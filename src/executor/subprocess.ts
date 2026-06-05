// subprocess.ts — CLI-agnostic streaming subprocess driver.
// subprocess.ts —— 与具体 CLI 无关的流式子进程 driver。
//
// Owns every CLI-neutral mechanism shared by stream-based executors: spawn into a
// 承载所有基于流的 executor 共享的、与 CLI 无关的机制：spawn 进
// fresh process group, process-group kill, wall + idle + abort watchdogs, newline
// 一个全新的进程组、进程组 kill、wall + idle + abort 三看门狗、按换行
// line buffering of stdout, stderr accumulation, stdin feed, and best-effort trace
// 缓冲 stdout、累积 stderr、喂入 stdin，以及尽力而为的 trace
// write. The command name, argv, line parsing, and reduction are all injected by the
// 落盘。命令名、argv、行解析和归约全部由调用方通过
// caller via a SubprocessSpec, so a new CLI is just a new spec (SPEC §5).
// SubprocessSpec 注入，因此接一个新 CLI 只需写一个新的 spec（SPEC §5）。

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  ResultSubtype,
  TokenUsage,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// Opt-in troubleshooting log: ODW_DEBUG=1 streams spawn argv, exit status, and (on an
// error result) a stderr tail to this process's stderr. Off by default — the happy path
// stays quiet; the always-on record lives in the per-agent trace file instead.
// 可选排查日志:ODW_DEBUG=1 时把 spawn argv、退出状态、(出错时) stderr 末尾打到本进程
// stderr。默认关闭——正常路径保持安静;常开的记录改为落在每个 agent 的 trace 文件里。
const DEBUG = process.env.ODW_DEBUG === "1" || process.env.ODW_DEBUG === "true";

/** The CLI-neutral core of an ExecResult; the driver adds durationMs. */
/** ExecResult 中与 CLI 无关的核心；durationMs 由 driver 补上。 */
export interface ExecResultCore {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  costUsd: number;
  resultSubtype: ResultSubtype;
  isError: boolean;
  usage: TokenUsage;
}

/**
 * Everything CLI-specific about a streaming executor: how to build argv (+ optional
 * stdin / cleanup), how to parse a single stdout line, and how to fold the collected
 * events into an ExecResultCore.
 *
 * 一个流式 executor 中所有与具体 CLI 相关的部分：如何构造 argv（+ 可选的
 * stdin / cleanup）、如何解析单行 stdout，以及如何把收集到的事件折叠成 ExecResultCore。
 */
export interface SubprocessSpec {
  /** The executable name to spawn (e.g. "claude", "codex"). */
  /** 要 spawn 的可执行文件名（例如 "claude"、"codex"）。 */
  command: string;
  /**
   * Build argv + optional stdin + optional cleanup. Async: lets the caller write a
   * temp file (e.g. an --output-schema path) before the subprocess starts.
   *
   * 构造 argv + 可选 stdin + 可选 cleanup。声明为 async：允许调用方在子进程启动前
   * 写临时文件（例如 --output-schema 的路径）。
   */
  prepare: (opts: ExecOptions) => Promise<{
    args: string[];
    stdin?: string;
    cleanup?: () => void | Promise<void>;
  }>;
  /** Parse one stdout line into an event object, or null to skip it. */
  /** 把单行 stdout 解析成一个事件对象，或返回 null 表示跳过。 */
  parseLine: (line: string) => unknown | null;
  /**
   * Pure reduction: collected events + exit context (including the original opts, so a
   * spec can branch on e.g. whether a schema was requested) → an ExecResultCore. The
   * driver appends durationMs.
   *
   * 纯归约：收集到的事件 + 退出上下文（含原始 opts，让 spec 可据此分支，
   * 例如本次是否带了 schema）→ ExecResultCore。durationMs 由 driver 补上。
   */
  reduce: (
    events: unknown[],
    ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
  ) => ExecResultCore;
}

/**
 * A self-contained debug record of one subprocess execution. Beyond the parsed stdout
 * events it captures argv, exit code, duration, and — crucially — stderr, which is where
 * CLI-level failures (auth, usage/quota limits, config errors) actually land. Persisting
 * this means a failed run is diagnosable from its trace alone, with no reproduction.
 *
 * 一次子进程执行的自包含调试记录。除了解析后的 stdout 事件,还记录 argv、退出码、耗时,
 * 以及——最关键的——stderr:CLI 级失败(认证、用量/配额上限、配置错误)真正落在这里。
 * 把它持久化,意味着失败的 run 单凭 trace 就能排查,无需复现。
 */
export interface ExecTrace {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  durationMs: number;
  exitCode: number | null;
  isError: boolean;
  resultSubtype: string;
  stderr: string;
  events: unknown[];
}

/** Best-effort trace write. Never rejects — a debug artifact must not fail the run. */
/** 尽力而为地写 trace。绝不 reject —— 一个 debug 产物不应让整个运行失败。 */
async function writeTrace(tracePath: string, trace: ExecTrace): Promise<void> {
  try {
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(tracePath, JSON.stringify(trace, null, 2));
  } catch (err) {
    console.warn(`[${trace.command}] trace write failed (${tracePath}):`, err);
  }
}

/**
 * Turn a SubprocessSpec into an Executor. All timeout / idle / abort / spawn-error
 * paths reject with "<command> timeout|idle timeout|aborted|spawn error: ..."; the
 * happy path resolves to { ...core, durationMs }.
 *
 * 把一个 SubprocessSpec 变成 Executor。所有 timeout / idle / abort / spawn-error
 * 路径都以 "<command> timeout|idle timeout|aborted|spawn error: ..." reject；正常
 * 路径 resolve 出 { ...core, durationMs }。
 */
export function makeSubprocessExecutor(spec: SubprocessSpec): Executor {
  const dbg = (msg: string): void => {
    if (DEBUG) console.error(`[odw:${spec.command}] ${msg}`);
  };
  return (opts: ExecOptions): Promise<ExecResult> => {
    return new Promise<ExecResult>((resolve, reject) => {
      const startedAt = Date.now();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      let settled = false;
      let cleanupFn: (() => void | Promise<void>) | undefined;
      let wallTimer: NodeJS.Timeout | undefined;
      let idleTimer: NodeJS.Timeout | undefined;

      const clearTimers = (): void => {
        if (wallTimer) clearTimeout(wallTimer);
        if (idleTimer) clearTimeout(idleTimer);
      };

      // Run the prepare()-supplied cleanup exactly once, best-effort. Never throws —
      // 把 prepare() 提供的 cleanup 恰好跑一次，尽力而为。绝不抛异常——
      // a leftover temp file must not mask the real settlement reason.
      // 残留的临时文件不应掩盖真正的 settlement 原因。
      const runCleanup = (): void => {
        const fn = cleanupFn;
        if (fn === undefined) return;
        cleanupFn = undefined;
        try {
          void Promise.resolve(fn()).catch((err) => {
            console.warn(`[${spec.command}] cleanup failed:`, err);
          });
        } catch (err) {
          console.warn(`[${spec.command}] cleanup failed:`, err);
        }
      };

      // prepare() is async (may write a temp file); only then do we spawn.
      // prepare() 是异步的（可能写临时文件）；之后才 spawn。
      void spec
        .prepare(opts)
        .then(({ args, stdin, cleanup }) => {
          cleanupFn = cleanup;

          // If the signal already aborted while prepare() was in flight, bail before spawning.
          // 如果在 prepare() 进行期间 signal 已经 abort，则在 spawn 之前就退出。
          if (opts.signal?.aborted) {
            settled = true;
            runCleanup();
            reject(new Error(`${spec.command} aborted`));
            return;
          }

          dbg(`spawn: ${spec.command} ${args.join(" ")} (cwd=${opts.cwd})`);
          const child = spawn(spec.command, args, {
            cwd: opts.cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
            stdio: ["pipe", "pipe", "pipe"],
            // New process group: the CLI may spawn its own children (MCP servers, tool
            // 新建进程组：CLI 可能派生它自己的子进程（MCP server、工具
            // subprocesses, bash). A cancel must kill the whole tree, not just the top
            // 子进程、bash）。取消时必须杀掉整棵进程树，而不只是顶层
            // process, or those grandchildren are orphaned. We keep the pipes (no unref).
            // 进程，否则那些孙子进程会变成孤儿。我们保留管道（不 unref）。
            detached: true,
          });

          // Kill the child's entire process group (negative pid). Falls back to the lone
          // 杀掉子进程所在的整个进程组（用负的 pid）。若进程组信号失败（pid 已消失 /
          // child if the group signal fails (pid gone / not a group leader). Never throws.
          // 不是组长进程）则退回到只杀单个子进程。绝不抛异常。
          const killTree = (sig: NodeJS.Signals): void => {
            try {
              if (child.pid !== undefined) process.kill(-child.pid, sig);
              else child.kill(sig);
            } catch {
              try {
                child.kill(sig);
              } catch {
                /* already dead */
                /* 已经死了 */
              }
            }
          };

          const events: unknown[] = [];
          let stdoutBuf = "";
          let stderrBuf = "";

          const onAbort = (): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            killTree("SIGKILL");
            runCleanup();
            dbg("aborted by signal");
            reject(new Error(`${spec.command} aborted`));
          };

          const fail = (message: string): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            opts.signal?.removeEventListener("abort", onAbort);
            killTree("SIGKILL");
            runCleanup();
            dbg(`fail: ${message}`);
            reject(new Error(message));
          };

          // Abort signal: kill + reject.
          // abort 信号：杀进程 + reject。
          if (opts.signal) {
            opts.signal.addEventListener("abort", onAbort, { once: true });
          }

          // Wall-clock timeout.
          // 墙钟超时。
          wallTimer = setTimeout(() => fail(`${spec.command} timeout`), timeoutMs);

          // Idle (stdout-arrival) watchdog.
          // idle（以 stdout 到达为准）看门狗。
          const armIdle = (): void => {
            if (opts.idleTimeoutMs === undefined) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => fail(`${spec.command} idle timeout`),
              opts.idleTimeoutMs,
            );
          };
          armIdle();

          // Consume a chunk of stdout: split complete lines, parse, push non-null events.
          // 消费一段 stdout：切出完整的行，解析后把非 null 的 event 推入数组。
          const consume = (chunk: string): void => {
            stdoutBuf += chunk;
            let nl: number;
            while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
              const line = stdoutBuf.slice(0, nl);
              stdoutBuf = stdoutBuf.slice(nl + 1);
              const ev = spec.parseLine(line);
              if (ev !== null) events.push(ev);
            }
          };

          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            armIdle();
            consume(chunk);
          });

          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            stderrBuf += chunk;
          });

          child.on("error", (err) => {
            const detail = err instanceof Error ? err.message : String(err);
            fail(`${spec.command} spawn error: ${detail}`);
          });

          child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimers();
            opts.signal?.removeEventListener("abort", onAbort);

            // Flush any trailing partial line.
            // 把末尾残留的不完整行刷出来。
            const tail = stdoutBuf.trim();
            if (tail.length > 0) {
              const ev = spec.parseLine(tail);
              if (ev !== null) events.push(ev);
            }
            stdoutBuf = "";

            // Wall-clock duration, computed the same way as before the refactor.
            // 墙钟耗时，按重构前同样的方式计算。
            const durationMs = Date.now() - startedAt;
            const core = spec.reduce(events, {
              stderr: stderrBuf,
              exitCode: code,
              opts,
            });

            dbg(
              `exit=${code} ${durationMs}ms events=${events.length} isError=${core.isError} subtype=${core.resultSubtype}`,
            );
            if (core.isError && stderrBuf.trim().length > 0) {
              dbg(`stderr tail: ${stderrBuf.trim().slice(-800)}`);
            }

            const finish = (): void => {
              const result: ExecResult = {
                text: core.text,
                sessionId: core.sessionId,
                costUsd: core.costUsd,
                durationMs,
                resultSubtype: core.resultSubtype,
                isError: core.isError,
                usage: core.usage,
              };
              if (core.structuredOutput !== undefined) {
                result.structuredOutput = core.structuredOutput;
              }
              runCleanup();
              resolve(result);
            };

            if (opts.tracePath) {
              void writeTrace(opts.tracePath, {
                command: spec.command,
                args,
                cwd: opts.cwd,
                prompt: opts.prompt,
                durationMs,
                exitCode: code,
                isError: core.isError,
                resultSubtype: core.resultSubtype,
                stderr: stderrBuf,
                events,
              }).then(finish);
            } else {
              finish();
            }
          });

          // Feed the prompt on stdin and close it.
          // 把 prompt 喂给 stdin 然后关闭它。
          child.stdin.on("error", () => {
            // EPIPE if the child died early; close handler / error handler covers settlement.
            // 子进程过早死亡会触发 EPIPE；settlement 由 close handler / error handler 负责。
          });
          if (stdin !== undefined) child.stdin.write(stdin);
          child.stdin.end();
        })
        .catch((err) => {
          // prepare() itself failed (e.g. temp-file write) — surface as a spawn error.
          // The abort listener is only attached after spawn, so there is none to remove here.
          // prepare() 自身失败（例如写临时文件失败）—— 以 spawn error 形式抛出。
          // abort 监听器要 spawn 之后才挂，所以这里没有需要移除的监听器。
          if (settled) return;
          settled = true;
          clearTimers();
          runCleanup();
          const detail = err instanceof Error ? err.message : String(err);
          reject(new Error(`${spec.command} spawn error: ${detail}`));
        });
    });
  };
}

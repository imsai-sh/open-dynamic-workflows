// executor/claude.ts — the only module that touches `claude`.
// executor/claude.ts —— 唯一直接调用 `claude` 的模块。
//
// Spawns `claude --print --output-format=stream-json`, feeds the prompt on stdin,
// 启动 `claude --print --output-format=stream-json`，把 prompt 喂给 stdin，
// parses the stream-json line-by-line, and reduces it to an ExecResult. Wall-clock,
// 逐行解析 stream-json，并归约成一个 ExecResult。墙钟（wall-clock）、
// idle, and abort watchdogs guard against hung subprocesses (SPEC §8).
// idle 和 abort 三个看门狗用于防止子进程挂死（SPEC §8）。

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExecOptions, ExecResult, Executor } from "../types.js";
import { parseStreamJsonLine, reduceStreamJsonEvents } from "./stream-json.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Build the argv for `claude` from ExecOptions. Never emits --dangerously-skip-permissions. */
/** 根据 ExecOptions 构造 `claude` 的 argv。绝不输出 --dangerously-skip-permissions。 */
export function buildClaudeArgs(opts: ExecOptions): string[] {
  const args: string[] = [
    "--print",
    "--output-format=stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.schema) args.push("--json-schema", JSON.stringify(opts.schema));
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  return args;
}

/** Best-effort raw trace write. Never rejects — a debug artifact must not fail the run. */
/** 尽力而为地写原始 trace。绝不 reject —— 一个 debug 产物不应让整个运行失败。 */
async function writeTrace(tracePath: string, prompt: string, events: unknown[]): Promise<void> {
  try {
    const trace = [{ type: "user_input", text: prompt }, ...events];
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(tracePath, JSON.stringify(trace, null, 2));
  } catch (err) {
    console.warn(`[claude] trace write failed (${tracePath}):`, err);
  }
}

export const claudeExecutor: Executor = (opts: ExecOptions): Promise<ExecResult> => {
  return new Promise<ExecResult>((resolve, reject) => {
    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const child = spawn("claude", buildClaudeArgs(opts), {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      // New process group: `claude --print` spawns its own children (MCP servers, tool
      // 新建进程组：`claude --print` 会派生它自己的子进程（MCP server、工具
      // subprocesses, bash). A cancel must kill the whole tree, not just the top process,
      // 子进程、bash）。取消时必须杀掉整棵进程树，而不只是顶层进程，
      // or those grandchildren are orphaned. We keep the pipes (no unref) for I/O.
      // 否则那些孙子进程会变成孤儿。我们保留管道（不 unref）以便 I/O。
      detached: true,
    });

    // Kill the child's entire process group (negative pid). Falls back to the lone child
    // 杀掉子进程所在的整个进程组（用负的 pid）。若进程组信号失败（pid 已消失 /
    // if the group signal fails (pid gone / not a group leader). Never throws.
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
    let settled = false;
    let wallTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (wallTimer) clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      killTree("SIGKILL");
      reject(new Error("claude aborted"));
    };

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      opts.signal?.removeEventListener("abort", onAbort);
      killTree("SIGKILL");
      reject(new Error(message));
    };

    // Abort signal: kill + reject.
    // abort 信号：杀进程 + reject。
    if (opts.signal) {
      if (opts.signal.aborted) {
        killTree("SIGKILL");
        reject(new Error("claude aborted"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Wall-clock timeout.
    // 墙钟超时。
    wallTimer = setTimeout(() => fail("claude timeout"), timeoutMs);

    // Idle (stdout-arrival) watchdog.
    // idle（以 stdout 到达为准）看门狗。
    const armIdle = (): void => {
      if (opts.idleTimeoutMs === undefined) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail("claude idle timeout"), opts.idleTimeoutMs);
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
        const ev = parseStreamJsonLine(line);
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
      fail(`claude spawn error: ${detail}`);
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimers();
      opts.signal?.removeEventListener("abort", onAbort);

      // Flush any trailing partial line.
      // 把末尾残留的不完整行刷出来。
      const tail = stdoutBuf.trim();
      if (tail.length > 0) {
        const ev = parseStreamJsonLine(tail);
        if (ev !== null) events.push(ev);
      }
      stdoutBuf = "";

      const durationMs = Date.now() - startedAt;
      const outcome = reduceStreamJsonEvents(events);

      const finish = (): void => {
        const result: ExecResult = {
          text: outcome.text,
          sessionId: outcome.sessionId,
          costUsd: outcome.costUsd,
          durationMs,
          resultSubtype: outcome.resultSubtype,
          isError: outcome.isError,
          usage: outcome.usage,
        };
        if (outcome.structuredOutput !== undefined) {
          result.structuredOutput = outcome.structuredOutput;
        }
        // Surface stderr context on error results for debuggability (never throws).
        // 在错误结果上带出 stderr 上下文以便调试（绝不抛异常）。
        if (outcome.isError && stderrBuf.trim().length > 0 && result.text.length === 0) {
          result.text = stderrBuf.trim();
        }
        resolve(result);
      };

      if (opts.tracePath) {
        void writeTrace(opts.tracePath, opts.prompt, events).then(finish);
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
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
};

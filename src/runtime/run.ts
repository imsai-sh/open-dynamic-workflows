// run.ts — runWorkflow(): the INTEGRATOR.
// run.ts —— runWorkflow()：集成器（INTEGRATOR）。
//
// Wires sandbox (meta + script) + hooks + executor + journal + progress into one run
// 把 sandbox（meta + script）+ hooks + executor + journal + progress 串成一次运行
// (SPEC §2, §5, §9, §10). Resolves the script source, opens the journal, builds the
// （SPEC §2、§5、§9、§10）。解析脚本源码，打开 journal，构建
// shared concurrency/agent/abort primitives, then drives the (possibly nested)
// 共享的 concurrency/agent/abort 原语，然后在单个 RunContext 下驱动（可能嵌套的）
// script under a single RunContext. workflow() nesting is one level only (SPEC §4).
// 脚本。workflow() 嵌套只允许一层（SPEC §4）。

import os from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  RunOptions,
  WorkflowResult,
  RunContext,
  ProgressEvent,
  WorkflowMeta,
  Executor,
  EventSink,
  WorkflowRef,
} from "../types.js";
import { TOTAL_AGENT_CAP } from "../types.js";
import { extractMeta, runScript } from "./sandbox.js";
import { createHooks } from "./hooks.js";
import { createSemaphore, createCounter } from "./semaphore.js";
import { openJournal } from "../journal/journal.js";
import { claudeExecutor } from "../executor/claude.js";

const now = (): string => new Date().toISOString();

/** Resolve a registry workflow source by name, trying `.js` then `.mjs`. */
/** 按名字解析 registry 中的 workflow 源码，先尝试 `.js` 再尝试 `.mjs`。 */
async function readRegistryScript(
  registryDir: string,
  name: string,
): Promise<{ source: string; ext: string }> {
  for (const ext of ["js", "mjs"] as const) {
    try {
      const source = await readFile(path.join(registryDir, `${name}.${ext}`), "utf8");
      return { source, ext };
    } catch {
      // try next extension
      // 尝试下一个扩展名
    }
  }
  // Also accept a name that already carries its extension.
  // 也接受本身已带扩展名的 name。
  try {
    const source = await readFile(path.join(registryDir, name), "utf8");
    const ext = path.extname(name).replace(/^\./, "") || "js";
    return { source, ext };
  } catch {
    throw new Error(
      `cannot resolve workflow "${name}" from registryDir "${registryDir}" (tried .js/.mjs)`,
    );
  }
}

/** Resolve the top-level script source + extension by precedence: scriptPath → script → name. */
/** 按优先级 scriptPath → script → name 解析顶层脚本的源码 + 扩展名。 */
async function resolveSource(options: RunOptions): Promise<{ source: string; ext: string }> {
  if (options.scriptPath !== undefined) {
    const source = await readFile(options.scriptPath, "utf8");
    const ext = path.extname(options.scriptPath).replace(/^\./, "") || "js";
    return { source, ext };
  }
  if (options.script !== undefined) {
    return { source: options.script, ext: "js" };
  }
  if (options.name !== undefined) {
    if (options.registryDir === undefined) {
      throw new Error(`RunOptions.name requires registryDir to resolve "${options.name}"`);
    }
    return readRegistryScript(options.registryDir, options.name);
  }
  throw new Error("runWorkflow requires one of: scriptPath, script, or name");
}

export async function runWorkflow(options: RunOptions): Promise<WorkflowResult> {
  // (1) Resolve top-level source + extension.
  // (1) 解析顶层源码 + 扩展名。
  const { source, ext } = await resolveSource(options);

  // (2) Journal base dir.
  // (2) Journal 的基准目录。
  const baseDir =
    options.runDir ?? path.resolve(options.cwd ?? process.cwd(), ".workflow-runs");

  // (3) Open journal + persist the resolved script.
  // (3) 打开 journal + 持久化已解析的脚本。
  const journal = await openJournal({
    baseDir,
    ...(options.resumeFromRunId !== undefined ? { resumeFromRunId: options.resumeFromRunId } : {}),
  });
  const persistedPath = await journal.persistScript(source, ext);

  // (4) Concurrency cap.
  // (4) 并发上限。
  const concurrency = options.concurrency ?? Math.max(1, Math.min(16, os.cpus().length - 2));

  // (5) Shared run primitives.
  // (5) 本次运行共享的原语。
  const sem = createSemaphore(concurrency);
  const counter = createCounter(TOTAL_AGENT_CAP);
  // Run-level output-token tally — pure observability (reported as tokensSpent), no ceiling.
  // run 级输出 token 计数 —— 纯观测（作为 tokensSpent 上报），不设上限。
  let tokensSpent = 0;
  const abort = new AbortController();

  // Forward external cancellation (RunOptions.signal) into the run's shared abort, which
  // 把外部取消信号（RunOptions.signal）转发到本次运行的共享 abort，
  // is what the executor watches to kill in-flight subprocesses.
  // 而 executor 正是监听这个 abort 来终止进行中的子进程。
  if (options.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  // (6) Event sink: accumulate + fan out to onEvent.
  // (6) 事件汇聚（sink）：累积事件 + 扇出到 onEvent。
  const events: ProgressEvent[] = [];
  const emit: EventSink = (e) => {
    events.push(e);
    journal.appendEvent(e);
    options.onEvent?.(e);
  };

  // (7) Executor (injectable for tests; defaults to claude --print).
  // (7) Executor（可注入便于测试；默认为 claude --print）。
  const executor: Executor = options.executor ?? claudeExecutor;

  const cwd = options.cwd ?? process.cwd();

  // Run a script body at a given nesting depth under a fresh RunContext that shares the
  // 在给定嵌套深度下、用一个全新的 RunContext 运行脚本体，该 RunContext 共享
  // run-global primitives (semaphore, counter, abort, journal, emit).
  // 运行级全局原语（semaphore、counter、abort、journal、emit）。
  const runInternal = async (src: string, scriptArgs: unknown, depth: number): Promise<unknown> => {
    const ctx: RunContext = {
      runId: journal.runId,
      runDir: journal.runDir,
      cwd,
      executor,
      concurrency,
      depth,
      emit,
      abort: abort.signal,
      currentPhase: { value: null },
      nextAgentId: () => counter.next(),
      takeCached: (k) => journal.takeCached(k),
      record: (r) => journal.append(r),
      addTokens: (n) => {
        tokensSpent += n;
      },
      ...(options.model !== undefined ? { defaultModel: options.model } : {}),
      ...(options.registryDir !== undefined ? { registryDir: options.registryDir } : {}),
      ...(options.agentTimeoutMs !== undefined ? { agentTimeoutMs: options.agentTimeoutMs } : {}),
    };

    // workflow() — one level of nesting only; shares all run-global primitives.
    // workflow() —— 只允许一层嵌套；共享所有运行级全局原语。
    const runNested = async (ref: WorkflowRef, a?: unknown): Promise<unknown> => {
      if (depth >= 1) {
        throw new Error("workflow() nesting is one level only");
      }
      let childSource: string;
      if (typeof ref === "string") {
        if (options.registryDir === undefined) {
          throw new Error(`workflow("${ref}") requires registryDir to resolve`);
        }
        childSource = (await readRegistryScript(options.registryDir, ref)).source;
      } else {
        childSource = await readFile(ref.scriptPath, "utf8");
      }
      const name = typeof ref === "string" ? ref : ref.scriptPath;

      emit({ type: "workflow_start", name, ts: now() });
      try {
        return await runInternal(childSource, a, depth + 1);
      } finally {
        emit({ type: "workflow_end", name, ok: true, ts: now() });
      }
    };

    const hooks = createHooks(ctx, { semaphore: sem, runNested, args: scriptArgs });
    return await runScript(src, hooks);
  };

  // TOP LEVEL.
  // 顶层。
  const meta: WorkflowMeta = extractMeta(source);
  emit({ type: "run_start", runId: journal.runId, meta, ts: now() });

  const startedAt = Date.now();
  let ok = true;
  let value: unknown;
  try {
    value = await runInternal(source, options.args, 0);
  } catch (err) {
    ok = false;
    const durationMs = Date.now() - startedAt;
    emit({
      type: "run_end",
      runId: journal.runId,
      ok,
      tokensSpent: tokensSpent,
      durationMs,
      ts: now(),
    });
    await journal.close();
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  emit({
    type: "run_end",
    runId: journal.runId,
    ok,
    tokensSpent: tokensSpent,
    durationMs,
    ts: now(),
  });
  await journal.close();

  return {
    runId: journal.runId,
    scriptPath: persistedPath,
    meta,
    value,
    events,
    tokensSpent: tokensSpent,
    agentCount: counter.count,
    durationMs,
  };
}

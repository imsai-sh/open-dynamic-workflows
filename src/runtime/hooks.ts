// hooks.ts — the orchestration hooks (agent/parallel/pipeline/phase/log/args/
// hooks.ts —— 编排钩子（agent/parallel/pipeline/phase/log/args/
// workflow) bound to a single RunContext. See SPEC §4, §5, §12.
// workflow），绑定到单个 RunContext。参见 SPEC §4、§5、§12。
//
// All "framework config" (cwd, model, semaphore, abort, journal) is captured
// 所有“框架配置”（cwd、model、semaphore、abort、journal）都在
// here via the ctx + deps closure; the workflow script sees only the ScriptHooks shape.
// 这里通过 ctx + deps 闭包捕获；workflow 脚本只看到 ScriptHooks 的形状。

import { execFileSync } from "node:child_process";
import path from "node:path";

import type {
  AgentOptions,
  AgentRecord,
  ExecOptions,
  RunContext,
  ScriptHooks,
  Thunk,
  WorkflowRef,
} from "../types.js";
import { keyFor } from "../journal/journal.js";
import { assertObjectRootSchema, validateAgainstSchema } from "../schema/validate.js";
import type { Semaphore } from "./semaphore.js";

export interface HookDeps {
  semaphore: Semaphore;
  runNested: (ref: WorkflowRef, args: unknown) => Promise<unknown>;
  args: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// agentType → system-prompt preset (SPEC §4). Built-in map; unknown → warn once.
// agentType → 系统提示词预设（SPEC §4）。内置映射表；未知值 → 只警告一次。
// ────────────────────────────────────────────────────────────────────────────

const AGENT_TYPE_PRESETS: Readonly<Record<string, string>> = {
  Explore:
    "You are a read-only exploration subagent. Investigate and report findings; do not modify files.",
  Plan: "You are a planning subagent. Produce a concrete, ordered plan; do not modify files.",
  General: "You are a general-purpose subagent.",
};

const warnedAgentTypes = new Set<string>();

function presetFor(agentType?: string): string | undefined {
  if (agentType === undefined) return undefined;
  const preset = AGENT_TYPE_PRESETS[agentType];
  if (preset !== undefined) return preset;
  if (!warnedAgentTypes.has(agentType)) {
    warnedAgentTypes.add(agentType);
    console.warn(`[hooks] unknown agentType "${agentType}" — falling back to default system prompt`);
  }
  return undefined;
}

const nowIso = (): string => new Date().toISOString();

// Collapse whitespace + truncate so an executor's failure reason (a turn.failed message or
// a multi-line stderr tail, surfaced into ExecResult.text) embeds cleanly into the thrown
// Error and the agent_end event the progress tree renders — a real reason, not just a subtype.
// 折叠空白 + 截断,让执行器的失败原因(turn.failed 消息或多行 stderr 末尾,已兜进
// ExecResult.text)干净地嵌进抛出的 Error 和进度树渲染的 agent_end 事件——给出真实原因,
// 而不只是一个 subtype。
function oneLine(s: string, max = 300): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Best-effort temp git worktree for isolation:"worktree". Returns the worktree dir, or
// 为 isolation:"worktree" 尽力创建临时 git worktree。返回 worktree 目录，
// null on any git failure (caller then falls back to ctx.cwd with a warning).
// 任何 git 失败则返回 null（调用方随后带警告回退到 ctx.cwd）。
function createWorktree(repoCwd: string, runDir: string, agentId: number): string | null {
  const wtDir = path.join(runDir, "worktrees", `agent-${agentId}`);
  const branch = `wf-agent-${agentId}`;
  try {
    execFileSync("git", ["worktree", "add", "--detach", "-b", branch, wtDir], {
      cwd: repoCwd,
      stdio: "ignore",
    });
    return wtDir;
  } catch (err) {
    console.warn(`[hooks] isolation:"worktree" failed for agent ${agentId}: ${String(err)} — using cwd`);
    return null;
  }
}

// Remove the worktree iff it has no uncommitted changes (`git status --porcelain` empty).
// 仅当 worktree 没有未提交改动时才移除它（`git status --porcelain` 输出为空）。
function cleanupWorktree(repoCwd: string, wtDir: string): void {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: wtDir,
      encoding: "utf8",
    });
    if (status.trim() !== "") return; // dirty → keep for inspection ｜ 有改动 → 保留以便检查
    execFileSync("git", ["worktree", "remove", "--force", wtDir], {
      cwd: repoCwd,
      stdio: "ignore",
    });
  } catch (err) {
    console.warn(`[hooks] worktree cleanup failed for ${wtDir}: ${String(err)}`);
  }
}

export function createHooks(ctx: RunContext, deps: HookDeps): ScriptHooks {
  const agent = async (prompt: string, opts?: AgentOptions): Promise<unknown> => {
    // `executor` is required in the public AgentOptions type, but the runtime must still
    // tolerate `agent(prompt)` with no opts at all so it can fail fast with a helpful
    // message (INVARIANT #10 — no default executor). Model the fallback as Partial so the
    // "missing executor" path stays reachable and type-checks (o.executor is then string | undefined).
    // `executor` 在公开的 AgentOptions 类型里是必填的，但运行时仍须容忍完全不传 opts 的
    // `agent(prompt)`，以便 fail fast 给出有用的报错（不变量 #10——没有默认 executor）。
    // 把回退建模为 Partial，使「缺 executor」分支可达且能通过类型检查（此时 o.executor 为 string | undefined）。
    const o: Partial<AgentOptions> = opts ?? {};
    const key = keyFor(prompt, o);
    const id = ctx.nextAgentId();
    const label = o.label ?? prompt.slice(0, 60);
    const phase = o.phase ?? ctx.currentPhase.value;

    // RESUME: a cached record for this content key → return instantly, no spend.
    // RESUME：该内容 key 已有缓存记录 → 立即返回，不产生花费。
    const cached = ctx.takeCached(key);
    if (cached !== undefined) {
      ctx.emit({ type: "agent_start", agentId: id, label, phase, cached: true, ts: nowIso() });
      ctx.emit({
        type: "agent_end",
        agentId: id,
        label,
        phase,
        ok: true,
        cached: true,
        costUsd: 0,
        outputTokens: 0,
        durationMs: 0,
        ts: nowIso(),
      });
      const rec: AgentRecord = { ...cached, index: id, cached: true };
      ctx.record(rec);
      return cached.result;
    }

    if (o.schema !== undefined) assertObjectRootSchema(o.schema);

    await deps.semaphore.acquire();
    ctx.emit({ type: "agent_start", agentId: id, label, phase, cached: false, ts: nowIso() });

    let worktreeDir: string | null = null;
    try {
      let cwd = ctx.cwd;
      if (o.isolation === "worktree") {
        worktreeDir = createWorktree(ctx.cwd, ctx.runDir, id);
        if (worktreeDir !== null) cwd = worktreeDir;
      }

      const resolvedModel = o.model ?? ctx.defaultModel;
      const appendSystemPrompt = presetFor(o.agentType);
      const execOpts: ExecOptions = {
        prompt,
        cwd,
        signal: ctx.abort,
        tracePath: path.join(ctx.runDir, "agents", `agent-${id}.jsonl`),
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(o.schema !== undefined ? { schema: o.schema } : {}),
        ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
        ...(ctx.agentTimeoutMs !== undefined ? { timeoutMs: ctx.agentTimeoutMs } : {}),
      };

      // Resolve the executor by name from the run's registry. No default: a missing
      // or unknown name fails fast (INVARIANT — never silently fall back). This throw
      // sits inside the try after semaphore.acquire(), so it unwinds through catch:
      // agent_end{ok:false} is emitted and the semaphore is released in finally.
      // 按名字从本次 run 的注册表解析 executor。没有默认值：缺失或未知的名字 fail fast
      //（不变量——绝不静默回退）。该 throw 位于 semaphore.acquire() 之后的 try 内，
      // 因此会经 catch 回退：发出 agent_end{ok:false}，并在 finally 中 release 信号量。
      if (!o.executor) {
        throw new Error(
          `agent() requires an 'executor' (one of: ${Object.keys(ctx.executors).join(", ")})`,
        );
      }
      const executor = ctx.executors[o.executor];
      if (executor === undefined) {
        throw new Error(
          `unknown executor "${o.executor}" (registered: ${Object.keys(ctx.executors).join(", ")})`,
        );
      }

      const res = await executor(execOpts);
      ctx.addTokens(res.usage.outputTokens);

      let value: unknown;
      if (o.schema !== undefined) {
        if (
          res.structuredOutput !== undefined &&
          validateAgainstSchema(o.schema, res.structuredOutput).ok
        ) {
          value = res.structuredOutput;
        } else {
          throw new Error(
            `structured output failed (subtype=${res.resultSubtype})` +
              (res.text ? `: ${oneLine(res.text)}` : ""),
          );
        }
      } else {
        value = res.text;
      }

      if (res.isError && res.resultSubtype !== "success") {
        throw new Error(
          `agent failed (subtype=${res.resultSubtype})` +
            (res.text ? `: ${oneLine(res.text)}` : ""),
        );
      }

      ctx.emit({
        type: "agent_end",
        agentId: id,
        label,
        phase,
        ok: true,
        cached: false,
        costUsd: res.costUsd,
        outputTokens: res.usage.outputTokens,
        durationMs: res.durationMs,
        ts: nowIso(),
      });

      ctx.record({
        index: id,
        key,
        label,
        phase,
        result: value,
        cached: false,
        outputTokens: res.usage.outputTokens,
        ts: nowIso(),
      });
      return value;
    } catch (e) {
      const aborted = ctx.abort.aborted;
      ctx.emit({
        type: "agent_end",
        agentId: id,
        label,
        phase,
        ok: false,
        cached: false,
        ...(aborted ? { skipped: true } : {}),
        costUsd: 0,
        outputTokens: 0,
        durationMs: 0,
        error: String(e),
        ts: nowIso(),
      });
      throw e;
    } finally {
      deps.semaphore.release();
      if (worktreeDir !== null) cleanupWorktree(ctx.cwd, worktreeDir);
    }
  };

  // parallel — BARRIER, failure→null, order preserved (SPEC §4). On abort it RE-THROWS
  // parallel —— BARRIER（栅栏），失败→null，保持顺序（SPEC §4）。中止时它会 RE-THROW（重新抛出），
  // instead of swallowing: each thunk settles to null (no unhandled rejection), then the
  // 而不是吞掉异常：每个 thunk 先 settle 成 null（避免 unhandled rejection），然后
  // post-barrier abort check throws so a cancelled run unwinds rather than filling nulls.
  // 栅栏之后的 abort 检查抛出异常，使被取消的运行得以回退，而不是填满一堆 null。
  const parallel = async (thunks: ReadonlyArray<Thunk>): Promise<Array<unknown>> => {
    const results = await Promise.all(
      thunks.map((t) => Promise.resolve().then(t).catch(() => null)),
    );
    if (ctx.abort.aborted) throw new Error("workflow aborted");
    return results;
  };

  // pipeline — independent per-item chains, NO inter-stage barrier (SPEC §4 / §12).
  // pipeline —— 每个 item 独立成链，stage 之间没有栅栏（SPEC §4 / §12）。
  // A throwing stage rejects its chain → subsequent .then skip → chain resolves null.
  // 某个 stage 抛错会 reject 它所在的链 → 后续 .then 被跳过 → 该链最终 resolve 成 null。
  // Like parallel, it re-throws on abort after the final collect.
  // 和 parallel 一样，在最终收集之后遇到 abort 会重新抛出异常。
  const pipeline: ScriptHooks["pipeline"] = async (items, ...stages) => {
    const chains = items.map((item, idx) => {
      const chain = stages.reduce<Promise<unknown>>(
        (p, st) => p.then((prev) => st(prev, item, idx)),
        Promise.resolve(item),
      );
      return chain.catch(() => null);
    });
    const results = await Promise.all(chains);
    if (ctx.abort.aborted) throw new Error("workflow aborted");
    return results;
  };

  const phase = (title: string): void => {
    ctx.currentPhase.value = title;
    ctx.emit({ type: "phase_start", phase: title, ts: nowIso() });
  };

  const log = (message: string): void => {
    ctx.emit({ type: "log", message, phase: ctx.currentPhase.value, ts: nowIso() });
  };

  const workflow = (ref: WorkflowRef, args?: unknown): Promise<unknown> =>
    deps.runNested(ref, args);

  return {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    args: deps.args,
    workflow,
  };
}

// types.ts — the FROZEN contract for the whole runtime.
// types.ts —— 整个运行时的冻结契约。
//
// Every module codes against these types. Do not change a shape without updating
// 每个模块都针对这些类型编码。改任何形状都要同步更新
// every consumer. Public API types and internal cross-module shapes both live here so
// 每一个消费方。公开 API 类型和内部跨模块形状都放在这里，
// there is one source of truth.
// 这样就有唯一的事实来源。

// ────────────────────────────────────────────────────────────────────────────
// JSON Schema (loose — we pass it through to the CLI and to ajv)
// JSON Schema（宽松定义 —— 我们把它透传给 CLI 和 ajv）
// ────────────────────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;

// ────────────────────────────────────────────────────────────────────────────
// meta block
// meta 块
// ────────────────────────────────────────────────────────────────────────────

export interface PhaseMeta {
  readonly title: string;
  readonly detail?: string;
  readonly model?: string;
}

export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly phases?: ReadonlyArray<PhaseMeta>;
  readonly model?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// agent() options
// agent() 选项
// ────────────────────────────────────────────────────────────────────────────

export interface AgentOptions {
  /** Display label; defaults to a truncated prompt or `agent-N`. */
  /** 显示标签；默认取截断后的 prompt 或 `agent-N`。 */
  label?: string;
  /** Explicit progress group. Use inside parallel()/pipeline() stages. */
  /** 显式的进度分组。在 parallel()/pipeline() 各阶段内部使用。 */
  phase?: string;
  /** JSON Schema forcing structured output; agent() then resolves to the object. */
  /** 强制结构化输出的 JSON Schema；之后 agent() 解析为该对象。 */
  schema?: JsonSchema;
  /** Model override for this call. */
  /** 本次调用的模型覆盖。 */
  model?: string;
  /** Run this agent in a fresh git worktree (parallel file mutation). EXPENSIVE. */
  /** 在全新的 git worktree 中运行此 agent（并行修改文件）。开销很大。 */
  isolation?: "worktree";
  /** Named subagent system-prompt preset. */
  /** 命名的子 agent system-prompt 预设。 */
  agentType?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// hooks injected into the script scope
// 注入到脚本作用域里的 hook
// ────────────────────────────────────────────────────────────────────────────

export type AgentFn = (prompt: string, opts?: AgentOptions) => Promise<unknown>;

export type Thunk<T = unknown> = () => Promise<T>;
export type ParallelFn = (thunks: ReadonlyArray<Thunk>) => Promise<Array<unknown>>;

/** A pipeline stage: receives the previous stage's result, the original item, and index. */
/** 一个 pipeline 阶段：接收上一阶段的结果、原始 item 以及索引。 */
export type PipelineStage = (
  prev: unknown,
  original: unknown,
  index: number,
) => Promise<unknown> | unknown;
export type PipelineFn = (
  items: ReadonlyArray<unknown>,
  ...stages: PipelineStage[]
) => Promise<Array<unknown>>;

export type PhaseFn = (title: string) => void;
export type LogFn = (message: string) => void;

export type WorkflowRef = string | { scriptPath: string };
export type WorkflowFn = (ref: WorkflowRef, args?: unknown) => Promise<unknown>;

/** The full set of globals bound into the workflow script's vm context. */
/** 绑定到 workflow 脚本 vm 上下文里的全部全局变量。 */
export interface ScriptHooks {
  agent: AgentFn;
  parallel: ParallelFn;
  pipeline: PipelineFn;
  phase: PhaseFn;
  log: LogFn;
  args: unknown;
  workflow: WorkflowFn;
}

// ────────────────────────────────────────────────────────────────────────────
// executor (claude --print subprocess)
// executor（claude --print 子进程）
// ────────────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ExecOptions {
  prompt: string;
  cwd: string;
  model?: string;
  schema?: JsonSchema;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  env?: Record<string, string>;
  /** Path to write the raw stream-json trace for debugging. */
  /** 写入原始 stream-json trace 的路径，用于调试。 */
  tracePath?: string;
  signal?: AbortSignal;
}

export type ResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_structured_output_retries"
  | "error_during_execution"
  | "timeout"
  | "idle_timeout"
  | (string & {});

export interface ExecResult {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  costUsd: number;
  durationMs: number;
  resultSubtype: ResultSubtype;
  isError: boolean;
  usage: TokenUsage;
}

/** The executor function signature; the only thing that touches `claude`. */
/** executor 函数签名；唯一直接接触 `claude` 的东西。 */
export type Executor = (opts: ExecOptions) => Promise<ExecResult>;

// ────────────────────────────────────────────────────────────────────────────
// progress events
// 进度事件
// ────────────────────────────────────────────────────────────────────────────

export type ProgressEvent =
  | { type: "run_start"; runId: string; meta: WorkflowMeta; ts: string }
  | { type: "phase_start"; phase: string; ts: string }
  | {
      type: "agent_start";
      agentId: number;
      label: string;
      phase: string | null;
      cached: boolean;
      ts: string;
    }
  | {
      type: "agent_end";
      agentId: number;
      label: string;
      phase: string | null;
      ok: boolean;
      cached: boolean;
      /** true when the agent was cancelled (run aborted) rather than failing on its own. */
      /** 当 agent 是被取消（run 中止）而非自身失败时为 true。 */
      skipped?: boolean;
      costUsd: number;
      outputTokens: number;
      durationMs: number;
      error?: string;
      ts: string;
    }
  | { type: "log"; message: string; phase: string | null; ts: string }
  | { type: "workflow_start"; name: string; ts: string }
  | { type: "workflow_end"; name: string; ok: boolean; ts: string }
  | { type: "run_end"; runId: string; ok: boolean; tokensSpent: number; durationMs: number; ts: string };

export type EventSink = (event: ProgressEvent) => void;

// ────────────────────────────────────────────────────────────────────────────
// journal (resume / caching)
// journal（恢复 / 缓存）
// ────────────────────────────────────────────────────────────────────────────

export interface AgentRecord {
  index: number;
  /** sha256(prompt + stableStringify(opts)). */
  /** sha256(prompt + stableStringify(opts))。 */
  key: string;
  label: string;
  phase: string | null;
  /** The resolved agent() return value (string | object | null). */
  /** agent() 解析后的返回值（string | object | null）。 */
  result: unknown;
  cached: boolean;
  outputTokens: number;
  ts: string;
}

// ────────────────────────────────────────────────────────────────────────────
// public entry API
// 公开的入口 API
// ────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
  cwd?: string;
  model?: string;
  runDir?: string;
  concurrency?: number;
  onEvent?: EventSink;
  registryDir?: string;
  /** Injected executor (defaults to the claude --print executor). Enables testing. */
  /** 注入的 executor（默认是 claude --print executor）。便于测试。 */
  executor?: Executor;
  /** Per-agent default timeout. */
  /** 每个 agent 的默认超时。 */
  agentTimeoutMs?: number;
  /**
   * External cancellation. When it aborts, in-flight agent subprocesses are killed
   * 外部取消。当它中止时，正在执行的 agent 子进程会被杀掉
   * (process-group SIGKILL) and the run unwinds: parallel()/pipeline() re-throw instead
   * （进程组 SIGKILL），整个 run 随之回退：parallel()/pipeline() 会重新抛出而不是
   * of swallowing to null, so runWorkflow() rejects. Already-completed agents stay
   * 吞掉成 null，于是 runWorkflow() 会 reject。已经完成的 agent 仍保留
   * recorded in the journal, so a later resumeFromRunId replays them with zero spend.
   * 在 journal 里，所以之后的 resumeFromRunId 会零开销地重放它们。
   */
  signal?: AbortSignal;
}

export interface WorkflowResult {
  runId: string;
  scriptPath: string;
  meta: WorkflowMeta;
  /** Whatever the script returned (or undefined). */
  /** 脚本返回的任意值（或 undefined）。 */
  value: unknown;
  events: ProgressEvent[];
  tokensSpent: number;
  agentCount: number;
  durationMs: number;
}

// ────────────────────────────────────────────────────────────────────────────
// internal shared run context (passed to hooks by run.ts)
// 内部共享的 run 上下文（由 run.ts 传给各 hook）
// ────────────────────────────────────────────────────────────────────────────

export interface RunContext {
  runId: string;
  runDir: string;
  cwd: string;
  defaultModel?: string;
  registryDir?: string;
  executor: Executor;
  agentTimeoutMs?: number;
  /** Concurrency cap. */
  /** 并发上限。 */
  concurrency: number;
  /** Nesting depth (0 = top-level; >0 forbids further workflow()). */
  /** 嵌套深度（0 = 顶层；>0 则禁止再调用 workflow()）。 */
  depth: number;
  emit: EventSink;
  abort: AbortSignal;
  /** Current phase() cursor (mutable). */
  /** 当前 phase() 游标（可变）。 */
  currentPhase: { value: string | null };
  /** Monotonic agent id allocator + 1000 cap enforcement. */
  /** 单调递增的 agent id 分配器 + 强制 1000 上限。 */
  nextAgentId(): number;
  /** Resume cache lookup by content key; returns the cached record or undefined. */
  /** 按内容 key 查找恢复缓存；返回缓存的 record 或 undefined。 */
  takeCached(key: string): AgentRecord | undefined;
  /** Append a freshly-produced (or cache-confirmed) record to the journal. */
  /** 把新产生（或缓存确认）的 record 追加到 journal。 */
  record(rec: AgentRecord): void;
  /** Accumulate output tokens for the run's tokensSpent metric (observability only; no ceiling). */
  /** 累加输出 token 用于本次 run 的 tokensSpent 观测指标（仅观测，无上限）。 */
  addTokens(n: number): void;
}

export const TOTAL_AGENT_CAP = 1000;

// codex-jsonl.ts — pure reducer over `codex exec --json` stdout
// codex-jsonl.ts —— 对 `codex exec --json` stdout 的纯 reducer
// (one JSON object per line). No I/O, no subprocess; just parse + fold.
// （每行一个 JSON 对象）。无 I/O、无子进程；只做解析 + 折叠。

/** Folded outcome of a codex JSONL event sequence. */
/** 一段 codex JSONL 事件序列折叠后的结果。 */
export interface CodexOutcome {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  resultSubtype: string;
  isError: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

/** JSON.parse one line; returns null on blank/whitespace or parse failure. */
/** 对单行做 JSON.parse；遇到空白行或解析失败时返回 null。 */
export function parseCodexJsonLine(line: string): any | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toFiniteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Fold the event stream into a single outcome. Defensive: tolerates missing
 * fields, skips malformed events, and treats unknown `item.type` values as
 * pass-through (never throws). `sessionId` comes from `thread.started`; `text`
 * is the last `agent_message` item's text; usage + terminal success come from
 * `turn.completed`; failures come from `turn.failed` / `error`.
 *
 * When `opts.schema` is set, `text` is JSON.parse'd into `structuredOutput`;
 * a parse failure flags `isError` rather than throwing. `isError` is true when
 * no turn completed, a turn failed, or a non-zero exit code was supplied.
 *
 * 把事件流折叠成单个结果。做了防御性处理：容忍缺失字段、跳过格式错误的事件，
 * 并把未知的 `item.type` 当作 pass-through（绝不抛出）。`sessionId` 取自
 * `thread.started`；`text` 取最后一个 `agent_message` item 的文本；用量与
 * 终止成功取自 `turn.completed`；失败取自 `turn.failed` / `error`。
 *
 * 当 `opts.schema` 为真时，对 `text` 做 JSON.parse 得到 `structuredOutput`；
 * 解析失败时标记 `isError` 而非抛出。`isError` 在以下情形为真：没有 turn
 * 完成、turn 失败、或传入了非零退出码。
 */
export function reduceCodexEvents(
  events: any[],
  opts?: { schema?: boolean; exitCode?: number | null },
): CodexOutcome {
  let lastAgentText: string | null = null;
  let sessionId: string | null = null;
  let sawCompleted = false;
  let sawTurnFailed = false;
  let errorMessage = "";

  const outcome: CodexOutcome = {
    text: "",
    sessionId: null,
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  for (const event of events) {
    if (!isObject(event)) continue;
    const type = event["type"];

    if (type === "thread.started") {
      const tid = event["thread_id"];
      if (typeof tid === "string") sessionId = tid;
      continue;
    }

    if (type === "item.completed") {
      // The agent's final answer (or a JSON string under structured output)
      // arrives as a completed `agent_message` item. Take the last one.
      // agent 的最终答案（结构化输出时是 JSON 字符串）以一个 completed 的
      // `agent_message` item 形式到达。取最后一个。
      const item = event["item"];
      if (isObject(item) && item["type"] === "agent_message") {
        const text = item["text"];
        if (typeof text === "string") lastAgentText = text;
      }
      // Any other item.type (command_execution / file_change / reasoning /
      // mcp_tool_call / web_search / todo_list / error …): ignore, never crash.
      // 其它 item.type：忽略，绝不崩。
      continue;
    }

    if (type === "turn.completed") {
      sawCompleted = true;
      const usage = event["usage"];
      if (isObject(usage)) {
        outcome.usage.inputTokens = toFiniteNumber(usage["input_tokens"]);
        outcome.usage.outputTokens = toFiniteNumber(usage["output_tokens"]);
      }
      continue;
    }

    if (type === "turn.failed") {
      sawTurnFailed = true;
      const error = event["error"];
      if (isObject(error) && typeof error["message"] === "string") {
        errorMessage = error["message"];
      }
      continue;
    }

    if (type === "error") {
      // Non-terminal stream error; keep the message for debugging fallback.
      // 非终止的流错误；保留 message 作为调试兜底。
      const message = event["message"];
      if (typeof message === "string") errorMessage = message;
      continue;
    }

    // thread.started's siblings (turn.started / item.started / item.updated)
    // and any unknown top-level type: ignore.
    // 其余顶层事件（turn.started / item.started / item.updated）以及任何
    // 未知顶层类型：忽略。
  }

  outcome.sessionId = sessionId;
  outcome.text = lastAgentText ?? "";

  const exitCode = opts?.exitCode;
  let isError =
    !sawCompleted ||
    sawTurnFailed ||
    (exitCode != null && exitCode !== 0);

  // When structured output is requested, parse the agent text as JSON. A parse
  // failure is an error (flag it, don't throw).
  // 请求结构化输出时，把 agent 文本当 JSON 解析。解析失败视为错误（标记，不抛）。
  if (opts?.schema) {
    try {
      outcome.structuredOutput = JSON.parse(outcome.text);
    } catch {
      isError = true;
    }
  }

  outcome.isError = isError;
  outcome.resultSubtype = isError ? "error_during_execution" : "success";

  // On failure with no agent text, surface the captured error message as text
  // so callers have something actionable to log.
  // 失败且没有 agent 文本时，把捕获到的错误信息放进 text，便于调用方记录。
  if (isError && outcome.text.length === 0 && errorMessage.length > 0) {
    outcome.text = errorMessage;
  }

  return outcome;
}

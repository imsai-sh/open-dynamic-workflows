// codex-jsonl.test.ts — unit tests for the codex `exec --json` reducer (pure, no I/O).
// codex-jsonl.test.ts —— codex `exec --json` reducer 的单元测试（纯函数，无 I/O）。
// Fixtures use the REAL event shapes emitted by `codex exec --json` (one JSON object
// 各 fixture 采用 `codex exec --json` 真实发出的事件形状（每行一个 JSON 对象），
// per line): thread.started{thread_id} → turn.started → item.completed{item:{type,text}}
// 形如 thread.started{thread_id} → turn.started → item.completed{item:{type,text}}
// → turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}.
// → turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}。
//
// Run: npx tsx --test src/executor/codex/codex-jsonl.test.ts
// 运行：npx tsx --test src/executor/codex/codex-jsonl.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceCodexEvents, parseCodexJsonLine } from "./codex-jsonl.js";

// A real codex thread id is a UUID; pin one so we can assert sessionId round-trips.
// 真实的 codex thread id 是一个 UUID；固定一个，便于断言 sessionId 原样透传。
const THREAD_ID = "67e55044-10b1-426f-9247-bb680e5fe0c8";

// ────────────────────────────────────────────────────────────────────────────
// Fixture builders — emit the exact line shapes codex writes, then JSON round-trip
// fixture 构造器 —— 产出 codex 真实写出的行形状，再走一遍 JSON 往返，
// each one so the reducer is fed exactly what `parseCodexJsonLine` would yield from
// 使得喂给 reducer 的，与 `parseCodexJsonLine` 从真实 stdout 解析出来的完全一致。
// real stdout (no hand-built object shortcuts).
// （不走手搓对象的捷径。）
// ────────────────────────────────────────────────────────────────────────────

/** Parse a list of raw JSONL lines into events, dropping blank/bad lines (null). */
/** 把一组原始 JSONL 行解析成事件，丢弃空行/坏行（null）。 */
function eventsFromLines(lines: string[]): any[] {
  const out: any[] = [];
  for (const line of lines) {
    const ev = parseCodexJsonLine(line);
    if (ev !== null) out.push(ev);
  }
  return out;
}

function threadStarted(threadId: string): string {
  return JSON.stringify({ type: "thread.started", thread_id: threadId });
}

function turnStarted(): string {
  return JSON.stringify({ type: "turn.started" });
}

/** A completed agent_message item — `item.text` is the final answer (or a JSON string). */
/** 一个 completed 的 agent_message item —— `item.text` 是最终答案（或一段 JSON 字符串）。 */
function agentMessage(text: string, id = "item_0"): string {
  return JSON.stringify({
    type: "item.completed",
    item: { id, type: "agent_message", text },
  });
}

/** A completed item of some other type (web_search / command_execution / …) — must not crash. */
/** 一个其它类型的 completed item（web_search / command_execution / …）—— 不可导致崩溃。 */
function otherItem(itemType: string, extra: Record<string, unknown> = {}, id = "item_x"): string {
  return JSON.stringify({
    type: "item.completed",
    item: { id, type: itemType, ...extra },
  });
}

/** turn.completed carries the cumulative usage breakdown (codex never reports USD). */
/** turn.completed 携带累计的 usage 明细（codex 从不报告 USD）。 */
function turnCompleted(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}): string {
  return JSON.stringify({ type: "turn.completed", usage });
}

function turnFailed(message: string): string {
  return JSON.stringify({ type: "turn.failed", error: { message } });
}

/** A non-terminal stream error (precedes turn.failed on backend errors). */
/** 一个非终止的流错误（后端出错时先于 turn.failed 出现）。 */
function errorEvent(message: string): string {
  return JSON.stringify({ type: "error", message });
}

// ────────────────────────────────────────────────────────────────────────────
// (1) happy path: thread.started → turn.started → agent_message → turn.completed
// (1) happy path：thread.started → turn.started → agent_message → turn.completed
// ────────────────────────────────────────────────────────────────────────────

test("(1) happy path: text/sessionId/usage extracted, isError=false, subtype=success", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    agentMessage("hello"),
    turnCompleted({
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 42,
      reasoning_output_tokens: 7,
    }),
  ]);

  const outcome = reduceCodexEvents(events);

  assert.equal(outcome.text, "hello");
  assert.equal(outcome.sessionId, THREAD_ID);
  // usage maps input_tokens/output_tokens (cached/reasoning are ignored by this reducer).
  // usage 取 input_tokens/output_tokens（cached/reasoning 不被本 reducer 采用）。
  assert.equal(outcome.usage.inputTokens, 100);
  assert.equal(outcome.usage.outputTokens, 42);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
  // No structured output requested → structuredOutput stays undefined.
  // 未请求结构化输出 → structuredOutput 保持 undefined。
  assert.equal(outcome.structuredOutput, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// (2) schema: agent_message.text is a JSON string → structuredOutput is parsed
// (2) schema：agent_message.text 是一段 JSON 字符串 → structuredOutput 被解析出来
// ────────────────────────────────────────────────────────────────────────────

test('(2) schema: agent_message.text=\'{"ok":true}\' parses to structuredOutput {ok:true}', () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    agentMessage('{"ok":true}'),
    turnCompleted({
      input_tokens: 5,
      cached_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 0,
    }),
  ]);

  const outcome = reduceCodexEvents(events, { schema: true });

  assert.deepEqual(outcome.structuredOutput, { ok: true });
  // The raw JSON text is preserved on `text`; the run still succeeded.
  // 原始 JSON 文本保留在 `text` 上；run 仍判为成功。
  assert.equal(outcome.text, '{"ok":true}');
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// (3) failure: error + turn.failed → isError=true, errorMessage surfaced as text
// (3) 失败：error + turn.failed → isError=true，errorMessage 进入 text
// ────────────────────────────────────────────────────────────────────────────

test("(3) failure: error + turn.failed → isError=true, error message surfaced as text", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    errorEvent("backend failed"),
    turnFailed("turn failed: backend failed"),
  ]);

  const outcome = reduceCodexEvents(events);

  assert.equal(outcome.isError, true);
  assert.equal(outcome.resultSubtype, "error_during_execution");
  // No agent_message arrived, so the captured failure message is surfaced as text.
  // 没有 agent_message 到达，因此把捕获到的失败信息放进 text。
  assert.equal(outcome.text, "turn failed: backend failed");
  // sessionId is still recovered from thread.started even on failure.
  // 即便失败，sessionId 仍能从 thread.started 取到。
  assert.equal(outcome.sessionId, THREAD_ID);
});

// ────────────────────────────────────────────────────────────────────────────
// (4) no turn.completed → isError=true (the turn never terminated cleanly)
// (4) 没有 turn.completed → isError=true（turn 从未干净地终止）
// ────────────────────────────────────────────────────────────────────────────

test("(4) missing turn.completed → isError=true even with an agent message present", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    agentMessage("partial answer"),
    // No turn.completed line. ｜ 没有 turn.completed 行。
  ]);

  const outcome = reduceCodexEvents(events);

  assert.equal(outcome.isError, true);
  assert.equal(outcome.resultSubtype, "error_during_execution");
  // The agent text we did see is still preserved.
  // 已经看到的 agent 文本仍被保留。
  assert.equal(outcome.text, "partial answer");
});

// ────────────────────────────────────────────────────────────────────────────
// (5) non-zero exitCode → isError=true, even when turn.completed is present
// (5) 非零 exitCode → isError=true，即便存在 turn.completed
// ────────────────────────────────────────────────────────────────────────────

test("(5) non-zero exitCode forces isError=true despite a clean turn.completed", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    agentMessage("hello"),
    turnCompleted({
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    }),
  ]);

  const outcome = reduceCodexEvents(events, { exitCode: 1 });

  assert.equal(outcome.isError, true);
  assert.equal(outcome.resultSubtype, "error_during_execution");
  // exitCode 0 with the same stream is success — confirm the exit code is the deciding factor.
  // 同一条流在 exitCode 0 下应为成功 —— 确认退出码才是决定因素。
  const ok = reduceCodexEvents(events, { exitCode: 0 });
  assert.equal(ok.isError, false);
  assert.equal(ok.resultSubtype, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// (6) unknown item.type (web_search / command_execution) does not crash the reducer
// (6) 未知 item.type（web_search / command_execution）不导致 reducer 崩溃
// ────────────────────────────────────────────────────────────────────────────

test("(6) unknown item types (web_search / command_execution) are tolerated, not fatal", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    otherItem("web_search", { query: "rust async await" }, "item_0"),
    otherItem(
      "command_execution",
      { command: "ls", aggregated_output: "a.txt\n", exit_code: 0, status: "completed" },
      "item_1",
    ),
    agentMessage("hello", "item_2"),
    turnCompleted({
      input_tokens: 8,
      cached_input_tokens: 0,
      output_tokens: 4,
      reasoning_output_tokens: 0,
    }),
  ]);

  // Must not throw; unknown items are pass-through, the agent_message still wins.
  // 不可抛错；未知 item 当 pass-through，agent_message 仍然胜出。
  const outcome = reduceCodexEvents(events);

  assert.equal(outcome.text, "hello");
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// (7) parseCodexJsonLine: blank / malformed lines → null (so the driver skips them)
// (7) parseCodexJsonLine：空行 / 坏行 → null（driver 据此跳过）
// ────────────────────────────────────────────────────────────────────────────

test("(7) parseCodexJsonLine returns null for blank / whitespace / malformed lines", () => {
  // Blank and whitespace-only lines → null. ｜ 空行与纯空白行 → null。
  assert.equal(parseCodexJsonLine(""), null);
  assert.equal(parseCodexJsonLine("   "), null);
  assert.equal(parseCodexJsonLine("\t  \n"), null);

  // Non-JSON / truncated JSON → null (never throws). ｜ 非 JSON / 截断的 JSON → null（绝不抛）。
  assert.equal(parseCodexJsonLine("not json at all"), null);
  assert.equal(parseCodexJsonLine('{"type":"thread.started"'), null);

  // A well-formed line still parses to the expected object. ｜ 正常行仍解析为预期对象。
  const ev = parseCodexJsonLine(threadStarted(THREAD_ID));
  assert.equal(ev.type, "thread.started");
  assert.equal(ev.thread_id, THREAD_ID);
});

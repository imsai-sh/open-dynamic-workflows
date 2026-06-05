// stream-json.test.ts — unit tests for the pure stream-json reducer. No I/O, no
// stream-json.test.ts —— stream-json 纯 reducer 的单元测试。无 I/O、无
// subprocess: we feed hand-built event arrays / lines and assert the fold result.
// 子进程：我们喂入手工构造的事件数组 / 文本行，并断言折叠后的结果。
// These guard reduceStreamJsonEvents/parseStreamJsonLine against executor refactors.
// 它们为 reduceStreamJsonEvents/parseStreamJsonLine 兜底，防 executor 重构回归。
//
// Run: npx tsx --test src/executor/claude/stream-json.test.ts
// 运行：npx tsx --test src/executor/claude/stream-json.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceStreamJsonEvents, parseStreamJsonLine } from "./stream-json.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers: tiny builders for the two event shapes we care about.
// 辅助函数：为我们关心的两种事件形状提供小巧的构造器。
// ────────────────────────────────────────────────────────────────────────────

/** An `assistant` event whose message.content is a single text block. */
/** 一个 `assistant` 事件，其 message.content 是单个 text block。 */
function assistantText(text: string): any {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

// ────────────────────────────────────────────────────────────────────────────
// (1) Multiple assistant events: their text blocks concatenate in order.
// (1) 多个 assistant 事件：它们的 text block 按顺序拼接。
// ────────────────────────────────────────────────────────────────────────────

test("(1) concatenates text from multiple assistant events (in order)", () => {
  const events = [
    assistantText("Hello, "),
    assistantText("brave "),
    // One assistant event may itself carry several content blocks, including
    // 单个 assistant 事件本身也可能携带多个 content block，包括
    // non-text blocks (e.g. tool_use) which must be ignored for text.
    // 必须在拼接 text 时被忽略的非 text block（如 tool_use）。
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "noop", input: {} },
          { type: "text", text: "new " },
          { type: "text", text: "world" },
        ],
      },
    },
    // `user` (tool result) events contribute nothing to the assistant text.
    // `user`（工具结果）事件对 assistant text 没有任何贡献。
    { type: "user", message: { content: [{ type: "text", text: "IGNORE ME" }] } },
    { type: "result", subtype: "success", is_error: false },
  ];

  const out = reduceStreamJsonEvents(events);
  assert.equal(out.text, "Hello, brave new world");
});

// ────────────────────────────────────────────────────────────────────────────
// (2) Terminal `result` event drives subtype/is_error/cost/session/usage/output.
// (2) 终止性 `result` 事件决定 subtype/is_error/cost/session/usage/structured_output。
// ────────────────────────────────────────────────────────────────────────────

test("(2) reads subtype/is_error/cost/session/usage/structured_output from result", () => {
  const events = [
    assistantText("answer"),
    {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.0123,
      session_id: "sess-abc",
      usage: { input_tokens: 42, output_tokens: 7 },
      structured_output: { ok: true, items: [1, 2, 3] },
    },
  ];

  const out = reduceStreamJsonEvents(events);
  assert.equal(out.text, "answer");
  assert.equal(out.resultSubtype, "success");
  assert.equal(out.isError, false);
  assert.equal(out.costUsd, 0.0123);
  assert.equal(out.sessionId, "sess-abc");
  assert.equal(out.usage.inputTokens, 42);
  assert.equal(out.usage.outputTokens, 7);
  assert.deepEqual(out.structuredOutput, { ok: true, items: [1, 2, 3] });
});

// ────────────────────────────────────────────────────────────────────────────
// (2b) A non-"success" result subtype implies isError when is_error is absent.
// (2b) 非 "success" 的 result subtype 在缺少 is_error 时推断为 isError。
// ────────────────────────────────────────────────────────────────────────────

test("(2b) non-success subtype without is_error is treated as an error", () => {
  const out = reduceStreamJsonEvents([
    assistantText("partial"),
    // No explicit is_error → derived from subtype !== "success".
    // 没有显式 is_error → 由 subtype !== "success" 推断。
    { type: "result", subtype: "error_max_turns", total_cost_usd: 0.5 },
  ]);

  assert.equal(out.resultSubtype, "error_max_turns");
  assert.equal(out.isError, true);
  // The result WAS seen, so cost survives (not zeroed like the no-result case).
  // result 确实出现过，所以 cost 保留（不会像「无 result」那样被归零）。
  assert.equal(out.costUsd, 0.5);
  // structuredOutput stays undefined when the key is absent from the event.
  // 当事件里没有该 key 时，structuredOutput 保持 undefined。
  assert.equal(out.structuredOutput, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// (3) No `result` event → isError, subtype "error_during_execution", all zeroed.
// (3) 没有 `result` 事件 → isError、subtype 为 "error_during_execution"、全部归零。
// ────────────────────────────────────────────────────────────────────────────

test("(3) missing result event yields an error outcome with zeroed cost/usage", () => {
  // Assistant text still accumulates; only the result-derived fields are reset.
  // assistant text 仍会累积；只有由 result 派生的字段被重置。
  const out = reduceStreamJsonEvents([
    assistantText("streamed "),
    assistantText("but never finished"),
  ]);

  assert.equal(out.text, "streamed but never finished");
  assert.equal(out.isError, true);
  assert.equal(out.resultSubtype, "error_during_execution");
  assert.equal(out.costUsd, 0);
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.usage.outputTokens, 0);
  // No session_id was ever observed.
  // 从未观察到 session_id。
  assert.equal(out.sessionId, null);
});

// ────────────────────────────────────────────────────────────────────────────
// (3b) An empty event stream is the degenerate no-result case.
// (3b) 空事件流是「无 result」的退化情形。
// ────────────────────────────────────────────────────────────────────────────

test("(3b) empty event array is an error with empty text and zeroed fields", () => {
  const out = reduceStreamJsonEvents([]);
  assert.equal(out.text, "");
  assert.equal(out.isError, true);
  assert.equal(out.resultSubtype, "error_during_execution");
  assert.equal(out.costUsd, 0);
  assert.equal(out.sessionId, null);
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.usage.outputTokens, 0);
  assert.equal(out.structuredOutput, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// (3c) Defensive: malformed / non-object events are skipped, not fatal.
// (3c) 防御性：格式错误 / 非对象的事件会被跳过，而非致命。
// ────────────────────────────────────────────────────────────────────────────

test("(3c) malformed entries are skipped; a later valid result still wins", () => {
  const out = reduceStreamJsonEvents([
    null,
    "not an object",
    42,
    assistantText("kept"),
    // An assistant event missing message/content contributes empty text.
    // 缺少 message/content 的 assistant 事件贡献空 text。
    { type: "assistant" },
    { type: "result", subtype: "success", is_error: false, session_id: "s9" },
  ] as any[]);

  assert.equal(out.text, "kept");
  assert.equal(out.isError, false);
  assert.equal(out.resultSubtype, "success");
  assert.equal(out.sessionId, "s9");
});

// ────────────────────────────────────────────────────────────────────────────
// (4) parseStreamJsonLine: blank/whitespace/garbage → null; valid line → object.
// (4) parseStreamJsonLine：空行/纯空白/坏行 → null；合法行 → 对象。
// ────────────────────────────────────────────────────────────────────────────

test("(4) parseStreamJsonLine returns null for blank, whitespace and bad lines", () => {
  assert.equal(parseStreamJsonLine(""), null);
  assert.equal(parseStreamJsonLine("   "), null);
  assert.equal(parseStreamJsonLine("\t \n"), null);
  // Not valid JSON.
  // 不是合法 JSON。
  assert.equal(parseStreamJsonLine("{ not json"), null);
  assert.equal(parseStreamJsonLine("undefined"), null);
});

test("(4) parseStreamJsonLine parses a valid line into the expected object", () => {
  const parsed = parseStreamJsonLine(
    '  {"type":"result","subtype":"success","is_error":false}  ',
  );
  assert.deepEqual(parsed, {
    type: "result",
    subtype: "success",
    is_error: false,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (4b) End-to-end: parse a multi-line stream-json transcript, then reduce it.
// (4b) 端到端：解析多行 stream-json 文本，再做 reduce。
// ────────────────────────────────────────────────────────────────────────────

test("(4b) parse-then-reduce a realistic line-delimited transcript", () => {
  const transcript = [
    "", // leading blank line is dropped by the parser ｜ 开头空行被 parser 丢弃
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-init" }),
    JSON.stringify(assistantText("The answer ")),
    JSON.stringify(assistantText("is 42.")),
    "   ", // stray whitespace line ｜ 杂散空白行
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.001,
      session_id: "s-final",
      usage: { input_tokens: 10, output_tokens: 3 },
    }),
    "", // trailing newline artifact ｜ 末尾换行残留
  ].join("\n");

  const events = transcript
    .split("\n")
    .map(parseStreamJsonLine)
    .filter((e): e is any => e !== null);

  // Blank/whitespace lines were dropped; four real events remain
  // 空白/空白行被丢弃；保留下来四个真实事件
  // (system/init + two assistant + result).
  // （system/init + 两个 assistant + result）。
  assert.equal(events.length, 4);

  const out = reduceStreamJsonEvents(events);
  assert.equal(out.text, "The answer is 42.");
  assert.equal(out.resultSubtype, "success");
  assert.equal(out.isError, false);
  assert.equal(out.costUsd, 0.001);
  // The final result's session_id wins over the earlier system event's.
  // 最终 result 的 session_id 覆盖了更早 system 事件里的值。
  assert.equal(out.sessionId, "s-final");
  assert.equal(out.usage.inputTokens, 10);
  assert.equal(out.usage.outputTokens, 3);
});

// ────────────────────────────────────────────────────────────────────────────
// (5) Defensive numeric coercion: non-finite / wrong-typed numbers fold to 0.
// (5) 防御性数值规整：非有限 / 类型错误的数字折叠为 0。
// ────────────────────────────────────────────────────────────────────────────

test("(5) non-numeric cost/usage fields coerce to zero", () => {
  const out = reduceStreamJsonEvents([
    {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: "free", // wrong type ｜ 类型错误
      usage: { input_tokens: null, output_tokens: "lots" },
    },
  ]);

  assert.equal(out.costUsd, 0);
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.usage.outputTokens, 0);
});

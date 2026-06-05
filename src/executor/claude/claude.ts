// executor/claude/claude.ts — the only module that touches `claude`.
// executor/claude/claude.ts —— 唯一直接调用 `claude` 的模块。
//
// Spawns `claude --print --output-format=stream-json`, feeds the prompt on stdin,
// 启动 `claude --print --output-format=stream-json`，把 prompt 喂给 stdin，
// parses the stream-json line-by-line, and reduces it to an ExecResult. The CLI-neutral
// 逐行解析 stream-json，并归约成一个 ExecResult。与 CLI 无关的
// machinery (spawn / process-group kill / wall+idle+abort watchdogs / line buffering /
// 机制（spawn / 进程组 kill / wall+idle+abort 看门狗 / 行缓冲 /
// trace) lives in subprocess.ts; this module only injects what is specific to `claude`.
// trace）放在 subprocess.ts；本模块只注入与 `claude` 相关的部分。

import type { ExecOptions, Executor } from "../../types.js";
import { parseStreamJsonLine, reduceStreamJsonEvents } from "./stream-json.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

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

/**
 * Fold the parsed stream-json events into an ExecResultCore. claude trusts its terminal
 * `result` event, so exitCode is ignored. Keeps the stderr fallback: on an error result
 * with empty text, surface trimmed stderr so the failure is debuggable.
 *
 * 把解析后的 stream-json 事件折叠成 ExecResultCore。claude 以其终止性的 `result` 事件
 * 为准，因此忽略 exitCode。保留 stderr 兜底：错误结果且 text 为空时，带出 trim 后的
 * stderr，便于排查失败。
 */
function reduceClaude(events: unknown[], ctx: { stderr: string }): ExecResultCore {
  const outcome = reduceStreamJsonEvents(events as any[]);

  const core: ExecResultCore = {
    text: outcome.text,
    sessionId: outcome.sessionId,
    costUsd: outcome.costUsd,
    resultSubtype: outcome.resultSubtype,
    isError: outcome.isError,
    usage: outcome.usage,
  };
  if (outcome.structuredOutput !== undefined) {
    core.structuredOutput = outcome.structuredOutput;
  }

  // Surface stderr context on error results for debuggability (never throws).
  // 在错误结果上带出 stderr 上下文以便调试（绝不抛异常）。
  if (core.isError && ctx.stderr.trim().length > 0 && core.text.length === 0) {
    core.text = ctx.stderr.trim();
  }

  return core;
}

export const claudeExecutor: Executor = makeSubprocessExecutor({
  command: "claude",
  prepare: async (opts) => ({ args: buildClaudeArgs(opts), stdin: opts.prompt }),
  parseLine: parseStreamJsonLine,
  reduce: (events, { stderr }) => reduceClaude(events, { stderr }),
});

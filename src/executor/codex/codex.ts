// executor/codex/codex.ts — the only module that touches `codex`.
// executor/codex/codex.ts —— 唯一直接调用 `codex` 的模块。
//
// Spawns `codex exec --json`, feeds the prompt on stdin, parses the JSONL events
// 启动 `codex exec --json`，把 prompt 喂给 stdin，逐行解析 JSONL 事件
// line-by-line, and reduces them to an ExecResult. The CLI-neutral machinery (spawn /
// 并归约成一个 ExecResult。与 CLI 无关的机制（spawn /
// process-group kill / wall+idle+abort watchdogs / line buffering / trace) lives in
// 进程组 kill / wall+idle+abort 看门狗 / 行缓冲 / trace）放在
// subprocess.ts; this module only injects what is specific to `codex`.
// subprocess.ts；本模块只注入与 `codex` 相关的部分。

import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, Executor } from "../../types.js";
import { parseCodexJsonLine, reduceCodexEvents } from "./codex-jsonl.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

/**
 * Build the argv for `codex exec` from ExecOptions. The fixed base is
 * `exec --json --skip-git-repo-check --color never --sandbox workspace-write`:
 * `--json` emits JSONL events; the cwd may be a non-git dir / worktree, so
 * `--skip-git-repo-check` is mandatory; `--sandbox workspace-write` is the
 * acceptEdits counterpart. INVARIANT: never emits
 * `--dangerously-bypass-approvals-and-sandbox` (the codex twin of claude's
 * "no --dangerously-skip-permissions" rule). The prompt is fed on stdin, so the
 * final argv token is `-` ("read from stdin"), which also dodges the argv length
 * limit on long prompts — the same approach claude takes.
 *
 * 根据 ExecOptions 构造 `codex exec` 的 argv。固定基底是
 * `exec --json --skip-git-repo-check --color never --sandbox workspace-write`：
 * `--json` 输出 JSONL 事件；cwd 可能是非 git 目录 / worktree，所以必带
 * `--skip-git-repo-check`；`--sandbox workspace-write` 是 acceptEdits 的对应物。
 * 【不变量】绝不输出 `--dangerously-bypass-approvals-and-sandbox`（claude 侧
 * “绝不 --dangerously-skip-permissions” 规则的 codex 对应物）。prompt 经 stdin
 * 喂入，因此 argv 末尾给 `-`（“从 stdin 读”），这也避免超长 prompt 撞 argv
 * 长度上限 —— 与 claude 的做法一致。
 */
export function buildCodexArgs(opts: ExecOptions, schemaPath?: string): string[] {
  const args: string[] = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
  ];
  if (opts.model) args.push("-m", opts.model);
  if (schemaPath) args.push("--output-schema", schemaPath);
  if (opts.appendSystemPrompt) {
    // append semantics (a developer-role message), not a base-prompt override.
    // append 语义（developer 角色消息），不覆盖 codex base。
    args.push("-c", `developer_instructions=${opts.appendSystemPrompt}`);
  }
  // resumeSessionId is intentionally not wired: runtime resume is journal replay
  // (it re-emits the stored neutral result and spawns no CLI), so no CLI-level
  // `exec resume` is needed here.
  // 故意不接 resumeSessionId：运行时 resume 是 journal 重放（重发存下来的中立
  // 结果、不 spawn 任何 CLI），因此这里不需要 CLI 级的 `exec resume`。

  // The prompt is read from stdin; `-` is the trailing positional that tells codex so.
  // prompt 从 stdin 读；`-` 是末尾位置参数，用来告诉 codex 这一点。
  args.push("-");
  return args;
}

/**
 * Fold the parsed codex JSONL events into an ExecResultCore. codex reports no USD,
 * so costUsd is always 0; usage comes from the reducer's input/output token counts.
 * The reducer needs to know whether structured output was requested (it then
 * JSON.parse's the agent text), which is derived from opts.schema; the exit code
 * also feeds the reducer's failure detection.
 *
 * 把解析后的 codex JSONL 事件折叠成 ExecResultCore。codex 不报 USD，所以 costUsd
 * 恒为 0；usage 取自 reducer 的 input/output token 计数。reducer 需要知道本次是否
 * 请求了结构化输出（届时它会对 agent 文本做 JSON.parse），这一点由 opts.schema
 * 推出；退出码也喂给 reducer 的失败判定。
 */
function reduceCodex(
  events: unknown[],
  ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
): ExecResultCore {
  const outcome = reduceCodexEvents(events as any[], {
    schema: ctx.opts.schema !== undefined,
    exitCode: ctx.exitCode,
  });

  const core: ExecResultCore = {
    text: outcome.text,
    sessionId: outcome.sessionId,
    costUsd: 0,
    resultSubtype: outcome.resultSubtype,
    isError: outcome.isError,
    usage: {
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    },
  };
  if (outcome.structuredOutput !== undefined) {
    core.structuredOutput = outcome.structuredOutput;
  }

  // Surface stderr as a last resort when the turn errored with no usable text — e.g. a
  // usage-limit / auth failure that kills codex before it emits any JSON event, leaving
  // the reason only on stderr. codex's stderr is noisy, but a real reason beats an opaque
  // error_during_execution. Mirrors the claude executor's stderr fallback.
  // 当 turn 出错且没有可用 text 时(例如配额/认证导致 codex 在吐出任何 JSON 事件前就死,
  // 原因只留在 stderr),把 stderr 兜出来作为最后手段。codex 的 stderr 很吵,但有个真实
  // 原因总好过一句空洞的 error_during_execution。与 claude 执行器的 stderr 兜底一致。
  if (core.isError && ctx.stderr.trim().length > 0 && core.text.length === 0) {
    core.text = ctx.stderr.trim();
  }

  return core;
}

export const codexExecutor: Executor = makeSubprocessExecutor({
  command: "codex",
  prepare: async (opts) => {
    // No schema → plain argv + stdin, nothing to clean up.
    // 无 schema → 直接 argv + stdin，没有需要清理的东西。
    if (opts.schema === undefined) {
      return { args: buildCodexArgs(opts), stdin: opts.prompt };
    }

    // codex takes --output-schema as a file path, so write the schema to a uniquely
    // named temp file. The executor is host code (not sandboxed), so crypto is fine.
    // cleanup deletes the temp file and swallows any error (a debug artifact must
    // never mask the real settlement reason).
    // codex 的 --output-schema 接收文件路径，因此把 schema 写到一个唯一命名的临时
    // 文件。executor 是 host 代码（非沙箱），可自由用 crypto。cleanup 删除该临时
    // 文件并吞掉任何错误（一个 debug 产物绝不应掩盖真正的 settlement 原因）。
    const schemaPath = join(
      tmpdir(),
      `codex-schema-${randomBytes(8).toString("hex")}.json`,
    );
    await writeFile(schemaPath, JSON.stringify(opts.schema));
    return {
      args: buildCodexArgs(opts, schemaPath),
      stdin: opts.prompt,
      cleanup: () => unlink(schemaPath).catch(() => {}),
    };
  },
  parseLine: parseCodexJsonLine,
  reduce: (events, { stderr, exitCode, opts }) =>
    reduceCodex(events, { stderr, exitCode, opts }),
});

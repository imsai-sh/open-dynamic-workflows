// subprocess.test.ts — exercises the CLI-agnostic driver with a fake "CLI" (`node -e`),
// so event capture / stderr / exit-code / the persisted trace are tested deterministically,
// with no network and no real claude/codex. The driver otherwise has no direct test.
// subprocess.test.ts —— 用一个假“CLI”(`node -e`)驱动 CLI 无关的 driver,
// 从而确定性地测试事件捕获 / stderr / 退出码 / 落盘的 trace,不联网、不碰真 claude/codex。
// 该 driver 此前没有任何直接测试。
//
// Run: npx tsx --test src/executor/subprocess.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExecOptions } from "../types.js";
import {
  makeSubprocessExecutor,
  type ExecResultCore,
  type ExecTrace,
} from "./subprocess.js";

// An executor whose "CLI" is `node -e <body>`. The body prints JSONL to stdout, text to
// stderr, and exits with whatever code it likes. reduce() folds events like the real
// executors do — including the stderr fallback on an error result with empty text.
// 一个“CLI”是 `node -e <body>` 的执行器。body 往 stdout 打 JSONL、往 stderr 打文本、
// 以任意退出码退出。reduce() 像真实执行器那样折叠事件——含错误且 text 为空时的 stderr 兜底。
function nodeExecutor(body: string) {
  return makeSubprocessExecutor({
    command: process.execPath, // node
    prepare: async (_opts: ExecOptions) => ({ args: ["-e", body] }),
    parseLine: (line: string): unknown | null => {
      const t = line.trim();
      if (t.length === 0) return null;
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    },
    reduce: (
      events: unknown[],
      ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
    ): ExecResultCore => {
      const last = events[events.length - 1] as { type?: string; text?: unknown } | undefined;
      const ok = last?.type === "done" && ctx.exitCode === 0;
      const core: ExecResultCore = {
        text: ok ? String(last?.text ?? "") : "",
        sessionId: null,
        costUsd: 0,
        resultSubtype: ok ? "success" : "error_during_execution",
        isError: !ok,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      if (core.isError && ctx.stderr.trim().length > 0 && core.text.length === 0) {
        core.text = ctx.stderr.trim();
      }
      return core;
    },
  });
}

function freshOpts(extra: Partial<ExecOptions> = {}): ExecOptions {
  const dir = mkdtempSync(path.join(tmpdir(), "odw-subproc-"));
  return { prompt: "hello", cwd: dir, tracePath: path.join(dir, "trace.json"), ...extra };
}

test("subprocess: happy path captures events, resolves ExecResult, writes a rich trace", async () => {
  const exec = nodeExecutor(
    `process.stdout.write(JSON.stringify({type:'started'})+'\\n');` +
      `process.stdout.write(JSON.stringify({type:'done',text:'echo-ok'})+'\\n');`,
  );
  const opts = freshOpts();
  const res = await exec(opts);

  assert.equal(res.isError, false);
  assert.equal(res.text, "echo-ok");

  const trace = JSON.parse(readFileSync(opts.tracePath as string, "utf8")) as ExecTrace;
  assert.equal(trace.exitCode, 0);
  assert.equal(trace.isError, false);
  assert.equal(trace.prompt, "hello");
  assert.equal(trace.command, process.execPath);
  assert.equal(trace.events.length, 2);
});

test("subprocess: a nonzero-exit, stderr-only failure surfaces stderr AND records it in the trace", async () => {
  const exec = nodeExecutor(
    `process.stderr.write("BOOM: you've hit your usage limit");process.exit(1)`,
  );
  const opts = freshOpts({ prompt: "do work" });
  const res = await exec(opts);

  // The reason is salvaged from stderr even though stdout had zero parseable events —
  // exactly the codex "usage-limit before any JSON event" shape.
  // 即便 stdout 没有任何可解析事件,原因也从 stderr 里被救回来 —— 正是 codex
  // “在任何 JSON 事件之前就撞上 usage-limit” 的形态。
  assert.equal(res.isError, true);
  assert.match(res.text, /usage limit/);

  const trace = JSON.parse(readFileSync(opts.tracePath as string, "utf8")) as ExecTrace;
  assert.equal(trace.exitCode, 1);
  assert.match(trace.stderr, /usage limit/);
  assert.equal(trace.events.length, 0);
});

// smoke.test.ts — end-to-end proof that the workflow runtime works WITHOUT spending real
// smoke.test.ts —— 端到端验证 workflow runtime 能跑通，且不消耗真实的
// claude tokens. We inject a FAKE Executor via RunOptions.executor so no `claude --print`
// claude token。我们通过 RunOptions.executor 注入一个 FAKE Executor，因此永远不会 spawn `claude --print`
// subprocess is ever spawned. Each test pins a unique runDir to avoid journal clashes.
// 子进程。每个测试固定一个唯一的 runDir，以避免 journal 冲突。
//
// Run: npx tsx --test src/smoke.test.ts
// 运行：npx tsx --test src/smoke.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runWorkflow } from "./runtime/run.js";
import type { Executor, ExecOptions, ExecResult, ProgressEvent, RunOptions } from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// Fake executor (per task spec). Resolves instantly; never touches `claude`.
// 伪造的 executor（按任务规格）。立即 resolve；永远不碰 `claude`。
// ────────────────────────────────────────────────────────────────────────────

function makeFakeResult(opts: ExecOptions): ExecResult {
  return {
    text: "FAKE:" + opts.prompt.slice(0, 20),
    structuredOutput: opts.schema ? { ok: true } : undefined,
    sessionId: "fake",
    costUsd: 0,
    durationMs: 1,
    resultSubtype: "success",
    isError: false,
    usage: { inputTokens: 1, outputTokens: 5 },
  };
}

const fakeExecutor: Executor = async (opts) => makeFakeResult(opts);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_ROOT = path.join(REPO_ROOT, ".workflow-runs");

let dirSeq = 0;
/** A unique runDir under .workflow-runs for each test, so journals never collide. */
/** 为每个测试在 .workflow-runs 下生成一个唯一的 runDir，使 journal 永不冲突。 */
function uniqueRunDir(tag: string): string {
  dirSeq += 1;
  return path.join(RUNS_ROOT, `smoke-${tag}-${dirSeq}`);
}

/** Base RunOptions with the fake executor wired in; per-test runDir + script. */
/** 接好了 fake executor 的基础 RunOptions；带每个测试各自的 runDir + script。 */
function opts(tag: string, script: string, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    script,
    executor: fakeExecutor,
    runDir: uniqueRunDir(tag),
    ...extra,
  };
}

const META = `export const meta = { name: 'smoke', description: 'smoke test workflow' }\n`;

// ────────────────────────────────────────────────────────────────────────────
// (a) phase()/log()/agent() — script value returned; agent() text = "FAKE:..."
// (a) phase()/log()/agent() —— 返回 script 的返回值；agent() 的 text = "FAKE:..."
// ────────────────────────────────────────────────────────────────────────────

test("(a) script with phase/log/agent returns its value; agent() text is FAKE:prompt", async () => {
  const script = `${META}
phase('Scan');
log('starting');
const t = await agent('hello world prompt for the agent');
return { text: t };
`;
  const res = await runWorkflow(opts("a", script));
  assert.equal(typeof res.value, "object");
  const value = res.value as { text: string };
  // "FAKE:" + first 20 chars of the prompt.
  // "FAKE:" + prompt 的前 20 个字符。
  assert.equal(value.text, "FAKE:hello world prompt f");
  assert.ok(value.text.startsWith("FAKE:"));
});

// ────────────────────────────────────────────────────────────────────────────
// (b) agent() with schema returns the validated structured object { ok: true }
// (b) 带 schema 的 agent() 返回经校验的结构化对象 { ok: true }
// ────────────────────────────────────────────────────────────────────────────

test("(b) agent() with schema returns the structured object { ok: true }", async () => {
  const script = `${META}
const obj = await agent('give me structured output', {
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
});
return obj;
`;
  const res = await runWorkflow(opts("b", script));
  assert.deepEqual(res.value, { ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// (c) parallel([ok, throwing]) → [value, null]; call never rejects, order kept
// (c) parallel([ok, throwing]) → [value, null]；调用永不 reject，顺序保持不变
// ────────────────────────────────────────────────────────────────────────────

test("(c) parallel([ok, throwing]) resolves to [value, null]", async () => {
  const script = `${META}
const out = await parallel([
  async () => await agent('the good one'),
  async () => { throw new Error('boom'); },
]);
return out;
`;
  const res = await runWorkflow(opts("c", script));
  const out = res.value as unknown[];
  assert.equal(out.length, 2);
  assert.equal(out[0], "FAKE:the good one");
  assert.equal(out[1], null);
});

// ────────────────────────────────────────────────────────────────────────────
// (d) pipeline([1,2,3], s1, s2) maps correctly; a throwing stage → null at that
// (d) pipeline([1,2,3], s1, s2) 正确映射；某个阶段抛错 → 该位置变为 null，
//     position while the other items still succeed.
//     而其他 item 仍然成功。
// ────────────────────────────────────────────────────────────────────────────

test("(d) pipeline maps (prev,original,index) and drops a throwing item to null", async () => {
  const script = `${META}
const out = await pipeline(
  [1, 2, 3],
  async (prev, original, index) => {
    // s1 receives the original item as prev for the first stage.
    // 第一阶段 s1 收到的 prev 就是原始 item。
    if (prev !== original) throw new Error('stage1 prev should equal original');
    if (original === 2) throw new Error('blow up item 2 in stage 1');
    return prev * 10 + index;     // 1->10+0=10 ; 3->30+2=32 ｜ 1->10+0=10 ; 3->30+2=32
  },
  async (prev) => prev + 1,        // 10->11 ; 32->33 ｜ 10->11 ; 32->33
);
return out;
`;
  const res = await runWorkflow(opts("d", script));
  // item 1: (1*10+0)+1 = 11 ; item 2: thrown in stage 1 -> null ; item 3: (3*10+2)+1 = 33
  // item 1: (1*10+0)+1 = 11 ; item 2: 在阶段 1 抛错 -> null ; item 3: (3*10+2)+1 = 33
  assert.deepEqual(res.value, [11, null, 33]);
});

// ────────────────────────────────────────────────────────────────────────────
// (f) sandbox determinism traps (SPEC §6): Date.now() and Math.random() throw
// (f) 沙箱确定性陷阱（SPEC §6）：Date.now() 和 Math.random() 在 script 内部
//     inside the script → runWorkflow rejects.
//     抛错 → runWorkflow reject。
// ────────────────────────────────────────────────────────────────────────────

test("(f) wall-clock-now API (Date.now) makes the run reject", async () => {
  const script = `${META}
const t = Date.now();
return t;
`;
  await assert.rejects(runWorkflow(opts("f-date", script)));
});

test("(f) randomness API (Math.random) makes the run reject", async () => {
  const script = `${META}
const r = Math.random();
return r;
`;
  await assert.rejects(runWorkflow(opts("f-rand", script)));
});

test("(f) argless new Date() is rejected by the static determinism scan", async () => {
  await assert.rejects(
    runWorkflow(opts("f-newdate", `${META}\nreturn new Date();\n`)),
    /deterministic/i,
  );
});

test("(f) argless Intl.DateTimeFormat().format() is trapped (no ambient wall-clock leak)", async () => {
  // ECMA-402 defaults a missing/undefined date arg to the system clock in engine C++,
  // ECMA-402 在引擎 C++ 层会把缺失/undefined 的 date 参数默认为系统时钟，
  // bypassing the SafeDate override — must be trapped at the Intl layer.
  // 从而绕过 SafeDate 覆盖 —— 必须在 Intl 层加以拦截。
  await assert.rejects(
    runWorkflow(opts("f-intl-fmt", `${META}\nreturn Intl.DateTimeFormat().format();\n`)),
  );
  await assert.rejects(
    runWorkflow(opts("f-intl-parts", `${META}\nreturn Intl.DateTimeFormat().formatToParts();\n`)),
  );
  await assert.rejects(
    runWorkflow(opts("f-intl-undef", `${META}\nreturn Intl.DateTimeFormat().format(undefined);\n`)),
  );
});

test("(f) explicit Intl.DateTimeFormat().format(ts) + NumberFormat still work", async () => {
  const script = `${META}
const d = Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(0);
const n = Intl.NumberFormat('en-US').format(1234.5);
return { d, n };
`;
  const res = await runWorkflow(opts("f-intl-ok", script));
  const v = res.value as { d: string; n: string };
  assert.equal(v.d, "01/01/1970");
  assert.equal(v.n, "1,234.5");
});

test("(f) Intl formatRange: explicit args work (this bound), argless trapped", async () => {
  const ok = `${META}
return Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatRange(0, 86400000);
`;
  const res = await runWorkflow(opts("f-intl-range", ok));
  assert.equal(typeof res.value, "string");
  assert.ok((res.value as string).includes("1970"));

  await assert.rejects(
    runWorkflow(opts("f-intl-range-argless", `${META}\nreturn Intl.DateTimeFormat().formatRange();\n`)),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// (g) non-literal meta rejects (SPEC §3) — a meta that references a variable is
// (g) 非字面量的 meta 被拒（SPEC §3）—— 引用了变量的 meta
//     not a pure literal, so extractMeta throws and the run rejects.
//     不是纯字面量，因此 extractMeta 抛错，整个 run 被 reject。
// ────────────────────────────────────────────────────────────────────────────

test("(g) non-literal meta rejects", async () => {
  const nameVar = "computed-name";
  const script = `const n = ${JSON.stringify(nameVar)};
export const meta = { name: n, description: 'meta references a variable -> not a pure literal' }
return 'unreachable';
`;
  await assert.rejects(runWorkflow(opts("g", script)));
});

// ────────────────────────────────────────────────────────────────────────────
// (h) WorkflowResult shape: runId/value present; events include run_start,
// (h) WorkflowResult 的形状：runId/value 存在；events 包含 run_start、
//     agent_start, agent_end, run_end.
//     agent_start、agent_end、run_end。
// ────────────────────────────────────────────────────────────────────────────

test("(h) WorkflowResult shape + event lifecycle (run_start/agent_start/agent_end/run_end)", async () => {
  const script = `${META}
const t = await agent('one agent for the lifecycle');
return t;
`;
  const res = await runWorkflow(opts("h", script));

  assert.equal(typeof res.runId, "string");
  assert.ok(res.runId.length > 0);
  assert.equal(res.value, "FAKE:one agent for the li");
  assert.ok(Array.isArray(res.events));

  const types = res.events.map((e) => e.type);
  assert.ok(types.includes("run_start"), "events should include run_start");
  assert.ok(types.includes("agent_start"), "events should include agent_start");
  assert.ok(types.includes("agent_end"), "events should include agent_end");
  assert.ok(types.includes("run_end"), "events should include run_end");

  // run_start first, run_end last; agent events sit between them.
  // run_start 在最前，run_end 在最后；agent 事件位于二者之间。
  assert.equal(types[0], "run_start");
  assert.equal(types[types.length - 1], "run_end");
});

// ────────────────────────────────────────────────────────────────────────────
// (i) sandbox Date trap is NOT escapable via an instance's .constructor (SPEC §6).
// (i) 沙箱的 Date 陷阱无法通过实例的 .constructor 逃逸（SPEC §6）。
//     `new Date(0).constructor.now()`, `Date.prototype.constructor.now()`, and the
//     `new Date(0).constructor.now()`、`Date.prototype.constructor.now()`，以及
//     argless `new (instance.constructor)()` all reach the trapped SafeDate, so the
//     无参的 `new (instance.constructor)()` 都会触达被拦截的 SafeDate，因此
//     run must reject — the determinism guarantee can't be defeated.
//     run 必须 reject —— 确定性保证无法被攻破。
// ────────────────────────────────────────────────────────────────────────────

test("(i) Date trap is not escapable via instance.constructor.now()", async () => {
  await assert.rejects(
    runWorkflow(opts("i-ctor-now", `${META}\nreturn new Date(0).constructor.now();\n`)),
  );
});

test("(i) Date trap is not escapable via Date.prototype.constructor.now()", async () => {
  await assert.rejects(
    runWorkflow(opts("i-proto-ctor", `${META}\nreturn Date.prototype.constructor.now();\n`)),
  );
});

test("(i) Date trap is not escapable via argless new (instance.constructor)()", async () => {
  await assert.rejects(
    runWorkflow(opts("i-ctor-new", `${META}\nconst C = new Date(0).constructor; return new C();\n`)),
  );
});

test("(i) Date trap is not escapable via structuredClone (host back-channel removed)", async () => {
  // structuredClone reconstructs Dates on the real untrapped prototype; it must not be
  // structuredClone 会在真实的、未被拦截的 prototype 上重建 Date 对象；因此它绝不能被
  // exposed, so referencing it inside the script throws (ReferenceError) → run rejects.
  // 暴露出来，所以在 script 内引用它会抛错（ReferenceError）→ run 被 reject。
  await assert.rejects(
    runWorkflow(opts("i-sclone", `${META}\nreturn structuredClone(new Date(0)).constructor.now();\n`)),
  );
  await assert.rejects(
    runWorkflow(opts("i-sclone-nested", `${META}\nreturn structuredClone({ d: new Date(5) }).d.constructor.now();\n`)),
  );
});

test("(i) explicit Date construction + parse still work (legit path not broken)", async () => {
  const script = `${META}
return {
  t: new Date(0).getTime(),
  iso: new Date(0).toISOString(),
  parsed: Date.parse('1970-01-01T00:00:00.000Z'),
};
`;
  const res = await runWorkflow(opts("i-legit", script));
  // NB: the script's returned object literal carries the vm context's Object.prototype,
  // 注意：script 返回的对象字面量携带的是 vm context 的 Object.prototype，
  // so assert.deepEqual (=deepStrictEqual, prototype-sensitive) would fail across realms.
  // 因此 assert.deepEqual（=deepStrictEqual，对 prototype 敏感）跨 realm 会失败。
  // Assert fields individually, like the other tests do.
  // 像其他测试那样逐个字段断言。
  const v = res.value as { t: number; iso: string; parsed: number };
  assert.equal(v.t, 0);
  assert.equal(v.iso, "1970-01-01T00:00:00.000Z");
  assert.equal(v.parsed, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// (j) Every ProgressEvent is persisted to runDir/events.jsonl (SPEC §10), not just
// (j) 每个 ProgressEvent 都会持久化到 runDir/events.jsonl（SPEC §10），而不仅仅是
//     buffered in-memory / fanned to onEvent.
//     在内存中缓冲 / 分发给 onEvent。
// ────────────────────────────────────────────────────────────────────────────

test("(j) events.jsonl is appended to disk with the full lifecycle", async () => {
  const baseDir = uniqueRunDir("j");
  const script = `${META}\nphase('Scan');\nconst t = await agent('persist my events');\nreturn t;\n`;
  const res = await runWorkflow({ script, executor: fakeExecutor, runDir: baseDir });

  const eventsPath = path.join(baseDir, res.runId, "events.jsonl");
  const raw = await readFile(eventsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);

  assert.ok(types.includes("run_start"), "events.jsonl should include run_start");
  assert.ok(types.includes("phase_start"), "events.jsonl should include phase_start");
  assert.ok(types.includes("agent_start"), "events.jsonl should include agent_start");
  assert.ok(types.includes("agent_end"), "events.jsonl should include agent_end");
  assert.ok(types.includes("run_end"), "events.jsonl should include run_end");
  // On-disk events match the in-memory events array length.
  // 磁盘上的 events 与内存中 events 数组的长度一致。
  assert.equal(lines.length, res.events.length);
});

// ────────────────────────────────────────────────────────────────────────────
// (k) resume: a second run against the same baseDir replays unchanged (prompt,opts)
// (k) resume：针对同一 baseDir 的第二次 run 会从 journal 重放那些 (prompt,opts) 未变的
//     agent() results from the journal — zero executor calls, zero token spend.
//     agent() 结果 —— 零次 executor 调用，零 token 消耗。
// ────────────────────────────────────────────────────────────────────────────

test("(k) resume replays cached agent results with zero spend on the second run", async () => {
  const baseDir = uniqueRunDir("k");
  let calls = 0;
  const countingExecutor: Executor = async (o) => {
    calls += 1;
    return makeFakeResult(o);
  };
  const script = `${META}\nconst a = await agent('first');\nconst b = await agent('second');\nreturn [a, b];\n`;

  const r1 = await runWorkflow({ script, executor: countingExecutor, runDir: baseDir });
  assert.equal(calls, 2, "first run spawns both agents");
  assert.equal(r1.tokensSpent, 10, "first run spends 2 × 5 output tokens");

  const callsAfterFirst = calls;
  const r2 = await runWorkflow({
    script,
    executor: countingExecutor,
    runDir: baseDir,
    resumeFromRunId: r1.runId,
  });
  assert.equal(calls, callsAfterFirst, "resume makes NO new executor calls");
  assert.equal(r2.tokensSpent, 0, "resume spends zero tokens (full cache hit)");

  const v1 = r1.value as string[];
  const v2 = r2.value as string[];
  assert.equal(v2[0], v1[0]);
  assert.equal(v2[1], v1[1]);
});

// ────────────────────────────────────────────────────────────────────────────
// (l) cancellation: aborting RunOptions.signal mid-run kills in-flight agents, makes
// (l) 取消：在 run 进行中 abort RunOptions.signal 会杀掉在途的 agent，使
//     parallel() re-throw (run rejects), and surfaces a `skipped` agent_end event.
//     parallel() 重新抛错（run 被 reject），并产生一个标记为 `skipped` 的 agent_end 事件。
// ────────────────────────────────────────────────────────────────────────────

test("(l) RunOptions.signal aborts an in-flight run; parallel re-throws + emits skipped", async () => {
  const controller = new AbortController();
  // Resolves only after a long delay, but rejects promptly when its signal aborts —
  // 只在长时间延迟后才 resolve，但当其 signal abort 时会立即 reject ——
  // standing in for a real `claude --print` subprocess that gets SIGKILLed.
  // 用来模拟一个被 SIGKILL 掉的真实 `claude --print` 子进程。
  const slowExecutor: Executor = (o) =>
    new Promise<ExecResult>((resolve, reject) => {
      if (o.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = setTimeout(() => resolve(makeFakeResult(o)), 5_000);
      o.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

  const events: ProgressEvent[] = [];
  const script = `${META}\nreturn await parallel([() => agent('a'), () => agent('b')]);\n`;
  const p = runWorkflow({
    script,
    executor: slowExecutor,
    runDir: uniqueRunDir("l"),
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e);
    },
  });

  setTimeout(() => controller.abort(), 50);

  await assert.rejects(p, /aborted/);
  assert.ok(
    events.some((e) => e.type === "agent_end" && e.skipped === true),
    "a cancelled agent emits agent_end{skipped:true}",
  );
});

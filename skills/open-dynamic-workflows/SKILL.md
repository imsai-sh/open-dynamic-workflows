---
name: open-dynamic-workflows
description: >-
  Use when a task needs more agents than one conversation can coordinate, or when you want
  the orchestration codified as a rerunnable script — codebase-wide audits/bug sweeps,
  large migrations (hundreds of files), research that cross-checks sources against each
  other, or a hard plan worth drafting from several independent angles. Teaches how to
  WRITE a dynamic-workflow JavaScript script (the official contract) and how to RUN it on
  this project's runtime (`workflow run` / `runWorkflow`).
---

# Dynamic workflows: how to write one, and how to run it

A dynamic workflow is a **JavaScript script that orchestrates subagents at scale**. The
model writes the script for the task; a runtime executes it, fanning each `agent()` call
out to a subagent. The control flow (loops, branching, fan-out) lives in deterministic
JS — the LLM work happens only at the leaves. Intermediate results stay in script
variables, so only the final answer comes back.

## When to use a workflow (vs subagents / skills / plain tools)

A workflow **moves the plan into code**. Reach for one when:

- the task decomposes into **dozens to hundreds** of agents (more than one conversation can coordinate);
- you want the orchestration as a **rerunnable, resumable** script;
- you want a **repeatable quality pattern** — e.g. independent agents adversarially reviewing each other's findings, or drafting a plan from several angles and weighing them — not just "more agents".

Canonical fits: codebase-wide bug/security/optimization sweep · 500-file migration ·
research that cross-checks sources · a hard plan stress-tested from independent angles.
**Do not** use one for a single quick file read/edit or when ordinary tools suffice.

---

## How to WRITE a workflow script

The script is **plain JavaScript** (NOT TypeScript — no type annotations, interfaces, or
generics). The body runs in an async context: top-level `await` works, and a top-level
`return <value>` is the workflow's result.

### 1. The `meta` block (required, first)

Every script MUST begin with `export const meta = {...}`, a **pure literal** — no
variables, function calls, spreads, or template interpolation:

```js
export const meta = {
  name: 'find-flaky-tests',                 // required
  description: 'Find flaky tests and propose fixes',  // required
  whenToUse: '…',                            // optional
  phases: [                                  // optional, one entry per phase() call
    { title: 'Scan', detail: 'grep CI logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test', model: 'opus' },
  ],
}
```

Required: `name`, `description`. Use the same phase titles in `meta.phases` as in `phase()`
calls (matched exactly). A missing/non-literal `meta` fails fast with a clear error.

### 2. Script body hooks

These are injected into the script scope:

- **`agent(prompt, opts?) → Promise<any>`** — spawn one subagent. Without `schema`, resolves
  to its final text. With `schema` (a JSON Schema), the subagent is forced to produce a
  matching object and `agent()` resolves to the **validated object**. Returns `null` if the
  agent is skipped/aborted (filter with `.filter(Boolean)`). `opts`: `label` (short display
  label), `phase` (assign to a progress group — **use this inside parallel/pipeline stages**),
  `schema`, `model` (override; omit to inherit), `isolation:'worktree'` (fresh git worktree —
  EXPENSIVE, only when agents mutate files in parallel), `agentType` (named subagent preset).
- **`pipeline(items, stage1, stage2, …) → Promise<any[]>`** — run each item through all
  stages independently, **NO barrier between stages** (item A can be in stage 3 while item B
  is in stage 1). Each stage callback gets `(prevResult, originalItem, index)`. A throwing
  stage drops that item to `null` and skips its remaining stages. **This is the DEFAULT for
  multi-stage work.**
- **`parallel(thunks) → Promise<any[]>`** — run thunks concurrently. This is a **BARRIER**
  (awaits all). A thunk that throws resolves to `null` in the result; the call never rejects
  — `.filter(Boolean)` before use. Pass **functions, not promises**:
  `parallel(items.map(x => () => agent(...)))`.
- **`phase(title)`** — start a phase; subsequent `agent()` calls group under it.
- **`log(message)`** — emit a narrator progress line.
- **`args`** — the input value passed to the run, verbatim.
- **`workflow(nameOrRef, args?) → Promise<any>`** — run another workflow inline (one level
  of nesting only); shares the run's concurrency/agent/abort.

A subagent's **final text is its return value** — raw data for the script, not a message to a
human. That's why `schema` (a validated object comes back) and a closing synthesis agent matter.

### 3. Rules that the runtime enforces (fail fast)

- **Plain JS only**: no `import`, `require`, `fs`, or Node APIs in the script.
- **Determinism**: `Date.now()`, `Math.random()`, and argless `new Date()` are unavailable
  (they would break resume). Pass timestamps via `args`; vary by index instead of random.
- **Structured output**: `opts.schema` is a JSON Schema whose **root must be `type:"object"`**
  (discriminated unions go flat: an enum discriminant + optional fields, NOT a root `oneOf`).
- **Limits**: up to 16 concurrent agents — **`min(16, cpus-2)`**, so fewer on small machines; **1000 agents total** per run.

### 4. Default to `pipeline()`; use a barrier only when you must

Use `parallel()` (a barrier) ONLY when stage N genuinely needs ALL of stage N-1 — e.g.
dedup/merge across the full set, an early-exit on total count, or cross-comparing findings.
"I need to map/filter first" is **not** a reason — do it inside a pipeline stage. A barrier
wastes the fast items' idle time while waiting for the slowest.

### 5. Design the shape for the task — these patterns are a palette, not a checklist

**You design the control flow.** Read the task, decide what should fan out, what verifies, and
what synthesizes, then pick — or compose — the shape that fits. The patterns below are a menu of
proven shapes: not steps to run in order, and not defaults to reach for before you've looked at
the task. Match the task to a shape:

| If the task is… | reach for… |
| :-- | :-- |
| unknown-size discovery ("find all the X") | **loop-until-dry** |
| a hard choice between approaches | **judge panel** |
| judging whether a claim holds across sources | **multi-modal sweep + cross-check** |
| a mechanical change across many items | **per-item fan-out** (pipeline; `isolation:'worktree'` if they'd collide) |
| confirming findings that might be wrong | **adversarial / perspective-diverse verify** |

- **Adversarial verify**: per finding, spawn N independent skeptics prompted to REFUTE it;
  drop it if a majority refute. Stops plausible-but-wrong findings.
- **Perspective-diverse verify**: give each verifier a distinct lens (correctness / security /
  perf / does-it-reproduce) instead of N identical refuters.
- **Judge panel**: generate N attempts from different angles, score with parallel judges,
  synthesize from the winner while grafting the runners-up's best ideas.
- **Loop-until-dry**: for unknown-size discovery, keep spawning finders until K consecutive
  rounds find nothing new (dedup against everything seen, not just confirmed).
- **Multi-modal sweep**: parallel agents each searching a different way (by container, by
  content, by entity, by time).
- **Completeness critic**: a final agent that asks "what's missing?" — its answer is the next round.
- **No silent caps**: if you bound coverage (top-N, sampling), `log()` what was dropped.
- Always end a multi-result run with a **synthesis agent** that returns a compact, JSON-serializable verdict.

**These patterns aren't exhaustive — compose novel harnesses when the task calls for it**
(tournament brackets, self-repair loops, staged escalation, whatever fits). The named patterns
are starting points, not a closed set; the task decides the structure.

Scale to the ask: "find any bugs" → a few finders + single-vote verify; "thoroughly audit"
→ larger pool + 3–5-vote adversarial pass + synthesis.

### One worked example — the review→verify shape (read it for mechanics, don't transplant it)

This shows the *mechanics* — pipeline-by-default, a barrier only where needed, schema-validated
`agent()` calls — on **one** shape: review across dimensions, then verify each finding. It is the
shape for "review, then confirm findings." It is **not** a template for every task.

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: 'Review the diff for correctness bugs. Report findings.' },
  { key: 'perf', prompt: 'Review the diff for performance regressions. Report findings.' },
]

const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  (review) =>
    parallel(
      review.findings.map((f) => () =>
        agent(`Adversarially verify this finding — is it real? ${f.title}`, {
          label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA,
        }).then((v) => ({ ...f, verdict: v })),
      ),
    ),
)

const confirmed = results.flat().filter(Boolean).filter((f) => f.verdict?.isReal)
return { confirmed }
// 'bugs' findings verify while 'perf' is still reviewing — no wasted wall-clock.
```

**The most common authoring mistake is transplanting this skeleton** — the `DIMENSIONS` array,
the `FINDINGS_SCHEMA` / `VERDICT_SCHEMA` names, the "adversarially verify each finding" pass —
onto a task that isn't "review, then verify findings." For instance, judging whether a metrics
claim is true is a **multi-modal sweep that cross-checks the sources against each other**, not N
skeptics refuting each reading; forcing the verify-skeleton onto it omits the cross-checking the
task actually needs. Match the task to a shape in the table above and let the task supply the
structure — the example only teaches the primitives.

---

## How to RUN a workflow (this project's runtime)

Write the script to a `.js` file. If the runtime CLI isn't installed yet, install it first
(it provides the `workflow` command):

```bash
npm install -g open-dynamic-workflows      # provides the `workflow` command
```

Then run the script:

```bash
workflow run path/to/script.js [--args '<json>'] [--model <id>] [--resume <runId>]
# e.g.
workflow run audit.js --args '{"dir":"src"}'
```

Or embed it programmatically:

```js
import { runWorkflow } from 'open-dynamic-workflows'
const result = await runWorkflow({
  scriptPath: 'audit.js',           // or: script: '<inline source>'
  args: { dir: 'src' },
  signal: controller.signal,         // cancellation
  onEvent: (e) => { /* phase_start / agent_start / agent_end / log / run_end */ },
})
// result: { runId, value, tokensSpent, agentCount, durationMs, events, ... }
// `value` is whatever the script returned.
```

- **Cancel**: Ctrl-C in the CLI (or abort `signal`) — kills the in-flight subagent process
  tree; the run unwinds. Completed agents stay recorded.
- **Resume**: `--resume <runId>` (or `resumeFromRunId`) — already-completed `agent()` calls
  with unchanged `(prompt, opts)` replay from cache with **zero token spend**; the rest run live.
- **Progress / cost**: each agent's cost, tokens, and duration stream via `onEvent` and a
  terminal live tree; the full event log is persisted under the run dir.

> In Claude Code itself, the equivalent is the built-in `Workflow` tool (the model writes a
> script and calls it; ultracode auto-decides; runs in the background under `/workflows`).
> This skill targets running the SAME contract on this standalone runtime, so a script you
> write here is portable to either.

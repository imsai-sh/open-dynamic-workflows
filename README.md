# Open Dynamic Workflows

> A faithful, **model- and harness-agnostic** standalone reimplementation of the official
> Claude Code **dynamic-workflow** runtime.
>
> 中文版见 [README.zh.md](./README.zh.md)。

## Why this exists

Anthropic's dynamic workflows are powerful — but they only run inside Anthropic's own
harness, and they're gated behind a Max subscription. This is an open-source
reimplementation of the same model (fan a deterministic script out across many subagents),
without those limits:

- **Any model.** Every `agent()` chooses its `Executor` by name. Bundled adapters drive
  `claude --print` and `codex exec` — different nodes can run on different CLIs — and you can
  plug in any other model, API, or backend. No lock-in.
- **Shipped as a skill + a CLI.** Not a feature buried in one product. The skill teaches an
  agent to *write* workflows; the CLI *runs* them. Plain, portable open source.
- **Drops into any coding agent.** Since it's just a skill + a CLI, wire it into whatever you
  already use — Claude Code, Codex, Cursor, your own harness — automate it from the terminal,
  or call it from the cloud.

## Install

One command installs the skill; your coding agent takes it from there:

```bash
npx skills add imsai-sh/open-dynamic-workflows
```

You can also invoke `/open-dynamic-workflows` explicitly to have the agent only *write* the workflow script without running it — handy for human review, or for re-running the generated `workflow.js` from your own automation.

## Module map

```
src/
├── types.ts              ← frozen shared contract — every module codes against it
├── index.ts              ← public API: runWorkflow + claudeExecutor / codexExecutor + builtinExecutors + types
├── cli.ts                ← CLI entry: argv → runWorkflow → live tree
├── executor/             ← one subfolder per CLI; subprocess.ts is the shared, CLI-agnostic driver
│   ├── subprocess.ts     ← spawn · process-group kill · wall/idle/abort watchdogs · line buffering · ExecTrace
│   ├── claude/
│   │   ├── claude.ts     ← spawn `claude --print` — the only place that touches claude
│   │   └── stream-json.ts ← claude stream-json event reducer (pure)
│   └── codex/
│       ├── codex.ts      ← spawn `codex exec --json` — the only place that touches codex
│       └── codex-jsonl.ts ← codex JSONL event reducer (pure)
├── schema/validate.ts    ← ajv + `--json-schema` building + root-`object` guard
├── runtime/
│   ├── semaphore.ts      ← concurrency cap (min(16, cpus-2)) + 1000-agent backstop + abort
│   ├── hooks.ts          ← agent / parallel / pipeline / phase / log / workflow, bound to a run context
│   ├── sandbox.ts        ← extract meta · run the script in node:vm · determinism guard
│   └── run.ts            ← runWorkflow() — wires sandbox + hooks + executors + journal + progress
├── journal/journal.ts    ← runId · persisted script · journal.jsonl · events.jsonl · resume cache
└── progress/tree.ts      ← ProgressEvent → terminal live tree
```

## Develop & test

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit (strict)
npm run smoke        # all tests — zero tokens, no real model CLI (claude/codex)
```

## Sibling projects

- **[open-claude-design](https://github.com/imsai-sh/open-claude-design)** — an open recreation of Claude Design as a pure web app.
- **[tui2cli](https://github.com/imsai-sh/tui2cli)** — with Anthropic about to meter `claude -p` and the Agent SDK separately, this wraps the Claude Code TUI (or any other coding TUI) into a programmatically callable CLI that still runs on your subscription quota.

## Contributing

Issues, PRs, and ⭐ stars are all welcome — bug reports, new executors (e.g. a Gemini or DeepSeek adapter), docs, or ideas.

License: MIT.

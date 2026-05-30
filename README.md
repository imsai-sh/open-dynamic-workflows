# Open Dynamic Workflows

> A faithful, **model- and harness-agnostic** standalone reimplementation of the official
> Claude Code **dynamic-workflow** runtime.
>
> 中文版见 [README.zh.md](./README.zh.md)。

## Install

**Install the skill** — your agent reads it to author and run workflows:

```bash
npx skills add imsai-sh/open-dynamic-workflows
```

## Module map

| file | what it owns |
| :--- | :--- |
| `src/types.ts` | the frozen shared contract (every module codes against it) |
| `src/executor/claude.ts` | spawn `claude --print`, parse stream-json → `ExecResult` — the only place that touches `claude` |
| `src/executor/stream-json.ts` | the stream-json event parser |
| `src/schema/validate.ts` | ajv wrapper, `--json-schema` arg building, root-`object` guard |
| `src/runtime/semaphore.ts` | concurrency cap (`min(16, cpus-2)`) + the 1000-agent backstop + abort |
| `src/runtime/hooks.ts` | `agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow` bound to a run context |
| `src/runtime/sandbox.ts` | extract `meta`, run the script in `node:vm`, enforce the determinism guard |
| `src/runtime/run.ts` | `runWorkflow()` — wires sandbox + hooks + executor + journal + progress + abort |
| `src/journal/journal.ts` | runId, persisted script, `journal.jsonl`, `events.jsonl`, resume cache |
| `src/progress/tree.ts` | `ProgressEvent` → terminal live tree |
| `src/cli.ts` | CLI entry: argv → `runWorkflow` → render |
| `src/index.ts` | public exports: `runWorkflow` + `claudeExecutor` + types |

### Develop & test

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit (strict)
npm run smoke        # all tests via an injected fake executor — zero tokens, no real claude
```

License: MIT.

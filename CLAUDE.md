# CLAUDE.md

本文件供 Claude Code 在本仓库工作时阅读。**改任何代码前先看完 `src/types.ts` 与 `docs/official/`。**

## 这是什么

**官方 Claude Code `Workflow` 运行时的一个忠实、模型 / harness 无关的独立复刻。**

一段 **JS workflow 脚本**（`export const meta` + 用 `agent()/parallel()/pipeline()/phase()/log()/args/workflow()` 写的 body）**由模型撰写**（对照 `skills/open-dynamic-workflows/SKILL.md`），本项目的**运行时执行它**——fan-out subagent、返回脚本返回值 + run 元数据、维护可 resume 的 journal。我们不替用户写脚本。

- **模型 / harness 无关**：`Executor` 是集成接缝；**每个 CLI 一个适配器**（`claude` / `codex` 各一），可换成任意模型 / harness。
- **executor 是 per-node 可插拔的**：host 通过 `RunOptions.executors`（一个 `name → Executor` 的注册表）提供实现，脚本里每个 `agent()` 用 `{executor}` 按名挑一个 CLI——**没有默认值，必须显式指定**。
- **撰写引导是一份 skill**（`skills/open-dynamic-workflows/SKILL.md`，英/中），不绑死任何 harness。
- **「hook」一词**（`agent`/`parallel`/… 这些注入脚本作用域的原语）来自**官方工具规范**的 "Script body hooks" 段；与 Claude Code 生命周期 hook（`PreToolUse` 等）无关。

## 真相源

- **行为以 `src/` 代码 + `src/smoke.test.ts` 为准。**
- **`docs/official/`** —— 官方契约逐字归档（`workflows.md` + 发布博客 + 工具定义）。"官方到底怎么规定" 看这里。
- **`src/types.ts`** —— 冻结契约（形状层），所有模块对照它编码。

## 模块边界

```
src/
├── types.ts              ← 冻结契约；Executor 接缝 / RunOptions.executors / WorkflowResult
├── index.ts              ← 公共导出：runWorkflow + claude/codex 适配器 + reducer + builtinExecutors + types
├── cli.ts                ← CLI 入口（bin: odw / open-dynamic-workflows；把 builtinExecutors 注入 run；无 --executor flag，因无默认）
├── executor/             ← 每个 CLI 一个子目录;subprocess.ts 是它们共享的 CLI 无关 driver
│   ├── subprocess.ts     ← CLI 无关的流式子进程 driver（spawn / 进程组 kill / wall+idle+abort 看门狗 / 行缓冲 / stdin / ExecTrace 落盘 / ODW_DEBUG）；接新 CLI = 在自己的子目录写一个 spec
│   ├── claude/
│   │   ├── claude.ts     ← spawn claude --print，唯一碰 claude 的地方（走 subprocess driver）
│   │   └── stream-json.ts ← claude stream-json 事件的纯 reducer
│   └── codex/
│       ├── codex.ts      ← spawn codex exec --json，唯一碰 codex 的地方（走 subprocess driver）
│       └── codex-jsonl.ts ← codex JSONL 事件的纯 reducer
├── schema/validate.ts    ← ajv + --json-schema 构造 + 根必须 object 守卫
├── runtime/
│   ├── semaphore.ts      ← 并发信号量 + 全局 agent 计数 + abort
│   ├── hooks.ts          ← agent/parallel/pipeline/phase/log/workflow 绑定 run ctx
│   ├── sandbox.ts        ← 抽 meta + 在 node:vm 跑脚本 + 决定论守卫
│   └── run.ts            ← runWorkflow() 总装配
├── journal/journal.ts    ← runId / 落盘 script / journal.jsonl / events.jsonl / resume 缓存（每个 workflow 自包含：脚本 <cwd>/.odw/<name>/script.js，run 落 <cwd>/.odw/<name>/runs/<runId>/）
└── progress/tree.ts      ← ProgressEvent → 终端实时进度树
```

**一次 run 的数据流**：`runWorkflow()` → `sandbox` 抽 `meta`、在 `node:vm` 跑脚本体 → 脚本调注入的 hooks（`hooks.ts`）→ 每个 `agent()` 过 `semaphore` 限流后，按其 `{executor}` 名字从 `ctx.executors` 注册表解析出对应 `Executor`（缺失 / 未知名即 throw），由它 spawn 对应 CLI（`claude --print` 或 `codex exec --json`）→ 结果经 `journal` 落盘 + `ProgressEvent` 流给 `progress/tree.ts`。**脚本怎么写不在 `src/`**——见 `skills/open-dynamic-workflows/SKILL.md`。

## 不变量（违反就是 bug）

1. **每个 `Executor` 是唯一接触其 CLI 的接缝**——`executor/claude.ts` 只碰 `claude`、`executor/codex.ts` 只碰 `codex`；其余模块全是对 `Promise<ExecResult>` 的纯编排。
2. **`pipeline()` 阶段间无 barrier**——绝不 `await` 完整个 stage N 再开 N+1。
3. **`parallel()` 永不 reject**——失败位填 `null`。
4. **并发 ≤ `min(16, cpus-2)`、总 agent ≤ 1000**；信号量在错误路径也要 release。
5. **脚本里 `Date.now`/`Math.random`/无参 `new Date` 必须抛错**（resume 决定论）。
6. **structured output 的 schema 根必须 `type:"object"`**（不重写 schema，根 `oneOf` 让 API 400 透出）。
7. **journal 写盘失败只 warn，永不 throw。**
8. **spawn claude 用 `--permission-mode acceptEdits`，绝不用 `--dangerously-skip-permissions`。**
9. **journal 是 CLI 中立的**——只存归约后的 `result`（string | object | null），绝不存 claude stream-json / codex JSONL 原文；resume 重放 = 重发存下来的值，**不 spawn 任何 CLI**（新增 executor 不改 journal 格式）。
10. **没有默认 executor**——`agent()` 必须显式带 `{executor}`；缺失或未知名（不在 `executors` 注册表里）即 throw，**绝不静默回退**。
11. **spawn codex 用 `--sandbox workspace-write`，绝不用 `--dangerously-bypass-approvals-and-sandbox`**（claude 侧不变量 #8 的 codex 对应物）。

## 常用命令

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit（仓库无 ESLint/Prettier，没有 lint 步骤）
npm run smoke        # 全部测试：tsx --test src/**/*.test.ts（注入 fake executor，零 token、不碰真 claude）
npm run dev -- run <script.js> [--args <json>] [--resume <runId>]   # 用本运行时真跑一个脚本
```

跑单条测试：`npx tsx --test --test-name-pattern="resume" src/smoke.test.ts`。

## 排查（失败可观测性）

- 每个 agent 的**完整执行记录**落在 `<runDir>/agents/agent-N.jsonl`——`subprocess.ts` 的 `ExecTrace`：`command / args / cwd / prompt / durationMs / exitCode / isError / resultSubtype / stderr / events`。CLI 级失败（认证、用量/配额上限、配置）只在 **stderr**，所以它入档，失败单凭 trace 即可定位、无需复现。
- 失败原因**内联**进抛出的 error 与 `agent_end.error`（进度树会渲染）：`agent failed (subtype=…): <reason>`（`hooks.ts` 的 `oneLine(res.text)`）。codex/claude 执行器在出错且无 text 时把 stderr 兜进 `res.text`。
- `ODW_DEBUG=1` 实时把每次 spawn 的 argv、退出状态、(出错时) stderr 末尾打到 stderr。


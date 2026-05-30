# CLAUDE.md

本文件供 Claude Code 在本仓库工作时阅读。**改任何代码前先看完 `src/types.ts` 与 `docs/official/`。**

## 这是什么

**官方 Claude Code `Workflow` 运行时的一个忠实、模型 / harness 无关的独立复刻。**

一段 **JS workflow 脚本**（`export const meta` + 用 `agent()/parallel()/pipeline()/phase()/log()/args/workflow()` 写的 body）**由模型撰写**（对照 `skills/open-dynamic-workflows/SKILL.md`），本项目的**运行时执行它**——fan-out subagent、返回脚本返回值 + run 元数据、维护可 resume 的 journal。我们不替用户写脚本。

- **模型 / harness 无关**：`Executor` 是集成接缝；`claude --print` 执行器只是**一个**参考适配器，可换成任意模型 / harness。
- **撰写引导是一份 skill**（`skills/open-dynamic-workflows/SKILL.md`，英/中），不绑死任何 harness。
- **「hook」一词**（`agent`/`parallel`/… 这些注入脚本作用域的原语）来自**官方工具规范**的 "Script body hooks" 段；与 Claude Code 生命周期 hook（`PreToolUse` 等）无关。

## 真相源

- **行为以 `src/` 代码 + `src/smoke.test.ts` 为准。**
- **`docs/official/`** —— 官方契约逐字归档（`workflows.md` + 发布博客 + 工具定义）。"官方到底怎么规定" 看这里。
- **`src/types.ts`** —— 冻结契约（形状层），所有模块对照它编码。

## 模块边界

```
src/
├── types.ts              ← 冻结契约；Executor 接缝 / RunOptions / WorkflowResult
├── index.ts              ← 公共导出：runWorkflow + claudeExecutor + types
├── cli.ts                ← CLI 入口
├── executor/
│   ├── claude.ts         ← spawn claude --print，唯一碰 claude 的地方
│   └── stream-json.ts    ← stream-json 事件解析
├── schema/validate.ts    ← ajv + --json-schema 构造 + 根必须 object 守卫
├── runtime/
│   ├── semaphore.ts      ← 并发信号量 + 全局 agent 计数 + abort
│   ├── hooks.ts          ← agent/parallel/pipeline/phase/log/workflow 绑定 run ctx
│   ├── sandbox.ts        ← 抽 meta + 在 node:vm 跑脚本 + 决定论守卫
│   └── run.ts            ← runWorkflow() 总装配
├── journal/journal.ts    ← runId / 落盘 script / journal.jsonl / events.jsonl / resume 缓存
└── progress/tree.ts      ← ProgressEvent → 终端实时进度树
```

**一次 run 的数据流**：`runWorkflow()` → `sandbox` 抽 `meta`、在 `node:vm` 跑脚本体 → 脚本调注入的 hooks（`hooks.ts`）→ 每个 `agent()` 过 `semaphore` 限流后交给 `executor`（spawn `claude --print`）→ 结果经 `journal` 落盘 + `ProgressEvent` 流给 `progress/tree.ts`。**脚本怎么写不在 `src/`**——见 `skills/open-dynamic-workflows/SKILL.md`。

## 不变量（违反就是 bug）

1. **执行器是唯一碰 `claude` 的模块**，其余全是对它 `Promise` 的纯编排。
2. **`pipeline()` 阶段间无 barrier**——绝不 `await` 完整个 stage N 再开 N+1。
3. **`parallel()` 永不 reject**——失败位填 `null`。
4. **并发 ≤ `min(16, cpus-2)`、总 agent ≤ 1000**；信号量在错误路径也要 release。
5. **脚本里 `Date.now`/`Math.random`/无参 `new Date` 必须抛错**（resume 决定论）。
6. **structured output 的 schema 根必须 `type:"object"`**（不重写 schema，根 `oneOf` 让 API 400 透出）。
7. **journal 写盘失败只 warn，永不 throw。**
8. **spawn claude 用 `--permission-mode acceptEdits`，绝不用 `--dangerously-skip-permissions`。**

## 常用命令

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit（仓库无 ESLint/Prettier，没有 lint 步骤）
npm run smoke        # 全部测试：tsx --test src/**/*.test.ts（注入 fake executor，零 token、不碰真 claude）
npm run dev -- run <script.js> [--args <json>] [--resume <runId>]   # 用本运行时真跑一个脚本
```

跑单条测试：`npx tsx --test --test-name-pattern="resume" src/smoke.test.ts`。


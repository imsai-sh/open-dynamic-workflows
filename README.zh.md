# Open Dynamic Workflows

> 官方 Claude Code **动态 workflow** 运行时的一个忠实、**模型 / harness 无关**的独立复刻。
>
> English: see [README.md](./README.md)。

## 为什么有这个项目

Anthropic 的动态 workflow 很强,但它只能跑在 Anthropic 自家的 harness 里,而且需要 Max 订阅。
这是同一套模型(把一段确定性脚本 fan out 成大量 subagent)的开源复刻,去掉了这些限制:

- **任意模型。** 每个 `agent()` 按名字选用 `Executor`。自带适配器分别驱动 `claude --print` 和
  `codex exec`——同一段脚本里不同 node 可以跑不同 CLI——再接任意模型 / API / 你自己的后端都行,无厂商绑定。
- **以 skill + CLI 交付。** 不是埋在某个产品里的功能。skill 教 agent **写** workflow,CLI 负责**跑**。
  纯粹、可移植的开源。
  - Claude Code 把动态 workflow 做成内置 tool([workflow-tool-definition.md](docs/official/workflow-tool-definition.md)),本仓库改用 skill 形式复刻,更通用、可移植。
- **塞进任意 coding agent。** 因为它就是一份 skill + 一个 CLI,你可以接进任何你在用的工具——
  Claude Code、Codex、Cursor、你自己的 harness——在终端里自动化,或从云端调用。

## 安装

只需一行命令安装此 skill,剩下的交给你的 coding agent:

```bash
npx skills add imsai-sh/open-dynamic-workflows
```

还可以显式调用 `/open-dynamic-workflows`,让 agent 只编写 workflow 脚本、暂不执行,便于人工审查,或在自动化脚本里重复运行生成的 `workflow.js`。


## 模块地图

```
src/
├── types.ts              ← 冻结的共享契约——所有模块对照它编码
├── index.ts              ← 公共 API：runWorkflow + claudeExecutor / codexExecutor + builtinExecutors + 类型
├── cli.ts                ← CLI 入口：argv → runWorkflow → 实时进度树
├── executor/             ← 每个 CLI 一个子目录;subprocess.ts 是共享的、CLI 无关的 driver
│   ├── subprocess.ts     ← spawn · 进程组 kill · wall/idle/abort 看门狗 · 行缓冲 · ExecTrace
│   ├── claude/
│   │   ├── claude.ts     ← spawn `claude --print`——唯一碰 claude 的地方
│   │   └── stream-json.ts ← claude stream-json 事件归约器（纯函数）
│   └── codex/
│       ├── codex.ts      ← spawn `codex exec --json`——唯一碰 codex 的地方
│       └── codex-jsonl.ts ← codex JSONL 事件归约器（纯函数）
├── schema/validate.ts    ← ajv + `--json-schema` 构造 + 根必须 `object` 守卫
├── runtime/
│   ├── semaphore.ts      ← 并发上限（min(16, cpus-2)）+ 1000-agent 兜底 + abort
│   ├── hooks.ts          ← agent / parallel / pipeline / phase / log / workflow,绑定 run context
│   ├── sandbox.ts        ← 抽 meta · 在 node:vm 跑脚本 · 决定论守卫
│   └── run.ts            ← runWorkflow()——装配 sandbox + hooks + executors + journal + progress
├── journal/journal.ts    ← runId · 落盘脚本 · journal.jsonl · events.jsonl · resume 缓存
└── progress/tree.ts      ← ProgressEvent → 终端实时进度树
```

## 开发 & 测试

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit（strict）
npm run smoke        # 全部测试——零 token、不 spawn 真实 model CLI（claude/codex）
```

## 同系列项目

- **[open-claude-design](https://github.com/imsai-sh/open-claude-design)** —— Claude Design 的开源复刻，纯 Web 应用。
- **[tui2cli](https://github.com/imsai-sh/tui2cli)** —— 为应对 Anthropic 即将给 `claude -p` 和 Claude Agent SDK 单独计费，把 Claude Code TUI（其实也可以是任意其他编程 TUI）包装成可被编程调用的 CLI 形式，仍然走订阅内额度。

## 贡献

欢迎 star、提 issue、发 PR——bug 反馈、新的 executor(比如 Gemini / DeepSeek 适配器)、文档、点子都欢迎。

License: MIT.

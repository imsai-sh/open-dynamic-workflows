# Open Dynamic Workflows

> 官方 Claude Code **动态 workflow** 运行时的一个忠实、**模型 / harness 无关**的独立复刻。
>
> English: see [README.md](./README.md)。

## 为什么有这个项目

Anthropic 的动态 workflow 很强,但它只能跑在 Anthropic 自家的 harness 里,而且需要 Max 订阅。
这是同一套模型(把一段确定性脚本 fan out 成大量 subagent)的开源复刻,去掉了这些限制:

- **任意模型。** 每个 `agent()` 都走可替换的 `Executor`。自带适配器驱动 `claude --print`;换成任意
  模型 / API / 你自己的后端都行,无厂商绑定。
- **以 skill + CLI 交付。** 不是埋在某个产品里的功能。skill 教 agent **写** workflow,CLI 负责**跑**。
  纯粹、可移植的开源。
- **塞进任意 coding agent。** 因为它就是一份 skill + 一个 CLI,你可以接进任何你在用的工具——
  Claude Code、Codex、Cursor、你自己的 harness——在终端里自动化,或从云端调用。

## 安装

**安装 skill** ——你的 agent 靠它来撰写并运行 workflow：

```bash
npx skills add imsai-sh/open-dynamic-workflows
```

## 模块地图

| 文件 | 职责 |
| :--- | :--- |
| `src/types.ts` | 冻结的共享契约（所有模块对照它编码） |
| `src/executor/claude.ts` | spawn `claude --print`、解析 stream-json → `ExecResult`——**唯一碰 `claude` 的地方** |
| `src/executor/stream-json.ts` | stream-json 事件解析器 |
| `src/schema/validate.ts` | ajv 包装、`--json-schema` 构造、根必须 `object` 守卫 |
| `src/runtime/semaphore.ts` | 并发上限（`min(16, cpus-2)`）+ 1000-agent 兜底 + abort |
| `src/runtime/hooks.ts` | `agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow` 绑定 run context |
| `src/runtime/sandbox.ts` | 抽 `meta`、在 `node:vm` 跑脚本、执行决定论守卫 |
| `src/runtime/run.ts` | `runWorkflow()`——装配 sandbox + hooks + executor + journal + progress + abort |
| `src/journal/journal.ts` | runId、落盘脚本、`journal.jsonl`、`events.jsonl`、resume 缓存 |
| `src/progress/tree.ts` | `ProgressEvent` → 终端实时进度树 |
| `src/cli.ts` | CLI 入口：argv → `runWorkflow` → 渲染 |
| `src/index.ts` | 公共导出：`runWorkflow` + `claudeExecutor` + 类型 |

### 开发 & 测试

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit（strict）
npm run smoke        # 全部测试，走注入的 fake executor——零 token、不碰真 claude
```


## 贡献

欢迎 star、提 issue、发 PR——bug 反馈、新的 executor(比如 Codex 适配器)、文档、点子都欢迎。

License: MIT.

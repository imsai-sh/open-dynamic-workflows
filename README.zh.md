# Open Dynamic Workflows

> 官方 Claude Code **动态 workflow** 运行时的一个忠实、**模型 / harness 无关**的独立复刻。
>
> English: see [README.md](./README.md)。

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


License: MIT.

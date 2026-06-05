// Public API. 公共 API。
// The core: types + the runtime entry. 核心：类型 + 运行时入口。
export * from "./types.js";
export { runWorkflow } from "./runtime/run.js";

// Bundled executor adapters — ONE adapter per CLI, swap or extend for your model/harness.
// 内置的 executor 适配器 —— 每个 CLI 一个适配器，可替换或扩展成你的模型/harness。
export { claudeExecutor, buildClaudeArgs } from "./executor/claude/claude.js";
export { codexExecutor, buildCodexArgs } from "./executor/codex/codex.js";

// Pure reducers + the shared subprocess driver — exposed so hosts can build their own adapters.
// 纯归约器 + 共享子进程 driver —— 导出以便 host 自行构建适配器。
export { reduceStreamJsonEvents, parseStreamJsonLine } from "./executor/claude/stream-json.js";
export { reduceCodexEvents, parseCodexJsonLine } from "./executor/codex/codex-jsonl.js";
export { makeSubprocessExecutor } from "./executor/subprocess.js";

import { claudeExecutor } from "./executor/claude/claude.js";
import { codexExecutor } from "./executor/codex/codex.js";

// Out-of-the-box registry, ready to pass as RunOptions.executors (or extend). This is
// NOT a "default executor": every agent() must still name one explicitly via {executor}.
// 开箱即用的注册表，可直接作为 RunOptions.executors 传入（或扩展）。它不是“默认
// executor”：每个 agent() 仍须通过 {executor} 显式指定名字。
export const builtinExecutors = { claude: claudeExecutor, codex: codexExecutor };

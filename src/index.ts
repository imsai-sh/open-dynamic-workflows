// Public API. 公共 API。
// The core: types + the runtime entry. 核心：类型 + 运行时入口。
export * from "./types.js";
export { runWorkflow } from "./runtime/run.js";

// The reference `claude --print` executor — ONE adapter, swap it for your model/harness.
// 参考用的 `claude --print` 执行器 —— 只是【一个】适配器，可替换成你的模型/harness。
export { claudeExecutor, buildClaudeArgs } from "./executor/claude.js";

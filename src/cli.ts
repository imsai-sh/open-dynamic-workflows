#!/usr/bin/env node
// cli.ts — argv → runWorkflow → terminal live tree. Hand-rolled flag parser
// cli.ts —— argv → runWorkflow → 终端实时树状视图。手写的 flag 解析器
// (no deps). Usage:
// （无依赖）。用法：
//   odw run <scriptPath> [--name <name>] [--args <json>] [--resume <runId>]
//                             [--cwd <dir>] [--model <id>]
//                             [--run-dir <dir>] [--no-tree]

import { runWorkflow } from "./runtime/run.js";
import { builtinExecutors } from "./index.js";
import { createTreeRenderer } from "./progress/tree.js";
import type { RunOptions } from "./types.js";

const USAGE =
  "usage: odw run <scriptPath> [--name <name>] [--args <json>] " +
  "[--resume <runId>] [--cwd <dir>] [--model <id>] " +
  "[--run-dir <dir>] [--no-tree]\n" +
  "\nScripts must pick a CLI per node: every agent() needs {executor:'claude'|'codex'}.\n";

// Flags that take a following value; everything else is boolean or positional.
// 需要紧跟一个取值的 flag；其余都按布尔 flag 或位置参数处理。
const VALUE_FLAGS = new Set([
  "name",
  "args",
  "resume",
  "cwd",
  "model",
  "run-dir",
]);

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next === undefined) throw new Error(`missing value for --${body}`);
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function flagStr(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (sub !== "run") {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const { positionals, flags } = parseArgs(argv.slice(1));

  const name = flagStr(flags, "name");
  const scriptPath = positionals[0];
  if (scriptPath === undefined && name === undefined) {
    process.stderr.write("[error] need a <scriptPath> positional or --name\n");
    process.stderr.write(USAGE);
    process.exit(1);
  }

  // The CLI ships the built-in registry; there is no --executor flag because there is
  // no default — each agent() names its CLI in the script (e.g. {executor:'codex'}).
  // CLI 内置注册表；没有 --executor flag，因为没有默认值——每个 agent() 在脚本里
  // 指定自己的 CLI（如 {executor:'codex'}）。
  const opts: RunOptions = { executors: builtinExecutors };
  if (scriptPath !== undefined) opts.scriptPath = scriptPath;
  if (name !== undefined) opts.name = name;

  const argsRaw = flagStr(flags, "args");
  if (argsRaw !== undefined) {
    try {
      opts.args = JSON.parse(argsRaw);
    } catch (e) {
      throw new Error(`--args is not valid JSON: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  const resume = flagStr(flags, "resume");
  if (resume !== undefined) opts.resumeFromRunId = resume;

  const cwd = flagStr(flags, "cwd");
  if (cwd !== undefined) opts.cwd = cwd;

  const model = flagStr(flags, "model");
  if (model !== undefined) opts.model = model;

  const runDir = flagStr(flags, "run-dir");
  if (runDir !== undefined) opts.runDir = runDir;

  const tree = createTreeRenderer({
    stream: process.stderr,
    enabled: flags["no-tree"] !== true,
  });
  opts.onEvent = tree.sink;

  // Ctrl-C cancels the run: abort the signal → in-flight subprocesses are killed and the
  // 按下 Ctrl-C 取消本次运行：触发 abort 信号 → 正在执行的子进程被杀掉，
  // run unwinds. A second Ctrl-C force-exits. Completed agents stay journaled, so
  // 整个运行随之回退。再按一次 Ctrl-C 则强制退出。已完成的 agent 仍记录在 journal 中，因此
  // `--resume <runId>` replays them with zero spend.
  // `--resume <runId>` 重放它们时零额外开销。
  const controller = new AbortController();
  opts.signal = controller.signal;
  let interrupting = false;
  process.on("SIGINT", () => {
    if (interrupting) {
      process.stderr.write("\n[force-exit]\n");
      process.exit(130);
    }
    interrupting = true;
    process.stderr.write("\n[interrupt] aborting workflow (Ctrl-C again to force-exit)…\n");
    controller.abort();
  });

  try {
    const res = await runWorkflow(opts);
    tree.stop();
    process.stdout.write(`${JSON.stringify(res.value ?? null, null, 2)}\n`);
    process.stderr.write(
      `\n[done] run=${res.runId} agents=${res.agentCount} tokens=${res.tokensSpent} ${res.durationMs}ms\n`,
    );
    process.exit(0);
  } catch (e) {
    tree.stop();
    if (controller.signal.aborted) {
      process.stderr.write(`\n[aborted] run cancelled — resume with: --resume <runId>\n`);
      process.exit(130);
    }
    process.stderr.write(`[error] ${String((e && (e as Error).stack) || e)}\n`);
    process.exit(1);
  }
}

void main();

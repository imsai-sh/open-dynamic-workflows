// journal.ts — runId allocation, persisted script, per-agent journal records,
// journal.ts —— runId 分配、持久化脚本、每个 agent 的 journal 记录，
// and resume-with-caching cache lookup. See SPEC §9.
// 以及带缓存复用的 resume 缓存查找。详见 SPEC §9。
//
// Invariant 8: journal write failures WARN, never throw.
// 不变量 8：journal 写盘失败只 WARN，绝不 throw。

import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRecord } from "../types.js";

// ────────────────────────────────────────────────────────────────────────────
// stable stringify — recursive key-sorted JSON; arrays keep order.
// 稳定序列化 —— 递归地按 key 排序的 JSON；数组保持原有顺序。
// ────────────────────────────────────────────────────────────────────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** sha256 hex of prompt + stableStringify(opts). */
/** prompt 加 stableStringify(opts) 的 sha256 十六进制摘要。 */
export function keyFor(prompt: string, opts: unknown): string {
  return createHash("sha256").update(prompt).update(stableStringify(opts)).digest("hex");
}

// ────────────────────────────────────────────────────────────────────────────
// Journal
// 日志（Journal）
// ────────────────────────────────────────────────────────────────────────────

export interface Journal {
  runId: string;
  runDir: string;
  persistScript(source: string, ext: string): Promise<string>;
  append(rec: AgentRecord): void;
  /** Append one ProgressEvent to runDir/events.jsonl (SPEC §10). Warn-never-throw. */
  /** 向 runDir/events.jsonl 追加一条 ProgressEvent（SPEC §10）。只 warn，绝不 throw。 */
  appendEvent(event: unknown): void;
  takeCached(key: string): AgentRecord | undefined;
  close(): Promise<void>;
}

function makeRunId(): string {
  const millis36 = Date.now().toString(36);
  const suffix = randomBytes(3).toString("hex");
  return `run-${millis36}-${suffix}`;
}

async function loadResumeCache(journalPath: string): Promise<Map<string, AgentRecord[]>> {
  const cache = new Map<string, AgentRecord[]>();
  let raw: string;
  try {
    raw = await readFile(journalPath, "utf8");
  } catch (err) {
    console.warn(`[journal] resume: cannot read ${journalPath}: ${String(err)} — running fully live`);
    return cache;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let rec: AgentRecord;
    try {
      rec = JSON.parse(trimmed) as AgentRecord;
    } catch {
      console.warn(`[journal] resume: skipping unparseable journal line`);
      continue;
    }
    const queue = cache.get(rec.key);
    if (queue) queue.push(rec);
    else cache.set(rec.key, [rec]);
  }
  return cache;
}

export async function openJournal(params: {
  baseDir: string;
  runId?: string;
  resumeFromRunId?: string;
}): Promise<Journal> {
  const runId = params.runId ?? makeRunId();
  const runDir = path.join(params.baseDir, runId);
  const agentsDir = path.join(runDir, "agents");
  const journalPath = path.join(runDir, "journal.jsonl");
  const eventsPath = path.join(runDir, "events.jsonl");

  await mkdir(agentsDir, { recursive: true });

  let resumeCache: Map<string, AgentRecord[]> | undefined;
  if (params.resumeFromRunId !== undefined) {
    const priorJournal = path.join(params.baseDir, params.resumeFromRunId, "journal.jsonl");
    resumeCache = await loadResumeCache(priorJournal);
  }

  // In-memory list of records produced this run.
  // 本次运行产生的记录的内存列表。
  const records: AgentRecord[] = [];

  // Per-file SERIAL append chains — no interleaving of lines within a file.
  // 每个文件各自的串行追加链 —— 保证同一文件内的行不会交错。
  let appendChain: Promise<void> = Promise.resolve();
  let eventChain: Promise<void> = Promise.resolve();

  const journal: Journal = {
    runId,
    runDir,
    async persistScript(source: string, ext: string): Promise<string> {
      const scriptPath = path.join(runDir, `script.${ext}`);
      try {
        await writeFile(scriptPath, source, "utf8");
      } catch (err) {
        // Invariant 8: never throw on a journal disk write.
        // 不变量 8：journal 写盘时绝不 throw。
        console.warn(`[journal] persistScript failed: ${String(err)}`);
      }
      return scriptPath;
    },
    append(rec: AgentRecord): void {
      records.push(rec);
      const line = `${JSON.stringify(rec)}\n`;
      appendChain = appendChain.then(async () => {
        try {
          await appendFile(journalPath, line, "utf8");
        } catch (err) {
          console.warn(`[journal] append failed: ${String(err)}`);
        }
      });
    },
    appendEvent(event: unknown): void {
      const line = `${JSON.stringify(event)}\n`;
      eventChain = eventChain.then(async () => {
        try {
          await appendFile(eventsPath, line, "utf8");
        } catch (err) {
          console.warn(`[journal] event append failed: ${String(err)}`);
        }
      });
    },
    takeCached(key: string): AgentRecord | undefined {
      const queue = resumeCache?.get(key);
      if (queue === undefined || queue.length === 0) return undefined;
      return queue.shift();
    },
    async close(): Promise<void> {
      await appendChain;
      await eventChain;
    },
  };

  return journal;
}

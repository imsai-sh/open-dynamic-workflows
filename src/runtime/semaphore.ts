// semaphore.ts — counting semaphore + global agent counter (SPEC §5).
// semaphore.ts —— 计数信号量 + 全局 agent 计数器（SPEC §5）。
//
// One shared semaphore caps concurrent agents; a separate counter enforces the
// 一个共享的信号量限制并发 agent 数量；另有一个独立的计数器强制执行
// run-lifetime agent cap (TOTAL_AGENT_CAP). Both are intentionally tiny and have
// 整个运行周期内的 agent 上限（TOTAL_AGENT_CAP）。两者刻意保持极简，且
// no dependency on the executor — pure synchronization primitives.
// 不依赖 executor —— 纯粹的同步原语。

import { TOTAL_AGENT_CAP } from "../types.js";

export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  readonly active: number;
  readonly limit: number;
}

/**
 * Counting semaphore. `acquire()` resolves immediately while `active < limit`,
 * 计数信号量。当 `active < limit` 时，`acquire()` 立即 resolve，
 * otherwise it queues FIFO. `release()` wakes exactly ONE waiter (no lost
 * 否则按 FIFO 顺序排队。`release()` 恰好唤醒一个等待者（不会丢失
 * wakeups: a released slot is either handed straight to a waiter or returned to
 * 唤醒：释放出的槽位要么直接交给某个等待者，要么归还到
 * the free pool). `active` never exceeds `limit`.
 * 空闲池）。`active` 永远不会超过 `limit`。
 */
export function createSemaphore(limit: number): Semaphore {
  const cap = Math.max(1, Math.floor(limit));
  const waiters: Array<() => void> = [];
  let active = 0;

  return {
    get active() {
      return active;
    },
    get limit() {
      return cap;
    },
    acquire(): Promise<void> {
      if (active < cap) {
        active += 1;
        return Promise.resolve();
      }
      // No free slot: queue. The waiter inherits the slot kept "active" by the
      // 没有空闲槽位：排队。等待者会继承由 releaser 保持为 "active" 的那个槽位，
      // releaser, so `active` stays balanced and never overshoots `cap`.
      // 因此 `active` 始终保持平衡，永远不会超过 `cap`。
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release(): void {
      const next = waiters.shift();
      if (next !== undefined) {
        // Hand the slot directly to the FIFO-front waiter; `active` unchanged.
        // 将槽位直接交给 FIFO 队首的等待者；`active` 保持不变。
        next();
        return;
      }
      if (active > 0) {
        active -= 1;
      }
    },
  };
}

export interface Counter {
  next(): number;
  readonly count: number;
}

/**
 * Monotonic 1-based id allocator with a hard cap. `next()` returns the new id;
 * 带硬性上限的单调递增（从 1 开始）id 分配器。`next()` 返回新分配的 id；
 * the `(cap+1)`-th call throws — the runaway backstop from SPEC §5
 * 第 `(cap+1)` 次调用会抛错 —— 这是 SPEC §5 中防止失控的兜底机制
 * (TOTAL_AGENT_CAP = 1000).
 * （TOTAL_AGENT_CAP = 1000）。
 */
export function createCounter(cap: number): Counter {
  let count = 0;
  return {
    get count() {
      return count;
    },
    next(): number {
      if (count >= cap) {
        throw new Error("agent cap " + cap + " exceeded");
      }
      count += 1;
      return count;
    },
  };
}

export { TOTAL_AGENT_CAP };

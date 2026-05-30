// sandbox.ts — extract the `meta` literal and run the workflow script in node:vm.
// sandbox.ts —— 提取 `meta` 字面量，并在 node:vm 中运行 workflow 脚本。
//
// Two jobs (SPEC §3, §6, §12):
// 两件事（SPEC §3、§6、§12）：
//   extractMeta — balanced-brace scan the `meta` object literal, eval it in an EMPTY
//   extractMeta —— 用平衡括号扫描 `meta` 对象字面量，在一个空的
//                 vm context so any var/fn/template ref throws (enforces "pure literal").
//                 vm context 中求值，使任何变量/函数/模板引用都抛错（强制要求“纯字面量”）。
//   runScript   — transform the source (drop top-level `export`, wrap in an async fn so
//   runScript   —— 转换源码（去掉顶层 `export`，包进一个 async 函数，使
//                 top-level await/return work), bind the hooks as CONTEXT GLOBALS, and
//                 顶层 await/return 可用），把 hooks 绑定为 context 全局变量，并
//                 trap the determinism-breaking time/randomness APIs (Date.now,
//                 拦截会破坏确定性的时间/随机 API（Date.now、
//                 Math.random, argless `new Date`) so the USER SCRIPT can't call them.
//                 Math.random、无参的 `new Date`），使用户脚本无法调用它们。

import vm from "node:vm";
import type { WorkflowMeta, ScriptHooks } from "../types.js";

const META_DECL_RE = /(?:^|\n)\s*(?:export\s+)?const\s+meta\s*=/;

// Determinism pre-flight (SPEC §6). The PRIMARY guard is this static source scan — it
// 确定性预检（SPEC §6）。首要防线是这个静态源码扫描 ——
// mirrors the official tool, which rejects scripts referencing these APIs at submission
// 它复刻官方工具的做法：在提交时（任何 vm 运行之前）就拒绝引用这些 API 的脚本。
// time (before any vm runs). The buildGlobals traps below are a best-effort SECONDARY
// 下方 buildGlobals 中的拦截只是尽力而为的次要
// defense. node:vm is explicitly NOT a security/isolation boundary, and the orchestration
// 防线。node:vm 明确不是安全/隔离边界，而且编排
// hooks must be real host functions, so a script that deliberately reflects via the
// hooks 必须是真实的宿主函数，所以一个刻意通过 Function 构造器做反射的脚本
// Function constructor can still reach the host realm — that is an inherent vm limitation,
// 仍然能触达宿主 realm —— 这是 vm 固有的局限，
// out of the cooperative-determinism threat model. The scan is intentionally naive (it also
// 不在“协作式确定性”的威胁模型之内。这个扫描故意写得很朴素（它也
// matches inside strings/comments), exactly like the official source check.
// 会匹配到字符串/注释内部），与官方的源码检查完全一致。
const FORBIDDEN_PATTERNS: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /\bDate\s*\.\s*now\s*\(/, name: "Date.now()" },
  { re: /\bMath\s*\.\s*random\s*\(/, name: "Math.random()" },
  { re: /\bnew\s+Date\s*\(\s*\)/, name: "new Date()" },
];

/** Reject a script that references the wall-clock / randomness APIs (SPEC §6). */
/** 拒绝任何引用了 wall-clock / 随机 API 的脚本（SPEC §6）。 */
export function assertDeterministicSource(source: string): void {
  for (const { re, name } of FORBIDDEN_PATTERNS) {
    if (re.test(source)) {
      throw new Error(
        `Workflow scripts must be deterministic: ${name} is unavailable (breaks resume). ` +
          "Pass timestamps via args.",
      );
    }
  }
}

/**
 * Find the `meta` object literal, eval it with an empty sandbox (no hooks, no globals)
 * 找到 `meta` 对象字面量，用一个空沙箱（无 hooks、无全局变量）对它求值，
 * so a non-literal meta throws, then validate name/description are strings.
 * 使非字面量的 meta 抛错，然后校验 name/description 都是字符串。
 */
export function extractMeta(source: string): WorkflowMeta {
  const decl = META_DECL_RE.exec(source);
  if (decl === null) {
    throw new Error(
      "workflow script must declare `export const meta = { … }` before its body (SPEC §3)",
    );
  }

  // Position of the `=` that begins the literal.
  // 字面量起始处那个 `=` 的位置。
  const eqIndex = source.indexOf("=", decl.index + decl[0].length - 1);
  if (eqIndex === -1) {
    throw new Error("malformed `meta` declaration: missing `=`");
  }

  const literal = scanObjectLiteral(source, eqIndex + 1);

  let value: unknown;
  try {
    // Empty sandbox: any identifier / function / template ref inside the literal is a
    // 空沙箱：字面量里任何标识符 / 函数 / 模板引用都是一个
    // free variable that is not defined → ReferenceError. That enforces "pure literal".
    // 未定义的自由变量 → ReferenceError。这就强制了“纯字面量”。
    value = vm.runInNewContext("(" + literal + ")", Object.create(null), {
      timeout: 1000,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `\`meta\` must be a pure object literal (no variables, calls, spreads, or template interpolation): ${reason}`,
    );
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("`meta` must be a plain object literal");
  }

  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string") {
    throw new Error("`meta.name` is required and must be a string");
  }
  if (typeof obj.description !== "string") {
    throw new Error("`meta.description` is required and must be a string");
  }

  return obj as unknown as WorkflowMeta;
}

/**
 * Balanced-brace scan starting at `from`. Skips whitespace to the opening `{`, then walks
 * 从 `from` 开始的平衡括号扫描。跳过空白直到开括号 `{`，然后在尊重
 * to its matching `}` while respecting strings, template literals, and comments. Returns
 * 字符串、模板字面量和注释的前提下走到与之匹配的 `}`。返回
 * the literal text including the braces.
 * 包含两侧花括号的字面量文本。
 */
function scanObjectLiteral(source: string, from: number): string {
  let i = from;
  // Skip leading whitespace to the opening brace.
  // 跳过前导空白，直到开括号。
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    break;
  }
  if (source[i] !== "{") {
    throw new Error("`meta` must be assigned an object literal `{ … }`");
  }

  const start = i;
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString !== null) {
      if (c === "\\") {
        i++; // skip escaped char ｜ 跳过被转义的字符
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }

    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error("unterminated `meta` object literal: no matching `}` found");
}

/**
 * Transform the source so top-level `export` is dropped and the body is wrapped in an
 * 转换源码：去掉顶层 `export`，把脚本体包进一个
 * async function (enabling top-level await + return), bind the hooks as context globals,
 * async 函数（从而支持顶层 await + return），把 hooks 绑定为 context 全局变量，
 * and run it in a vm context whose globals are safe builtins + determinism traps.
 * 然后在一个全局为“安全内建 + 确定性拦截”的 vm context 中运行它。
 */
export async function runScript(source: string, hooks: ScriptHooks): Promise<unknown> {
  assertDeterministicSource(source);
  const transformed = transformSource(source);
  const wrapped = "async function __wf(){\n" + transformed + "\n}";

  const globals = buildGlobals(hooks);
  const ctx = vm.createContext(globals);
  const fn = vm.runInContext("(" + wrapped + ")", ctx) as () => Promise<unknown>;
  return await fn();
}

/**
 * Drop the leading `export ` from `export const meta` and from any other top-level
 * 去掉 `export const meta` 以及任何其他顶层
 * `export const`/`export function`. Only matches at line starts (top-level), leaving
 * `export const`/`export function` 前导的 `export `。只匹配行首（顶层），让
 * exports inside nested scopes untouched (they'd be syntax errors anyway, but the body
 * 嵌套作用域内的 export 保持原样（它们本来就是语法错误，不过脚本体
 * shouldn't contain them).
 * 也不应该包含它们）。
 */
function transformSource(source: string): string {
  // `export const meta` → `const meta` (and any other top-level export decl).
  // `export const meta` → `const meta`（以及任何其他顶层 export 声明）。
  return source.replace(
    /(^|\n)([ \t]*)export[ \t]+(const|let|var|function|async[ \t]+function|class)\b/g,
    (_m, lead: string, indent: string, kw: string) => lead + indent + kw,
  );
}

/**
 * Build the vm context globals: safe builtins + a Math copy whose random throws + a Date
 * 构建 vm context 的全局对象：安全内建 + 一个 random 会抛错的 Math 副本 + 一个
 * wrapper whose `now` and argless construction throw + the injected hooks. No require /
 * `now` 和无参构造都会抛错的 Date 包装器 + 注入的 hooks。没有 require /
 * process / global / globalThis / import / fs / child_process.
 * process / global / globalThis / import / fs / child_process。
 */
function buildGlobals(hooks: ScriptHooks): Record<string, unknown> {
  const blocked = "wall-clock/now is unavailable in workflow scripts — pass timestamps via args";

  // Math copy: identical surface, but `random` throws.
  // Math 副本：表面一模一样，但 `random` 会抛错。
  const SafeMath: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(Math)) {
    SafeMath[k] = (Math as unknown as Record<string, unknown>)[k];
  }
  SafeMath.random = () => {
    throw new Error(blocked);
  };

  // Date wrapper: explicit-argument construction and parsing stay usable; argless
  // Date 包装器：带显式参数的构造和解析仍可用；无参
  // construction (the "now" path), bare `Date()` calls, and the static `now()` throw.
  // 构造（即“now”路径）、裸 `Date()` 调用、以及静态 `now()` 都会抛错。
  //
  // Crucially, the wrapper severs every back-channel from a constructed instance to the
  // 关键在于，这个包装器切断了从已构造实例通往
  // real, untrapped Date — `new Date(0).constructor.now()`, `Date.prototype.constructor`,
  // 真实、未被拦截 Date 的所有后门 —— `new Date(0).constructor.now()`、`Date.prototype.constructor`、
  // and walking the instance's prototype chain must NOT reach the real Date (that would
  // 以及顺着实例原型链往上走，都不能触达真实 Date（否则会
  // re-expose live wall-clock and defeat the determinism guarantee in SPEC §6). To achieve
  // 重新暴露实时 wall-clock，破坏 SPEC §6 的确定性保证）。为此，
  // that, instances are built with Reflect.construct (so they keep Date's internal slot +
  // 实例用 Reflect.construct 构造（从而保留 Date 的内部 slot +
  // methods) but re-homed onto a SANITIZED prototype whose `constructor` is SafeDate and
  // 方法），但被重新挂到一个净化过的原型上，其 `constructor` 是 SafeDate、
  // whose own [[Prototype]] is Object.prototype — RealDate.prototype is never in the chain.
  // 其自身的 [[Prototype]] 是 Object.prototype —— RealDate.prototype 永远不在链上。
  const RealDate = Date;
  const SafeDate = function (this: unknown, ...rawArgs: unknown[]): object {
    if (new.target === undefined) {
      // Bare `Date()` — would need the wall clock to make sense; disallow.
      // 裸 `Date()` —— 只有依赖 wall clock 才有意义；禁止。
      throw new Error(blocked);
    }
    if (rawArgs.length === 0) {
      throw new Error(blocked);
    }
    // Build a genuine Date (internal [[DateValue]] slot + working methods) but home it on
    // 构造一个真正的 Date（带内部 [[DateValue]] slot + 可用方法），但通过 newTarget 参数
    // SafeDate.prototype via the newTarget argument rather than on RealDate.prototype.
    // 把它挂到 SafeDate.prototype，而不是 RealDate.prototype。
    return Reflect.construct(RealDate, rawArgs, SafeDate as unknown as new () => object);
  } as unknown as DateConstructor;

  // Sanitized prototype: copy every RealDate.prototype method/symbol, but point
  // 净化后的原型：复制 RealDate.prototype 上的每个方法/symbol，但把
  // `constructor` at SafeDate and let it inherit from Object.prototype (NOT
  // `constructor` 指向 SafeDate，并让它继承自 Object.prototype（而非
  // RealDate.prototype), so no proto-walk or `.constructor` hop reaches the real Date.
  // RealDate.prototype），这样任何原型链遍历或 `.constructor` 跳转都触达不到真实 Date。
  const safeProto: object = Object.create(Object.prototype);
  for (const key of Reflect.ownKeys(RealDate.prototype)) {
    if (key === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(RealDate.prototype, key);
    if (desc !== undefined) Object.defineProperty(safeProto, key, desc);
  }
  Object.defineProperty(safeProto, "constructor", {
    value: SafeDate,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(SafeDate, "prototype", {
    value: safeProto,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  SafeDate.parse = RealDate.parse.bind(RealDate);
  SafeDate.UTC = RealDate.UTC.bind(RealDate);
  Object.defineProperty(SafeDate, "now", {
    value: () => {
      throw new Error(blocked);
    },
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // Intl override (SPEC §6). ECMA-402 `DateTimeFormat.format()/formatToParts()/
  // Intl 覆写（SPEC §6）。ECMA-402 的 `DateTimeFormat.format()/formatToParts()/
  // formatRange*()` default a missing or `undefined` date argument to the SYSTEM CLOCK in
  // formatRange*()` 在缺省或传入 `undefined` 日期参数时，会在引擎（C++）内部默认取系统时钟 ——
  // the engine (C++) — NOT via the sandbox Date — so the SafeDate trap does not cover it and
  // 而不经过沙箱里的 Date —— 所以 SafeDate 的拦截覆盖不到它，
  // a cooperative author can accidentally leak live wall-clock with `Intl.DateTimeFormat()
  // 一个守规矩的作者也可能通过 `Intl.DateTimeFormat()
  // .format()`. Wrap DateTimeFormat so the now-defaulting path throws; explicit timestamps
  // .format()` 意外泄漏实时 wall-clock。包装 DateTimeFormat 使“默认取 now”的路径抛错；显式传时间戳
  // still work. Other Intl members (NumberFormat, Collator, …) are time-independent.
  // 仍然可用。Intl 的其他成员（NumberFormat、Collator 等）与时间无关。
  // (Temporal — whose `Temporal.Now.*` is another now-defaulting surface — is not shipped in
  // （Temporal —— 其 `Temporal.Now.*` 是另一个“默认取 now”的入口 —— 在
  //  the current Node baseline; if a future runtime exposes it, it must be trapped here too.)
  //  当前 Node 基线里尚未提供；若未来某个运行时暴露了它，也必须在这里一并拦截。）
  const RealIntl = Intl;
  const SafeIntl: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(RealIntl)) {
    SafeIntl[k] = (RealIntl as unknown as Record<string, unknown>)[k];
  }
  const RealDTF = RealIntl.DateTimeFormat;
  const SafeDTF = function (...ctorArgs: unknown[]): object {
    const inst = new (RealDTF as unknown as new (...a: unknown[]) => object)(...ctorArgs);
    return new Proxy(inst, {
      get(target, prop) {
        const tgt = target as Record<string, (...x: unknown[]) => unknown>;
        if (prop === "format" || prop === "formatToParts") {
          const fn = (tgt[prop] as (...x: unknown[]) => unknown).bind(target);
          return (...a: unknown[]) => {
            if (a.length === 0 || a[0] === undefined) throw new Error(blocked);
            return fn(...a);
          };
        }
        if (prop === "formatRange" || prop === "formatRangeToParts") {
          const fn = (tgt[prop] as (...x: unknown[]) => unknown).bind(target);
          return (...a: unknown[]) => {
            if (a.length < 2 || a[0] === undefined || a[1] === undefined) throw new Error(blocked);
            return fn(...a);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
  } as unknown as typeof Intl.DateTimeFormat;
  SafeDTF.supportedLocalesOf = RealDTF.supportedLocalesOf.bind(RealDTF);
  SafeIntl.DateTimeFormat = SafeDTF;

  return {
    // Safe builtins.
    // 安全的内建对象。
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Map,
    Set,
    RegExp,
    Error,
    Symbol,
    // NOTE: structuredClone is deliberately NOT exposed. It is a host intrinsic that
    // 注意：structuredClone 是故意不暴露的。它是一个宿主内建函数，
    // deep-clones by RECONSTRUCTING Date instances on the real (untrapped) Date.prototype
    // 深拷贝时会在真实（未被拦截的）Date.prototype 上重建 Date 实例 ——
    // — a back-channel that hands the script the real Date constructor (.now() / argless
    // 这是一条后门，把真实的 Date 构造器交到脚本手里（.now() / 无参
    // construction → live wall clock) and defeats the SPEC §6 determinism guarantee.
    // 构造 → 实时 wall clock），从而破坏 SPEC §6 的确定性保证。
    // Scripts that need a plain-data clone can JSON-roundtrip.
    // 需要纯数据克隆的脚本可以走 JSON 往返。
    console,
    Math: SafeMath,
    Date: SafeDate,
    Intl: SafeIntl,

    // Injected hooks (referenced as free variables inside the script).
    // 注入的 hooks（在脚本内部以自由变量的形式被引用）。
    agent: hooks.agent,
    parallel: hooks.parallel,
    pipeline: hooks.pipeline,
    phase: hooks.phase,
    log: hooks.log,
    args: hooks.args,
    workflow: hooks.workflow,
  };
}

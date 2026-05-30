---
name: open-dynamic-workflows
description: >-
  当一个任务需要的 agent 多到一次对话协调不过来，或你想把编排固化成一段可重跑的脚本时使用——
  例如全代码库审计 / bug 扫荡、大规模迁移（上百个文件）、需要把多个来源相互交叉核对的研究、
  或一个值得从多个独立角度各起一稿再择优的硬计划（fan-out / 多 agent 编排 / workflow）。
  本 skill 讲【如何编写】一段动态 workflow 的 JavaScript 脚本（官方契约），以及【如何运行】它
  （本项目运行时：`workflow run` / `runWorkflow`）.
---

# 动态 workflow：怎么写，怎么跑

动态 workflow 是一段**编排大量 subagent 的 JavaScript 脚本**。模型为任务**写出**这段脚本,
运行时**执行**它,把每个 `agent()` 调用 fan out 成一个 subagent。控制流(循环、分支、fan-out)
是确定性的 JS——LLM 的活只发生在叶子节点。中间结果留在脚本变量里,最后只把最终答案带回来。

## 何时用 workflow(相对 subagent / skill / 普通工具)

workflow 把**计划搬进代码**。以下情况用它:

- 任务可拆成**几十到几百**个 agent(多到一次对话协调不过来);
- 你想要一段**可重跑、可 resume** 的编排脚本;
- 你想要一套**可复用的质量模式**——比如让独立 agent **对抗式互查**彼此的发现,或从多个角度各起一稿再相互权衡——而不只是"多跑几个 agent"。

典型场景:全代码库 bug / 安全 / 性能扫荡 · 500 文件迁移 · 多来源交叉核对的研究 · 从独立角度压力测试一个硬计划。
**不要**用它做单个快速读改文件,或普通工具就够的事。

---

## 如何编写一段 workflow 脚本

脚本是**纯 JavaScript**(不是 TypeScript——不写类型标注 / interface / 泛型)。脚本体在 async 上下文里跑:
顶层 `await` 可用,顶层 `return <value>` 就是 workflow 的结果。

### 1. `meta` 块(必填,第一条)

每段脚本必须以 `export const meta = {...}` 开头,且它是**纯字面量**——不含变量、函数调用、spread、模板插值:

```js
export const meta = {
  name: 'find-flaky-tests',                 // 必填
  description: 'Find flaky tests and propose fixes',  // 必填
  whenToUse: '…',                            // 可选
  phases: [                                  // 可选,每个 phase() 调用对应一条
    { title: 'Scan', detail: 'grep CI logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test', model: 'opus' },
  ],
}
```

必填 `name`、`description`。`meta.phases` 里的标题要和 `phase()` 调用一致(精确匹配)。
`meta` 缺失或非字面量会立即报清晰错误。

### 2. Script body hooks(脚本体可用的注入函数)

以下被注入脚本作用域:

- **`agent(prompt, opts?) → Promise<any>`** —— 启动一个 subagent。不带 `schema` 时解析为它的最终文本;
  带 `schema`(一个 JSON Schema)时,subagent 被强制产出符合的对象,`agent()` 解析为**校验后的对象**。
  被跳过 / 中止则返回 `null`(用 `.filter(Boolean)` 过滤)。`opts`:`label`(简短显示名)、
  `phase`(指定进度分组——**在 parallel/pipeline 的 stage 里务必显式传**)、`schema`、`model`(覆盖;
  省略则继承)、`isolation:'worktree'`(给该 agent 开独立 git worktree——**昂贵**,仅当并行改文件会冲突时用)、
  `agentType`(具名 subagent 预设)。
- **`pipeline(items, stage1, stage2, …) → Promise<any[]>`** —— 每个 item 独立流过所有 stage,
  **阶段间无 barrier**(item A 可在 stage 3,item B 还在 stage 1)。每个 stage 回调收到
  `(prevResult, originalItem, index)`。某 stage 抛错 → 该 item 落 `null` 并跳过其余 stage。
  **这是多阶段工作的默认选择。**
- **`parallel(thunks) → Promise<any[]>`** —— 并发跑这些 thunk。这是 **barrier**(等全部)。
  抛错的 thunk 在结果里变 `null`,调用本身**永不 reject**——用前 `.filter(Boolean)`。
  传**函数,不是 promise**:`parallel(items.map(x => () => agent(...)))`。
- **`phase(title)`** —— 开一个 phase;后续 `agent()` 归到它名下。
- **`log(message)`** —— 输出一行叙述性进度。
- **`args`** —— 运行时传入的输入值,原样。
- **`workflow(nameOrRef, args?) → Promise<any>`** —— 内联跑另一个 workflow(**只允许一层嵌套**);
  共享本次 run 的并发 / agent 计数 / abort。

subagent 的**最终文本就是它的返回值**——给脚本用的原始数据,不是写给人看的消息。所以 `schema`
(直接拿回校验过的对象)和收尾的 synthesis agent 才重要。

### 3. 运行时强制的规则(不合格立即报错)

- **纯 JS**:脚本里不能用 `import` / `require` / `fs` / Node API。
- **决定论**:`Date.now()`、`Math.random()`、无参 `new Date()` 不可用(会破坏 resume)。
  时间戳通过 `args` 传入;需要"随机"就按 index 变化,别用随机数。
- **结构化输出**:`opts.schema` 是 JSON Schema,**根必须是 `type:"object"`**
  (discriminated union 要扁平表达:一个 enum 判别字段 + 若干可选字段,**不要**根 `oneOf`)。
- **上限**:并发最多 **`min(16, cpus-2)`** 个 agent(小机器更少);单次 run **总计 1000 个** agent。

### 4. 默认用 `pipeline()`;只在必须时才用 barrier

只有当 stage N **确实需要** stage N-1 的**全部**结果时才用 `parallel()`(barrier)——例如全集去重 / 合并、
按总数提前退出、或跨发现相互比对。"我得先 map/filter 一下"**不是**理由——把它放进 pipeline 的一个 stage。
barrier 会让快的 item 干等最慢的那个,白白浪费时间。

### 5. 为任务设计形态——这些模式是调色板,不是清单

**控制流由你设计。** 读懂任务,想清楚什么该 fan out、什么做验证、什么做 synthesis,然后挑——或组合——
最契合的形态。下面是一份"久经考验的形态"菜单:它们不是按顺序跑的步骤,也不是没看任务就先抓来用的默认值。
把任务对到形态上:

| 任务是…… | 就用…… |
| :-- | :-- |
| 未知规模的发现("把所有 X 找出来") | **跑到挖空 loop-until-dry** |
| 在几种方案里做艰难取舍 | **评委团 judge panel** |
| 判断一个结论是否跨多个来源成立 | **多模态 sweep + 交叉核对** |
| 跨大量条目的机械改动 | **逐条目 fan-out**(pipeline;会冲突就 `isolation:'worktree'`) |
| 确认可能出错的发现 | **对抗式 / 多视角验证** |

- **对抗式验证(adversarial verify)**:每条发现起 N 个独立 skeptic,prompt 让它们去**反驳**;多数反驳就毙掉。挡住"看着对其实错"。
- **多视角验证(perspective-diverse verify)**:给每个验证者不同的 lens(正确性 / 安全 / 性能 / 能否复现),而不是 N 个一样的复读机。
- **评委团(judge panel)**:从不同角度生成 N 稿,并行打分,从赢家综合 + 嫁接亚军的好点子。
- **跑到挖空(loop-until-dry)**:未知规模的发现,连续 K 轮没新东西才停(对照"所有已见"去重,不是只对照已确认的)。
- **多模态 sweep**:并行 agent 各用不同方式搜(按容器 / 按内容 / 按实体 / 按时间)。
- **完整性批判(completeness critic)**:最后一个 agent 专问"还漏了什么?"——它的答案就是下一轮的活。
- **不许静默截断**:若你限了覆盖范围(top-N / 抽样),用 `log()` 说清楚丢了什么。
- 多结果的 run 末尾,总要一个 **synthesis agent** 返回一个紧凑、可 JSON 序列化的结论。

**这些模式并不穷尽——任务需要时就组合出新的 harness**(锦标赛淘汰、自我修复循环、分级升级,怎么合适怎么来)。
列出来的是起点,不是封闭集合;形态由任务决定。

按需求伸缩:"找点 bug" → 几个 finder + 单票验证;"彻底审计" → 更大 finder 池 + 3–5 票对抗 + synthesis。

### 一个范例 —— review→verify 这一种形态(看机制,别照搬)

下面这段展示的是**机制**——默认 pipeline、只在必要处加 barrier、schema 校验的 `agent()` 调用——
落在**一种**形态上:按维度 review,再逐条 verify。这是"先 review、再确认发现"这类任务的形态,
**不是**所有任务的模板。

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: 'Review the diff for correctness bugs. Report findings.' },
  { key: 'perf', prompt: 'Review the diff for performance regressions. Report findings.' },
]

const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  (review) =>
    parallel(
      review.findings.map((f) => () =>
        agent(`Adversarially verify this finding — is it real? ${f.title}`, {
          label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA,
        }).then((v) => ({ ...f, verdict: v })),
      ),
    ),
)

const confirmed = results.flat().filter(Boolean).filter((f) => f.verdict?.isReal)
return { confirmed }
// 'bugs' 的发现在 'perf' 还在 review 时就已经在 verify 了——不浪费墙钟时间。
```

**最常见的写法错误,就是把这套骨架照搬过去**——`DIMENSIONS` 数组、`FINDINGS_SCHEMA` / `VERDICT_SCHEMA`
这套命名、"逐条对抗式验证"那一趟——套到一个根本不是"先 review 再验证发现"的任务上。比如:判断一个指标
结论是否成立,该是**多模态 sweep + 把几个来源相互交叉核对**,而不是起 N 个 skeptic 去逐条反驳;硬套
verify 骨架反而会漏掉任务真正需要的交叉核对。把任务对到上面表格里的形态,让任务来决定结构——范例只教原语。

---

## 如何运行一段 workflow(本项目运行时)

把脚本写到一个 `.js` 文件。若运行时 CLI 还没装,先装(它提供 `workflow` 命令):

```bash
npm install -g open-dynamic-workflows      # 提供 `workflow` 命令
```

然后跑这个脚本:

```bash
workflow run path/to/script.js [--args '<json>'] [--model <id>] [--resume <runId>]
# 例如
workflow run audit.js --args '{"dir":"src"}'
```

或在代码里嵌入:

```js
import { runWorkflow } from 'open-dynamic-workflows'
const result = await runWorkflow({
  scriptPath: 'audit.js',           // 或 script: '<内联源码>'
  args: { dir: 'src' },
  signal: controller.signal,         // 取消
  onEvent: (e) => { /* phase_start / agent_start / agent_end / log / run_end */ },
})
// result: { runId, value, tokensSpent, agentCount, durationMs, events, ... }
// value 就是脚本 return 的东西。
```

- **取消**:CLI 里按 Ctrl-C(或 abort 那个 `signal`)——杀掉在飞的 subagent 进程树,run 干净 unwind;已完成的 agent 仍被记录。
- **Resume**:`--resume <runId>`(或 `resumeFromRunId`)——已完成、且 `(prompt, opts)` 未变的 `agent()` 调用从缓存重放、**零 token 花费**;其余 live 跑。
- **进度 / 成本**:每个 agent 的 cost、token、耗时经 `onEvent` 与终端实时树流出;完整事件日志落在 run 目录下。

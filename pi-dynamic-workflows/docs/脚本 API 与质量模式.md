# 脚本 API 与质量模式

工作流脚本是普通 JavaScript。本文档给出脚本里所有可用全局、它们的选项、以及推荐的质量模式。

## 1. 脚本骨架

```js
export const meta = {
  name: 'short_snake_case',     // 必填，做 runId 的 slug
  description: '一句话描述',     // 必填
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Verify' }],
  // model: 'anthropic/claude-fable-5',         // 可选：默认模型
  // phases: [{ title: 'Verify', model: 'anthropic/claude-opus-4-8' }],
}

phase('Scan')
const files = await agent('列出 src/routes/ 下所有路由文件', { tier: 'small' })

phase('Review')
const findings = await parallel(
  files.split('\n').filter(Boolean).map((file) =>
    () => agent(`审计 ${file} 是否缺少 auth 检查`, { tier: 'medium', isolation: 'worktree' })
  )
)

phase('Verify')
return await agent('汇总并交叉验证这些发现：\n' + findings.join('\n\n'), { tier: 'big' })
```

### meta 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✅ | 非空字符串；用作 runId slug，截断 40 字符 |
| `description` | ✅ | 非空字符串；UI 与 log 里都看得到 |
| `phases` | ✕ | `Array<{ title: string; model?: string }>`，每个 phase 标题即 phase() 接受的字符串 |
| `model` | ✕ | 整次 run 的默认模型；被 `opts.model` / `opts.tier` 覆盖 |

### meta 解析的硬约束

- 必须是 `export const meta = { ... }` 写在最前面。
- meta 必须是字面量（`ObjectExpression`），不允许 spread、computed key、`__proto__` 等。
- `name` / `description` 必须是字符串字面量。

这些约束都在解析阶段（`parseWorkflowScript`）就拒绝掉。

## 2. 可用全局

### 2.1 `agent(prompt, options?)`

发起一个隔离的子代理。

```ts
type AgentOptions = {
  label?: string;                                       // 2-5 词的短描述，用于 TUI/日志
  phase?: string;                                       // 显式指定 phase（覆盖 phase()）
  schema?: TSchema;                                      // JSON Schema；返回的是校验过的对象
  model?: string;                                        // 'provider/modelId' 或 'provider/modelId:thinking'
  tier?: 'small' | 'medium' | 'big' | string;            // 通过 ~/.pi/workflows/model-tiers.json 解析
  agentType?: string;                                    // .pi/agents/<name>.md 的命名子代理
  isolation?: 'worktree';                                // 给 agent 单独 git worktree
  timeoutMs?: number | null;                             // 单个 agent 的超时；null = 不限时
  retries?: number;                                      // 0..3；可恢复失败的重试次数
}
```

返回：

- 无 `schema` → `string`（最后一个 assistant 文本）
- 有 `schema` → `Static<TSchema>`（已通过 schema 校验的对象）

模型解析优先级：

```
opts.model  >  agentDef.model  >  opts.tier  >  meta.phases[currentPhase].model  >  meta.model  >  mainModel
```

如果什么都不指定但 `model-tiers.json` 存在，会回退到 `medium` tier——保证"用户配了 tier 就真的生效"。

#### 关键行为

- **限流器**：所有 agent 共享一个 `limiter`，默认上限 `min(16, hardwareConcurrency - 2)`，可在 `runWorkflow` 的 `options.concurrency` 覆盖。
- **预算门禁**：`tokenBudget` 达到后下一个 `agent()` 抛 `TOKEN_BUDGET_EXHAUSTED`（不可恢复，抛错）。
- **agent 上限**：超过 `maxAgents`（默认 1000）抛 `AGENT_LIMIT_EXCEEDED`。
- **可恢复错误自动重试**：超时 / 连接失败 / 空文本输出 / `usage limit` 这类，按 `retries + 1` 次重试；用尽后无 schema 返回 `null`，有 schema 抛错。
- **不可恢复错误抛出**：`TOKEN_BUDGET_EXHAUSTED` / `AGENT_LIMIT_EXCEEDED` / `WORKFLOW_ABORTED`（主动 abort）会直接抛出，被 `parallel()` 识别后中断整个 fan-out。
- **真实账本**：每个 agent 完成时 SDK 会话调用 `session.getSessionStats()`，把 input/output/cacheRead/cacheWrite/cost 计入共享 `tokenUsage` 和 `shared.spent`，**不是估算**。
- **Worktree**：`isolation: "worktree"` 创建一个 `<repoRoot>/.pi/worktrees/<id>` 的临时分支 `pi/wf/<id>`；agent 完成后 `removeWorktree` 强制清理（即便超时/异常）。
- **子代理 transcript**：`persistAgentSessions: true` 时落盘到 `~/.pi/agent/sessions/<encoded-cwd>/`，命名 `workflow:<runId> <label>`。

### 2.2 `parallel(thunks)`

`thunks` 必须是 `() => Promise<unknown>` 数组，**不是** Promise 数组。常见错误写法：

```js
// ❌ 错：传 Promise，全部串行等
await parallel(items.map(item => agent(...)))

// ✅ 对：传 thunk，limiter 控制并发
await parallel(items.map(item => () => agent(...)))
```

行为：

- 内部走 `Promise.all` + 共享限流器。
- 任意 thunk 抛可恢复错误 → 那一槽返回 `null`，日志记录，不影响其他。
- 任意 thunk 抛不可恢复错误 → 整个 `parallel()` 抛出。
- 不可恢复 = `TOKEN_BUDGET_EXHAUSTED` / `AGENT_LIMIT_EXCEEDED` / 主动 abort。

返回值是 `unknown[]`，与输入等长。

### 2.3 `pipeline(items, ...stages)`

每个 stage 签名是 `(prev, original, index) => Promise<unknown> | unknown`。不同 item 的多个 stage 之间可以并发；同一个 item 内的 stage 是串行。

```js
const result = await pipeline(
  files,
  async (file) => (await agent(`阅读 ${file}`)).slice(0, 500),
  (preview, file) => `<<${file}>>\n${preview}`,
)
```

错误处理与 `parallel` 一致：可恢复 → `null`，不可恢复 → 抛出。

### 2.4 `workflow(nameOrScript, args?)`

调用保存的工作流或直接传一段脚本字符串：

```js
// 1) 调已保存的工作流（保存的脚本从 storage 里 load）
const out = await workflow('code-review', { diff, diffSource })

// 2) 直接传脚本（罕见用法，nameOrScript 解析失败时 fallback 为 script）
const out = await workflow(`export const meta = {...}; ...`, args)
```

- 共享外层的 limiter / agentCount / tokenBudget / SharedStore。
- 嵌套深度 1：再调一次 `workflow()` 会抛 `SCRIPT_VALIDATION_ERROR`。
- 不共享外层的 `resumeJournal`：子 run 自己的脚本，不复用父的账本。
- `runId` 形如 `${parentRunId}-nested1`，与父 run 不冲突。

### 2.5 `phase(title, { budget? })`

切换当前 phase，影响后续 agent 在 TUI/任务面板里的分组。`budget` 是该 phase 的 token 子预算：

```js
phase('Expensive Research', { budget: 100_000 })
try {
  // ... 多个 agent
} catch (e) {
  if (e.code !== 'TOKEN_BUDGET_EXHAUSTED') throw e
  log('phase exceeded budget, skipping')
}
```

软门禁：phase 内 `shared.spent - startSpent >= budget` 时抛 `TOKEN_BUDGET_EXHAUSTED`（不可恢复），但因为是抛错而不是拒绝新 agent，try/catch 包一层即可让后续 phase 继续。

### 2.6 `checkpoint(promptText, options?)`

人类决策点；resume 时回放人类答复（这是相对 Claude Code 的真优势之一）。

```ts
const go = await checkpoint('确认要继续重构吗？', { default: true })
if (!go) return { skipped: true }
```

行为：

- 走 callSeq + callHash，resume 同样生效。
- 有 `options.confirm` → 调它拿答复（用于前台同步的 UI 场景）。
- 无 `confirm`（后台 run 常见）→ `headless: 'default'`（默认）时取 `options.default ?? true`；`headless: 'abort'` 时抛 `WORKFLOW_ABORTED`。
- **后台 run 永不挂起**——这是关键：headless 模式绝不让"等待人类"卡住长循环。

### 2.7 `verify(item, { reviewers?, threshold?, lens? })`

让 N 个对抗者独立判断 item 是否真实，N 默认 2，threshold 默认 0.5。

```js
const verdict = await verify(finding, {
  reviewers: 3,
  threshold: 0.5,
  lens: 'security',  // 或 string[]
})
// → { real: boolean, realCount, total, votes: [{real, reason}, ...] }
```

`lens` 是文本提示词，每个 reviewer 拿一个循环分配。

### 2.8 `judgePanel(attempts, { judges?, rubric? })`

N 个 attempts 各自被多个 judge 打分，取平均分最高者（输入序兜底）。

```js
const best = await judgePanel(
  candidates,
  { judges: 3, rubric: 'factuality and citation accuracy' }
)
// → { index, attempt, score, judgments: [{score, reason}, ...] }
```

### 2.9 `loopUntilDry({ round, key?, consecutiveEmpty?, maxRounds? })`

`round(roundIndex) => unknown[]`，每轮产出的 items 按 `key(item)` 去重加入累积列表，连续 `consecutiveEmpty`（默认 2）轮没新东西就停止。最长 `maxRounds`（默认 50）轮。

```js
const bugs = await loopUntilDry({
  round: async (i) => {
    const found = await agent(`Round ${i + 1}：还有哪些没列出来的 bug？`, {
      schema: { type: 'object', properties: { bugs: { type: 'array', items: { type: 'object' } } } }
    })
    return found?.bugs ?? []
  },
  key: (b) => `${b.file}:${b.line}:${b.summary.slice(0, 40)}`,
  consecutiveEmpty: 2,
})
```

遇到 token 用尽 / agent 上限会优雅 break（保留已收集的部分），不抛错。

### 2.10 `completenessCheck(taskArgs, results)`

收尾 critic：让一个 agent 列出"还缺什么"。

```js
const missing = await completenessCheck(args, collected)
// → { complete: boolean, missing: string[] }
```

### 2.11 `retry(thunk, { attempts?, until? })`

`thunk(attempt) => Promise`，`until(result) => boolean` 满足即停。

```js
const ok = await retry(
  (i) => agent(`第 ${i + 1} 次尝试：...`),
  { attempts: 3, until: (r) => r?.pass === true }
)
```

### 2.12 `gate(thunk, validator, { attempts? })`

`validator(result) => { ok, feedback? }`，不通过则把 `feedback` 喂给下一次 `thunk(feedback, attempt)`。

```js
const out = await gate(
  (fb, i) => agent(`根据反馈修正输出 (第 ${i + 1} 次)：\n${fb ?? ''}`),
  (r) => r?.looks_valid === true ? { ok: true } : { ok: false, feedback: '...' },
  { attempts: 3 }
)
// → { ok, value, attempts }
```

### 2.13 `log(message)` / `console.*`

`log('...')` 把一行加入 `state.logs`、写到 `<runsDir>/<runId>.log`、触发 `onLog` 事件。`console.log / info / warn / error` 也都桥接到 `log`，但 `warn/error` 会加前缀。

### 2.14 `args` / `cwd` / `process.cwd()` / `budget`

- `args`：脚本的入参（`runWorkflow` 的 `args` 字段），任意 JSON。
- `cwd`：项目根目录（`runWorkflow` 的 `cwd` 字段）。
- `process.cwd()`：返回 cwd（vm 沙箱里 `process` 被冻结成 `{ cwd: () => '...' }`，没有其他方法）。
- `budget`：`{ total, spent(), remaining() }`，详见 [runtime-flow.md](./runtime-flow.md)。

## 3. 共享 store：`store_put` / `store_get`

每个子代理被注入两个工具 `store_put` / `store_get`，背后是 `SharedStore`：

- 整个 run 共享一份（嵌套也继承）。
- 写到 `store_put` 的 key→value 会被记到 `agentDeltas[deltaKey]`，每次 agent 完成时 `store.commitDelta(deltaKey)` 取出增量，**写入账本**。
- Resume 时按 callSeq 顺序 `applyDelta`，解决"并行 agent 谁后写谁赢"的乱序问题。
- 多 agent 写同一 key：last-write-wins，没有合并。

```js
// agent 内
await store_put({ key: 'routes', value: fileList })
```

工具名稳定为 `store_put` / `store_get`，且绕过 `agentType` 的 `tools` 白名单（通过 `systemTools` 注入）——任何 agentType 都能用。

## 4. 命名子代理：`agentType`

`.pi/agents/*.md`（项目级）和 `~/.pi/agent/agents/*.md`（用户级）的 Markdown 文件，frontmatter 定义工具白/黑名单 + model + 角色 prompt：

```markdown
---
name: security-auditor
description: Audits code for security issues
tools: [read, grep, glob]
disallowedTools: [bash]
model: anthropic/claude-fable-5
---

You are a security auditor. Focus on authn, authz, injection, and secrets handling.
```

```js
const audit = await agent('审计 src/auth/', { agentType: 'security-auditor' })
```

加载顺序（先来先得）：项目 → 用户级（`~/.pi/agent/agents/`）→ 旧版用户级（`~/.pi/agents/`，deprecated 警告）。

`agentDefinitionKey(def)` 把 tools/disallowedTools/model/isolation/prompt 序列化进 callHash，编辑 `.md` 会让 resume 重新跑对应 agent。

## 5. 质量模式：推荐组合

### 5.1 经典 fan-out：find → verify → merge

```js
phase('Find')
const candidates = await parallel(
  angles.map((a) => () => agent(`从 ${a} 角度找问题...`, { label: a, schema: candidateSchema }))
)

phase('Verify')
const surviving = await parallel(
  candidates.flat().map((c, i) => () =>
    agent(`判定这个发现是真问题还是误报：${JSON.stringify(c)}`, { label: `verify ${i}`, schema: verdictSchema })
  )
).then((vs) => candidates.flat().filter((_, i) => vs[i]?.verdict !== 'REFUTED'))

phase('Report')
return await agent('合成报告...', { tier: 'big' })
```

### 5.2 找完所有东西

```js
const bugs = await loopUntilDry({
  round: async (i) => (await agent(`第 ${i + 1} 轮：还有哪些 bug？`, { schema }))?.bugs ?? [],
  key: (b) => `${b.file}:${b.line}`,
})
```

### 5.3 最佳方案挑选

```js
const attempts = await parallel(ideas.map((idea) => () => agent(`实现这个方案：${idea}`)))
const best = await judgePanel(attempts, { rubric: 'correctness and clarity' })
```

### 5.4 反 adversarial 验证

```js
const verdict = await verify(finding, { reviewers: 3, threshold: 0.5, lens: 'security' })
if (!verdict.real) return null
```

### 5.5 大开支时优雅降级

```js
if (budget.remaining() < 50_000) {
  log('budget tight, switching to small tier')
  opts = { ...opts, tier: 'small' }
}
```

### 5.6 用 `checkpoint` 做单步确认

```js
const ok = await checkpoint('继续写实现吗？', { default: true })
if (!ok) return { skipped: true }
```

## 6. 错误处理

| 情况 | 行为 | 脚本如何应对 |
| --- | --- | --- |
| 单个 agent 超时 / 空输出 / 5xx | `retries` 内自动重试 | 拿不到就 `if (result === null) continue` |
| Provider 用量/配额 | 抛 `PROVIDER_USAGE_LIMIT`，不可恢复 | 让它抛；manager 会自动 `paused`，resume 时 replay |
| 主动 abort（Esc） | 抛 `WORKFLOW_ABORTED`，可恢复 | 同上 |
| Token 用尽 | 抛 `TOKEN_BUDGET_EXHAUSTED`，不可恢复 | 在 `try/catch` 包一个 phase，让后续 phase 继续 |
| Agent 上限 | 抛 `AGENT_LIMIT_EXCEEDED`，不可恢复 | 收尾 `return partial` |
| schema 不匹配 | 抛 `SCHEMA_NONCOMPLIANCE`，不可恢复 | 改 schema 或重写 agent 提示词 |

## 7. 不能做的事（确定性硬约束）

- `Date.now()` / `new Date()` / `Math.random()` 都会在 vm 沙箱里抛错。
- `require()` / `import` / `fs` / `process.binding` 全部不可用。
- 写入型副作用只能通过 `store_put` 或你自己的子代理工具；脚本自身不能直接写文件。
- 不能创建定时器（`setTimeout` / `setInterval` 是 vm realm 自己的，但延迟对 resume 毫无价值——注释里明确说"vm 里没有 timer"）。

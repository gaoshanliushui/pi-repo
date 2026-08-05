# Subagent Executor 架构与流程

本文档对应 `pi-subagents/src/runs/foreground/subagent-executor.ts`。该文件是前台 subagent 工具的中央执行器（executor），把上层工具调用解析成 single / parallel / chain 三种执行模式，并管理 foreground control、intercom 通信、fork context、嵌套路由、watchdog 操作与执行结果持久化。

## 1. 主要完成的工作

按职责拆分为以下几块：

### 1.1 入参解析与归一化

- `SubagentParamsLike` 统一了所有 subagent 动作（`run / status / steer / interrupt / stop / resume / append-step / doctor / schedule*`）以及三种执行模式（`agent / tasks / chain`）的入参形态。
- `omitExecutionModeActionAlias` 把旧版 `action: "single" | "parallel"` 形式归一为新版的"看 `agent/tasks/chain` 是否出现"。
- `normalizeRepeatedParallelCounts` 把 `tasks[i].count` 这种隐式并行展开成具体数组条目，让下游免做计数展开；同样处理 chain 内 parallel 步骤的 count。
- `applySingleAgentLaunchDefaults` 把 agent 配置里的 `defaultAsync / defaultTimeoutMs / defaultTurnBudget / defaultAcceptance` 在用户没显式给值时注入到 params。
- `applyForceTopLevelAsyncOverride` 实现"顶层强制 async"（`config.forceTopLevelAsync === true` 且子代理处于第 0 层时）。

### 1.2 校验

- `validateExecutionInput`：三种模式必须**恰好一种**被传入（`hasChain + hasTasks + hasSingle = 1`）；agent 名必须存在于 `agents` 列表；接受条件（`validateExecutionAcceptance`）必须能解析；chain 第一步不能是 dynamic fanout；parallel 步骤必须有 ≥1 个 task。
- `validateExecutionChainBindings`：chain 的 named output binding（`{previous}`、`{step.task.X}`）合法性。
- `countRequestedSubagentSpawns` / `reserveSubagentSpawns`：调度前的 session 级 spawn 配额检查。
- `checkSubagentDepth`：当前嵌套深度没超过 `maxSubagentDepth`。
- `resolveRequestedCwd`：把请求 cwd 解析为绝对路径，默认回退到 `ctx.cwd`。
- `resolveForegroundTimeout` / `resolveTurnBudgetConfig` / `validateToolBudgetConfig` / `resolveEffectiveToolBudget`：超时、turn 预算、tool 预算的合法性。
- `resolveAgentDefaultContextPolicy`：根据 agent 配置的 `defaultContext` 或显式 `params.context` 决定是否 fork；`preflightForkSessionsForStaticTasks` 在并发派发前**先串行**调用 `sessionFileForIndex` 把 fork session 文件预热，避免后续 `mapConcurrent` 抢同一父会话造成竞态。
- `buildParallelWorktreeTaskCwdError` / `findDuplicateParallelOutputPath`：worktree + parallel 路径冲突以及输出路径冲突检测。

### 1.3 Agent / Intercom / Fork 上下文

- `resolveExecutionAgentScope` → `discoverAgents`：从 `effectiveCwd` 发现可用 agents + 项目级 `modelScope`。
- `resolveIntercomBridge`：根据 `config.intercomBridge` 与 `params.context` 决定本次 run 是否启用 intercom bridge；启用时把每个 agent 套用 `applyIntercomBridgeToAgent`。
- `applyForceTopLevelAsyncOverride` / `createForkContextResolver`：构造 fork 上下文解析器，拿到 `sessionFileForIndex` 与 `thinkingOverrideForIndex`；chain/parallel 通过 `wrapChainTasksForFork` 把 `task: "{previous}"` 替换为 fork 模板。
- 子会话路径：`sessionDirForIndex(idx)`、`sessionFileForTask(agentName, idx)`、`sessionFileForIndex(idx)`、`thinkingOverrideForTask(agentName, idx)`。

### 1.4 Foreground Control 与状态机

- 前台执行会在 `state.foregroundControls.set(runId, foregroundControl)` 注册一个 control；包含 `runId / mode / currentAgent / currentIndex / currentActivityState / nestedRoute / interrupt` 等。
- `runSinglePath` / `runParallelPath` / `runChainPath` 内部都会把 control 的 `interrupt` 字段绑到子任务的 `AbortController.abort()`，并通过 `updateRememberedForegroundChild` 在 detached exit 时持久化进度和事件。
- `finish` 块（`finally`）始终清掉 pending notices、删除 control 记录、复位 `lastForegroundControlId`。
- `foregroundStatusResult` + `formatForegroundActivity`：把 control 投影成给 status 查询返回的"运行中"视图，含 `currentTool / currentToolStartedAt / currentActivityState / lastActivityAt / tokens / toolCount` 等。
- `trimRememberedForegroundRuns`：保留最近 50 条前台 run；优先淘汰 `exitCode` 收敛（非 detached）的。

### 1.5 单次执行路径（三种模式）

| 路径 | 入口 | 主要工作 |
| ---- | ---- | ---- |
| `runSinglePath` | `params.agent` | clarify TUI（若 `params.clarify && ctx.hasUI`）→ task 注入 `/single-output` 指令 → fork 模板 → `runSync` 拉起子进程 → 输出 `finalizeSingleOutput` → 计算 cost/usage → 记入 run history |
| `runParallelPath` | `params.tasks` | 并发上限 / worktree / 输出路径冲突检查 → clarify TUI 或 clarify-driven background → 把任务扇出到 `runForegroundParallelTasks`（`mapConcurrent` 包裹 `runSync`）→ `aggregateParallelOutputs` 汇总 → 处理 interrupted / detached 分支 → 写 foregroundControl 与 nested status |
| `runChainPath` | `params.chain` | sequential / parallel / dynamic-fanout 步骤的复合执行；通过 `executeChain` 处理；中途若 `chainResult.requestedAsync` 为真，自动转换为 `executeAsyncChain` 后台跑 |

并发度由 `resolveTopLevelParallelConcurrency` 解析，全局并发由 `Semaphore(deps.config.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT)` 强制上限。

### 1.6 Async / Background 路径

`runAsyncPath(data)` 在 `effectiveAsync` 为真时短路执行：

- 有 `tasks` → 用一个 implicit parallel-step 调 `executeAsyncChain`（`resultMode: "parallel"`）。
- 有 `chain` → 直接 `executeAsyncChain`。
- 有 `agent`（single）→ `executeAsyncSingle`。

始终依赖上游 jiti（`isAsyncAvailable()` 检查），缺失则返回明确错误。

### 1.7 管理动作（management actions）

`execute` 中按 `params.action` 分派：

| action | 处理 |
| ---- | ---- |
| `doctor` | 用 `buildDoctorReport` 输出诊断报告（含当前 sessionFile、orchestrator target、错误原因） |
| `status` | 支持 `view: "fleet" | "transcript"` 与 `id/runId` 精确查找；先看 foreground controls，再 fallback 到 `inspectSubagentStatus` |
| `resume` | `resumeAsyncRun`：先把目标 run 解析为 async/foreground/nested 三类之一；其中 nested 走 `resumeLiveNestedRun`（通过 nested control request）；foreground 走 `interruptLiveAsyncResumeTarget` + intercom deliverSubagentIntercomMessageEvent；async 走 `executeAsyncSingle`/`executeAsyncChain`，可选把目标作为 chain root（`attachRoot`） |
| `steer` | 分 nested/foreground/async：foreground 不支持（提示用 interrupt/resume）；async 调 `requestAsyncSteer`；nested 调 `steerNestedRun` |
| `interrupt` | 优先 foreground control 的 `interrupt()`；否则走 `interruptAsyncRun`；否则 `interruptNestedRun` |
| `stop` | 仅支持 async；调 `stopAsyncRun` |
| `append-step` | `appendStepToAsyncChain`：要求 `chain` 长度 = 1、当前 run 必须 running 且仍在 in-progress 步骤中；output name 不能与现有 / 已挂起的 append 冲突；最终 `enqueueChainAppendRequest` 写挂起请求到 async dir |
| `schedule*` | 委托给 `deps.handleScheduledRunAction` |

绝大多数 mutating 动作（`create/update/delete/eject/disable/enable/reset/watchdog.configure`）属于 `MUTATING_MANAGEMENT_ACTIONS`，当 `deps.allowMutatingManagementActions === false` 时会被拒（child-safe fanout 模式）。

### 1.8 嵌套 / Nested Run 处理

- `resolveInheritedNestedRouteFromEnv` + `resolveNestedParentAddressFromEnv` + `createNestedRoute(runId)`：从环境变量继承或新建嵌套路由。
- `writeNestedForegroundEvent`：在 started/completed 时把"父路径 / 深度 / child 摘要"写入 nested event 总线。
- 嵌套 resume / interrupt / steer 通过 `nested-events.ts` 中的 `writeNestedControlRequest` / `readNestedControlResults` 投递到 owner；失败时回落 `directNestedAsyncInterrupt` / `directNestedAsyncSteer`。
- `validateNestedSessionFile` 在嵌套 resume 时强制校验 session file 必须 `.jsonl`、必须 `realpath` 后落在 trusted nested session root 之下，且路径段里包含 run id。

### 1.9 Foreground Control 实时通知

- `createForegroundControlNotifier` + `emitControlNotification`：把 control event 通过 `SUBAGENT_CONTROL_EVENT`（event 通道）与 `SUBAGENT_CONTROL_INTERCOM_EVENT`（intercom 通道）广播；后者还需要桥接 active 且有 orchestrator target。
- `clearPendingForegroundControlNotices`：前台 run 结束（finally）时清空积压。
- `SUBAGENT_FOREGROUND_COMPLETE_EVENT`：在 detached exit 时通过 `updateRememberedForegroundChild` 发射"子项完成"事件（含 success/summary/exitCode/cwd/sessionFile/sessionId/taskIndex）。

### 1.10 结果与 intercom 回执

- `maybeBuildForegroundIntercomReceipt`：所有路径收敛后，若 intercom bridge 处于 active 且结果不是被中断或 detached，构造一份 `formatSubagentResultReceipt` 文本与剥掉输出体的 `stripDetailsOutputsForIntercomReceipt` details，并替换原 content。
- `emitForegroundResultIntercom`：把 children payload 通过 `deliverSubagentResultIntercomEvent` 投递回 orchestrator。

### 1.11 Fork context 与最终包封

`withForkContext(result, params.context)` 当 `context === "fork"` 时把 `details.context = "fork"`；否则不变。所有路径结尾都通过它把 fork 标记打到 details。

## 2. 主流程（`execute` → 路径分派）

```
executeWithSingleDispatchGuard(id, params, signal, onUpdate, ctx)
├── omitExecutionModeActionAlias(params)             // 兼容旧 action 字段
├── 如果 params.action 存在：
│     ├── watchdog.*                 → handleWatchdogToolAction
│     ├── doctor                     → buildDoctorReport
│     ├── status                     → inspectSubagentStatus / foregroundStatusResult
│     ├── resume                     → resumeAsyncRun
│     ├── steer                      → steerAsyncRun / steerNestedRun
│     ├── stop                       → stopAsyncRun
│     ├── interrupt                  → foreground.interrupt() / interruptAsyncRun / interruptNestedRun
│     ├── append-step                → appendStepToAsyncChain
│     ├── schedule*                  → deps.handleScheduledRunAction
│     ├── 其它管理动作（受 allowMutatingManagementActions 约束）
│
└── 否则（执行一次 run）：
      ├── state.baseCwd / foregroundRuns / foregroundControls 初始化
      ├── resolveRequestedCwd
      ├── omitExecutionModeActionAlias
      ├── checkSubagentDepth
      ├── normalizeRepeatedParallelCounts
      ├── applyForceTopLevelAsyncOverride (depth=0)
      ├── resolveToolBudget(effectiveParams.toolBudget)             → runToolBudget
      ├── resolveToolBudget(deps.config.toolBudget)                → configToolBudget
      ├── resolveExecutionAgentScope / discoverAgents(effectiveCwd)
      ├── applySingleAgentLaunchDefaults
      ├── resolveForegroundTimeout
      ├── resolveTurnBudgetConfig
      ├── resolveAgentDefaultContextPolicy                          → 可能改写 params.context
      ├── resolveIntercomBridge + applyIntercomBridgeToAgent(可选)
      ├── reserveSubagentSpawns                                     → session spawn 配额
      ├── createForkContextResolver                                 → 用于 fork session file
      ├── mkdir(sessionRoot)
      ├── preflightForkSessionsForStaticTasks                       → 串行预热 fork 路径
      ├── validateExecutionInput + validateExecutionChainBindings
      ├── 创建 foregroundControl                                     → 仅非 async
      ├── runAsyncPath(data, deps)                                  → 若 effectiveAsync，短路返回
      ├── writeNestedForegroundEvent("subagent.nested.started")
      ├── 三种模式分派：
      │     ├── hasChain  → runChainPath(execData, deps)
      │     ├── hasTasks  → runParallelPath(execData, deps)
      │     └── hasSingle → runSinglePath(execData, deps)
      ├── writeNestedForegroundEvent("subagent.nested.completed", result)
      └── finally: clearPendingForegroundControlNotices + delete foregroundControls

dispenseSingleSubagentGuard 保证并发调用只跑一次（state.subagentInProgress）
所有返回值用 withForkContext(...) 包裹 fork 信息
```

## 3. 三个执行路径（执行顺序与外部契约）

### 3.1 `runSinglePath`

1. `effectiveToolBudget` 解析。
2. clarify TUI（可选）：用户在交互界面上确认 task 文本、model、output、skills，并可选择"后台运行"。
3. 选择 runInBackground → 走 `executeAsyncSingle`。
4. 否则在 task 文本里注入 single-output 指令（`injectSingleOutputInstruction`）。
5. 用 `runSync(ctx.cwd, agents, agentName, task, opts)` 拉起子进程（见 [subagent-spawn-机制.md](./subagent-spawn-机制.md)）。
6. `recordRun` 写入 history；构造 `compactForegroundDetails`；`rememberForegroundRun`；intercom 回执；失败 / 中断 / detached 分支。

### 3.2 `runParallelPath`

1. worktree / duplicate-output / 任务数上限校验。
2. clarify TUI（可选）：允许逐个任务覆盖 output/model/skill，并"全部后台"或留在前台。
3. 创建 `WorktreeSetup`（若 `params.worktree`）→ 每个 task 一个 git worktree；最终 `cleanupWorktrees`（`finally`）。
4. `runForegroundParallelTasks`：
   - 先**串行**调用 `sessionFileForIndex(i)` 预热 fork session 文件。
   - `mapConcurrent(tasks, concurrencyLimit, async (task, i) => runSync(...))` 拉起所有子进程。
   - 通过 `globalSemaphore` 强制全局并发上限。
   - 每个 worker 都把进度写到 `liveResults[i]` 与 `liveProgress[i]`；`onUpdate` 把它们合并到顶层 progress。
5. 处理中断 / detached / 全部失败 / 部分成功分支；`aggregateParallelOutputs` 汇总。
6. worktree diff summary（`buildParallelWorktreeSuffix`）会附加到结果文本里。

### 3.3 `runChainPath`

1. `wrapChainTasksForFork(chain, contextPolicy)` 处理 fork 模板。
2. `executeChain(...)`：常规 chain 执行（含 sequential / parallel / dynamic-fanout）。
3. 如果 chain 内部产生 `requestedAsync`（runInBackground）→ 转 `executeAsyncChain`。
4. `attachRootChildrenToSteps` 把根 children 挂到 step results。
5. `maybeBuildForegroundIntercomReceipt` 投递回执，否则按原 details 返回。

## 4. Intercom 与 Bridge

| 角色 | 入口 |
| ---- | ---- |
| Orchestrator target（owner 侧） | `resolveIntercomSessionTarget(pi.getSessionName(), ctx.sessionManager.getSessionId())` |
| Child target | `resolveSubagentIntercomTarget(runId, agentName, idx)` |
| Bridge state | `resolveIntercomBridge({ config, context, orchestratorTarget })` |
| 应用 bridge | `applyIntercomBridgeToAgent(agent, bridgeState)`（覆盖 systemPrompt 等） |
| 投递 | `deliverSubagentIntercomMessageEvent` / `deliverSubagentResultIntercomEvent` |
| 接收方 | `INTERCOM_DETACH_REQUEST_EVENT` |

`createSubagentExecutor` 把这些与 `state.foregroundControls` / `IntercomEventBus` 等结合，让一次 subagent run 既能 detach（被 orchestrator 接管）也能异步 resume。

## 5. 失败处理与边界

- **执行失败**：`toExecutionErrorResult(params, error)` 统一包封 `isError: true` 结果，含 `details.mode`。
- **depth 越界**：`checkSubagentDepth` 直接报最大嵌套深度并提示用户自己完成。
- **配额越界**：`reserveSubagentSpawns` 返回结构化错误并写到 result。
- **action 非法**：提示 `valid: SUBAGENT_ACTIONS.join(", ")`。
- **mutating 权限**：`allowMutatingManagementActions === false` 时限制到非破坏性动作。
- **clarify 取消**：返回 `{ text: "Cancelled", details.mode, results: [] }`。
- **session dir 创建失败**：`fs.mkdirSync` 抛错会被 catch 并转换成 `toExecutionErrorResult`。
- **runSync 异常**：`execute` 顶层 `try/catch` 包住整个 chain/parallel/single 分派，并把 `writeNestedForegroundEvent("subagent.nested.completed", errorResult)` 一并发出。

## 6. 协作对象

| 模块 | 用途 |
| ---- | ---- |
| `runs/foreground/execution.ts:runSync` | 实际单进程拉起；持有进程级生命周期 |
| `runs/foreground/chain-execution.ts:executeChain` | chain 模式执行 |
| `runs/foreground/chain-clarify.ts:ChainClarifyComponent` | clarify TUI |
| `runs/background/async-execution.ts` | async single / chain 后台跑 |
| `runs/background/control-channel.ts` | interrupt / stop / steer IPC |
| `runs/background/chain-append.ts` | append-step 队列 |
| `runs/background/run-id-resolver.ts` | 三类 run 解析（foreground/async/nested） |
| `intercom/intercom-bridge.ts` | bridge state 管理 |
| `intercom/result-intercom.ts` | 结果回执与 payload |
| `agents/skills.ts` / `agents/agents.ts` / `agents/agent-scope.ts` / `agents/agent-management.ts` | agent 注册与解析 |
| `shared/types.ts` / `shared/settings.ts` / `shared/utils.ts` / `shared/parallel-utils.ts` | 类型 / 行为 / 并发工具 |
| `shared/turn-budget.ts` / `shared/tool-budget.ts` / `shared/acceptance.ts` / `shared/single-output.ts` | 预算、接受判定、输出处理 |
| `shared/fork-context.ts` / `shared/session-identity.ts` / `shared/nested-events.ts` / `shared/nested-render.ts` | fork、嵌套事件、嵌套投影 |
| `shared/worktree.ts` | 并行 worktree 生命周期 |
| `watchdog/tool-actions.ts` / `extension/doctor.ts` / `extension/control-notices.ts` | watchdog、doctor、通知清理 |

## 7. 一句话总结

`createSubagentExecutor` 把"调用 subagent tool"这一动作变成一个**自适应执行器**：先识别 action（管理操作 vs. 启动 run），再根据 `agent / tasks / chain` 与 `clarify / async / worktree / context` 等开关进入 single/parallel/chain 三条主路径之一，或在 `effectiveAsync` 下转后台；全程用 `foregroundControls`、`state.subagentSpawns`、`IntercomBridge`、`nestedRoute`、`forkContextResolver` 这些共享控制对象保持状态一致；任何异常都被 `toExecutionErrorResult` / `withForkContext` / `writeNestedForegroundEvent` 兜底，确保外层 LLM 永远拿到结构一致的 `AgentToolResult<Details>`。

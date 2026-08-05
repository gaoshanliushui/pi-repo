# Subagent 生成、调度与通信：难点与解法

本文档基于 `pi-subagents` 源码，分析子代理系统在"生成"、"调度"、"子代理之间通信"、"子代理与主代理通信"四个维度上的工程难点，以及当前实现给出的解法。

## 0. 一句话鸟瞰

**子代理是另一个 Pi 进程。** 它不是 in-process 协程，而是一个独立的 OS 进程，通过 JSONL 流与宿主对话，通过文件目录（control inbox / result / chain-append）异步通信，通过 intercom bridge 共享上下文通道。这一定位决定了几乎所有"难点"都源自"跨进程 + 异步 + 缺乏共享内存"。

## 1. 子代理的生成

### 1.1 难点：进程模型与 I/O

`runs/foreground/execution.ts:309` 的 `spawn(spec.command, spec.args, {...})` 只是表象，真正难的是让一个子进程以受控的方式"对宿主可用"——既要看到 stdout/stderr 让宿主能解析事件，又要可被中断可被硬杀，还要在 Windows 上不弹黑色窗口。

### 1.2 解法

```ts
const proc = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: options.cwd ?? runtimeCwd,
    env: spawnEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
});
```

- **stdio = `["ignore", "pipe", "pipe"]`**：stdin 被屏蔽（子进程无须读交互输入），stdout 由 `createJsonlWriter` 实时落盘，stderr 被 `createBoundedByteTail` 截断到 `MAX_CHILD_STDERR_BYTES`。
- **命令装配三级降级**（`runs/shared/pi-spawn.ts`）：
  1. `PI_SUBAGENT_PI_BINARY_ENV`（Nix/容器二进制覆写）；
  2. `resolvePiCliScript`（向上找 `package.json#bin.pi` + shebang 校验，复用 `process.execPath` 跑源码/已构建脚本）；
  3. fallback `{ command: "pi", args }`。
- **环境注入**：`spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(maxSubagentDepth) }`。`PI_SUBAGENT_DEPTH` 阻止代理自我递归无限嵌套。
- **Post-exit stdio guard**（`shared/post-exit-stdio-guard.ts`）：子进程 `close` 之后 `proc.stdout/stderr` 仍可能短暂收到管道缓冲数据；guard 通过 `unref` 流 + `onStdioAfterExit` 钩子兜底。

详细的退出收敛路径（normal / intercom detach / SIGTERM / SIGKILL）见 [subagent-spawn-机制.md](./subagent-spawn-机制.md)。

### 1.3 余下难点：找不到 pi 二进制

容器化、PATH 缺失、跨用户运行都可能导致 `command: "pi"` 找不到。`pi-spawn.ts` 的三级降级覆盖了大部分场景，但对"用户把全局 pi 装到 nvm/pnpm 私有路径、又改了 PATH"这种边缘情况没有保护——属于已知权衡，靠文档说明。

## 2. 子代理的调度

调度包括三件事：**谁来跑、并发多少、何时打住**。

### 2.1 难点 A：三种 run 模式 + async 切换

单一入口要被四种执行形态分流：

| 模式 | 入参特征 | 行为 |
| ---- | ---- | ---- |
| single | `agent + task` | 拉起一个子进程 |
| parallel | `tasks[]` | 拉起 N 个并发子进程 |
| chain | `chain[]`（sequential / parallel / dynamic-fanout） | 多步组合，每步再分发 |
| async | 任一上述模式 + `params.async === true` 或 `forceTopLevelAsync` | 拆给后台 runner |

外加 forward-only 操作：`status / steer / interrupt / stop / resume / append-step / doctor / schedule* / watchdog.*`。

### 2.2 解法：单一 executor + 类型化分发

`runs/foreground/subagent-executor.ts:createSubagentExecutor` 暴露两个函数：

1. `execute`：先分派 action；若不是管理动作则走"run 路径"——同步模式走 `runSinglePath / runParallelPath / runChainPath`，async 模式走 `runAsyncPath` 返回 `executeAsyncSingle / executeAsyncChain`。
2. `executeWithSingleDispatchGuard`：在 execute 外裹一层 `state.subagentInProgress` 标志，避免一 turn 内多次 subagent 工具调用冲突。

关键校验与配额（`subagent-executor.ts`）：
- `validateExecutionInput`：三种 run 模式**必须恰好一种**被传入。
- `validateExecutionAcceptance` / `validateExecutionChainBindings`：接受条件与 chain output binding 合法性。
- `countRequestedSubagentSpawns` + `reserveSubagentSpawns`：`maxSubagentSpawnsPerSession` session 级配额。
- `checkSubagentDepth`：`PI_SUBAGENT_DEPTH` 嵌套上限。
- `applyForceTopLevelAsyncOverride`：depth=0 时强制后台跑（防止顶层"裸跑前台独占 LLM"）。
- `applySingleAgentLaunchDefaults`：agent 配置中的 `defaultAsync / defaultTimeoutMs / defaultTurnBudget / defaultAcceptance` 在用户没显式给值时注入。

### 2.3 难点 B：并发上限与全局并发

`parallel` 模式下，并发度有两个口径：

- 任务内并行：`params.concurrency ?? config.parallel.concurrency`（`resolveTopLevelParallelConcurrency`）；
- 全局并行：`config.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT`（`shared/parallel-utils.ts:Semaphore`）。

### 2.4 解法

`runs/foreground/subagent-executor.ts` 中 `runParallelPath` 调用 `runForegroundParallelTasks`，后者用：

```ts
return mapConcurrent(tasks, input.concurrencyLimit, async (task, index) => {
    ...
    return runSync(...);
}, input.globalSemaphore);
```

`mapConcurrent` = 任务级并发池，全局 `Semaphore(new Semaphore(limit))` 限制机器上同时跑多少个 pi 进程。`runForegroundParallelTasks` 顶部还有一段**关键预热**：

```ts
for (let i = 0; i < input.tasks.length; i++) {
    input.sessionFileForIndex(i);   // 串行触发 fork session 分支
}
```

避免 `mapConcurrent` 的多个 worker 同时 fork 同一父会话文件造成竞态。

### 2.5 难点 C：fork 子会话 vs 全新会话

LLM 期望"子代理能继承当前对话上下文"，但跨进程意味着无法共享内存。需要：

- 选择继承粒度：fresh / fork（`params.context`）；
- 解析父会话文件所在位置；
- 在子进程中触发 fork。

### 2.6 解法

`shared/fork-context.ts:createForkContextResolver(ctx.sessionManager, "fork" | undefined)` 返回 `sessionFileForIndex(idx)` / `thinkingOverrideForIndex(idx)`。`wrapForkTask(task ?? "{previous}")` 把 chain 里的 `{previous}`、`{task}` 替换为 fork 模板。`preflightForkSessionsForStaticTasks` 在执行路径确定后立刻串行预热所需的 fork 文件，避免下游并发竞态。

### 2.7 难点 D：超时 / turn budget / tool budget

子代理运行可能无限挂起；用户希望"30 分钟后必须停"，也希望"这个工具只能用 N 次"。

### 2.8 解法

- **整体超时**：`resolveForegroundTimeout` 校验 `timeoutMs` / `maxRuntimeMs`，用 `Date.now() + timeoutMs` 产生 `deadlineAt`。
- **turn 预算**：`shared/turn-budget.ts:resolveTurnBudgetConfig` 校验；`subagent-prompt-runtime.ts` 在子进程内注入 turn budget system prompt。
- **tool 预算**：`shared/tool-budget.ts:validateToolBudgetConfig` + `resolveEffectiveToolBudget` 三级合并（task-level → run-level → agent-level → config-level）。
- **子进程退出收敛**：`runs/foreground/execution.ts` 的"五条完成路径"——正常退出 / intercom detach / SIGTERM / SIGKILL / 1s 优雅 drain 窗口（`FINAL_STOP_GRACE_MS = 1000`）。

### 2.9 难点 E：子代理状态对外可观测

子进程在跑，主线程怎么知道"现在到哪一步了"？

### 2.10 解法

`SubagentState.foregroundControls`（`shared/types.ts:877` 起的接口）保存 `runId / mode / startedAt / updatedAt / currentAgent / currentIndex / currentActivityState / currentTool / tokens / toolCount / interrupt?`。`runs/foreground/execution.ts` 中 `runSync` 通过 `onUpdate` 回调实时更新这些字段。`foregroundStatusResult` 把 control 投影为可读的状态文本。

## 3. 子代理与主代理通信

### 3.1 难点：跨进程 + LLM 不可直连

主子通讯有两种完全不同的形态：

- **结果回报**：子进程完成 → 主代理看到结果（一次性）。
- **中途干预**：子进程跑到一半，主代理发现"该停 / 该改 / 该问"（交互式）。

前端跨进程信道的传统方案（Unix socket / shared memory / RPC over stdin）在 Windows 上不稳，又难嵌入 LLM 工具语义。

### 3.2 解法 A：结果回报 → 文件 + coalescer

子进程的 stdout 写 JSONL 事件，主进程通过 `shared/jsonl-writer.ts:createJsonlWriter` 落盘到 `shared.jsonlPath`。完成后子进程写 `result.json`，主进程用 `shared/file-coalescer.ts` 的 `resultFileCoalescer.schedule(...)` 节流读取——多 run 同时完成时合并读。

### 3.3 解法 B：中途控制 → Portable 文件 inbox（关键）

`runs/background/control-channel.ts` 是这个系统的"通信心脏"。它的注释直接挑明核心难题：

> Background runs are detached OS processes. The original control path delivered an interrupt with `process.kill(pid, SIGUSR2|SIGBREAK)`, but Windows cannot deliver those signals cross-process via `process.kill` and throws `ENOSYS`, which left async runs uninterruptible (no stop, no live steer) on Windows.

**解法**：跨 OS 统一用**文件 inbox**。

```
<asyncDir>/control/
├── interrupt.json              # 主代理 → 子进程：暂停
├── timeout.json                # 主代理 → 子进程：超时
├── stop.json                   # 主代理 → 子进程：硬停
├── steer-requests/             # 通用 steer
│   └── <ts>-<uuid>.json
└── steer-targets/<index>/      # 定向到某个子步骤
    └── <ts>-<uuid>.json
```

主代理通过 `requestAsyncInterrupt / requestAsyncStop / requestAsyncSteer / requestAsyncTimeout` 写入。子进程内部有 `pollControlInbox` 周期性扫描（`POLL_INTERVAL_MS`），找到请求就路由进 `interruptRunner()`、`deliverStopRequest` 等。`writeAtomicJson` 用 temp + rename 保证写入原子性，避免读到半截。

OS 信号只保留为"快速通道"：`INTERRUPT_SIGNAL = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2"`。Windows 上失败会被 catch，不影响主路径——文件 inbox 是权威信源。

### 3.4 解法 C：Intercom Bridge（语言级通道）

子代理本身也是 LLM，让它能"主动联系主代理问问题"是另一个层面的难点。`intercom/intercom-bridge.ts` 通过 systemPrompt 注入一段 `INTERCOM_BRIDGE_MARKER` 标识的指令模板：

```
The inherited thread is reference-only. Do not continue that conversation...
Use contact_supervisor first. It resolves the supervisor session "{orchestratorTarget}"...
- Need a decision, blocked, approval, ...: contact_supervisor({ reason: "need_decision", message: ... })
- After contact_supervisor with reason "need_decision" ... stay alive and continue only after reply arrives ...
```

`applyIntercomBridgeToAgent` 把 `intercom` 与 `contact_supervisor` 两个 tool 注入 agent，并**确保不重复注入已有 tool**。`resolveIntercomBridge` 根据 mode（`off / always / fork-only`）和 context 决定是否激活：`fork-only` 模式下，只有 fork 出去的子代理才允许与主代理对话——fresh 子进程保持隔离，避免每次 subagent 都来打断主代理。

`intercom/native-supervisor-channel.ts` 是真正"把子代理说出口的话投递给主代理"的插件，挂在 `native:pi-subagents-supervisor-channel` 虚拟扩展路径下。

### 3.5 解法 D：结果回执聚合（多 run 同回）

当一次 chain 有多个子代理完成时，主代理只会收到一次"结果"事件。`intercom/result-intercom.ts` 把子代理的 status / summary / artifact / sessionPath / intercomTarget 聚合成 `SubagentResultIntercomPayload`，通过 `deliverSubagentResultIntercomEvent` 投递。`maybeBuildForegroundIntercomReceipt` 在前台 run 结束时把这个回执拼成" `=== Task i: agent ===`"的可读文本。

## 4. 子代理之间的通信

### 4.1 难点

子代理之间大多并不直接通信——它们以**链式**或**并行**方式工作，由宿主充当中介。但 chain 模式下后一步需要前一步的输出，dynamic-fanout 下需要把"上一步的结构化命名输出"展开成 N 个 task，嵌套 chain 还需要把整个内层 chain 的 children 挂回外层的 step。

### 4.2 解法 A：chain 内的 named output binding

`shared/settings.ts:buildChainInstructions`、`shared/chain-outputs.ts:validateChainOutputBindingsWithContext` 实现：

- 上一步把命名的结构化输出写入 `chain.outputName` 块；
- 下一步在 task 文本里用 `{previous}` 或 `{step.<i>.task.<name>}` 引用；
- dynamic fanout 把 `{previous}` 的列表展开成 N 个并发任务，由 `config.chain?.dynamicFanout?.maxItems` 限幅。

`runs/foreground/chain-execution.ts:executeChain` 是编排器，依次调度 steps、同步回收 `SingleResult[]`，并把 results 注入下一步的上下文。

### 4.2 解法 B：fork context 让子代理共享祖先上下文

`shared/fork-context.ts:createForkContextResolver` 决定哪些子代理要 fork 父会话、哪些用 fresh。`subagent-executor.ts` 的 `preflightForkSessionsForStaticTasks` + `wrapChainTasksForFork` 在执行路径确定后就**预先创建** fork 出的 session 文件位置——再由后续的 `wrapForkTask` 把 task 文本改为"先读父会话上下文再回答"的形态。

### 4.3 解法 C：嵌套 chain / nested runs

`shared/nested-events.ts`、`shared/nested-render.ts` 提供跨链事件总线：

- 子代理内部的 chain 通过 `inheritedNestedRoute` + `resolveNestedParentAddressFromEnv` 知道"我是被什么 run 调起的"。
- `writeNestedForegroundEvent("subagent.nested.started" / ".completed", result)` 把"父 run id / step index / depth / 子项摘要"写进总线的 JSON 文件。
- `resolveNestedResumeTarget` + `validateNestedSessionFile` 在跨时间 resume nested run 时，**严格校验** session file 落在 trusted nested session root 之下，且路径里包含 run id——避免外部输入的恶意路径注入。

### 4.4 解法 D：bridge 上"子代理问主代理"

如果 chain 中某一步需要中途决策，bridge 模板注入的 `contact_supervisor` 让子代理作为 LLM 直接发起问询。`contact_supervisor({ reason: "need_decision" })` 与 `intercom({ action: "ask", to: ... })` 是两条不同粒度的接口——前者更结构化（"我被阻塞了 / 我要审批 / 我要访谈"），后者只是底层 fallback。

## 5. 其它系统性挑战

### 5.1 进程崩溃 / stale run

`runs/background/stale-run-reconciler.ts:reconcileAsyncRun(asyncDir, { kill })` 检测"async dir 还在但 pid 没了 / session 卡住"的 stale run，决定是否清理或 attach。

### 5.2 任务取消与超时一致性

`execution.ts` 的"五条完成路径"保证子进程任一退出路径都写齐 `result.*` 字段；`complete-batch / completion-dedupe` 防重复投递完成事件。

### 5.3 命名唯一性

`resolveSubagentIntercomTarget(runId, agent, index)` 把代理、runId、index 三元组标准化为 `subagent-<agent>-<runId>-<i+1>`。`getOrCreateRunId` 通过 `createHash("sha256")` 提供跨进程稳定的 run id。

### 5.4 run history 与可追溯

`shared/run-history.ts:recordRun(agent, task, exitCode, durationMs)` 把每个执行的成功/失败/耗时记入 history；`runs/background/run-status.ts:inspectSubagentStatus` 把它与当前会话的 active run 一起呈现。

### 5.5 同一 turn 多次 subagent

`subagentInProgress` 布尔守卫（`subagent-executor.ts:executeWithSingleDispatchGuard`）在 execute 期间拒掉并发 subagent 工具调用——避免 LLM 一次输出两个 subagent tool 造成状态串扰。

## 6. 通信拓扑图

```
                                  （文件 inbox，cross-OS 权威）
       ┌─────────────────────────────────────────────────────────────────────┐
       │                                                                     │
       ▼                                                                     │
   ┌───────────┐    spawn()    ┌────────────────┐    spawn()    ┌───────────┐
   │ 主 Pi     ├──────────────►│ 子代理 Pi 进程  ├──────────────►│ 子子代理  │
   │ (host)    │               │ (foreground)    │               │ (nested)  │
   └─────┬─────┘               └────────┬────────┘               └─────┬─────┘
         │                             │                              │
         │ 1) stdout: JSONL 流         │                              │
         │    → createJsonlWriter      │                              │
         │                             │                              │
         │ 2) intercom bridge:         │                              │
         │    contact_supervisor ◄─────┼── LLM-driven 询问 ──────────┤
         │    (via SYSTEM prompt +     │                              │
         │     native-supervisor ext)  │                              │
         │                             │                              │
         │ 3) result file:             │                              │
         │    <run-dir>/result.json ◄──┤── 写完聚合 ──────────────────┤
         │                             │                              │
         │ 4) control inbox:           │                              │
         │    <run-dir>/control/       │                              │
         │    └ interrupt.json ───────►│ 轮询 (POLL_INTERVAL_MS)      │
         │    └ stop.json ────────────►│                              │
         │    └ steer-requests/*.json ►│                              │
         │                             │                              │
         │ 5) nested events bus:       │                              │
         │    <project>/nested/.../*.jsonL ◄─── 父子共用 ──────────────┘
         │                             
       │ 6) chain output bindings:
       │    下一步用 {previous} / {step.<i>.<name>}
```

## 7. 余下尚未完全解决的边界

- **Long-running active detection**：`runs/shared/long-running-guard.ts` 在 watch dog 里识别"看似静默但实际在跑"的子代理（容器构建等），把它标记为 `active_long_running` 而不是 idle。这是启发式，会误判。
- **跨平台信号**：Windows 上 `SIGUSR2` 仍走 catch fallback，文件 inbox 才是真正路径。
- **bridge 模板的注入安全**：用户提供的 `instructionFile` 读入 systemPrompt，未经清洗，但 prompt 注入本身就是 LLM 已知攻击面；当前靠"模板用 `INTERCOM_BRIDGE_MARKER` 标注"避免重复注入。
- **dynamic fanout 上限**：默认 `config.chain?.dynamicFanout?.maxItems` 可能被用户调大，存在被恶意输入炸出上千个子进程的风险——目前没有 rate-limit，依赖用户配置。

## 8. 相关文档

- [subagent-spawn-机制.md](./subagent-spawn-机制.md) — 进程拉起细节
- [subagent-executor.md](./subagent-executor.md) — executor 架构与流程
- `intercom/native-supervisor-channel.ts` — supervisor channel 扩展
- `runs/background/control-channel.ts` — 控制通道（已含 Windows 信号问题注释）
- `shared/fork-context.ts` — fork session 解析
- `shared/nested-events.ts` — 嵌套事件总线

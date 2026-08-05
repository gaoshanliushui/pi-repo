# Subagent Spawn 机制详解

本文档分析 `pi-subagents` 在前台启动一次 subagent 任务时，如何在 `src/runs/foreground/execution.ts:309` 用 `node:child_process.spawn` 拉起一个 pi 主 CLI 子进程，并把它的整个生命周期收敛到一个 Promise 上。

核心代码：

```ts
const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
let observedMutationAttempt = false;

const exitCode = await new Promise<number>((resolve) => {
    const spawnSpec = getPiSpawnCommand(args);
    const proc = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: options.cwd ?? runtimeCwd,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    // ... 状态机、计时器、监听器 ...
});
```

下文按六个层面展开：命令装配 → `spawn` 调用本身 → 内层状态机 → 三条完成路径 → 中止与中断接线 → 收尾。

## 1. spawn 命令装配（`getPiSpawnCommand`）

`runs/shared/pi-spawn.ts:134` 的 `getPiSpawnCommand(args, deps?)` 按优先级返回一个 `{ command, args }` 二元组：

1. **环境变量覆盖**。若 `PI_SUBAGENT_PI_BINARY_ENV` 设了非空值，直接当成可执行路径——便于 Nix/Guix store、容器、自定义构建里注入固定二进制。
2. **解析本地 CLI 脚本**。`resolvePiCliScript` 向上查找包含 `package.json#bin.pi` 的目录；再用 `isRunnableNodeScript` 校验：首行必须形如 `#!/usr/bin/env node`（或同类 shebang）+ 文件存在。命中时返回：
   ```ts
   { command: process.execPath, args: [piCliPath, ...args] }
   ```
   也就是**复用当前 node 进程**直接跑 TS/JS 入口，省去 `PATH` 解析。
3. **回退 `pi`**。以上都不中则 `{ command: "pi", args }`，交操作系统 `PATH` 解析。

这条策略统一了开发态（跑源码）、发布态（跑打包二进制）、测试态（复用 node）三个场景，所有路径最终都被同一个 `spawn` 出口消费。

## 2. `spawn()` 调用本身

```ts
const proc = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: options.cwd ?? runtimeCwd,
    env: spawnEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
});
```

逐字段含义：

- `cwd`：优先使用调度时绑定的 `options.cwd`（代理目标工作目录），否则用 `runtimeCwd`（宿主 pi 所在目录）。两者都没有则沿用父进程 cwd——`spawn` 默认继承。
- `env`：`{ ...process.env, ...sharedEnv, ...getSubagentDepthEnv(maxSubagentDepth) }`。即父进程环境作底，叠加代理特化的键（凭据路径、`PI_*` 系列）和 `PI_SUBAGENT_DEPTH`（递归深度环境变量，阻止代理自我递归时无限嵌套）。
- `stdio: ["ignore", "pipe", "pipe"]`：
  - **stdin = `ignore`**——子代理不需要从父进程读交互输入，所有交互通过 RPC over 控制通道完成。
  - **stdout = `pipe`**——`createJsonlWriter(shared.jsonlPath, proc.stdout)` 实时把 JSONL 事件落盘，同时被 `createBoundedLineReader` 解析。
  - **stderr = `pipe`**——通过 `createBoundedByteTail` 截取至 `MAX_CHILD_STDERR_BYTES`（约 64 KiB），避免 UI 横幅污染持久化日志。
- `windowsHide: true`：Windows 下不弹出黑色控制台窗口，常驻进程友好。

`spawn` 同步返回 `ChildProcess`。所有后续子进程状态、`stdout/stderr`、`kill()` 信号全部挂在这个对象上。

## 3. 内层状态机

Promise 体内立刻声明一组状态字段，构成"完成条件"的核心：

| 字段 | 含义 |
| ---- | ---- |
| `processClosed` | 进程退出（不论成功与否），由 `proc.on("close", ...)` 触发 |
| `settled` | Promise 已 `resolve` 一次，防止双重 `finish` |
| `detached` | 进入 intercom 协调模式，子进程被解除托管 |
| `intercomStarted` | 已收到首个 intercom 事件 |
| `assistantError` | 解析到的最后一条 assistant 终止错误 |

围绕这五个标志位，再加若干定时器：

- `activityTimer`：基于 `lastActivityAt` 检测心跳停止。
- `timeoutTimer` / `timeoutTerminationTimer` / `timeoutHardKillTimer`：attempt 整体超时阶梯。
- `turnBudgetTerminationTimer` / `turnBudgetHardKillTimer`：turn 预算阶梯。
- `protocolHardKillTimer`：协议级硬杀兜底。
- `finalDrainTimer` / `finalHardKillTimer` / `watchdogTailTimer`：收尾阶段的 1 s 优雅退出窗口（`FINAL_STOP_GRACE_MS = 1000`），超时 `SIGTERM`，再过 `HARD_KILL_MS = 3000` 仍未退出则 `SIGKILL`。

每个 timer 都 `timer.unref?.()`，不会单独挂住 Node 事件循环。

### 3.1 子进程收尾协议

```ts
const FINAL_STOP_GRACE_MS = 1000;
const HARD_KILL_MS = 3000;
```

子代理发出最终的 assistant `stop` 但迟迟不退时，主流程保护性地不直接 SIGTERM，而是：

1. `startFinalDrain()` 启动 1 s 计时；
2. 若 watchdog 仍然 active (`childWatchdogIsActive`)，转走 `armWatchdogTail()`（默认 120 s 静默预算），这段时间可以补救协议层；
3. 否则在 timer 到期发 `SIGTERM`；3 s 后仍存活再 `SIGKILL`。

## 4. 三条"完成路径"

Promise 只能 `resolve` 一次，`finish(code)` 入口幂等。

### 4.1 正常退出

```ts
proc.on("close", code => finish(code));
```

exit code 直接汇报；stdout 关闭时 JSONL writer 自然 `flush + end`。

### 4.2 intercom 拆离

```ts
options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
    if (!options.allowIntercomDetach || detached || processClosed) return;
    // ... 校验 runId / agent / childIndex 路由 ...
    options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true, ... });
    detachForIntercom();
});
```

命中拆离请求时调用 `detachForIntercom()`：

- `result.detached = true`、`result.detachedReason = "intercom coordination"`；
- `progress.status = "detached"`、`progress.durationMs = Date.now() - startTime`；
- `finish(-2)` 用哨兵退出码区分此分支。

### 4.3 超时 / 中止 / 硬杀

分别在对应定时器中调用 `trySignalChild(proc, "SIGTERM")` 与 `trySignalChild(proc, "SIGKILL")`，用 `forcedTerminationSignal` 标记，并向 `result.error` 写入失败原因。

### 4.4 `trySignalChild` 与 Post-Exit Stdio Guard

`attachPostExitStdioGuard(proc, { onStdioAfterExit, ... })` 解决 Node 的一个特性：**子进程退出后，`proc.stdout`/`proc.stderr` 仍可能短暂收到数据**（管道缓冲、tail -f 行为）。Guard 在 `close` 事件之后挂一个清屏：尝试 `unref` 流 → 若进程引用为 0 则消费剩余字节，否则登记一个 listener 在收到 `data` 时调用 `onStdioAfterExit`。

`trySignalChild` 跨平台发出 `SIGTERM`/`SIGKILL`，Windows 下行为由 Node 内部模拟（仍走 `proc.kill`）。

### 4.5 stderr 字节上限

`createBoundedByteTail` 在 `MAX_CHILD_STDERR_BYTES` 处截断。子代理把 stderr 当诊断/进度通道，容器日志可能塞噪声，tail-only 比全量落盘更稳健。

## 5. 子代理活动的判定

子代理从 stdout 写 JSONL（自定义协议），主进程用 `createBoundedLineReader` 解析。每收到一条事件：

1. `projectChildLifecycle(event)` 投影成 `ChildLifecycleAction = "cancel-drain" | "start-drain"`，决定是清掉还是启动"收尾保护定时器"。
2. 若事件是 assistant 的终止 stop（带 stop reason）但还没退出：
   - 若 `cleanTerminalAssistantStopReceived && agentSettledReceived` 为真——直接 `startFinalDrain()`，给子代理 1 s 自然结束。
   - 否则进入 `armWatchdogTail()`，使用 `childWatchdog?.watchdogTailTimeoutMs`（默认 120 s）作为静默超时，超时即把 watchdog 状态转为 `phase: "stale"`，`fireUpdate()` 上报后再 `startFinalDrain()`。

子代理的 `finalOutput` / 结构化输出（`readStructuredOutput`）和单输出快照（`captureSingleOutputSnapshot`）在 stdout 旁路被并发处理。

## 6. 中止与中断接线

```ts
let removeAbortListener: (() => void) | undefined;
let removeInterruptListener: (() => void) | undefined;
```

通过 `AbortSignal`（`options.abortSignal`）与外部中断信号（`process.on("SIGINT", ...)`）桥接到子代理：

- **AbortSignal 触发** → 立即发 `SIGTERM`，同时 `clearTimeoutTimers()` + `clearTurnBudgetTimers()` 防止误判超时。
- **SIGINT** → 标记 `interrupted = true`，给子代理一次"清场后退出"的机会，否则同上硬杀。
- **解除监听**调用 `removeAbortListener()` / `removeInterruptListener()`，避免 listener 泄漏。

## 7. 收尾：`finish(code)` 与进度汇报

`finish(code)` 步骤：

1. `settled = true` 防重入。
2. 清掉所有定时器（`clearFinalDrainTimers`、`clearWatchdogTailTimer`、`clearStdioGuard`、`clearTimeoutTimers`、`clearTurnBudgetTimers`、`protocolHardKillTimer`）。
3. 解绑并 close stdout/stderr 流，触发 JSONL writer 的 `flush + end`。
4. 写入 `result.exitCode`、`result.timedOut`、`result.interrupted`、`result.detached`、`result.error`、`result.finalOutput`。
5. 累加 `progress.tokens` / `progress.toolCount` / `progress.durationMs`，把 `progress.status` 置为 `succeeded | failed | detached`。
6. `fireUpdate()` 把进度推给观察者，`resolve(code)` 退出 Promise。

调用方拿到 `exitCode` 后会做：

- 通过 `evaluateAcceptance` 跑接受判定。
- 通过 `evaluateCompletionMutationGuard` 检查变更越界。
- 把当前 attempt 的 `recentOutput` 累计进 `shared`，供下一次循环借鉴。

## 8. 协作对象一览

| 文件 / 导出 | 职责 |
| ---- | ---- |
| `runs/shared/pi-spawn.ts:getPiSpawnCommand` | 命令装配（环境变量 → 本地脚本 → `pi`） |
| `runs/shared/pi-spawn.ts:resolvePiCliScript` | `package.json#bin.pi` + shebang 校验 |
| `shared/jsonl-writer.ts:createJsonlWriter` | 把 stdout 流式落盘 |
| `shared/post-exit-stdio-guard.ts` | 退出后清流、`trySignalChild` |
| `shared/child-protocol.ts` | `createBoundedLineReader`、`createBoundedByteTail`、`projectChildLifecycle` |
| `shared/turn-budget.ts` | turn 预算阶梯计算 |
| `shared/acceptance.ts` | `evaluateAcceptance` 接受判定 |
| `shared/completion-guard.ts` | `evaluateCompletionMutationGuard` 变更越界检查 |
| `watchdog/settings.ts:resolveWatchdogConfig` | 子代理 watchdog 配置 |

## 9. 一句话总结

`spawn` 这一行表面只是"拉起一个 pi 子进程"，但通过 `stdio: ["ignore","pipe","pipe"]` + 五个核心状态标志位 + 多组 timer，**把子代理的正常退出 / intercom 拆离 / 中止信号 / 超时阶梯 / 静默 watchdog / 优雅 drain / 硬杀兜底全部收敛到一个 Promise 上**——是 orchestrator 容错能力的关键支点。

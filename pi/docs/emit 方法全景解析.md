# Pi 源码中 `emit` 方法全景解析

> 基于源码（`packages/coding-agent/src/core/extensions/runner.ts`、`packages/agent/src/harness/agent-harness.ts`、`packages/coding-agent/src/core/agent-session-runtime.ts`、`packages/coding-agent/src/core/agent-session.ts`、`packages/coding-agent/src/core/event-bus.ts`、`packages/coding-agent/src/core/package-manager.ts`、`packages/tui/src/stdin-buffer.ts`）整理。
>
> 目标：理清 "一大群 `emit*()` 方法" 各自的职责、执行流程、相互关系，帮助后续维护者快速定位扩展/会话/订阅相关的代码。

---

## 1. 为什么会有这么多 `emit`

Pi 的事件体系分两层：

1. **扩展事件（ExtensionEvent）**：ExtensionRunner 暴露给上层 runtime/agent 调用的钩子（`before_agent_start` / `message_end` / `tool_call` / …）。每个事件都对应一个 `emitXxx()` 方法，签名各异：有的修改消息，有的阻塞工具调用，有的取消会话切换。
2. **进程内事件（AgentSessionEvent / AgentHarnessEvent）**：TUI、CLI 命令、UI 组件订阅的 "我在执行什么 / 队列怎么变" 这类通知。两层都共用 "emit 名字"，但实现分散在三个核心类里：

| 类别 | 主要文件 | 典型方法 |
| --- | --- | --- |
| 扩展事件分发 | `runner.ts`（`ExtensionRunner`） | `emit`、`emitMessageEnd`、`emitToolResult`、`emitToolCall`、`emitUserBash`、`emitContext`、`emitBeforeProviderRequest`、`emitBeforeProviderHeaders`、`emitBeforeAgentStart`、`emitResourcesDiscover`、`emitInput`、`emitError` |
| Agent 钩子 | `agent-harness.ts`（`AgentHarness`） | `emitOwn`、`emitAny`、`emitHook`、`emitBeforeProviderRequest`、`emitBeforeProviderPayload`、`emitQueueUpdate`、`emitRunFailure` |
| 业务态事件 | `agent-session-runtime.ts`、`agent-session.ts` | `emitBeforeSwitch`、`emitBeforeFork`、`_emit`、`_emitQueueUpdate`、`_emitAgentSettled`、`_emitExtensionEvent` |
| 通用 / 工具 | `event-bus.ts`、`package-manager.ts`、`stdin-buffer.ts` | `EventBus.emit`、`emitProgress`、`emitDataSequence` |

下面按 "代码量从大到小" 依次拆解。

---

## 2. `ExtensionRunner.emit` —— 通用扩展事件入口

位置：`packages/coding-agent/src/core/extensions/runner.ts:755-787`

```ts
async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
    const ctx = this.createContext();
    let result: SessionBeforeEventResult | undefined;

    for (const ext of this.extensions) {
        const handlers = ext.handlers.get(event.type);
        if (!handlers || handlers.length === 0) continue;

        for (const handler of handlers) {
            try {
                const handlerResult = await handler(event, ctx);

                if (this.isSessionBeforeEvent(event) && handlerResult) {
                    result = handlerResult as SessionBeforeEventResult;
                    if (result.cancel) {
                        return result as RunnerEmitResult<TEvent>;
                    }
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : undefined;
                this.emitError({
                    extensionPath: ext.path,
                    event: event.type,
                    error: message,
                    stack,
                });
            }
        }
    }

    return result as RunnerEmitResult<TEvent>;
}
```

### 2.1 作用

`emit` 是扩展事件分发的 "**通用兜底**"，承载那些没有专属 `emitXxx()` 方法的事件——也就是 `RunnerEmitEvent` 类型（`runner.ts:123-136`）剩下的那些：`session_before_switch` / `session_before_fork` / `session_before_compact` / `session_before_tree` / `session_shutdown` / `agent_start` / `agent_end` / `agent_settled` / `turn_start` / `turn_end` / `message_start` / `message_update` / `tool_execution_start` / `tool_execution_end` / `register_*` 等。设计目的：用一份稳定的 `emit<TEvent>(...)` 路径让所有 "无返回值/只关心是否被取消" 的事件保持类型安全，比每来一个事件写一个新方法更经济。

### 2.2 执行流程

1. **建上下文**：`createContext()`（`runner.ts:636-705`）生成 `ExtensionContext`。其中所有读状态的 getter（`model`、`cwd`、`signal` 等）都内嵌 `assertActive()`（`runner.ts:523-527`）——在 `invalidate()` 之后捕获上下文的扩展会立即拿到过期错误。
2. **遍历扩展**：双重循环，外层 `this.extensions` 内层每个扩展 `ext.handlers.get(event.type)`。
   - 守卫：`!handlers || handlers.length === 0` 直接 continue，避免在零订阅上做无谓工作。
3. **调用 handler**：`await handler(event, ctx)`。handler 在扩展里是 `EventListener`，参数类型来自 `types.ts` 的 `ExtensionEvent`。
4. **处理 "可取消" 事件**：`isSessionBeforeEvent(event)`（`runner.ts:746-753`）用于识别四个 `session_before_*` 事件。只要任一 handler 返回 `result.cancel === true`，立即 return，跳过剩余扩展/handler。
   - 这意味着：**取消是 "短路且首 winning"**——后面的扩展再也没机会否决。
5. **隔离错误**：`try/catch` 包住每个 handler。失败时构造 `ExtensionError` 通过 `emitError()` 通知监听器，绝不让单个扩展把整条分发链搞挂。
6. **返回值**：始终返回 `SessionBeforeEventResult | undefined`（强类型 `RunnerEmitResult<TEvent>`），非 `session_before_*` 事件类型下结果是 `undefined`，但类型一致利于调用方书写。

### 2.3 关键设计点

- **共享同一段分发骨架**：所有特化的 `emitXxx()` 在错误隔离、双层循环、上下文创建上跟通用 `emit` 完全一致，差异只在中间如何 merge handler 结果。
- **首 winning 短路**：与 `emitInput`（`handled` 优先短路）、`emitMessageEnd`（顺序合并，校验 role）、`emitContext`（合并 messages）等形成四种典型合并策略。

---

## 3. `ExtensionRunner` 的十个专属 `emitXxx()`

它们都遵循同样的骨架（建 `ctx` → 双层循环 → try/catch → 合并/短路），差异集中在 **合并策略** 和 **入参/出参形状**。下表先给汇总，再各讲一个最值得说的。

| 方法 | 文件位置 | 事件 | 合并策略 | 短路条件 |
| --- | --- | --- | --- | --- |
| `emitMessageEnd` | `runner.ts:789-829` | `message_end` | 顺序替换 message；role 不一致报错 | 无（顺序遍历所有扩展） |
| `emitToolResult` | `runner.ts:831-879` | `tool_result` | 顺序合并 `content` / `details` / `isError` | 无 |
| `emitToolCall` | `runner.ts:881-902` | `tool_call` | 后写覆盖前值 | `result.block === true` 立即返回 |
| `emitUserBash` | `runner.ts:904-931` | `user_bash` | 首 winning | 任一 handler 返回 truthy 结果即返回 |
| `emitContext` | `runner.ts:933-963` | `context` | 顺序替换 messages 数组（`structuredClone` 深拷贝） | 无 |
| `emitBeforeProviderRequest` | `runner.ts:965-997` | `before_provider_request` | 顺序替换 payload | 无 |
| `emitBeforeProviderHeaders` | `runner.ts:999-1028` | `before_provider_headers` | **就地 mutate**（返回原 `headers`） | 无 |
| `emitBeforeAgentStart` | `runner.ts:1030-1094` | `before_agent_start` | 收集 messages、追加 systemPrompt | 无 |
| `emitResourcesDiscover` | `runner.ts:1096-1142` | `resources_discover` | 按扩展分组累加 `skillPaths` / `promptPaths` / `themePaths` | 无 |
| `emitInput` | `runner.ts:1145-1184` | `input` | `transform` 链式覆盖 `text` / `images`；`handled` 终态短路 | `result?.action === "handled"` |

### 3.1 `emitMessageEnd`：可变的 message 包装

`message_end` 让扩展对刚生成的消息做最后修改（最常见的例子是 "改成自定义角色" 做引用）。执行流程：

1. `currentMessage = event.message`，`modified = false`。
2. 每扩展构造 `currentEvent = { ...event, message: currentMessage }` —— 关键是**每轮重新克隆**，否则一个扩展改了 message，下一个扩展看到的还是上游原文。
3. handler 返回后，校验 `handlerResult.message.role === currentMessage.role`；不一致视为错误，跳过这个 result（但不阻断后续扩展）。
4. 任一修改落地 → `modified = true`，最终 `modified ? currentMessage : undefined`，让调用方区分 "动过" 与 "没人动"。
5. 错误依旧走 `emitError` 通道。

### 3.2 `emitBeforeProviderHeaders`：就地 mutate 的特殊形态

其他事件都尊重 handler 的返回值；只有它明确写明 "Handlers mutate `headers` in place; the return value is ignored."（`runner.ts:1008`）。原因：HTTP headers 本来就是单对象、就地扩展比构造新对象更便宜，并且大量扩展都只关心"加一个 `X-Trace-Id`" 这种追加式变更，按引用就地改能保持幂等。

### 3.3 `emitBeforeAgentStart`：组合型结果

返回 `BeforeAgentStartCombinedResult | undefined`，字段 `{ messages?, systemPrompt? }`。执行流程：

1. 用 `Object.defineProperties` 复制 `createContext()` 的描述符，再覆盖 `ctx.getSystemPrompt` —— 让每个 handler 读到**累积过的** `currentSystemPrompt`，而不是原始 `systemPrompt`。
2. 多个扩展可以**追加** messages（`messages.push(result.message)`），同时**替换** systemPrompt（`currentSystemPrompt = result.systemPrompt`）。
3. 用 `systemPromptModified` 标识 systemPrompt 是否真正被改过，避免在没人动时仍返回 `{ systemPrompt: undefined }`（区分 "未设置" 与 "值为空"）。

### 3.4 `emitInput`：transform/handled/continue 三态机

输入事件有三种"态度"：

- `action: "handled"` —— 立刻终止分发，原样返回（短路）。
- `action: "transform"` —— 写入 `currentText` / `currentImages`，**继续轮转下一个 handler**（链式变换）。
- 默认 `action: "continue"` —— 不修改。

最后若 `currentText !== text || currentImages !== images`，对外以 `transform` 形式返回，否则返回 `{ action: "continue" }`（`runner.ts:1181-1183`）。这是 Pi 中典型的"管道式"emit 实现。

### 3.5 `emitResourcesDiscover`：多源累加

`resources_discover` 让扩展声明 skill/prompt/theme 文件路径，runner 维护三张表：`skillPaths` / `promptPaths` / `themePaths`。每发现一条 `result.skillPaths` 就把它和扩展路径一起 push 进去（`{ path, extensionPath: ext.path }`），下游 `ResourceLoader` 凭这个 `extensionPath` 在出错时回溯是哪个扩展报的。

### 3.6 `emitContext`：深拷贝避免污染原数组

特别地，`let currentMessages = structuredClone(messages);` 在最开始做一次深拷贝，避免扩展对 `messages` 数组 / 嵌套对象的修改泄漏回 caller。

---

## 4. `ExtensionRunner.emitError` —— 错误广播

位置：`runner.ts:534-538`

```ts
emitError(error: ExtensionError): void {
    for (const listener of this.errorListeners) {
        listener(error);
    }
}
```

所有 `emitXxx()` 抓到 `try/catch` 后都通过它广播。这是一个非阻塞、顺序遍历的 `Set<ExtensionErrorListener>` 调用。订阅侧（`onError()`，`runner.ts:529-532`）通常用于：UI 显示"扩展 X 在事件 Y 中抛错 Z"、诊断汇总、Telemetry 上报。

注意它是 **同步** 的。这意味着 `emit` 流程只等 handler 自身 resolve，错误通知的 listener 是 fire-and-forget，不能反向影响主体分发。

---

## 5. 顶层辅助函数 `emitSessionShutdownEvent` / `emitProjectTrustEvent`

`runner.ts:190-231` 定义了两个工厂方法包装类逻辑：

### 5.1 `emitSessionShutdownEvent(extensionRunner, event)`

```ts
if (extensionRunner.hasHandlers("session_shutdown")) {
    await extensionRunner.emit(event);
    return true;
}
return false;
```

- 先 `hasHandlers()` 检查，能零成本跳过；存在订阅才走 `emit()`。
- 返回 `boolean` 让调用方按"真的发了" / "没人监听"分支处理。常用于 `agent-session-runtime.ts:167-175` 的 `teardownCurrent`：在 `session.dispose()` 前后做对账。

### 5.2 `emitProjectTrustEvent(extensionsResult, event, ctx)`

不对应 `ExtensionRunner.emit`，而是直接遍历 `LoadExtensionsResult.extensions`：

- 一个事件可能注册多个 handler，第一个返回 `trusted !== "undecided"` 的胜出，**undecided 视为弃权，继续往下问**。
- 把每个扩展每条 handler 的异常逐条 `errors.push(...)`，最终返回 `{ result?, errors }`。语义更接近 "投票"，而不是 "扇出"。

---

## 6. `AgentSessionRuntime.emitBeforeSwitch` / `emitBeforeFork`

位置：`packages/coding-agent/src/core/agent-session-runtime.ts:133-165`

它们是把上层 `switchSession` / `newSession` / `fork` 操作转换成扩展事件并把结果归一为 `{ cancelled: boolean }` 的薄包装。

```ts
private async emitBeforeSwitch(
    reason: "new" | "resume",
    targetSessionFile?: string,
): Promise<{ cancelled: boolean }> {
    const runner = this.session.extensionRunner;
    if (!runner.hasHandlers("session_before_switch")) {
        return { cancelled: false };
    }
    const result = await runner.emit({
        type: "session_before_switch",
        reason,
        targetSessionFile,
    });
    return { cancelled: result?.cancel === true };
}
```

### 6.1 执行流程

1. 检查 `runner.hasHandlers("session_before_switch")`：没有订阅就直接 `cancelled: false`，跳过 `emit` 调用。
2. 存在订阅：构造事件传给 `runner.emit()`，拿到 `SessionBeforeSwitchResult | undefined`。
3. 把 `result?.cancel === true` 归一为 boolean，让上层 `switchSession` 在 `cancelled` 时早返回，不进入 `teardownCurrent` 流程。

### 6.2 与 `emitBeforeFork` 的差异

仅是事件类型 `session_before_fork`、入参 `entryId`/`position` 不同。两者结构对称，便于阅读维护。

---

## 7. `AgentHarness` 的 `emit` 系列

位置：`packages/agent/src/harness/agent-harness.ts:212-301`、`517-529`、`294-301`

`AgentHarness` 自身也对外暴露一套 `emit`，但服务的对象是 **`@earendil-works/pi-agent-core` 的核心循环**（调用方是 `runAgentLoop` / `streamSimple`），与扩展无关。它们用的是 `handlers` 这个 `Map<eventType, Set<Listener>>`（`agent-harness.ts:181`），常驻订阅模型。

### 7.1 `emitOwn(event, signal)` —— 透传自身事件

```ts
for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
    try { await listener(event, signal); }
    catch (error) { throw normalizeHookError(error); }
}
```

- `SUBSCRIBER_EVENT_TYPE = "*"`（`agent-harness.ts:124`）即"通配订阅"——任何 `subscribe(listener)` 都会注册到这个集合。
- 错误经 `normalizeHookError` 包成 `AgentHarnessError("hook", ...)` 抛出，harness 主流程会捕获并转成 `agent_end` 终态消息（见 `emitRunFailure`）。
- 适用事件：`queue_update`、`save_point`、`settled`（这三种只在 harness 内部分发，不进 `emitAny`）。

### 7.2 `emitAny(event, signal)` —— 给通配订阅转发任何 agent 事件

形状与 `emitOwn` 完全一样，但服务于所有 `AgentEvent`（`message_*` / `tool_execution_*` / `turn_*` / `agent_*`）。`agent-harness.ts:488-515` 的 `handleAgentEvent` 在合适的分支上分别调用：`message_end` 之前 append to session；`turn_end` 后 flush pending writes，再 emit `save_point`；`agent_end` 后 emit `settled`。

### 7.3 `emitHook<TType>(event)` —— 取得 lastResult 的强类型分发

```ts
const handlers = this.getHandlers(event.type as TType);
if (!handlers || handlers.size === 0) return undefined;
let lastResult;
for (const handler of handlers) {
    try {
        const result = await handler(event);
        if (result !== undefined) lastResult = result;
    } catch (error) {
        throw normalizeHookError(error);
    }
}
return lastResult;
```

- 关键点：`AgentHarnessEventResultMap`（`harness/types.ts`）按事件类型映射返回结构，`emitHook<TType extends keyof ...>` 推导出真正的结果类型。
- "最后一次非 undefined 的结果胜出"——下游 `transformContext`、`beforeToolCall`、`afterToolCall` 全部通过它注入。
- 错误同样经 `normalizeHookError` 透出，不被吞掉。

### 7.4 `emitBeforeProviderRequest` / `emitBeforeProviderPayload`

`emitBeforeProviderRequest` 是 `transformContext`-style 的链式合并：每个 handler 收到**当前累积**的 `streamOptions`，返回 `AgentHarnessStreamOptionsPatch`（可能是新 transport、新 header、新 metadata），由 `applyStreamOptionsPatch` 合并。`emitBeforeProviderPayload` 形式上完全类比，但 payload 是任意 `unknown`。

### 7.5 `emitQueueUpdate` —— 队列变更通知

```ts
await this.emitOwn({
    type: "queue_update",
    steer: [...this.steerQueue],
    followUp: [...this.followUpQueue],
    nextTurn: [...this.nextTurnQueue],
});
```

关键在三个 `[...this.xxxQueue]`：把内部可变数组**深浅拷贝**后发出，避免 listener 持有引用后改到内部状态。被 `drainQueuedMessages`（`agent-harness.ts:387-397`）和 `executeTurn` 在队列出队后调用。

### 7.6 `emitRunFailure` —— 把异常折成终态消息

当循环抛错且无法补救时调用：

```ts
const failureMessage = createFailureMessage(model, error, aborted);
await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal);
await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal);
await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] }, signal);
await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] }, signal);
return [failureMessage];
```

按 `message_start → message_end → turn_end → agent_end` 顺序伪造一组事件，强制 listener 收齐终态——而不是让它 "卡在流中断" 上不知所措。这是 resilience 层面的 emit。

---

## 8. `AgentSession._emit*` —— 业务态事件（订阅式）

`packages/coding-agent/src/core/agent-session.ts` 把 runtime 与 listener 之间通过 `_emit` 联系。

### 8.1 `_emit(event)` 与 `_emitQueueUpdate()`

`_emit`（`agent-session.ts:501-505`）只做一件事：**对 `_eventListeners` 顺序同步派发**。和 `ExtensionRunner.emitError` 一样是轻量广播。

`_emitQueueUpdate()`（`agent-session.ts:507-513`）包装 `{ type: "queue_update", steering, followUp }` 后委托给 `_emit`，把可变队列再深一份拷贝。

### 8.2 `_emitAgentSettled()` / `_emitExtensionEvent(event)`

`_emitAgentSettled`（`agent-session.ts:534-542`）：先通知扩展侧 `_extensionRunner.emit({ type: "agent_settled" })`，再通知 TUI 侧 `_emit`，并通过 `finally` 触发 `_resolveIdleWaitIfIdle()`，让等待 idle 的代码块恢复执行。

`_emitExtensionEvent`（`agent-session.ts:674-760`）是当前最复杂的 dispatch，根据 `event.type` 路由到扩展 runner 的 `emit*` 系列：

- `agent_start`/`agent_end` → `runner.emit(...)`
- `message_start`/`message_update`/`message_end` → 对应 `runner.emit` 或 `emitMessageEnd`
- `tool_execution_*` → `runner.emit(...)`
- 自定义条目 → `runner.emit(...)`
- 由 `_handleAgentEvent`（`agent-session.ts:548-...`）在 session 内统一调用。

每个分支都先订阅扩展响应，再 `_emit(event)` 让 TUI 看到一致序列——确保两层订阅看到的都是同步状态。

---

## 9. 通用进程内 EventBus

位置：`packages/coding-agent/src/core/event-bus.ts`

```ts
const emitter = new EventEmitter();

emit: (channel, data) => { emitter.emit(channel, data); },
on: (channel, handler) => {
    const safeHandler = async (data) => {
        try { await handler(data); }
        catch (err) { console.error(`Event handler error (${channel}):`, err); }
    };
    emitter.on(channel, safeHandler);
    return () => emitter.off(channel, safeHandler);
},
clear: () => emitter.removeAllListeners(),
```

- 包装 Node 原生 `EventEmitter`：UI 边缘等场景下用，给不需要强类型、不需要合并策略的轻量通道用。
- `on()` 自动把 handler 包成 `safeHandler`：handler 是 `async`，**任意异常进 `console.error` 不抛出**——和扩展 emit 的"隔离 + 通知错误"风格不同：这里把错误吞到 stderr，更适合"通知式"用法。

---

## 10. 工具级 `emit` 辅助

### 10.1 `PackageManager.emitProgress` —— 包管理进度

`packages/coding-agent/src/core/package-manager.ts:880-882`：

```ts
private emitProgress(event: ProgressEvent): void {
    this.progressCallback?.(event);
}
```

通过 `progressCallback` 单回调传递。`withProgress(action, source, message, op)`（`884-899`）包成三段式 `start → complete / error`。简洁、单播、不聚合。

### 10.2 `StdinBuffer.emitDataSequence` —— Kitty 协议去重

`packages/tui/src/stdin-buffer.ts:389-398`：

```ts
if (rawCodepoint === this.pendingKittyPrintableCodepoint) {
    this.pendingKittyPrintableCodepoint = undefined;
    return; // Kitty 协议会把一次按键拆成 "press + release"，这里把同字符去重
}
this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
this.emit("data", sequence);
```

不是分发，是去重 + 触发上游 `data` 事件。

---

## 11. 横向对比 —— 合并策略矩阵

| 合并策略 | 适用方法 | 典型场景 |
| --- | --- | --- |
| 顺序替换 | `emitContext`、`emitMessageEnd`、`emitInput(transform)` | 上下文/消息/输入需要经过一系列转换 |
| 顺序合并 patch | `emitBeforeAgentStart`、`emitBeforeProviderRequest`、`emitBeforeProviderPayload`、`emitToolResult` | 累积形变更（拼接消息、追加 system、改 stream options） |
| 后写覆盖前值 | `emitToolCall`、`emitMessageEnd` 对 message.role | "最后一个有话说的人说了算" |
| 首 winning / 短路 | `emit(user_bash)`、`emitInput(handled)`、`emit(session_before_*)` | "任何人说我否决" → 立即终止 |
| 就地 mutate | `emitBeforeProviderHeaders` | 同对象追加字段 |
| 多源累加 | `emitResourcesDiscover` | 路径清单按扩展聚合 |
| 顺序通知 | `emit`（通用）、`emitError` | 观察者模式，不要返回值 |
| 完全错开 | `emitOwn` / `emitAny` / `emitQueueUpdate` | 通知业务进度 |
| 单回调 | `emitProgress`、`EventBus.emit` | 单一可被替换的 listener |
| 去重后 emit | `emitDataSequence` | 终端协议层 |

新事件想要复用模式时，从这张表挑一种最贴近的，再套 `ExtensionRunner.emit()` 的骨架即可。

---

## 12. 错误处理全景

| emit 方法 | 错误走向 | 来源 |
| --- | --- | --- |
| `ExtensionRunner.emit*` | `try/catch` → `emitError(ExtensionError)` → 订阅者 | `runner.ts:773-782` 等多处 |
| `ExtensionRunner.emitError` | 顺序遍历 `errorListeners` | `runner.ts:534-538` |
| `emitProjectTrustEvent` | 错误累加进 `errors: ExtensionError[]`，返回 | `runner.ts:220-228` |
| `AgentHarness.emit*` | `normalizeHookError` 包成 `AgentHarnessError("hook")` 抛出 | `agent-harness.ts:217/227/245/271/288` |
| `AgentHarness.emitRunFailure` | 异常转 `assistant` 终态消息 + 走 `agent_end` | `agent-harness.ts:517-529` |
| `EventBus.on` handler | `console.error` 吞掉 | `event-bus.ts:23` |
| `PackageManager.emitProgress` | 不在它的范畴（异常向下传播给 `withProgress` 客户端） | `package-manager.ts:884-899` |

---

## 13. 执行流程示意（以一次用户消息为例）

```
TUI 提交文本
  └─ AgentSessionRuntime / AgentHarness
       ├─ emitQueueUpdate() ──> 通配订阅（_emit QueueUpdate）
       ├─ emitHook({ type: "before_agent_start", ... })
       │     └─ 顺序合并 messages / systemPrompt
       ├─ extensionRunner.emitInput(text, images, source)
       │     └─ 链式 transform / 短路 handled
       ├─ runAgentLoop 循环
       │     ├─ agent-loop → emitBeforeProviderRequest / emitBeforeProviderPayload
       │     ├─ tool 触发 → _emitExtensionEvent → extensionRunner.emit/emitToolCall/emitToolResult
       │     ├─ 完成后 → extensionRunner.emitMessageEnd
       │     └─ turn_end → emitQueueUpdate, emitAny(turn_end)
       └─ agent_end → emitRunFailure / emit(agent_end) / emit(agent_settled)
            └─ _emitAgentSettled → runtime 通知 + TUI _emit
```

---

## 14. 维护提示

- 修改 `RunnerEmitEvent` 联合类型时，记得把新增事件从通用 `emit()` 自动覆盖范围里去掉，如果它有专属合并策略的话——否则 `TEvent` 推导出 `RunnerEmitResult<TEvent>` 会出现 `undefined` 而非强类型。
- 给 `ExtensionRunner` 加新方法，骨架默认沿用：建 ctx → 双层循环 → try/catch → 合并/短路；只有"合并"和"短路"是真正需要逐事件设计的部分。
- 修改 `_emit` 相关路径前，先确认监听者期望的事件顺序。`AgentSession` 主动在扩展之前 `_emit` 同类事件，确保 TUI 永远先于扩展看到状态变化；调整这条顺序可能让 TUI 观察到不一致的中间态。
- `_emitExtensionEvent` 是关键派发表，新增 agent 事件时必须同步在这里登记，否则 TUI 看不到该事件，扩展 runner 也不会被调用。

---

## 附录 A：方法清单（按文件）

### `packages/coding-agent/src/core/extensions/runner.ts`

- `emit(error: ExtensionError): void` (534-538)
- `emit<TEvent>(event): Promise<RunnerEmitResult<TEvent>>` (755-787)
- `emitMessageEnd` (789-829)
- `emitToolResult` (831-879)
- `emitToolCall` (881-902)
- `emitUserBash` (904-931)
- `emitContext` (933-963)
- `emitBeforeProviderRequest` (965-997)
- `emitBeforeProviderHeaders` (999-1028)
- `emitBeforeAgentStart` (1030-1094)
- `emitResourcesDiscover` (1096-1142)
- `emitInput` (1145-1184)
- 文件外导出 `emitSessionShutdownEvent` (190-199)、`emitProjectTrustEvent` (201-231)

### `packages/agent/src/harness/agent-harness.ts`

- `emitOwn` (212-220)
- `emitAny` (222-230)
- `emitHook<TType>` (232-249)
- `emitBeforeProviderRequest` (251-275)
- `emitBeforeProviderPayload` (277-292)
- `emitQueueUpdate` (294-301)
- `emitRunFailure` (517-529)

### `packages/coding-agent/src/core/agent-session-runtime.ts`

- `emitBeforeSwitch` (133-148)
- `emitBeforeFork` (150-165)

### `packages/coding-agent/src/core/agent-session.ts`

- `_emit` (501-505)
- `_emitQueueUpdate` (507-513)
- `_emitAgentSettled` (534-542)
- `_emitExtensionEvent` (674-760)

### `packages/coding-agent/src/core/event-bus.ts`

- `EventBusController.emit` (15-17)

### `packages/coding-agent/src/core/package-manager.ts`

- `emitProgress` (880-882)

### `packages/tui/src/stdin-buffer.ts`

- `emitDataSequence` (389-398)

---

文档版本：基于当前 `main` 分支源码（commit `f8f75544` 之后）。

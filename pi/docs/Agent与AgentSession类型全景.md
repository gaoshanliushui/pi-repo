# Agent / AgentSession / AgentContext / AgentLoopConfig / Message 类型全景

本文基于 `packages/agent` 与 `packages/coding-agent` 的源代码梳理五类核心数据形态的字段语义和交互链路，覆盖：

- `Agent` (`@earendil-works/pi-agent-core` 的运行时类)
- `AgentState` (`Agent` 暴露的可读写状态接口)
- `AgentContext` (传给底层 agent loop 的不可变快照)
- `AgentLoopConfig` (底层 loop 接收的运行配置)
- `Message` / `AgentMessage` (对话消息,包含标准 LLM 消息和应用自定义消息)

源码定位:

- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/types.ts`
- `packages/agent/src/index.ts`
- `packages/ai/src/types.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/messages.ts`

## 1. 类型依赖关系一览

```
AgentSession ──── 拥有/引用 ────▶ Agent ──── 快照 ────▶ AgentContext
   │                                │                       │
   │                                │                       ▼
   │                                │                 runAgentLoop / runAgentLoopContinue
   │                                ▼                       │
   │                            AgentLoopConfig ────────────┘
   │                                │
   │                                ▼
   │                          StreamFn(model, Context, options)
   │                                │
   │                                ▼
   │                          AssistantMessageEventStream
   ▼
SessionManager / SettingsManager / ResourceLoader / ModelRegistry / ExtensionRunner

所有经过 loop 的对话内容: AgentMessage (= Message ∪ 自定义消息)
最终送到 LLM: Message (= UserMessage | AssistantMessage | ToolResultMessage)
```

要点:

- `Agent` 是低阶运行时,负责单一活动的 run、转录维护、事件广播、steer/follow-up 队列、abort 控制。
- `AgentSession`(`coding-agent`)是高阶会话包装,把 `Agent` 与持久化、扩展、压缩、重试、模型/思考等级、bash、UI 队列镜像整合到一起。
- `AgentContext` 是 `Agent` 在每次 run 开始时对自身状态做的浅拷贝快照,只读语义。
- `AgentLoopConfig` 是 `Agent` 把自身字段翻译给 loop 用的"per-run 视图",所有回调 (`beforeToolCall`、`afterToolCall`、`prepareNextTurn`、`getSteeringMessages`、`getFollowUpMessages`、`shouldStopAfterTurn`、`convertToLlm`、`transformContext`、`getApiKey`) 都来自这里。
- `Message` 是送到 LLM 的标准化消息;`AgentMessage` 是上层可扩展的消息联合(通过 `CustomAgentMessages` 声明合并加入 `bashExecution` / `custom` / `branchSummary` / `compactionSummary`)。

## 2. Agent (`packages/agent/src/agent.ts`)

`Agent` 是状态化的低阶 agent loop 包装类。一个 `Agent` 实例在同一时间只能跑一个活动 run (`activeRun`);发起新的 `prompt()` 时如果已经存在 run,必须改用 `steer()` 或 `followUp()` 入队。

### 2.1 私有字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_state` | `MutableAgentState` | 当前 Agent 的全部可读写状态(详见 §3)。 |
| `listeners` | `Set<(event, signal) => Promise<void>\|void>` | 通过 `subscribe()` 注册的事件监听器集合。 |
| `steeringQueue` | `PendingMessageQueue` | 转向队列,`pendingMessages` 注入点。 |
| `followUpQueue` | `PendingMessageQueue` | 后续队列,agent 自然结束后才消费。 |
| `activeRun` | `ActiveRun \| undefined` | 当前正在跑的 run,包含 `promise`、`resolve`、`abortController`。 |

### 2.2 公开字段(由构造选项直接赋值)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `convertToLlm` | `(AgentMessage[]) => Message[] \| Promise<Message[]>` | 把 `AgentMessage[]` 转成 LLM 可理解的 `Message[]`。默认实现 `defaultConvertToLlm` 只保留 `user` / `assistant` / `toolResult` 三种 role。 |
| `transformContext` | `(AgentMessage[], signal?) => Promise<AgentMessage[]>` | 在 `convertToLlm` 之前对 `AgentMessage[]` 做剪枝/注入(例如上下文窗口管理)。 |
| `streamFn` | `StreamFn` | 真正调用 LLM 的流式函数,默认 `streamSimple`(来自 `@earendil-works/pi-ai/compat`)。 |
| `getApiKey` | `(provider) => Promise<string\|undefined> \| string \| undefined` | 每次 LLM 调用前解析 API key(支持短时 OAuth)。 |
| `onPayload` | `SimpleStreamOptions["onPayload"]` | 在 HTTP payload 发出前检查/替换。 |
| `onResponse` | `SimpleStreamOptions["onResponse"]` | 收到 HTTP response 后、消费 body 之前触发。 |
| `beforeToolCall` | `(BeforeToolCallContext, signal?) => Promise<BeforeToolCallResult \| undefined>` | 工具参数校验后、执行前的钩子;返回 `{ block: true }` 阻止执行。 |
| `afterToolCall` | `(AfterToolCallContext, signal?) => Promise<AfterToolCallResult \| undefined>` | 工具执行后、事件发出前的钩子,可改写 `content` / `details` / `isError` / `terminate`。 |
| `prepareNextTurn` | `(signal?) => AgentLoopTurnUpdate \| undefined \| Promise<...>` | 旧式 turn 刷新钩子(无 context)。 |
| `prepareNextTurnWithContext` | `(PrepareNextTurnContext, signal?) => AgentLoopTurnUpdate \| undefined \| Promise<...>` | 优先于 `prepareNextTurn`,可拿到 turn 末尾的 message/toolResults/context/newMessages。 |
| `sessionId` | `string \| undefined` | 透传给支持 session 缓存的 provider(用于路由/缓存亲和)。 |
| `thinkingBudgets` | `ThinkingBudgets \| undefined` | 各 thinking 等级的 token 预算(仅 token 型 provider)。 |
| `transport` | `Transport` | 首选传输协议(`sse` / `websocket` / `websocket-cached` / `auto`),默认 `auto`。 |
| `maxRetryDelayMs` | `number \| undefined` | 服务端请求长延时重试的上限。 |
| `toolExecution` | `ToolExecutionMode` | 多 tool call 时的整体执行策略,默认 `parallel`。 |

`QueueMode`(steering/follow-up 队列的排空策略):

- `"all"` 一次排空所有排队消息。
- `"one-at-a-time"` 只消费队首一条,其余留到下个 drain 点。

`ToolExecutionMode`:

- `"sequential"` 串行执行(同一 message 内按顺序 prepare → execute → finalize)。
- `"parallel"` 先顺序 prepare,再并发执行被允许并行的工具;`tool_execution_end` 按完成顺序发,tool-result message artifact 仍按源顺序追加。

### 2.3 关键方法

| 方法 | 行为 |
| --- | --- |
| `subscribe(listener)` | 注册事件监听,返回取消订阅函数;listener 在事件循环里被 `await`,因此属于当前 run 结算的一部分。 |
| `get state()` | 返回 `_state` 的对外只读视图(`AgentState`)。 |
| `steeringMode` / `followUpMode`(getter/setter) | 转发到 `PendingMessageQueue.mode`。 |
| `steer(message)` / `followUp(message)` | 推入对应队列。 |
| `clearSteeringQueue()` / `clearFollowUpQueue()` / `clearAllQueues()` / `hasQueuedMessages()` | 队列维护。 |
| `get signal()` | 当前活动 run 的 `AbortSignal`,无 run 时为 `undefined`。 |
| `abort()` | 中止当前 run。 |
| `waitForIdle()` | resolve 于当前 run + 所有 awaited listener 结束之后。 |
| `reset()` | 清空转录、运行时状态、队列。 |
| `prompt(input, images?)` | 启动一次新 run;若已有 run 则抛错。接受字符串、单条消息、消息数组。 |
| `continue()` | 在当前转录末尾非 assistant 时续跑;若末尾是 assistant,会先尝试排空 steering,再尝试 follow-up,最后抛错。 |
| `processEvents(event)`(私有) | 把每个 loop 事件折算进 `_state`(更新 `streamingMessage`、`messages`、`pendingToolCalls`、`errorMessage`),然后串行 `await` 所有 listener。 |
| `runWithLifecycle(executor)`(私有) | 装填 `activeRun`、创建 `AbortController`、执行 loop 入口,异常路径走 `handleRunFailure`(合成 error assistant message 并走完整事件序列),`finally` 调 `finishRun()` 解锁。 |

## 3. AgentState(`packages/agent/src/types.ts`)

`AgentState` 是 `Agent` 暴露的可读写状态接口。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `systemPrompt` | `string` | 每次请求带上的系统提示词,由 `Agent.state.systemPrompt` 持有。 |
| `model` | `Model<any>` | 当前活跃模型;通过 `setModel` 切换。 |
| `thinkingLevel` | `ThinkingLevel` | 请求的推理强度(`"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`)。 |
| `tools` | `AgentTool<any>[]`(accessor) | 可用工具列表;`Agent` 内部 setter 会做顶层数组拷贝。 |
| `messages` | `AgentMessage[]`(accessor) | 对话转录;`Agent` 内部 setter 会做顶层数组拷贝。 |
| `isStreaming` | `readonly boolean` | 是否处于 prompt 或 continuation 运行中,直到 `agent_end` listener 全部 settled 才置 false。 |
| `streamingMessage?` | `readonly AgentMessage` | 当前流式 assistant message 的部分态(若有)。 |
| `pendingToolCalls` | `readonly ReadonlySet<string>` | 正在执行的工具调用 id 集合。 |
| `errorMessage?` | `readonly string` | 最近一次失败或被中止的 assistant turn 的错误信息。 |

实现细节:`Agent` 通过 `createMutableAgentState` 把 `systemPrompt/model/thinkingLevel` 存为普通字段,把 `tools/messages` 用闭包 + getter/setter 包装(写入时 `.slice()`),把 `isStreaming/streamingMessage/pendingToolCalls/errorMessage` 也存为可读写的内部字段。

## 4. AgentContext(`packages/agent/src/types.ts`)

`AgentContext` 是传给底层 loop 的"上下文快照":

```ts
interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool<any>[];
}
```

| 字段 | 含义 |
| --- | --- |
| `systemPrompt` | 与 `Agent.state.systemPrompt` 同步;`AgentSession` 会通过 `prepareNextTurnWithContext` 每轮注入最新的 `_baseSystemPrompt` / override。 |
| `messages` | 当前转录的浅拷贝(`Agent.createContextSnapshot` 里 `.slice()`)。loop 期间会就地追加消息(assistant 部分态、tool-result),但起点是 snapshot。 |
| `tools?` | 可选的工具集合,默认从 `Agent.state.tools` 浅拷贝。loop 内部把工具匹配(`currentContext.tools?.find(...)`)用于 `beforeToolCall` / 工具执行等场景。 |

注意:虽然 `AgentContext` 是普通接口,但调用方应把它视作只读快照。`runAgentLoop` 在内部把它和 prompt 消息合并成 `currentContext` 之后再进行 in-place 修改;这只是为了避免每次构造新对象。

## 5. AgentLoopConfig(`packages/agent/src/types.ts`)

`AgentLoopConfig extends SimpleStreamOptions`,是底层 loop 一应运行的"配置面"。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `model` | 是 | 当前请求使用的 `Model<any>`;loop 会读取 `model.provider` 用于 `getApiKey`。 |
| `convertToLlm` | 是 | `AgentMessage[] -> Message[]`(过滤掉 UI-only 消息、把自定义消息转换成 user 文本等)。 |
| `transformContext?` | 否 | 在 `convertToLlm` 之前的 `AgentMessage[] -> AgentMessage[]` 剪枝/注入。 |
| `getApiKey?` | 否 | 每次请求动态解析 API key,优先于 `SimpleStreamOptions.apiKey`。 |
| `shouldStopAfterTurn?` | 否 | 在 `turn_end` 之后被调用,返回 `true` 时 loop 立即 `agent_end` 退出(不再轮询 steering/follow-up 队列)。 |
| `prepareNextTurn?` | 否 | `turn_end` 之后、`shouldStopAfterTurn` 之前被调用;返回 `AgentLoopTurnUpdate` 可替换下一轮的 `context` / `model` / `thinkingLevel`。 |
| `getSteeringMessages?` | 否 | 内层 while 条件里轮询,产出 steering 消息(本轮 tool 执行完后注入)。 |
| `getFollowUpMessages?` | 否 | agent 自然停转后被消费;产出 follow-up 消息后,outer while 重新进入。 |
| `toolExecution?` | 否 | `"sequential" \| "parallel"`,默认 `parallel`。 |
| `beforeToolCall?` | 否 | 参数校验后、执行前;返回 `{ block: true }` 替换为错误 tool result。 |
| `afterToolCall?` | 否 | 工具执行后、`tool_execution_end` 之前;字段级覆盖 `content` / `details` / `isError` / `terminate`,无深合并。 |
| (来自 `SimpleStreamOptions`) | 否 | `temperature` / `maxTokens` / `signal` / `apiKey` / `transport` / `cacheRetention` / `sessionId` / `onPayload` / `onResponse` / `headers` / `timeoutMs` / `websocketConnectTimeoutMs` / `maxRetries` / `maxRetryDelayMs` / `metadata` / `env` / `reasoning` / `thinkingBudgets`。 |

配套子类型:

- `BeforeToolCallContext { assistantMessage, toolCall, args, context }`
- `AfterToolCallContext { assistantMessage, toolCall, args, result, isError, context }`
- `ShouldStopAfterTurnContext { message, toolResults, context, newMessages }`
- `PrepareNextTurnContext = ShouldStopAfterTurnContext`
- `AgentLoopTurnUpdate { context?, model?, thinkingLevel? }`
- `BeforeToolCallResult { block?, reason? }`
- `AfterToolCallResult { content?, details?, isError?, terminate? }`

## 6. Message 与 AgentMessage

### 6.1 标准 `Message`(`packages/ai/src/types.ts`)

```ts
type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `UserMessage` | `role: "user"` | 必填。 |
| | `content: string \| (TextContent \| ImageContent)[]` | 文本或文本+图片混合块。 |
| | `timestamp: number` | 毫秒 Unix 时间戳。 |
| `AssistantMessage` | `role: "assistant"` | 必填。 |
| | `content: (TextContent \| ThinkingContent \| ToolCall)[]` | 文本/思考/tool call 块数组。 |
| | `api: Api` | 实际使用的 API 类型。 |
| | `provider: ProviderId` | provider 标识。 |
| | `model: string` | 请求的模型 id。 |
| | `responseModel?: string` | 实际返回的 `chunk.model`(用于 `openrouter` 等 auto 路由)。 |
| | `responseId?: string` | 上游响应/message id(若提供)。 |
| | `diagnostics?: AssistantMessageDiagnostic[]` | 失败/恢复的脱敏诊断。 |
| | `usage: Usage` | 输入/输出/缓存读写 token 与 cost。 |
| | `stopReason: StopReason` | `"stop" \| "length" \| "toolUse" \| "error" \| "aborted"`。 |
| | `errorMessage?: string` | 失败/中止时的错误文本。 |
| | `timestamp: number` | 毫秒 Unix 时间戳。 |
| `ToolResultMessage<TDetails>` | `role: "toolResult"` | 必填。 |
| | `toolCallId: string` | 对应 `AssistantMessage.content[*].toolCall.id`。 |
| | `toolName: string` | 工具名。 |
| | `content: (TextContent \| ImageContent)[]` | 文本/图片内容;空数组表示"无内容"。 |
| | `details?: TDetails` | 结构化详情(用于 UI/日志)。 |
| | `addedToolNames?: string[]` | 该结果之后方可用的新工具(用于延迟工具加载)。 |
| | `isError: boolean` | 是否错误结果。 |
| | `timestamp: number` | 毫秒 Unix 时间戳。 |

相关小类型:

- `TextContent { type: "text"; text; textSignature? }`
- `ThinkingContent { type: "thinking"; thinking; thinkingSignature?; redacted? }`
- `ImageContent { type: "image"; data(base64); mimeType }`
- `ToolCall { type: "toolCall"; id; name; arguments; thoughtSignature? }`
- `Usage { input; output; cacheRead; cacheWrite; cacheWrite1h?; reasoning?; totalTokens; cost{...} }`
- `StopReason`

### 6.2 `AgentMessage` 与 `CustomAgentMessages`

`packages/agent/src/types.ts` 通过声明合并提供扩展点:

```ts
interface CustomAgentMessages { /* 空, 由应用扩展 */ }
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

`packages/coding-agent/src/core/messages.ts` 给 `CustomAgentMessages` 加了四个成员:

| `customType` 值 | 类型 | 关键字段 | 语义 |
| --- | --- | --- | --- |
| `bashExecution` | `BashExecutionMessage` | `role: "bashExecution"`、`command`、`output`、`exitCode`、`cancelled`、`truncated`、`fullOutputPath?`、`timestamp`、`excludeFromContext?` | `! command` 触发的 bash 执行记录。`excludeFromContext` 为 true 时不进 LLM context。 |
| `custom` | `CustomMessage<T>` | `role: "custom"`、`customType`、`content`、`display`、`details?`、`timestamp` | 扩展通过 `sendMessage()` 注入的任意消息;`convertToLlm` 统一映射为 user。 |
| `branchSummary` | `BranchSummaryMessage` | `role: "branchSummary"`、`summary`、`fromId`、`timestamp` | 分支汇合处的历史摘要。 |
| `compactionSummary` | `CompactionSummaryMessage` | `role: "compactionSummary"`、`summary`、`tokensBefore`、`timestamp` | 自动/手动压缩产生的摘要。 |

`convertToLlm`(在 `packages/coding-agent/src/core/messages.ts`)把上述自定义消息翻译成标准 `Message`:

- `bashExecution` → user(`Ran \`cmd\`` + 输出 + 退出码/截断提示;`excludeFromContext` 直接丢弃)。
- `custom` → user(文本或 content 数组)。
- `branchSummary` → user(`<summary>...</summary>` 包裹)。
- `compactionSummary` → user(`<summary>...</summary>` 包裹)。
- `user` / `assistant` / `toolResult` → 原样返回。

## 7. 交互链路(全流程)

### 7.1 `Agent` 启动一次 `prompt()` 到 loop 内的状态机

1. `Agent.prompt(input, images?)` 归一化为 `AgentMessage[]`,在没有 `activeRun` 时进入 `runPromptMessages`。
2. `runPromptMessages` → `runWithLifecycle` → `runAgentLoop(prompts, ctx, config, emit, signal, streamFn)`:
   - `runAgentLoop` 发出 `agent_start` → `turn_start` → 对每个 prompt 发 `message_start` / `message_end`。
   - 构造 `currentContext = { ...context, messages: [...context.messages, ...prompts] }` 与 `newMessages = [...prompts]`。
3. 进入 `runLoop`(共享主循环):
   1. 先 poll 一次 `config.getSteeringMessages?()`。
   2. 外层 `while (true)`:
      - 内层 `while (hasMoreToolCalls || pendingMessages.length > 0)`:
        - 第一个 turn 之外每次先发 `turn_start`。
        - 把 `pendingMessages` 注入 `currentContext.messages` / `newMessages`,发对应 `message_start` / `message_end`。
        - `streamAssistantResponse`: `transformContext` → `convertToLlm` → 组装 `Context`(只读 llm context)→ `streamFn(model, llmContext, options)` → 边读 `AssistantMessageEventStream` 边就地更新 `currentContext.messages` 的"占位 assistant message"并发 `message_start` / `message_update` / `message_end`。
        - 若 `stopReason === "error" \| "aborted"`:发 `turn_end` 与 `agent_end`,立即退出。
        - 收集 `toolCalls`,根据 `toolExecution === "sequential"` 或存在 `executionMode: "sequential"` 的工具走 `executeToolCallsSequential` / `executeToolCallsParallel`,产出 `ToolResultMessage[]` 与 `terminate`。`stopReason === "length"` 走 `failToolCallsFromTruncatedMessage`(全部强制报错,避免截断的参数被实际执行)。
        - 工具结果入栈 `currentContext.messages` / `newMessages`。
        - 发 `turn_end`。
        - 调 `config.prepareNextTurn?(turn)`:可改写下一轮的 `context` / `model` / `reasoning`。
        - 调 `config.shouldStopAfterTurn?(turn)`:为 true 时发 `agent_end` 并退出。
        - 重新 poll `config.getSteeringMessages?()`,进入下一个内层循环。
      - 内层退出后 poll `config.getFollowUpMessages?()`,有内容则作为新的 `pendingMessages` 重新进入内层,无内容则退出外层。
   3. 发 `agent_end{messages: newMessages}`。
4. `Agent.processEvents` 对每个事件:
   - `message_start` / `message_update` → 把 `_state.streamingMessage` 置为部分态。
   - `message_end` → 清 `streamingMessage`,把消息推入 `_state.messages`。
   - `tool_execution_start` / `tool_execution_end` → 维护 `_state.pendingToolCalls` Set。
   - `turn_end`(assistant + `errorMessage`)→ 同步到 `_state.errorMessage`。
   - `agent_end` → 清 `streamingMessage`。
   - 然后串行 `await` 所有 `_state.listeners`。
5. `runWithLifecycle.finally` → `finishRun()`:清 `isStreaming/streamingMessage/pendingToolCalls`,resolve `activeRun.promise`,清空 `activeRun`。此时 `agent` 才进入 idle。

### 7.2 `AgentSession` 如何与 `Agent` 协作

`AgentSession` 在构造时:

1. 接收一个 `Agent` 实例、`SessionManager`、`SettingsManager`、`ResourceLoader`、`ModelRegistry`、`cwd` 等。
2. 调用 `agent.subscribe(this._handleAgentEvent)` —— session 内的事件订阅既驱动持久化,也驱动压缩/重试/扩展事件。
3. 安装 `beforeToolCall` / `afterToolCall` hook,把 extension 的 `tool_call` / `tool_result` 事件桥接到 `ExtensionRunner.emitToolCall` / `emitToolResult`。
4. 安装 `prepareNextTurnWithContext`:在每轮 `turn_end` 之后,把 `_baseSystemPrompt` 或 `_systemPromptOverride` 重新写入 `context.systemPrompt`,并同步最新的 `model` / `thinkingLevel` 与 `_state.tools`。
5. `_buildRuntime` 装载基础工具集 + 扩展,生成 `_toolRegistry` 与 `_baseSystemPrompt`,设置默认活动工具(`read/bash/edit/write` 或 `baseToolsOverride`)。

`AgentSession.prompt(text, options)` 的关键路径:

1. `/` 开头 → `_tryExecuteExtensionCommand` 立即执行扩展命令(返回 true 即结束)。
2. 触发扩展 `input` 事件,可被 handled / transform。
3. `_expandSkillCommand` + `expandPromptTemplate` 展开 `/skill:` 与 `/template:`。
4. 已经在 streaming:`streamingBehavior === "followUp"` → `agent.followUp()`,否则 `agent.steer()`(同步维护 `_steeringMessages` / `_followUpMessages` 镜像用于 UI 展示)。
5. 不在 streaming:
   - 校验模型与认证。
   - 检测最后一次 assistant 是否触发压缩,若是则先做(然后才发新 prompt)。
   - 拼装 `AgentMessage[]`:user message + `_pendingNextTurnMessages` + 扩展 `before_agent_start` 返回的 custom messages。
   - 调 `extensionRunner.emitBeforeAgentStart` 决定是否覆盖 systemPrompt。
6. `_runAgentPrompt(messages)`:
   - `_isAgentRunActive = true`
   - `await this.agent.prompt(messages)`
   - 循环 `await agent.continue()` 直到 `_handlePostAgentRun()` 返回 false(可能触发自动重试或自动压缩)。
   - `finally`:清 `_systemPromptOverride`、flush pending bash messages、`_emitAgentSettled` → 解锁 `waitForIdle` 的 promise。

事件桥接(`_handleAgentEvent`):

- 收到 `message_start`(user):若文本匹配 `_steeringMessages` 或 `_followUpMessages` 镜像,从对应 UI 镜像里移除并发 `queue_update`,保证 UI 看到的队列态与底层 `Agent` 队列一致。
- 收到 `message_end`:
  - `custom` → `sessionManager.appendCustomMessageEntry`。
  - `user/assistant/toolResult` → `sessionManager.appendMessage`。
  - 同步追踪 `_lastAssistantMessage`,并在成功(非 error)时复位 `_overflowRecoveryAttempted` 与 `_retryAttempt`。
- `agent_end`:根据 `_willRetryAfterAgentEnd` 在转发给用户 listener 时加 `willRetry` 字段。

压缩(`compact` / `_checkCompaction` / `_runAutoCompaction`):

- 手动 `compact(customInstructions?)`:`_disconnectFromAgent` → 中止 → 让扩展 `session_before_compact` 提供摘要或自行调用 `compact()` 生成摘要 → `sessionManager.appendCompaction` → `agent.state.messages = sessionManager.buildSessionContext().messages`(把压缩结果喂回 agent 转录)。
- 自动压缩在 `_handlePostAgentRun` 里:`_checkCompaction(lastAssistantMessage)` 区分:
  - `overflow`:`isContextOverflow` + 同一模型;在 `_overflowRecoveryAttempted` 之前会从 `agent.state.messages` 移除 error assistant message,然后跑压缩并自动续跑。
  - `threshold`:`shouldCompact` 按 usage/token 估计触发压缩,但不自动重试。

重试(`_prepareRetry`):指数退避(`baseDelayMs * 2^(attempt-1)`),`_retryAbortController` 控制可中止。失败 assistant message 仍写入 session 历史,但从 `agent.state.messages` 临时移除。

模型/思考等级管理:

- `setModel` / `cycleModel`:改 `agent.state.model`,同步写入 session entry 与 settings,clamp thinking level 到新模型的能力集。
- `setThinkingLevel` / `cycleThinkingLevel`:clamp + 写 session entry + 在支持或非 `off` 时写 settings,发 `thinking_level_changed` + 扩展事件 `thinking_level_select`。

工具管理:

- `_refreshToolRegistry`:合并内置工具 + 扩展注册工具,套 `wrapRegisteredTools`(让扩展可以拦截工具执行),并把 allowed/excluded 过滤后的工具集合作为新的活动集。
- `setActiveToolsByName(names)`:从 `_toolRegistry` 取实际 `AgentTool`,写回 `agent.state.tools`,重新生成 `_baseSystemPrompt` 并同步 `agent.state.systemPrompt`。

队列管理:

- `_queueSteer` / `_queueFollowUp`:同步维护 `_steeringMessages` / `_followUpMessages`(string[]),以及调 `agent.steer()` / `agent.followUp()`(投 `AgentMessage`)。
- `clearQueue` / `pendingMessageCount` / `getSteeringMessages` / `getFollowUpMessages`:为 UI 提供读视图。

### 7.3 消息类型在 `Agent` 与 LLM 之间的转换路径

- 用户/UI 输入 → `AgentMessage[]`(可能含 `bashExecution` / `custom` / `branchSummary` / `compactionSummary`)。
- 进入 `Agent.prompt` → `runAgentLoop` → 在每次 `streamAssistantResponse` 之前:
  1. `transformContext?(messages, signal)` 在 `AgentMessage[]` 层做剪枝/注入。
  2. `convertToLlm(messages)` 走自定义实现(默认是 `defaultConvertToLlm`,只过 `user/assistant/toolResult`);`AgentSession` 在持久化时用 `convertToLlm`(来自 `coding-agent/src/core/messages.ts`),把自定义角色映射成 user 文本。
  3. 构造 `Context = { systemPrompt, messages: llmMessages, tools: contextTools }`,调用 `streamFn(model, context, options)`(默认 `streamSimple`)。
- `streamFn` 返回 `AssistantMessageEventStream`(`start/text_start/text_delta/.../done/error`)。loop 把流事件映射成 `message_start` / `message_update` / `message_end`,并把最终的 `AssistantMessage` 写到 `currentContext.messages`。
- 如果 assistant 调起工具,工具产出 `AgentToolResult`,经过 `afterToolCall` 覆盖,折算成 `ToolResultMessage` 写回 `currentContext.messages`,继续下一轮。

### 7.4 关键不变量

- 同一时刻只有一个活动 run(`Agent.activeRun`);`Agent.prompt()` 在已有 run 时直接抛错。
- `Agent.state.messages` 与 `sessionManager` 的 append-only JSONL 在 `message_end` 之后保持一致(失败消息也会写入 session,但可在压缩前临时从 `agent.state.messages` 移除以让重试或压缩生效)。
- `agent_end` 不代表 run 真正结束 —— 还要等 `_handleAgentEvent` 中扩展事件、`waitForIdle` 的 `agent_settled` 全部 settle 之后,`AgentSession.isIdle` 才为 true。
- 自定义消息只有经过 `convertToLlm` 才能进 LLM;`CustomAgentMessages` 必须实现 `convertToLlm` 转换分支才能被模型看到。
- 工具的 `executionMode: "sequential"` 会覆盖 `AgentLoopConfig.toolExecution`,强制整批串行(并行模式下被发现的 sequential 工具也会让整批回退为 sequential)。

## 8. 同名工具回调在 Agent 与 AgentLoopConfig 中的差异

`Agent` 和 `AgentLoopConfig` 都声明了 `beforeToolCall` / `afterToolCall`(以及 `convertToLlm`、`transformContext`、`getApiKey`、`shouldStopAfterTurn`、`prepareNextTurn`、`getSteeringMessages`、`getFollowUpMessages`),回调签名完全一致。两层声明不是冗余,而是同一行为在两种语境下的复用:

### 8.1 字段层面:Agent 是可写状态,AgentLoopConfig 是只读快照

`Agent` 把它们声明为 public 字段(可在构造后重新赋值):

```ts
// packages/agent/src/agent.ts (节选)
export interface AgentOptions {
  beforeToolCall?: (ctx, signal?) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?:  (ctx, signal?) => Promise<AfterToolCallResult | undefined>;
}

class Agent {
  public beforeToolCall?: (ctx, signal?) => Promise<BeforeToolCallResult | undefined>;
  public afterToolCall?:  (ctx, signal?) => Promise<AfterToolCallResult | undefined>;
}
```

每次 run 开始时,`Agent.createLoopConfig()` 把 `Agent` 上当前的值原样拷进 per-run 的 `AgentLoopConfig`:

```ts
private createLoopConfig(options): AgentLoopConfig {
  return {
    // ...
    beforeToolCall: this.beforeToolCall,
    afterToolCall:  this.afterToolCall,
    // ...
  };
}
```

底层 loop(`runAgentLoop` / `runAgentLoopContinue`)只读 `AgentLoopConfig` 的字段——它根本不直接依赖 `Agent` 类。

### 8.2 设计动机:把"长生命周期门面"和"per-run 纯数据"分开

| 层 | 类型 | 生命周期 | 谁来读 |
| --- | --- | --- | --- |
| 门面层 | `Agent` 实例字段 | 跟 `Agent` 实例同生命周期,可被外部重新赋值 | 只有 `Agent.createLoopConfig()` 读 |
| 配置层 | `AgentLoopConfig` 字段 | 单次 `runAgentLoop` / `runAgentLoopContinue` 调用,值在 run 启动时被冻结 | 底层 loop 的 `prepareToolCall` / `finalizeExecutedToolCall` |

这种分层带来两个好处:

- **底层 loop 是纯函数式**——`agentLoop(prompts, context, config, signal?, streamFn?)` 直接返回 `EventStream<AgentEvent, AgentMessage[]>`,根本不需要 `Agent` 实例。SDK、扩展或第三方测试可以绕过 `Agent` 直接使用 loop。
- **`Agent` 负责状态部分**(转录、队列、监听器、AbortController),它把状态翻译成"这一轮怎么跑"的配置投递给 loop。

### 8.3 一个特别值得注意的差异:下游可以重写 Agent 上的钩子

`Agent` 的字段是 public + mutable,这给上层包装类(典型例子是 `AgentSession`)留了一个"运行时接管工具钩子"的入口:

```ts
// packages/coding-agent/src/core/agent-session.ts (节选)
private _installAgentToolHooks(): void {
  this.agent.beforeToolCall = async ({ toolCall, args }) => {
    const runner = this._extensionRunner;
    if (!runner.hasHandlers("tool_call")) return undefined;
    return await runner.emitToolCall({ /* ... */ });
  };

  this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
    const runner = this._extensionRunner;
    if (!runner.hasHandlers("tool_result")) return undefined;
    // 把工具结果桥接给扩展,再把扩展的改写回写到 AgentToolResult
    return {
      content: hookResult.content,
      details: hookResult.details,
      isError: hookResult.isError ?? isError,
    };
  };
}
```

注意几点:

- **`AgentSession` 在 `Agent` 实例上重写了 `beforeToolCall` / `afterToolCall`**,从而在 `Agent` 后续 `createLoopConfig()` 时把桥接函数一起打包进 `AgentLoopConfig`。
- 工具钩子的执行顺序(扩展 vs. 用户原始钩子)由 `AgentSession` 决定,而不是由 `AgentLoopConfig` 上的字段决定。
- 字段描述里说"hook 收到 abort signal 并负责尊重它"——这同样适用于被 `AgentSession` 替换后的桥接版本。

如果只把钩子放在 `AgentLoopConfig` 上,这种"运行时替换"就没法实现:`AgentLoopConfig` 在每次 run 启动时构造,而 `AgentSession` 要持续管理扩展的生命周期,需要随时改写,而不是只在 run 开始时设置一次。

### 8.4 简表

| 维度 | `Agent.beforeToolCall` / `afterToolCall` | `AgentLoopConfig.beforeToolCall` / `afterToolCall` |
| --- | --- | --- |
| 出现位置 | `AgentOptions` 和 `Agent` 实例字段 | `AgentLoopConfig` 接口字段 |
| 生命周期 | 跟 `Agent` 实例共存亡,可被反复改写 | 单次 `runAgentLoop` / `runAgentLoopContinue` 调用 |
| 谁写 | 构造 Agent 的人,或后来接管它的上层(`AgentSession`) | `Agent.createLoopConfig()` 自动从 `Agent` 拷贝 |
| 谁读 | 只有 `Agent.createLoopConfig()` | `runAgentLoop` 中的 `prepareToolCall` / `finalizeExecutedToolCall` |
| 回调签名 | `(BeforeToolCallContext, signal?) => Promise<BeforeToolCallResult \| undefined>` / `(AfterToolCallContext, signal?) => Promise<AfterToolCallResult \| undefined>` | 完全相同 |
| 是否能独立使用 | 不能——必须经由 `AgentLoopConfig` 投递给 loop | 可以——裸调 `runAgentLoop(...)` 也能用 |
| 改写时机 | 任何时候(典型:扩展加载、`AgentSession` 绑定) | 每次 run 启动时自动重新拷贝 |

一句话总结:**`Agent` 上的钩子是长生命周期的"门面",`AgentLoopConfig` 上的同名钩子是这次 run 的"实际执行参数"**。双层声明把"可被运行时替换的状态"和"loop 真正消费的纯数据"分开,既让底层 loop 保持纯函数形态,也让上层包装(`AgentSession`、扩展系统)能在 `Agent` 上做透明的接管。

## 9. 速查:五类对象的最小心智模型

- `Agent`:状态机 + 队列 + 事件总线 + 唯一活动 run。负责"会话中怎么转"。
- `AgentSession`:在 `Agent` 之上挂 session(持久化、压缩、分支摘要、重试、模型/思考等级、扩展、工具注册、UI 队列镜像、bash)。负责"会话怎么落盘、怎么被 UI 和扩展消费"。
- `AgentContext`:`Agent` 每次 run 的不可变快照,loop 内可以就地追加但语义上是起点。
- `AgentLoopConfig`:loop 的全部回调 + LLM 选项 + 转换函数,描述"这一轮该怎么跑"。
- `Message` / `AgentMessage`:对话的最小内容单位。`AgentMessage = Message ∪ CustomAgentMessages`,后者在 `coding-agent/src/core/messages.ts` 用声明合并补齐四种自定义角色。
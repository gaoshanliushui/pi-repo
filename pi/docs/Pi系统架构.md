# Pi Agent Harness — 核心模块与运行流程速查

> 本文档是 `docs/ARCHITECTURE.md` 的精炼版，按"模块职责 → 关键数据结构 → 主路径时序"重排，方便快速对照源码定位。
>
> 仓库布局：`F:/Project/agent/general/pi/packages/{ai, agent, tui, coding-agent, orchestrator}`。

---

## 1. 包拓扑与依赖方向

```
                 ┌──────────────────────────┐
                 │ @earendil-works/pi-tui    │  (可选，仅 UI 依赖)
                 └────────────▲─────────────┘
                              │
┌──────────────────────────────────────────────────────┐
│ @earendil-works/pi-coding-agent                       │  ← 入口：CLI / AgentSession / Tools / Mode
└─────────▲──────────────────▲─────────────▲────────────┘
          │                  │             │
          │                  │             │
┌─────────┴──────────┐  ┌────┴────────┐  ┌─┴────────────────────────┐
│ @earendil-works/   │  │ @earendil-  │  │ @earendil-works/         │
│ pi-agent-core      │  │ works/      │  │ pi-orchestrator          │
│ (Agent + 持久化)   │  │ pi-ai       │  │ (实验性多实例调度)       │
└─────────▲──────────┘  └─────────────┘  └──────────────────────────┘
          │
          │
          └──── @earendil-works/pi-ai （基础类型 / Provider / EventStream）

外部依赖：@anthropic-ai/sdk、openai、@google/genai、@aws-sdk/client-bedrock-runtime、
@mistralai/mistralai、typebox、chalk、jiti、proper-lockfile、@silvia-odwyer/photon-node
（仅 coding-agent 用做图像处理），TUI 还引入 marked（markdown 渲染）、chalk。
```

---

## 2. @earendil-works/pi-ai（LLM 统一层）

源码：`packages/ai/src/`

### 2.1 核心抽象

| 文件 | 关键导出 | 职责 |
| --- | --- | --- |
| `types.ts` | `Api`、`Model`、`Provider`、`AssistantMessage`、`AssistantMessageEvent`、`Context`、`Message`、`StreamFunction` | 整个 LLM 层的类型契约。 |
| `models.ts` | `Models`、`MutableModels`、`Provider`、`createModels()`、`createProvider()`、`hasApi()`、`getSupportedThinkingLevels()`、`calculateCost()` | Provider / Models 集合。可动态注册、刷新、鉴权委派。 |
| `api/lazy.ts` | `lazyApi`、`lazyStream` | 把动态 `import()` 包成同步返回的 `AssistantMessageEventStream`。 |
| `api/*.ts` | `anthropicMessagesApi()`、`openaiCompletionsApi()`、`openaiResponsesApi()`、`bedrockConverseStreamApi()` 等 | 每个 Provider 的 `Api` 实现（`stream`/`streamSimple`）。 |
| `auth/types.ts` | `ApiKeyAuth`、`OAuthAuth`、`CredentialStore`、`AuthContext`、`AuthResult` | 鉴权抽象；OAuth 通过锁定的 `modify` 防止 token 双刷新。 |
| `auth/resolve.ts` | `resolveProviderAuth()`、`ModelsError`（`auth`、`oauth`、`model_source` …） | 优先级：override apiKey → 已存凭证 → ambient（env / AWS / ADC）。 |
| `utils/event-stream.ts` | `EventStream<T, R>`、`AssistantMessageEventStream` | 异步事件迭代器 + 终结 `Promise<R>`。 |
| `utils/retry.ts` | 大量正则：可重试/不可重试错误分类 | Provider 错误的可重试判别。 |
| `providers/*.ts` | `anthropicProvider()`、`openaiProvider()`、`googleProvider()` … | 30+ Provider 工厂。 |
| `providers/faux.ts` | `fauxProvider()` | 测试用伪 Provider，按队列返回 AssistantMessage。 |
| `models.generated.ts` | 自动生成的 `ANTHROPIC_MODELS`、`OPENAI_MODELS` 等 | 模型目录元数据。 |

### 2.2 Models 调用链

```
Models.stream(model, ctx, opts)
  └─ ModelsImpl.stream()
       ├─ lazyStream(model, setup)
       │    └─ setup() -> requireProvider + applyAuth
       │         ├─ resolveProviderAuth(provider, model, credentials, ctx)
       │         └─ provider.stream(requestModel, ctx, requestOptions)
       │              └─ ProviderStreams.stream() = API 模块的 stream 函数
       │                   └─ HTTP / WebSocket 请求 → 解析流 → AssistantMessageEvent
       └─ 返回 AssistantMessageEventStream（同步返回）
```

### 2.3 流式事件协议（`AssistantMessageEvent`）

```ts
type AssistantMessageEvent =
  | { type: "start";            partial }
  | { type: "text_start";       contentIndex; partial }
  | { type: "text_delta";       contentIndex; delta; partial }
  | { type: "text_end";         contentIndex; content; partial }
  | { type: "thinking_start";   contentIndex; partial }
  | { type: "thinking_delta";   contentIndex; delta; partial }
  | { type: "thinking_end";     contentIndex; content; partial }
  | { type: "toolcall_start";   contentIndex; partial }
  | { type: "toolcall_delta";   contentIndex; delta; partial }
  | { type: "toolcall_end";     contentIndex; toolCall; partial }
  | { type: "done";             reason: "stop"|"length"|"toolUse"; message }
  | { type: "error";            reason: "error"|"aborted"; error: AssistantMessage };
```

不变量：**`provider.stream` 永远不抛异常**；错误必须编码为 `error` 终结事件并填充 `stopReason/errorMessage`。

### 2.4 鉴权解析优先级

```
options.apiKey (caller override)
  → 凭证存储 OAuthCredential / ApiKeyCredential（按 Provider.id 锁 modify）
  → ApiKeyAuth.resolve({ model, ctx, credential })  ─→  env / AWS profile / ADC / SSO
  → OAuthAuth.toAuth(credential)
```

---

## 3. @earendil-works/pi-agent-core（Agent 运行时）

源码：`packages/agent/src/`

### 3.1 模块映射

| 文件 | 行级职责 |
| --- | --- |
| `agent.ts` | `Agent` 类。持有 transcript / 工具 / 队列 / 监听器；暴露 `prompt()` / `continue()` / `steer()` / `followUp()`。`runWithLifecycle` 包装 `AbortController`。 |
| `agent-loop.ts` | 低层循环 `runAgentLoop` / `runAgentLoopContinue`。工具执行（sequential / parallel）、`beforeToolCall`/`afterToolCall`、steering / follow-up、truncation 失败。 |
| `types.ts` | `AgentMessage`、`AgentTool`、`AgentState`、`AgentEvent`、`AgentLoopConfig`、`BeforeToolCallContext`、`AfterToolCallContext`、`QueueMode`、`ToolExecutionMode`。 |
| `proxy.ts` | `Agent` 的 settings-driven `streamFn` 默认实现：注入 api key、headers、retry、attribution。 |
| `node.ts` | Node 适配（`process.stdin` 等）。 |

### 3.2 Agent 状态机

```ts
class Agent {
  state: {
    systemPrompt;        // str
    model;               // Model<any>
    thinkingLevel;       // 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    tools;               // AgentTool<any>[] (accessor：setter 自动 copy)
    messages;            // AgentMessage[] (accessor)
    isStreaming;         // bool
    streamingMessage?;   // AgentMessage
    pendingToolCalls;    // Set<string>
    errorMessage?;       // str
  };

  // 队列
  steeringQueue: PendingMessageQueue;   // mode: 'all' | 'one-at-a-time'
  followUpQueue: PendingMessageQueue;

  // 单一 activeRun
  activeRun?: { promise; resolve; abortController };

  // API
  prompt(input, images?);   // 启动一次 run（同 activeRun 时抛错）
  continue();                // 不添加新消息，从 transcript 末尾继续
  steer(message);            // 当前轮结束后注入（steering）
  followUp(message);         // agent 停止后再注入（follow-up）
  subscribe(listener);       // 事件订阅
  abort(); waitForIdle(); reset();
}
```

### 3.3 Agent 事件协议

```
agent_start
turn_start
message_start       (user/assistant/toolResult)
message_update       (assistant only，附 assistantMessageEvent)
message_end
tool_execution_start (toolCallId, toolName, args)
tool_execution_update(partialResult)
tool_execution_end   (result, isError)
turn_end             (message, toolResults)
agent_end            (messages: AgentMessage[])
```

### 3.4 Agent Loop 主循环

```
runAgentLoop(prompts, ctx, config, emit, signal, streamFn)
  ├─ emit agent_start
  ├─ emit turn_start
  ├─ for prompt in prompts: emit message_start/end
  └─ runLoop(initialCtx, newMessages, …)
        ├─ pendingMessages = config.getSteeringMessages?.()
        ├─ 外层 while(true):
        │     ├─ 内层 while(hasMoreToolCalls || pendingMessages.length > 0):
        │     │     ├─ emit turn_start
        │     │     ├─ 把 pendingMessages 推进 ctx.messages + newMessages
        │     │     ├─ streamAssistantResponse(ctx, config, …)
        │     │     │     ├─ transformContext(messages, signal) (可选)
        │     │     │     ├─ llmMessages = await convertToLlm(messages)
        │     │     │     ├─ resolvedApiKey = getApiKey?.(model.provider) ?? config.apiKey
        │     │     │     ├─ response = await streamFunction(model, llmCtx, { apiKey, signal })
        │     │     │     └─ for await event of response: emit message_start/update/end
        │     │     ├─ if stopReason ∈ {'error','aborted'}: emit turn_end / agent_end / return
        │     │     ├─ toolCalls = message.content.filter(c=>c.type==='toolCall')
        │     │     ├─ if toolCalls.length:
        │     │     │     ├─ if stopReason==='length': failToolCallsFromTruncatedMessage(...)  // 参数可能被截断
        │     │     │     └─ else executeToolCalls(...)  (parallel or sequential)
        │     │     │           ├─ prepareToolCall(...) → schema validate + beforeToolCall
        │     │     │           ├─ tool.execute(id, args, signal, onUpdate)
        │     │     │           ├─ afterToolCall(...) (可改 content / details / isError / terminate)
        │     │     │           └─ createToolResultMessage(...)
        │     │     ├─ emit turn_end(message, toolResults)
        │     │     ├─ await config.prepareNextTurn?(ctx)
        │     │     ├─ if config.shouldStopAfterTurn?.(): emit agent_end / return
        │     │     └─ pendingMessages = await config.getSteeringMessages?.()
        │     ├─ followUpMessages = await config.getFollowUpMessages?.()
        │     └─ if followUpMessages.length > 0: pendingMessages = followUpMessages; continue
        │          else: break
        └─ emit agent_end(messages: newMessages)
```

### 3.5 工具执行

```
prepareToolCall(toolCall)
  ├─ tool = ctx.tools.find(t => t.name === toolCall.name)
  ├─ if !tool: immediate error("Tool X not found")
  ├─ preparedArgs = tool.prepareArguments?.(args) ?? args
  ├─ validatedArgs = validateToolArguments(tool, preparedArgs)        // TypeBox 校验
  ├─ if config.beforeToolCall: 可能 block: true → immediate error
  └─ return { kind: 'prepared', tool, args }

executePreparedToolCall(prepared)
  ├─ tool.execute(id, args, signal, onUpdate) → AgentToolResult
  │     ├─ content:  (TextContent | ImageContent)[]   // 强制保持数组
  │     ├─ details:  T
  │     ├─ addedToolNames?: string[]
  │     └─ terminate?: boolean
  └─ try/catch → 异常转 error AgentToolResult

finalizeExecutedToolCall: afterToolCall 可改 content/details/isError/terminate
batch 终止条件：所有 finalized 的 terminate 均为 true → 提前结束当前轮
```

工具执行模式：

- `config.toolExecution === "sequential"` 或 **任何** `tool.executionMode === "sequential"` → 顺序执行。
- 否则 `parallel`：`prepareToolCall` 顺序执行（确保 schema 校验串行），但允许的 `execute()` 可并发，`tool_execution_end` 按完成顺序发，最后 `toolResultMessage` 按 assistant 原始顺序发。

### 3.6 Harness 子模块

源码：`packages/agent/src/harness/`

| 子目录 | 作用 |
| --- | --- |
| `agent-harness.ts` | 高层封装 `AgentHarness`，统一处理 Session 文件、Compaction、Branch、Skills、Prompt Templates、Extension、Telemetry、Hooks、Abort/Navigation 等场景。约 1000 行，是 agent-core 的"应用层"。 |
| `compaction/compaction.ts` | 上下文压缩：`estimateTokens()`、`calculateContextTokens()`、`shouldCompact()`、`prepareCompaction()`、`compact()`、`generateSummary()`。`CompactionEntry` 携 `firstKeptEntryId` + `tokensBefore` + 可选 `details`(读/改文件列表)。 |
| `compaction/branch-summarization.ts` | 分支摘要：`collectEntriesForBranchSummary(fromId)` + `generateBranchSummary(model, ctx)` → `BranchSummaryEntry`。 |
| `messages.ts` | AgentMessage 与 SessionTreeEntry 的互转、`bashExecutionToText`、`createBranchSummaryMessage`、`createCompactionSummaryMessage`、`CustomMessage`。 |
| `prompt-templates.ts` | `/foo` 命令的 prompt 模板解析与字符串展开。 |
| `skills.ts` | `<skill name=… location=…>` 内联块的解析、转 `AgentMessage`。 |
| `system-prompt.ts` | 拼装 system prompt。 |
| `session/jsonl-storage.ts` | JSONL Session 存储：`SessionHeader`(v3) + 多种 `SessionTreeEntry`（message / thinking_level_change / model_change / compaction / branch_summary / custom / custom_message / label / session_info / active_tools_change / file_checkpoint）。`buildSessionContext()` 折叠压缩、恢复 active tools/thinking/model。 |
| `session/jsonl-repo.ts` `memory-storage.ts` `memory-repo.ts` | JSONL 与内存双套 SessionStorage。 |
| `session/session.ts` | Session 上下文生成、entry transform、projection。 |
| `session/repo-utils.ts` `session/uuid.ts` | 工具：uuidv7、`FileSystem` 包装。 |
| `utils/shell-output.ts` `utils/truncate.ts` | 小工具。 |
| `types.ts` | 整个 harness 的类型中心。 |

---

## 4. @earendil-works/pi-coding-agent（应用层 / CLI）

源码：`packages/coding-agent/src/`

### 4.1 入口流程

```
cli.ts
  ├─ process.title = "pi"
  ├─ PI_CODING_AGENT = "true"
  ├─ configureHttpDispatcher()    // 全局 undici dispatcher
  └─ main(argv)
       ├─ 处理 PI_OFFLINE / 平台清理（macOS quarantine、Windows self-update）
       ├─ handlePackageCommand / handleConfigCommand（独立子命令分支）
       ├─ SettingsManager 创建（先 bootstrap）
       ├─ parseArgs → Args（mode、model、session-dir、extensions…）
       ├─ runMigrations(cwd)
       ├─ SettingsManager 创建（startup）
       ├─ showFirstTimeSetup（interactive 首次）
       ├─ createSessionManager（--session / --resume / --continue / --fork）
       ├─ ProjectTrustStore：决定是否弹"信任项目"
       ├─ createAgentSessionRuntime(createRuntime, {...})
       │       ├─ createAgentSessionServices(opts) → { authStorage, modelRegistry, settingsManager, resourceLoader, … }
       │       └─ createAgentSessionFromServices({…}) → AgentSession + Agent + 绑定扩展
       ├─ 决定 appMode：interactive | print | json | rpc
       └─ 分发：
              interactive → new InteractiveMode(runtime, opts).run()
              print/json  → runPrintMode(runtime, …)
              rpc         → runRpcMode(runtime)
```

### 4.2 `core/` 关键模块

| 文件 | 关键类型/函数 | 说明 |
| --- | --- | --- |
| `sdk.ts` | `createAgentSession(options)` | 顶级工厂：合并 services、注册 `beforeToolCall`/`afterToolCall`/`prepareNextTurnWithContext`、构造 Agent + AgentSession、绑定扩展、装回 session messages。 |
| `agent-session.ts` | `AgentSession`（≈3000 行） | 核心：事件订阅与回放、Steering/Follow-up 队列、Session 持久化（`message_end` 触发 `appendMessage`）、Compaction（manual / threshold / overflow）、自动重试、Bash 注入、扩展钩子桥接、`_installAgentToolHooks`。 |
| `agent-session-runtime.ts` | `AgentSessionRuntime` | 拥有当前 `AgentSession` + services；封装 `newSession / switchSession / fork / reload / reloadModel`。切换时先发 `session_shutdown` 再重建 cwd-bound services。 |
| `agent-session-services.ts` | `AgentSessionServices`、`createAgentSessionServices()` | `authStorage` / `settingsManager` / `modelRegistry` / `resourceLoader` 等。 |
| `model-registry.ts` | `ModelRegistry` | 包装 `Models` + `AuthStorage`。`getApiKeyAndHeaders(model)` 把"已存凭证 + ambient + models.json 配置的 key/command"统一解析。 |
| `model-resolver.ts` | `findInitialModel`、`resolveCliModel`、`ScopedModel` | CLI `--model/--provider` 解析与默认 model 选择。 |
| `session-manager.ts` | `SessionManager`、`SessionHeader`（v3）、`buildSessionContext`、`forkFrom`、`continueRecent`、`inMemory` | Session 文件 IO + 分支折叠 + 树遍历。 |
| `settings-manager.ts` | `SettingsManager`（global + project `.pi/settings.json`） | 默认 model / thinking / transport / steeringMode / compaction / retry / proxy / timeout / telemetry 等。`withLock` 串行写入。 |
| `auth-storage.ts` | `AuthStorage` | 文件级 `proper-lockfile` 保护 `auth.json`。 |
| `resource-loader.ts` | `DefaultResourceLoader` | 加载 extensions / skills / prompt templates / themes / `AGENTS.md` / `CLAUDE.md`。 |
| `tools/` (`bash`/`edit`/`write`/`read`/`grep`/`find`/`ls`/`file-mutation-queue`) | `createXxxToolDefinition(cwd, opts)` | 内置工具工厂。`withFileMutationQueue` 串行化写工具。Bash 通过 `BashOperations` 可注入远程执行。 |
| `bash-executor.ts` | `executeBashWithOperations`、`BashOperations` | Bash 执行抽象（gondolin VM / 本地 shell / Docker）。 |
| `extensions/index.ts` | `ExtensionRunner`、`ToolDefinition`、`ExtensionAPI` | 扩展系统入口。 |
| `extensions/runner.ts` | `ExtensionRunner` 事件总线、`emit*` | 30+ 事件类型（`session_start`、`tool_call`、`turn_start` 等）。 |
| `compaction/index.ts` | 包装 agent-core 的压缩 + 分支摘要 + token 估算 | 暴露 `compaction_start/end` 事件。 |
| `slash-commands.ts` | `BUILTIN_SLASH_COMMANDS`（`/help`/`/model`/`/compact`/`/session`/`/resume`/`/fork`/`/tree`/`/export`…） | 内置斜杠命令注册表。 |
| `export-html/` | `exportSessionToHtml(session, path)`、`createToolHtmlRenderer` | 会话导出独立 HTML（含 vendor JS）。 |
| `keybindings.ts` | 编辑器/全局键位 | 支持 `DEFAULT_EDITOR_KEYBINDINGS` / `DEFAULT_APP_KEYBINDINGS` 注入。 |
| `migrations.ts` `trust-manager.ts` `http-dispatcher.ts` `cache-stats.ts` `footer-data-provider.ts` `system-prompt.ts` `prompt-templates.ts` `skills.ts` `source-info.ts` `provider-attribution.ts` | 周边 | |
| `diagnostics.ts` `event-bus.ts` `package-manager.ts` `experimental.ts` `resolve-config-value.ts` `telemetry.ts` `timings.ts` `provider-display-names.ts` `model-resolver.ts` `auth-guidance.ts` `bash-executor.ts` `cache-stats.ts` |  | |

### 4.3 `modes/` 三种运行模式

| 模式 | 入口 | IO |
| --- | --- | --- |
| `interactive` | `modes/interactive/interactive-mode.ts` | TUI（`@earendil-works/pi-tui`）。订阅 `AgentSessionEvent`，渲染消息/工具/状态栏；`/` 派发 slash command、`!` 注入 Bash、Ctrl+P 切模型、Ctrl+G 外编辑、附件粘贴。 |
| `print` / `json` | `modes/print-mode.ts` | 单次 prompt；`text` 模式只打最终回复；`json` 模式输出 JSONL 事件流。 |
| `rpc` | `modes/rpc/rpc-mode.ts` + `rpc-client.ts` | stdin JSONL 接收 `RpcCommand` → 调用 `runtime.session.*`；stdout 输出 `RpcResponse` 与 `AgentSessionEvent`。`rpc-entry` 是 Node 启动用入口。 |

---

## 5. @earendil-works/pi-tui（终端 UI 库）

源码：`packages/tui/src/`

### 5.1 模块映射

| 文件 | 入口 |
| --- | --- |
| `tui.ts` | `TUI`、`Container`、`Component`、`Focusable`、`OverlayHandle`、`CURSOR_MARKER`。差分渲染、键盘路由、Overlay。 |
| `keys.ts` | `Key`、`parseKey`、`matchesKey`、`isKeyRelease`、`isKeyRepeat`、`isKittyProtocolActive`、`setKittyProtocolActive`、`KeyId`、`KeyEventType`。Kitty 键盘协议 + 旧式 sequence。 |
| `keybindings.ts` | `KeybindingsManager`、`Keybinding`、`KeybindingConflict`、`DEFAULT_EDITOR_KEYBINDINGS`、`DEFAULT_APP_KEYBINDINGS`。 |
| `autocomplete.ts` | `AutocompleteProvider`、`CombinedAutocompleteProvider`、`SlashCommand`。 |
| `editor-component.ts` | `EditorComponent` 接口（getText/setText/handleInput/onSubmit/onChange/addToHistory/insertTextAtCursor/insertImage/setAutocompleteProvider）。扩展可注入 vim/emacs 等编辑器。 |
| `fuzzy.ts` | `fuzzyMatch`、`fuzzyFilter`。 |
| `utils.ts` | `visibleWidth`、`sliceByColumn`、`sliceWithWidth`、`wrapTextWithAnsi`、`extractSegments`、`normalizeTerminalOutput`、`truncateToWidth`。 |
| `stdin-buffer.ts` | `StdinBuffer`：按粘贴边界切分输入。 |
| `terminal.ts` | `ProcessTerminal`、`Terminal` 接口。 |
| `terminal-colors.ts` | `parseOsc11BackgroundColor`、`parseTerminalColorSchemeReport`。 |
| `terminal-image.ts` | `detectCapabilities`、`renderImage`、`allocateImageId`、Kitty/iTerm 协议编码、`hyperlink`。 |
| `kill-ring.ts` `undo-stack.ts` `native-modifiers.ts` `word-navigation.ts` | 编辑器小工具。 |
| `components/box.ts` `text.ts` `spacer.ts` `loader.ts` `cancellable-loader.ts` `input.ts` `editor.ts`（2333 行） `markdown.ts`（marked） `image.ts` `select-list.ts` `settings-list.ts` `truncated-text.ts` | UI 组件。 |

### 5.2 渲染与键盘流

```
stdin (raw mode)
  └─ StdinBuffer (paste boundary)
       └─ TUI input loop
            ├─ handleKey → routed to focused Component
            │     ├─ Component.handleInput?(data)
            │     └─ Component.render(width)  → line[]
            └─ diff(prevLines, newLines) → 写 ANSI 转义到 stdout
```

- `Component` 接口：`render(width)`、`handleInput?(data)`、`wantsKeyRelease?`、`invalidate()`。
- `Container` 通过 layout 维护子组件尺寸与 focus。
- `OverlayHandle` 提供浮层（modal / select / dropdown）。

---

## 6. @earendil-works/pi-orchestrator（实验性多实例调度）

源码：`packages/orchestrator/src/`

| 文件 | 关键导出 |
| --- | --- |
| `serve.ts` | `serve()`：启动 Unix socket daemon。`recoverAfterRestart` + 可选 Radius 集成 + 优雅 shutdown。 |
| `cli.ts` | `serve` / `list` / `spawn` / `status` / `stop` / `rpc` / `rpc-stream`。 |
| `supervisor.ts` | `OrchestratorSupervisor`：管理 `LiveInstance` Map（`rpcProcess` + `subscribers`），`new_session`/`switch_session`/`fork`/`clone`/`set_session_name`/`prompt` 之后刷新 session 元数据。 |
| `rpc-process.ts` | `RpcProcessInstance`：包装子进程（`pi --mode rpc` 或 `node …/rpc-entry.js`），通过 stdin/stdout JSONL 把请求/事件进出 child。 |
| `storage.ts` | `loadInstances()` / `saveInstances()`：orchestrator 实例清单持久化到 `instances.json`。 |
| `radius.ts` | Radius 远程集成（machine / presence）。 |
| `handler.ts` | IPC 请求 handler（spawn/list/stop/status/rpc/rpc_stream）。 |
| `ipc/{server,client,protocol}.ts` | Unix socket 服务器、客户端、协议（`SpawnRequest` / `ListRequest` / `StopRequest` / `RpcRequest` / `RpcStreamRequest`）。 |
| `types.ts` | `InstanceRecord`、`InstanceStatus`、`MachineRecord`。 |
| `config.ts` | socket 路径、orchestrator 目录路径。 |

### 6.1 进程拓扑

```
orchestrator serve
  └─ Unix socket (e.g. ~/.pi/orchestrator/<machine>.sock)
       ├─ spawn: child = spawn("pi", ["--mode", "rpc"], cwd)  // 或 node rpc-entry
       │           └─ pi child: stdin JSONL  → AgentSession  → Agent loop
       │                     stdout JSONL → RpcResponse + AgentSessionEvent
       └─ supervisor: 维护 InstanceRecord
                       ├─ 子进程 stdin/stdout ↔ JSONL RpcClient
                       └─ 可选 bridge 到 Radius（远程）
```

---

## 7. 关键数据流：从用户键入到工具结果

```
键盘 / 粘贴
  └─ InteractiveMode.handleInput
       ├─ '/' → dispatchSlashCommand  →  AgentSession 上的对应操作
       ├─ '!' → executeBash  →  BashExecutionMessage (steer)
       └─ 文本 → AgentSession.userMessage → session.prompt(text)
            └─ Agent.prompt() → runWithLifecycle() (AbortController)
                 └─ runAgentLoop(prompts, ctx, config, emit, signal, streamFn)
                      └─ runLoop → streamAssistantResponse (见 §3.4)
                            └─ streamSimple / AgentSession 自定义 streamFn
                                  ├─ ModelRegistry.getApiKeyAndHeaders(model)
                                  ├─ mergeProviderAttributionHeaders(...)
                                  ├─ before_provider_headers (extensionRunner)
                                  └─ Models.stream(model, ctx) → Provider.stream()
                                        └─ 各 Api 模块：HTTP/WS → AssistantMessageEventStream
                                              └─ stream ← Agent 解析为 message_* 事件

收到 toolCall:
  Agent.executeToolCalls
    ├─ prepareToolCall: schema validate + beforeToolCall (扩展可 block)
    ├─ tool.execute(args, signal, onUpdate)        // 内置或扩展工具
    │     └─ 返回 AgentToolResult
    ├─ afterToolCall (扩展可改 content/details/isError/terminate)
    └─ toolResultMessage 推入 context → emit turn_end

转 offerHook prepareNextTurnWithContext → AgentSession 刷 systemPrompt/tools
继续 loop 直到 follow-up 空 + 无更多 tool call → agent_end
```

---

## 8. Session 持久化（JSONL）

`packages/agent/src/harness/session/jsonl-storage.ts` + `packages/coding-agent/src/core/session-manager.ts`：

```
文件 layout：
  /path/to/session/<session-id>.jsonl
  ├─ line 1: { type: "session", version: 3, id, timestamp, cwd, parentSession?, metadata? }
  ├─ line 2: { type: "thinking_level_change", id, thinkingLevel }
  ├─ line 3: { type: "model_change", id, provider, modelId }
  ├─ line N: { type: "message", id, message: { role, content, … } }
  ├─ ...
  ├─ { type: "compaction", id, summary, tokensBefore, firstKeptEntryId, details? }
  ├─ { type: "branch_summary", id, summary, fromId }
  ├─ { type: "custom", customType, content, display? }
  ├─ { type: "label", targetId, label }
  └─ { type: "file_checkpoint"?, "session_info"?, "active_tools_change"? }
```

`buildSessionContext()`：默认 transform 把最近一次 `compaction` 之前的旧 entries 折叠为一条 compaction summary；后续 entries 透传。

---

## 9. 关键子系统速查表

| 子系统 | 主要文件 | 入口 API |
| --- | --- | --- |
| 鉴权 | `packages/ai/src/auth/` + `coding-agent/src/core/auth-storage.ts` + `model-registry.ts` | `Models.getAuth(model)` / `AuthStorage.withLockAsync` / `ModelRegistry.getApiKeyAndHeaders` |
| 模型目录 | `packages/ai/scripts/generate-models.ts` → `models.generated.ts` | `getBuiltinModel()` / `ModelRegistry.getModels()` |
| Agent Loop | `packages/agent/src/agent.ts`、`agent-loop.ts` | `new Agent({...}).prompt(...)` |
| 工具 | `coding-agent/src/core/tools/*.ts` | `createXxxToolDefinition(cwd, opts)` |
| Session | `packages/agent/src/harness/session/` + `coding-agent/src/core/session-manager.ts` | `SessionManager.create/open/forkFrom` + `buildSessionContext` |
| 压缩 | `packages/agent/src/harness/compaction/` | `compact(messages, opts)` + `shouldCompact` |
| 扩展 | `coding-agent/src/core/extensions/` | `loadExtensionCached(path)` / `ExtensionRunner.emit*` |
| TUI | `packages/tui/src/tui.ts` + `components/` | `new TUI(terminal).start()` + `Container` |
| RPC | `coding-agent/src/modes/rpc/` | `runRpcMode(runtime)` + `RpcClient` |
| 资源加载 | `coding-agent/src/core/resource-loader.ts` | `DefaultResourceLoader({ cwd, agentDir, settingsManager })` |
| HTTP | `coding-agent/src/core/http-dispatcher.ts` | `configureHttpDispatcher(proxy, timeoutMs)` |
| 项目信任 | `coding-agent/src/core/trust-manager.ts` | `ProjectTrustStore.get(cwd)` / `set(cwd, trusted)` |
| 主题 | `coding-agent/src/modes/interactive/theme/` | `initTheme(name)` + `theme()` |
| 导出 | `coding-agent/src/core/export-html/` | `exportSessionToHtml(session, path)` |
| 调度 | `packages/orchestrator/src/` | `serve()` + `OrchestratorSupervisor` |

---

## 10. 不变量 / 设计契约

- `Provider.stream` 永 **不抛异常**；所有失败必须编码为 `AssistantMessage` + `stopReason: "error"|"aborted"` + `errorMessage`。
- `Agent.state.messages` 是真实 transcript；扩展不能直接修改，只能走 `steer`/`followUp`/`sendMessage`。
- `transformContext` 在 AgentMessage 层（LLM 边界之前）；`convertToLlm` 之后不可改 `Message[]`。
- `Agent.prompt` 与 `Agent.continue` 互斥；同时刻只能有一个 active run。
- 单一 `PromptTemplate` / `Skill` 在 `<…>` 块内嵌入消息文本，避免给 LLM 添加额外结构。
- 写工具通过 `withFileMutationQueue` 串行化以避免竞态。
- Bash 通过 `BashOperations` 抽象出本地 / 远程 / VM 执行面。
- `SuspiciousProject` / 不可信项目：扩展读取与 bash 默认受限；`ProjectTrustStore` 持久化信任决定。
- 跨进程 `auth.json` 写入用 `proper-lockfile` 串行化。
- OAuth token 刷新在 `CredentialStore.modify` 内执行，避免并发双刷新。
- `lazyApi()` 内的 `import()` 失败被转成 `error` 流事件，对调用方语义无影响。

---

## 11. 进程拓扑

- `pi` 单进程：CLI → `AgentSessionRuntime` → 1 个 `AgentSession` + 1 个 `Agent` + 1 个 JSONL session。
- `pi --mode rpc` 把同一个 runtime 的命令/事件通过 JSONL 暴露给外部进程。
- `orchestrator serve` 启动 Unix socket daemon，按需 spawn 多个 `pi` 子进程（每个都是完整 runtime），把 socket 客户端的 RPC 转发到对应实例的 JSONL。
- Interactive / RPC / Print 共享同一个 `AgentSessionRuntime`；切换 IO 层无需重建 session。

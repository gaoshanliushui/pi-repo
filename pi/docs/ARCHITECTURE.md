# Pi Agent Harness 架构文档

> 基于源码（`packages/ai`、`packages/agent`、`packages/tui`、`packages/coding-agent`、`packages/orchestrator`）整理。

## 1. 总体定位

Pi 是一个自扩展（self-extensible）的编码 Agent 框架。仓库是 npm workspaces 单仓多包结构，对外发布四个核心包，并提供 `pi` CLI：

| 包 | npm 名 | 职责 |
| --- | --- | --- |
| `packages/ai` | `@earendil-works/pi-ai` | 多 Provider 统一 LLM API、流式事件、鉴权解析、模型目录生成 |
| `packages/agent` | `@earendil-works/pi-agent-core` | Agent 运行时：消息循环、工具执行、上下文管理、压缩/分支摘要、Session 持久化 |
| `packages/tui` | `@earendil-works/pi-tui` | 差分渲染的 TUI 库，组件、按键、终端能力探测 |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | 交互式/打印/RPC 模式的 CLI、内置工具、扩展、资源加载器 |
| `packages/orchestrator` | `@earendil-works/pi-orchestrator` | 实验性：通过 Unix socket 多实例调度 coding-agent |

依赖方向自上而下：`coding-agent` → `agent` + `ai` + `tui`；`agent` → `ai`；`orchestrator` → `coding-agent`。

## 2. 核心模块

### 2.1 `@earendil-works/pi-ai`：LLM 统一层

源码：`packages/ai/src/`

- **Provider / Models 抽象**（`models.ts`）
  - `Provider`：`id` / `name` / `auth` / `getModels()` / `stream()` / `streamSimple()`。可静态（内置目录）或动态（`refreshModels()`）列出模型。
  - `Models`：`MutableModels`（`setProvider` / `deleteProvider`），负责 `getAuth()` 与流式委托。`getAuth()` 内部走 `auth/resolve.ts` 优先级：override apiKey → 已存凭证 → 环境变量/ADC 等 ambient。
  - 顶层 `index.ts` 故意不导出 `stream()`/`complete()`/全局 `getModels`/OAuth 实现/`compat`；Provider 工厂在 `@earendil-works/pi-ai/providers/*`，API 实现在 `@earendil-works/pi-ai/api/*`，旧全局 API 在 `@earendil-works/pi-ai/compat`。
- **API 实现**（`api/*`）：每个 Provider 对应一种 `Api`（`openai-responses`、`openai-completions`、`openai-codex-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex`、`azure-openai-responses`、`mistral-conversations`）。`lazy.ts` 暴露 `lazyApi()` / `lazyStream()`，把动态导入包成同步返回的 `AssistantMessageEventStream`，加载失败转为 error 事件。
- **生成目录**（`models.generated.ts`）：由 `scripts/generate-models.ts` 拉取上游元数据构建。`AgentSession` 不直接读它，统一通过 `Models.getModels()`。
- **鉴权**（`auth/`）
  - `auth/context.ts` 提供 `defaultProviderAuthContext`，封装环境变量读取、`fileExists` 等 ambient 能力。
  - `auth/credential-store.ts` 默认 `InMemoryCredentialStore`；按 provider 串行化写入。
  - `auth/resolve.ts` 实现优先级与 `ModelsError`（`model_source` / `model_validation` / `provider` / `stream` / `auth` / `oauth`）。
  - `oauth/*`：每个支持 OAuth 的 Provider 一个实现（`getOAuthProvider(id)` 注册表）。`refreshOAuth` 处理过期 token 并写回。
- **事件流**（`utils/event-stream.ts`）：`EventStream<T, R>` 是带终结判定的 `AsyncIterable<T>` + `Promise<R>`，给上层提供 `result()`。`AssistantMessageEventStream` 在此基础上加 `AssistantMessageEvent` 协议（`start` / `text_*` / `thinking_*` / `toolcall_*` / `done` / `error`）。

### 2.2 `@earendil-works/pi-agent-core`：Agent 运行时

源码：`packages/agent/src/`

- **类型**（`types.ts`）：`AgentMessage`（`user` / `assistant` / `toolResult` / `bashExecution` / `custom` / `branchSummary` / `compactionSummary`），`AgentContext`、`AgentTool`、`StreamFn`、`ToolExecutionMode`、`QueueMode`、事件类型（`message_start`/`message_update`/`message_end`/`tool_execution_start`/`tool_execution_end`/`turn_start`/`turn_end`/`agent_start`/`agent_end`）。
- **Agent 类**（`agent.ts`）
  - 持有 `state`（`systemPrompt` / `model` / `thinkingLevel` / `tools` / `messages` / `isStreaming` / `streamingMessage` / `pendingToolCalls` / `errorMessage`）。
  - 队列：`steeringQueue` + `followUpQueue`（`all` 或 `one-at-a-time`）。
  - `prompt(input, images?)`：单消息或批量 user 消息；`continue()`：从当前 transcript 续跑（最后一条必须是 user/toolResult）。
  - 每次跑动使用 `runWithLifecycle` 创建 `AbortController`，`subscribe()` 的监听器串行 await，`agent_end` 之后才把 run 标记为 idle。
  - 失败处理：把异常合成 `stopReason: "error"|"aborted"` 的 assistant 消息，避免监听器收不到终态。
- **循环**（`agent-loop.ts`）
  - `runLoop`：外层循环处理 follow-up；内层循环处理 tool/steering。
  - `streamAssistantResponse`：执行 `transformContext`（AgentMessage→AgentMessage）→ `convertToLlm`（AgentMessage→Message）→ `streamFunction`（默认 `streamSimple`）。流式事件 `message_start`/`message_update`/`message_end`。
  - 工具执行：默认 parallel；任何 `tool.executionMode === "sequential"` 触发 sequential 模式。`stopReason === "length"` 时把全部 toolcall 标错（参数可能截断）。
  - 支持 `beforeToolCall` / `afterToolCall` / `prepareNextTurn` 钩子。
- **Harness 子模块**（`harness/`）
  - `compaction/`：基于 token 估算的上下文压缩；`branch-summarization.ts` 处理分支切换。
  - `session/`：JSONL/内存两套 `SessionStorage`（`jsonl-repo.ts` / `memory-repo.ts`），`session.ts` 负责 `buildSessionContext`：折叠 compression 前的旧 entries、解析 `model_change` / `thinking_level_change` / `active_tools_change`。
  - `system-prompt.ts`、`prompt-templates.ts`、`skills.ts`：系统提示、prompt 模板、skill 解析。
  - `messages.ts`：`bashExecutionToText`、summary 消息工厂、`CustomMessage`。

### 2.3 `@earendil-works/pi-tui`：终端 UI

源码：`packages/tui/src/`

- **TUI 主类**（`tui.ts`）：差分渲染、按键路由、Overlay、CSS 主题。`Component` 接口：`render(width)` / `handleInput?(data)` / `wantsKeyRelease?` / `invalidate()`。`Container`、`Focusable`、`OverlayHandle` 构成层级与覆盖。
- **组件**（`components/`）：`Box`、`Text`、`Markdown`（基于 `marked`）、`Editor`、`Input`、`SelectList`、`SettingsList`、`Image`（Kitty/iTerm 协议）、`Spacer`、`Loader`、`CancellableLoader`、`TruncatedText`。
- **键盘**（`keys.ts`、`keybindings.ts`）：Kitty 键盘协议识别、按键解析、`KeybindingsManager` 持有 `Keybinding` 表（带 `KeyId` 与 `matchesKey`）。
- **终端**（`terminal.ts`、`terminal-image.ts`、`terminal-colors.ts`）：`ProcessTerminal` 抽象底层；`detectCapabilities()` 探测 Kitty/iTerm/背景色协议；`renderImage` 编码图片到指定协议；`hyperlink()` 输出 OSC 8 链接。
- **工具**（`utils.ts`、`fuzzy.ts`）：宽度/截断/ANSI 切片；`fuzzyMatch` / `fuzzyFilter` 用于补全与列表。
- **StdinBuffer**（`stdin-buffer.ts`）：把 stdin 按粘贴边界分批。

### 2.4 `@earendil-works/pi-coding-agent`：CLI 与应用层

源码：`packages/coding-agent/src/`

- **入口**
  - `cli.ts`：`process.title` / `PI_CODING_AGENT` / `process.emitWarning` 屏蔽；`configureHttpDispatcher()` 在 provider SDK 出请求前装好；`main(argv)`。
  - `main.ts`：解析 CLI、迁移、Settings/Trust/Auto-discovery、决定 `appMode`（`interactive` / `print` / `json` / `rpc`）、读取 stdin、构造 `AgentSessionRuntime`、按模式分发到 `InteractiveMode` / `runPrintMode` / `runRpcMode`。
- **核心层 `core/`**
  - `sdk.ts`：`createAgentSession()` 工厂：合并 cwd/services/options、注册扩展 runners、安装 `before/afterToolCall` 与 `prepareNextTurnWithContext`（自动刷新 `systemPrompt` / `tools`）、构造 `Agent` 与 `AgentSession`、恢复 session messages、记录 model/thinking 变更。
  - `agent-session-services.ts` / `agent-session-runtime.ts`：cwd 绑定服务与 runtime。`createAgentSessionServices` 产出 `AgentSessionServices`（`authStorage` / `settingsManager` / `modelRegistry` / `resourceLoader` / `diagnostics`）。`AgentSessionRuntime` 拥有当前 `AgentSession` + services，封装 `newSession` / `switchSession` / `fork` / `reload`，切换时先发 `session_shutdown`、再重建 cwd-bound services、最后 `apply`。
  - `agent-session.ts`（3000+ 行）：`AgentSession` 类。承担：
    - 事件订阅与回放（`subscribe` / `_handleAgentEvent`）。
    - 队列状态：`_steeringMessages` / `_followUpMessages` / `_pendingNextTurnMessages`。
    - 会话持久化：`message_end` 写 `SessionManager.appendMessage`，`compaction_end` 写 `appendCompaction`。
    - 压缩：manual / threshold / overflow 三种原因；`shouldCompact` + `prepareCompaction` + `compact`。
    - 自动重试：`_retryAbortController` + `auto_retry_start` / `auto_retry_end` 事件。
    - Bash 执行：`!` 命令通过 `BashExecutionMessage` 注入。
    - 工具/扩展集成：`_installAgentToolHooks` 把 `beforeToolCall` / `afterToolCall` 桥接到扩展；`_buildRuntime` 初始化基础工具、注册扩展工具；`_extensionRunnerRef` 给 Agent 的 `streamFn` 注入 `before_provider_headers` 钩子。
  - `session-manager.ts`：基于 JSONL 的 Session 存储。`SessionHeader`（`v3`，含 `parentSession`）+ 多种 `SessionEntry`（message / thinking_level_change / model_change / compaction / branch_summary / custom / custom_message / label / session_info / active_tools_change / file_checkpoint）。提供 `create` / `open` / `forkFrom` / `continueRecent` / `inMemory` / `list` / `listAll` / `getEntry` / `append*`。`buildSessionContext()` 把分支折叠成 LLM 上下文。
  - `settings-manager.ts`：全局 + 项目 `.pi/settings.json`。持有默认 model/thinking/transport/steeringMode/followUpMode/compaction/retry/branchSummary/httpProxy/timeout/telemetry/theme 等；`withLock` 保护并发写。
  - `model-registry.ts`：`ModelRegistry` 包装 `Models` + `AuthStorage`。`getApiKeyAndHeaders(model)` 把"已存凭证 + ambient + models.json 中声明的 key/command"统一解析为 `AuthStatus`。支持运行期 `setRuntimeApiKey`、`registerProvider`（扩展注册）、`refresh()`（动态模型）。
  - `resource-loader.ts`：`DefaultResourceLoader` 在 `reload()` 时统一加载 extensions / skills / prompt templates / themes / 上下文文件（`AGENTS.md` / `CLAUDE.md`），处理诊断、路径冲突、`noExtensions` / `noSkills` 开关以及 npm/git 包源。
  - `auth-storage.ts`：文件级 `proper-lockfile` 保护 `auth.json` 写入；提供 `withLock` / `withLockAsync`、runtime api key、OAuth refresh 写回。
  - `tools/`：内置工具 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`，全部 `createXxxToolDefinition(cwd, opts)` 工厂；`withFileMutationQueue` 串行化写工具。
  - `bash-executor.ts`：把 bash 工具的 `BashOperations` 抽象出来，便于扩展（gondolin、Docker 等）。
  - `compaction/index.ts`：包装 `agent-core` 压缩 + 分支摘要 + token 估算；处理 `compaction_start` / `compaction_end` 事件。
  - `slash-commands.ts`：`BUILTIN_SLASH_COMMANDS`（`/help` / `/model` / `/compact` / `/session` / `/resume` / `/fork` / `/tree` / `/export` 等）。
  - `extensions/`：扩展系统——`loader.ts` 解析 `.ts`/`.js`/`.mjs` 扩展、`runner.ts` 事件总线、`types.ts` 全部扩展 API 类型（`ExtensionContext`、`ToolDefinition`、`SlashCommandInfo`、`ProviderRegistration` 等）。
  - `migrations.ts`、`trust-manager.ts`、`http-dispatcher.ts`、`cache-stats.ts`、`footer-data-provider.ts`、`keybindings.ts`、`export-html/` 等周边模块。
- **模式层 `modes/`**
  - `interactive/interactive-mode.ts`：TUI 入口。订阅 `AgentSessionEvent`，渲染消息/工具/状态栏；处理 `/` 命令、`!` bash、Ctrl+P 切模型、Ctrl+G 外编辑、附件粘贴图像。`bindExtensions` 把 TUI 注入扩展 UI 上下文。
  - `print-mode.ts`：单次 prompt；`mode: "text"` 输出最终回复，`mode: "json"` 输出 JSONL 事件流。
  - `rpc/rpc-mode.ts` + `rpc-client.ts`：通过 stdin/stdout JSONL 与外部驱动（如 IDE 插件、`orchestrator`）交互。`RpcClient` 把外部命令桥接到 `AgentSession` 方法。
- **扩展样例**（`examples/extensions/`）：gondolin（VM 路由）、sandbox、自定义 provider、with-deps。

### 2.5 `@earendil-works/pi-orchestrator`：多实例调度

源码：`packages/orchestrator/src/`

- 基于 Unix socket 暴露 `serve` 守护进程，可启动/停止 `coding-agent` 实例。
- CLI 子命令：`serve` / `list` / `spawn` / `status` / `stop` / `rpc` / `rpc-stream`。
- `rpc-stream` 客户端把 JSONL `RpcCommand` / `extension_ui_response` 写进 socket，把远端 `RpcResponse` / 事件流回 stdout。
- 协议见 `ipc/protocol.ts`，类型在 `@earendil-works/pi-coding-agent` 的 `rpc-types.ts` 导出。

## 3. 核心运行流程

下面以 `pi` 的 interactive 模式为线索，串起从启动到一次工具调用的完整路径。

### 3.1 启动与 CLI 解析

```
$ pi [args]
└─ cli.ts
   ├─ process.title = APP_NAME; PI_CODING_AGENT=true; 屏蔽 emitWarning
   ├─ configureHttpDispatcher()           // 全局 undici dispatcher
   └─ main(argv)
      ├─ 处理 --offline / PI_OFFLINE / 平台特定清理
      ├─ SettingsManager.create(bootstrap)  // 用于 http proxy / 早期设置
      ├─ handlePackageCommand / handleConfigCommand（独立子命令）
      ├─ parseArgs → Args
      │   └─ 解析 --model / --provider / --thinking / --tools / --no-tools
      │      --session / --continue / --resume / --fork / --name
      │      --session-dir / --extensions / --skills / --themes / --prompt-templates
      │      --system-prompt / --append-system-prompt / --export / --mode / --print
      ├─ runMigrations(cwd)                // 旧 auth/settings 迁移
      ├─ SettingsManager.create(startup)   // 真实 startup
      ├─ showFirstTimeSetup（仅 interactive）
      ├─ createSessionManager              // 解析 --session/--resume/--continue/--fork
      │   └─ SessionManager.create/open/forkFrom/continueRecent/inMemory
      ├─ ProjectTrustStore：决定是否弹"信任此项目"提示
      ├─ createAgentSessionRuntime(createRuntime, {...})
      │   └─ createRuntime 闭包：把 cwd/services 绑定到当前 argv
      └─ 决定 appMode 并按模式分发
```

### 3.2 cwd 绑定服务与 Session 创建

`createAgentSessionRuntime` 用一个工厂闭包分两步建出 `AgentSession`：

1. **`createAgentSessionServices(options)`** 返回 `AgentSessionServices`：
   - `authStorage`（默认 `~/.pi/agent/auth.json`）。
   - `modelRegistry`（`~/.pi/agent/models.json` + `authStorage`）。
   - `settingsManager`（`cwd` + `agentDir`，可能受 `projectTrusted` 影响）。
   - `resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, ... })`，`reload()` 加载扩展、技能、prompt、theme、`AGENTS.md` / `CLAUDE.md`。
   - 应用扩展注册的 Provider（`pendingProviderRegistrations`），应用扩展 `flagValues`。
2. **`createAgentSessionFromServices({ services, sessionManager, model, ... })`** 调用 `sdk.createAgentSession`：
   - 从 `sessionManager.buildSessionContext()` 恢复 messages、thinking level、model（必要时降级并产生 `modelFallbackMessage`）。
   - 构造 `Agent`：`convertToLlm`（含 `blockImages` 过滤）、`streamFn`（合并 provider 鉴权、retry、attribution headers、`before_provider_headers` 钩子）、`onPayload` / `onResponse` 钩子、`transformContext` 走扩展、`steeringMode` / `followUpMode` / `transport` / `thinkingBudgets`。
   - 构造 `AgentSession`：订阅 agent 事件、安装 `beforeToolCall` / `afterToolCall` / `prepareNextTurnWithContext` 钩子、注册基础工具 + 扩展工具 + 自定义工具、把 extensions 绑到 `ExtensionRunner`。

### 3.3 模式分发

- **`appMode === "rpc"`**：`runRpcMode(runtime)` 启动 `RpcClient`，把 `RpcCommand` 转成 `runtime.session.prompt()` / `runtime.newSession()` / `runtime.fork()` 等；事件以 `RpcResponse` JSONL 写出。
- **`appMode === "print" | "json"`**：`runPrintMode(runtime, { mode, initialMessage, initialImages, messages })`：
  - 注册 SIGTERM/SIGHUP、订阅 `AgentSessionEvent`、调用 `session.prompt(initialMessage, images)`。
  - 完成后可继续 `messages`，最后 `await session.waitForIdle()`。
  - `mode === "text"` 仅打印最终回复；`mode === "json"` 把所有事件 JSONL 化。
- **`appMode === "interactive"`**：`new InteractiveMode(runtime, opts).run()` 启动 TUI，进入主循环。

### 3.4 Interactive 主循环

`InteractiveMode.run()` 大致：

1. 渲染欢迎屏、首屏 footer、init 主题。
2. 启动 `TUI.start()`，主组件是 `Editor`（输入框）和会话视图。
3. 用户输入文本 / 命令 / 附件：
   - `/` 开头 → 解析为 slash command（内置或扩展提供），从 `BUILTIN_SLASH_COMMANDS` 派发。
   - `!` 开头 → `executeBash`（`BashExecutionMessage`）注入。
   - 文本 → `session.prompt(text, images?)`。
4. `session.prompt` → `agent.prompt` → `runWithLifecycle` → `runAgentLoop`（或 `runAgentLoopContinue`）。
5. 每条消息持久化：`_handleAgentEvent` 监听 `message_end`，调用 `sessionManager.appendMessage`（写 JSONL）。
6. UI 收到 `AgentSessionEvent`（扩展 `agent_end` / `compaction_end` / `queue_update` / `session_info_changed` / `thinking_level_changed` / `auto_retry_*`）增量重绘。

### 3.5 Agent 循环一次轮转

```
runLoop (agent-core)
├─ 拉取 steeringMessages（steeringQueue.drain）
├─ 内层 while:
│   ├─ 把 pending messages 推进 context
│   ├─ streamAssistantResponse
│   │   ├─ transformContext(messages)        // 扩展可改写
│   │   ├─ convertToLlm(messages)            // AgentMessage[] → Message[]
│   │   ├─ streamFunction(model, context)    // 走 AgentSession.streamFn
│   │   │   └─ auth + retry + headers + before_provider_headers
│   │   └─ 收集 AssistantMessageEvent → emit message_* 
│   ├─ if tool calls:
│   │   ├─ stopReason=="length" → fail all (参数可能截断)
│   │   ├─ else executeToolCalls (parallel/sequential)
│   │   │   ├─ beforeToolCall (AgentSession 注入扩展 tool_call 钩子)
│   │   │   ├─ tool.execute(args, signal)     // 实际工具实现
│   │   │   ├─ afterToolCall  (扩展 tool_result 钩子)
│   │   │   └─ 产出 toolResultMessage
│   │   └─ 把结果 push 到 context
│   ├─ emit turn_end
│   ├─ prepareNextTurn(turnContext)          // AgentSession 刷新 systemPrompt/tools
│   ├─ shouldStopAfterTurn? → emit agent_end, return
│   └─ 再拉 steeringMessages
└─ 拉取 followUpMessages：非空则继续内层，否则 break → emit agent_end
```

终止条件：

- 工具结果 / `message_end` 把 `stopReason: "error"|"aborted"` 直接结束。
- 显式 `shouldStopAfterTurn`（如压缩完成、`terminate` 工具结果）。
- 外层 follow-up 队列空 + 内层无更多 tool call + 无 steering → `agent_end`。

### 3.6 工具执行

`AgentSession._installAgentToolHooks()` 把 `agent.beforeToolCall` / `agent.afterToolCall` 桥到 `_extensionRunner`：

- `beforeToolCall` → `extension_runner.emitToolCall({ tool_call })`，扩展可 `block: true` 阻止执行。
- `afterToolCall` → `extension_runner.emitToolResult({ tool_result })`，扩展可改写 `content` / `details` / `isError` / `terminate`。

基础工具工厂在 `tools/`：

- `createReadToolDefinition(cwd, opts)` / `write` / `edit`（共享 `withFileMutationQueue`）/ `bash`（`BashOperations` 可注入）/ `grep` / `find` / `ls`。
- 每个工具返回 `ToolDefinition`（TypeBox schema + `execute(args, ctx, signal)`），`AgentSession` 把它包成 `AgentTool` 注入 `agent.state.tools`。

### 3.7 压缩 / 分支摘要

- **手动**：`/compact [instructions]` → `session.compact(reason="manual", instructions?)`。
- **自动**：`message_end` 之后估算 `contextUsage`；超过 `compaction.reserveTokens + keepRecentTokens` 触发 `compaction_start(reason="threshold")`。
- **溢出**：`turn_end` 收到 `isContextOverflow`，触发 `reason="overflow"`；`AgentSession` 置 `_overflowRecoveryAttempted` 避免死循环。
- **算法**（`agent-core` `compaction.ts`）：
  - `findCutPoint`：按 `keepRecentTokens` 留近 N 个 token 的 message；保证切在 user 消息前。
  - `generateSummary`：调当前 model 生成 summary。
  - `compact`：把 cut 之前的 entries 折叠为一条 `compactionSummary` message，写入 `CompactionEntry`（含 `firstKeptEntryId`、`tokensBefore`、可选 `details: CompactionDetails` 记录读/改文件）。
- **分支摘要**（`branch-summarization.ts`）：从 entryId 之前的分支另算一次 summary，写 `BranchSummaryEntry`。

### 3.8 鉴权解析

`Agent` 的 `streamFn` 注入：

```
streamFn(model, context, options) {
  auth = modelRegistry.getApiKeyAndHeaders(model)
  //  → AuthStorage 读 auth.json  → env/ADC/SSO fallback → 注入 auth.apiKey/headers/env
  headers = mergeProviderAttributionHeaders(model, settings, sessionId, auth.headers, options.headers)
  if (extensionRunner.hasHandlers("before_provider_headers")) headers = emit(headers)
  return streamSimple(model, context, { apiKey, env, timeoutMs, maxRetries, headers, ... })
}
```

`streamSimple` 内部走 `Models.stream()` → `ModelsImpl.applyAuth()` → `resolveProviderAuth()` → Provider 实现。每个 Provider 的 `Api` 模块（`api/anthropic-messages.lazy.ts` 等）以 lazy import 加载。

### 3.9 扩展生命周期

1. `DefaultResourceLoader.reload()`：枚举 `cwd/.pi/agent/extensions` / `agentDir/extensions` / npm 包源 / `--extension` 路径，调用 `loadExtensionCached(path)`。
2. `Extension` 的 `factory(ExtensionContext)` 返回 `ExtensionAPI`：
   - 订阅事件（`session_start` / `session_shutdown` / `agent_settled` / `message_*` / `tool_call` / `tool_result` / `turn_*`）。
   - 注册工具 / slash command / keybinding / CLI flag / UI widget。
   - 注册 Provider（`pendingProviderRegistrations`）。
3. `ExtensionRuntime` 持有事件订阅与 `flagValues` 映射。
4. `AgentSession.bindExtensions({ mode, uiContext, commandContextActions, onError })`：把 TUI 上下文注入扩展，让它们能弹 modal/select；`commandContextActions` 暴露 `newSession` / `fork` / `switchSession` / `reload` / `navigateTree` 等与 `AgentSessionRuntime` 互通。
5. 卸载：`session.dispose()` → `extensionRunner.dispose()` → 取消所有 `subscribe` 句柄。

## 4. 关键时序：一次工具调用的端到端路径

```
用户敲 Enter
  └─ InteractiveMode 把文本发到 session.prompt(text)
       └─ agent.prompt → runWithLifecycle → runAgentLoop
            ├─ emit agent_start / turn_start / message_start+end (user)
            └─ runLoop 第一次迭代
                 ├─ streamAssistantResponse
                 │   ├─ transformContext(扩展) → messages
                 │   ├─ convertToLlm          → llmMessages
                 │   └─ streamSimple(model, ctx)           // = AgentSession.streamFn
                 │        └─ modelRegistry.getApiKeyAndHeaders
                 │        └─ mergeProviderAttributionHeaders + 扩展 before_provider_headers
                 │        └─ Models.stream(model, ctx) → provider.stream(model, ctx)  // lazy API
                 │        └─ Provider 实现走 HTTP/WS，产出 AssistantMessageEvent
                 └─ 收到 assistantMessage，含 toolCall
                      ├─ executeToolCalls
                      │   ├─ 扩展 beforeToolCall（可 block）
                      │   ├─ ToolDefinition.execute(args, ctx, signal)  // 内置工具或扩展工具
                      │   │   └─ 例：bash → executeBashWithOperations → ToolResultMessage
                      │   └─ 扩展 afterToolCall（可改写 content/details/terminate）
                      ├─ push toolResultMessage 到 context
                      ├─ emit turn_end
                      ├─ prepareNextTurnWithContext → AgentSession 刷 systemPrompt/tools/thinking
                      └─ hasMoreToolCalls? 是 → 再 streamAssistantResponse；否 → followUp 队列判定
```

## 5. 关键子系统对照表

| 子系统 | 主要文件 | 入口 API |
| --- | --- | --- |
| 鉴权 | `packages/ai/src/auth/` + `coding-agent/src/core/auth-storage.ts` + `model-registry.ts` | `Models.getAuth(model)` / `AuthStorage.withLockAsync` |
| 模型目录 | `packages/ai/scripts/generate-models.ts` → `models.generated.ts` | `getBuiltinModel()` / `ModelRegistry.getModels()` |
| 工具 | `coding-agent/src/core/tools/*.ts` | `createXxxToolDefinition(cwd, opts)` |
| Session | `packages/agent/src/harness/session/` + `coding-agent/src/core/session-manager.ts` | `SessionManager.create/open/forkFrom` + `buildSessionContext` |
| 压缩 | `packages/agent/src/harness/compaction/` | `compact(messages, options)` + `shouldCompact` |
| 扩展 | `coding-agent/src/core/extensions/` | `loadExtensionCached(path)` + `ExtensionRuntime.emit*` |
| TUI | `packages/tui/src/tui.ts` + `components/` | `new TUI(terminal).start()` + `Container` |
| RPC | `coding-agent/src/modes/rpc/` | `runRpcMode(runtime)` + `RpcClient` |
| 资源加载 | `coding-agent/src/core/resource-loader.ts` | `DefaultResourceLoader({ cwd, agentDir, settingsManager })` |
| HTTP | `coding-agent/src/core/http-dispatcher.ts` | `configureHttpDispatcher(proxy, timeoutMs)` |
| 项目信任 | `coding-agent/src/core/trust-manager.ts` | `ProjectTrustStore.get(cwd)` / `set(cwd, trusted)` |
| 主题 | `coding-agent/src/modes/interactive/theme/` | `initTheme(name)` + `theme()` |
| 导出 | `coding-agent/src/core/export-html/` | `exportSessionToHtml(session, path)` |

## 6. 进程间拓扑

- `pi` 单进程内：CLI → `AgentSessionRuntime` → 1 个 `AgentSession` + 1 个 `Agent` + 1 个 JSONL session 文件。
- `pi --mode rpc` 把同一 runtime 的命令/事件通过 JSONL 暴露给外部。
- `orchestrator serve` 启动一个 socket daemon，按需 `spawn` 多个 `pi` 子进程（每个都是完整 runtime），把 socket 客户端的 RPC 转发到对应实例的 JSONL。
- TUI、RPC、Print 三种 mode 共享同一个 `AgentSessionRuntime`；切换 mode（不退出进程）只换 IO 层，不重建 session。

## 7. 已知不变量

- `agent.state.messages` 始终是真实 transcript；扩展不能直接改，必须走 `sendMessage` / `steer` / `followUp`。
- `session.messages` 持久化为 JSONL `message` entries；`compaction` / `branch_summary` / `custom` / `custom_message` 等非 LLM 消息各自走自己的 entry。
- `beforeToolCall` 的 `block: true` 会把工具换成 `errorMessage` 文本结果再继续循环。
- `transformContext` 改写的是 AgentMessage[]，发生在 LLM 边界之前；`convertToLlm` 之后不可再改 Message[]（应改 AgentMessage）。
- `Agent.prompt` 与 `Agent.continue` 互斥；运行时只能有一个 active run。`steer` / `followUp` 是并发的入队接口。
- `Provider.stream` 永不抛异常；错误必须编码到返回的 stream 事件里（`stopReason: "error"|"aborted"` + `errorMessage`）。

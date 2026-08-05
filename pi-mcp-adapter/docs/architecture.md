# 架构

`pi-mcp-adapter` 是一个 Pi 扩展模块。它默认导出一个工厂函数 `mcpAdapter(pi)`（在 `index.ts` 中），注册以下内容：

- 一个 `mcp-config` flag（指向 MCP 配置文件路径）。
- 一个 `mcp` 代理工具，以及来自元数据缓存的零或多个 direct tools。
- 两条命令：`/mcp`（服务器面板）与 `/mcp-auth`（OAuth 选择器）。
- `tool_result` 事件的覆写逻辑，把 MCP 失败重新归类为错误。

它依赖三个核心件（`init.ts`、`server-manager.ts`、`lifecycle.ts`），外加 UI 集成、OAuth、Sampling、Elicitation 等子系统。

## 生命周期一览

```
                       session_start
                            │
                            ▼
   ┌────────────────────────────────────────────────────┐
   │ initializeOAuth()                       (目前 no-op)│
   │ initializeMcp(pi, ctx)                              │
   │   ├─ 合并加载配置（含 imports）                     │
   │   ├─ 注册服务器条目                                 │
   │   ├─ 把元数据缓存填进内存 toolMetadata              │
   │   ├─ 并行连接 eager / keep-alive 服务器            │
   │   ├─ 如有需要，补齐 direct tools 缓存              │
   │   ├─ 启动 keep-alive 健康检查（30s）                │
   │   └─ 返回 McpExtensionState                        │
   └────────────────────────────────────────────────────┘
                            │
                            ▼
              proxy / direct 工具调用发生
                            │
   tool call ──────────► 通过 McpServerManager lazy connect
                            │
                            ▼
              维护 inFlight + lastUsedAt
                            │
                            ▼
              结果内容走 output guard
                            │
                            ▼
                            模型

                  session_shutdown / session_restart
                            │
                            ▼
   ┌────────────────────────────────────────────────────┐
   │ shutdownState(state, reason)                       │
   │   ├─ 关闭已打开的 UI 服务器                        │
   │   ├─ 刷写元数据缓存                                │
   │   ├─ lifecycle.gracefulShutdown() → closeAll       │
   │   └─ shutdownOAuth()                               │
   └────────────────────────────────────────────────────┘
```

`index.ts` 中的 `lifecycleGeneration` 是个计数器，每次 `session_start` / `session_shutdown` 自增，保证旧的 `initializeMcp` 不会覆盖当前 session 的状态。

## 扩展状态（`state.ts`）

`McpExtensionState` 是 `initializeMcp` 产出、被所有 proxy/direct 调用修改的单一对象：

| 字段 | 作用 |
|------|------|
| `manager` | `McpServerManager`，管理活跃的 `Client`/transport 映射。 |
| `lifecycle` | `McpLifecycleManager`，负责 keep-alive 跟踪 + 空闲/健康定时器。 |
| `toolMetadata` | 服务器 → `ToolMetadata[]`，启动时从缓存恢复，每次重连后原地更新。 |
| `config` | 最终合并后的 `McpConfig`（全局 + Pi 全局 + 项目 + 项目 Pi，`imports` 已展开）。 |
| `failureTracker` | `Map<serverName, lastFailureTimestamp>`，配合 `lazyConnect` 的 60 秒退避。 |
| `uiResourceHandler` | 通过 MCP `readResource` RPC 读取 `ui://` 资源，并归一化 CSP/权限元数据。 |
| `consentManager` | UI 宿主为 UI 端调用工具而维护的「每个服务器一次/始终/永不」缓存，默认为 `once-per-server`。 |
| `uiServer` / `completedUiSessions` | 当前活跃 UI 宿主句柄，以及已完成 session 的有界队列（最多 10 条），通过 `mcp({ action: "ui-messages" })` 取回。 |
| `openBrowser` / `ui` / `sendMessage` | 对 Pi 的反向钩子（打开 URL、弹通知、把 MCP-UI prompt/intent 推回去时附带 `triggerTurn`）。 |

## 服务器管理器（`server-manager.ts`）

`McpServerManager` 是连接账本，核心职责：

- **连接去重。** 同一服务器名并发 `connect()` 共享同一个 in-flight Promise（`connectPromises`）。
- **传输选择。** stdio 用 `StdioClientTransport`；HTTP 优先 `StreamableHTTPClientTransport`，探测失败时回退到 `SSEClientTransport`（`UnauthorizedError` 算作 StreamableHTTP 真实信号，不回退）。
- **npx 优化。** `resolveNpxBinary()` 在 npm 缓存里查真实二进制，把 spawn 改成 `node <bin>`（或裸二进制），跳过 npm 父进程。结果落在 `<agent dir>/mcp-npx-cache.json`。
- **Capability 注入。** 一旦 settings 启用了 sampling/elicitation，构造出的 `Client` 就对外宣告这些 capability，并把对应的请求处理器注册上去（`sampling-handler.ts`、`elicitation-handler.ts`）。
- **空闲簿记。** `touch()`、`incrementInFlight()`、`decrementInFlight()` 与每个连接的 `lastUsedAt`，让 `McpLifecycleManager.isIdle` 永远正确，关闭长调用结束后的服务器。
- **Stream 结果补丁。** UI 流式工具会发 `notifications/serverStreamResultPatch`；管理器按 `streamToken` 分发给 `ui-session.ts`。

`close` / `closeAll` 在 await SDK close 之前先把连接从 map 中同步删掉，避免 shutdown 期间并发的 `connect()` 创建的新连接被错误删除。

## Lifecycle 管理器（`lifecycle.ts`）

`McpServerManager` 上一层薄包装：

- `registerServer(name, definition, settings?)`：登记服务器定义与 per-server 空闲覆盖。
- `markKeepAlive(name, ...)`：把服务器加入健康检查轮询。
- `setGlobalIdleTimeout(minutes)` + per-server 覆盖。
- `startHealthChecks(intervalMs = 30000)`：启动 `setInterval`，负责：
  1. 重连 status 不是 `connected` 的 keep-alive 服务器。
  2. 关闭其他满足 `isIdle()` 阈值的服务器。
- `gracefulShutdown()`：清掉定时器，调用 `manager.closeAll()`。

reconnect 与 idle shutdown 回调在 `init.ts` 里设置，用于在事件发生时刷新 `toolMetadata` 与状态栏。

## 启动流程（`init.ts`）

`initializeMcp` 把启动串起来：

1. `loadMcpConfig(configPath, ctx.cwd)` 把四个文件槽位合并，展开 `imports`。
2. 构造 `manager`、`lifecycle`、`toolMetadata`、`failureTracker`、`uiResourceHandler`、`consentManager`，按 settings + `ctx.hasUI` 决定 sampling/elicitation。
3. 把 `openBrowser` / `sendMessage` 等反向回调塞进 state，供 UI 子系统使用。
4. 加载 `<agent dir>/mcp-cache.json`。若不存在则写入一份空的（从而让 `bootstrapAll` 触发一次全量元数据采集）；每个服务器会执行 `registerServer`，并在其缓存条目有效（hash 一致、年龄 ≤ 7 天）时把 `toolMetadata` 提前填好。
5. 决定 `startupServers`：keep-alive + eager（无缓存时为全部服务器）。
6. 并发连接（`parallelLimit`，并发 10）。成功后刷写 `toolMetadata` 与缓存；需要鉴权时返回 `needs-auth`；其他失败时把时间戳写进 `failureTracker`，并通过通知告知用户。
7. 启动后，如果设置了 `MCP_DIRECT_TOOLS` 且存在没有有效缓存的 direct tool 服务器，并发补齐缓存。
8. 接好 reconnect / idle shutdown 回调，启动 `lifecycle.startHealthChecks()`。

与 `initializeMcp` 一起导出：`lazyConnect`（proxy 和 direct 都会用）、`updateServerMetadata`、`updateMetadataCache`、`flushMetadataCache`、`updateStatusBar`、`getFailureAgeSeconds`。

60 秒退避逻辑住在 `failureTracker` 上；`lazyConnect` 在窗口内直接返回 `false`，避免对挂掉的服务无限重试。

## 元数据缓存（`metadata-cache.ts`）

`~/.pi/agent/mcp-cache.json` 是 tool 名、描述、input schema、UI 资源 URI、流模式以及无连接状态下的资源信息的真源。按服务器「身份字段」的 SHA-256 做键（hash 排除 lifecycle 类参数 `lifecycle`、`idleTimeout`、`requestTimeoutMs`、`debug`），所以这些字段改了不会让缓存失效。

`reconstructToolMetadata` 按 `ToolMetadata[]` 的形状重建，包括（默认开启时）合成的 `get_*` 资源工具。

缓存的版本（`CACHE_VERSION = 1`）和最大寿命（7 天）会在加载时强制检查；写入走 `writeFileSync` + `rename` 的原子写流程。

## Proxy vs Direct

### 代理工具（`proxy-modes.ts` + `index.ts` 注册的 `mcp`）

单个工具，根据参数切换模式。调度优先级：

```
ui-messages > auth-start > auth-complete > tool (call)
            > connect > describe > search > server (list) > 空（status）
```

- **`ui-messages`**：清空 `state.completedUiSessions`（上限 10）并返回 prompts / intents / notifications，附带从 `intent\n{json}` 解析出的 `handoffs`。
- **`auth-start`**：交互式 OAuth 时返回授权 URL。无头/远端场景由它把 URL 抛给模型。
- **`auth-complete`**：接受完整 `redirectUrl`、仅 `code`、或裸 code 字符串，最终化挂起的 transport。
- **`tool`**：通过 prefixed 名（`<server_prefix>_<tool>`）解析到 server + `ToolMetadata`，lazy 连接，对 `client.callTool`（若 metadata 有 `resourceUri` 则走 `readResource`）发起调用。会处理 signal、UI session、output guard、auto-auth。
- **`connect`**：强制连接（`lazy` 模式下 handshake 用的入口），刷新元数据，返回当前列表。
- **`describe`**：跨服务器模糊匹配（`findToolByName` 支持 hyphen/underscore 互换）。
- **`search`**：默认是空格分隔的子串 OR；`regex: true` 切到正则，`recheck` 会做安全性校验。
- **`server`**：列单个服务器的工具。仅命中缓存时提示 `(not connected, cached)`。
- **status**：列出每个服务器 connected / cached / needs-auth / failed 的状态。

### Direct Tools（`direct-tools.ts`）

`resolveDirectTools()` 遍历元数据缓存（不需真实连接），返回 effective `directTools` 非 false 的所有服务器的扁平 `DirectToolSpec[]`。结果按名称去重，撞上 Pi 内置名（`read`、`bash`、`edit`…）会被跳过并打印警告。Per-server `excludeTools` 也在这里生效。

扩展在模块加载阶段（`session_start` 之前）就为每个 spec 注册一个 Pi 工具，绑定到 `createDirectToolExecutor`。该执行器：

- 若需要则等 `initPromise` 完成；未初始化时返回带 `details.error` 的结果。
- 调 `lazyConnect(state, serverName, ...)`；连接 `needs-auth` 时，可能在 `settings.autoAuth` 与（UI session 或 `client_credentials`）的前提下尝试 `attemptDirectAutoAuth` 一次。
- 把请求转给 `client.callTool`；若 metadata 含 `uiResourceUri`，则通过 `maybeStartUiSession` 打开 MCP UI session。
- 经 `guardMcpOutput` 后返回 `{ content, details }`。

`MCP_DIRECT_TOOLS="__none__"` 完全关闭 direct tool 注册（脚本化场景用）。

## Output Guard（`mcp-output-guard.ts`）

Proxy 与 direct executor 都把 text/image 内容交给 `guardMcpOutput`：

- 文本块合并后按 `maxBytes`（默认 50 KiB）与 `maxLines`（默认 2000）截断。超长会用头部预览 + 「全文已落到…」提示替换，并把原文写到 `0600` 权限的临时文件里。临时文件不会被自动清理。
- 图片块保持原样，仍是 provider 原生图片内容。
- Proxy 还会约束 `details.mcpResult`：JSON 超过 `detailsMaxBytes`（默认 16 KiB）后改为结构化摘要（块数、大小、键预览），原始 JSON 落到相邻临时文件。
- 当 `settings.outputGuard === false` 或 `MCP_OUTPUT_GUARD=0` 时，整个 guard 全部短路。

## MCP UI 集成

当工具 metadata 包含 `_meta.ui.resourceUri`（由 `@modelcontextprotocol/ext-apps` 的 `getToolUiResourceUri` 提取）时，proxy/direct executor 会走 `maybeStartUiSession` 路径而不是直接把 tool result 交回。

`ui-session.ts` 负责整个生命期：

1. 如果同一个 `(server, tool)` 已经存在 `state.uiServer`，就复用：推一次 `tool-input`，对流式调用注册 stream patch 监听，返回 `reused: true` 的 `UiSessionRuntime`；模型看到的只是「Updated the open UI」一句话。
2. 否则由 `UiResourceHandler` 读取 `ui://...` 资源（text 或 base64 解码后的 blob），构造 host context，再通过 `startUiServer` 起一个 per-session HTTP 服务。
3. 服务器在 `127.0.0.1:<random>` 监听后，宿主 HTML 渲染。Viewer 选择：
   - macOS 安装了 `glimpseui`（`pi install npm:glimpseui`）：原生 WKWebView 窗口。
   - 其他：通过 `state.openBrowser` 用 OS 默认浏览器打开（`pi.exec` 路径）。
   - `MCP_UI_VIEWER=glimpse` 强制原生，`browser` 强制浏览器。
4. 消息走宿主页面 → `/proxy/ui/message`，服务端按 prompt / intent / notify 分类。prompt 与 intent 通过 `state.sendMessage({...}, { triggerTurn: true })` 推回来，触发新的一轮 agent。已完成的 session 入队 `state.completedUiSessions`（容量 10），等下一次 `mcp({ action: "ui-messages" })` 拉走。
5. UI 主动发起的 tool call 走 `/proxy/tools/call`，过 `consentManager`。默认 `once-per-server`，首次会向用户弹审批；之后按 always/never/dismissed 决定放行。

`UiServerHandle` 通过 SSE 推送 `tool-input`、`tool-result`、`result-patch`、`host-context`、`session-complete`，并且支持 `Last-Event-ID` 断线重连时的事件重放。还有一个 60 秒闲置 watchdog 自动结束 session。

`app-bridge.bundle.js` 是预打包好的（~408 KB），浏览器侧不再需要按需 bundle，直接用 MCP SDK + Zod。

## OAuth（`mcp-auth-flow.ts`、`mcp-oauth-provider.ts`、`mcp-callback-server.ts`）

OAuth 走 MCP SDK 的 `auth()` 驱动加上本地进程内回环回调服务：

1. **准备。** `extractOAuthConfig(definition)` 输出 `McpOAuthConfig`（可选 `clientId`、`redirectUri`、scope 等）。
2. **State + 回调。** `startAuth()` 生成 256 bit 随机 state，调用 `mcp-callback-server.ts` 的 `ensureCallbackServer({ oauthState, strictPort: clientId || redirectUri })`。`strictPort: true` 时由 OS 分配空闲端口，否则按 `redirectUri` 精确匹配。
3. **Auth 驱动。** `runSdkAuth(authProvider, { serverUrl })` 要么返回 `AUTHORIZED`，要么通过 `McpOAuthProvider.onRedirect` 抓取授权 URL。
4. **挂起 transport。** 抓到 URL 时，把相同 auth provider 的 `StreamableHTTPClientTransport` 放到 `pendingTransports`，最长保留 `MANUAL_AUTH_TIMEOUT_MS`（5 分钟）。URL 返回给调用方。
5. **浏览器交互。** `authenticate()` 启动 OS 浏览器，然后 `waitForCallback(state)` 等待回调。无界面 / 远程场景下显式调用 `startAuth()`，把 URL / copy-back 通过代理工具暴露。
6. **结束。** `parseAuthorizationCodeInput` 把 raw code / query 字符串 / 完整回环 URL 都解析成 code；transport 调用 `finishAuth`；`getOAuthState` / `clearOAuthState` 完成 CSRF state 校验。

`getValidToken()` 在 token 过期且有 `refreshToken` 时通过 SDK 走刷新流程。`removeAuth()` 清掉凭据并取消该服务器所有挂起的回调。

`initializeOAuth()` / `shutdownOAuth()` 是 `index.ts` 调用的入口，确保 `session_restart` 时任何「手动 OAuth」都能干净退出。

## Sampling（`sampling-handler.ts`）

Settings 启用时，客户端宣告 `sampling`，处理器把 `CreateMessageRequest` 路由到 Pi 的 model registry：

- 非文本内容、tool use、tool choice、stop sequence、`includeContext` 之外的取值都会显式拒绝，仅支持纯文本 Sampling。
- `resolveSamplingModel` 按 `modelPreferences.hints` 顺序匹配，再回退到当前模型，再到任意可用模型；每个模型都跑一次 `getApiKeyAndHeaders` 拿鉴权。
- 调模型前 + 返回结果前都过 `ctx.ui.confirm` 做两次确认。`samplingAutoApprove: true` 全部跳过 —— 这是非 UI 模式下想要 Sampling 必须打开的开关。

## Elicitation（`elicitation-handler.ts`）

客户端宣告 `elicitation: { form: {}, ...(allowUrl ? { url: {} } : {}) }`。URL 模式只会在 `isTuiMode(ctx)` 为真时附加。

- **Form 模式。** 把 schema 拆成每个字段一个 `select`/`input`，按类型选择交互（enum、oneOf、多选、boolean）。输入后用 Ajv 校验，用户先看 review 后再确认。「Decline」映射为 `decline`，dialog 关闭映射为 `cancel`。
- **URL 模式。** 显式同意对话框列出 server、host 与完整 URL，确认后用 `open` 包打开，结束时通过 `elicitation-complete` 通知；执行器看到后通知用户。
- `client.callTool` 抛出的 `UrlElicitationRequiredError`（SDK 的 `-32042` 信号）被两个 executor 捕获，交给 `handleUrlElicitation`，要么返回「去浏览器完成后再重试」，要么返回动作（`accept` / `decline` / `cancel`）。

## 状态栏

`updateStatusBar(state)` 把 `MCP: <connected>/<total> servers` 推给 `ctx.ui.setStatus`。Lazy 连接进行中时 `state.ui.setStatus` 还会临时显示 `MCP: connecting to …`。

## In-flight / 失败追踪

`McpServerManager` 暴露 `incrementInFlight` / `decrementInFlight`。两个 executor 把每次 `callTool` / `readResource` 包在这对调用里，让 `isIdle()` 不会在长调用中间把进程关了。

`failureTracker` 记每个服务器上次连接失败的时间戳。`lazyConnect` 在 `FAILURE_BACKOFF_MS`（60 s）窗口内直接返回 `false`。窗口结束缓存项失效后再调用就正常重试。这就是 `mcp({})` / `/mcp` 显示 `failed Xs ago` 与防止短重试循环的原因。

## 模块地图

| 文件 | 角色 |
|------|------|
| `index.ts` | 扩展工厂、工具注册、session 生命周期装配。 |
| `state.ts` | `McpExtensionState`、消息类型。 |
| `types.ts` | 配置、服务器、tool/resource 类型；tool 名/排除辅助。 |
| `config.ts` | 配置发现、合并、`imports` 与共享 server entry 的预览/写入。 |
| `metadata-cache.ts` | `~/.pi/agent/mcp-cache.json` 的读 / 写 / hash / 重建。 |
| `init.ts` | `initializeMcp` + 辅助函数（`lazyConnect`、`updateServerMetadata`…）。 |
| `lifecycle.ts` | keep-alive / 空闲 / 健康检查协调。 |
| `server-manager.ts` | 连接账本、传输、npx 解析、UI stream demux。 |
| `proxy-modes.ts` | `mcp` 工具的各模式（`executeStatus`、`executeSearch`、`executeCall`…）。 |
| `direct-tools.ts` | `resolveDirectTools`、`getMissingConfiguredDirectToolServers`、`buildProxyDescription`、per-tool executor 工厂。 |
| `commands.ts` | `/mcp` 与 `/mcp-auth` 命令处理器、状态辅助、面板装配。 |
| `npx-resolver.ts` | 把 `npx -y foo` 解析为实际缓存里的二进制，跳过 npm。 |
| `mcp-auth-flow.ts` | OAuth 协调（start / complete / refresh / logout）。 |
| `mcp-auth.ts` | token 存取与 TTL 辅助。 |
| `mcp-oauth-provider.ts` | `McpOAuthProvider` 实现。 |
| `mcp-callback-server.ts` | 抓 OAuth `code` 的回环 HTTP 监听器。 |
| `sampling-handler.ts` | MCP `CreateMessageRequest` 处理器。 |
| `elicitation-handler.ts` | MCP `ElicitRequest` 处理器（form + URL）。 |
| `ui-resource-handler.ts` | 读取并校验 `ui://...` 资源。 |
| `ui-session.ts` | 打开 / 复用 MCP UI session、流式补丁、完成队列。 |
| `ui-server.ts` | 每会话 HTTP 宿主，提供 `/`、`/events`、`/ui-app`、`/proxy/...`。 |
| `host-html-template.ts` | 包住 UI iframe 与 AppBridge bundle 的 HTML 壳。 |
| `glimpse-ui.ts` | 可选的 macOS WKWebView 渲染器。 |
| `consent-manager.ts` | UI 端 tool call 的服务器级 allow/deny。 |
| `mcp-output-guard.ts` | 输出限幅 → 临时文件溢出。 |
| `tool-result-renderer.ts` | proxy / direct 调用与结果的紧凑渲染。 |
| `tool-metadata.ts` | `buildToolMetadata`、模糊 `findToolByName`、schema 格式化。 |
| `resource-tools.ts` | resource → 合成 tool 名的转换。 |
| `panel-keys.ts` / `mcp-panel.ts` / `mcp-setup-panel.ts` | `/mcp` TUI 浮层。 |
| `onboarding-state.ts` | 首次启动提示指纹。 |
| `errors.ts` | 类型化错误（`McpUiError`、`ConsentError`、`ServerError`…）。 |
| `abort.ts` | AbortSignal + promise cancel 辅助。 |
| `logger.ts` | 按 component 标签的 debug / error logger。 |
| `cli.js` | `pi-mcp-adapter init`（检测 host 配置、为 Pi 写 imports）。 |
| `app-bridge.bundle.js` | `ui-server.ts` 吐出来的浏览器 SDK + Zod 包。 |

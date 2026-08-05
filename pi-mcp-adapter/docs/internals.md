# 内部模块

把一些值得了解、但不是普通用户也得看的子系统收集在这里，方便后续贡献者与深挖者。

## npx 解析器（`npx-resolver.ts`）

启动 `npx -y some-server@latest` 时，即便包已经在本地缓存里，也会额外拉起约 143 MB 的 npm 父进程。`McpServerManager` 在构造 stdio transport 之前会先调 `resolveNpxBinary(command, args)`。

工作过程：

1. **解析。** 判断是 `npx …` 还是 `npm exec -- …`，分离出 `packageSpec`（`some-server@latest`）、可选的显式 bin 名以及后置位置参数。识别 `-y`、`-p` 等 flag。产出 `{ packageSpec, binName?, extraArgs }`。
2. **命中缓存。** 一份 TTL 24h 的缓存（`<agent dir>/mcp-npx-cache.json`）按完整 `npx …` 命令字符串做键，映射到 `{ resolvedBin, packageVersion, isJs }`。命中则直接返回。
3. **在 npm 缓存里解析。** 走 `npm config get cache` 拿本地缓存目录，遍历 `<cache>/_npx/<dir>/node_modules/<pkg>`（按 mtime 倒序），挑最新的。从 `package.json` 的 `bin` 字段挑出与命令行匹配、或按 package 默认 / 首个 entry 的二进制。
4. **慢路径。** 没命中时执行 `npm exec --yes --package <spec> -- node -e 1`，让 npx 把缓存填上，再走第 3 步。
5. **JS vs 原生。** 检测 `isJs`：是则在 spawn 时套一层 `node <bin> <extraArgs>`，否则直接 `<bin> <extraArgs>`。

效果：lazy 连接完全跳过 npm 父进程。失败一律回退到原始 `command` 路径，因此该解析器是 best-effort，不是阻塞式。

## 本地 UI 宿主（`ui-server.ts`）

MCP UI 宿主是一个只绑 `127.0.0.1` 的 HTTP 服务器，端口 OS 分配（或 OAuth 预注册要求精确匹配时指定）。每个 session 拿到一个唯一 `sessionToken`（UUID），既作为 `GET /` 的 query 参数，也是每个 `POST /proxy/...` body 里的字段。

端点：

| Method | Path | 用途 |
|--------|------|------|
| GET | `/` | 渲染宿主 HTML 壳（注入 AppBridge bundle URL、host context、可选 CSP meta）。 |
| GET | `/`ui-app | 输出资源本身的 HTML，并套用配置的 CSP。 |
| GET | `/events` | SSE 流，事件为 `tool-input`、`tool-result`、`result-patch`、`host-context`、`session-complete`。支持 `Last-Event-ID` 重放（从最近 checkpoint 或缓冲日志回放）。 |
| GET | `/app-bridge.bundle.js` | 预打包好的 AppBridge SDK + Zod，year 长 Cache-Control。 |
| POST | `/proxy/tools/call` | UI 端发起的 tool call，过 `ConsentManager`。 |
| POST | `/proxy/ui/consent` | 登记服务器级 approve / deny。 |
| POST | `/proxy/ui/message` | UI 消息（prompt / intent / notify）。 |
| POST | `/proxy/ui/context` | UI 发来的 model context 更新。 |
| POST | `/proxy/ui/open-link` | 校验 UI 想打开的链接（实际打开由宿主的 `state.openBrowser` 负责）。 |
| POST | `/proxy/ui/download-file` | 目前返回错误结果（下载尚未接通）。 |
| POST | `/proxy/ui/request-display-mode` | 切换 `inline` / `fullscreen` / `pip`。 |
| POST | `/proxy/ui/heartbeat` | 探活。 |
| POST | `/proxy/ui/complete` | 标 session 完成，再关闭服务。 |

### 流模式

工具 metadata 带 `uiStreamMode` 时：

- `eager` → 把每次中间 `notifications/serverStreamPatch` 包装成结构化 envelope（`streamId`、`sequence`、`phase: "partial"/"checkpoint"/"settled"`），塞进 `structuredContent["pi-mcp-adapter/stream"]`。
- `stream-first` → 同样的 envelope，但告知 `partialInput`，最初把工具入参后压，先由 UI 驱动。

### Watchdog

每 5 秒的 `setInterval` 看一下 `lastHeartbeatAt`：超过 60 秒没动就标 `stale` 并关闭。`server.listen()` 与 watchdog 都 `unref()`，不会阻塞 Pi 退出。

## ConsentManager（`consent-manager.ts`）

用于「UI 服务器调起工具时是否需要再次征求用户同意」。三档：

| 模式 | 行为 |
|------|------|
| `"never"` | UI 端的调用永远拒绝，返回 `ConsentError("approval required")`。 |
| `"once-per-server"`（默认） | 每个服务器每个会话首次调用弹一次 UI 审批，之后缓存下来。 |
| `"always"` | 每次调用都要重新审批。 |

宿主页面用 `consentManager.requiresPrompt(serverName)` 决定是否渲染「Approve tool access」按钮，`/proxy/ui/consent` 写入决定。

## 元数据缓存（`metadata-cache.ts`）与 Output Spill（`mcp-output-guard.ts`）

两者共享同一套写法：parse → 限幅检查 → 写 `<file>.<pid>.tmp` → rename。都共用 `<agent dir>` 根目录；都能容忍半成品文件（解析失败就当空）；都有 version 字段保证老格式能干净丢弃。

截断临时文件用 `mkdtemp(join(tmpdir(), "pi-mcp-output-"))` 创建，文件名形如 `<kind>-<random>.txt`，权限 `0o600`，不会被自动清理——README 里专门提示过：溢出的内容可能含敏感数据。

## OAuth 内部（`mcp-auth.ts`、`mcp-oauth-provider.ts`、`mcp-callback-server.ts`）

- `mcp-auth.ts` 包装底层 token 存储：`getAuthForUrl(serverName, serverUrl)`、`isTokenExpired`、`clearAllCredentials` 等。State（OAuth `state`）也按 `(serverName, serverUrl)` 持久化，让多 URL 服务器与重命名天然隔离。
- `McpOAuthProvider` 实现 SDK 的 `OAuthClientProvider`（client info、redirect URL、code verifier、tokens、`auth()` 回调）。`onRedirect` 抓 URL 而不打浏览器，浏览器让上层 `authenticate()` 来开。
- `mcp-callback-server.ts` 是按 `oauthState` 隔离的回环 HTTP 监听器，配合 strict-port：`strictPort: true`（即预注册 client）严格匹配 `redirectUri`。
- `parseAuthorizationCodeInput` 是个小能手：能接受 raw code、query 字符串（`code=…&state=…`）或完整的回环 URL；同时把 hash 参数与错误合并成同一 shape。

CSRF 校验做了两遍：一次在 `auth-complete` 时检查（`expectedState`），一次在 `completeAuth` 内（落盘的 state 与启动时生成的对齐）。

## Logger（`logger.ts`）

`logger.child({ component: ... })` 返回带元数据标签的子 logger，所有日志自动带上这些字段。UI 子系统里大量用来给每个 server 打 trace tag，避免污染全局状态。

## Abort（`abort.ts`）

`throwIfAborted(signal)`、`abortable(promise, signal)` 让 executor 把取消信号干净地透出 `callTool` / `readResource`。abort signal 组合进 SDK 的 `RequestOptions`（`{ signal }`），再串到宿主 UI session 中。

## 磁盘上的文件清单

| 文件 | 拥有者 | 用途 |
|------|--------|------|
| `~/.config/mcp/mcp.json` | user | 只读的标准 MCP 配置。 |
| `<agent dir>/mcp.json` | Pi | 全局覆盖 + imports + adapter 私有字段。 |
| `.mcp.json` / `.pi/mcp.json` | project | 同上，但作用域为项目。 |
| `<agent dir>/mcp-cache.json` | Pi | 服务器 tool/resource 元数据。 |
| `<agent dir>/mcp-npx-cache.json` | Pi | 解析后的 npx 二进制。 |
| `<agent dir>/onboarding-state.json` | Pi | 共享配置提示指纹。 |
| `<agent dir>/auth/<server>/*` | Pi | 按服务器持久化的 OAuth token、client info、code verifier、state。 |
| `os.tmpdir()/pi-mcp-output-…/` | extension | 超长 MCP text/details 的溢出文件，不会被清理。 |

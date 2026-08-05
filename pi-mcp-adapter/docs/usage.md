# 用法

## 代理工具 `mcp`

`mcp` 注册时有少量可选参数；每次调用只走一种模式，调度顺序：

```
ui-messages > auth-start > auth-complete > tool (call)
            > connect > describe > search > server (list) > status
```

| 模式 | 参数 | 说明 |
|------|------|------|
| status | （无） | 列出所有配置服务器、连接状态、工具数与 `failed Xs ago`。 |
| list | `server: "<name>"` | 列单服务器工具。仅缓存命中时打 `(not connected, cached)` 提示。 |
| search | `search: "<query>"`（可选 `regex: true`、`server: "<name>"`、`includeSchemas: false`） | 工具名 + 描述的子串 OR。带 Pi 工具时会显示在最前并加 `[pi tool]` 前缀。下划线/连字符互通：`context7_resolve_library_id` 能命中 `context7_resolve-library-id`。 |
| describe | `describe: "<tool_name>"`（可选 `server: "<name>"`） | 工具描述 + 参数 schema。 |
| call | `tool: "<name>", args: '{"k":"v"}', [server: "<name>"]` | 调用工具。`args` 是 JSON 字符串（proxy 解析一次）。 |
| connect | `connect: "<server-name>"` | 强制 lazy connect 并刷新元数据。 |
| ui-messages | `action: "ui-messages"` | 取走已完成 MCP UI session 的消息队列（prompt / intent / notification + `intent\n{json}` 形式的 handoff）。 |
| auth-start | `action: "auth-start", server: "<name>"` | 无头场景下取 OAuth 授权 URL。 |
| auth-complete | `action: "auth-complete", server: "<name>", args: '{"redirectUrl":"…"}'`（也接受 `{"code":"…"}`） | 贴回 redirect URL 或仅 `code` 查询参数。 |

`settings.autoAuth` 打开时，`connect` 与 `call` 会在服务器返回 `needs-auth` 时自动跑 OAuth 一次并重试；否则结果文本会告诉模型走哪条 `auth-start` / `auth-complete` 流程。

### 简单示例

```
mcp({ })                                                  # status
mcp({ server: "chrome-devtools" })                        # 列出该服务器工具
mcp({ search: "screenshot navigate" })                    # 子串搜索
mcp({ describe: "chrome_devtools_take_screenshot" })      # 描述工具
mcp({ tool: "chrome_devtools_navigate", args: '{"url":"https://example.com"}' })
mcp({ connect: "linear-server" })
mcp({ action: "ui-messages" })
mcp({ action: "auth-start", server: "linear-server" })
mcp({ action: "auth-complete", server: "linear-server", args: '{"redirectUrl":"http://localhost:19876/callback?code=…&state=…"}' })
```

结果默认渲染很紧凑（前 3 行 + `Ctrl+O to expand`），但实际返回给模型的内容仍是完整的。

## Direct Tools

服务器设置了 `directTools: true` 或 `directTools: ["a","b"]` 后，对应工具就是一等 Pi 工具，与 `read`、`bash`、`edit` 并列：

```
get_file_contents({ repo: "badlogic/pi-mono", path: "README.md" })
```

行为和 proxy 调用基本一致，但有几个差别：

- 系统提示里带着完整 input schema（每个工具约 150–300 tokens）。
- 结果不带 `details.mcpResult`，仅在截断时携带 `details.outputGuard`。
- 输出仍走 `guardMcpOutput`，UI 类工具同样会打开 MCP UI 宿主。

扩展在模块加载时从元数据缓存注册 direct tools，因此不需要先有真实连接。执行流程：

```
direct executor ──► lazyConnect（或缓存即用） ──► 鉴权检查
                                                     │
                                                     ├── needs-auth? autoAuth? 重试
                                                     │
                          callTool / readResource ───┤
                                                     │
                          output guard ─────────────►┴──► Pi 工具结果
```

UI 场景下，direct 调用与 proxy 走完全相同的 `maybeStartUiSession`，打开、复用、流式 patch 都一致。

## 命令

| 命令 | 行为 |
|------|------|
| `/mcp` | 打开交互式服务器面板，显示连接状态、工具数、direct/proxy 切换。在 OAuth 服务器上按 Enter 或 `ctrl+a` 触发鉴权。 |
| `/mcp setup` | 引导式首次配置：检测共享 MCP 文件、接纳 host imports、初始化一个最小 `.mcp.json`、快速加入 RepoPrompt、打开已发现的配置路径。写盘前 `previewX → writeX` 会出 diff，TUI 总能先看再保存。 |
| `/mcp tools` | 按 prefixed 名列出全部 MCP 工具。 |
| `/mcp reconnect` | 重连所有服务器。 |
| `/mcp reconnect <server>` | 重连单个服务器。 |
| `/mcp logout <server>` | 清除该服务器的 OAuth 凭据并断开连接。 |
| `/mcp-auth` | 在交互式 UI session 中打开 OAuth 服务器选择器。 |
| `/mcp-auth <server>` | 针对特定服务器开始 OAuth。 |

面板里的 direct-tool 切换、`/mcp setup` 写入的配置都会落盘并触发 Pi 的 reload 流程，新 direct tool 注册无需手动重启。

## CLI 助手：`pi-mcp-adapter init`

`pi install npm:pi-mcp-adapter` 安装后，可以再跑 `pi-mcp-adapter init`（加 `--dry-run` 仅查看）：

- 发现 4 个配置路径并报告哪些存在。
- 探测 host 配置（`cursor`、`claude-code`、`claude-desktop`、`codex`、`windsurf`、`vscode`）。
- 把缺失的 imports 加到 `<agent dir>/mcp.json`。

CLI 不会写入标准的 `~/.config/mcp/mcp.json` 或 `.mcp.json`。把它当成「把 Pi 与其他 host 同步」的标准做法。

## OAuth 流程

### 交互式会话

1. 跑 `/mcp-auth <server>`（或在 `/mcp` 中 Enter 选中的服务器）。
2. `authenticate()` → `startAuth()` → `ensureCallbackServer` → SDK 的 `auth()` 驱动。
3. 抓到回调 URL 时用 OS 浏览器打开。
4. 回调服务器记录 `code` → SDK 跑 `finishAuth` → 凭据落盘 → `/mcp reconnect <server>` 完成连接。

面板上相应服务器的 `needs-auth` 会消失。

### 远程 / 无头会话

Pi 跑在不能开浏览器的环境时：

1. `mcp({ action: "auth-start", server: "<name>" })` 返回授权 URL 与需要贴回的 `redirectUrl`。
2. 在本地浏览器打开。浏览器会跳到 `http://localhost:<port>/callback?code=...&state=...`。在远端机器上页面也许打不开，地址栏里的 URL 仍然带着 code。
3. 贴回完整 URL 或只贴 `code`：

```
mcp({
  action: "auth-complete",
  server: "<name>",
  args: '{"redirectUrl":"http://localhost:19876/callback?code=…&state=…"}'
})
```

State 在启动时持久化，回填时校验；不匹配会返回 `OAuth state mismatch` 错误。

`client_credentials`（`oauth.grantType: "client_credentials"`）彻底跳过浏览器——server 支持时可拿来跑非交互机器鉴权。

### 重新鉴权 / 注销

- token 过期或被吊销后调 `mcp({ tool: "foo" })` 会触发 `getValidToken`，有 `refreshToken` 就走 SDK 刷新。
- `/mcp logout <server>`（或面板里的 logout 操作）清除该服务器凭据并关闭连接。

授权 URL 与 code 都是敏感信息——它们在过期/完成前都相当于对 MCP server 的访问许可。

## MCP UI / Glimpse

当工具返回的 metadata 带 `_meta.ui.resourceUri` 时，proxy/direct executor 切到 MCP UI 模式：

1. `UiResourceHandler.readUiResource` 读 `ui://...` 并归一化 CSP/权限。
2. `startUiServer` 在 `127.0.0.1:<random>` 启动会话级 HTTP 服务器（OAuth 预注册要求固定端口时例外）。
3. 渲染宿主 HTML。Viewer 选择：
   - macOS 安装 `glimpseui`（`pi install npm:glimpseui`）：原生 WKWebView。
   - 其他：用 OS 默认浏览器（通过 `pi.exec`，`MCP_UI_VIEWER=browser` 时强制）。
   - `MCP_UI_VIEWER=glimpse` 强制原生。
4. UI 通过 `/proxy/ui/message` 与 agent 通信。四种 shape：

| type | 行为 |
|------|------|
| `prompt` | 用户消息；`state.sendMessage` 把它推成 `mcp-ui-prompt` 并触发新一轮 agent。 |
| `intent` | 带 `name` + `params` 的结构化动作；同样触发新一轮，标记 `mcp-ui-intent`。 |
| `notify` | 单向通知；用 `ctx.ui.notify` 弹出。 |
| `message` | 通用消息体，按 notify 处理。 |
| （自定义） | 其他全部以 `name` 为 type 的 intent 转发。 |

UI 端发起的 tool call 必须过 `ConsentManager`：每个服务器每个会话最多一次授权，之后按 always / never 决定。

拉回 UI 消息：

```
mcp({ action: "ui-messages" })
```

Proxy 会清空 `state.completedUiSessions`（容量 10），返回 prompts / intents / notifications，再加上解析过的 `handoffs`（用于 `intent\n{json}` payload）。

### 复用与流式

同一个 `(server, tool)` 在 UI 已开的情况下再调一次，会通过 SSE 发 `tool-input`，对流式工具（`uiStreamMode: "eager"` 或 `"stream-first"`）还会把每个 `notifications/serverStreamResultPatch` 推给已经打开的窗口。模型只看到新一轮 tool result。

## Sampling & Elicitation

`sampling-handler.ts` 与 `elicitation-handler.ts` 注册为 MCP 客户端请求处理器。是否可见由 settings 控制：

- `settings.sampling`（UI 存在时默认 `true`）宣告 `sampling: {}`。无 UI 时必须同时打开 `settings.samplingAutoApprove: true`，因为调模型前 + 返回结果前各需要一次 `ctx.ui.confirm`。
- `settings.elicitation`（UI 存在时默认 `true`）宣告 `elicitation.form`。URL 模式仅在 TUI 模式下附加（通过 `isTuiMode` 判断）。

URL elicitation 必须由用户显式同意：对话框展示服务器、host 与完整 URL，打开浏览器前再次确认。完成后 SDK 会发 `elicitation-complete` 通知，executor 收到后提示用户。

`callTool` 抛出的 `UrlElicitationRequiredError`（SDK 的 `-32042` 信号）被 proxy / direct 共同捕获，转交给 `manager.handleUrlElicitationRequired`，然后返回「去浏览器完成后再重试」或对应动作（`accept` / `decline` / `cancel`）。

## 模型看到的失败信息

| 场景 | 反馈 |
|------|------|
| Tool 调用的服务器处于 `needs-auth` | Executor 返回 `details.error === "auth_required"`，并附上 proxy 同款 auth-start 引导。`autoAuth` 打开时会自动跑 OAuth 并重试一次。 |
| 还在退避窗口内 | 返回 `details.error === "server_backoff"`；`/mcp` 在同一窗口也会显示 `failed Xs ago`。 |
| 输出超过 guard 上限 | `content` 末尾追加 `<truncation-notice>`，并附带 `details.outputGuard`（含 `fullOutputPath`、`originalBytes` 等）。原文落在 `0600` 临时文件。 |
| Proxy `details.mcpResult` 超过 `detailsMaxBytes` | JSON 被替换成 `details.mcpResult` 摘要对象，原始 JSON 落在与截断文件相邻的临时文件。 |
| UI session 无法打开 | `tool_result` 当作普通文本返回（无 UI metadata），`ctx.ui.notify` 弹个 warning。URL elicitation 错误会变成结构化的重试文本。 |
| 生命周期 / abort | `tool_result` 事件覆写（`error-signal.ts`）把返回的 `isError` 重新归类为真错误，让 Pi 记入 error 流。 |

## 调参速查

| 目标 | 设置 |
|------|------|
| 减少 proxy noise | 给最吵的服务器配 `directTools`，其余的写 `excludeTools`。 |
| 关闭 Glimpse | 设置 `MCP_UI_VIEWER=browser` 后再启动 Pi。 |
| 全局关闭输出截断 | `settings.outputGuard = false` 或 `MCP_OUTPUT_GUARD=0`。 |
| 非 UI 模式运行 Sampling | `settings.samplingAutoApprove = true`。 |
| 允许 URL elicitations | 用 TUI 模式启动 Pi，并把 `settings.elicitation` 留着。 |
| 复用其他 agent dir 的 OAuth token | 启动 Pi 前设置 `PI_CODING_AGENT_DIR`，让两边的 `mcp-auth` 写读同一个目录。 |
| 指定自编译的 Glimpse | `GLIMPSE_BINARY=/path/to/glimpse`。 |
| 让某个服务器走 direct、绕过全局默认 | per-server `directTools` 写成字符串数组。 |

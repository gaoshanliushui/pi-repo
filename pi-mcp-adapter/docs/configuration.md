# 配置

`pi-mcp-adapter` 从一组分层配置文件 + 可选的兼容性 `imports` 读取 MCP 配置。`settings` 与所在配置文件一起被读取，只有 Pi 自有文件会被改写（用于存 adapter 特有的字段）。

## 文件布局

按下列顺序读取（同一槽位内优先级从上到下）。若文件存在则视为命中：

| 槽位 | 路径 | 作用范围 | 类型 | 说明 |
|------|------|---------|------|------|
| 用户全局共享 | `~/.config/mcp/mcp.json` | user | shared | 标准 MCP 路径，Pi 只读不写。 |
| Pi 全局覆盖 | `<Pi agent dir>/mcp.json`（默认 `~/.pi/agent/mcp.json`） | user | pi-owned | 放置 `imports` 与 adapter 私有字段（如 `directTools`）。 |
| 项目共享 | `<cwd>/.mcp.json` | project | shared | 项目级标准配置。 |
| 项目 Pi 覆盖 | `<cwd>/.pi/mcp.json` | project | pi-owned | 项目级 Pi 私有覆盖。 |

`<Pi agent dir>` 在设置了 `$PI_CODING_AGENT_DIR` 时取该值，否则为 `~/.pi/agent`。

> Pi 只写 Pi 自有文件。标准 `~/.config/mcp/mcp.json`、`.mcp.json` 一律只读。如果某服务器是从这些「共享」文件里来的，而你想写入 `directTools` 之类的 adapter 私有字段，覆盖会被写到同名键下的 Pi 自有覆盖文件里。

## ServerEntry 字段

所有字段都位于 `mcpServers.<name>` 下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | string | stdio 传输要执行的命令。 |
| `args` | string[] | `command` 的参数。 |
| `env` | object | 额外的环境变量，支持 `${VAR}` 与 `$env:VAR` 插值。 |
| `cwd` | string | 工作目录，支持 `${VAR}`、`$env:VAR`、`~/`。 |
| `url` | string | HTTP 端点（Streamable HTTP，失败回退到 SSE）。 |
| `headers` | object | HTTP 头，支持环境变量插值。 |
| `auth` | `"oauth"` \| `"bearer"` \| `false` | 鉴权模式；HTTP 服务器未配置 `headers` 时省略该项会自动走 OAuth。 |
| `oauth.grantType` | `"authorization_code"` \| `"client_credentials"` | 默认 `authorization_code`；`client_credentials` 不打开浏览器。 |
| `oauth.clientId` | string | 预注册的 client ID；省略时走动态注册。 |
| `oauth.clientSecret` | string | 机密客户端用的密钥。 |
| `oauth.scope` | string | 请求的 OAuth scope。 |
| `oauth.redirectUri` | string | 预注册到 Provider 的回环 redirect URI；动态客户端可以省略，由 OS 分配本地端口。 |
| `oauth.clientName` / `oauth.clientUri` | string | 动态注册时对外展示的名称 / 主页。 |
| `bearerToken` | string | 静态 bearer token，支持环境变量插值。 |
| `bearerTokenEnv` | string | bearer token 所在的环境变量名。 |
| `lifecycle` | `"lazy"` \| `"eager"` \| `"keep-alive"` | 默认为 `lazy`。见 [Lifecycle 模式](#lifecycle-模式)。 |
| `idleTimeout` | number | 空闲断开分钟数，会覆盖全局。 |
| `requestTimeoutMs` | number | 单次实时调用的超时（毫秒）；`<= 0` 退回到 SDK 默认。 |
| `exposeResources` | boolean | 把 MCP 资源暴露成 `get_*` 代理工具，默认 `true`。 |
| `directTools` | `true` \| `string[]` \| `false` | 把指定工具直接注册为 Pi 工具，详见 [Direct Tools](#direct-tools)。 |
| `excludeTools` | string[] | 按原名或加前缀的名称隐藏工具，对 direct / proxy search/list/describe 与 `/mcp` 面板都生效。 |
| `debug` | boolean | 把 stdio 服务器的 stderr 透传给 Pi（默认丢弃）。 |

### 最简 stdio 示例

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

### 带自定义 header 的 HTTP 服务器

```json
{
  "mcpServers": {
    "figma": {
      "url": "http://localhost:3845/mcp",
      "headers": { "X-Auth": "bearer ${FIGMA_TOKEN}" }
    }
  }
}
```

一旦显式写了 `headers`，自动 OAuth 检测就会失效；如仍想用 OAuth，需要显式写 `auth: "oauth"`。

### 预注册 OAuth client

```json
{
  "mcpServers": {
    "linear-server": {
      "url": "https://mcp.linear.example/sse",
      "auth": "oauth",
      "oauth": {
        "clientId": "your-registered-id",
        "redirectUri": "http://localhost:3118/callback",
        "scope": "read write"
      }
    }
  }
}
```

动态 client（不写 `clientId`）会让 OAuth 客户端自动挑空闲的本地端口。

## Settings

顶级 `settings` 键可放在任意配置文件中：

```json
{
  "settings": {
    "toolPrefix": "server",
    "idleTimeout": 10,
    "requestTimeoutMs": 30000,
    "directTools": false,
    "disableProxyTool": false,
    "autoAuth": false,
    "sampling": true,
    "samplingAutoApprove": false,
    "elicitation": true,
    "outputGuard": true
  }
}
```

| 设置 | 默认 | 作用 |
|------|------|------|
| `toolPrefix` | `"server"` | `"server"` → 形如 `chrome_devtools_*`；`"short"` → 去掉末尾的 `-mcp`；`"none"` → 不加前缀。 |
| `idleTimeout` | `10` | 空闲多少分钟就断开非 keep-alive 的服务器。设为 `0` 关闭空闲断开。 |
| `requestTimeoutMs` | SDK 默认 | 单次实时调用的超时（per-server 未指定时生效）。 |
| `directTools` | `false` | 全局默认；per-server `directTools` 可以覆盖。 |
| `disableProxyTool` | `false` | 当所有已知服务器都能从缓存覆盖到 direct tools 时，隐藏 `mcp` 代理工具。 |
| `autoAuth` | `false` | `mcp({ connect })`、`mcp({ tool })` 与 direct tool 在需要 OAuth 时自动执行并重试一次。 |
| `sampling` | UI 可用时 `true` | 对外宣告 `sampling` capability。 |
| `samplingAutoApprove` | `false` | 跳过 Sampling 二次确认；非 UI 模式下必须开。 |
| `elicitation` | UI 可用时 `true` | 对外宣告 `elicitation` capability（TUI 下还会附加 url 模式）。 |
| `outputGuard` | `true` | 限制超大 MCP 输出。见 [Output Guard](#output-guard)。 |
| `authRequiredMessage` | 未设置 | OAuth「需要鉴权」时的提示模板，`${server}` 会被替换。 |

### Output Guard

默认情况下 MCP 文本结果在行内被限制在 **50 KiB / 2,000 行**（与 Pi 自带的 `bash` guard 一致）。超出后会替换成头部的预览片段，并把原文写到 `0600` 权限的临时文件，路径会附在结果里。

- 图片内容块始终原样透传，不会被截断。
- 在 proxy 模式下，`details.mcpResult` 仅在 JSON ≤ **16 KiB** 时保留原始；更大的会被替换成结构化摘要（块数、大小、键预览），原始 JSON 落到临时文件。
- Direct tool 的结果从不携带 `mcpResult`。

对象形式允许细调，或整体关闭：

```json
{
  "settings": {
    "outputGuard": { "maxBytes": 51200, "maxLines": 2000, "detailsMaxBytes": 16384 }
  }
}
```

```json
{
  "settings": { "outputGuard": false }
}
```

环境变量紧急开关：`MCP_OUTPUT_GUARD=0`。

### Lifecycle 模式

| 模式 | 连接时机 | 断开时机 | 自动重连 | 说明 |
|------|---------|---------|---------|------|
| `"lazy"`（默认） | 首次 tool 调用 / 缓存覆盖不全的 search | 空闲 `idleTimeout` 分钟后 | 下次再用时 | 适合偶尔用的服务器。 |
| `"eager"` | session 启动时 | 仅当 `idleTimeout > 0` 时按空闲断开 | 不自动重连 | 适合几乎总需要、丢连也能忍一次的服务器。 |
| `"keep-alive"` | session 启动时 | 永不 | 是（30 秒健康检查） | 适合始终要可用的服务器。 |

空闲超时由 `settings.idleTimeout`（默认 10 分钟）控制，每个服务器可以用 `server.<name>.idleTimeout` 单独覆盖。`keep-alive` 服务器由 `McpLifecycleManager` 每 30 秒跑一次健康检查。

## Direct Tools

默认所有 MCP 工具都通过单一 `mcp` 代理访问。如果希望某些工具直接出现在 Pi 的工具列表里，需要写 `directTools`：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "directTools": ["search_repositories", "get_file_contents"]
    },
    "huge-server": {
      "command": "npx",
      "args": ["-y", "mega-mcp@latest"],
      "directTools": false
    }
  }
}
```

| 取值 | 行为 |
|------|------|
| `true` | 把该服务器全部工具（受 `excludeTools` 过滤）注册为独立 Pi 工具。 |
| `["name_a", "name_b"]` | 只注册列出的工具，使用原 MCP 名。 |
| 未写 / `false` | 仅走代理。 |

Direct tools 的注册来自持久化的元数据缓存（`<agent dir>/mcp-cache.json`），启动阶段不需要真实连接。新加 `directTools` 后第一次启动时缓存还不存在，工具会先回到仅代理，并在后台补齐缓存；要立刻生效可执行 `/mcp reconnect <server>`。

全局默认 `settings.directTools` 和环境变量 `MCP_DIRECT_TOOLS`（如 `MCP_DIRECT_TOOLS=server1,server2/tool`）也存在；`__none__` 完全禁用。Per-server 的 `directTools` 会覆盖设置项，但 `MCP_DIRECT_TOOLS` 拥有最高优先级。

每个 direct tool 大约 150–300 tokens。5–20 个工具的精准选择性价比最高；75+ 工具的服务器建议保留代理或用 `string[]` 显式挑选。

在 `/mcp` 面板里切换 direct/proxy，以及 `/mcp setup` 触发新配置写入时，扩展会自动跑 Pi 的 reload 流程，让新 direct tools 当场生效，无需手动重启。

## Imports

需要兼容非常规格式（Cursor、Claude Code 等）时，在 `imports` 里声明：

```json
{
  "imports": ["cursor", "claude-code"],
  "mcpServers": {}
}
```

支持的 kind：`cursor`、`claude-code`、`claude-desktop`、`vscode`、`windsurf`、`codex`。早期版本里的自定义下载器已被移除，改用 `pi install npm:pi-mcp-adapter`，再可选地跑 `pi-mcp-adapter init` 自动把 host 配置检测出来并写入 Pi agent dir 的 imports。

`.mcp.json`、`~/.config/mcp/mcp.json` 不需要写 imports 也会自动加载。

## Pi Agent Dir 下被写出的文件

| 文件 | 用途 |
|------|------|
| `mcp.json` | Pi 全局覆盖（同时也是 `mcp.json`），所有 Pi 端写入都走它。 |
| `mcp-cache.json` | 按服务器索引的 tool/resource 元数据，用服务器定义哈希做键，用于离线 search/list/describe 与 direct-tool 注册。 |
| `mcp-npx-cache.json` | npx 服务器解析后的二进制路径，下次启动直接跳过 npm 父进程。 |
| `onboarding-state.json` | 是否已经展示过首次启动的「共享配置」提示。 |

文件路径默认为 `~/.pi/agent/`，除非设置了 `$PI_CODING_AGENT_DIR`。

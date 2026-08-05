# pi-mcp-adapter 文档

`pi-mcp-adapter` 是一个 [Pi](https://github.com/badlogic/pi-mono/) 扩展，用来在不消耗上下文窗口的前提下，把 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 服务器暴露给 Pi 编码 Agent。

核心理念：系统提示里只放一个轻量的 `mcp` 代理工具（再加若干可选的「直连」工具），而不是把每个服务器的全量 schema 全部塞进去。服务器默认按需启动，工具元数据落盘缓存，模型只在确实用到的时候才触发按需发现。

## 目录

| 文档 | 内容 |
|------|------|
| [architecture.md](./architecture.md) | 扩展如何装配在一起：生命周期、状态对象、服务器管理器、健康/空闲检查、proxy 与 direct 模式、MCP UI 集成、OAuth、Sampling、Elicitation、Output Guard。 |
| [configuration.md](./configuration.md) | 配置文件布局（`~/.config/mcp/mcp.json`、`.mcp.json`、Pi 自有覆盖、`imports`）、所有服务器字段、`settings`、Output Guard 调优、Lifecycle 模式。 |
| [usage.md](./usage.md) | 代理 `mcp` 工具的用法、`/mcp` 与 `/mcp-auth` 命令、direct tools、OAuth 流程、MCP UI / Glimpse 集成，以及运行时需要注意的细节。 |
| [internals.md](./internals.md) | 值得关注的子模块：npx 解析（跳过 npm 父进程）、本地 MCP UI 宿主服务器、ConsentManager、元数据缓存、回调服务器与 OAuth 流程。 |

## 一段话心理模型

1. 扩展注册一个 `mcp` 代理工具，再加上 0 个或若干直连工具（从持久化的元数据缓存里派生，缓存存在则无需真实连接）。
2. `session_start` 时 `init.ts` 加载标准 / Pi 的配置文件、展开 `imports`、把元数据缓存填进内存，仅对 `lifecycle` 为 `eager` 或 `keep-alive` 的服务器做直连。
3. 模型调用 `mcp({ tool: "...", args: "..." })` 时，proxy 先按需（lazy）连目标服务器，比对元数据缓存里的工具名，再把请求交给 MCP SDK 客户端。
4. 调用结果声明了 MCP UI 资源 URI 时，会启动一个嵌入式 HTTP 宿主服务器（`ui-server.ts`），把 HTML 渲染进 Glimpse（macOS）或系统浏览器，再把 UI→Agent 的消息通过 `state.uiServer` 回灌到 agent。
5. OAuth、Sampling、Elicitation、Output Guard 都挂在这同一套 proxy/direct 执行管道上，由各自模块把关并维护持久凭据。

更深入的内容请从 [architecture.md](./architecture.md) 开始。

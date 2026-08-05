# pi 扩展系统与外部插件接口

`packages/coding-agent/src/core/extensions/` 目录下的五个文件(`index.ts` / `types.ts` / `loader.ts` / `runner.ts` / `wrapper.ts`)共同构成 pi 的扩展系统。它给"外部编写一段 TypeScript 代码,就能 hook 进 Agent 生命周期、注册 LLM-callable 工具、注册 slash command 和键盘快捷键、提供 UI 控件、注册自定义模型 provider"留出了完整的接口。

下文先按"扩展长什么样"梳理契约,再按目录文件维度逐个拆解运行机制,最后给出"写一个扩展"和"把扩展接到 pi"两份步骤。

---

## 0. 一句话模型

> 一个扩展就是一个 `(pi: ExtensionAPI) => void | Promise<void>` 的工厂函数,在 pi 启动时被 `ExtensionRunner` 调用一次,期间通过 `pi.on(...)` 订阅事件、通过 `pi.registerTool/registerCommand/registerShortcut/registerFlag/registerProvider/...` 注册插件制品、通过 `pi.sendMessage/...` 调用运行时动作。

扩展不必"上线"——它可以以文件形式放在 cwd 的 `.pi/extensions/` 下、放在 `~/.pi/agent/extensions/` 下、以 npm 包 `package.json` 的 `pi.extensions` 字段声明形式引入,也可以通过 `createAgentSession({ inlineExtension: ... })` 直接内联注入。`loader.ts::discoverAndLoadExtensions` 是默认发现策略。

---

## 1. 扩展 API:ExtensionAPI

`ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`(见 `types.ts`)。`pi` 对象的字段见 `types.ts` §"Extension API",分类如下:

### 1.1 事件订阅

```ts
api.on("agent_start", (event, ctx) => { ... });
api.on("tool_call",    (event, ctx) => { ... });  // 可 block / 可改 input
api.on("message_end",  (event, ctx) => { ... });  // 可替换 message
api.on("session_before_compact", (event, ctx) => { ... });  // 可 cancel / 可提供 compaction
...
```

事件清单见下文 §4。绝大多数 `ExtensionHandler<E, R>` 是 `(event: E, ctx: ExtensionContext) => Promise<R | void> | R | void` —— 同步异步双兼容,无副作用时返回 `void` 即可。

### 1.2 注册插件制品

| 方法 | 作用 |
| --- | --- |
| `registerTool(tool)` | 注册 LLM-callable 工具(提供 `name` / `description` / `parameters` / `execute` / `renderCall` / `renderResult`)。后续 LLM 就能看到并调用这个工具。 |
| `registerCommand(name, { description, handler, getArgumentCompletions? })` | 注册 `/xxx` 命令,handler 收到 `(args: string, ctx: ExtensionCommandContext)`。 |
| `registerShortcut(KeyId, { description, handler })` | 注册键盘快捷键,handler 收到 `(ctx: ExtensionContext)`。与内置快捷键冲突时由 `runner.getShortcuts()` 报告冲突诊断(见 §3.3)。 |
| `registerFlag(name, { description, type, default? })` | 注册 CLI flag(`boolean` 或 `string`),可在工厂里 `api.getFlag(name)` 读取。`runtime.flagValues` 在 `bindCore` 之后会被 CLI 解析层覆盖默认值。 |
| `registerMessageRenderer(customType, renderer)` | 为扩展自定义 `CustomMessage`(`customType` 字段)提供 TUI 渲染。 |
| `registerEntryRenderer(customType, renderer)` | 为扩展自定义 `CustomEntry` 提供 TUI 渲染(不进 LLM 上下文)。 |
| `registerProvider(name, config)` | 动态注册 / 覆盖模型 provider。详见 §6。 |
| `unregisterProvider(name)` | 撤销。 |

### 1.3 运行时动作

```ts
api.sendMessage(message, { triggerTurn?, deliverAs? })  // 发送 CustomMessage 到会话,可触发 turn
api.sendUserMessage(content, { deliverAs? })            // 发送 user 消息,总是触发 turn
api.appendEntry(customType, data?)                       // 写一条不进 LLM 上下文的持久化条目
api.setSessionName(name) / api.getSessionName()
api.setLabel(entryId, label | undefined)
api.exec(command, args, options?)                        // 同步执行 shell 命令
api.getActiveTools() / api.getAllTools() / api.setActiveTools(names)
api.getCommands()                                        // 列出所有 slash command
api.setModel(model) / api.getThinkingLevel() / api.setThinkingLevel(level)
api.getFlag(name)                                         // 读 CLI flag
api.events: EventBus                                      // 扩展间共享事件总线
```

> 注意 §1.3 这些"动作"在扩展 *加载阶段* 调用会抛错(`runtime.assertActive()`,见 `loader.ts::createExtensionRuntime`)—— `bindCore()` 之前它们指向 throwing stubs;只有 `AgentSession._bindExtensionCore(...)` 之后才被替换为真正的实现。这是为了避免扩展在初始化期偷偷调用运行时副作用。

### 1.4 上下文:ExtensionContext / ExtensionCommandContext / ReplacedSessionContext

- **`ExtensionContext`(`ctx` 字段):** 每个事件回调拿到的"只读视图"。包含 `ui`、`mode`、`hasUI`、`cwd`、`sessionManager`、`modelRegistry`、`model`、`isIdle()`、`isProjectTrusted()`、`signal`、`abort()`、`hasPendingMessages()`、`shutdown()`、`getContextUsage()`、`compact(options?)`、`getSystemPrompt()`。
- **`ExtensionCommandContext`:** 命令处理器专用,在 `ExtensionContext` 基础上加 `waitForIdle()` / `newSession()` / `fork()` / `navigateTree()` / `switchSession()` / `reload()` / `getSystemPromptOptions()`。
- **`ReplacedSessionContext`:** `newSession/fork/switchSession` 的 `withSession` 回调专用,再加 `sendMessage` / `sendUserMessage` —— 这些必须在替换后的 ctx 上调用,不能在原来捕获的 ctx 上调用(runner 会通过 `invalidate()` 抛错,见 §3.4)。
- 所有 `ctx.*` 字段都是 **lazy getter**(`runner.createContext()` 用 `Object.defineProperties` + 闭包访问器实现,见 `runner.ts::createContext/createCommandContext`),这样切换 UI context 后下一次回调就能拿到新 context,不会出现"快照陈旧"的 bug。

---

## 2. 编写一个扩展:最小可运行示例

```ts
// ~/.pi/agent/extensions/hello.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 1. 注册工具
  pi.registerTool({
    name: "hello_world",
    label: "Hello World",
    description: "Return a greeting for the given name.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    execute: async (_id, params, _signal, _onUpdate, _ctx) => ({
      content: [{ type: "text", text: `Hello, ${(params as { name: string }).name}!` }],
      details: { ok: true },
    }),
  });

  // 2. 注册 slash 命令
  pi.registerCommand("greet", {
    description: "Greet the user",
    handler: async (args, ctx) => {
      ctx.ui.notify(`greet: ${args || "anon"}`);
    },
  });

  // 3. 订阅事件
  pi.on("agent_end", () => {
    console.log("[extension] agent run finished");
  });
}
```

发现策略(由 `DefaultResourceLoader` 驱动):`cwd/.pi/extensions/hello.ts` 或 `~/.pi/agent/extensions/hello.ts` 都会被 `discoverAndLoadExtensions` 自动加载。无需手动注册。

更复杂场景:放进子目录 + 写 `package.json`:

```json
{
  "name": "my-hello",
  "version": "0.1.0",
  "pi": {
    "extensions": ["./src/index.ts"],
    "themes": ["./themes/dark.json"]
  }
}
```

`loader.ts::resolveExtensionEntries` 会读 `package.json` 的 `pi.extensions` 字段,允许一个 npm 包发布多个扩展入口。

---

## 3. 文件维度详解

### 3.1 `types.ts` —— 类型契约总览

`types.ts` 是整个扩展系统的"宪法",只声明类型不执行代码。关键类别:

- **UI 契约:`ExtensionUIContext`** —— TUI 模式、RPC 模式、打印模式各实现一份自己的版本,TUI 模式提供 `select/confirm/input/notify/onTerminalInput/setStatus/setFooter/setHeader/custom/pasteToEditor/setEditorText/editor/setWorkingMessage/setWorkingVisible/setWorkingIndicator/setHiddenThinkingLabel/setWidget/setTitle/addAutocompleteProvider/setEditorComponent/getEditorComponent/theme/getAllThemes/getTheme/setTheme/getToolsExpanded/setToolsExpanded`。
- **事件契约:`ExtensionEvent`** 是 30+ 种 event 类型的 discriminated union,按生命周期分组。
- **上下文契约:`ExtensionContext / ExtensionCommandContext / ReplacedSessionContext / ProjectTrustContext`。**
- **注册结果契约:`Extension(handlers/tools/commands/flags/shortcuts/messageRenderers/entryRenderers) / RegisteredTool / ExtensionFlag / ExtensionShortcut / RegisteredCommand / ResolvedCommand。`**
- **运行时契约:`ExtensionRuntime = ExtensionRuntimeState + ExtensionActions`,所有方法签名都在这里。**
- **provider 契约:`ProviderConfig / ProviderModelConfig` —— 包含 `streamSimple`、`oauth`、`apiKey` 的 env 插值语法、`compat`(OpenAI 兼容开关)等。**

### 3.2 `loader.ts` —— 加载与发现

#### 3.2.1 加载目标

- **文件形式**:`*.ts` / `*.js` —— `loader.ts::isExtensionFile`。
- **子目录 + `index.ts/js`**:`loader.ts::resolveExtensionEntries` 优先看 `package.json` 的 `pi.extensions`,没有再看 `index.ts` / `index.js`。
- **`package.json` 协议:** npm 包的 `pi.extensions` 数组声明多入口,以及 `pi.themes` / `pi.skills` / `pi.prompts` 顺带挂载资源。

#### 3.2.2 加载机制:jiti + virtualModules

`loader.ts::loadExtensionModule` 用 `jiti/static` 解析 TS 扩展,根 node module 不能用 `tryNative` —— 必须走 jiti,这样 extension 的 import 才会走 jiti 的 alias / virtualModules 解析。

两份别名配置:

- **Node.js 模式(`!isBunBinary`):** `getAliases()` 用 `require.resolve` + workspace 路径解析,把 `@earendil-works/*`、`typebox`、`@sinclair/typebox/*` 等重定向到本仓库 `dist/` 产物。
- **Bun binary 模式:** `VIRTUAL_MODULES` 静态 import 把这些包体打进去(`_bundledPiAgentCore` 等,见 `loader.ts` 顶部)。这样编译后的二进制无需文件系统查找 import。

#### 3.2.3 `createExtensionRuntime` —— 加载期与运行期的界线

```ts
const notInitialized = () => { throw new Error("...not initialized..."); };

const runtime: ExtensionRuntime = {
  sendMessage: notInitialized,
  sendUserMessage: notInitialized,
  ...
  // 唯一例外的"合法 stub":
  refreshTools: () => {},  // 加载阶段 registerTool 调用合法
  registerProvider: (name, cfg) => runtime.pendingProviderRegistrations.push({...}),
  unregisterProvider: name => runtime.pendingProviderRegistrations = ...
                                  .filter(r => r.name !== name),
  ...
};
```

含义:

- **加载期 vs 运行期。** 扩展工厂在 `agent.subscribe` 之前、`AgentSession._bindExtensionCore` 之前执行,这段窗口期任何 `sendMessage` / `setModel` 都会抛错。
- **`registerTool` 在加载期合法**(因为工具注册是"声明"而非"副作用"),所以 `refreshTools` 是 `() => {}` 的空函数占位。
- **`registerProvider` 在加载期是 queue,** 在 `bindCore` 时被 flush 到 `modelRegistry`,之后才改为"立即生效"。这给"扩展加载顺序在 ModelRegistry 准备之前"留了空间(其实本仓库里 ModelRegistry 已先建好,但语义更安全)。

**`ExtensionAPI` 实现**(`createExtensionAPI`):每个方法都包一层 `runtime.assertActive()`(如果 runner 已经 `invalidate`,整个 API 就抛"ctx stale"),并把 register 类方法写到当前 `extension.handlers.get(event)?.push(handler)`,把 action 类方法转发到 `runtime.*`。

#### 3.2.4 `useExtensionCacheCwd` —— 扩展模块缓存

```ts
let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionCache = new Map<string, ExtensionFactory>();
```

缓存 key 是 (cwd, generation)。`reset()` 时 `clearExtensionCache()` 把所有缓存 + generation++ 一起清掉。这样:

- 同 cwd 内"重载"(`AgentSession.reload`)复用上次 `jiti.import(...)` 拿到的工厂函数,避免每次重复解析 TS;
- cwd 切换(`session_switch`)自动 invalidate;
- 显式 `clearExtensionCache()` 用于"我希望强制重新解析"路径。

> 注意:缓存的是 *工厂函数*,不是 `Extension` 对象 —— 也就是说每次 reload 都会用同样的工厂跑一次,得到新的 `Extension.handlers` 等,但 jiti 不再 import 文件。

#### 3.2.5 `discoverAndLoadExtensions` —— 标准发现路径

优先级:
1. `cwd/${CONFIG_DIR_NAME}/extensions/`(项目本地,优先)
2. `agentDir/extensions/`(全局)
3. 调用方传入的 `configuredPaths`(CLI / SDK 显式指定,允许绝对 / 相对目录)

每个目录用 `discoverExtensionsInDir` 扫一级(文件 / 含 `index.{ts,js}` 的子目录 / 含合法 `package.json` 的子目录),不递归。

### 3.3 `runner.ts` —— 事件分发与扩展语境

`ExtensionRunner` 是真正执行扩展的主体。它有:

#### 3.3.1 双模式 UI:`noOpUIContext` / 真 UI

```ts
const noOpUIContext: ExtensionUIContext = {
  select: async () => undefined,
  confirm: async () => false,
  ...
};

setUIContext(uiContext?, mode: ExtensionMode = "print"): void {
  this.uiContext = uiContext ?? noOpUIContext;
  this.mode = mode;
}

hasUI(): boolean {
  return this.uiContext !== noOpUIContext;
}
```

- 加载完成后默认 `noOpUIContext`,所以 `ctx.hasUI === false`。
- 交互模式调用 `bindExtensions({ uiContext, mode: "tui", ... })` 后切到真 UI,`ctx.hasUI === true`。
- RPC / 打印模式各自实现一份 `ExtensionUIContext`(`pc => this.ui.notify(...)` 之类),`hasUI` 同样为 `true`。

#### 3.3.2 三层 ctx 解析

| 调用方 | 由 runner 提供 | 含 |
| --- | --- | --- |
| 事件回调(非 session_before_*) | `createContext()` | `ExtensionContext` |
| `tool_execution_*` / `message_*` 等 | 同上 | `ExtensionContext` |
| `session_before_*` / `tool_call` / `tool_result` 等专用路径 | 同上 | `ExtensionContext` |
| command handler | `createCommandContext()` | `ExtensionCommandContext` |
| `withSession` 回调 | 由替换后的 AgentSession 再调 `createCommandContext()` 包一层 | `ReplacedSessionContext` |

`createCommandContext` 的实现细节见 §1.4 的 lazy getter 说明 —— 关键点是 `Object.defineProperties` 避免 spread 触发 lazy 求值。

#### 3.3.3 事件分发语义

每个 `emit*` 方法对应不同的 *事件流规则*,这是扩展作者必须理解的契约:

| 方法 | 触发的事件 | 语义 | 返回值 |
| --- | --- | --- | --- |
| `emit(event)`(泛型) | `agent_*` / `turn_*` / `model_*` / `thinking_*` / `session_start/info_changed/compact/tree/shutdown` / `tool_execution_*` / `after_provider_response` | 串行调用所有 extension-注册-顺序的 handler;异常被 `emitError` 捕获,不中断后续 extension;`session_before_*` 类事件遇到 `result.cancel === true` 立刻短路 | 对 `session_before_*` 返回首个非空结果;其他返回 `undefined` |
| `emitMessageEnd(event)` | `message_end` | 链式覆盖 `message`(`currentMessage = handlerResult.message`),**必须保持原 `role`**,否则记录 error | 最终被覆盖过的 message,或 `undefined`(未被改) |
| `emitToolCall(event)` | `tool_call` | 短路式 —— 第一个返回 `{ block: true, reason? }` 的 handler 立即阻止工具执行 | 该 `block` 结果,或 `undefined` |
| `emitToolResult(event)` | `tool_result` | 链式叠加 `content / details / isError` 的 *field-by-field* 覆盖;未填的字段保持原值 | 合并结果,或 `undefined`(未被改) |
| `emitUserBash(event)` | `user_bash` | 短路式 —— 任一返回 `{ operations, result }` 即视为"接管" | 首个非空结果,或 `undefined` |
| `emitContext(messages)` | `context` | `structuredClone(messages)` 起,handler 可以返回 `{ messages }` 替换 message 数组 | 最终 messages |
| `emitBeforeProviderRequest(payload)` | `before_provider_request` | handler 返回值替换 `payload`(`undefined` 不变) | 最终 payload |
| `emitBeforeProviderHeaders(headers)` | `before_provider_headers` | handler **直接 mutate `headers` 对象**(`null` = 删除该 header),返回值被忽略 | headers(已被 mutate) |
| `emitBeforeAgentStart(prompt, images, sp, spOpts)` | `before_agent_start` | 链式合并 `{ message?, systemPrompt? }`,**多扩展同时返回 `systemPrompt` 时以最后者为准**(`currentSystemPrompt` 持续被覆盖) | 合并结果,或 `undefined` |
| `emitResourcesDiscover(cwd, reason)` | `resources_discover` | 收集每个扩展返回的 `skillPaths/promptPaths/themePaths` | 三类路径列表(均带 `extensionPath`) |
| `emitInput(text, images, source, streamingBehavior)` | `input` | 链式覆盖 `text` / `images`;返回 `handled` 时立即短路(整个 prompt 不发往 Agent) | `{ action: "handled" \| "transform" \| "continue" }` |

错误处理:每个 handler 都在自己的 try/catch 内,异常被 `emitError({ extensionPath, event, error, stack })` 上报,进入 `errorListeners`,**不影响**后续 extension 的调用。这是"一个扩展崩了不带走其他扩展"的隔离层。

#### 3.3.4 失效检测

```ts
private assertActive(): void {
  if (this.staleMessage) {
    throw new Error(this.staleMessage);
  }
}

invalidate(message) {
  if (!this.staleMessage) {
    this.staleMessage = message;
    this.runtime.invalidate(message);
  }
}
```

会话切换 / 重载 / `ctx.newSession/fork/switchSession/reload` 之后,旧 `ExtensionRunner` 实例的 `staleMessage` 被设置;之后任何 `assertActive()` 都会抛错。**扩展代码捕获的旧 `pi` 对象或 `ctx` 对象,后续调用都会触发这个抛错**,强制作者用 `withSession((newCtx) => ...)` 重新拿到 fresh ctx。

#### 3.3.5 命令命名与冲突

```ts
resolveRegisteredCommands() {
  ...
  let invocationName = (counts.get(command.name) ?? 0) > 1
    ? `${command.name}:${occurrence}`
    : command.name;
}
```

同名命令(`/foo` 在多个扩展里)会自动加 `:2`、`:3` 后缀去重,扩展作者不用关心 collsion。冲突诊断写入 `commandDiagnostics`,UI 可以选择把"我装了哪些命令"显示出来。

#### 3.3.6 快捷键冲突

`getShortcuts(resolvedKeybindings)` 用 `buildBuiltinKeybindings` 把内置快捷键表转成 `{ key: { keybinding, restrictOverride } }`。`restrictOverride` 标记了"`app.*` / `tui.*` 等关键路径",这条 key 上扩展的 shortcut 会被直接跳过 + 写一条 diagnostics。同样是故障可见性设计。

#### 3.3.7 工具收集

```ts
getAllRegisteredTools() {
  const toolsByName = new Map<string, RegisteredTool>();
  for (const ext of this.extensions)
    for (const tool of ext.tools.values())
      if (!toolsByName.has(tool.definition.name)) {
        toolsByName.set(tool.definition.name, tool);  // 先注册者赢
      }
  return Array.from(toolsByName.values());
}
```

同 `registerProvider` 的"先注册者赢"语义;`AgentSession._refreshToolRegistry` 会把这个列表和 SDK 自定义 `customTools` / 内置工具合并,然后写入 `agent.state.tools`。

### 3.4 `wrapper.ts` —— 把扩展工具塞进 Agent

`wrapRegisteredTool` 把 `RegisteredTool` 包成 `AgentTool`:

```ts
const tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
const execute = tool.execute;
return {
  ...tool,
  execute: async (toolCallId, params, signal, onUpdate) => {
    const activeBefore = runner.getActiveTools();
    const result = await execute(toolCallId, params, signal, onUpdate);
    const activeAfter  = runner.getActiveTools();
    if (!activeBefore.every((name) => activeAfter.includes(name))) return result;
    const beforeNames = new Set(activeBefore);
    const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
    if (addedToolNames.length === 0) return result;
    return { ...result, addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])] };
  },
};
```

要点:

- **`wrapToolDefinition`**(`tools/tool-definition-wrapper.ts`)把 `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)` 包成 `AgentTool.execute(toolCallId, params, signal, onUpdate)`,每次执行都即时从 `runner.createContext()` 拿一个新鲜 ctx,确保工具执行期间 `ctx.isIdle()` / `ctx.signal` 等都是当前值。
- **`addedToolNames` 检测:** 执行前后各调一次 `runner.getActiveTools()`,计算新增 —— 允许工具"在执行中声明额外可用的工具"(`AgentToolResult.addedToolNames` 字段,见 `Agent与AgentSession类型全景.md` §2)。这给"按需装载工具"的协议级支持。
- **顺序保证:`AgentSession._refreshToolRegistry`** 把 `wrappedExtensionTools` 排在 `wrappedBuiltInTools` 之后(`toolRegistry.set(tool.name, tool)`),同名扩展工具覆盖内置工具。

### 3.5 `index.ts` —— 公开面

只做 `export * from "./types.ts"` + `export { ExtensionRunner } from "./runner.ts"` + `export { ... loader ... } from "./loader.ts"` + `export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.ts"`。

外部用 `import { ExtensionAPI, ExtensionContext, ... } from "@earendil-works/pi-coding-agent"`。

---

## 4. 事件一览与触发时机

| 事件 | 类型 | 触发位置 | 处理语义 |
| --- | --- | --- | --- |
| `project_trust` | 启动期 | `ResourceLoader._handleProjectTrust`,在 `session_start` 之前 | 决策 `trusted = yes/no/undecided`;首次 `undecided` → 全 `undecided` → 弹内置信任确认 UI |
| `resources_discover` | 启动期 / 重载 | `AgentSession.extendResourcesFromExtensions` | 返回 `skillPaths/promptPaths/themePaths`,被 `ResourceLoader.extendResources` 合并 |
| `session_start` | 启动期 / 重载 | `AgentSession.bindExtensions` | 无返回值 —— 仅通知 |
| `session_info_changed` | 运行时 | `setSessionName()` 时 | 无返回值 |
| `session_before_switch` / `session_before_fork` / `session_before_tree` | 切换前 | `cmd newSession/fork/navigateTree/switchSession` | 可 `cancel: true` 取消;`session_before_tree` 还可返回 `{ summary, customInstructions, replaceInstructions, label }` |
| `session_before_compact` | 压上下文前 | `AgentSession._runAutoCompaction` 和 `compact()` | 可 `cancel: true`;可 `compaction: CompactionResult` 直接取代系统生成的压上下文结果 |
| `session_compact` | 压上下文化 | 压上下文写入 session 后 | 仅通知 |
| `session_shutdown` | 切换 / 重载 / 退出 | `AgentSession.bindExtensions(reload)` | 仅通知;旧的 `pi` / `ctx` 之后会失效 |
| `session_tree` | 切换后 | `navigateTree()` 完成后 | 仅通知 |
| `context` | 每个 LLM 调用前 | `AgentSession -> Agent.transformContext` 经 `ExtensionRunner.emitContext` | 可替换 messages |
| `before_provider_request` | provider HTTP 请求发出前 | `createAgentSession` 里 `Agent.onPayload` 闭包 | 可替换 payload |
| `before_provider_headers` | header 拼装后、HTTP 之前 | `createAgentSession` 里 `streamFn` | **mutate headers**(包括 null=删除) |
| `after_provider_response` | HTTP 响应已收到 | `createAgentSession` 里 `Agent.onResponse` 闭包 | 仅副作用 |
| `before_agent_start` | `Agent.prompt` 前,system prompt 落定 | `AgentSession._handleAgentEvent` 在 `agent_start` 之前 | 可返回 `{ message?, systemPrompt? }` |
| `agent_start` / `agent_end` / `agent_settled` | run 边界 | `runAgentLoop` 头尾 | 仅通知 |
| `turn_start` / `turn_end` | 每次 turn 边界 | `runAgentLoop` 每次翻 turn | 仅通知 |
| `message_start` / `message_update` / `message_end` | 每个 AgentMessage | `runAgentLoop` 的 `emit` | `message_end` 可替换 message(同 role 校验) |
| `tool_execution_start` / `_update` / `_end` | AgentTool 生命周期 | `agent-loop::executeToolCalls` | 仅通知 |
| `model_select` / `thinking_level_select` | 模型/级别变更 | `AgentSession.setModel/setThinkingLevel` | 仅通知 |
| `user_bash` | `!` / `!!` 触发 | `AgentSession.sendUserMessage` | 可返回 `{ operations?, result? }` 接管执行 |
| `input` | 用户在 TUI/RPC 输入文本 | `AgentSession.prompt` 进入期 | 可 `transform` 或 `handled`(后者整段不传给 Agent) |
| `tool_call` | Tool 即将执行 | 经 `Agent.beforeToolCall`(被 `AgentSession._installAgentToolHooks` 装成桥接函数) | 可 `block: true` 阻断;可 mutate `event.input` 改 args(无重新校验) |
| `tool_result` | Tool 已执行 | 经 `Agent.afterToolCall` | 可 field-by-field 覆盖 `content/details/isError` |

完整类型清单见 `types.ts` 中从 `ExtensionEvent = ... | ... | ...` 一长串 union(`index.ts:1018-1043`)。

---

## 5. UI 接口(`ExtensionUIContext`)

只在 `ctx.mode === "tui"` / RPC 等有 UI 的 mode 下真正可用,其他 mode 默认给 `noOpUIContext`(返回空 / 抛"UI not available")。

主要分类:

- **阻塞式询问:`select / confirm / input / editor`** —— 返回 Promise,UI 关闭前一直等。`opts.signal` 可主动 dismiss,`opts.timeout` 自动超时。
- **非阻塞通知:`notify(message, type?)`** —— 状态条 / toast。
- **状态:`setStatus(key, text | undefined) / setWorkingMessage / setWorkingVisible / setWorkingIndicator / setHiddenThinkingLabel / setTitle`** —— 改 footer / 状态 / 加载指示器。
- **组件注入:`setWidget / setFooter / setHeader / setEditorComponent / addAutocompleteProvider / custom<T>(factory, opts?)`** —— 把自己的 TUI 组件挂到指定位置;`custom` 提供完整焦点控制(`done` callback + `OverlayHandle`)。
- **编辑器管道:`pasteToEditor / setEditorText / getEditorText / editor`** —— 与内置 editor 互动,扩展能 prefill、读取、回填。
- **主题:`theme / getAllThemes / getTheme / setTheme`** —— Theme 切换。
- **配置:`getToolsExpanded / setToolsExpanded`** —— 全局工具输出展开折叠。

任何一项都要按 mode 实现 —— `interactive-mode` / `rpc-mode` / `print-mode` 分别给出自己的 `ExtensionUIContext`,详见 `bindExtensions({ uiContext, mode })`。

---

## 6. Provider 注册:registerProvider / unregisterProvider

`pi.registerProvider(name, config)` 是扩展新增/覆盖模型 provider 的官方入口。`config: ProviderConfig`:

```ts
{
  name?,                            // 显示名
  baseUrl?,                         // 覆盖 baseUrl(单独提供时只改 URL,不重新定义 models)
  apiKey?,                          // 字面值 / $ENV / ${ENV} / !command
  api?,                             // "anthropic-messages" 等
  models?: ProviderModelConfig[],   // 提供此字段时,会**替换**该 provider 下的所有现有模型
  oauth?: { name, login, refreshToken, getApiKey, modifyModels? },  // 注册 OAuth
  streamSimple?: (model, ctx, opt) => AssistantMessageEventStream,  // 完全自定义 API
  headers?, authHeader?,
}
```

`ProviderModelConfig` = `id / name / api? / baseUrl? / reasoning / thinkingLevelMap? / input / cost / contextWindow / maxTokens / headers? / compat?`,与 `Model<TApi>` 对齐。

行为:

- **加载期:** 推入 `runtime.pendingProviderRegistrations` 队列。
- **`bindCore` 时 flush:** `bindCore(actions, contextActions, providerActions?)`,若外部传了 `providerActions.registerProvider/unregisterProvider`,就调外部;否则落到 `modelRegistry.registerProvider/unregisterProvider`。
- **flush 之后:** `runtime.registerProvider / unregisterProvider` 被替换成"立即生效"版本,扩展在事件回调 / 命令处理器里再调也直接生效,无需 reload。
- **`unregisterProvider`:** 删除该 provider 名下的所有模型,恢复被覆盖的内置模型(如果有)。

OAuth 部分(`/login <provider>` UI 调用它)由 `auth-storage.ts` 暴露 `login`/`refreshToken` 流程,扩展在这里挂上自家 SSO 协议即可。

---

## 7. 完整发现→加载→绑定→执行的时序图

```
ResourceLoader.discoverAndLoadExtensions(cwd, agentDir)
  ↓
loadExtensions(paths, cwd, ...)
  ↓ 创建 ExtensionRuntime(throw stub 版) + 空 extensionCache
loadExtension(path)
  ↓ jiti.import(path)
loadExtensionModule → 工厂函数
  ↓ createExtensionAPI(extension, runtime, cwd, eventBus)
factory(api) ←— 用户扩展在这里跑,调 pi.on / pi.registerTool / ...
  ↓
返回 { extensions, errors, runtime }
  ↓
AgentSession._buildRuntime({ activeToolNames, flagValues })
  ↓ new ExtensionRunner(extensions, runtime, cwd, sessionManager, modelRegistry)
ExtensionRunner 构造时,extensions 已经带着 handlers/tools/commands/flags/shortcuts
  ↓
_bindExtensionCore(runner) ← 来自 AgentSession
  ↓ 注入真 actions
runner.bindCore({ sendMessage, setModel, ... }, { getModel, isIdle, ... }, { registerProvider, ... })
  ↓ flush pendingProviderRegistrations -> modelRegistry
  ↓ runtime.sendMessage 等被替换为真实现
_applyExtensionBindings(runner)
  ↓ (后续由 mode 调用 agentSession.bindExtensions({ uiContext, mode }))
  ↓ runner.setUIContext(uiContext, mode)
  ↓ 如果 uiContext 提供真 UI,runner.hasUI() === true
emit("session_start")
  ↓ for each extension with session_start handler
emit("agent_start")
  ↓ 每个 LLM run 的开头
...
```

之后的"上下文→provider→agent→turn→message→tool_execution"层层 emit,与上表一一对应。

---

## 8. 错误模型与可见性

每个 handler 都在 runner 内部 try/catch 中;异常走 `emitError(error)`:

```ts
interface ExtensionError {
  extensionPath: string;  // 出现问题的扩展路径
  event: string;          // 出错的事件名 / "register_provider" / "command" / "send_message" 等
  error: string;          // 人类可读的错误
  stack?: string;
}
```

- `runner.emitError` → `errorListeners` 集合
- `AgentSession.bindExtensions(...)` 通过 `runner.onError(listener)` 注册内部 listener,把错误链到 `agentSession._emitExtensionEvent` → `extensionRunner.emitError`
- 然后错误进入内部 `runWithLifecycle` 的 catch 块,被包装成 AgentMessage 失败路径或 abort 路径

**约定:扩展内的异常不应抛出整个 run**。这保证一个扩展崩了不会带走整个 agent loop。

另外,与"扩展代码崩了"并列的另一个故障面是"扩展 ctx 失效" —— 用已 stale 的 ctx 调动作会立刻 `throw new Error(this.staleMessage)`,文案明确告知"用 withSession 拿新 ctx",这是给扩展作者的友好提示而不是静默走错。

---

## 9. 写入 pi 系统的"接入点"清单

如果想写一个扩展接入 pi,以下是常见接入面(列出对应 API):

| 接入意图 | 用什么 |
| --- | --- |
| 监听 run 开始 / 结束 / 翻 turn | `pi.on("agent_start" / "agent_end" / "turn_*")` |
| LLM 输出前后插手 | `pi.on("message_start/update/end")`(end 可替换) |
| 工具调用前改 args / 阻断 | `pi.on("tool_call", ...)`(mutate `event.input` 或返回 `{ block: true }`) |
| 工具结果后改写 | `pi.on("tool_result", ...)` |
| 改动模型选择 / thinking 级别 | `pi.on("model_select" / "thinking_level_select")` |
| 给 session 起名 / 加标签 / 写自定义条目 | `pi.setSessionName / setLabel / appendEntry` |
| 让扩展发消息触发 Agent | `pi.sendMessage / sendUserMessage` |
| 注册新模型 provider | `pi.registerProvider(...)` |
| 注册新工具 | `pi.registerTool(...)` |
| 注册 slash 命令 | `pi.registerCommand(...)` |
| 注册键盘快捷键(交互模式) | `pi.registerShortcut(...)` |
| 注册 CLI flag | `pi.registerFlag(...)` |
| 接管 `!` bash 执行 | `pi.on("user_bash", ...)` |
| 自定义 `CustomMessage`/`CustomEntry` 渲染 | `pi.registerMessageRenderer / registerEntryRenderer` |
| 改了 system prompt 或加 context 消息 | `pi.on("before_agent_start", ...)` 返回 `{ message?, systemPrompt? }` |
| 改 LLM 实际看到的 messages | `pi.on("context", ...)` 返回 `{ messages }` |
| 改 provider HTTP 请求体 / header | `pi.on("before_provider_request" / "before_provider_headers")` |
| 弹模态 / toast / 设 footer | `ctx.ui.*`(`select / confirm / input / notify / setFooter / setStatus`) |
| 注入 TUI 组件到指定位置 | `ctx.ui.setWidget / setFooter / setHeader / custom()` |
| 接入项目级 AGENTS.md / settings / 项目本地扩展 | `~/.pi/agent/extensions/`(全局)或 `<cwd>/.pi/extensions/`(项目),`discoverAndLoadExtensions` 会自动扫 |
| 给 npm 包发布扩展 | 在包内 `package.json` 加 `"pi": { "extensions": ["./src/index.ts"] }` |
| SDK 内联注入(测试 / 嵌入式) | `createAgentSession({ ... })` 前置准备 `extensionContextRef` 后通过 `ExtensionRuntime.registerProvider` 等机制 —— 一般通过文件路径发现最稳 |

---

## 10. 把扩展塞到 pi 启动流程里:三种方式

### 10.1 文件形式(最常见)

放置位置:

- `<cwd>/.pi/extensions/<name>.ts`(项目级,优先)
- `<cwd>/.pi/extensions/<name>/index.ts`(带 package.json 时可有更复杂配置)
- `<cwd>/.pi/extensions/<name>/package.json` + `pi.extensions` 字段
- `~/.pi/agent/extensions/<name>.ts`(全局)
- 同上的子目录 / package.json 形式

放好后下次 `createAgentSession` 调用 `DefaultResourceLoader.reload()` 时自动 load。**`loader.ts` 不要求重启 pi** —— 任何 `extendResources` / `reload` 路径都能识别新放的扩展。

### 10.2 命令行显式指定

CLI 模式下 `pi --extension /path/to/my.ts`,或者多份 `--extension path1 --extension path2`,会被 `configuredPaths` 入参传到 `discoverAndLoadExtensions`。

### 10.3 SDK 调用方显式注入

`createAgentSession` 接收的 `options` 里没有 `inlineExtension` 字段(那只是 `LoadExtensionsResult.extensions` 的旁路);要 inline 注册的话,可以:

1. **构造一份 `LoadExtensionsResult`** 手工 `extensions.push(yourExtension)`,然后自己 `new ExtensionRunner(extensions, runtime, ...)`;
2. 或者通过 SDK 自身的"内部注入扩展"路径。

更简单的 in-memory 路径见 `loader.ts::loadExtensionFromFactory(factory, cwd, eventBus, runtime)`:传入 factory 函数直接得到一个 `Extension`,可用于测试场景。

### 10.4 内联 JS 来源(无文件路径)

`extensionCacheCwd` / `loaderExtension(path)` 要求"路径能解析到文件",`discoverAndLoadExtensions` 也是按路径扫。所以"临时调试一个内联函数"最快的办法是写一个临时 `.ts` 文件放到某个目录里,再 `--extension <file>`。这避免了"无文件入口"的额外接口复杂度。

---

## 11. 与其他文档的关系

- `Agent` / `AgentState` / `AgentLoopConfig` / `Message` 的字段语义,以及 `AgentSession` 的入口事件流,见 `Agent与AgentSession类型全景.md`。
- `createAgentSession(options)` 如何一次性装好 `extensionRunnerRef` 让扩展运行时尚未 ready → ready 之间透明,见 `createAgentSession执行过程.md`。
- 工具状态机、扩展工具如何与内置工具共处、`AgentSession` 何时调 `_installAgentToolHooks` 重写 `agent.beforeToolCall/afterToolCall`,见 `Agent与AgentSession类型全景.md` §8。
- 上下文累积、压上下文(`session_before_compact` / `session_compact`) 协议与 `AgentLoopConfig.convertToLlm` 的关系,见 `Agent与AgentSession类型全景.md` §6-§7。

---

## 12. 一句话总结

> **`ExtensionAPI` + `ExtensionRunner` + 一个被 `loader.ts` 喂满的 `Extension` 集合 = pi 的"插件底座";所有"hook"都是事件订阅,所有"添加"都是注册调用,所有"副作用"都是 action 方法 —— 加载期与运行期由 `ExtensionRuntime.assertActive` 严格隔离,任何 ctx 跨会话切换都会被 `invalidate` 挡掉,任何 handler 抛错都会被 `emitError` 收编不带走整个 run。**

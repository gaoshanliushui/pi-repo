# createAgentSession 执行过程

`createAgentSession` 是 `@earendil-works/pi-coding-agent` 包对外暴露的 SDK 入口(`packages/coding-agent/src/core/sdk.ts`)。它把若干独立子系统(`AuthStorage`、`ModelRegistry`、`SettingsManager`、`SessionManager`、`ResourceLoader`、扩展运行时)组装成一个完全可用的 `AgentSession`,并把会话状态、模型决策、思考级别、流式调用全部一次性串好。

下文按 `sdk.ts::createAgentSession` 的源码顺序,把一次完整调用拆成六个阶段,逐阶段描述它做了什么、为什么、以及对应的副作用。

---

## 0. 输入契约与返回值

```ts
export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult>
```

- `CreateAgentSessionOptions` 是构造参数,每个字段都有缺省值,可以"裸调"。完整字段见后文 §1。
- `CreateAgentSessionResult`:
  - `session: AgentSession` —— 完全初始化的会话,可立刻 `prompt()`/`steer()`/`followUp()`。
  - `extensionsResult: LoadExtensionsResult` —— 已经按 `cwd` 解析出来的扩展集,留给交互模式做 UI context 设置(打印模式和 RPC 模式不直接用)。
  - `modelFallbackMessage?: string` —— 在恢复失败/无可用模型时给 UI 用的提示。

调用方通常只关心 `session`,把后两者留给上层 mode 处理。

---

## 1. 阶段一:路径与基础设施准备

```ts
const cwd = resolvePath(
  options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd(),
);
const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
```

- `cwd` 的优先级:`options.cwd` > `options.sessionManager.getCwd()` > `process.cwd()`。SessionManager 自身记住一个 cwd,所以即便调用方没传,只要传了 SessionManager 也能拿到项目目录。
- `agentDir`:不传就用全局 `~/.pi/agent`(`getAgentDir()`)。
- 两个都经 `resolvePath` 规范化(消除 `..`、归一化分隔符),这样后续所有路径比较都是字节级相等的。

接下来按"调用方是否已经提供"逐个构建四大基础设施,全部 lazy 实例化以减少无谓 I/O:

| 实例 | 缺省构造方式 | 副作用 |
| --- | --- | --- |
| `authStorage` | `AuthStorage.create(<agentDir>/auth.json)` | 打开凭据存储(可能触发首次反序列化) |
| `modelRegistry` | `ModelRegistry.create(authStorage, <agentDir>/models.json)` | 加载模型清单 + 注册 provider,触发 `authStorage.getAuth()` 调用 |
| `settingsManager` | `SettingsManager.create(cwd, agentDir)` | 读全局 + 项目级 `settings.json`,合并后形成 `Settings` 对象 |
| `sessionManager` | `SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))` | 决定会话文件路径(可能在 cwd 散列目录下创建 `sessions/<encoded-cwd>/`),分配 `sessionId` |
| `resourceLoader` | `new DefaultResourceLoader({ cwd, agentDir, settingsManager })` + `await resourceLoader.reload()` | **阻塞**:扫描扩展、技能、提示模板、主题、`AGENTS.md` / `CLAUDE.md` 上下文文件 |

注意四点:

- **`resourceLoader.reload()` 是同步 `await`,但内部是异步链**——它会触发包管理器解析(`packageManager.resolve()`)、扩展 JIT 加载、内联工厂注入等。第一次 SDK 调用因此通常会感觉到 200ms+ 的冷启动。
- 仅有 `cwd` 但没传 `agentDir` 时,`authPath` / `modelsPath` 是 `undefined` —— 此时 `AuthStorage.create(undefined)` 与 `ModelRegistry.create(..., undefined)` 会让两者内部选择默认路径。如果你打算整套跑 in-memory,要么显式传 `options.agentDir`,要么传 `inMemory`/自定义的 `AuthStorage` / `ModelRegistry`。
- `DefaultResourceLoader.reload()` 同时会调用 `settingsManager.reload()`,因此 settings 实际上是被 loader 又重新读了一遍;第一次构造的 `SettingsManager` 是"短暂无效"的,真正生效的是 loader 内部那次 reload 之后的版本。`resourceLoader.reload()` 还会把这次耗时塞进 `time("resourceLoader.reload")`,可在调试输出里看到。

---

## 2. 阶段二:从既有会话恢复上下文

```ts
const existingSession = sessionManager.buildSessionContext();
const hasExistingSession = existingSession.messages.length > 0;
const hasThinkingEntry = sessionManager.getBranch().some(
  (entry) => entry.type === "thinking_level_change",
);
```

- `buildSessionContext()` 内部是 `buildSessionContext(this.getEntries(), this.leafId, this.byId)`(见 `session-manager.ts`):沿当前 leafId 走到根,把 `compactionSummary` 折叠成 user 消息、把 `branchSummary` 折叠成 user 消息、把所有 `message` 条目还原成 `AgentMessage`。返回结构是:
  ```ts
  interface SessionContext {
    messages: AgentMessage[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  }
  ```
- `hasThinkingEntry` 用来判断会话历史上是否显式记过 `thinking_level_change` 条目;有的话直接复用记录值,没有的话落到 settings 默认。

这一步的关键结论:**`createAgentSession` 对"继续上一次的会话"和"开新会话"是同一套代码**,靠 `hasExistingSession` 走分支。

---

## 3. 阶段三:模型决策

模型决策是"恢复 → 兜底 → 二次兜底"的三层回退逻辑:

### 3.1 第一层 —— 调用方显式 `options.model`

若提供了 `options.model`,直接使用,**不再看 SessionManager**。这给"用同一个 SDK 实例但每次绑定不同模型"的需求提供了入口。

### 3.2 第二层 —— 已有会话:从会话里恢复

```ts
if (!model && hasExistingSession && existingSession.model) {
  const restoredModel = modelRegistry.find(
    existingSession.model.provider,
    existingSession.model.modelId,
  );
  if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
    model = restoredModel;
  }
  if (!model) {
    modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
  }
}
```

`modelRegistry.find(provider, modelId)` 是纯索引查找(不抛、不查盘),找不到返回 `undefined`。即便找到了,如果 `hasConfiguredAuth()` 返回 false(凭据过期或被撤销),也不能用 —— 此时把 `modelFallbackMessage` 写好,留给后续 fallback 显示。

### 3.3 第三层 —— 兜底:`findInitialModel`

兜底函数在 `model-resolver.ts`,内部优先级是:**CLI 参数 > scoped models 第一项 > settings 默认 > 第一个有 auth 的 available model**。注意它在我们这条调用路径下仅传 `defaultProvider` / `defaultModelId` / `defaultThinkingLevel`,所以 CLI 和 scoped 这两条路径在此函数里都不会走到,实际效果等价于"看 settings 默认,再不行就用 `getAvailable()[0]`"。

`getAvailable()` 只返回 `hasConfiguredAuth() === true` 的模型,所以这一步保证拿到的模型一定有可用凭据。

如果 `model` 仍然 `undefined`(例如用户既没配默认、也没存任何 auth),`modelFallbackMessage = formatNoModelsAvailableMessage()` 给上层展示用。

后续如果使用了 fallback,`modelFallbackMessage` 会拼上 `Using <provider>/<id>` 后缀,让用户知道"恢复失败,我替你选了这个"。

---

## 4. 阶段四:思考级别决策与 clamp

```ts
let thinkingLevel = options.thinkingLevel;

// 1) 会话恢复了的话,沿用会话 / settings 默认
if (thinkingLevel === undefined && hasExistingSession) {
  thinkingLevel = hasThinkingEntry
    ? (existingSession.thinkingLevel as ThinkingLevel)
    : (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
}

// 2) 任何路径下都没拿到,落 settings 默认,再不行就 DEFAULT_THINKING_LEVEL
if (thinkingLevel === undefined) {
  thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
}

// 3) 按模型能力裁剪
if (!model) {
  thinkingLevel = "off";
} else {
  thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
}
```

- 第一档优先使用调用方显式值(例如 SDK 启动了"高温"模式)。
- 第二档在已恢复场景里区分:**会话历史上改过 thinking level** → 用会话记录的;**没改过** → 用 settings 默认。这两类合计决定了"恢复会话时不会出现意外的级别跳变"。
- 第三档兜底,从 settings 拿,没有就用 `DEFAULT_THINKING_LEVEL`(默认 `"medium"`,见 `defaults.ts`)。
- 最后过 `clampThinkingLevel(model, ...)`:把 `"xhigh"` / `"max"` 等仅部分模型族支持的值,按模型元数据裁剪到实际可达的最高档;实在拿不到模型时直接置 `"off"`(无模型输出思考,反正是空跑)。

---

## 5. 阶段五:工具集解析

```ts
const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
const allowedToolNames =
  options.tools ?? (options.noTools === "all" ? [] : undefined);
const excludedToolNames = options.excludeTools;

const excludedToolNameSet = excludedToolNames
  ? new Set(excludedToolNames)
  : undefined;

const initialActiveToolNames: string[] = (
  options.tools ? [...options.tools]
  : options.noTools ? []
  : defaultActiveToolNames
).filter((name) => !excludedToolNameSet?.has(name));
```

`createAgentSession` 只在 SDK 层做"白/黑名单筛选",**真正的工具注册、扩展包裹、提示词片段收集都在 `AgentSession` 构造器里**(因为那时 `ExtensionRunner` 已经构建好,可以从 `runner.getAllRegisteredTools()` 取扩展注册的工具)。这里的 `initialActiveToolNames` 仅作为给 `AgentSession` 构造器的初始值,后续可以被 `setActiveToolsByName()` 任意替换。

关键边界:

| 调用方组合 | `allowedToolNames` | `excludedToolNames` | `initialActiveToolNames` |
| --- | --- | --- | --- |
| 都不传 | `undefined`(全部允许) | `undefined` | `[read, bash, edit, write]` |
| `tools: ["read", "bash"]` | `["read", "bash"]` | `undefined` | `["read", "bash"]` |
| `noTools: "all"` | `[]` | `undefined` | `[]` |
| `noTools: "builtin"` | `undefined` | `[read, bash, edit, write]` | `[]`(被排除后空) |
| `excludeTools: ["bash"]` | `undefined` | `[bash]` | `[read, edit, write]` |
| `tools + excludeTools` | `[a, b]` | `[b]` | `[a]`(取 tools 后再过滤) |

注意 `tools` 与 `noTools` 互斥 —— `tools` 优先;`excludeTools` 始终在最后一道过滤。

---

## 6. 阶段六:构建 Agent

这是 `createAgentSession` 最重的一步,涉及多个 closure / 间接层。`Agent` 还没产生副作用,所有"按需触发"的动作都被构造成函数,然后**通过 `extensionRunnerRef` 这个 mutable ref 透传**给扩展运行时。这是 SDK 设计上最重要的一处间接。

### 6.1 `convertToLlmWithBlockImages`

```ts
const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
  const converted = convertToLlm(messages);
  if (!settingsManager.getBlockImages()) {
    return converted;
  }
  // 把 user/toolResult 中的 image 块替换为 "Image reading is disabled." 文本,
  // 并对相邻的占位文本去重
  return converted.map(...);
};
```

- 底层走 `messages.ts::convertToLlm`(把 `bashExecution`/`custom`/`branchSummary`/`compactionSummary` 这几个 coding-agent 私有的 `AgentMessage` 折叠成 LLM 能理解的 user 消息,见 § 与 `Agent与AgentSession类型全景.md` §6.1 的对应说明)。
- **"defense-in-depth"**:即使上游(扩展、TUI、MCP)塞了图,如果用户在 settings 里启用了 `images.blockImages`,这里把所有图的 `ImageContent` 都替换成 `"Image reading is disabled."` 文本占位 + 邻近去重。
- **每次 prompt 都动态读取 `settingsManager.getBlockImages()`** —— 用户在会话中途切了开关,下一次 LLM 调用立刻生效,无需重建 Agent。

### 6.2 `extensionRunnerRef` —— 延迟初始化扩展句柄

```ts
const extensionRunnerRef: { current?: ExtensionRunner } = {};
```

`AgentSession` 构造期间才会真正 `new ExtensionRunner(...)`,而 `Agent` 必须在 `AgentSession` 之前构造完。`extensionRunnerRef` 是这个时序空缺的"桥":

- 装到 `Agent` 上的 `streamFn`/`onPayload`/`onResponse`/`transformContext` 都通过 `extensionRunnerRef.current` 读扩展句柄。
- 调用这些 closure 时如果 `current === undefined`(扩展还没建好),它们就回退成"什么都不做"。
- 一旦 `AgentSession` 构造完写入了 `extensionRunnerRef.current = runner`,后续所有调用就走扩展路径。

### 6.3 装入 Agent 的闭包

`new Agent({...})` 时把以下字段全部用闭包包起来,使其"懒"地依赖运行时状态:

#### `streamFn` —— LLM 流式调用的总入口

```ts
streamFn: async (model, context, options) => {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const env = auth.env || options?.env
    ? { ...(auth.env ?? {}), ...(options?.env ?? {}) }
    : undefined;

  const providerRetrySettings = settingsManager.getProviderRetrySettings();
  const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
  // SDKs 把 timeout=0 视作 0ms(立即超时),不是"无限"。用 int32 上限模拟关闭
  const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
  const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
  const websocketConnectTimeoutMs =
    options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();

  let headers = mergeProviderAttributionHeaders(
    model,
    settingsManager,
    options?.sessionId,
    auth.headers,
    options?.headers,
  );

  // 让扩展在静态拼装之后、HTTP 调用之前再注入/调整 header
  const headerRunner = extensionRunnerRef.current;
  if (headerRunner?.hasHandlers("before_provider_headers")) {
    headers = await headerRunner.emitBeforeProviderHeaders(headers ?? {});
  }

  return streamSimple(model, context, {
    ...options,
    apiKey: auth.apiKey,
    env,
    timeoutMs,
    websocketConnectTimeoutMs,
    maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
    headers,
  });
}
```

职责:

1. **凭据解析**:`modelRegistry.getApiKeyAndHeaders(model)` —— **每次 LLM 调用都重新解析**(用户切换凭据、改 OAuth 状态等马上生效)。`ok === false` 时直接抛错进入上层 `agent_end` 的失败分支。
2. **环境注入**:把 `auth.env` 与 `options.env` 合并;两者都没有就不传。
3. **timeout / retry 折叠**(按 settings → provider → `options` 优先级合并):
   - `timeoutMs`:settings 中按 provider 配置,否则 `httpIdleTimeoutMs`(0 表示无限,这里转 int32 最大值规避 SDK 把 0 当 0ms 立即超时)。
   - `websocketConnectTimeoutMs`:settings 优先,否则用 options 已有值。
   - `maxRetries` / `maxRetryDelayMs`:provider retry settings 优先,否则透传 `options.*`,否则 SDK 默认。
4. **attribution header 合并**:`mergeProviderAttributionHeaders` 把 provider 默认 attribution、auth 提供的 session header、`options.headers` 三层合并,`undefined` 字段会被去空。
5. **`before_provider_headers` 扩展钩子**:合并后、HTTP 调用前,扩展可以再加一层 header。这给"tracing correlation"等需求留了入口,同时不会破坏静态配置。
6. 最后 `streamSimple` 返回 `AssistantMessageEventStream`,自然被 `runAgentLoop::streamAssistantResponse` 消费。

#### `onPayload` —— 出站 payload 拦截

```ts
onPayload: async (payload, _model) => {
  const runner = extensionRunnerRef.current;
  if (!runner?.hasHandlers("before_provider_request")) return payload;
  return runner.emitBeforeProviderRequest(payload);
}
```

provider 真正发请求前最后一次修改 payload 的机会。如果扩展没注册,直接返回原对象(零开销)。

#### `onResponse` —— 入站响应拦截

```ts
onResponse: async (response, _model) => {
  const runner = extensionRunnerRef.current;
  if (!runner?.hasHandlers("after_provider_response")) return;
  await runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers });
}
```

收到 HTTP 响应后、读取 body 前触发。常用于埋点/metrics。返回值不会被 SDK 消费,只用于副作用。

#### `transformContext` —— 在 `convertToLlm` 之前的 AgentMessage 形变

```ts
transformContext: async (messages) => {
  const runner = extensionRunnerRef.current;
  if (!runner) return messages;
  return runner.emitContext(messages);
}
```

`AgentLoopConfig.transformContext` 先于 `convertToLlm` 执行(见 `agent-loop.ts::streamAssistantResponse`),常用于扩展做"上下文窗口裁剪、按需注入外部信息"。

#### 状态传递类字段

```ts
sessionId: sessionManager.getSessionId(),
steeringMode: settingsManager.getSteeringMode(),
followUpMode: settingsManager.getFollowUpMode(),
transport: settingsManager.getTransport(),
thinkingBudgets: settingsManager.getThinkingBudgets(),
maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
```

这些每次构造 Agent 都会重新从 settings 读一次,但运行期间用户改 settings 的影响**不会**自动扩散(因为 Agent 字段是值类型快照)。和 §6.1 中"每次 prompt 读 settings"的设计是互补关系:prompt 级别的瞬时状态凭每次重读生效,Agent 级配置则在构造时一次性快照。

`initialState` 写入 `systemPrompt: ""`(占位)、`model`、`thinkingLevel`、`tools: []`。`systemPrompt` 真正的内容由 `AgentSession` 在 `bindExtensions()` 之后通过 `_rebuildSystemPrompt()` 写入。

---

## 7. 阶段七:把会话历史灌进 Agent

```ts
if (hasExistingSession) {
  agent.state.messages = existingSession.messages;
  if (!hasThinkingEntry) {
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }
} else {
  // 新会话:把本次的 model/thinkingLevel 落盘,保证"resume 时能恢复"
  if (model) {
    sessionManager.appendModelChange(model.provider, model.id);
  }
  sessionManager.appendThinkingLevelChange(thinkingLevel);
}
```

两种走向的语义:

- **续会话**:把 `buildSessionContext` 解析出的消息整体塞进 `agent.state.messages`(注意 `AgentState.tools`/`messages` 的 setter 在赋值时会 `slice()` 复制一份顶层数组)。**如果历史上没显式改过 thinking level,补一条 `thinking_level_change` entry**,这样下次 resume 不会再走 settings 默认。
- **开新会话**:**主动写入 `model_change` 与 `thinking_level_change` entry**。即便用户还没发任何 prompt,session 文件里也已经记下了"初始模型是 X,初始思考级别是 Y"。这保证"以后用 `--continue` 续这个会话,模型和思考级别都不会莫名其妙地变成 settings 默认"。

`appendModelChange` / `appendThinkingLevelChange` 内部都是 `generateId(this.byId)` + 写入 JSONL,append-only 树形结构。

---

## 8. 阶段八:构造 AgentSession 并返回

```ts
const session = new AgentSession({
  agent,
  sessionManager,
  settingsManager,
  cwd,
  scopedModels: options.scopedModels,
  resourceLoader,
  customTools: options.customTools,
  modelRegistry,
  initialActiveToolNames,
  allowedToolNames,
  excludedToolNames,
  extensionRunnerRef,
  sessionStartEvent: options.sessionStartEvent,
});
const extensionsResult = resourceLoader.getExtensions();

return { session, extensionsResult, modelFallbackMessage };
```

`AgentSession` 构造器(详见 `Agent与AgentSession类型全景.md` §2)会:

1. 立刻 `subscribe(_handleAgentEvent)`,把会话持久化、扩展事件、自动 compaction 触发、auto-retry 计数等内部钩子挂上。
2. 调 `_installAgentToolHooks()`,**把 `agent.beforeToolCall` / `agent.afterToolCall` 重写**为扩展桥接版本(从这一秒起,Agent 自带的同名钩子就被替换)。
3. 调 `_installAgentNextTurnRefresh()`,安装一个固定的 `prepareNextTurnWithContext`,负责每次翻 turn 时把系统提示词和工具集刷新成当前最新值。
4. 调 `_buildRuntime(...)`,创建 `ExtensionRunner`、写入 `extensionRunnerRef.current = runner`(此时 §6.2 中的所有"懒闭包"才真正有扩展可用)、跑 `bindCore`、`applyExtensionBindings`。
5. 用 `initialActiveToolNames` 启动一轮 `_refreshToolRegistry()`,把内置 + 扩展工具合并,写入 `agent.state.tools`,并触发 `_rebuildSystemPrompt()`。

最终返回的 `session.extensionsResult` 取自 `resourceLoader.getExtensions()`,它**就是 `_buildRuntime` 内部那个 `ExtensionRunner` 背后的 `LoadExtensionsResult`**,因此 UI 上做 `bindExtensions(...)` 时可以直接拿这个结果去初始化 UI context,而无需再次扫描。

---

## 9. 全流程时序图(文字版)

```
调用 createAgentSession(options)
  │
  ├─ 解析 cwd / agentDir(均经 resolvePath)
  ├─ 构造 authStorage / modelRegistry / settingsManager / sessionManager
  │     (若 caller 已传入,则跳过对应工厂)
  ├─ 构造 resourceLoader (DefaultResourceLoader) 并 await .reload()
  │     ├─ packageManager.resolve()
  │     ├─ 加载扩展(支持 inline factories)
  │     ├─ 加载 skill / prompt template / theme / AGENTS.md 上下文文件
  │     └─ time("resourceLoader.reload")
  │
  ├─ 读历史:buildSessionContext() + hasThinkingEntry
  │
  ├─ 模型决策
  │     ├─ options.model?
  │     ├─ hasExistingSession && existingSession.model?
  │     │     └─ modelRegistry.find() + hasConfiguredAuth() ?
  │     └─ findInitialModel() 兜底
  │           (CLI/scoped 在此调用路径下不命中,实际走 settings 默认 → first available)
  │
  ├─ 思考级别决策
  │     ├─ options.thinkingLevel
  │     ├─ existingSession / settings 默认
  │     └─ clampThinkingLevel(model, level)
  │
  ├─ 解析 initialActiveToolNames + 白/黑名单
  │
  ├─ new Agent({
  │     initialState: { systemPrompt: "", model, thinkingLevel, tools: [] },
  │     convertToLlm: convertToLlmWithBlockImages,
  │     streamFn:    (见 §6.3,带 auth/timeout/header/扩展钩子)
  │     onPayload:   (扩展 before_provider_request 钩子)
  │     onResponse:  (扩展 after_provider_response 钩子)
  │     transformContext: (扩展 emitContext 钩子)
  │     sessionId / steeringMode / followUpMode / transport / thinkingBudgets / maxRetryDelayMs,
  │     // extensionRunnerRef 被这些闭包通过 .current 读取,此时仍 undefined
  │  })
  │
  ├─ 灌入历史 / 补会话条目
  │     ├─ hasExistingSession: 灌 messages,无 thinking_entry 则补一条
  │     └─ 否则:appendModelChange + appendThinkingLevelChange
  │
  ├─ new AgentSession({ agent, sessionManager, settingsManager, cwd,
  │                       scopedModels, resourceLoader, customTools,
  │                       modelRegistry, initialActiveToolNames,
  │                       allowedToolNames, excludedToolNames,
  │                       extensionRunnerRef, sessionStartEvent })
  │     └─ 内部: subscribe → _installAgentToolHooks → _installAgentNextTurnRefresh
  │              → _buildRuntime → 创建 ExtensionRunner → 写 extensionRunnerRef.current
  │              → bindCore / applyExtensionBindings
  │              → _refreshToolRegistry → 写入 agent.state.tools
  │              → _rebuildSystemPrompt → 写入 agent.state.systemPrompt
  │
  └─ return { session, extensionsResult, modelFallbackMessage }
```

调用方拿到 `session` 后:

- TUI / 打印 / RPC 三种 mode 在 session 上再 `bindExtensions({ uiContext, mode, ... })`,触发 `session_start` 扩展事件。
- `session.prompt(text, options?)` 走"extension 输入拦截 → 模板/skill 展开 → 队列 or 校验 model/auth → 调 `agent.prompt`"路径。
- 任何 LLM 调用实际跑到 `streamSimple` 时,`streamFn` 里读到的 `modelRegistry`、`settingsManager`、`extensionRunnerRef.current` 才反映"此刻的运行时"。

---

## 10. 与其他文档的关系

- `Agent`/`AgentState`/`AgentContext`/`AgentLoopConfig`/`Message` 的字段语义与生命周期,见 `Agent与AgentSession类型全景.md`。本篇是它的"上游组装手册"——专门解释 `Agent` / `AgentLoopConfig` 字段是怎么被填进去的、`streamFn` 闭包为什么长这样。
- `beforeToolCall` / `afterToolCall` 在 `Agent` 上被 `AgentSession` 重写为扩展桥接的细节,见 `Agent与AgentSession类型全景.md` §8(同名工具回调在 Agent 与 AgentLoopConfig 中的差异)。
- 扩展钩子(`tool_call` / `tool_result` / `before_provider_request` / `after_provider_response` / `input` / `message_end` 等)的触发时机,见 `AgentSession::_handleAgentEvent` / `_emitExtensionEvent`(`packages/coding-agent/src/core/agent-session.ts`)以及扩展系统自身的 `ExtensionRunner` 实现。

---

## 11. 常见边界

- **冷启动**:第一次调用 `createAgentSession` 时,扩展扫描 + 包管理器解析 + `AGENTS.md` 上下文文件读取都会同步阻塞。建议 SDK 集成者在子进程/worker 内调用,或复用已 reload 过的 `resourceLoader`。
- **in-memory session**:传 `SessionManager.inMemory()`(或自定义 `SessionManager`)即可关掉磁盘持久化,但仍占 `sessionId`。`createAgentSession` 不区分 in-memory 与文件后端,行为完全相同。
- **没有可用模型**:`model === undefined` 不会抛,而是让 `modelFallbackMessage` 落盘;真正报错是用户尝试 `prompt()` 时(`AgentSession.prompt()` 里 `_modelRegistry.hasConfiguredAuth` 失败,或 `formatNoApiKeyFoundMessage`)。如需 fail-fast,在调用方自行 `modelRegistry.getAvailable()` 校验。
- **没有扩展**:`extensionRunnerRef.current` 永远是 `undefined`,所有 hook 闭包分支都走"不做",无运行时开销。
- **多实例**:同一个 `modelRegistry`/`sessionManager`/`resourceLoader`/`settingsManager` 可以被多个 `createAgentSession` 共享,但 `Agent` 实例之间不共享 `agent.state`。同一进程可建多个 `session`,分别 prompt。

---

## 12. 一句话总结

`createAgentSession` 把"凭据 + 模型 + 会话 + 资源 + 扩展"的横切关注点一次性装到 `Agent` 闭包里,再通过 `extensionRunnerRef` 这个 mutable ref 让"扩展运行时还没就绪 vs. 就绪后"对 `Agent` 透明;随后用 `AgentSession` 接管状态持久化、工具钩子、system prompt 重建,最终返回一个可以直接 `prompt()` 的会话对象。

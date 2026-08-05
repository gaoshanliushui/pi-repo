# Pi 智能体资源加载流程（含 Extensions 详解）

本文档基于 `packages/coding-agent/src/core/` 下的源码，描述 pi 智能体在一次会话启动时如何把各类资源（扩展 / 技能 / 提示模板 / 主题 / 项目上下文文件 / 系统提示）从磁盘、npm、git、CLI 临时参数、内联工厂中发现、解析、合并并交给上层使用。重点放在 Extensions 的完整加载链。

## 0. 入口与协作对象

| 文件 | 职责 |
| ---- | ---- |
| `core/resource-loader.ts` | 资源装配中枢：`DefaultResourceLoader.reload(options)` 是主入口；对外暴露 `getExtensions/getSkills/getPrompts/getThemes/getAgentsFiles/getSystemPrompt/getAppendSystemPrompt` 等只读接口；并提供 `extendResources(paths)` 动态追加 skill/prompt/theme 路径 |
| `core/package-manager.ts` | `DefaultPackageManager`：把 `SettingsManager.packages`（npm/git/local）与 `SettingsManager.extensions/skills/prompts/themes`（显式路径列表）合并，自动发现 `agentDir/.pi/extensions`、`cwd/.pi/extensions` 等目录里的资源；按优先级排序后产出 `ResolvedPaths` |
| `core/extensions/loader.ts` | 真正加载扩展：用 `jiti` 在 Node 中解析 TS、用 `virtualModules` 在 Bun 二进制中供给内置包别名；调用扩展工厂 `factory(api)` 让扩展向自身注册 hooks/tools/commands/flags 等 |
| `core/extensions/runner.ts` | 把加载好的扩展装到运行时：`ExtensionRunner.bindCore(...)` 把 `ExtensionRuntime` 上的 stub 方法换成真实实现并 flush 预绑期间收集的 provider 注册 |
| `core/settings-manager.ts` | 持有全局 / 项目设置；`projectTrusted` 决定项目本地资源是否参与发现 |
| `core/event-bus.ts` | 扩展可见的 `events: EventBus`；也用于 extension load 的进度广播 |
| `core/source-info.ts` | 把 `PathMetadata` 转成可读的 `SourceInfo`（path/source/scope/origin/baseDir） |

`SettingsManager` 中 `PackageSource` 支持两种形态：

```ts
type PackageSource =
  | string                                          // 装载该包所有资源
  | { source: string; autoload?: boolean;            // 过滤模式（白名单）
      extensions?: string[]; skills?: string[];
      prompts?: string[]; themes?: string[] };
```

`autoload: false` 表示“不自动加载，仅按显式 patterns 应用 delta”，常用于项目级对全局包的精细裁剪。

## 1. 总体流程

```
DefaultResourceLoader.reload(options)
 ├── resetTimings / clearExtensionCache (再次调用)
 ├── [可选] loadProjectTrustExtensions()
 │     └── 在 projectTrusted=false 状态下做一次不信任扫描，交给上层决定是否授信
 ├── settingsManager.reload()
 ├── packageManager.resolve()                       → ResolvedPaths (extensions/skills/prompts/themes)
 ├── packageManager.resolveExtensionSources(additionalExtensionPaths, { temporary: true })
 │     → ResolvedPaths (CLI 临时)
 ├── collect 元数据 → metadataByPath
 ├── loadFinalExtensionSet(extensionPaths, preTrustExtensions)  ←─ 重点，见 §3
 │     ├── loadExtensionsCached(...)
 │     ├── loadExtensionFactories(runtime)         ←─ 内联 factory，<inline:name>
 │     └── addExtensionConflictDiagnostics(...)
 ├── extension path → 走 existsSync 校验 → 把不存在的写进 errors
 ├── skill / prompt / theme 合并 + 装载 + override + sourceInfo
 ├── agentsFiles (AGENTS.md / CLAUDE.md 沿 cwd 向上爬)
 ├── systemPrompt / appendSystemPrompt (源文件或字符串)
 └── this.loaded = true
```

## 2. `PackageManager.resolve()` —— 资源发现（不限于扩展）

`resolve(onMissing?)` 是“无状态”的纯查找（带按需安装），输出 `ResolvedPaths`：

1. **包源合并**：依次读取 `projectSettings.packages`、`globalSettings.packages`，用 `dedupePackages` 去重（项目优先；若项目对象标记 `autoload:false` 则作为 user 版本的 delta 并存）。
2. **`resolvePackageSources`** 逐包解析：
   - `npm:foo@1.2.3` → `getNpmInstallPath` → 若缺失或版本不匹配就调用 `installMissing()`（受 `PI_OFFLINE`、`onMissing("skip"/"error")` 控制）。
   - `git:...` → `getGitInstallPath`；临时源会 `refreshTemporaryGitSource` 主动 `git fetch/reset --hard`。
   - 本地路径 → `resolveLocalExtensionSource` 处理（直接指向文件 / 目录或指向 npm package 根）。
3. **`collectPackageResources`**：先读 `package.json#pi` manifest（`{ extensions, skills, prompts, themes }` 字符串数组，支持 `! + -` 模式）→ 否则按 `packageRoot/extensions|skills|prompts|themes/` 目录约定。
4. **本地列表**：对四类资源类型，分别用 `resolveLocalEntries(projectEntries, ...)` 和 `resolveLocalEntries(globalEntries, ...)`，先把非 pattern 路径收成 `plain`，再 `applyPatterns` 决定每个文件是否启用。`source: "local"`、`scope: "project"/"user"`。
5. **自动发现** `addAutoDiscoveredResources`：
   - `projectTrusted` 为真时扫 `cwd/.pi/extensions|skills|prompts|themes`。
   - 项目 `.agents/skills`（仅当 `projectTrusted` 为真）从 `cwd` 沿父目录爬到 `.git` 根。
   - 全局 `agentDir/.pi/extensions|skills|prompts|themes` + `~/.agents/skills`。
   - 自动发现的条目 `source: "auto"`，并用 settings 里的同名键（如 `globalSettings.extensions`）作为 `! + -` 覆盖：`!pattern` 排除、`+exact` 强制包含、`-exact` 强制排除（`isEnabledByOverrides`）。
6. **`toResolvedPaths`**：每类按 `resourcePrecedenceRank` 排序——`project/local` 0 → `project/auto` 1 → `user/local` 2 → `user/auto` 3 → `package` 4，相同路径用 `canonicalizePath` 去重。

`resolveExtensionSources(additionalExtensionPaths, { temporary: true })` 是 CLI 临时路径通道：每个 source 被看作 `scope: "temporary"` 的包源，走相同的 `resolvePackageSources`（不读 settings、不在 trusted gating 下做事），最终只用来拿 extension 路径。

### 2.1 路径收集的目录约定

- **扩展**：`collectAutoExtensionEntries(dir)` 行为见 §3.1（特殊）。
- **技能**：`collectSkillEntries(dir, mode)`——`mode === "pi"` 时根目录下任何 `*.md` 视为裸技能；任何子目录若包含 `SKILL.md` 则以该子目录为单位；`mode === "agents"` 仅取子目录里的 `SKILL.md`。
- **提示模板**：`collectAutoPromptEntries(dir)` = 顶层 `*.md`（忽略 node_modules 和隐藏项，按 `.gitignore`/`.ignore`/`.fdignore`）。
- **主题**：`collectAutoThemeEntries(dir)` = 顶层 `*.json`。
- 文件收集器 `collectFiles` 自动跳过 `node_modules`、隐藏项、`.gitignore` 等，符号链接会 `statSync` 解析。

### 2.2 优先级与覆盖（applyPatterns 语义）

| 模式 | 含义 |
| ---- | ---- |
| `plain` | 通配匹配，命中则加入 |
| `!pattern` | 排除命中项 |
| `+path` | 强制包含精确路径 |
| `-path` | 强制排除精确路径 |

顺序：includes → excludes → force-includes → force-excludes。skill 的精确匹配额外比对其父目录（因为 SKILL.md 目录才是 unit）。`isEnabledByOverrides` 用相同语义但用于自动发现的覆盖。

## 3. Extensions 加载全链路

### 3.1 路径发现（`PackageManager` 层）

`collectAutoExtensionEntries(dir)` 是扩展目录的入口：

1. **根目录优先**：若 `dir/package.json` 存在且 `pi.extensions` 非空，返回 `package.json` 声明的文件（`existsSync` 过滤）；否则若 `dir/index.ts` / `dir/index.js` 存在，单独返回它。这是“把扩展当作 npm 包”的形式。
2. **目录扫描**：否则遍历 `dir` 顶层：
   - 文件：`*.ts` / `*.js` → 直接作为 entry。
   - 子目录：用 `resolveExtensionEntries(fullPath)` 探测它——若子目录内含 `package.json#pi.extensions`，按声明加载；否则若 `index.ts`/`index.js`，单文件加载。
   - 都未命中则该子目录被忽略（**不在更深层递归**，复杂布局必须用 manifest）。
   - 隐藏项和 `node_modules` 跳过，`.gitignore` 类的 ignore 规则生效。

`loadExtensionsCached`（在 `core/extensions/loader.ts`）封装的就是 `loadExtensionsInternal(paths, ..., useCache=true)`，**真正逐个 file path 加载扩展模块**。

### 3.2 路径汇总（`ResourceLoader` 层）

`DefaultResourceLoader.reload(options)` 把“已启用扩展路径”按以下顺序合并：

```
extensionPaths =
   noExtensions ? cliEnabledExtensions
                : mergePaths(cliEnabledExtensions, enabledExtensions)
```

`enabledExtensions` 来自 `packageManager.resolve().extensions.filter(enabled=true)`；`cliEnabledExtensions` 来自 `resolveExtensionSources(additionalExtensionPaths, { temporary: true })`，并被强制打上 `{ source: "cli", scope: "temporary", origin: "top-level" }`。

`mergePaths` 用 `resolvePath(p, cwd, { trim: true })` + `canonicalizePath` 去重，保证相同路径只入队一次。

### 3.3 信任双阶段加载

`DefaultResourceLoader` 在调用方传入 `resolveProjectTrust` 时执行双阶段：

```
loadProjectTrustExtensions():
  settingsManager.setProjectTrusted(false)
  settingsManager.reload()
  return loadCurrentExtensionSet({ includeInlineFactories: true })
```

`loadCurrentExtensionSet`：

```
enabledExtensions  = resolvedPaths.extensions.filter(enabled).map(path)
cliEnabledExtensions = cliExtensionPaths.extensions.filter(enabled).map(path)
extensionPaths = noExtensions ? cliEnabledExtensions : mergePaths(cliEnabledExtensions, enabledExtensions)
loadExtensionsCached(extensionPaths, cwd, eventBus)
if (includeInlineFactories):
    inlineExtensions = await loadExtensionFactories(runtime)
    push inlineExtensions.extensions + errors
```

**关键点**：第一次扫描在“项目不信任”状态下完成，因此 `packageManager.resolve()` 不会把项目本地 `cwd/.pi/extensions` 与 `cwd/.pi/packages` 等纳入。然后 `loadFinalExtensionSet` 用第一次的结果作预热，避免双跑。

### 3.4 最终加载 `loadFinalExtensionSet`

```
loadFinalExtensionSet(extensionPaths, preTrustExtensions):
  if !preTrustExtensions:
      r = loadExtensionsCached(extensionPaths, cwd, eventBus)
      r.extensions.push(...loadExtensionFactories(r.runtime).extensions)
      r.errors.push(...loadExtensionFactories(...).errors)
      addExtensionConflictDiagnostics(r)
      return r
  // 复用预热结果
  preloadedByPath = Map(preTrustExtensions.extensions
                          .filter(path !startsWith "<inline:")
                          .map(extension.resolvedPath → extension))
  failedPreloadPaths = Set(preTrustExtensions.errors.map(this.resolveExtensionLoadPath))
  remainingPaths = extensionPaths.filter(p =>
      !preloadedByPath.has(resolveExtensionLoadPath(p)) &&
      !failedPreloadPaths.has(resolveExtensionLoadPath(p)))
  remainingExtensions = await loadExtensionsCached(remainingPaths, cwd, eventBus, preTrustExtensions.runtime)
  // 重排：按用户给的 extensionPaths 顺序
  orderedExtensions = extensionPaths.map(p => loadedByPath.get(resolveExtensionLoadPath(p)))
                                     .filter(non-null)
  orderedExtensions.push(...inlineExtensions = preTrustExtensions.extensions.filter(<inline:>))
  result = { extensions: orderedExtensions, errors: [...preloadErrors, ...remainingErrors], runtime: preloadRuntime }
  addExtensionConflictDiagnostics(result)
  return result
```

`<inline:...>` 总是放在最后（不参与 `resolvedPath` 复用），且 inline 工厂只在第二次加载后的 `loadExtensionFactories` 中再次执行（第一次的 inline 结果从 `preTrustExtensions.extensions` 取）。

### 3.5 单个扩展加载（`extensions/loader.ts`）

入口 `loadExtension(extensionPath, cwd, eventBus, runtime, cacheToken?)`：

```
resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true })
factory = loadExtensionModule(resolvedPath, cacheToken)
if (!factory) → error "Extension does not export a valid factory function"
extension = createExtension(extensionPath, resolvedPath)
api = createExtensionAPI(extension, runtime, cwd, eventBus)
await factory(api)        // ← 扩展在此期间 registerTool/on/...
```

- `createExtension` 初始化空容器：`handlers/tools/commands/flags/shortcuts/messageRenderers/entryRenderers`；`sourceInfo` 暂为合成值，后续 `applyExtensionSourceInfo` 才会覆盖。
- `createExtensionAPI` 中**注册方法**直接写到扩展对象；**动作方法**都通过 `runtime.assertActive()` 检查会话是否失效后转给共享 `runtime`。

### 3.6 jiti / 虚拟模块 / 别名

`loadExtensionModule` 是核心加载器：

```
if (cacheToken 是当前 generation):   // extensionCache 按 (cwd, generation) 索引
    return extensionCache.get(resolvedPath)

jiti = createJiti(import.meta.url, {
    moduleCache: false,
    ...(isBunBinary
       ? { virtualModules: VIRTUAL_MODULES, tryNative: false }   // Bun 二进制
       : { alias: getAliases() })                                // Node / 开发态
})

module = await jiti.import(resolvedPath, { default: true })
factory = module as ExtensionFactory
if (typeof factory !== "function") return undefined
if (cacheToken 有效) extensionCache.set(resolvedPath, factory)
return factory
```

**虚拟模块表**（Bun 二进制使用，扩展 import 时直接拿到 `pi` 系列内置模块，避免文件系统解析）：

| 名字 | 指向 |
| ---- | ---- |
| `typebox` / `typebox/compile` / `typebox/value` / `@sinclair/typebox` 同名 | 对应 typebox 静态引入 |
| `@earendil-works/pi-agent-core` / `@mariozechner/pi-agent-core` | `_bundledPiAgentCore` |
| `@earendil-works/pi-tui` / `@mariozechner/pi-tui` | `_bundledPiTui` |
| `@earendil-works/pi-ai` / `@earendil-works/pi-ai/compat` / `@mariozechner/pi-ai` / `@mariozechner/pi-ai/compat` | `_bundledPiAiCompat`（旧 global API 的兼容入口） |
| `@earendil-works/pi-ai/oauth` / `@mariozechner/pi-ai/oauth` | `_bundledPiAiOauth` |
| `@earendil-works/pi-coding-agent` / `@mariozechner/pi-coding-agent` | `_bundledPiCodingAgent`（`core/index.ts`，因为 `loader.ts` 不被 `index.ts` re-export，避开循环依赖） |

**Node 别名表** `getAliases()`（运行时按 `import.meta.url` 算出）：

- `@earendil-works/pi-coding-agent` → `packages/coding-agent/index.js`
- 其余 pi 系列 → `packages/<pkg>/dist/index.js`（优先 workspace 物理路径，回退到 `import.meta.resolve`）
- typebox 通过 `require.resolve` 定位

这两个表确保扩展 `import "@earendil-works/pi-coding-agent"` 之类永远解析到 pi 自身的代码，而不是被 npm 解析到重复副本。

### 3.7 缓存策略

- `extensionCache` 按路径缓存工厂函数本身，但 **只在 token 匹配当前 (cwd, generation) 时生效**。
- `useExtensionCacheCwd(cwd)` 切换 cwd 会 `clearExtensionCache()`，并 `extensionCacheGeneration++` 让所有旧 token 失效。
- `DefaultResourceLoader.reload` 在非首次调用时主动 `clearExtensionCache()`，便于开发期间编辑扩展后热重载。

### 3.8 冲突诊断

`detectExtensionConflicts(extensions)`：

- 对每个扩展的 `tools.keys()` 与 `flags.keys()` 维护 `toolOwners/flagOwners: Map<string, path>`；
- 若同名 key 已存在且归属不同 path → push `{ path: ext.path, message: "Tool \"X\" conflicts with Y" }`；
- 冲突只入 `errors`，扩展本身保留，**调用顺序决定优先级**。

### 3.9 SourceInfo 应用

`applyExtensionSourceInfo(extensions, metadataByPath)`：

- `findSourceInfoForPath(ext.path, undefined, metadataByPath)` 优先命中 `metadataByPath`（CLI/包/Settings/local 四类 metadata 都会被收集），找不到时回退 `getDefaultSourceInfoForPath`。
- `getDefaultSourceInfoForPath` 按目录归属分类：
  - `agentDir/{skills,prompts,themes,extensions}` → `source: "local"`, `scope: "user"`
  - `cwd/.pi/{skills,prompts,themes,extensions}` → `source: "local"`, `scope: "project"`
  - 其他 → `source: "local"`, `scope: "temporary"`
  - `<inline:...>` 或 `<...>` 形式 → `source = tag`, `scope: "temporary"`
- 扩展的 `commands` / `tools` 都会继承扩展的 `sourceInfo`，便于 TUI/诊断展示来源。

### 3.10 内联工厂 `loadExtensionFactories`

```
for (i, input) in extensionFactories:
    isNamed = typeof input !== "function"
    factory = isNamed ? input.factory : input
    path = `<inline:${isNamed ? input.name : i+1}>`
    try:
        ext = await loadExtensionFromFactory(factory, cwd, eventBus, runtime, path)
        extensions.push(ext)
    catch err:
        errors.push({ path, error })
```

`loadExtensionFromFactory` 与文件路径流程同形，只是跳过 jiti 模块解析直接 `factory(api)`。这些 `<inline:...>` 扩展不进入 `extensionCache`，每次 `reload` 都会重新执行（这是合理的——内联代码本来就是新闭包）。

## 4. 与 Extensions 加载同时发生的其他资源

虽然本文聚焦 Extensions，但完整 reload 还并行做了：

- **Skills**：`mergePaths(cliEnabledSkills + enabledSkills, additionalSkillPaths)` → `loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false })`。`mapSkillPath` 对 `auto`/`package` 资源若目录含 `SKILL.md` 则把资源路径替换为具体文件。
- **Prompts**：`loadPromptTemplates` → `dedupePrompts`（按 name 首个胜出，其余入 collision diagnostic）；`systemPromptSource` 既可走文件，也可走原始字符串（`resolvePromptInput` 探测文件）。
- **Themes**：`loadThemes` 支持目录与单 `.json`；`dedupeThemes` 同样按 name 去重；同名 `agentDir/themes`、`cwd/.pi/themes` 都会进入扫描。
- **项目上下文文件**：`loadProjectContextFiles` 从 `agentDir` 开始取一份 AGENTS/CLAUDE.md，再从 `cwd` 一路向根，每个目录取一份（按顺序）。最终输出形如 `[agentDir/context, ...ancestorsToCwd]`，`agentsFilesOverride` 可整体替换。
- **系统提示**：`discoverSystemPromptFile` 优先 `cwd/.pi/SYSTEM.md`（需 `projectTrusted`），否则 `agentDir/SYSTEM.md`；`appendSystemPrompt` 同理，列表形式。

诊断（`ResourceDiagnostic`）三态：

- `error`：路径不存在 / 加载失败
- `warning`：theme 路径不是 json / 读目录失败
- `collision`：同 name 冲突时记录 winner/loser 路径

## 5. 信任、安全与作用域

- `projectTrusted = false` 时，`PackageManager` 不会把 `cwd/.pi/packages`、`cwd/.pi/extensions` 等纳入 `resolve()`；`addAutoDiscoveredResources` 同样跳过项目目录。
- `assertProjectTrustedForScope(scope)` 在 `scope === "project"` 的所有 npm/git 安装和存储路径写入时抛错——`ResourceLoader` 不会主动调用 install，但 `ResourceLoaderReloadOptions` 允许上层决定是否授信。
- 包管理器在执行 npm/git 操作时使用 `NETWORK_TIMEOUT_MS = 10000`，并发上限 `UPDATE_CHECK_CONCURRENCY = 4`、`GIT_UPDATE_CONCURRENCY = 4`；`PI_OFFLINE` 让所有 network 调用短路。
- `getExtensionTempFolder(agentDir)` 创建 `agentDir/tmp/extensions`（0o700），临时 npm/git 源安装到该目录下，加 hash 前缀避免冲突。
- `resolveManagedPath` 强制所有写入路径仍在 install root 之下（防止 `..` 逃逸）。

## 6. 动态扩展：`extendResources(paths)`

扩展 hook 在初次执行后，可能通过 `pi.sendUserMessage` 等动作驱动 `extendResources({ skillPaths, promptPaths, themePaths })`：

```
skillPaths/promptPaths/themePaths = normalizeExtensionPaths(...)
对每个 path 把 SourceInfo 写入 extension*SourceInfos
merge 到 last*Paths
update*FromPaths(last*Paths)   // 局部刷新，不全量 reload
```

`normalizeExtensionPaths` 把每条 `baseDir` 用 `resolveResourcePath` 解析到绝对路径；`mergePaths` 沿用全局的 `canonicalizePath` 去重。**只刷新 skill/prompt/theme 三类**——extension 本身追加需要在 `resource-loader` 层 `reload()` 全跑一次。

## 7. 失败模式与诊断传递

| 阶段 | 失败处理 |
| ---- | ---- |
| `PackageManager.resolve` 包源缺失 | 调用 `onMissing(source)` 决定 `install/skip/error`；非 fatal 时跳过 |
| 扩展模块 import 失败 | `errors: [{ path, error: "Failed to load extension: <msg>" }]`，继续加载其他扩展 |
| 工厂函数未导出函数 | `errors: [{ path, error: "Extension does not export a valid factory function" }]` |
| 工厂执行抛错 | 同上包装 |
| 同名 tool/flag 冲突 | 冲突入 `errors`，扩展保留 |
| 本地扩展路径不存在 | `errors: [{ path, error: "Extension path does not exist: <path>" }]` |
| Skill/Prompt/Theme 同名 | collision diagnostic，保留先入者 |
| 系统提示文件读失败 | `console.error` 警告，fallback 到原始字符串 |

## 8. 一次 reload 的完整时序图

```text
cli.ts → main.ts
   └── 构造 DefaultResourceLoader({ cwd, agentDir, settings, eventBus,
                                     additionalExtensionPaths, extensionFactories, ... })
   └── await loader.reload({ resolveProjectTrust })
          │
          ├── settingsManager.setProjectTrusted(false); settingsManager.reload()
          ├── packageManager.resolve()                   // trusted=false 视角
          ├── packageManager.resolveExtensionSources(additionals, {temporary:true})
          ├── loadExtensionsCached(...)                  // 信任预扫，仅 user/global + CLI + <inline:>
          │     └── jiti.import → factory(api) → 注册
          ├── 把 preTrustExtensions 交给上层 UI
          ├── settingsManager.setProjectTrusted(<UI answer>); settingsManager.reload()
          ├── packageManager.resolve()                   // 最终信任态
          ├── packageManager.resolveExtensionSources(additionals, {temporary:true})
          ├── loadFinalExtensionSet(...)                 // 复用预扫，只跑增量
          │     ├── loadExtensionsCached(remainingPaths, cwd, eventBus, preloadRuntime)
          │     ├── 重排 orderedExtensions（按用户给定 path 顺序）
          │     ├── push <inline:...> 扩展
          │     └── addExtensionConflictDiagnostics
          ├── 校验 additionalExtensionPaths 是否存在
          ├── applyExtensionSourceInfo(extensions, metadataByPath)
          ├── skill/prompt/theme 合并 + 装载 + override + sourceInfo
          ├── agentsFiles = loadProjectContextFiles({cwd, agentDir})
          ├── systemPrompt / appendSystemPrompt (file or string)
          └── this.loaded = true
   └── ExtensionRunner.bindCore(runtime, session, modelRegistry)
          └── 把 ExtensionRuntime 的 stub 方法换成真实实现
              flush pendingProviderRegistrations
   └── AgentSession 启动 → 工具/事件流经扩展 hooks
```

## 9. 调用方参考

- **headless**：`await loader.reload()` 后用只读 getter。
- **交互式 CLI**：`await loader.reload({ resolveProjectTrust })`，UI 根据 `preTrustExtensions` 弹授信。
- **SDK**：`extensionFactories` 注入内联扩展；`*Override` 重写结果；`extendResources` 在运行时挂新 skill/prompt/theme。

## 10. 相关文档

- `docs/extensions.md`：扩展作者向 API（`on/registerTool/...`）。
- `docs/sdk.md`：SDK 用法、注入扩展的方式。
- `docs/sessions.md`：扩展 hook 写入 session 的方式。
- `packages/coding-agent/src/core/extensions/loader.ts` 源码注释。
- `packages/coding-agent/src/core/extensions/runner.ts` 把 extension 绑到 runtime。
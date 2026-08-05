# 五大 manager 职责与关系

`SessionManager` / `SettingsManager` / `ProjectTrustStore`(trust-manager.ts)/ `DefaultPackageManager`(package-manager.ts)/ `tools-manager.ts` 是 pi 的五条长期存活"基础设施"。它们各自管一块独立状态,把同一份"运行中的 coding-agent 会话"持久化、配置、信任、扩展依赖、外部命令依赖这五个维度分别封装好,再由 `AgentSession` 和 `createAgentSession` 把它们横切拼起来。

下文按"各 manager 是什么" → "它们之间的关系" → "差异与共性" → "实际使用指南"四块展开。

---

## 0. 一句话定位

| manager | 一个比喻 | 持久化形态 | 生命周期 |
| --- | --- | --- | --- |
| `SessionManager` | 会话账本 | append-only JSONL,带 v1→v3 迁移、id/parentId 树 | 一个会话 |
| `SettingsManager` | 配置中心 | `settings.json`(global + project 两层 + lock) | 整个 agent 进程 |
| `ProjectTrustStore`(trust-manager.ts) | 信任登记簿 | `~/.pi/agent/trust.json`(`Record<cwd, bool\|null>`) | 全局 |
| `DefaultPackageManager`(package-manager.ts) | 资源/扩展的"包管理器" | `agentDir/npm`、`agentDir/git`、`<cwd>/.pi/{npm,git}`、`agentDir/tmp/extensions/*`、`<cwd>/.pi/{skills,prompts,themes,extensions}` | 整个 agent 进程 |
| `tools-manager.ts`(无 class) | `fd`/`rg` 二进制仓库 | `~/.pi/agent/bin/` + 临时解压目录 | 整个 agent 进程 |

> 注:`tools-manager.ts` 不导出 class,只导出 `getToolPath` / `ensureTool` 两个函数 + 私有 `downloadTool`,习惯上仍然按"manager"理解。下文沿用这个称谓。

---

## 1. SessionManager ——"会话账本"

源码:`packages/coding-agent/src/core/session-manager.ts`

### 1.1 角色

把"Agent 跑出来的所有事件"按 **append-only JSONL + id/parentId 树** 写盘。读出来能做:恢复上下文(`buildSessionContext`)、走分支(`branch(branchFromId)` / `branchWithSummary` / `createBranchedSession`)、找最近一次 compaction(`getLatestCompactionEntry`)、列所有会话(`SessionManager.list(...)` / `listAll(...)`)。

### 1.2 公共入口

- 静态工厂:`SessionManager.create(cwd, sessionDir?)` / `open(path, sessionDir?, cwdOverride?)` / `continueRecent(cwd, sessionDir?)` / `inMemory(cwd?, options?)` / `forkFrom(sourcePath, targetCwd, sessionDir?, options?)` / `list(...)` / `listAll(...)`。
- 实例方法(`append*` 是持盘写入):`appendMessage / appendThinkingLevelChange / appendModelChange / appendCompaction / appendCustomEntry / appendSessionInfo / appendCustomMessageEntry / appendLabelChange`。
- 读:`getCwd / getSessionDir / usesDefaultSessionDir / getSessionId / getSessionFile / isPersisted / getLeafId / getLeafEntry / getEntry / getChildren / getLabel / getBranch / buildContextEntries / buildSessionContext / getHeader / getEntries / getTree / getSessionName`。
- 树结构操作:`branch(branchFromId)` / `resetLeaf()` / `branchWithSummary(branchFromId, summary, details?, fromHook?)` / `createBranchedSession(leafId)`。
- 全集重置 / 切换:`setSessionFile(filePath)` / `newSession(options?)`。

### 1.3 数据模型

```ts
SessionEntry = SessionMessageEntry | ThinkingLevelChangeEntry | ModelChangeEntry
             | CompactionEntry | BranchSummaryEntry | CustomEntry | CustomMessageEntry
             | LabelEntry | SessionInfoEntry

FileEntry = SessionHeader | SessionEntry
SessionHeader = { type: "session"; version; id; timestamp; cwd; parentSession? }
```

session 文件 = `[header]\n[entry1]\n[entry2]\n...`,每行 JSON。`CURRENT_SESSION_VERSION = 3`,`migrateV1ToV2`(加 id/parentId 树、迁移 `firstKeptEntryIndex → firstKeptEntryId`)→ `migrateV2ToV3`(改名 `hookMessage → custom` role)。

### 1.4 关键算法

- **`byId` 索引** `_buildIndex()` 一次性建好(`O(n)`),`getEntry / getChildren / getBranch` 都基于它。
- **`buildSessionPath`**(递归走 parentId → root)用于 `getBranch()` 与 `buildContextEntries()`。
- **`buildContextEntries`** 把 compaction 之前的"已摘要条目"折叠成一个 `compaction` 节点,**只保留 `firstKeptEntryId` 及其之后的原始条目**,这样 LLM 看到的上下文就是"一段摘要 + recent entries"。
- **`buildSessionContext`** 在 `buildContextEntries` 之上调 `sessionEntryToContextMessages`:把 `compaction` / `branch_summary` / `custom_message` 条目转成可发给 LLM 的 `AgentMessage`,把 `custom` / `label` / `session_info` 排除。
- **`_persist` 延迟 flush** —— 没有 assistant 消息之前**不创建文件**,第一次有 assistant 输出时才把内存中的所有 entries 全量写出,之后才 append-only。这避免了"用户开了会话没发第一条消息就创建空 jsonl"。

### 1.5 与其他 manager 的关系

- **不读 settings**。它只知道 `cwd`(自己保存了一个拷贝,来源于 `setSessionFile` / `newSession(options)`)。
- **被 `AgentSession` 和 `ResourceLoader` 间接读** —— `AgentSession._handleAgentEvent` 在 `message_end` 时调 `appendMessage`,在 `sessionManager.appendModelChange` 等处同步落盘模型与思考级别变更。
- **`createBranchedSession` 是"从已有会话切出一个新 jsonl 文件"** 的内部工具 —— 由外部的 fork / newSession / switchSession 流程触发。

---

## 2. SettingsManager ——"配置中心"

源码:`packages/coding-agent/src/core/settings-manager.ts`

### 2.1 角色

把 `~/.pi/agent/settings.json`(global)和 `<cwd>/.pi/settings.json`(project)合并成一份**对外只读的 `Settings`**,并提供 *细粒度 set 方法*(修改全局 / 修改项目)+ *写时 lock*(防止并发覆盖)+ *deep merge*(嵌套对象字段级合并)+ *字段级修改追踪*(只为真改了的字段写盘)。

### 2.2 公共入口

- 静态:`SettingsManager.create(cwd, agentDir, options?)` / `fromStorage(storage, options?)` / `inMemory(settings?, options?)`。
- 读 getter:`getGlobalSettings / getProjectSettings / isProjectTrusted / getDefaultProvider / getDefaultModel / getSteeringMode / getFollowUpMode / getTheme / getDefaultThinkingLevel / getTransport / getCompactionSettings / getBranchSummarySettings / getRetrySettings / getProviderRetrySettings / getHttpIdleTimeoutMs / getWebSocketConnectTimeoutMs / getThinkingBudgets / getBlockImages / getEnabledModels / getSessionDir` 等上百个 getter。
- 改 setter:`setDefaultProvider / setDefaultModel / setDefaultModelAndProvider / setSteeringMode / setFollowUpMode / setTheme / setDefaultThinkingLevel / setTransport / setCompactionEnabled / setRetryEnabled / setHttpIdleTimeoutMs / setPackages / setProjectPackages / setExtensionPaths / setProjectExtensionPaths / setSkillPaths / setProjectSkillPaths / setPromptTemplatePaths / setProjectPromptTemplatePaths / setThemePaths / setProjectThemePaths` 等。
- 生命周期:`applyOverrides(overrides)`(再叠加一层,用于"启动期强制覆盖")、`reload()`(从磁盘重读)、`drainErrors()`(清空累积的 load/save 错误)、`flush()`(await 当前待写入队列)、`setProjectTrusted(trusted)`(trust-manager 改了之后回调这里)。

### 2.3 数据模型

`Settings` 是一个 *超长* 接口(83+ 字段),主要分组:

| 分组 | 例子 |
| --- | --- |
| 模型与模式选择 | `defaultProvider / defaultModel / defaultThinkingLevel / enabledModels` |
| 队列行为 | `steeringMode / followUpMode / transport` |
| 压上下文 / 重试 | `compaction / retry / providerRetry / branchSummary` |
| 资源扫描 | `packages / extensions / skills / prompts / themes / enableSkillCommands / externalEditor / shellPath / shellCommandPrefix / npmCommand` |
| UI / TUI | `theme / hideThinkingBlock / showCacheMissNotices / terminal / images / editorPaddingX / outputPad / autocompleteMaxVisible / showHardwareCursor / markdown / warnings / doubleEscapeAction / treeFilterMode / quietStartup` |
| 项目信任 / 遥测 | `defaultProjectTrust / enableInstallTelemetry / enableAnalytics / trackingId` |
| 其他 | `sessionDir / httpProxy / httpIdleTimeoutMs / websocketConnectTimeoutMs` |

### 2.4 关键算法

- **`deepMergeSettings`** 浅 + 嵌套深合并:对象字段再下一层 merge,数组/原始值直接覆盖。
- **`modifiedFields` + `modifiedNestedFields`**:每次 setter 调 `markModified(field, nestedKey?)` 记录"这一会话改了哪些字段"。
- **`save()` 走 `enqueueWrite`**:内部维护 `writeQueue: Promise<void>` 串行化所有写入,避免并发覆盖。先 `structuredClone` 一次快照,然后清 `modified*`,再 `persistScopedSettings(...)` 调 `storage.withLock(...)`。
- **`FileSettingsStorage.withLock`**:`proper-lockfile` 同步加锁,`ELOCKED` 时重试 10 次 × 20 ms。
- **`migrateSettings`**:加载时跑(把旧 `queueMode → steeringMode`、旧 `websockets: bool → transport`、旧 `skills: { enableSkillCommands, customDirectories } → skills[] + enableSkillCommands`、`retry.maxDelayMs → retry.provider.maxRetryDelayMs`)。
- **`setProjectTrusted(trusted)`** 会清空所有 `modifiedProjectFields`,未 trust 时把 `projectSettings = {}`,已 trust 时重新从磁盘读 project 部分。

### 2.5 与其他 manager 的关系

- **被 `DefaultPackageManager` 依赖**:`pm.settingsManager.getGlobalSettings() / getProjectSettings() / getNpmCommand() / isProjectTrusted()` 全从这里读。
- **被 `createAgentSession` 依赖**(`sdk.ts`):构造 `Agent` 时把 `settingsManager.getSteeringMode / getFollowUpMode / getTransport / getThinkingBudgets / getBlockImages` 等传递进去;构造 `streamFn` 闭包时同样读 `settingsManager.getProviderRetrySettings / getHttpIdleTimeoutMs / getWebSocketConnectTimeoutMs`。
- **被 `AgentSession` 依赖**:模型选择、思考级别、队列模式、压上下文等持久化都走它的 setter + 同步 `sessionManager.appendModelChange / appendThinkingLevelChange`。
- **被 `ResourceLoader.reload()` 依赖**:`~/.pi/agent/settings.json` 改了会触发 `settingsManager.reload()` → 整条 resource 链重新扫描。

---

## 3. ProjectTrustStore ——"信任登记簿"

源码:`packages/coding-agent/src/core/trust-manager.ts`(导出类 `ProjectTrustStore` + 工具函数 `getProjectTrustParentPath` / `getProjectTrustOptions` / `hasTrustRequiringProjectResources` / `readTrustFile` / `writeTrustFile` / `withTrustFileLock`)。

### 3.1 角色

把 *每个项目目录(absolute, normalized)* 是否被信任、是否被父级信任、是否曾经忽略、是否从未记录,**持久化为一份 `~/.pi/agent/trust.json` 全局字典**。`true` = 信任、`false` = 拒绝、`null` = 显式清掉。

### 3.2 公共入口

- 类 `ProjectTrustStore(agentDir)`:构造时把 `trustPath = <agentDir>/trust.json` 算好。实例方法 `get(cwd): boolean | null` / `getEntry(cwd): { path; decision } | null` / `set(cwd, decision)` / `setMany(decisions[])`。
- 工具函数:`getProjectTrustParentPath(cwd)`(取父目录),`getProjectTrustOptions(cwd, { includeSessionOnly })`(列出"Trust / Trust parent / Do not trust / 仅本会话..."选项),`hasTrustRequiringProjectResources(cwd)`(扫 `<cwd>/.pi/{settings.json,extensions,skills,prompts,themes,SYSTEM.md,APPEND_SYSTEM.md}` 与 `<cwd>/.agents/skills` + 祖先)。

### 3.3 数据模型

```ts
trust.json = Record<canonicalCwd, true | false | null>
```

字典的 key 是 `canonicalizePath(resolvePath(cwd))` 归一化的绝对路径;value 用 `proper-lockfile` 同步 lock + atomic write(`writeFileSync` 整个文件)。

### 3.4 关键算法

- **`findNearestTrustEntry(data, cwd)`**:从 `cwd` 开始沿父目录一级一级向上走,直到找到一条 key `value ∈ {true, false}` 记录。返回 `null` 表示"无记录"。
- **`getProjectTrustOptions`**:在 cwd 给用户列选项 —— Trust cwd / Trust parent(同时把 child 设为 null)/ Trust(this session only) / Don't trust / Don't trust(this session only)。
- **`writeTrustFile`** 对 key 做 lex sort,确保文件 deterministic。
- **`withTrustFileLock(path, fn)`** 用 `proper-lockfile.lockSync(trustDir, ..., lockfilePath: "<path>.lock")` 锁住整个 trust 目录,锁目录比锁文件强(防止 rename)。
- **`hasTrustRequiringProjectResources`**:忽略 `~/.agents/skills` 这种"用户级资源"(只信任 project-local)。`~/.agents/skills` 在 `~/.pi/agent/sessions/<cwd>/` 之外也算信任。

### 3.5 与其他 manager 的关系

- **被 `project-trust.ts::resolveProjectTrusted` 调用**(编排 `"extension project_trust event → getProjectTrustOptions → ui.select → trustStore.setMany"`)。
- **通过 `SettingsManager.setProjectTrusted`** 影响 `SettingsManager.projectTrusted` 字段;SettingsManager 拒绝向未 trust 的 project 写 settings(`assertProjectTrustedForWrite()`)。
- **通过 `DefaultPackageManager.isProjectTrusted()`** 阻止向未 trust 的 `<cwd>/.pi/npm`、`<cwd>/.pi/git` 写 install(`assertProjectTrustedForScope`)。
- **通过 `ResourceLoader.reload({ resolveProjectTrust })`** 编排"信任决策 → 项目 settings → 资源列表"。

---

## 4. DefaultPackageManager ——"扩展/技能/主题/包管理器"

源码:`packages/coding-agent/src/core/package-manager.ts`(导出 `DefaultPackageManager` 实现 `PackageManager` 接口)。

### 4.1 角色

把 settings 里的 `packages: PackageSource[]`(npm:`npm:@scope/name@ver` / git:`github:owner/name@ref` / 本地路径 / `package.json pi.{extensions,skills,prompts,themes}`)+ 项目本地 `<cwd>/.pi/{extensions,skills,prompts,themes}` + 用户级 `~/.pi/agent/{extensions,skills,prompts,themes}` + `~/.agents/skills`(祖先目录 + 用户级),**合并成一份带 precedence 的 `ResolvedPaths`**。同时提供 *install* / *update* / *remove* / *checkForAvailableUpdates*,覆盖 npm 项目安装(`npm install --legacy-peer-deps`)、git clone + reset、`.gitignore` 防云盘同步、`peer deps` 抑制等。

### 4.2 公共入口(全部 `Promise`,除非标注)

```ts
interface PackageManager {
  resolve(onMissing?): Promise<ResolvedPaths>;                  // ★ 主入口:聚合所有资源
  install(source, { local? }): Promise<void>;
  installAndPersist(source, { local? }): Promise<void>;
  remove(source, { local? }): Promise<void>;
  removeAndPersist(source, { local? }): Promise<boolean>;
  update(source?): Promise<void>;                              // 全部 / 单个更新
  listConfiguredPackages(): ConfiguredPackage[];               // 用于 UI / package CLI
  resolveExtensionSources(sources[], { local?, temporary? }): Promise<ResolvedPaths>;
  addSourceToSettings / removeSourceFromSettings(source, { local? }): boolean;  // 同步
  setProgressCallback(cb | undefined): void;                   // 进度回调
  getInstalledPath(source, scope: "user"|"project"): string | undefined;
}
```

### 4.3 数据模型

```ts
type PackageSource = string | { source: string; autoload?; extensions?; skills?; prompts?; themes?; }
type SourceScope = "user" | "project" | "temporary";

interface PathMetadata { source: string; scope: SourceScope; origin: "package"|"top-level"; baseDir?; }
interface ResolvedResource { path: string; enabled: boolean; metadata: PathMetadata; }
interface ResolvedPaths { extensions: ResolvedResource[]; skills: ResolvedResource[]; prompts: ResolvedResource[]; themes: ResolvedResource[]; }
```

`PackageSource` 是 settings 里的字符串形态;`origin: "package"` 表示从 npm/git 包来,`"top-level"` 表示直接由 settings 中 `extensions/skills/prompts/themes` 列表给出或自动发现。

### 4.4 关键算法

- **`resourcePrecedenceRank(metadata)`**:`0..4` 数值越小越高 —— `project+settings` > `project+auto` > `user+settings` > `user+auto` > `package`。`toResolvedPaths` 用这个 rank 排序后再按 canonical path 去重,实现"first-wins"的名字冲突消解。
- **`resolve()` 顺序**(核心):
  1. 收集 global + project `packages`,用 `dedupePackages` 去重(同 identity 保留 project entry;若 project entry `autoload=false` 则把 user entry 作为 delta base 保留)。
  2. `resolvePackageSources(...)` —— 对每个 source 视 `npm` / `git` / `local`,先确保安装(走 `installMissing()`),再调 `collectPackageResources(installedPath, ...)` 读 `package.json` 的 `pi.{extensions,skills,prompts,themes}` 字段或者 `<package>/extensions` 等约定目录,再 `applyPatterns` 走用户传入的 include/exclude/force-include/force-exclude glob。
  3. 解析 settings 的 top-level `extensions/skills/prompts/themes` 列表(`resolveLocalEntries`)—— 拆分 `plain` 和 `pattern`(以 `+ - !` 开头)两类,glob 用 minimatch 命中,相对路径基于 `projectBaseDir = <cwd>/.pi` 或 `globalBaseDir = <agentDir>`。
  4. `addAutoDiscoveredResources(...)` —— 扫 `<cwd>/.pi/{extensions,skills,prompts,themes}` 与 `~/.pi/agent/{extensions,skills,prompts,themes}`,**仅在 projectTrusted 时扫项目侧**;同时扫 `~/.agents/skills` 与祖先 `<cwd>/.agents/skills`(限制到 git 仓库根为止)。
  5. `toResolvedPaths(...)` 用 `resourcePrecedenceRank` 排序并 dedupe。
- **`applyPatterns(allPaths, patterns, baseDir)`** 四步走:include → exclude → force-include(`+`)→ force-exclude(`-`)。
- **`dedupePackages`** 按 `getPackageIdentity(source, scope)`(npm:`npm:<name>`,git:`git:<host>/<path>` —— 这样 SSH/HTTPS 同源)合并;project + `autoload=false` 的 user entry 视为 delta。
- **`getNpmInstallArgs(specs, installRoot)`** 按 `bun / pnpm / npm` 分发参数,且对每个都做 *抑制 peer deps*(因为 extension 是和 pi 一起跑的,自动装 peer 会扯进 pi 自己的依赖导致版本锁)。
- **`installGit` / `updateGit` / `ensureGitRef`**:`clone` → `fetch --prune --no-tags origin <ref>` → `rev-parse` 比对 → `reset --hard <ref>^{commit}` → `clean -fdx` → `npm install --omit=dev`(有 `package.json` 时)。
- **`resolveExtensionSources(sources[], { temporary: true })`** 写到 `~/.pi/agent/tmp/extensions/<prefix>/<sha8>/<name>`(`/` URL 重命名为 host/path 后),`temporary` 走 `getTemporaryDir("git-<host>", path)`,签出后会被 `refreshTemporaryGitSource` 在每次 `resolve()` 时拉一次(`updateGit` 路径)。`getExtensionTempFolder` 在第一次用时 `mkdirSync + chmodSync 0o700`。
- **`addSourceToSettings` / `removeSourceFromSettings`** 用 `packageSourcesMatch(leftKey, rightKey)` 去重,需要 `normalizePackageSourceForSettings` 把 local 路径转相对 baseDir 的稳定表示,避免绝对路径干扰 settings diff。
- **进度:**`setProgressCallback(cb)` 注册一个 `ProgressCallback`;内部 `withProgress(action, source, message, op)` 在每个 `install / remove / update / clone / pull` 外层包一层 emit `start / complete / error` 给 UI。
- **`checkForAvailableUpdates`**:对每个配置 package 同时发并发 ≤ 4 的"是否有新版"请求(npm view 最新 + 比对;git rev-parse 本地 vs remote ls-remote),返回 `PackageUpdate[]`。
- **`PI_OFFLINE=1`** 时 `isOfflineModeEnabled()` 短路 update / check / refreshTemporaryGitSource。

### 4.5 与其他 manager 的关系

- **依赖 `SettingsManager`** —— `getGlobalSettings / getProjectSettings / getNpmCommand / isProjectTrusted` 全是它的输入。
- **被 `trust-manager`** 间接影响 —— `assertProjectTrustedForScope` 拒绝往未 trust 的 `<cwd>/.pi/npm`、`<cwd>/.pi/git` 落盘;同时拒绝把资源从 `<cwd>/.pi/{extensions,skills,prompts,themes}`、`<cwd>/.agents/skills` 加载。
- **被 `ResourceLoader.reload()` 依赖** —— 调用 `packageManager.resolve(...)` 得到 `ResolvedPaths`,再按 `extensions/skills/prompts/themes` 灌进 `DefaultResourceLoader` 的内存缓存。

---

## 5. tools-manager.ts ——"`fd` / `rg` 二进制仓库"

源码:`packages/coding-agent/src/utils/tools-manager.ts`(无类,纯函数 + 私有 `TOOLS` 常量)。

### 5.1 角色

pi 的内置 `find` / `grep` 工具是 `fd` / `rg` 的 wrapper。`tools-manager.ts` 负责:

1. **优先查本地**:`~/.pi/agent/bin/{fd,rg}[.exe]`。
2. **回退查系统 PATH**:`fd` 接受 `fdfind`(Debian/Ubuntu),`rg` 接受 `rg`。
3. **都没有就自动下载**:`getLatestVersion(config.repo)` 走 GitHub `releases/latest` API;`downloadFile` 走 `fetch + pipeline(fileStream)`;Windows 走 tar.xf / PowerShell Expand-Archive,其他平台 tar xzf / unzip。
4. **删干净**:`rmSync(archive)` + `rmSync(extract_dir, recursive)`,并发安全(`extract_tmp_<binary>_<pid>_<ts>_<rand>` 防并发覆盖)。

### 5.2 公共入口

```ts
function getToolPath(tool: "fd" | "rg"): string | null;          // 查 bin/ 再查 PATH
async function ensureTool(tool: "fd" | "rg", silent?: boolean): Promise<string | undefined>;
```

### 5.3 数据模型

```ts
interface ToolConfig {
  name: string;             // "fd" / "ripgrep"
  repo: string;             // "sharkdp/fd" / "BurntSushi/ripgrep"
  binaryName: string;       // "fd" / "rg"
  systemBinaryNames?: string[];
  tagPrefix: string;        // "v" / ""
  getAssetName(version, plat, arch): string | null;
}

const TOOLS: Record<string, ToolConfig> = { fd: {...}, rg: {...} };
```

### 5.4 关键算法

- **`commandExists(cmd)`** 用 `spawnSync(cmd, ["--version"], { stdio: "pipe" })`;只要 `result.error === undefined` 即认为存在(ENOENT 会让 `result.error` 不是 undefined)。
- **`downloadFile`**:`AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS=120_000)`,`Readable.fromWeb(response.body)` 流入 `createWriteStream(dest)`。
- **`extractTarGzArchive`** 走 `tar xzf`;`extractZipArchive` 在 Windows 优先 `System32/tar.exe`(bsdtar),回退 PowerShell `Expand-Archive`,再回退 GNU `tar xf`,Unix 优先 `unzip -q` 回退 `tar xf`。
- **`downloadTool`** 步骤:getLatestVersion → mkdir `TOOLS_DIR` → `downloadFile` → 唯一临时目录 `extract_tmp_...` → extract → 在已知位置找(`<extractDir>/<asset名>/<binary>` 或回退到 `findBinaryRecursively` 扫目录)→ `renameSync` 到 `TOOLS_DIR/<binary>` → Unix 平台 `chmodSync 0o755` → 清理 archive + extract dir。
- **`isOfflineModeEnabled` / Android / Termux** 短路下载,给用户提示。

### 5.5 与其他 manager 的关系

**这一文件与其他 manager 完全解耦** —— 它不知道 SettingsManager / TrustStore / PackageManager。它只依赖 `getBinDir()`(在 `config.ts` 里,`~/.pi/agent/bin/`)。

但它**被上游消费**:

- `interactive-mode.ts` 启动时 `Promise.all([ensureTool("fd"), ensureTool("rg")])` 拿到 `fdPath / rgPath` 存到 mode 上,模式结束不再用。
- `core/tools/grep.ts` 工具内部在 LLM 调 `rg` 时 `ensureTool("rg", true)`(silent 模式),失败就 error 工具结果,不让 LLM 误以为代码坏了。
- `core/tools/find.ts` 同理,`ensureTool("fd", true)`。

---

## 6. 五个 manager 之间的"关系图"

```
            ┌──────────────────────────────────────────────────────────┐
            │                       createAgentSession                │
            │  (packages/coding-agent/src/core/sdk.ts)                │
            └──────────────────────────────────────────────────────────┘
                                  │
            ┌──────────────┬───────┼───────────────┬───────────────────┐
            ▼              ▼       ▼               ▼                   ▼
   ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  ┌────────────────┐  ┌────────────┐
   │ AuthStorage │  │  ModelReg.  │  │ SettingsManager │  │ SessionManager │  │    ...     │
   │ + AuthGuidance │ │             │  │                 │  │                │  │            │
   └─────────────┘  └─────────────┘  └─────────────────┘  └────────────────┘  └────────────┘
                                       │           ▲             ▲
                                       │           │             │
                                       ▼           │             │
                          ┌──────────────────────────┐           │
                          │ ProjectTrustStore ── setProjectTrusted │
                          │  (trust-manager.ts)      │   (via SettingsManager)
                          └──────────────────────────┘
                                       │
                                       ▼ 信任/拒绝流入 SettingsManager.projectTrusted
                          ┌──────────────────────────┐
                          │  DefaultPackageManager   │
                          │  (package-manager.ts)    │
                          └──────────────────────────┘
                                       │
                                       ▼ resolve() → ResolvedPaths
                          ┌──────────────────────────┐
                          │   DefaultResourceLoader  │
                          │ (发现 + 把 paths 灌进自身缓存) │
                          └──────────────────────────┘
                                       │
                                       ▼ ExtensionRunner
                                   (ExtensionAPI)


   tools-manager ──── 与其他 4 个 manager 完全解耦 ────→  ❙
   (由 interactive-mode / core/tools/{grep,find}.ts 直接调用)
```

读法:

- **`SettingsManager` 是中枢**:所有 manager 都从它读 settings;`TrustStore` 通过 `SettingsManager.setProjectTrusted` 注入信任状态;`DefaultPackageManager` 直接读它。
- **`SessionManager` 是账本**:与上面四个 manager 解耦。它只关心"append 一行 entries",不读 settings、不查 trust、不扫包目录。
- **`ProjectTrustStore` 是"前置闸门"**:它决定了 `SettingsManager.projectTrusted`、`DefaultPackageManager::assertProjectTrustedForScope`、`ResourceLoader.reload(...)` 中是否扫项目侧资源。
- **`DefaultPackageManager` 是"装配工"**:消费 `SettingsManager` 决定要装什么包,消费 `TrustStore` 决定能否写项目侧 npm/git,把结果(`ResolvedPaths`)喂给 `DefaultResourceLoader`。
- **`tools-manager` 是"工具人"**:与其他 manager 无关,只关心二进制依赖,被 mode / 工具直接消费。

---

## 7. 差异与共性

### 7.1 共同点

1. **所有 manager 都对外暴露"读 + 改"的两类 API**(SessionManager 主要是读 + append;SettingsManager 读写都很丰富;TrustStore 读 truthy + setMany;PackageManager 异步 resolve/install;tools-manager 异步 ensureTool)。
2. **所有 manager 都走"路径归一化"**:`resolvePath / canonicalizePath / normalizePath`(`utils/paths.ts`)给所有 `cwd` 比较提供一致语义。
3. **所有需要并发的 manager 都用 `proper-lockfile`**:`FileSettingsStorage.withLock` 锁 settings.json;`withTrustFileLock` 锁整个 trust 目录而不是单个文件(避免 rename 竞态)。
4. **所有 manager 都"懒加载"构造**:`createAgentSession` 链路里任何一个出错都不会让已经构造好的 manager 提前暴露,尽量到第一次访问才落盘(典型例子:`SessionManager._persist` 延迟写文件到第一次有 assistant 消息)。
5. **所有 manager 的失败都被吞或上抛,从不向后兼容 workaround 旧数据形状**:`SettingsManager.migrateSettings`、`SessionManager.migrateToCurrentVersion` 是显式迁移而非 silent fallback。

### 7.2 差异

| 维度 | SessionManager | SettingsManager | ProjectTrustStore | DefaultPackageManager | tools-manager |
| --- | --- | --- | --- | --- | --- |
| 持久化形态 | append-only JSONL | JSON 文件 (global + project) | 全局 JSON 字典 | 文件系统目录树 (npm/git/extensions) + 配置文件间接 | 二进制 tar.gz/zip |
| 写并发模型 | 同步 `appendFileSync`,允许 caller 并行(由调用方单跑一次) | `writeQueue` 串行化 + `proper-lockfile` 文件锁 | `proper-lockfile` 同步锁目录 | 串行化的 install/update 队列 + npm/git 进程锁 | 单下载流(临时目录防并发) |
| 主要消费者 | AgentSession(action emit 落盘) | 全栈(createAgentSession、AgentSession、ExtensionRunner、DefaultPackageManager) | project-trust.ts + SettingsManager + DefaultPackageManager | ResourceLoader + package CLI | interactive-mode + grep/find tool |
| 是否需要 ProjectTrust | 否(只信任 cwd) | 是(写 project settings 需要) | (自身就是信任权威) | 是(写 `<cwd>/.pi/npm` 需要) | 否(只用 `~/.pi/agent/bin/`) |
| 是否启动网络 I/O | 否 | 否 | 否 | 是(npm install / git clone / GitHub release) | 是(GitHub releases) |
| Schema 演进 | v1→v2→v3 (`migrateSessionEntries`) | 单版本 + `migrateSettings` 字段级 | 单版本 + 数据形态(无版本号) | n/a | n/a |

### 7.3 协同示例:启动一次 `pi` 的数据流

1. `createAgentSession({ cwd, agentDir, options })` 构造 `SettingsManager.create(cwd, agentDir)` —— 同步读 global + project settings.json,合并,得到 `Settings`。
2. 它检查 `Settings.defaultProjectTrust` / `defaultModel` 等字段,**这一步里 SettingsManager 不知 project 是否被信任**。
3. 构造 `SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))` —— 走 `~/.pi/agent/sessions/<encoded-cwd>/`。
4. 构造 `DefaultPackageManager({ cwd, agentDir, settingsManager })`,此时 `ResourceLoader.reload()` 调它:`packageManager.resolve(...)` 触发 npm/git install,然后回 `ResolvedPaths` 给 `DefaultResourceLoader`。
5. `DefaultResourceLoader._handleProjectTrust(cwd, extensionsResult, projectTrustContext)` 先调 `hasTrustRequiringProjectResources(cwd)` —— 如果没有任何 project-side 资源,直接返回 true。否则构造 `resolveProjectTrusted` 决策:
   - 走 `project_trust` extension event;
   - 否则查 `projectTrustStore.get(cwd)`(必要时向上搜父目录);
   - 否则按 `Settings.defaultProjectTrust` 决策。
6. 一旦定出 `trusted`:`SettingsManager.setProjectTrusted(trusted)` —— SettingsManager 拒绝向未 trust 的项目 settings 写。
7. `DefaultPackageManager.isProjectTrusted()` 也带回这个 boolean,决定 install 到哪里。
8. `createAgentSession` 完成后 `interactive-mode` 启动时 `Promise.all([ensureTool("fd"), ensureTool("rg")])` 拿 fd/rg 路径。

> 注意 5 与 6 之间的细节:`DefaultResourceLoader.reload()` 调用链是 `reload → loadCurrentExtensionSet({...}) → emitBeforeReload → ... → emit session_start → extendResourcesFromExtensions → project-trust 决策 → settingsManager.setProjectTrusted → settingsManager.reload()`。所以 **Trust → SettingsManager → 其他 manager** 在 reload 路径上同步生效。

---

## 8. 实际使用指南

### 8.1 `SessionManager`

- 直接用:`SessionManager.create(cwd)` 创建新会话;`continueRecent(cwd)` 自动续上次的会话;`inMemory()` 跑测试;`forkFrom(sourcePath, targetCwd)` 跨项目 fork。
- 通过 `AgentSession` 间接用:它会在 `message_end` 自动 `appendMessage`,在 `setModel / setThinkingLevel` 时 `appendModelChange / appendThinkingLevelChange`。你通常不需要直接调。
- 想自己控制落盘粒度 / 写自定义 entry:用 `appendCustomEntry(customType, data)`(不进 LLM 上下文)或 `appendCustomMessageEntry(customType, content, display, details)`(进 LLM 上下文)。

### 8.2 `SettingsManager`

- **多数字段的读取已经是"运行时按次读"**:`createAgentSession` 在 `streamFn` 闭包里调 `settingsManager.getProviderRetrySettings()`,所以即使你设了 `setProviderRetrySettings` 之外的 provider 重试,下次 LLM 调用立刻生效。
- **修改后想立刻落盘**:`setter` 内部是异步写,但 `await settingsManager.flush()` 等队列空。多用于"修改 + reload" 流程(如 CLI 改 keybindings 后想确认)。
- **错误诊断**:`drainErrors()` 把累积的 `{ scope, error }` 全部取出。这是 `main.ts` 启动时把"上次 settings.json 解析失败"这种错误上抛的关键路径。
- **测试场景**:`SettingsManager.inMemory({ defaultProvider: "anthropic", ... })`,**完全脱离文件系统**,`fromStorage` 也接受自定义 `InMemorySettingsStorage`。
- **重置项目侧 settings**:`setProjectTrusted(false)`,所有 `projectSettings` 清空;再 `setProjectTrusted(true)` 重新从磁盘读。

### 8.3 `ProjectTrustStore`

- **典型用法**:`resolveProjectTrusted({ cwd, trustStore, projectTrustContext, ... })` 已经把"event → UI select → trustStore.setMany"全包了,通常直接调它。
- **想自己查 / 改:**`store.get(cwd)` / `store.set(cwd, true|false|null)`,别忘了 null 表示"清掉记录"(祖先目录的 trust 才能生效)。
- **完全离线跳过提示**:`hasTrustRequiringProjectResources(cwd)` 返回 false 时 `resolveProjectTrusted` 直接 true,无需 UI。这是没设 `.pi/`、没设 `.agents/skills` 的项目行为。

### 8.4 `DefaultPackageManager`

- **添加扩展并持久化**:`installAndPersist("npm:@you/foo", { local: true })`,会自动 `install` + `addSourceToSettings`,scope = "project"。
- **批量更新:**`update()`(无参)所有 package + `update("source")`(单包)。`PI_OFFLINE=1` 时直接跳过。
- **CLI 调用 entry point:**`packages/coding-agent/src/package-manager-cli.ts` 是命令行入口;`listConfiguredPackages()` 返回 `ConfiguredPackage[]` 给 UI 列举已安装包。
- **临时扩展 (不写盘):**`resolveExtensionSources(["git:github.com/me/my-ext"], { temporary: true })`,自动写到 `~/.pi/agent/tmp/extensions/git-<host>/<sha8>/<path>`,每次 resolve 时 `refreshTemporaryGitSource`。
- **被 `.gitignore` 屏蔽:**所有 install 根目录都先 `markPathIgnoredByCloudSync` + `ensureGitIgnore`,防止云盘同步误删。

### 8.5 `tools-manager`

- **启动 mode 时:**`Promise.all([ensureTool("fd"), ensureTool("rg")])`,放后台异步进行。
- **工具内部 lazy:**`grep.ts` 在 LLM 第一次调用 `rg` 时才 `ensureTool("rg", true)`,并 silent 模式不打扰用户。
- **手动查:**`getToolPath("rg")` 同步返回值:本地路径 / 系统名 / `null`。
- **Android / Termux:**不下载,提示用户用 `pkg install ripgrep / fd`。
- **离线模式:**`PI_OFFLINE=1` 时不下载,只提示"找不到,跳过"。

---

## 9. 与其他文档的关系

- 五个 manager 中,`SessionManager` 是 `AgentSession` 的核心依赖,见 `Agent与AgentSession类型全景.md` §2。
- `createAgentSession` 对五个 manager 的协同用法(`extensionRunnerRef` 设计、模型/思考级别/会话恢复),见 `createAgentSession执行过程.md` §1-§6。
- `ProjectTrustStore ↔ SettingsManager.projectTrusted ↔ DefaultPackageManager` 三者构成的"信任闸门",见 `createAgentSession执行过程.md` §1(以及 `pi扩展系统与外部插件接口.md` §3.2.3 提到的 pre-vs-post `bindCore` 概念)。
- 扩展的"发现 + 加载 + 解析",即 `DefaultPackageManager.resolve()` → `DefaultResourceLoader` 的串联,在 `pi扩展系统与外部插件接口.md` §3.2-§3.4 已经覆盖,可以互相对照。

---

## 10. 一句话总结

> **五个 manager 各管一摊数据:`SessionManager` 管"会发生什么"的 append-only 流;`SettingsManager` 管"想要什么样的配置";`ProjectTrustStore` 管"这个项目能不能信";`DefaultPackageManager` 管"有什么扩展 / 技能 / 主题需要装";`tools-manager` 管"`fd` 和 `rg` 哪来的"。它们之间通过 `SettingsManager.projectTrusted` 与 `ResourceLoader.reload()` 这两条总线耦合,而 `SessionManager` 和 `tools-manager` 与其他四个解耦,分别独立支撑会话持久化和工具二进制下载。**

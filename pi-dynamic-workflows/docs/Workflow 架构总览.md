# Workflow 架构总览

> pi-dynamic-workflows 是一个 Pi 扩展，把"Claude Code 风格的多代理动态工作流"移植到 Pi 上。
> 它让一个普通 prompt 能够通过一段 JS 编排脚本，扇出几十甚至上百个隔离的子代理来并行完成工作。

本文先讲整体结构和职责分工。运行流程、脚本 API、后台管理、存储布局和内置工作流分别在单独文档中展开。

## 1. 模块一览

源码位于 `src/`，下面按职责把核心模块分组。

### 1.1 入口与扩展装配

| 文件 | 角色 |
| --- | --- |
| `extensions/workflow.ts` | Pi 扩展入口。创建一个共享的 `WorkflowManager`、注册 `workflow` 工具、注册所有 `/...` 斜杠命令、在 `session_start` 时挂接 UI、结果回投和任务面板。 |
| `src/index.ts` | 公共 API 出口。Pi 之外的使用者（或测试）从这里导入。 |

### 1.2 工作流运行时

| 文件 | 角色 |
| --- | --- |
| `src/workflow.ts` | 核心：脚本解析、vm 沙箱执行、调用序列、限额、账本、嵌套。导出 `parseWorkflowScript` 与 `runWorkflow`。 |
| `src/agent.ts` | `WorkflowAgent`：把 `agent(prompt, opts)` 翻译成"创建一个子 Pi 会话 → 调用 → 读 usage → 拆解"的物理动作。处理模型解析、schema 工具注入、工作树 cwd 等。 |
| `src/agent-registry.ts` | 命名子代理（`agentType`）注册表。把 `.pi/agents/*.md`（项目级）和 `~/.pi/agent/agents/*.md`（用户级）解析成 `AgentDefinition`，提供工具白/黑名单的合并函数。 |
| `src/shared-store.ts` | 跨子代理的内存 KV（`store_put` / `store_get`），以及账本增量的提交/重放。 |
| `src/worktree.ts` | 每次 `agent({ isolation: "worktree" })` 创建一个临时 git worktree，让并行编辑互不打架。 |
| `src/structured-output.ts` | schema 模式下往子代理注入的"终止型"工具 `structured_output`，把通过 schema 校验的参数直接当作子代理的返回值。 |
| `src/agent-history.ts` | 把子代理的 messages 压成一个紧凑的历史（用于 TUI 和 `onAgentHistory`）。 |

### 1.3 后台运行 / 持久化

| 文件 | 角色 |
| --- | --- |
| `src/workflow-manager.ts` | `WorkflowManager`：把 `runWorkflow` 包成可暂停/恢复/停止的后台任务。聚合 `EventEmitter` 上的事件供 UI 订阅。 |
| `src/run-persistence.ts` | 把每次 run 序列化成 `~/.pi/workflows/projects/<key>/runs/<id>.json`（含账本、agents、logs），用 tmp+rename 做原子写，提供跨进程文件锁。 |
| `src/logger.ts` | 给单个 run 用的轻量 logger，可选择写到 `runs/<id>.log`。 |
| `src/workflow-paths.ts` | 用户级工作流目录布局、cwd→项目键的哈希。 |

### 1.4 模型与路由

| 文件 | 角色 |
| --- | --- |
| `src/model-tier-config.ts` | `~/.pi/workflows/model-tiers.json` 的读写、按能力分桶（mini/flash/haiku → small，opus/pro/ultra/large/plus → big）并生成默认配置。 |
| `src/model-routing.ts` | `meta.phases[].model` + `meta.model` 的相位路由解析（精确匹配 + 可选 regex）。 |
| `src/model-spec.ts` | Pi CLI 风格的 `provider/modelId[:thinking]` 解析与规范化。 |

### 1.5 错误 / 状态码

| 文件 | 角色 |
| --- | --- |
| `src/errors.ts` | `WorkflowError`、`WorkflowErrorCode`、提供商用量/配额识别、错误包装。 |
| `src/config.ts` | 全局上限常量（`MAX_AGENTS_PER_RUN=1000`、`MAX_CONCURRENCY=16`、`MAX_AGENT_RETRIES=3` 等）和目录名。 |

### 1.6 用户界面 / 命令

| 文件 | 角色 |
| --- | --- |
| `src/workflow-tool.ts` | 暴露给 Pi 的 `workflow` 工具；把 tool call 转成一次 `runWorkflow`（默认后台执行）。 |
| `src/workflow-commands.ts` | `/workflows` 命令的 list/status/watch/stop/pause/resume/rm/save 等子命令。 |
| `src/builtin-commands.ts` | `/deep-research`、`/adversarial-review`、`/code-review`、`/multi-perspective`、`/codebase-audit` 的注册。 |
| `src/saved-commands.ts` | 把已保存的工作流注册为 `/<name>` 命令，参数解析 `key=value` 与位置参数。 |
| `src/workflows-models-command.ts` | `/workflows-models` —— 编辑 `model-tiers.json` 的 TUI 命令。 |
| `src/effort-command.ts` | `/effort` 与 `/ultracode` —— 站立式自动开启工作流模式。 |
| `src/workflow-editor.ts` | 编辑器高亮 + 退格取消的交互细节。 |
| `src/workflow-ui.ts` | `/workflows` 的 TUI 导航器（drill into phase/agent/detail）。 |
| `src/task-panel.ts` | 输入框下方的"工作流运行中"实时面板。 |
| `src/display.ts` | `WorkflowSnapshot` 类型 + 文本/行渲染。 |
| `src/workflow-saved.ts` | 已保存工作流的 CRUD。 |
| `src/workflow-settings.ts` | `~/.pi/workflows/settings.json` 的读取、合并与项目级覆盖。 |
| `src/web-tools.ts` | 给 `/deep-research` 注入的 `web_search` / `web_fetch` 工具。 |
| `src/adversarial-review.ts`、`src/code-review.ts`、`src/deep-research.ts` | 内置工作流的脚本生成器。 |

## 2. 数据流（高层视角）

下图展示一条从用户发出 `Run a workflow to audit ...` 到结果回到聊天里的完整链路。

```
┌──────────────────────────────────────────────────────────────┐
│  Pi 聊天界面                                                  │
│  - 用户消息 / "workflow" 触发 / /workflows 工具调用           │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
            ┌────────────────────────────────────┐
            │  extensions/workflow.ts             │
            │  构造 WorkflowManager、storage、   │
            │  workflow 工具、命令、TUI          │
            └─────────────┬──────────────────────┘
                          │
                          ▼
        ┌───────────────────────────────────────┐
        │  workflow tool / /workflows run /    │
        │  /<name> / /deep-research / ...      │
        └─────────────┬─────────────────────────┘
                      │  parseWorkflowScript
                      │  (acorn AST + meta 校验)
                      ▼
        ┌───────────────────────────────────────┐
        │  WorkflowManager.startInBackground   │
        │   - 生成 runId                        │
        │   - 申请跨进程文件锁 (acquireRunLease)│
        │   - 立刻 persistRun()                │
        └─────────────┬─────────────────────────┘
                      │  executeRun → runWorkflow
                      ▼
        ┌───────────────────────────────────────┐
        │  runWorkflow (vm 沙箱)               │
        │   - 装载 DETERMINISM_PRELUDE         │
        │   - 注入 agent/parallel/pipeline/    │
        │     verify/judgePanel/...            │
        │   - 执行用户脚本                      │
        └─────────────┬─────────────────────────┘
                      │  agent() / parallel() / pipeline()
                      ▼
        ┌───────────────────────────────────────┐
        │  WorkflowAgent.run (per subagent)     │
        │   - 解析 tier/model/agentType        │
        │   - 可选 git worktree                │
        │   - createAgentSession(prompt)       │
        │   - 收 usage / history / model        │
        └─────────────┬─────────────────────────┘
                      │  onAgentStart / onAgentEnd / onAgentJournal
                      ▼
        ┌───────────────────────────────────────┐
        │  WorkflowManager (event emitter)      │
        │   - 更新 snapshot (agents/running/   │
        │     done/error/tokenUsage)           │
        │   - 持久化到 .json (atomic write)     │
        └─────────────┬─────────────────────────┘
                      │  /workflows TUI + 任务面板订阅
                      ▼
        ┌───────────────────────────────────────┐
        │  installResultDelivery               │
        │  (run 完成后把结果回投到聊天)          │
        └───────────────────────────────────────┘
```

## 3. 关键设计抉择

- **vm 沙箱而非子进程**：脚本里能用的所有 API（`agent/parallel/pipeline/verify/...`）都是通过 `vm.createContext` 注入的全局对象，宿主对象（`Date`、`Math`）被换成本域内的"会抛错的占位"，避免 `Math.random()`/`Date.now()` 之类的非确定性用法破坏账本回放。
- **确定性账本**：`callSeq` 在词法调用时单调递增；每次 `agent()` 把 `(prompt, model, phase, agentType, schema, agentDefKey)` 哈希成 `callHash`。Resume 时只对"未变动前缀"做缓存命中，一旦遇到哈希不匹配（即用户改了 prompt 或改了 `model-tiers.json`）就把这一调用和后续所有调用重新跑。
- **共享预算/限流器**：嵌套 `workflow('saved', args)` 沿用父级的 `limiter`（16 并发）、`agentCount`（1000 上限）、`tokenUsage`、`depth=1`，保证嵌套不会绕过全局约束。
- **真实账本而非估算**：每次子代理完成后从 SDK 会话里读 `session.getSessionStats()`，把 `input/output/cacheRead/cacheWrite/cost` 计入共享 `tokenUsage`，被 budget 门禁和回投时使用。
- **后台为默认**：`workflow` 工具的 `background` 默认 `true`，工具调用立刻返回 runId，主对话不必阻塞。`background: false` 用于"在同一条消息里需要结果"的同步场景（前台执行，但仍走 `WorkflowManager.runSync` 保留 TUI 订阅）。
- **可恢复而非纯实时**：每个 run 立刻写盘为 `runs/<id>.json`，每完成一个 agent 就再写一次（覆盖式）。`resume(runId)` 读取脚本 + 账本 + 状态，构造新的 `ManagedRun`，以"未变动前缀"模式继续跑。
- **跨进程锁**：`run-persistence.ts` 用 `<id>.lock` JSON 文件 + `pid` 探测防止两个 Pi 进程同时操作同一个 run；启动时 `recoverStaleRuns` 把孤立的 `running` run 改成 `paused` 留给用户手动 resume。

## 4. 角色分工对照

| 角色 | 谁负责 | 关键输入 / 输出 |
| --- | --- | --- |
| 调度者（dispatcher） | `runWorkflow` 内的 `agent`/`parallel`/`pipeline` | 词法 callSeq、callHash、共享 store、限流器 |
| 执行者（executor） | `WorkflowAgent.run` | 真实的 Pi 子代理会话 |
| 状态聚合（aggregator） | `WorkflowManager` | `ManagedRun.snapshot`，emit 事件给 UI |
| 持久化（persistence） | `run-persistence.ts` | 原子写 `runs/<id>.json`、`.bak` 备份、`.lock` |
| 渲染（renderer） | `display.ts`、`workflow-ui.ts`、`task-panel.ts` | TUI 行、面板、文本报告 |
| 触发（trigger） | `workflow-editor.ts` + `effort-command.ts` | 用户输入的 "workflow" 关键字、effort 站立开关 |

## 5. 一次典型的"长循环"运行

1. 用户写 `audit every route under src/routes/ for missing auth checks` 并在末尾加 "workflow"。
2. 编辑器高亮 → 提交时 prompt 被改写为"调用 workflow 工具"。
3. LLM 生成一段带 `phase('Scan')`/`phase('Review')`/`phase('Verify')` 的脚本，调 `workflow` 工具。
4. 工具按 `background: true`（默认）把脚本交给 `WorkflowManager.startInBackground`，立刻返回 runId。
5. 主线程 `executeRun`：
   - 解析 + 校验 meta。
   - 注入 `vm` 沙箱 + 确定性 prelude。
   - 顺序执行脚本；每次 `agent()` 走 `limiter` 池。
6. `WorkflowAgent` 为每个子代理建会话（必要时 worktree），收 usage/历史，写入 store delta。
7. 进度通过 `EventEmitter` 推到任务面板和 `/workflows` TUI。
8. 完成后 `installResultDelivery` 把结果回投到聊天，run 写入最终状态、释放文件锁。

如果中间按 Esc / 关闭 Pi，重启时 `recoverStaleRuns` 把"running"改回"paused"，用户用 `/workflows resume <id>` 续跑 —— 只跑那些改过或没跑过的调用。

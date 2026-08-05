# pi-dynamic-workflows 源码文档

本目录是 `pi-dynamic-workflows` 扩展的源码级文档，从代码出发讲解整套系统的功能与运行流程。

> 项目根的 `README.md` 是面向用户的安装与使用指南；本目录下的文档面向阅读源码 / 二次开发 / 调试问题的开发者。

## 1. 文档索引

| 文档 | 主题 |
| --- | --- |
| [architecture.md](./architecture.md) | 模块划分、依赖关系、关键设计抉择、一次典型 run 的端到端数据流 |
| [runtime-flow.md](./runtime-flow.md) | `runWorkflow` 的内部状态机：脚本解析、vm 沙箱、确定性 prelude、`agent()` 生命周期、并行/嵌套/质量模式 |
| [background-management.md](./background-management.md) | `WorkflowManager` 与 `RunPersistence`：run 生命周期、pause/stop/resume、跨进程文件锁、孤儿恢复、原子写 |
| [script-api.md](./script-api.md) | 工作流脚本里所有可用全局与选项：`agent / parallel / pipeline / phase / checkpoint / verify / judgePanel / loopUntilDry / completenessCheck / retry / gate / workflow / store_*` |
| [storage.md](./storage.md) | `~/.pi/workflows/` 目录布局、`settings.json` / `model-tiers.json`、run 持久化、跨进程锁、agentType 注册表、saved workflow、迁移 |
| [bundled-workflows.md](./bundled-workflows.md) | 5 个内置斜杠命令：`/deep-research` `/adversarial-review` `/multi-perspective` `/code-review` `/codebase-audit` |

## 2. 快速上手：源码阅读路径

如果你只想大致了解整套系统，按这个顺序读：

1. [architecture.md](./architecture.md) §1（模块一览）— 看代码长什么样
2. [architecture.md](./architecture.md) §2（数据流图）— 看一个 prompt 是怎么变成结果的
3. [runtime-flow.md](./runtime-flow.md) §1, §4, §5 — 看 `runWorkflow` 入口与 `agent/parallel` 的关键逻辑
4. [background-management.md](./background-management.md) §1, §4, §5 — 看 manager 与 run 生命周期

如果是为了做某个具体改动：

| 目标 | 起点 |
| --- | --- |
| 改 `agent()` 的行为 | `src/workflow.ts` `runWorkflow` 中 `agent` 闭包 + `src/agent.ts` `WorkflowAgent.run` |
| 改并行调度 | `src/workflow.ts` 的 `createLimiter` + `parallel/pipeline` 闭包 |
| 改 schema 校验/重试 | `src/agent.ts` `resolveStructuredOutput` + `src/structured-output.ts` |
| 改 run 持久化布局 | `src/workflow-paths.ts` + `src/run-persistence.ts` |
| 改 UI（TUI / 任务面板） | `src/display.ts` + `src/workflow-ui.ts` + `src/task-panel.ts` |
| 改 `/workflows` 命令 | `src/workflow-commands.ts` + `src/saved-commands.ts` |
| 改内置工作流 | `src/builtin-commands.ts` + `src/{deep-research,code-review,adversarial-review}.ts` |
| 改 settings / tier | `src/workflow-settings.ts` + `src/model-tier-config.ts` |
| 改工作流编辑器高亮 / 触发 | `src/workflow-editor.ts` + `src/effort-command.ts` |

## 3. 核心抽象一张表

| 抽象 | 定义 | 实例 | 关键文件 |
| --- | --- | --- | --- |
| 工作流脚本 | 顶层 `export const meta = {...}` + JS | 用户写的字符串 | `src/workflow.ts` |
| 一次运行 | `ManagedRun` | `auth_audit-lpx7` | `src/workflow-manager.ts` |
| 一个 agent | 真实 Pi 子代理会话 | `createAgentSession(...)` | `src/agent.ts` |
| 账本条目 | `JournalEntry` | `{ index, hash, result, storeDelta? }` | `src/workflow.ts` |
| 命名子代理 | `AgentDefinition` | `security-auditor` | `src/agent-registry.ts` |
| 工作树 | `Worktree` | `<repoRoot>/.pi/worktrees/<id>` | `src/worktree.ts` |
| 共享存储 | `SharedStore` | run-level `Map<string, unknown>` | `src/shared-store.ts` |
| 错误 | `WorkflowError` + `WorkflowErrorCode` | `TOKEN_BUDGET_EXHAUSTED` 等 | `src/errors.ts` |
| 持久化 | `PersistedRunState` | `<runsDir>/<id>.json` | `src/run-persistence.ts` |
| 已保存工作流 | `SavedWorkflow` | `<savedDir>/<name>.json` | `src/workflow-saved.ts` |

## 4. 关键不变量

阅读代码时记住这几条不变量，会让很多地方立刻清晰：

- **词法 callSeq 决定 resume 顺序**：`callSeq` 在 `agent()` 入口同步 `++`，在限流前就锁定——并行 `parallel()` 的 fan-out 也能拿到稳定的索引。
- **`callHash` 决定 cache 命中**：`sha256(prompt, model, tier, phase, agentType, agentDefKey, schema)`，任何一项改了就 cache miss。
- **firstMiss 是单调不递减的**：一旦遇到 miss，从该 callIndex 起的所有调用全部走 live run。
- **SharedRuntime 跨嵌套共享**：嵌套 `workflow('name', args)` 不会复制 16 并发限流器 / 1000 agent 上限 / token 预算。
- **背景 run 永不挂起**：headless 模式下 `checkpoint()` 取默认值，绝不让后台任务等人类。
- **写盘用 tmp+rename**：`<id>.json` 是原子写，`<id>.json.bak` 是上一份成功写盘的兜底。
- **deterministic prelude 是 best-effort**：vm 沙箱本身不是安全边界，只是用来拦截"误用 `Date.now()`"这类意外——trusted script（用户或 LLM 生成的）才在这个沙箱里跑。

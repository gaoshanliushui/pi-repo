# pi-subagents 概览

> Pi 编程助手的子代理（subagent）扩展。把工作下放给专注的子 Pi 会话：scout、planner、worker、reviewer、oracle 等。

- 仓库：`F:\Project\agent\general\pi-subagents`
- 包名：`pi-subagents`（`pi-package`）
- 版本：`0.34.0`（见 `package.json:3`）
- 作者/许可：Nico Bailon / MIT
- 主入口：`src/extension/index.ts`（`registerSubagentExtension`）
- 安装脚本：`install.mjs`（同时也是 `pi-subagents` 的 npm bin）

## 它解决了什么问题

Pi 是一个交互式编程助手。但在很多场景下，单一上下文很难同时承担：

- 浏览陌生代码、阅读大量文件
- 做计划、生成文档
- 实际改动、跑测试
- 多视角评审、并行调研
- 让工作跑在后台、等待结果、再继续

`pi-subagents` 让 Pi 可以把这些工作下放给"专注的子 Pi"——每个子代理拥有自己的 system prompt、工具集、技能、模型、可选工作目录、可选 worktree，以及独立的会话文件。父会话保持轻量，子代理完成后再把结构化结果交回来。

## 主要能力

| 能力 | 说明 |
|------|------|
| **三种执行模式** | `single`（单个 agent + 任务）、`parallel`（并发任务数组）、`chain`（顺序步骤，每步用 `{previous}` 接住上一步） |
| **同步 / 异步** | 同步（前台）流式输出；`async: true` 后台跑，子代理完成时通过事件总线发回通知 |
| **动态 fan-out** | chain 里支持 `{expand, parallel, collect}`：从前一步的结构化输出里抽出数组，扩展成 N 个并行任务，再聚合成有序结果 |
| **链式模板变量** | 任务字符串里可用 `{task}`、`{previous}`、`{chain_dir}`、`{outputs.name}` |
| **Worktree 隔离** | 并行任务可以为每个子任务创建独立的 git worktree，避免互相覆盖 |
| **结构化输出** | 每个任务可声明 JSON Schema，输出按 Schema 校验后落到 `structuredOutputPath`，并作为 `{outputs.<name>}` 喂给后续步骤 |
| **验收（acceptance）** | `auto` / `attested` / `checked` / `verified` / `reviewed` 多种等级；`verified` 会跑配置的 shell 命令做硬校验 |
| **Watchdog（看门狗）** | 可选的对抗性复审：当 main 会话或子代理改了仓库代码时，在 `agent_end` 边界用一个强互补模型做一次改动复审，并附带 LSP 诊断 |
| **Intercom 桥** | fork 上下文的子代理可以使用 `intercom` / `contact_supervisor` 工具回呼父会话 |
| **控制通道** | 子代理可以发出 `active_long_running` / `needs_attention` 事件，父会话会以控制通知呈现，并能 resume / steer / interrupt |
| **工具 / turn 预算** | `toolBudget`（soft/hard/block）、`turnBudget`（maxTurns/graceTurns）防止子代理失控 |
| **会话持久化** | 子代理独立保存 JSONL 会话、Markdown transcript、events.jsonl，结果落到磁盘便于事后回放 |
| **多源 agent 发现** | builtin / package / user / project 四种来源，按优先级合并 |

## 仓库结构

```
pi-subagents/
├── package.json            # pi-package 元数据 + bin: pi-subagents
├── install.mjs             # 克隆/更新 ~/.pi/agent/extensions/subagent
├── README.md               # 用户向安装与使用说明
├── CHANGELOG.md
├── agents/                 # 内置 agent 提示词（scout/planner/worker/...）
├── prompts/                # 链式编排用的 prompt 模板
├── skills/                 # 安装时注册的技能
├── src/
│   ├── extension/          # Pi 扩展入口、配置、RPC、control notices
│   │   ├── index.ts        # 主注册函数 registerSubagentExtension
│   │   ├── config.ts       # 读写 ~/.pi/agent/extensions/subagent/config.json
│   │   ├── schemas.ts      # TypeBox 工具参数 schema
│   │   ├── tool-description.ts  # 工具描述（full/compact/custom）
│   │   ├── rpc.ts          # 子代理跨进程 RPC 桥
│   │   ├── control-notices.ts   # 控制通知渲染
│   │   ├── doctor.ts       # 子代理 doctor 报告
│   │   └── fanout-child.ts # 显式声明的 fanout 子扩展入口
│   ├── agents/             # agent / chain / skill 发现与序列化
│   ├── runs/
│   │   ├── foreground/     # 同步路径：subagent-executor、execution、chain-execution、chain-clarify
│   │   ├── background/     # 异步路径：subagent-runner、async-execution、async-job-tracker、result-watcher、wait、scheduled-runs、control-channel、stale-run-reconciler...
│   │   └── shared/         # 工作树、worktree、acceptance、nested-events、turn/tool-budget、pi-args、model-fallback、chain-outputs...
│   ├── slash/              # /run / /scout 等斜杠命令 + prompt 模板桥
│   ├── watchdog/           # 主 watchdog 运行时、子 watchdog 注册、review、settings
│   ├── intercom/           # 跨上下文协调桥（contact_supervisor / intercom）
│   ├── tui/                # 子代理结果在 Pi 中的渲染
│   ├── profiles/           # 子代理 profile 持久化（模型选择 profile）
│   └── shared/             # 共享类型、工具、配置、常量、artifacts、status-format
└── test/                   # unit / integration / e2e 测试
```

## 安装

```bash
pi install npm:pi-subagents
```

`install.mjs` 的逻辑（见 `install.mjs:16-85`）：

1. 计算目标目录 `~/.pi/agent/extensions/subagent`
2. 已存在且是 git 仓库 → `git pull` 更新
3. 否则 `git clone https://github.com/nicobailon/pi-subagents.git`
4. 移除：`pi-subagents --remove`

安装后 Pi 会自动加载 `src/extension/index.ts`，并把内置 agents / skills / prompts 注册进 `~/.pi/agent/`。

> 注意：项目里有一个 `doxs/` 空目录，是历史残留。新文档统一写到 `docs/` 下。

## 快速上手

安装后直接用自然语言驱动 Pi：

```text
Use reviewer to review this diff.
Ask oracle for a second opinion on my current plan.
Use scout to understand this code based on our discussion.
Run parallel reviewers: one for correctness, one for tests, one for unnecessary complexity.
```

Pi 会判断是否需要调用 `subagent` 工具、用哪个 agent、用 chain 还是 parallel。

如果想明确用同步/异步、worktree、超时等参数，使用 `/run` 斜杠命令或直接调用 `subagent` 工具：

```text
/run reviewer[model=anthropic/claude-sonnet-4:high] "Review this diff" --bg
```

`--bg` 让它走异步路径（等价于 `async: true`），`--fork` 让子代理 fork 当前会话的上下文（`context: "fork"`）。

## 内置 agent 一览

来自 `agents/*.md` 与 `src/agents/agents.ts:35-44` 的 `BUILTIN_AGENT_NAMES`：

| Agent | 用途 |
|-------|------|
| `scout` | 本地代码侦察：定位文件、入口、数据流、风险点 |
| `researcher` | 联网/文档调研，给出有出处的简报 |
| `planner` | 在已有上下文基础上产出可执行计划，不改代码 |
| `worker` | 实施改动，跑验证，对未授权决策上抛而非猜测 |
| `reviewer` | 对照任务/计划/测试做代码评审与小修补 |
| `context-builder` | 强力的前置上下文构建：写出 `context.md`、`meta-prompt.md` |
| `oracle` | 行动前的二次审视：挑战假设、提示漂移、推荐下一步 |
| `delegate` | 轻量级通用代理，行为接近父会话 |

## 三大运行模式

### SINGLE（单 agent）

```json
{ "agent": "reviewer", "task": "Review this diff for correctness and tests" }
```

省略 `task` 时表示这个 agent 是 self-contained 的（比如 `scout` 靠上下文自己决定做什么）。

### PARALLEL（并发任务）

```json
{
  "tasks": [
    { "agent": "reviewer", "task": "Review for correctness", "as": "correctness" },
    { "agent": "reviewer", "task": "Review tests", "as": "tests" },
    { "agent": "reviewer", "task": "Review complexity", "as": "complexity" }
  ],
  "concurrency": 4,
  "worktree": true
}
```

`worktree: true` 时每个任务在独立 git worktree 中跑，避免互相覆盖。

`count` 字段把同一个任务重复 N 次（每次生成独立 run id）：

```json
{ "agent": "scout", "task": "Find usages of {item}", "count": 5 }
```

### CHAIN（顺序步骤）

```json
{
  "chain": [
    { "agent": "scout", "task": "Map the auth flow for {task}" },
    { "agent": "planner", "task": "Plan changes based on:\n{previous}" },
    { "agent": "worker", "task": "Implement this plan:\n{previous}", "output": "result.md" }
  ],
  "chainDir": "~/.cache/my-chain"
}
```

链中每个步骤：

- 默认 `{task}` 是原始任务，`{previous}` 是上一步的文本输出
- 可以用 `as: "name"` 把上一步的结构化输出存为 `{outputs.name}`
- `parallel: [...]` 嵌入一个并发段
- `expand` + `collect` 嵌入动态 fan-out

## 同步 vs 异步

```json
{ "agent": "reviewer", "task": "...", "async": false }   // 前台流式返回
{ "agent": "reviewer", "task": "...", "async": true  }   // 后台运行，完成时发通知
```

`async: true` 时：

- 子代理 fork 一个独立进程跑（`spawn(pi ...)`）
- 父会话立刻返回，子代理写到 `~/.pi/agent/sessions/<session>/async/<runId>/`
- 完成时通过事件总线 `subagents:async:complete` 唤醒父 Pi
- 可用 `wait` 工具阻塞到完成（用于脚本/非交互场景）

## 配套文档

- [`architecture.md`](架构与运行流程.md) — 模块划分、运行流程、事件生命周期
- [`tools.md`](工具参考.md) — `subagent` / `wait` 工具参数详解、action 表
- [`configuration.md`](配置参考.md) — 配置项、settings.json、agent frontmatter、watchdog、acceptance、budgets
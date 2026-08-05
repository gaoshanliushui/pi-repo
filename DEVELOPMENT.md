# pi + 扩展联调（Windows / WebStorm）

这个目录下并列放了 pi 主仓库和若干扩展副本，用来对 pi 的核心
（`@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-tui`）
以及扩展做同步开发。

**联调时不会碰全局 `~/.pi/`**：通过环境变量 `PI_CODING_AGENT_DIR` 把 pi 指向
仓库内的 `.pi-agent/`，全局的 pi 安装、扩展、settings 都不受影响。

## 目录结构

```
pi-repo/
├── pi/                 # monorepo，含 packages/{agent,ai,coding-agent,tui,orchestrator}
├── pi-subagents/       # 扩展 A
├── pi-web-access/      # 扩展 B
├── .pi-agent/          # 仓库本地的 pi agent home（settings.json / auth.json / trust.json / extensions/）
├── linkdev.mjs         # 重建 @earendil-works junction 的脚本（对所有扩展幂等运行）
├── pi-dev.bat          # Windows：cmd/PowerShell 一键跑本地 pi CLI
└── pi-dev.sh           # Bash：同上
```

每个扩展目录里 `node_modules/@earendil-works/*` 都是 junction，指向
`pi/packages/{agent,ai,coding-agent,tui,orchestrator}`。这样从扩展代码里
`import '@earendil-works/pi-agent-core'` 直接吃 monorepo 的产物/源码。

## 添加一个新扩展要做的事

假设新扩展叫 `pi-foo`，克隆或解压到 `pi-repo/pi-foo/`：

1. 装扩展自身依赖（不要动 `@earendil-works/*`）：
   ```bash
   cd F:/Project/agent/general/pi-repo/pi-foo
   npm install --ignore-scripts --no-audit --no-fund
   ```

   如果这个扩展的 `@earendil-works/*` 在 dependencies/devDependencies（而不是
   peerDependencies），先把它们改成 optional peerDependencies——否则 npm 会拉
   npm 上的固定版本，覆盖我们的 junction。可以在本地改后
   `git update-index --skip-worktree package.json` 让 git 忽略。

2. 在 `linkdev.mjs` 顶部的 `EXTENSIONS` 数组里加一行：
   ```js
   const EXTENSIONS = ["pi-subagents", "pi-web-access", "pi-foo"];
   ```

3. 跑一次 link：
   ```bash
   node F:/Project/agent/general/pi-repo/linkdev.mjs
   ```

4. 在 `.pi-agent/settings.json` 的 `packages` 里加本地路径：
   ```json
   "F:/Project/agent/general/pi-repo/pi-foo"
   ```

5. 用 `./pi-dev.sh list` 验证 pi 已经把它作为本地扩展加载。

## 已经做过的一次性配置（pi-subagents / pi-web-access）

- `pi-subagents/package.json`：把 `@earendil-works/*` 从 dependencies/devDependencies
  移到 `peerDependencies`（`*` + optional）。（`pi-web-access` 原本就是 peerDeps，未改。）
- 各扩展 `node_modules/@earendil-works/*` -> Windows junction 指向
  `pi/packages/{agent,ai,coding-agent,tui,orchestrator}`。
- `.pi-agent/settings.json` 里 `packages` 用本地绝对路径注册。
- `.pi-agent/auth.json` 与 `trust.json`：从全局 `~/.pi/agent/` **复制**过来，
  保留登录状态；改动不会回流。你想脱敏时删掉即可。

## 每次跑 pi 都要带 `PI_CODING_AGENT_DIR`

命令行：

```bash
# Windows PowerShell / cmd
pi-dev.bat list
pi-dev.bat                # 进入 TUI

# Git Bash / WSL
./pi-dev.sh list
```

或者手动：

```bash
PI_CODING_AGENT_DIR=F:/Project/agent/general/pi-repo/.pi-agent \
  node pi/packages/coding-agent/dist/cli.js
```

**忘记加这个环境变量**，pi 就会加载你全局的那份扩展列表，看不到本地扩展的改动。

## 什么时候要重跑 `node linkdev.mjs`？

- 在**任一扩展目录**里跑过 `npm install`（会清 junction）
- 换机器 / 换路径
- 切分支后 `@earendil-works/*` 目录消失

命令：

```bash
cd F:/Project/agent/general/pi-repo
node linkdev.mjs
```

会遍历 `EXTENSIONS` 里每一个扩展，重建 junction，末尾对每个扩展 sanity 打印 5 个包的版本。

## 常用工作流

改代码前先 build 一次 pi（peerDep 消费者 import 的是 `dist/`）：

```bash
cd F:/Project/agent/general/pi-repo/pi
npm install --ignore-scripts   # 首次
npm run build                  # tui -> ai -> agent -> coding-agent -> orchestrator
```

日常改 pi 源码时，为了不用每次都 `npm run build`：

```bash
cd F:/Project/agent/general/pi-repo/pi/packages/coding-agent && npx tsgo -p tsconfig.build.json --watch
# 每个包起一个 watch
```

跑 pi CLI，验证扩展被加载：

```bash
./pi-dev.sh list
# 应看到本地绝对路径的扩展列表：
# User packages:
#   F:/Project/agent/general/pi-repo/pi-subagents
#   F:/Project/agent/general/pi-repo/pi-web-access
```

跑扩展自己的测试：

```bash
cd F:/Project/agent/general/pi-repo/pi-subagents  && npm test    # subagents 单测
cd F:/Project/agent/general/pi-repo/pi-web-access && npm test    # web-access 内置 node --test
```

## WebStorm

- 把 `pi-repo/` 直接 Open 为项目；`.idea/pi-repo.iml` 已经把 `pi/`、
  `pi-subagents/`、`pi-web-access/` 都注册为 Content Root，`node_modules/dist`
  被 Excluded。
- 预置的 Run Configuration（`.idea/runConfigurations/`）都已经内建
  `PI_CODING_AGENT_DIR=$PROJECT_DIR$/.pi-agent`：
  - **pi CLI (TS source)**：`--import tsx` 直接跑 `packages/coding-agent/src/cli.ts`
  - **pi CLI (built dist)**：跑 `dist/cli.js`（先 build）
  - **pi build (all workspaces)**：`npm run build`
  - **pi-subagents unit tests**：`npm run test:unit`
  - **pi-web-access tests**：`npm run test`
- TypeScript：Settings → Languages & Frameworks → TypeScript，"Use TypeScript from"
  指向 `pi/node_modules/typescript`。
- Biome：安装 JetBrains Biome 插件，指向 `pi/node_modules/@biomejs/biome`。

## 陷阱

- **不要把扩展加进 pi 的 workspaces**。Node 的模块解析会往
  `pi-repo/node_modules` 找 `@earendil-works/*`（而不是 pi/node_modules），
  永远解析不到。
- **不要 commit** 扩展 `package.json` 里的 peerDep 改动。可以
  `git update-index --skip-worktree <ext>/package.json` 让 git 忽略。
- 在**任一扩展目录**里跑 `npm install` 后**永远**跟一句 `node ../linkdev.mjs`
  重建 junction，否则 import 会失败。
- pi 的 `packages/*` 各自 `package.json` 的 `exports` 是白名单，直接
  `require('@earendil-works/pi-ai/package.json')` 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`
  ——这是**正常**的，用 `import '@earendil-works/pi-ai'` 主入口没问题。
- 想跟全局 pi 同步登录状态？重新把 `~/.pi/agent/auth.json` 复制过来即可。
  想彻底隔离？留 `.pi-agent/auth.json` 自己覆盖或者删掉重登。

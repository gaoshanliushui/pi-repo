# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository rules

Read `AGENTS.md` before changing code. It is the authoritative repository policy; `CONTRIBUTING.md` adds contributor and PR requirements.

Key constraints:

- Keep responses short and technical. Do not use emojis in code, commits, issues, or PR comments.
- Use erasable TypeScript syntax in `packages/*/src`, `packages/*/test`, and `packages/coding-agent/examples`: no enums, namespaces, parameter properties, `import =`, or `export =`. Avoid `any` unless it is genuinely required, and use normal top-level imports rather than inline import types.
- Put editor key handling in `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`, not hard-coded input checks.
- Do not edit `packages/ai/src/models.generated.ts`; change `packages/ai/scripts/generate-models.ts` and regenerate instead.
- Do not remove intentional behavior merely to accommodate an older dependency, and do not preserve backward compatibility unless requested.
- Do not commit unless asked. Stage only files changed for the current task; never use `git add .`, `git add -A`, `git reset --hard`, `git checkout .`, `git clean -fd`, or `git stash` in this shared working tree.

## Prerequisites and installation

- Node.js `>=22.19.0`.
- npm workspaces are defined by the root `package.json`.
- Install dependencies without lifecycle scripts:

```bash
npm install --ignore-scripts
# Clean/CI-equivalent install:
npm ci --ignore-scripts
```

Direct dependencies are exact-pinned (`.npmrc` also enforces `save-exact` and a two-day minimum release age). After dependency changes:

```bash
npm install --package-lock-only --ignore-scripts
node scripts/generate-coding-agent-shrinkwrap.mjs
```

`package-lock.json` changes are guarded by the pre-commit hook; only set `PI_ALLOW_LOCKFILE_CHANGE=1` for an intentional reviewed lockfile update. New dependencies with lifecycle scripts require an explicit shrinkwrap allowlist entry; never add one silently.

## Build, checks, tests, and local execution

Run commands from the repository root unless a command explicitly changes into a package.

```bash
npm run check       # Biome --write, dependency/import checks, generated-lock checks, and tsgo --noEmit
npm run build       # Build all workspaces in dependency order
./test.sh           # Canonical full test run; hides auth.json, clears provider keys, then runs workspace tests
./pi-test.sh        # Run the coding-agent CLI directly from TypeScript source
./pi-test.sh --no-env --help
```

On Windows, `pi-test.bat`/`pi-test.ps1` wrap the source CLI runner.

Command discipline from `AGENTS.md`:

- After non-documentation code changes, run `npm run check` and inspect the full output. It rewrites files through Biome and does not run tests.
- Do not run `npm run build` or raw `npm test` unless the user explicitly requests it. Use `./test.sh` for a full suite so live provider credentials cannot activate e2e tests.
- If a test file is created or changed, run that file. Coding-agent suite tests must use `packages/coding-agent/test/suite/harness.ts` with the faux provider; never spend real API tokens in tests.

Run one Vitest file from its package directory:

```bash
cd packages/agent && node ../../node_modules/vitest/dist/cli.js --run test/agent-loop.test.ts
cd packages/ai && node ../../node_modules/vitest/dist/cli.js --run test/faux-provider.test.ts
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/auth-storage.test.ts
```

Run one named Vitest test by adding `-t`:

```bash
cd packages/agent && node ../../node_modules/vitest/dist/cli.js --run test/agent-loop.test.ts -t "test name"
```

TUI tests use Node's test runner rather than the normal Vitest suite:

```bash
cd packages/tui && node --test --test-reporter=dot test/keybindings.test.ts
```

Agent harness-only tests have a separate configuration:

```bash
cd packages/agent && npm run test:harness
```

Regression tests for coding-agent issues belong in `packages/coding-agent/test/suite/regressions/<issue-number>-<short-slug>.test.ts`.

## Architecture

This is an npm-workspaces monorepo with five lockstep-versioned packages. The dependency direction is:

```text
orchestrator -> coding-agent -> agent -> ai
                         \----> ai
                         \----> tui
```

- `packages/ai` (`@earendil-works/pi-ai`) is the provider-neutral model and streaming layer. Provider factories live in `src/providers/`; wire-protocol implementations live in `src/api/`; auth resolution is in `src/auth/`. The root entry point is intentionally small, while providers, APIs, OAuth, and compatibility exports are exposed through package subpaths. Model catalogs are generated.
- `packages/agent` (`@earendil-works/pi-agent-core`) owns the model/tool loop and event contract. `src/agent.ts` manages lifecycle, steering/follow-up queues, and the single active run; `src/agent-loop.ts` performs turns and tool execution. `src/harness/` adds session context, compaction, and branch summarization.
- `packages/tui` (`@earendil-works/pi-tui`) is a differential terminal renderer and component/keybinding library. `src/tui.ts` defines rendering and input routing; `src/components/` contains reusable terminal widgets.
- `packages/coding-agent` (`@earendil-works/pi-coding-agent`) composes the other packages into the `pi` CLI and public SDK. It owns sessions, built-in tools, extensions, resource discovery, model/auth settings, and the interactive, print/JSON, and RPC modes.
- `packages/orchestrator` (`@earendil-works/pi-orchestrator`) is the experimental Unix-socket supervisor for spawning and controlling multiple coding-agent processes.

### Main runtime flow

1. `packages/coding-agent/src/cli.ts` enters `src/main.ts`, which parses arguments and chooses interactive, print/JSON, or RPC mode.
2. `core/agent-session-runtime.ts`, `core/agent-session-services.ts`, and `core/sdk.ts` construct cwd-scoped auth, model registry, settings, resources, the core `Agent`, and `AgentSession`.
3. `AgentSession` bridges the core agent to persistence, tools, extensions, compaction, and provider streaming. It resolves credentials through `ModelRegistry` and calls the `packages/ai` streaming layer.
4. The core agent converts its messages to LLM context, streams an assistant turn, executes requested tools, emits lifecycle events, and consumes steering/follow-up queues.
5. The selected mode renders those events through `pi-tui`, writes JSONL output, or serves the stdin/stdout RPC protocol.

### Extension, tool, and resource boundaries

- Built-in tool factories are in `packages/coding-agent/src/core/tools/`. File mutations are serialized by `file-mutation-queue.ts`; bash is abstracted so sandbox/container extensions can replace execution.
- Extension loading and hooks are in `core/extensions/loader.ts`, `runner.ts`, and `types.ts`. Hooks can alter provider headers/requests, block or rewrite tool calls/results, and add commands or UI. Node loads TypeScript extensions through `jiti`; the Bun binary uses statically supplied virtual modules.
- `core/resource-loader.ts` discovers extensions, skills, prompt templates, themes, and project context files. Project resources that require trust are gated by `core/trust-manager.ts`.
- Sessions are append-only v3 JSONL managed by `core/session-manager.ts`. Compaction and branch summaries are stored as dedicated entries and folded back into model context by `packages/agent/src/harness/session/session.ts`.
- `packages/coding-agent/src/index.ts`, `packages/agent/src/index.ts`, and each package's `package.json` `exports` map are the canonical public API boundaries. Prefer changing exported surfaces there rather than importing private internals across packages.

Useful starting points are `docs/ARCHITECTURE.md`, `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/core/agent-session.ts`, `packages/agent/src/agent.ts`, and the progressive examples in `packages/coding-agent/examples/sdk/`. Working extension recipes are under `packages/coding-agent/examples/extensions/`.

## Generated and release-managed files

- Never hand-edit `packages/ai/src/models.generated.ts`.
- Regenerate `packages/coding-agent/npm-shrinkwrap.json` with `node scripts/generate-coding-agent-shrinkwrap.mjs`; validate with `--check`.
- Treat `package-lock.json` as reviewed source and use install commands with `--ignore-scripts`.
- Do not edit package `CHANGELOG.md` files unless explicitly asked; maintainers normally add entries. Released sections are immutable, and all packages are versioned together.
- Pi intentionally has no built-in permission sandbox. For work involving execution isolation, consult `packages/coding-agent/docs/containerization.md` and the security boundary in `SECURITY.md`.

#!/usr/bin/env bash


#
# One-click setup for local pi + extensions development.
#
#   1. Checks Node/npm versions.
#   2. Installs pi monorepo deps and builds it.
#   3. Installs each extension's own deps.
#   4. Runs linkdev.mjs to point every extension's @earendil-works/* at pi/packages/*.
#   5. Writes .pi-agent/settings.json registering every extension as a local package.
#   6. Copies ~/.pi/agent/auth.json into .pi-agent/ if present (keeps global login).
#
# Idempotent: safe to re-run. Does not touch the global ~/.pi/ install.
#
set -euo pipefail

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
cd "$DIR"

PI_DIR="$DIR/pi"
AGENT_DIR="$DIR/.pi-agent"
SETTINGS_FILE="$AGENT_DIR/settings.json"
GLOBAL_AUTH="$HOME/.pi/agent/auth.json"

# Extensions that get deps installed and are registered in .pi-agent/settings.json.
EXTENSIONS=(
  "pi-subagents"
  "pi-web-access"
  "pi-mcp-adapter"
  "pi-dynamic-workflows"
)

c_blue=$'\033[1;34m'; c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_reset=$'\033[0m'
step()  { printf "\n%s==> %s%s\n" "$c_blue"   "$1" "$c_reset"; }
ok()    { printf "%s[ok]%s %s\n" "$c_green"  "$c_reset" "$1"; }
warn()  { printf "%s[warn]%s %s\n" "$c_yellow" "$c_reset" "$1"; }
die()   { printf "%s[error]%s %s\n" "$c_red"   "$c_reset" "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Toolchain check
# ---------------------------------------------------------------------------
step "Checking toolchain"

command -v node >/dev/null || die "node not found on PATH (need Node >= 22.19.0)"
command -v npm  >/dev/null || die "npm not found on PATH"

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f1)"
NODE_MINOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  die "Node >= 22.19.0 required, found $NODE_VERSION"
fi
ok "node $NODE_VERSION, npm $(npm -v)"

[ -d "$PI_DIR" ] || die "pi monorepo not found at $PI_DIR"

# ---------------------------------------------------------------------------
# 2. Build pi monorepo
# ---------------------------------------------------------------------------
step "Installing pi monorepo dependencies"
(
  cd "$PI_DIR"
  npm install --ignore-scripts --no-audit --no-fund
)
ok "pi deps installed"

step "Building pi monorepo (tui -> ai -> agent -> coding-agent -> orchestrator)"
# Build each package individually so we can skip pi-ai's network-dependent
# generate-models step when models.dev is unreachable. The generated catalogs
# are committed to git, so tsgo alone is enough for local dev.
PI_PACKAGES=(tui ai agent coding-agent orchestrator)

# Returns 0 if models.dev is reachable within 5s, non-zero otherwise.
models_dev_reachable() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 5 -o /dev/null https://models.dev/api.json
  else
    node -e '
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 5000);
      fetch("https://models.dev/api.json", { signal: c.signal })
        .then(r => process.exit(r.ok ? 0 : 1))
        .catch(() => process.exit(1))
        .finally(() => clearTimeout(t));
    '
  fi
}

for pkg in "${PI_PACKAGES[@]}"; do
  pkg_dir="$PI_DIR/packages/$pkg"
  [ -d "$pkg_dir" ] || die "pi package $pkg not found at $pkg_dir"
  (
    cd "$pkg_dir"
    if [ "$pkg" = "ai" ]; then
      if models_dev_reachable; then
        echo "  models.dev reachable — regenerating catalogs"
        npm run build
      else
        echo "  models.dev unreachable — using committed catalogs (compile only)"
        # image-models.generated.ts: OpenRouter is usually reachable and the
        # generator fails safe; if it fails, compile against the committed file.
        npm run generate-image-models 2>/dev/null || true
        npx tsgo -p tsconfig.build.json
      fi
    else
      npm run build
    fi
  ) || die "build failed for pi package $pkg"
  ok "built pi-$pkg"
done

# ---------------------------------------------------------------------------
# 3. Install extension dependencies
# ---------------------------------------------------------------------------
for ext in "${EXTENSIONS[@]}"; do
  ext_dir="$DIR/$ext"
  if [ ! -d "$ext_dir" ]; then
    warn "skip $ext: directory missing ($ext_dir)"
    continue
  fi
  step "Installing $ext dependencies"
  (
    cd "$ext_dir"
    # --ignore-scripts matches pi's own install discipline; --no-save keeps the
    # @earendil-works/* entries in package.json untouched so linkdev can relink.
    npm install --ignore-scripts --no-audit --no-fund
  )
  ok "$ext deps installed"
done

# ---------------------------------------------------------------------------
# 4. Relink @earendil-works/* junctions/symlinks
# ---------------------------------------------------------------------------
step "Linking @earendil-works/* into each extension's node_modules"
node "$DIR/linkdev.mjs"

# ---------------------------------------------------------------------------
# 5. Write .pi-agent/settings.json with every local extension registered
# ---------------------------------------------------------------------------
step "Writing $SETTINGS_FILE"

mkdir -p "$AGENT_DIR"

# Build the packages array as JSON. Use a temp file and node for safe escaping.
PACKAGES_JSON="$(
  EXTENSIONS="${EXTENSIONS[*]}" DIR="$DIR" node <<'NODE'
    const exts = (process.env.EXTENSIONS || "").split(/\s+/).filter(Boolean);
    const fs = require("node:fs");
    const paths = exts
      .map(e => [e, `${process.env.DIR}/${e}`])
      .filter(([, p]) => fs.existsSync(p))
      .map(([, p]) => p);
    process.stdout.write(JSON.stringify(paths, null, 2));
NODE
)"

# Merge into any existing settings.json, preserving user keys but replacing
# `packages` with the current local-extension list.
SETTINGS_FILE="$SETTINGS_FILE" PACKAGES_JSON="$PACKAGES_JSON" node <<'NODE'
  const fs = require("node:fs");
  const file = process.env.SETTINGS_FILE;
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // missing or invalid — start fresh
  }
  settings.packages = JSON.parse(process.env.PACKAGES_JSON);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
NODE

ok "settings.json packages:"
while IFS= read -r line; do printf "         %s\n" "$line"; done <<<"$PACKAGES_JSON"

# ---------------------------------------------------------------------------
# 6. Copy auth from global install, if present
# ---------------------------------------------------------------------------
if [ -f "$GLOBAL_AUTH" ] && [ ! -f "$AGENT_DIR/auth.json" ]; then
  step "Copying $GLOBAL_AUTH -> $AGENT_DIR/auth.json"
  cp "$GLOBAL_AUTH" "$AGENT_DIR/auth.json"
  ok "login state copied (delete .pi-agent/auth.json to isolate)"
elif [ -f "$AGENT_DIR/auth.json" ]; then
  ok ".pi-agent/auth.json already present, leaving as-is"
else
  warn "no ~/.pi/agent/auth.json found — run ./pi-dev.sh and log in when prompted"
fi

# ---------------------------------------------------------------------------
# 7. Smoke test
# ---------------------------------------------------------------------------
step "Verifying local extensions are registered"
if [ -f "$PI_DIR/packages/coding-agent/dist/cli.js" ]; then
  PI_CODING_AGENT_DIR="$AGENT_DIR" node "$PI_DIR/packages/coding-agent/dist/cli.js" list || true
else
  warn "pi CLI not built, skipping list"
fi

printf "\n%sDone.%s Run %s./pi-dev.sh%s to launch pi against this checkout.\n" \
  "$c_green" "$c_reset" "$c_blue" "$c_reset"

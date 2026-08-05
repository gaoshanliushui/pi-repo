#!/usr/bin/env node
/**
 * Re-links extension packages against the sibling pi monorepo for local dev.
 *
 * Effect:
 *   For every extension listed in EXTENSIONS, creates junctions inside its
 *   node_modules/@earendil-works/ pointing at pi/packages/{agent,ai,coding-agent,tui,orchestrator}.
 *
 * The local Pi runtime is directed at ./.pi-agent/ via the PI_CODING_AGENT_DIR
 * env var (see pi-dev.sh / pi-dev.bat and .idea/runConfigurations/*.xml).
 * No global ~/.pi state is touched.
 *
 * Run again after any `npm install` inside an extension dir (which wipes the
 * @earendil-works junctions).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE; // pi-repo/
const PI = path.join(ROOT, "pi");

// Every extension dir that wants @earendil-works/* pointed at the local monorepo.
const EXTENSIONS = ["pi-subagents", "pi-web-access"];

const PKG_LINKS = {
  "pi-agent-core": path.join(PI, "packages", "agent"),
  "pi-ai": path.join(PI, "packages", "ai"),
  "pi-coding-agent": path.join(PI, "packages", "coding-agent"),
  "pi-tui": path.join(PI, "packages", "tui"),
  "pi-orchestrator": path.join(PI, "packages", "orchestrator"),
};

function link(source, target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(source, target, type);
  console.log(`  ${target}  ->  ${source}`);
}

for (const ext of EXTENSIONS) {
  const extDir = path.join(ROOT, ext);
  if (!fs.existsSync(extDir)) {
    console.warn(`skip extension ${ext}: missing directory ${extDir}`);
    continue;
  }

  console.log(`\nLinking @earendil-works/* into ${ext}/node_modules ...`);
  const scope = path.join(extDir, "node_modules", "@earendil-works");
  for (const [name, source] of Object.entries(PKG_LINKS)) {
    if (!fs.existsSync(source)) {
      console.warn(`  skip ${name}: missing source ${source}`);
      continue;
    }
    link(source, path.join(scope, name));
  }

  console.log(`\n  Sanity check for ${ext}:`);
  for (const name of Object.keys(PKG_LINKS)) {
    const pkgJson = path.join(scope, name, "package.json");
    try {
      const v = JSON.parse(fs.readFileSync(pkgJson, "utf8")).version;
      console.log(`    @earendil-works/${name} -> ${v}`);
    } catch (err) {
      console.warn(`    @earendil-works/${name} probe failed: ${err.message}`);
    }
  }
}

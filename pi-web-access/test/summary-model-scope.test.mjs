import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadEnabledModelPatterns, modelMatchesEnabledPatterns } from "../summary-model-scope.ts";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const summarySrc = readFileSync(new URL("../summary-review.ts", import.meta.url), "utf8");

test("summary model scope matches nested provider model ids and thinking suffixes", () => {
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "nvidia/nemotron-3-super-120b-a12b:free" },
			["openrouter/nvidia/nemotron-3-super-120b-a12b:free"],
		),
		true,
	);
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "anthropic/claude-sonnet-4" },
			["openrouter/*:low"],
		),
		true,
	);
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "ai21/jamba-large-1.7" },
			["openrouter/nvidia/*"],
		),
		false,
	);
});

test("enabledModels loading uses trusted project settings over global settings", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-agent-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-web-access-project-"));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["global/model"] }));
	await mkdir(join(projectDir, ".pi"));
	await writeFile(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["project/model"] }));

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		assert.deepEqual(
			loadEnabledModelPatterns({ cwd: projectDir, isProjectTrusted: () => true }),
			["project/model"],
		);
		assert.deepEqual(
			loadEnabledModelPatterns({ cwd: projectDir, isProjectTrusted: () => false }),
			["global/model"],
		);
	} finally {
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
	}
});

test("summary generation no longer uses catalog fallback or first available model", () => {
	assert.doesNotMatch(summarySrc, /getModel/);
	assert.doesNotMatch(indexSrc, /getModel/);
	assert.match(summarySrc, /ctx\.modelRegistry\.find\(spec\.provider, spec\.id\)/);
	assert.match(indexSrc, /ctx\.modelRegistry\.find\(provider, id\)/);
	assert.match(summarySrc, /modelMatchesEnabledPatterns\(model, enabledModelPatterns\)/);
	assert.doesNotMatch(indexSrc, /defaultSummaryModel = summaryModels\[0\]\.value/);
	assert.match(indexSrc, /modelMatchesEnabledPatterns\(model, enabledModelPatterns\)/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const utilsUrl = new URL("../utils.ts", import.meta.url).href;
const perplexityUrl = new URL("../perplexity.ts", import.meta.url).href;
const geminiApiUrl = new URL("../gemini-api.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	delete childEnv.PERPLEXITY_API_KEY;
	delete childEnv.GEMINI_API_KEY;
	delete childEnv.GOOGLE_GEMINI_BASE_URL;
	delete childEnv.CLOUDFLARE_API_KEY;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete childEnv[key];
		} else {
			childEnv[key] = value;
		}
	}
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
	});
}

test("web-search config path uses PI_CODING_AGENT_DIR before XDG_CONFIG_HOME", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-config-path-"));
	const agentDir = join(root, "agent-dir");
	const xdgDir = join(root, "xdg");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(xdgDir, "pi"), { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ perplexityApiKey: "pplx-from-agent" }) + "\n", "utf8");
	await writeFile(join(xdgDir, "pi", "web-search.json"), JSON.stringify({}) + "\n", "utf8");

	const child = runChild(`
		const { getWebSearchConfigDir, getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		const { isPerplexityAvailable } = await import(${JSON.stringify(perplexityUrl)});
		console.log(JSON.stringify({
			dir: getWebSearchConfigDir(),
			path: getWebSearchConfigPath(),
			available: isPerplexityAvailable(),
		}));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: xdgDir,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		dir: agentDir,
		path: join(agentDir, "web-search.json"),
		available: true,
	});
});

test("web-search config path uses XDG_CONFIG_HOME pi directory when agent dir is unset", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-xdg-config-"));
	const xdgDir = join(root, "xdg");
	await mkdir(join(xdgDir, "pi"), { recursive: true });
	await writeFile(join(xdgDir, "pi", "web-search.json"), JSON.stringify({ geminiApiKey: "gemini-from-xdg" }) + "\n", "utf8");

	const child = runChild(`
		const { getWebSearchConfigDir, getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiUrl)});
		console.log(JSON.stringify({
			dir: getWebSearchConfigDir(),
			path: getWebSearchConfigPath(),
			available: isGeminiApiAvailable(),
		}));
	`, {
		PI_CODING_AGENT_DIR: undefined,
		XDG_CONFIG_HOME: xdgDir,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		dir: join(xdgDir, "pi"),
		path: join(xdgDir, "pi", "web-search.json"),
		available: true,
	});
});

test("Gemini base URL and Cloudflare auth use env before config", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-base-url-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({
		geminiBaseUrl: "https://config.example.com/gemini/",
		cloudflareApiKey: "config-cf-key",
	}) + "\n", "utf8");

	const child = runChild(`
		const {
			getApiHost,
			getVersionedApiBase,
			buildKeyParam,
			buildAuthHeaders,
			isGeminiApiAvailable,
		} = await import(${JSON.stringify(geminiApiUrl)});
		console.log(JSON.stringify({
			host: getApiHost(),
			base: getVersionedApiBase(),
			keyParam: buildKeyParam("gemini-key"),
			headers: buildAuthHeaders(),
			available: isGeminiApiAvailable(),
		}));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: undefined,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
		GOOGLE_GEMINI_BASE_URL: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/",
		CLOUDFLARE_API_KEY: "env-cf-key",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		host: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio",
		base: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/v1beta",
		keyParam: "",
		headers: { "cf-aig-authorization": "Bearer env-cf-key" },
		available: true,
	});
});

test("Gemini API requests include role and gateway auth headers", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-request-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const { queryGeminiApiWithVideo } = await import(${JSON.stringify(geminiApiUrl)});
		const text = await queryGeminiApiWithVideo("Describe", "files/test", { model: "gemini-test", timeoutMs: 1000 });
		console.log(JSON.stringify({ text, capturedUrl, capturedHeaders, capturedBody }));
	`, {
		PI_CODING_AGENT_DIR: undefined,
		XDG_CONFIG_HOME: undefined,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
		GOOGLE_GEMINI_BASE_URL: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio",
		CLOUDFLARE_API_KEY: "env-cf-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.equal(output.text, "ok");
	assert.equal(output.capturedUrl, "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/v1beta/models/gemini-test:generateContent");
	assert.equal(output.capturedHeaders["cf-aig-authorization"], "Bearer env-cf-key");
	assert.equal(output.capturedHeaders["Content-Type"], "application/json");
	assert.deepEqual(output.capturedBody.contents, [{
		role: "user",
		parts: [
			{ fileData: { fileUri: "files/test" } },
			{ text: "Describe" },
		],
	}]);
});

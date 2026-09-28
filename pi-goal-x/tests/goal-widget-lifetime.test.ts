import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGoalCore } from "../extensions/goal-state.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

for (const focused of [false, true]) test(`deferred widget render survives stale context (focused=${focused})`, async t => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-widget-lifetime-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const goal = writeActiveGoalFile({ cwd }, createGoal({ objective: "Keep working", autoContinue: true, sisyphus: false }));
	let stale = false;
	const factories: Function[] = [];
	const core = createGoalCore({ getActiveTools: () => [], setActiveTools: () => {}, appendEntry: () => {} } as any);
	const ctx = new Proxy({
		cwd, hasUI: true,
		ui: { setStatus: () => {}, setWidget: (_key: string, factory: unknown) => { if (typeof factory === "function") factories.push(factory); } },
		sessionManager: { getSessionId: () => "test", getBranch: () => focused ? [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }] : [] },
	}, { get(target, property) { if (stale) throw new Error(`stale context access: ${String(property)}`); return Reflect.get(target, property); } }) as unknown as ExtensionContext;
	await core.loadState(ctx);
	core.updateUI(ctx);
	await Promise.resolve();
	assert.ok(factories.length > 0);
	const component = factories.at(-1)!({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, { fg: (_: string, text: string) => text, bold: (text: string) => text });
	core.updateUI(ctx);
	core.clearGoalWidget(ctx);
	stale = true;
	await Promise.resolve();
	core.toggleDashboardExpanded();
	assert.doesNotThrow(() => component.render(100));
	const nextCwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-widget-replacement-"));
	t.after(() => fs.rmSync(nextCwd, {recursive: true, force: true}));
	const nextGoal = writeActiveGoalFile({cwd: nextCwd}, createGoal({objective: "Replacement objective", autoContinue: true, sisyphus: false}));
	const nextCtx = {cwd: nextCwd, hasUI: true, ui: {setStatus() {}, setWidget: (_key: string, factory: unknown) => { if (typeof factory === "function") factories.push(factory); }}, sessionManager: {getSessionId: () => "replacement", getBranch: () => [{type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(nextGoal.id, "created")}]}} as unknown as ExtensionContext;
	const count = factories.length;
	await core.loadState(nextCtx);
	core.updateUI(nextCtx);
	await Promise.resolve();
	assert.ok(factories.length > count, "replacement re-registers the widget");
	assert.equal(core.state.goal?.id, nextGoal.id);
	const nextComponent = factories.at(-1)!({requestRender() {}, terminal: {rows: 40, columns: 100}}, {fg: (_: string, text: string) => text, bold: (text: string) => text});
	assert.match(nextComponent.render(100).join("\n"), /Replacement objective/);
});

/**
 * Unit tests: the settings TUI components (v0.0.20 menu + selector;
 * v0.0.22 — the per-dial plain-language description on the highlighted
 * menu row, and the caller-composed selector title).
 *
 * The fakes are permissive on purpose: the components are stateless render
 * + handleInput over pi's KeybindingsManager surface (matches/getKeys), and
 * these tests pin the rendering contract, not the key mapping (that is pi's
 * job — the ids are tui.select.* / app.thinking.save, measured in both
 * pinned versions).
 *
 * Run: node --test "test/*.test.ts"
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SamEnumSelector, SamSettingsMenu } from "../src/settings-ui.ts";

/** Fake KeybindingsManager: matches fires for exactly the key ids in `press`. */
function pressKeys(press: string[]): { matches: (data: string, keyId: string) => boolean; getKeys: (keyId: string) => readonly string[] } {
	return {
		matches: (_data, keyId) => press.includes(keyId),
		getKeys: () => [] as readonly string[],
	};
}

test("the settings menu: row format + the highlighted row's description, which follows the cursor", () => {
	const rows = [
		{ key: "auditDepth", label: "audit depth", valueText: "auto", sourceText: "default", description: "how thoroughly each closed unit is checked" },
		{ key: "statusLine", label: "context status line", valueText: "on", sourceText: "default", description: "the live context bar under pi's status line" },
	];
	let result: unknown;
	const menu = new SamSettingsMenu(pressKeys(["tui.select.down"]), rows, (r) => {
		result = r;
	});
	const before = menu.render(100);
	assert.ok(before.some((l) => l.includes("audit depth: auto  [default]")), "the row format: label: value  [source]");
	assert.ok(before.some((l) => l.includes("— how thoroughly each closed unit is checked")), "the highlighted row's description is shown");
	menu.handleInput("x"); // the permissive fake: cursor down
	const after = menu.render(100);
	assert.ok(after.some((l) => l.includes("— the live context bar under pi's status line")), "the description follows the cursor");
	assert.ok(!after.some((l) => l.includes("— how thoroughly each closed unit is checked")), "the old description is gone");
});

test("the settings menu: the save key persists the highlighted row's dial key", () => {
	const rows = [
		{ key: "auditDepth", label: "audit depth", valueText: "medium", sourceText: "in-session", description: "how thoroughly each closed unit is checked" },
		{ key: "statusLine", label: "context status line", valueText: "on", sourceText: "default", description: "the live context bar under pi's status line" },
	];
	let result: unknown;
	const menu = new SamSettingsMenu(pressKeys(["app.thinking.save"]), rows, (r) => {
		result = r;
	});
	menu.handleInput("x"); // the permissive fake: the save key on the highlighted row
	assert.deepEqual(result, { kind: "persist", key: "auditDepth" });
});

test("the enum selector: the ✓ marks the current value; the caller-composed title (with the description) rides line 1", () => {
	const done = () => undefined;
	const sel = new SamEnumSelector(
		pressKeys([]),
		["auto", "light", "medium", "full"],
		"medium",
		"SAM audit depth — how thoroughly each closed unit is checked · confirm = this session · save key = this session + settings.json",
		done,
	);
	const lines = sel.render(100);
	assert.ok(lines[0].includes("how thoroughly each closed unit is checked"), "the description is part of the title (composed at the call site)");
	assert.ok(lines.some((l) => l.includes("✓ medium")), "the ✓ on the current value");
	assert.ok(!lines.some((l) => l.includes("✓ auto")), "no ✓ on the others");
});

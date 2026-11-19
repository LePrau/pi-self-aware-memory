/**
 * Unit tests: the settings TUI components (v0.0.20 menu + selector;
 * v0.0.22 — the per-dial plain-language description on the highlighted
 * menu row, and the caller-composed selector title;
 * v0.0.49 — the mouse wheel (handleMouse — cursor CLAMPED at the ends,
 * consumed via {handled: true}, non-wheel passes through) and the menu's
 * dial-list windowing to the terminal height (centred on the cursor,
 * the report's list-level calculation; no windowing without getRows)).
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
	assert.ok(lines[1].includes("how thoroughly each closed unit is checked"), "the description is part of the title (composed at the call site)");
	assert.ok(lines.some((l) => l.includes("✓ medium")), "the ✓ on the current value");
	assert.ok(!lines.some((l) => l.includes("✓ auto")), "no ✓ on the others");
});

/** The test rows for the windowing/wheel cases (labels dial 0..n−1). */
function menuRows(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		key: `dial${i}`,
		label: `dial ${i}`,
		valueText: "on",
		sourceText: "default",
		description: `note ${i}`,
	}));
}

test("the settings menu: the mouse wheel moves the cursor (CLAMPED) and returns {handled: true}; non-wheel passes through (v0.0.49)", () => {
	const menu = new SamSettingsMenu(pressKeys([]), menuRows(3), () => undefined);
	assert.deepStrictEqual(menu.handleMouse({ type: "wheel", wheelDelta: 10 }), { handled: true }, "the wheel is consumed (no chat fallthrough)");
	let lines = menu.render(100);
	assert.ok(lines.some((l) => l.startsWith("    >dial 2:")), "clamped to the last row");
	menu.handleMouse({ type: "wheel", wheelDelta: -10 });
	lines = menu.render(100);
	assert.ok(lines.some((l) => l.startsWith("    >dial 0:")), "clamped back to the first row");
	assert.deepStrictEqual(menu.handleMouse({ type: "click" }), undefined, "non-wheel passes through (pi selection etc.)");
	assert.deepStrictEqual(menu.handleMouse({ type: "wheel", wheelDelta: 0 }), undefined, "a zero delta is a no-op");
});

test("the enum selector: the mouse wheel moves the cursor (CLAMPED) and returns {handled: true} (v0.0.49)", () => {
	const sel = new SamEnumSelector(pressKeys([]), ["auto", "light", "medium", "full"], "medium", "t", () => undefined);
	// the cursor starts on the current value (index 1)
	assert.deepStrictEqual(sel.handleMouse({ type: "wheel", wheelDelta: -10 }), { handled: true });
	let lines = sel.render(100);
	assert.ok(lines.some((l) => l.startsWith("    >  auto")), "clamped to the first value");
	assert.deepStrictEqual(sel.handleMouse({ type: "wheel", wheelDelta: 10 }), { handled: true });
	lines = sel.render(100);
	assert.ok(lines.some((l) => l.startsWith("    >  full")), "clamped to the last value");
	assert.deepStrictEqual(sel.handleMouse({ type: "click" }), undefined, "non-wheel passes through");
});

test("the settings menu: the dial list windows to the terminal height, centred on the cursor (v0.0.49)", () => {
	const menu = new SamSettingsMenu(pressKeys(["tui.select.down"]), menuRows(8), () => undefined, () => 12); // vis = 12 − 7 = 5
	let lines = menu.render(100);
	assert.ok(lines.some((l) => l.startsWith("    >dial 0:")), "cursor at the top: the first row is visible");
	assert.ok(!lines.some((l) => l.includes("dial 7: ")), "the list is windowed (the last row is hidden)");
	for (let i = 0; i < 7; i++) menu.handleInput("x"); // the permissive fake: down ×7 → the last row
	lines = menu.render(100);
	assert.ok(lines.some((l) => l.startsWith("    >dial 7: ")), "the highlighted row stays visible");
	assert.ok(lines.some((l) => l.startsWith("     dial 3: ")), "the window pins at the end (clamped start)");
	assert.ok(!lines.some((l) => l.startsWith("     dial 0: ")), "row 0 has scrolled out of the window");
	assert.ok(lines.some((l) => l.includes("— note 7")), "the description follows the cursor");
	assert.ok(lines[1].includes("SAM settings"), "the header stays");
	assert.ok(lines.at(-1)!.includes("to edit"), "the hint stays");
});

test("the settings TUI: the report-style split line rides at the very top of both components (v0.0.49)", () => {
	const menu = new SamSettingsMenu(pressKeys([]), menuRows(2), () => undefined);
	const sel = new SamEnumSelector(pressKeys([]), ["a", "b"], "a", "t", () => undefined);
	assert.strictEqual(menu.render(40)[0], "─".repeat(40), "menu: the full-width split line is line 1");
	assert.strictEqual(sel.render(40)[0], "─".repeat(40), "selector: the full-width split line is line 1");
});

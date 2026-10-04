/**
 * TUI argument-completion pins (0.0.2 wave, Paul 2026-10-05): "/sam's UI
 * settings list is too long for the display line; UI-settings autocomplete /
 * show valid options while typing". Measured pi 0.87.1 supports
 * RegisteredCommand.getArgumentCompletions natively (/model + /thinking
 * precedent) — these pins cover the pure candidate lists; the TUI's visual
 * side is verified by Paul on the Qube TUI (the VM cannot render it).
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert";
import {
	SAM_COMMAND_DESCRIPTION,
	SAM_COMPLETION_SUBCOMMANDS,
	SAM_MODE_COMPLETIONS,
	samCompletionsFor,
} from "../src/tui-completions.ts";

test("bare (just typed /sam ): the ten subcommands, each a well-formed item", () => {
	const items = samCompletionsFor("");
	assert.ok(Array.isArray(items), "a list, not null");
	assert.equal(items?.length, 10, "8 since the 0.0.2 wave + goal (2026-10-05 final feature) + settle (valid subcommand, was missing from the list)");
	assert.deepEqual(
		items?.map((i) => i.value),
		["goal", "report", "mode", "fold", "resolve", "audit", "settle", "reaudit", "undo", "retrieve"],
	);
	for (const i of items!) assert.ok(typeof i.label === "string" && i.label.length > 0);
});

test("one word: the matching start set (pi's fuzzy engine filters the display); no match ⇒ null (no false candidates)", () => {
	assert.deepEqual(samCompletionsFor("re")?.map((i) => i.value), ["report", "resolve", "reaudit", "retrieve"]);
	assert.deepEqual(samCompletionsFor("go")?.map((i) => i.value), ["goal"], "'go' → the goal subcommand");
	assert.deepEqual(samCompletionsFor("mo")?.map((i) => i.value), ["mode"], "partial 'mo' matches the subcommand 'mode' (not yet the modes — that is the exact word case)");
	assert.equal(samCompletionsFor("zzz"), null, "nothing starts with 'zzz' ⇒ null");
});

test("'mode': the four display modes, values carry the full argument ('mode <m>')", () => {
	const items = samCompletionsFor("mode");
	assert.ok(Array.isArray(items));
	assert.deepEqual(
		items?.map((i) => i.value),
		["mode display", "mode manual", "mode assisted", "mode auto"],
	);
	// a typed tail still gets the mode list (the TUI filters on its side):
	assert.equal(samCompletionsFor("mode a")?.length, 4);
});

test("unit commands: the LIVE ledger ids (value '<cmd> <n>'); no ids ⇒ null (no false candidates)", () => {
	for (const cmd of ["fold", "resolve", "audit", "reaudit"]) {
		const items = samCompletionsFor(cmd, [1, 4, 5]);
		assert.deepEqual(
			items?.map((i) => i.value),
			[`${cmd} 1`, `${cmd} 4`, `${cmd} 5`],
			`${cmd}: live ids`
		);
		assert.deepEqual(items?.map((i) => i.label), ["1", "4", "5"], `${cmd}: labels are the ids`);
		// a typed partial digit still gets the id list:
		assert.equal(samCompletionsFor(`${cmd} 1`, [1, 4, 5])?.length, 3);
		assert.equal(samCompletionsFor(cmd), null, `${cmd}: no ledger ids ⇒ null`);
	}
});

test("other multi-word prefixes: null (free text, as before)", () => {
	assert.equal(samCompletionsFor("bogus xyz"), null);
	assert.deepEqual(samCompletionsFor("retrieve"), samCompletionsFor("")?.filter((s) => s.value === "retrieve"), "retrieve is a subcommand (the id is free text after)");
});

test("the registration description is SHORT (the TUI line) and names the tool", () => {
	assert.match(SAM_COMMAND_DESCRIPTION, /^pi-self-aware-memory /);
	assert.ok(SAM_COMMAND_DESCRIPTION.includes("report"));
	assert.ok(SAM_COMMAND_DESCRIPTION.includes("goal"), "the 2026-10-05 final feature is named in the short line");
	assert.ok(SAM_COMMAND_DESCRIPTION.length < 120, `fits (${SAM_COMMAND_DESCRIPTION.length} chars; the old one was ~190)`);
});

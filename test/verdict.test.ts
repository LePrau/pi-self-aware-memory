/**
 * Unit tests: verdict parsing (product port of the P1 spike, which cleared
 * the live bar 9/10 — see dev repo run-outputs).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { assistantText, parseVerdict } from "../src/verdict.ts";

test("VERIFIED: exact, case-insensitive, surrounding whitespace tolerated", () => {
	assert.deepEqual(parseVerdict("VERIFIED"), { class: "VERIFIED" });
	assert.deepEqual(parseVerdict("verified"), { class: "VERIFIED" });
	assert.deepEqual(parseVerdict("Verified"), { class: "VERIFIED" });
	assert.deepEqual(parseVerdict("  verified \n"), { class: "VERIFIED" });
});

test("CORRECTIONS: captures the list after the marker", () => {
	const v = parseVerdict("CORRECTIONS: the file has 5 lines, not 3");
	assert.deepEqual(v, { class: "CORRECTIONS", corrections: "the file has 5 lines, not 3" });
	assert.deepEqual(parseVerdict("corrections:\n  - line count is 5\n  - path was wrong").class, "CORRECTIONS");
});

test("CORRECTIONS with an empty list is UNAUDITABLE (nothing was said to correct)", () => {
	assert.deepEqual(parseVerdict("CORRECTIONS:"), { class: "UNAUDITABLE" });
	assert.deepEqual(parseVerdict("CORRECTIONS:   "), { class: "UNAUDITABLE" });
});

test("anything else is UNAUDITABLE", () => {
	for (const raw of ["", "   ", "looks fine to me", "VERIFIED, but see notes", "corrections (none)", "ok"]) {
		assert.equal(parseVerdict(raw).class, "UNAUDITABLE", JSON.stringify(raw));
	}
});

test("assistantText: strings pass through, blocks are concatenated", () => {
	assert.equal(assistantText("hello"), "hello");
	assert.equal(
		assistantText([
			{ type: "text", text: "VER" },
			{ type: "toolCall", name: "x", arguments: {} },
			{ type: "text", text: "IFIED" },
		]),
		"VERIFIED",
	);
	assert.equal(assistantText([]), "");
});

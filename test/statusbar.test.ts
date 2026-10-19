/**
 * Unit tests: the SAM status line / context bar (v0.0.15, Paul 2026-10-19).
 *
 * Plan + decisions:
 *   pi-agent/context-management/pi-self-aware-memory-dev/2026-10-19-sam-status-line.md
 *
 * All text is pinned exactly (D2 bar length 40, D6 `|` placement, D7 note
 * line, D8 segment math + overflow shrink order).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	STATUS_BAR_LENGTH,
	renderSamStatusLine,
	statusBarChars,
	type SamStatusLineInput,
} from "../src/statusbar.ts";

function input(over: Partial<SamStatusLineInput> = {}): SamStatusLineInput {
	return {
		tokens: 10_000,
		window: 20_000,
		reserve: 2_000,
		sysPromptTokens: 2_000,
		goalTokens: 250,
		stackTokens: 3_000,
		auditDepth: "medium",
		...over,
	};
}

test("bar length is exactly STATUS_BAR_LENGTH (40) chars", () => {
	const line = renderSamStatusLine(input());
	assert.ok(line.startsWith("SAM ["), line);
	assert.equal(line.length, 4 + STATUS_BAR_LENGTH + 2 + " audit: medium".length, line);
	const bar = line.slice(4, 4 + STATUS_BAR_LENGTH);
	assert.equal(bar.length, STATUS_BAR_LENGTH);
});

test("segments: O then . then x, scaled by window (500 tokens/char at W=20000)", () => {
	// O = 2250 → round(4.5) = 5; . = 3000 → 6; x = 10000−2250−3000 = 4750 → round(9.5) = 10
	// | at round((20000−2000)×40/20000) = 36
	const line = renderSamStatusLine(input());
	assert.equal(
		line,
		"SAM [" + "OOOOO" + "......" + "xxxxxxxxxx" + " ".repeat(15) + "|" + " ".repeat(3) + "] audit: medium",
		line,
	);
});

test("sub-scale segments get the min-1 char", () => {
	// O = 10 tokens → 1; . = 10 → 1; x = 80 → 1; | at 36
	assert.equal(
		renderSamStatusLine(input({ tokens: 100, sysPromptTokens: 10, goalTokens: 0, stackTokens: 10, auditDepth: "light" })),
		"SAM [" + "O.x" + " ".repeat(33) + "|" + " ".repeat(3) + "] audit: light",
	);
});

test("empty context: all-spaces bar with the | at its position", () => {
	assert.equal(
		renderSamStatusLine(input({ tokens: 0, sysPromptTokens: 0, goalTokens: 0, stackTokens: 0 })),
		"SAM [" + " ".repeat(36) + "|" + " ".repeat(3) + "] audit: medium",
	);
});

test("overflow: shrink x first, then ., then O (D8)", () => {
	// O = 15000 → 30; . = 10000 → 20; x = max(0, 20000−25000) = 0 ⇒ 50 > 40:
	// x nothing, dot 20→10, O stays 30. The | at 36 replaces a dot char.
	assert.deepEqual(statusBarChars(15_000, 10_000, 0, 20_000), { o: 30, dot: 10, x: 0 });
	assert.equal(
		renderSamStatusLine(input({ tokens: 20_000, sysPromptTokens: 10_000, goalTokens: 5_000, stackTokens: 10_000 })),
		"SAM [" + "O".repeat(30) + ".".repeat(6) + "|" + ".".repeat(3) + "] audit: medium",
	);
});

test("zero segments stay zero (no min-1)", () => {
	assert.deepEqual(statusBarChars(0, 0, 0, 20_000), { o: 0, dot: 0, x: 0 });
});

test("note line (D7): tokens null / no window / no reserve / zero window", () => {
	for (const over of [
		{ tokens: null },
		{ window: undefined },
		{ reserve: undefined },
		{ window: 0 },
	] satisfies Partial<SamStatusLineInput>[]) {
		assert.equal(renderSamStatusLine(input(over)), "SAM (context tokens unknown) audit: medium");
	}
});

/**
 * Unit tests: the SAM status line / context bar (v0.0.15, Paul 2026-10-19;
 * v0.0.16 fix-up 2 — segment re-semantics + in-flight tail, same version).
 *
 * Plan + decisions:
 *   pi-agent/context-management/pi-self-aware-memory-dev/2026-10-19-sam-status-line.md
 *   pi-agent/context-management/pi-self-aware-memory-dev/2026-10-19-sam-tui-inflight-estimate.md
 *
 * All text is pinned exactly (D2 bar length 40, D6 `|` placement, D7 note
 * line, D8 segment math + overflow shrink order, fix-up 2: O = pre-first-turn
 * prompt, dots = raw closed-span tokens, min-1 for every segment, retention
 * glyph ░, in-flight run in the unknown state).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	STATUS_BAR_LENGTH,
	renderSamStatusLine,
	samTuiSegments,
	statusBarChars,
	type SamStatusLineInput,
	type SamTuiSegmentsInput,
} from "../src/statusbar.ts";

function input(over: Partial<SamStatusLineInput> = {}): SamStatusLineInput {
	return {
		tokens: 10_000,
		window: 20_000,
		reserve: 2_000,
		sysPromptTokens: 2_000,
		goalTokens: 250,
		summaryTokens: 0,
		auditedTokens: 3_000,
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

test("/sam: post-fold O uses the takeover summary (fix-up 2 ruling 5)", () => {
	// O = 2000 + 8000 (summary > 0 ⇒ replaces the goal block) = 10000 → 20;
	// . = 1000 → 2; x = 10000 − 10000 − 1000 = 0.
	assert.equal(
		renderSamStatusLine(
			input({ tokens: 10_000, sysPromptTokens: 2_000, goalTokens: 250, summaryTokens: 8_000, auditedTokens: 1_000 }),
		),
		"SAM [" + "O".repeat(20) + ".." + " ".repeat(14) + "|" + " ".repeat(3) + "] audit: medium",
	);
});

test("/sam: in-flight tokens count into the total (fix-up 2)", () => {
	// 9900 + 100 in-flight = 10000 ⇒ identical to the baseline pin above.
	assert.equal(
		renderSamStatusLine(input({ tokens: 9_900, inflightTokens: 100 })),
		"SAM [" + "OOOOO" + "......" + "xxxxxxxxxx" + " ".repeat(15) + "|" + " ".repeat(3) + "] audit: medium",
	);
});

test("sub-scale segments get the min-1 char", () => {
	// O = 10 tokens → 1; . = 10 → 1; x = 80 → 1; | at 36
	assert.equal(
		renderSamStatusLine(input({ tokens: 100, sysPromptTokens: 10, goalTokens: 0, summaryTokens: 0, auditedTokens: 10, auditDepth: "light" })),
		"SAM [" + "O.x" + " ".repeat(33) + "|" + " ".repeat(3) + "] audit: light",
	);
});

test("empty context: all-spaces bar with the | at its position", () => {
	assert.equal(
		renderSamStatusLine(input({ tokens: 0, sysPromptTokens: 0, goalTokens: 0, summaryTokens: 0, auditedTokens: 0 })),
		"SAM [" + " ".repeat(36) + "|" + " ".repeat(3) + "] audit: medium",
	);
});

test("overflow: shrink x first, then ., then O (D8)", () => {
	// O = 15000 → 30; . = 10000 → 20; x = max(0, 20000−25000) = 0 ⇒ 50 > 40:
	// x nothing, dot 20→10, O stays 30. The | at 36 replaces a dot char.
	assert.deepEqual(statusBarChars(15_000, 10_000, 0, 20_000), { o: 30, dot: 10, x: 0 });
	assert.equal(
		renderSamStatusLine(
			input({ tokens: 20_000, sysPromptTokens: 10_000, goalTokens: 5_000, summaryTokens: 0, auditedTokens: 10_000 }),
		),
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

/* ── v0.0.16 TUI bar (plan: pi-self-aware-memory-dev/2026-10-19-sam-tui-status-line.md;
 *    fix-up 2: pi-self-aware-memory-dev/2026-10-19-sam-tui-inflight-estimate.md) ── */

function tuiInput(over: Partial<SamTuiSegmentsInput> = {}): SamTuiSegmentsInput {
	return {
		tokens: 10_000,
		window: 20_000,
		reserve: 2_000,
		keepRecent: 5_000,
		sysPromptTokens: 2_000,
		goalTokens: 250,
		summaryTokens: 0,
		auditedTokens: 3_000,
		auditDepth: "medium",
		...over,
	};
}

test("TUI: known state — prompt/audited/retention runs, | at 36, not crossed", () => {
	// O = 2250 → 5; . = 3000 → 6; x = 4750, keep = 5000 ≥ x ⇒ all remainder is
	// retention: ret = round(9.5) = 10 (glyph ░ — fix-up 2).
	const bar = samTuiSegments(tuiInput());
	assert.equal(bar.crossed, false);
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "prompt", text: "█████" },
		{ kind: "audited", text: "······" },
		{ kind: "retention", text: "░".repeat(10) },
		{ kind: "fill", text: " ".repeat(15) },
		{ kind: "threshold", text: "│" },
		{ kind: "fill", text: " ".repeat(3) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: in-flight counts into the total in the known state (fix-up 2)", () => {
	// 9900 + 100 in-flight = 10000 ⇒ identical to the baseline known pin.
	const bar = samTuiSegments(tuiInput({ tokens: 9_900, inflightTokens: 100 }));
	assert.equal(bar.crossed, false);
	assert.deepEqual(
		bar.segments.map((s) => s.text),
		samTuiSegments(tuiInput()).segments.map((s) => s.text),
	);
});

test("TUI: crossed — outside run before the |, retention after (red/yellow split at W−R)", () => {
	// tokens = 19000 > 18000 (W−R). O = 5, . = 6; x = 13750, keep = 5000:
	// outside = 8750, retention = 5000; rem = round(27.5) = 28;
	// outside = round(8750×28/13750) = 18, retention = 10 (░).
	// The | at 36 REPLACES a retention char (inside the tail, past the line).
	const bar = samTuiSegments(tuiInput({ tokens: 19_000 }));
	assert.equal(bar.crossed, true);
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "prompt", text: "█████" },
		{ kind: "audited", text: "······" },
		{ kind: "outside", text: "▒".repeat(18) },
		{ kind: "retention", text: "░".repeat(7) },
		{ kind: "threshold", text: "│" },
		{ kind: "retention", text: "░░" },
		{ kind: "fill", text: " " },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: retention-only remainder (tail smaller than the remainder)", () => {
	// tokens = 8000: x = 2750, keep = 5000 ⇒ outside = 0, retention = 2750 → 6 chars (░).
	const bar = samTuiSegments(tuiInput({ tokens: 8_000 }));
	assert.equal(bar.crossed, false);
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "prompt", text: "█████" },
		{ kind: "audited", text: "······" },
		{ kind: "retention", text: "░".repeat(6) },
		{ kind: "fill", text: " ".repeat(19) },
		{ kind: "threshold", text: "│" },
		{ kind: "fill", text: " ".repeat(3) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: post-fold O uses the takeover summary (fix-up 2 ruling 5)", () => {
	// O = 2000 + 8000 (summary > 0 ⇒ replaces goal 250) = 10000 → 20; . = 3000 → 6;
	// x = 10000 − 13000 = 0.
	const bar = samTuiSegments(tuiInput({ tokens: 10_000, summaryTokens: 8_000 }));
	assert.equal(bar.crossed, false);
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "prompt", text: "█".repeat(20) },
		{ kind: "audited", text: "······" },
		{ kind: "fill", text: " ".repeat(10) },
		{ kind: "threshold", text: "│" },
		{ kind: "fill", text: " ".repeat(3) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: unknown state (tokens null) — O + ' ???' + | still placed (Paul ruling 3)", () => {
	// O = 2250 → 5; separator space at 5, ??? at 6–8; | at 36.
	const bar = samTuiSegments(tuiInput({ tokens: null }));
	assert.equal(bar.crossed, false);
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "prompt", text: "█████" },
		{ kind: "fill", text: " " },
		{ kind: "unknown", text: "???" },
		{ kind: "fill", text: " ".repeat(27) },
		{ kind: "threshold", text: "│" },
		{ kind: "fill", text: " ".repeat(3) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: unknown state WITH in-flight — its own min-1 run (fix-up 2 ruling 2)", () => {
	// O = 2250 → 5; in-flight 3000 → round(6) = 6 (░); separator at 11,
	// ??? at 12–14; | at 36.
	const bar = samTuiSegments(tuiInput({ tokens: null, inflightTokens: 3_000 }));
	assert.equal(bar.crossed, false);
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "prompt", text: "█████" },
		{ kind: "retention", text: "░".repeat(6) },
		{ kind: "fill", text: " " },
		{ kind: "unknown", text: "???" },
		{ kind: "fill", text: " ".repeat(21) },
		{ kind: "threshold", text: "│" },
		{ kind: "fill", text: " ".repeat(3) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: unknown state with sub-scale in-flight — min-1 char (fix-up 2 ruling 3)", () => {
	// in-flight 100 → round(0.2) = 0 → min-1 ⇒ 1 char (░).
	const bar = samTuiSegments(tuiInput({ tokens: null, inflightTokens: 100 }));
	assert.deepEqual(
		bar.segments.find((s) => s.kind === "retention")?.text,
		"░",
	);
});

test("TUI: unknown state without window — no scale, no O, no in-flight, no |", () => {
	const bar = samTuiSegments(tuiInput({ tokens: null, window: undefined, inflightTokens: 3_000 }));
	assert.equal(bar.crossed, false);
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "fill", text: " " },
		{ kind: "unknown", text: "???" },
		{ kind: "fill", text: " ".repeat(36) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: overflow — shrink outside → retention → audited → prompt (D7)", () => {
	// O = 15000 → 30, . = 10000 → 20, x = 0 ⇒ 50 > 40: dot 20 → 10; the | at 36
	// replaces an audited char.
	const bar = samTuiSegments(
		tuiInput({ tokens: 20_000, sysPromptTokens: 10_000, goalTokens: 5_000, summaryTokens: 0, auditedTokens: 10_000 }),
	);
	assert.equal(bar.crossed, true); // 20000 > 18000
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "prompt", text: "█".repeat(30) },
		{ kind: "audited", text: "·".repeat(6) },
		{ kind: "threshold", text: "│" },
		{ kind: "audited", text: "·".repeat(3) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: overflow shrinks audited before prompt (fix-up 2: post-fold O stays last)", () => {
	// O = 5000 + 3000 (summary) = 8000 → 16; . = 14000 → 28; x = 22000 − 22000 = 0
	// ⇒ 44 > 40: no outside/retention, dot 28 → 24, O stays 16. The | at 36
	// replaces an audited char.
	const bar = samTuiSegments(
		tuiInput({ tokens: 22_000, sysPromptTokens: 5_000, goalTokens: 0, summaryTokens: 3_000, auditedTokens: 14_000 }),
	);
	assert.equal(bar.crossed, true); // 22000 > 18000
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "prompt", text: "█".repeat(16) },
		{ kind: "audited", text: "·".repeat(20) },
		{ kind: "threshold", text: "│" },
		{ kind: "audited", text: "·".repeat(3) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: min-1 split of the remainder (outside and retention both get a char)", () => {
	// tokens = 7350: x = 2100 → rem = round(4.2) = 4; keep = 2000:
	// outside = 100, retention = 2000 ⇒ outside = max(1, round(0.19)) = 1, retention = 3.
	const bar = samTuiSegments(tuiInput({ tokens: 7_350, keepRecent: 2_000 }));
	assert.equal(bar.crossed, false);
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "prompt", text: "█████" },
		{ kind: "audited", text: "······" },
		{ kind: "outside", text: "▒" },
		{ kind: "retention", text: "░░░" },
		{ kind: "fill", text: " ".repeat(21) },
		{ kind: "threshold", text: "│" },
		{ kind: "fill", text: " ".repeat(3) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

test("TUI: 1-char remainder budget — outside wins (deterministic)", () => {
	// tokens = 5750: x = 500 → rem = round(1) = 1; keep = 400:
	// outside = 100, retention = 400 ⇒ outside = 1, retention = 0.
	const bar = samTuiSegments(tuiInput({ tokens: 5_750, keepRecent: 400 }));
	assert.equal(
		bar.segments.some((s) => s.kind === "retention"),
		false,
		JSON.stringify(bar.segments),
	);
	assert.equal(
		bar.segments.find((s) => s.kind === "outside")?.text,
		"▒",
	);
});

test("TUI: empty known context — all-fill bar with the | at its position", () => {
	const bar = samTuiSegments(
		tuiInput({ tokens: 0, sysPromptTokens: 0, goalTokens: 0, summaryTokens: 0, auditedTokens: 0 }),
	);
	assert.equal(bar.crossed, false);
	assert.deepEqual(bar.segments, [
		{ kind: "bracket", text: "[" },
		{ kind: "fill", text: " ".repeat(36) },
		{ kind: "threshold", text: "│" },
		{ kind: "fill", text: " ".repeat(3) },
		{ kind: "bracket", text: "]" },
		{ kind: "suffix", text: " audit: medium" },
	]);
});

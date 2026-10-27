/**
 * 2026-10-27: elapsed time on close and audit (WISHLIST) — the pure core of
 * src/tool-render.ts (the pi-tui wrappers are visual glue, covered live)
 * plus the child-progress plumbing: countChildToolCalls (extraction.ts)
 * and auditProgressLine (closeaudit.ts).
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	formatSamToolDuration,
	samTimerText,
	samTextOutput,
	samStubArgsPreview,
	type SamTimerState,
} from "../src/tool-render.ts";
import { countChildToolCalls } from "../src/extraction.ts";
import { auditProgressLine } from "../src/closeaudit.ts";
import type { RawEntry } from "../src/branchaudit.ts";

/* ── formatSamToolDuration (the core's formatToolDuration, verbatim) ────── */

test("formatSamToolDuration: seconds under a minute", () => {
	assert.equal(formatSamToolDuration(0), "0.0s");
	assert.equal(formatSamToolDuration(4200), "4.2s");
	assert.equal(formatSamToolDuration(59999), "60.0s"); // the core rounds up at the boundary, too
});

test("formatSamToolDuration: minutes and hours", () => {
	assert.equal(formatSamToolDuration(61000), "1m 1s");
	assert.equal(formatSamToolDuration(90000), "1m 30s");
	assert.equal(formatSamToolDuration(3661000), "1h 1m 1s");
});

/* ── samTimerText (the timer state machine) ─────────────────────────────── */

test("samTimerText: no clock yet ⇒ no line", () => {
	const state: SamTimerState = {};
	assert.equal(samTimerText(state, 1000, true, false), undefined);
	assert.equal(state.endedAt, undefined); // a partial render never ends the clock
});

test("samTimerText: live elapsed from the renderer clock", () => {
	const state: SamTimerState = { startedAt: 1000 };
	assert.equal(samTimerText(state, 5500, true, false), "Elapsed 4.5s");
});

test("samTimerText: final without a recorded duration ⇒ renderer clock", () => {
	const state: SamTimerState = { startedAt: 1000 };
	assert.equal(samTimerText(state, 6200, false, false), "Took 5.2s");
	assert.equal(state.endedAt, 6200);
});

test("samTimerText: the RECORDED durationMs wins for the final line (1.3.0+/1.4.0)", () => {
	const state: SamTimerState = { startedAt: 1000 };
	// the renderer clock says 6.2 s; the recorded duration says 8 m — the record wins
	assert.equal(samTimerText(state, 6200, false, false, 480000), "Took 8m 0s");
});

test("samTimerText: bad recorded values are ignored (0.87.1 shape — field absent)", () => {
	assert.equal(samTimerText({ startedAt: 1000 }, 2000, false, false, -5), "Took 1.0s");
	assert.equal(samTimerText({ startedAt: 1000 }, 3000, true, true, Number.NaN), "Elapsed 2.0s"); // isError ends the clock, stays "Elapsed" while partial
});

/* ── samTextOutput ───────────────────────────────────────────────────────── */

test("samTextOutput: text blocks only, joined, \\r stripped", () => {
	assert.equal(samTextOutput([{ type: "text", text: "a" }, { type: "text", text: "b\r" }]), "a\nb");
});

test("samTextOutput: non-text / non-array content ⇒ empty", () => {
	assert.equal(samTextOutput([{ type: "image", data: "x" }]), "");
	assert.equal(samTextOutput("plain string"), "");
	assert.equal(samTextOutput(undefined), "");
});

/* ── samStubArgsPreview (the close family's row preview) ─────────────────── */

test("samStubArgsPreview: collapsed shows the size (like the in-flight audit line)", () => {
	assert.equal(samStubArgsPreview({ stub: "x\ny", depth: "full" }, "close_unit", false), "depth=full stub: 2 lines, 3 chars");
	assert.equal(samStubArgsPreview({ stub: "x" }, "close_unit", false), "stub: 1 lines, 1 chars");
	assert.equal(samStubArgsPreview({ stub: "x", unitId: 3 }, "update_unit", false), "unitId=3 stub: 1 lines, 1 chars");
});

test("samStubArgsPreview: expanded shows the fields, the stub verbatim (core format)", () => {
	assert.equal(samStubArgsPreview({ stub: "a\nb", depth: "full" }, "close_unit", true), "  depth: full\n  stub: a\n      b");
	assert.equal(samStubArgsPreview({ stub: "a" }, "update_unit", true), "  stub: a");
});

test("samStubArgsPreview: missing args are total", () => {
	assert.equal(samStubArgsPreview(undefined, "close_unit", false), "stub: 1 lines, 0 chars");
	assert.equal(samStubArgsPreview({}, "close_unit", true), "");
});

/* ── countChildToolCalls (the audit child's tool-call count) ─────────────── */

function assistantEntry(id: string, blocks: unknown[]): RawEntry {
	return { id, type: "message", message: { role: "assistant", content: blocks } };
}

test("countChildToolCalls: only assistant toolCall blocks count", () => {
	assert.equal(countChildToolCalls([]), 0);
	const entries: RawEntry[] = [
		{ id: "1", type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
		assistantEntry("2", [{ type: "text", text: "thinking" }, { type: "toolCall", name: "read", id: "t1", arguments: { path: "a" } }]),
		assistantEntry("3", [
			{ type: "toolCall", name: "bash", id: "t2", arguments: { command: "ls" } },
			{ type: "toolCall", name: "read", id: "t3", arguments: { path: "b" } },
		]),
		{ id: "4", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
		{ id: "5", type: "message", message: { role: "assistant", content: "string content" } },
		{ id: "6", type: "custom", customType: "sam", data: {} },
	];
	assert.equal(countChildToolCalls(entries), 3);
});

/* ── auditProgressLine (the live in-flight audit line) ───────────────────── */

test("auditProgressLine: the base text (depth + stub size)", () => {
	assert.equal(
		auditProgressLine({ depth: "medium", depthSource: "zone" }, "a\nb"),
		"auditing the summary… (medium audit · stub: 2 lines · 3 chars)",
	);
});

test("auditProgressLine: the override hint and the child tool-call count", () => {
	assert.equal(
		auditProgressLine({ depth: "full", depthSource: "tool-override" }, "a"),
		"auditing the summary… (full audit, depth override · stub: 1 lines · 1 chars)",
	);
	assert.equal(auditProgressLine({ depth: "medium", depthSource: "zone" }, "a", 0), "auditing the summary… (medium audit · stub: 1 lines · 1 chars) · child: 0 tool calls");
	assert.equal(auditProgressLine({ depth: "medium", depthSource: "zone" }, "a", 1), "auditing the summary… (medium audit · stub: 1 lines · 1 chars) · child: 1 tool call");
	assert.equal(auditProgressLine({ depth: "medium", depthSource: "zone" }, "a", 3), "auditing the summary… (medium audit · stub: 1 lines · 1 chars) · child: 3 tool calls");
});

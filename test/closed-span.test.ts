/**
 * Unit tests: closedSpanTokens — the close boundary (v0.0.16 fix-up 3).
 *
 * Pins the fix: the dots count the RAW tokens of closed spans still present
 * in the CURRENT projection — including closed spans that pi preserved in
 * the post-fold retention tail (a close immediately followed by a fold).
 * The old window (lastCompaction, lastSettlement] returned 0 there.
 *
 * Measured case (session 2026-10-16T17-58-17…jsonl): u105 close @4645, then
 * fold @4656; the retention tail contained 17,744 tokens of u105's closed
 * span (→ 5 dots expected, 0 rendered) plus 3,119 tokens of genuine
 * orphaned post-close tail (→ 1 block).
 *
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { __closedSpanTokens } from "../extensions/self-aware-memory/index.ts";
import { SAM_LEDGER_CUSTOM_TYPE } from "../src/ledger.ts";
import type { PlainEntry } from "../src/projection.ts";

let n = 0;
const id = () => `e${++n}`;
const t = (chars: number) => "x".repeat(chars); // multiples of 4 → tokens = chars/4

function userMessage(text: string): PlainEntry {
	return { id: id(), kind: "message", message: { role: "user", content: text } };
}

function assistantMessage(text: string): PlainEntry {
	return { id: id(), kind: "message", message: { role: "assistant", content: text, stopReason: "stop" } };
}

function settlement(): PlainEntry {
	return { id: id(), kind: "custom", customType: SAM_LEDGER_CUSTOM_TYPE, data: { kind: "settlement", unitId: 1 } };
}

function compaction(summaryChars: number, firstKeptEntryId: string): PlainEntry {
	return { id: id(), kind: "compaction", summary: t(summaryChars), firstKeptEntryId };
}

test("no close at all → 0 (with and without a compaction)", () => {
	n = 0;
	const a = userMessage(t(100));
	assert.equal(__closedSpanTokens([a, assistantMessage(t(100))]), 0);
	const c = compaction(400, a.id);
	assert.equal(__closedSpanTokens([a, c, userMessage(t(100))]), 0);
});

test("pre-fold: closed span before the settlement counts; the open span after it does not", () => {
	n = 0;
	const a = userMessage(t(100)); // 25 tokens, closed span
	const s = settlement();
	const b = assistantMessage(t(200)); // 50 tokens, open span
	assert.equal(__closedSpanTokens([a, s, b]), 25);
});

test("close-then-fold (measured u105 case): closed span retained in the tail counts", () => {
	n = 0;
	const t1 = userMessage(t(400)); // 100 — closed-span content, kept in the tail
	const t2 = assistantMessage(t(800)); // 200 — closed-span content, kept in the tail
	const s = settlement();
	const c = compaction(400, t1.id); // summary = 100 tokens — must NOT count (O's job)
	const u = userMessage(t(400)); // 100 — open span after the fold
	// old window (lastCompaction, lastSettlement] → 0; fixed → 300
	assert.equal(__closedSpanTokens([t1, t2, s, c, u]), 300);
});

test("orphaned entries absorbed into the next closed span count", () => {
	n = 0;
	const o1 = userMessage(t(100)); // 25 — orphaned span (no settlement of its own)
	const o2 = assistantMessage(t(200)); // 50 — orphaned span
	const s = settlement(); // its audited span (prev-settlement, s] covers o1+o2
	const c = compaction(400, o1.id);
	const u = userMessage(t(400)); // open
	assert.equal(__closedSpanTokens([o1, o2, s, c, u]), 75);
});

test("settlement after a fold: pre-fold retained content + post-fold closed span count, summary does not", () => {
	n = 0;
	const c0 = userMessage(t(100)); // 25 — retained pre-fold content (before the first settlement → closed span)
	const c = compaction(200, c0.id); // summary 50 — excluded
	const d = userMessage(t(400)); // 100 — closed span between compaction and settlement
	const s = settlement();
	const u = userMessage(t(400)); // 100 — open span
	assert.equal(__closedSpanTokens([c0, c, d, s, u]), 125);
});

test("entries dropped by the compaction checkpoint contribute nothing", () => {
	n = 0;
	const x = userMessage(t(100)); // dropped (before firstKept)
	const y = userMessage(t(400)); // 100 — kept
	const c = compaction(400, y.id);
	const s = settlement();
	assert.equal(__closedSpanTokens([x, y, c, s]), 100);
});

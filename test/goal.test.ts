/**
 * D11 (2026-10-02) — goal persistence: PURE LOGIC PINS (no pi, no live
 * inference — the house rule; the wiring arms live in test/d8d9-arms.test.ts
 * and test/close-audit.test.ts). The model-facing strings are pinned here
 * and in test/protocol pins.
 *
 * Scope pinned:
 *  - isGoalRecord (ledger-parse guard; the validator fix ships with the
 *    NOT-YET-VERIFIED/UNVERIFIED-AUDIT-ACCEPT settlement cases in ledger.ts);
 *  - goalRecords / latestGoal (latest-wins — mirrors settlements'
 *    latest-per-unit rule);
 *  - lastRealUserMessage (F4: SAM-injected text is never user input);
 *  - agentTurnsAfter (n = 1 decided; thinking blocks excluded; tool-call-only
 *    turns skipped);
 *  - fallbackGoal (verbatim user input + n agent turns, labelled
 *    takeover-derived; provenance ids when present);
 *  - softWrap (display-only, content-stable);
 *  - goalBlock / goalBlockHeader / GOAL_BLOCK_MARKER (the replacement
 *    semantics rely on this exact shape — stripGoalBlock pins it back);
 *  - stripGoalBlock (replacement at the next fold; foreign summaries
 *    UNTOUCHED — the fail-safe).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	GOAL_BLOCK_MARKER,
	GOAL_FALLBACK_HEADER,
	isGoalRecord,
	goalRecords,
	latestGoal,
	lastRealUserMessage,
	agentTurnsAfter,
	fallbackGoal,
	softWrap,
	goalBlock,
	goalBlockHeader,
	stripGoalBlock,
} from "../src/goal.ts";
import { AUDIT_INSTRUCTION_PREFIX } from "../src/protocol.ts";

/* ── the record guard ───────────────────────────────────────────────────── */

test("isGoalRecord: accepts the pinned shape; rejects everything else", () => {
	assert.equal(isGoalRecord({ v: 1, kind: "goal", text: "migrate the scheduler", ts: 123, basis: "adjust-goal" }), true);
	assert.equal(isGoalRecord({ v: 1, kind: "goal", text: "x", ts: 1, basis: "takeover-fallback", userEntryId: "a1", turnEntryIds: ["a2"] }), true);
	assert.equal(isGoalRecord(null), false);
	assert.equal(isGoalRecord({ v: 2, kind: "goal", text: "x", ts: 1, basis: "adjust-goal" }), false, "versioned");
	assert.equal(isGoalRecord({ v: 1, kind: "settlement", text: "x", ts: 1, basis: "adjust-goal" }), false, "kind");
	assert.equal(isGoalRecord({ v: 1, kind: "goal", text: "  ", ts: 1, basis: "adjust-goal" }), false, "whitespace-only text is no goal");
	assert.equal(isGoalRecord({ v: 1, kind: "goal", text: "x", basis: "adjust-goal" }), false, "ts required");
	assert.equal(isGoalRecord({ v: 1, kind: "goal", text: "x", ts: 1 }), false, "basis required");
	assert.equal(isGoalRecord({ v: 1, kind: "goal", text: "x", ts: 1, basis: "weird" }), false, "basis is a closed set");
	assert.equal(isGoalRecord({ v: 1, kind: "goal", text: "x", ts: 1, basis: "adjust-goal", turnEntryIds: "no" }), false, "turnEntryIds is a string array (the strict-mode pin)");
});

/* ── latest-wins ────────────────────────────────────────────────────────── */

const E = {
	goal: (text: string, ts: number, basis: "adjust-goal" | "takeover-fallback" = "adjust-goal"): unknown => ({
		kind: "custom", customType: "sam", data: { v: 1, kind: "goal", text, ts, basis },
	}),
	settlement: (): unknown => ({ kind: "custom", customType: "sam", data: { v: 1, kind: "settlement", unitId: 1, retrievalId: "abc123def456", verdict: "VERIFIED", line: "x", auditFile: "f", replyId: "r", parsedClean: true, ts: 1 } }),
	nudge: (): unknown => ({ kind: "custom", customType: "sam-nudge", data: { trigger: "band" } }),
};

test("goalRecords: goal records only, in branch order; foreign custom types ignored", () => {
	const out = goalRecords([E.nudge(), E.goal("one", 1), E.settlement(), E.goal("two", 2)] as never);
	assert.equal(out.length, 2);
	assert.equal(out[0].text, "one");
	assert.equal(out[1].text, "two");
});

test("latestGoal: latest-wins (last record in branch order); none ⇒ undefined", () => {
	assert.equal(latestGoal([] as never), undefined);
	const g = latestGoal([E.goal("old", 1), E.settlement(), E.goal("new", 2)] as never);
	assert.equal(g?.text, "new");
});

/* ── the fallback capture ───────────────────────────────────────────────── */

test("lastRealUserMessage: the last real user message; SAM-injected + audit/undo noise skipped", () => {
	const entries = [
		{ id: "m1", type: "message", message: { role: "user", content: "first task prompt" } },
		{ id: "m2", type: "message", message: { role: "assistant", content: "on it" } },
		{ id: "m3", type: "message", message: { role: "user", content: "[sam-nudge] continue" } },
		{ id: "m4", type: "message", message: { role: "user", content: `${AUDIT_INSTRUCTION_PREFIX} Unit 1 was just closed.` } },
		{ id: "m5", type: "message", message: { role: "user", content: "no — do it with the v4 dials instead" } },
		{ id: "m6", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } },
	] as never[];
	const hit = lastRealUserMessage(entries);
	assert.equal(hit?.text, "no — do it with the v4 dials instead");
	assert.equal(hit?.id, "m5");
	assert.equal(lastRealUserMessage([{ id: "x", type: "message", message: { role: "user", content: "[sam-nudge] hi" } }] as never), undefined);
	assert.equal(lastRealUserMessage([] as never), undefined);
});

test("agentTurnsAfter: exactly n ASSISTANT TEXT turns after the user input; thinking + tool-call-only skipped", () => {
	const entries = [
		{ id: "u", type: "message", message: { role: "user", content: "goal input" } },
		{ id: "t1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }] } },
		{ id: "t2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "x", arguments: {} }] } },
		{ id: "t3", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Turn one text." }] } },
		{ id: "t4", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Turn two " }, { type: "text", text: "text." }] } },
	] as never[];
	const out = agentTurnsAfter(entries, 0, 1);
	assert.equal(out.length, 1, "n = 1 caps the capture");
	assert.equal(out[0].text, "Turn one text.");
	const two = agentTurnsAfter(entries, 0, 2);
	assert.equal(two.length, 2);
	assert.equal(two[1].text, "Turn two text.", "text blocks are concatenated");
});

test("fallbackGoal: verbatim user input + n turns, labelled takeover-derived; ids as provenance", () => {
	const entries = [
		{ id: "u1", type: "message", message: { role: "user", content: "Write the report; ask before committing" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: "Understood — the report, no commits without asking." } },
	] as never[];
	const fb = fallbackGoal(entries, 1, 1761987000000);
	assert.ok(fb, "a real user message + one turn ⇒ the fallback exists");
	assert.equal(fb.record.basis, "takeover-fallback");
	assert.ok(fb.record.text.includes("GOAL FALLBACK"), "the capture is labelled");
	assert.ok(fb.record.text.includes("USER INPUT: Write the report; ask before committing"), "the user input verbatim");
	assert.ok(fb.record.text.includes("AGENT TURN 1: Understood — the report, no commits without asking."), "the one agent turn verbatim (n = 1)");
	assert.equal(fb.record.userEntryId, "u1");
	assert.deepEqual(fb.record.turnEntryIds, ["a1"]);
	// no real user message ⇒ no fallback (nothing to capture — the fold goes
	// through pi's own path; fail-open)
	assert.equal(fallbackGoal([{ id: "a", type: "message", message: { role: "assistant", content: "hi" } }] as never, 1, 0), undefined);
	// no agent turns after the input: the capture is still valid (user input only)
	const noTurn = fallbackGoal([{ id: "u", type: "message", message: { role: "user", content: "just do it" } }] as never, 1, 5);
	assert.ok(noTurn);
	assert.ok(!noTurn.record.text.includes("AGENT TURN"), "no fabricated turns");
});

/* ── the block shape (replace semantics rely on it) ─────────────────────── */

test("goalBlock: header + verbatim text + the pinned marker; the fallback header for fallback basis", () => {
	const g = goalBlock({ v: 1, kind: "goal", text: "Migrate the scheduler to the v4 dials", ts: 1761985200000, basis: "adjust-goal" });
	assert.deepEqual(g.split("\n"), [goalBlockHeader(1761985200000), "Migrate the scheduler to the v4 dials", GOAL_BLOCK_MARKER]);
	assert.ok(goalBlockHeader(1761985200000).startsWith("Goal (stored "));
	assert.ok(goalBlockHeader(1761985200000).includes("via adjust_goal"));
	const fb = goalBlock({ v: 1, kind: "goal", text: "USER INPUT: x", ts: 5, basis: "takeover-fallback" });
	assert.ok(fb.startsWith(GOAL_FALLBACK_HEADER));
	assert.ok(fb.endsWith(GOAL_BLOCK_MARKER));
});

test("softWrap: display-only — hard newlines preserved, lines broken at spaces, long words hard-chunked, NO text mutation", () => {
	assert.equal(softWrap("short", 96), "short");
	const multi = softWrap("line one\nline two", 96);
	assert.equal(multi, "line one\nline two", "hard newlines survive");
	const w = softWrap("aaaa bbbb cccc dddd eeee", 12);
	assert.equal(w.split("\n").join(" ").split(" ").sort().join(" "), "aaaa bbbb cccc dddd eeee".split(" ").sort().join(" "), "word set unchanged (display-only)");
	assert.ok(w.split("\n").every((l) => l.length <= 12), "broken at width");
	const long = softWrap("x".repeat(30) + " ok", 10);
	assert.ok(long.split("\n").every((l) => l.length <= 10), "unbreakable words hard-chunked");
});

test("stripGoalBlock: removes our goal block (both header shapes) incl. the following blank; foreign summaries UNTOUCHED", () => {
	const adjust = `${goalBlockHeader(1)}\nOLD GOAL TEXT\n${GOAL_BLOCK_MARKER}\n\nrest of the old summary`;
	assert.equal(stripGoalBlock(adjust), "rest of the old summary", "adjust-goal block replaced, prose kept");
	const fallback = `${GOAL_FALLBACK_HEADER}\nUSER INPUT: something\n${GOAL_BLOCK_MARKER}\nleftover`;
	assert.equal(stripGoalBlock(fallback), "leftover", "fallback block stripped too");
	assert.equal(stripGoalBlock("## pi-native summary\nprose"), "## pi-native summary\nprose", "a summary we did not author is never touched (fail-safe)");
	assert.equal(stripGoalBlock(goalBlockHeader(1) + "\nno marker here"), goalBlockHeader(1) + "\nno marker here", "header without our marker ⇒ malformed ⇒ untouched");
});

/**
 * D11b — the goal-clarification nudge (src/goal-nudge.ts) and its pins.
 * DECIDED + LANDED 2026-10-03 (design note: dev-repo
 * `2026-10-03-v4-goal-clarification-nudge.md`; wording is Paul's, surgical
 * fixes only — the note lists them).
 *
 * Trigger (measured 2026-10-03 at `2e1b2f0`): NO active goal nudge existed —
 * only static tool-description text + the fold-time fallback; across all 19
 * rep banks the model never once called adjust_goal (every goal record
 * basis: "takeover-fallback"). Paul's decision: land it FIRST (choice B),
 * then the operator arm O is its first live proof.
 *
 * What this suite fixes (house rule: strings ship with their pins):
 * - the EXACT delivered texts (both variants, marker prefix included —
 *   wording = pins; reword = rewrite these),
 * - the classification (Paul verbatim, 2026-10-03: outside input
 *   (user / outside agent) arms; extension-delivered steers and `[sam-`
 *   noise and blank text never; total + exact),
 * - the state machine (A/B variant selection incl. the stored-goal A-
 *   exclusion; once-per-event; re-input replacement; consumption; the
 *   adjust_goal-success clear),
 * - the ledger entry shape (same `sam-nudge` type; `trigger: "goal"` +
 *   variant; the D9 suppressed fields),
 * - the gate parity (the `SAM_NUDGE` family gate + `childEnv` — a spawn
 *   child never inherits the offer),
 * - the state integration (createSamState carries the fresh runtime).
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	GOAL_NUDGE_TEXTS,
	GOAL_NUDGE_VARIANTS,
	SAM_NOISE_PREFIX,
	armGoalOffer,
	clearGoalPending,
	consumeGoalOffer,
	createGoalNudgeState,
	goalNudgeLedgerEntry,
	goalNudgeText,
	isGoalUserInput,
} from "../src/goal-nudge.ts";
import { NUDGE_MARKER, NUDGE_LEDGER_CUSTOM_TYPE, childEnv, nudgeEnabled } from "../src/nudge.ts";
import { createSamState } from "../src/state.ts";
import { rebuildLedger } from "../src/ledger.ts";

// ── the texts (wording = pins — Paul 2026-10-03, surgical fixes only) ─────

test("the A text (sessionstart) is pinned byte-exact — Paul's 2026-10-03 wording, fixed", () => {
	assert.equal(
		GOAL_NUDGE_TEXTS.sessionstart,
		"[sam-nudge] As soon as you get an understanding of the current goal derived from user input and project status, " +
			"store this via adjust_goal. You can always adjust it mid-session, and re-read it to verify whether you're on track.",
	);
});

test("the B text (userinput) is pinned byte-exact — Paul's 2026-10-03 wording, fixed", () => {
	assert.equal(GOAL_NUDGE_TEXTS.userinput, "[sam-nudge] If the new input changes the shape of our current goal, you may update it via adjust_goal.");
});

test("every goal-offer text carries the F1 provenance marker (the battery readout classifies on it)", () => {
	for (const v of GOAL_NUDGE_VARIANTS) {
		assert.ok(GOAL_NUDGE_TEXTS[v].startsWith(NUDGE_MARKER + " "), `variant ${v} must start with "[sam-nudge] "`);
		assert.equal(goalNudgeText(v), GOAL_NUDGE_TEXTS[v], "goalNudgeText returns the pinned literal unchanged");
	}
});

test("the variant set is exactly the two variants (no third wording path)", () => {
	assert.deepEqual([...GOAL_NUDGE_VARIANTS], ["sessionstart", "userinput"]);
});

test("the SAM-noise prefix is the F4 convention ([sam-])", () => {
	assert.equal(SAM_NOISE_PREFIX, "[sam-");
});

// ── the classification (Paul verbatim, 2026-10-03; measured pi 0.87.1) ────

test("classification: outside input arms the offer (TUI user + outside agent / rpc)", () => {
	assert.equal(isGoalUserInput({ text: "find any discrepancies in the flotilla", source: "interactive" }), true);
	assert.equal(isGoalUserInput({ text: "run the consistency sweep across the 8 services", source: "rpc" }), true);
	assert.equal(isGoalUserInput({ text: "  trim me, please  ", source: "rpc" }), true, "surrounding whitespace is trimmed, then judged");
});

test("classification: extension-delivered input NEVER arms (Paul: not sam input which also rides steer)", () => {
	assert.equal(isGoalUserInput({ text: "close it now", source: "extension" }), false);
	assert.equal(
		isGoalUserInput({ text: "[sam-nudge] Context is at 62% of the window…", source: "extension" }),
		false,
		"a D7 steer (sendUserMessage ⇒ source extension, measured pi source) never arms",
	);
});

test("classification: the [sam-] guard is start-anchored (the F4 convention — defence in depth)", () => {
	assert.equal(isGoalUserInput({ text: "[sam-nudge] a reminder", source: "interactive" }), false);
	assert.equal(isGoalUserInput({ text: "[sam-audit] check this span", source: "rpc" }), false);
	assert.equal(
		isGoalUserInput({ text: "a real question about [sam- prefixes", source: "interactive" }),
		true,
		"the guard is start-anchored only — [sam- inside a real user question is still user input",
	);
});

test("classification: blank / whitespace-only input never arms", () => {
	assert.equal(isGoalUserInput({ text: "", source: "interactive" }), false);
	assert.equal(isGoalUserInput({ text: "   ", source: "rpc" }), false);
});

// ── the state machine (variant selection + once-per-event) ─────────────────

test("state machine: first outside input with NO stored goal ⇒ A (sessionstart)", () => {
	const st = createGoalNudgeState();
	assert.equal(armGoalOffer(st, { goalStored: false }), "sessionstart");
	assert.equal(st.pending, "sessionstart");
});

test("state machine: first outside input with a stored goal ⇒ B (the goal is known — the reminder)", () => {
	const st = createGoalNudgeState();
	assert.equal(armGoalOffer(st, { goalStored: true }), "userinput");
	assert.equal(st.pending, "userinput");
});

test("state machine: every LATER outside input ⇒ B (the short reminder)", () => {
	const st = createGoalNudgeState();
	armGoalOffer(st, { goalStored: false });
	assert.equal(armGoalOffer(st, { goalStored: false }), "userinput");
	// and B repeats per new event (the goal may be stored now — B is the
	// per-input reminder either way)
	consumeGoalOffer(st);
	assert.equal(armGoalOffer(st, { goalStored: true }), "userinput");
});

test("state machine: a re-input before the fire REPLACES the pending offer (latest event wins)", () => {
	const st = createGoalNudgeState();
	assert.equal(armGoalOffer(st, { goalStored: false }), "sessionstart");
	assert.equal(armGoalOffer(st, { goalStored: false }), "userinput", "the second event of the same session is B and replaces");
	assert.equal(st.pending, "userinput");
	assert.equal(st.userInputsSeen, 2);
});

test("state machine: consumption clears the event (once per event — no re-fire)", () => {
	const st = createGoalNudgeState();
	armGoalOffer(st, { goalStored: false });
	consumeGoalOffer(st);
	assert.equal(st.pending, null);
});

test("state machine: a successful adjust_goal clears the pending offer (the model acted)", () => {
	const st = createGoalNudgeState();
	armGoalOffer(st, { goalStored: false });
	assert.equal(st.pending, "sessionstart");
	clearGoalPending(st);
	assert.equal(st.pending, null, "the ask was answered — no offer; the goal record is the provenance");
});

// ── the ledger entry (F1 provenance; the arm-O O1 assert's class) ──────────

test("the ledger entry (fired): trigger goal + variant + deliverAs steer, no gap/zone fields", () => {
	const e = goalNudgeLedgerEntry({ variant: "userinput", now: 1_760_000_000_000 });
	assert.deepEqual(e, { trigger: "goal", variant: "userinput", at: 1_760_000_000_000, deliverAs: "steer" });
});

test("the ledger entry (suppressed): the D9 fields ride along (a suppressed decision leaves a trace)", () => {
	const s = goalNudgeLedgerEntry({ variant: "sessionstart", now: 1, suppressed: true, suppressReason: "audit-in-flight" });
	assert.equal(s.trigger, "goal");
	assert.equal(s.suppressed, true);
	assert.equal(s.suppressReason, "audit-in-flight");
	assert.equal(s.deliverAs, "steer");
	assert.equal("gapTokens" in s, false, "the goal class has NO context ruler (design note: no time, no ruler)");
});

// ── the gate parity (the nudge family = one switch; the child never inherits) ─

test("gate parity: the SAM_NUDGE family gate (DEFAULT ON; explicit off opts out D7 AND the goal offer)", () => {
	assert.equal(nudgeEnabled({}), true, "default on (Paul 2026-10-02 — the family shares the switch)");
	assert.equal(nudgeEnabled({ SAM_NUDGE: "off" }), false);
	assert.equal(nudgeEnabled({ SAM_NUDGE: "on" }), true, "non-off values stay on (the only opt-out is `off`)");
});

test("gate parity: childEnv forces SAM_NUDGE=off (a spawn child never inherits the goal offer)", () => {
	// the audit child's one-turn/zero-tool-call contract is untouched (scope
	// guard, design note §5): it boots with the whole nudge family off.
	assert.equal(childEnv({ SAM_NUDGE: "on" }).SAM_NUDGE, "off");
	assert.equal(childEnv({}).SAM_NUDGE, "off", "childEnv forces it even when unset (it OVERRIDES)");
});

// ── the state integration ──────────────────────────────────────────────────

test("state integration: createSamState carries a fresh goal-offer runtime (re-armed per session)", () => {
	const state = createSamState(rebuildLedger([]));
	assert.equal(state.goalNudge.pending, null);
	assert.equal(state.goalNudge.userInputsSeen, 0);
});

test("the ledger custom type for the goal offer is the SAM nudge type (the readout grades trigger + variant)", () => {
	assert.equal(NUDGE_LEDGER_CUSTOM_TYPE, "sam-nudge");
});

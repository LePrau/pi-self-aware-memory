/**
 * v0.0.4 FOLD (Paul 2026-10-14): the pure-core pins — the SAM_FOLD dial
 * (default ON), the tool surface + refusal texts (protocol strings ship
 * with their pinned tests), the sam-fold-ack text builder (every origin ×
 * takeover × estimated-after combination), the failure ack, and the state
 * integration (createSamState starts with no fold in flight, no deferred
 * ack). The GLUE (tool registration, the session_compact /
 * session_compact_failed listeners, the nudge hint) is pinned in
 * test/close-audit.test.ts + test/extension.test.ts + test/nudge.test.ts.
 *
 * Design note: src/fold.ts + dev-repo
 * `2026-10-14-eval-model-initiated-fold-after-close-unit.md`.
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	FOLD_ACK_CUSTOM_TYPE,
	FOLD_ACK_MARKER,
	FOLD_NOW_TOOL_ACTIVE,
	FOLD_NOW_PARAMS,
	FOLD_NOW_AUDIT_FORK_TEXT,
	FOLD_NOW_DISABLED_TEXT,
	FOLD_NOW_IN_FLIGHT_TEXT,
	FOLD_NOW_TRIGGERED_TEXT,
	foldAckText,
	foldAckChannel,
	foldEnabled,
	foldFailText,
	openTurnAtFold,
} from "../src/fold.ts";
import type { PlainEntry } from "../src/projection.ts";
import { FOLD_NUDGE_HINT, nudgeText } from "../src/nudge.ts";
import { rebuildLedger } from "../src/ledger.ts";
import { createSamState } from "../src/state.ts";

/* ── the SAM_FOLD dial (default ON — the opt-out is explicit `off`) ──────── */

test("foldEnabled: unset ⇒ ON (house practice: new behaviour behind a dial, default on like the nudge)", () => {
	assert.equal(foldEnabled({}), true);
});

test("foldEnabled: `on` ⇒ ON, `off` ⇒ OFF, garbage ⇒ ON (fail-safe to the default)", () => {
	assert.equal(foldEnabled({ SAM_FOLD: "on" }), true);
	assert.equal(foldEnabled({ SAM_FOLD: "off" }), false);
	assert.equal(foldEnabled({ SAM_FOLD: "Off " }), true);
	assert.equal(foldEnabled({ SAM_FOLD: "garbage" }), true);
});

/* ── the ack channel constants (byte-stable) ─────────────────────────────── */

test("the ack channel: custom type + marker are byte-stable", () => {
	assert.equal(FOLD_ACK_CUSTOM_TYPE, "sam-fold-ack");
	assert.equal(FOLD_ACK_MARKER, "[sam-fold-ack]");
});

/* ── the tool surface (protocol strings ship with their pins) ─────────────── */

test("fold_now tool surface: name/label/snippet/guidelines byte-stable; the description carries the contract lines", () => {
	assert.equal(FOLD_NOW_TOOL_ACTIVE.name, "fold_now");
	assert.equal(FOLD_NOW_TOOL_ACTIVE.label, "Fold the session context now");
	assert.equal(
		FOLD_NOW_TOOL_ACTIVE.promptSnippet,
		"fold_now — fold (compact) the session now, at a clean unit boundary; your turn ends, the next prompt starts with the compacted context + a sam-fold-ack",
	);
	assert.deepEqual(FOLD_NOW_TOOL_ACTIVE.promptGuidelines, [
		"Call fold_now right after a close_unit's audit settled — a settled close is a clean fold point even at low context consumption — make it the final action of your turn (your turn ends when it runs).",
		"Do not fold as the last act of a settling turn — if your answer is done and nothing else is pending, leave the fold to the first action after the next user interaction.",
		"Never call fold_now inside a SAM side-branch audit session, and never call it twice while a fold is in flight (wait for the sam-fold-ack).",
	]);
	// v0.0.37: the settled-turn fold guidance (Paul: the fold can be the first
	// action after the next user interaction instead):
	assert.match(FOLD_NOW_TOOL_ACTIVE.description, /Do not fold when you are about to settle/);
	// the F1 contract (the turn ends; the model never reads the tool result —
	// the ack rides the sam-fold-ack message):
	assert.match(FOLD_NOW_TOOL_ACTIVE.description, /ENDS YOUR CURRENT TURN/);
	assert.match(FOLD_NOW_TOOL_ACTIVE.description, /sam-fold-ack/);
	// v0.0.5 fold-resume: the ack restarts the turn (not "queued for the
	// next prompt"):
	assert.match(FOLD_NOW_TOOL_ACTIVE.description, /restarts your turn/);
	// the clean-boundary steering + the mid-unit ORPHANED tradeoff (F5):
	assert.match(FOLD_NOW_TOOL_ACTIVE.description, /clean unit boundary/);
	assert.match(FOLD_NOW_TOOL_ACTIVE.description, /ORPHANED/);
	// F3 single-flight, stated:
	assert.match(FOLD_NOW_TOOL_ACTIVE.description, /One fold at a time/);
	// the retention cut named (pi's keepRecentTokens default):
	assert.match(FOLD_NOW_TOOL_ACTIVE.description, /≤20,000-token retention tail/);
});

/* ── v0.0.37: the fold-ack channel (steer-when-continuing) ───────────────── */

test("foldAckChannel: the full matrix (idle appends; pending work steers; the native request-path fold steers; a settling run appends)", () => {
	// idle — the run is not active: always append (the model learns with the
	// next user input; nothing to steer into).
	assert.equal(foldAckChannel({ origin: "native", runActive: false, hasPending: false, openTurn: true }), "append");
	assert.equal(foldAckChannel({ origin: "user", runActive: false, hasPending: true, openTurn: true }), "append");
	// active + user-queued work: the run continues on the user's own messages
	// (pi's settle check counts them) — steer is safe for BOTH origins.
	assert.equal(foldAckChannel({ origin: "native", runActive: true, hasPending: true, openTurn: false }), "steer");
	assert.equal(foldAckChannel({ origin: "user", runActive: true, hasPending: true, openTurn: false }), "steer");
	// active, no pending work:
	//  - native request-path fold (open turn — the folded LLM request runs
	//    right after the fold) ⇒ steer (the model learns before the next act);
	assert.equal(foldAckChannel({ origin: "native", runActive: true, hasPending: false, openTurn: true }), "steer");
	//  - native post-run fold (the run would settle at :2084) ⇒ append — the
	//    2026-11-06 settled-model guard: no standalone SAM turn;
	assert.equal(foldAckChannel({ origin: "native", runActive: true, hasPending: false, openTurn: false }), "append");
	//  - user fold (prompt start / pre-send catch) ⇒ append either way (the
	//    user's own prompt carries the appended ack; pi's flow never depends
	//    on a SAM steer).
	assert.equal(foldAckChannel({ origin: "user", runActive: true, hasPending: false, openTurn: true }), "append");
	assert.equal(foldAckChannel({ origin: "user", runActive: true, hasPending: false, openTurn: false }), "append");
});

/* v0.0.37: the open-turn probe fixtures (PlainEntry shapes). */
const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x"):
	PlainEntry =>
	({ id, kind: "message", message: { role, content } }) as PlainEntry;
const comp = (id: string): PlainEntry =>
	({ id, kind: "compaction", summary: "takeover", firstKeptEntryId: "k" }) as PlainEntry;
const custom = (id: string, customType = "sam-close-unit"): PlainEntry =>
	({ id, kind: "custom", customType, data: {} }) as PlainEntry;
const customMessage = (id: string): PlainEntry =>
	({ id, kind: "custom_message", customType: "sam-fold-ack", content: "[sam-fold-ack] x", display: true }) as PlainEntry;

test("openTurnAtFold: success (the last MESSAGE before the compaction entry) and failure (the last entry) shapes", () => {
	// mid-turn fold: a toolResult right before the compaction entry ⇒ open.
	assert.equal(openTurnAtFold([msg("a", "assistant"), msg("b", "toolResult"), comp("c")], "c"), true);
	// MEASURED 2026-11-16 (the close-audit fixture branch): SAM's own custom
	// records interleave between the last toolResult and the compaction
	// entry — the walk skips them ⇒ still open.
	assert.equal(openTurnAtFold([msg("a", "assistant"), msg("b", "toolResult"), custom("d"), comp("c")], "c"), true);
	// an earlier fold's ack (a custom_message entry) interleaves too:
	assert.equal(openTurnAtFold([msg("a", "assistant"), msg("b", "toolResult"), customMessage("e"), comp("c")], "c"), true);
	// the walk stops at the last MESSAGE: an assistant before a custom ⇒ post-run ⇒ closed.
	assert.equal(openTurnAtFold([msg("a", "assistant"), custom("d"), comp("c")], "c"), false);
	// mid-turn FAILURE: no compaction entry — a toolResult at the branch end ⇒ open.
	assert.equal(openTurnAtFold([msg("a", "assistant"), msg("b", "toolResult")]), true);
	// post-run shapes (the fold landed after a settling assistant message) ⇒ closed:
	assert.equal(openTurnAtFold([msg("a", "assistant"), comp("b")], "b"), false);
	assert.equal(openTurnAtFold([msg("a", "assistant")]), false);
	// user messages are not an open turn either:
	assert.equal(openTurnAtFold([msg("a", "user"), comp("b")], "b"), false);
	// non-message predecessors are not an open turn:
	assert.equal(openTurnAtFold([comp("a")]), false);
	assert.equal(openTurnAtFold([comp("a"), msg("b", "toolResult")]), true); // last entry stands in
	// an ABSENT compaction id (malformed event — pi always appends the entry
	// before firing the event) ⇒ false (the safe default, the append channel):
	assert.equal(openTurnAtFold([msg("a", "assistant"), msg("b", "toolResult")], "missing"), false);
	// nothing before the compaction entry (idx 0) ⇒ false (the safe default):
	assert.equal(openTurnAtFold([comp("a")], "a"), false);
	// empty branch ⇒ false:
	assert.equal(openTurnAtFold([]), false);
	assert.equal(openTurnAtFold([], "a"), false);
});

test("fold_now parameters: the empty schema (no parameters)", () => {
	assert.deepEqual(FOLD_NOW_PARAMS, { type: "object", properties: {}, required: [] });
});

/* ── the refusal texts (byte-stable — the guard family's one-liners) ──────── */

test("F4 audit-fork refusal: byte-stable", () => {
	assert.equal(
		FOLD_NOW_AUDIT_FORK_TEXT,
		"This session is a SAM side-branch in progress: fold_now is not available here. Complete the instructed work as usual.",
	);
});

test("F3 in-flight refusal: byte-stable (waits for the ack, never aborts)", () => {
	assert.equal(
		FOLD_NOW_IN_FLIGHT_TEXT,
		"A fold is already in flight — wait for the sam-fold-ack message at the start of the next turn before folding again.",
	);
});

test("dial-off refusal: byte-stable (the native threshold fold still applies)", () => {
	assert.equal(
		FOLD_NOW_DISABLED_TEXT,
		"fold_now is disabled (SAM_FOLD=off) — pi's native threshold fold still applies.",
	);
});

test("triggered acknowledgement: byte-stable (transcript provenance; the model never reads it — F1)", () => {
	assert.equal(
		FOLD_NOW_TRIGGERED_TEXT,
		"Fold triggered — your turn ends now. The sam-fold-ack message reports the result " +
			"(tokens folded, the surviving summaries, the banked span) and restarts your turn with the compacted context.",
	);
});

/* ── the sam-fold-ack text (pure builder — every combination) ──────────────── */

test("foldAckText (model, takeover, exact estimated): the exact numbers ride the ack + the v0.0.5 resume line (model origin only)", () => {
	assert.equal(
		foldAckText({ origin: "model", tokensBefore: 90000, estimatedTokensAfter: 21000, fromExtension: true }),
		"[sam-fold-ack] Fold complete (your fold_now call) — 90,000 tokens folded; the context now holds " +
			"SAM's takeover summary (goal + settlement lines) + ≈ 21,000 tokens. " +
			"The settlement lines above are the surviving summaries; the raw span is banked (tombstone / sam_retrieve)." +
			" Your turn was compacted — resume the work from the settlement lines above (stop if the task is done).",
	);
});

test("foldAckText (user /compact, no estimated — the honest retention-tail phrase)", () => {
	assert.equal(
		foldAckText({ origin: "user", tokensBefore: 120000, estimatedTokensAfter: null, fromExtension: true }),
		"[sam-fold-ack] Fold complete (the /compact command) — 120,000 tokens folded; the context now holds " +
			"SAM's takeover summary (goal + settlement lines) + the ≤20,000-token retention tail. " +
			"The settlement lines above are the surviving summaries; the raw span is banked (tombstone / sam_retrieve).",
	);
});

test("foldAckText (native fold, takeover): pi's automatic fold named, exact tokensBefore", () => {
	assert.equal(
		foldAckText({ origin: "native", tokensBefore: 114700, estimatedTokensAfter: null, fromExtension: true }),
		"[sam-fold-ack] Fold complete (pi's automatic fold) — 114,700 tokens folded; the context now holds " +
			"SAM's takeover summary (goal + settlement lines) + the ≤20,000-token retention tail. " +
			"The settlement lines above are the surviving summaries; the raw span is banked (tombstone / sam_retrieve).",
	);
});

test("foldAckText (no takeover — F1 control arm: pi's own summary stands)", () => {
	const t = foldAckText({ origin: "native", tokensBefore: 40000, estimatedTokensAfter: null, fromExtension: false });
	assert.equal(
		t,
		"[sam-fold-ack] Fold complete (pi's automatic fold) — 40,000 tokens folded; the context now holds " +
			"the compaction summary + the ≤20,000-token retention tail. " +
			"The compaction summary above carries the surviving context; the raw span is banked (tombstone / sam_retrieve).",
	);
});

test("foldAckText (non-finite estimated): the NaN guard falls back to the honest phrase (never renders 'NaN')", () => {
	const t = foldAckText({ origin: "model", tokensBefore: 1000, estimatedTokensAfter: Number.NaN, fromExtension: true });
	assert.match(t, /the ≤20,000-token retention tail/);
	assert.ok(!t.includes("NaN"), "NaN must never reach the model");
});

/* ── the fold-failure ack (byte-stable) ────────────────────────────────────── */

test("foldFailText: names the error, states no state change, is an actionable resume (v0.0.5 — a model-initiated failure restarts the turn)", () => {
	assert.equal(
		foldFailText("Nothing to compact (session too small)"),
		"[sam-fold-ack] Fold FAILED — Nothing to compact (session too small) — no state change; the context is unchanged. " +
			"Your turn was aborted — resume the work: retry fold_now at a clean boundary, or continue from where you left off.",
	);
});

/* ── the nudge hint (the "context window is high" pointer, nudge.ts) ───────── */

test("FOLD_NUDGE_HINT: byte-stable v0.0.31 reword (option A, 2026-11-10) — NO leading newline (the standalone `fold` trigger carries it bare); names the clean point, OFFERS the fold, keeps the turn-ends contract", () => {
	assert.equal(
		FOLD_NUDGE_HINT(7),
		"Everything up to unit 7 is summarized in the settlement lines — a clean fold point: call fold_now if you want to fold (your turn ends; the next prompt starts with the post-compaction context and a sam-fold-ack).",
	);
});

test("nudgeText (band, with foldHint): the hint appends after the imminent-fold warning", () => {
	const t = nudgeText("band", { contextPercent: 76.4, foldHint: { unit: 3 } });
	assert.equal(
		t,
		"[sam-nudge] Context is at 76% of the window, climbing toward pi's compaction line. " +
			"If you have a checkable deliverable, or a substantial finding or question worth keeping, " +
			"close it now with close_unit, even if it is not finished completely (mark assumptions and leads as open, with their basis) — " +
			"otherwise continue only until your next checkable point, and close there. " +
			"Unmarked context may be lost at compaction." +
			"\nEverything up to unit 3 is summarized in the settlement lines — a clean fold point: call fold_now if you want to fold (your turn ends; the next prompt starts with the post-compaction context and a sam-fold-ack).",
	);
});

test("nudgeText (gap, with foldHint): the hint appends after the checkpoint advice", () => {
	const t = nudgeText("gap", { contextPercent: 52.1, foldHint: { unit: 12 } });
	assert.equal(
		t,
		"[sam-nudge] Context is at 52% of the window since your last close. " +
			"A close this early is a cheap checkpoint — a close with a larger unit later may not be. " +
			"If a checkable deliverable, finding, claim, or open question is ready, " +
			"close it now with close_unit (mark assumptions and leads as open, with their basis); " +
			"if not, continue — and close at the next checkable point." +
			"\nEverything up to unit 12 is summarized in the settlement lines — a clean fold point: call fold_now if you want to fold (your turn ends; the next prompt starts with the post-compaction context and a sam-fold-ack).",
	);
});

test("nudgeText (reasoning, with foldHint): the hint NEVER rides the reasoning nudge (not context-pressure)", () => {
	const t = nudgeText("reasoning", { foldHint: { unit: 3 } });
	assert.ok(!t.includes("fold_now"), "the reasoning nudge is untouched by the fold hint");
	assert.ok(!t.includes(FOLD_NUDGE_HINT(3)));
});

test("nudgeText (no foldHint): byte-identical to the pre-fold text (the existing pins stand)", () => {
	assert.equal(
		nudgeText("band", { contextPercent: 76.4 }),
		"[sam-nudge] Context is at 76% of the window, climbing toward pi's compaction line. " +
			"If you have a checkable deliverable, or a substantial finding or question worth keeping, " +
			"close it now with close_unit, even if it is not finished completely (mark assumptions and leads as open, with their basis) — " +
			"otherwise continue only until your next checkable point, and close there. " +
			"Unmarked context may be lost at compaction.",
	);
});

/* ── state integration (the fold runtime starts clean) ─────────────────────── */

test("state integration: createSamState starts with no fold in flight and no deferred ack", () => {
	const state = createSamState(rebuildLedger([]));
	assert.equal(state.foldInFlight, false);
	assert.equal(state.foldAckPending, null);
});

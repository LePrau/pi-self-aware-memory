/**
 * D7 mid-session nudge — the pure core (src/nudge.ts) and its pins.
 * FINAL SPEC 2026-10-02 (Paul; wording PROVISIONAL — his), INCLUDING the
 * same-day DESIGN CORRECTION: NO TIME IN ANY TRIGGER + the `reasoning`
 * class's ACTIVITY rulers (tool calls + thinking budget since the last
 * close / write / offer). Paul, verbatim core: "time for nudges is
 * irrelevant, time passed is dependant on tool calls and the inference
 * system used more than the actual progress a model makes… time is not a
 * good measure for llm work." Goal (verbatim): "long research and
 * reasoning turns result in more frequent checkpoints, so that even the
 * huge 'find any discrepancies' prompt has a chance of more than one close
 * in one context sized window."
 *
 * What this suite fixes (house rule: strings ship with their pins):
 * - the dial (DEFAULT ON; only `SAM_NUDGE=off` opts out),
 * - the hard guards (close-dial only, audit-in-flight, audit-fork),
 * - the ONE context ruler: `gap = ctx − baseline` (baseline = session
 *   start / after close / after settlement-less compaction), FLOOR
 *   20,000 (= pi's measured keepRecent default — NO override, NO dial),
 * - the `gap` class (≥ floor, any zone; ≤1 per stretch),
 * - the `band` class (in-band ∧ ≥ floor; ≤1 per stretch; urgency —
 *   "a second urgency nudge is allowed even if the earlier nudge still
 *   did not get a close_unit as answer", Paul verbatim; consumes the gap
 *   flag; the per-stretch flag IS the anti-spam — no cooldown),
 * - the in-band + below-floor silence (the 96k/105k case),
 * - the `reasoning` class with Paul's ACTIVITY rulers (NOT total context,
 *   NOT time, NOT zone): `toolCallsSinceReset ≥ 15` AND
 *   `thinkingSinceReset ≥ 5000` (dials `SAM_NUDGE_REASONING_CALLS` and
 *   `SAM_NUDGE_REASONING_CHARS`); reset points:
 *   close (stretch reset), write/edit (materialization), ANY nudge offer
 *   (soft checkpoint — re-crossing = more unmaterialized work);
 * - the NO-TIME shape (the runtime carries no time fields — pinned),
 * - the stretch resets + baseline re-stamp semantics (F3),
 * - the `childEnv` pin (spawn-children never inherit a live nudge),
 * - the EXACT current nudge texts (PROVISIONAL — Paul's wording is final;
 *   reword = rewrite these pins),
 * - the ledger entry shape (F1 provenance, incl. `gapTokens` + the D9
 *   `suppressed` fields),
 * - the state integration (createSamState carries the fresh runtime).
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	NUDGE_ENV,
	NUDGE_MARKER,
	NUDGE_LEDGER_CUSTOM_TYPE,
	NUDGE_GAP_TOKENS,
	DEFAULT_REASONING_CHARS,
	DEFAULT_REASONING_CALLS,
	MATERIALIZING_TOOLS,
	CHECKPOINT_TOOL,
	applyBaselineReset,
	applyNudgeFire,
	bumpActivity,
	childEnv,
	createNudgeRuntime,
	decideNudge,
	envInt,
	materializeReset,
	nudgeEnabled,
	nudgeLedgerEntry,
	nudgeText,
	reasoningCharsOf,
	resetNudgeStretch,
	type NudgeDecisionInput,
	type NudgeRuntime,
} from "../src/nudge.ts";
import { PI_DEFAULT_KEEP_RECENT_TOKENS } from "../src/gates.ts";
import { createSamState } from "../src/state.ts";
import { rebuildLedger } from "../src/ledger.ts";

const fresh = () => createNudgeRuntime();

/** A runtime with the ACTIVITY rulers at `calls`/`thinking` (bumped like
 *  the wiring does: real increments, not field hacks). */
const withActivity = (st: NudgeRuntime, calls: number, thinking: number): NudgeRuntime => {
	bumpActivity(st, { toolCall: true, thinkingChars: thinking });
	for (let i = 1; i < calls; i++) bumpActivity(st, { toolCall: true });
	return st;
};

const base = (over: Partial<NudgeDecisionInput> = {}): NudgeDecisionInput => ({
	enabled: true,
	closeDial: true,
	auditInFlight: false,
	auditFork: false,
	zone: "calm",
	st: fresh(),
	contextTokens: null,
	gapFloorTokens: NUDGE_GAP_TOKENS, // = 20,000
	toolCallFloor: DEFAULT_REASONING_CALLS, // = 15
	thinkingFloor: DEFAULT_REASONING_CHARS, // = 5000 (Paul, 2026-10-02: 5k ≈ 2–3 medium turns or one big turn; the budget is incremental)
	...over,
});

/** A stretch with `st` whose baseline is `baseline` (fresh or advanced). */
const withBaseline = (baseline: number, st = fresh()) => {
	st.baselineTokens = baseline;
	return st;
};

/* ── NO-TIME shape pin (the 2026-10-02 design correction) ───────────────── */

test("shape: the runtime carries NO time fields — triggers act on context position + unmaterialized work (Paul, 2026-10-02: time is not a measure of LLM work)", () => {
	const st = fresh();
	assert.deepEqual(
		Object.keys(st).sort(),
		["baselineTokens", "firedBand", "firedGap", "lastFireTrigger", "pendingBaselineReset", "thinkingSinceReset", "toolCallsSinceReset"],
	);
	// and the decision input has no clock:
	// (checked by compilation — NudgeDecisionInput has no `now` since the
	// design correction; this pin keeps the runtime's surface stable.)
	assert.equal(st.toolCallsSinceReset, 0);
	assert.equal(st.thinkingSinceReset, 0);
});

test("materializeReset: zeroing both activity rulers is the unit of a reset (close / write / offer all reuse it)", () => {
	const st = withActivity(fresh(), 30, 8000);
	materializeReset(st);
	assert.equal(st.toolCallsSinceReset, 0);
	assert.equal(st.thinkingSinceReset, 0);
});

/* ── dial + guards ───────────────────────────────────────────────────────── */

test("dial default ON (Paul, 2026-10-02): only an explicit `off` opts out", () => {
	assert.equal(nudgeEnabled({}), true); // default ON
	assert.equal(nudgeEnabled({ [NUDGE_ENV]: "off" }), false); // explicit opt-out
	assert.equal(nudgeEnabled({ [NUDGE_ENV]: "on" }), true);
	const st = withActivity(fresh(), 20, 9000);
	const d = decideNudge(base({ enabled: false, zone: "watch", contextTokens: 40_000, st }));
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "dial-off");
});

test("guard: the v3 dials never nudge (the control arms stay byte-stable)", () => {
	const st = withActivity(fresh(), 20, 9000);
	const d = decideNudge(base({ closeDial: false, zone: "action", contextTokens: 120_000, st }));
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "not-close-dial");
});

test("guard: a close-audit in flight never nudges (guards beat both trigger classes)", () => {
	const st = withActivity(fresh(), 20, 9000);
	const d = decideNudge(base({ auditInFlight: true, zone: "watch", contextTokens: 120_000, st }));
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "audit-in-flight");
});

test("guard: an audit side-session never nudges", () => {
	const st = withActivity(fresh(), 20, 9000);
	const d = decideNudge(base({ auditFork: true, zone: "watch", contextTokens: 120_000, st }));
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "audit-fork");
});

/* ── the gap class ───────────────────────────────────────────────────────── */

test("gap class: fires at EXACTLY the 20k floor (Paul's absolute lower bound), any zone", () => {
	const d = decideNudge(base({ contextTokens: 20_000, zone: "calm" }));
	assert.equal(d.fire, true);
	if (d.fire === true) {
		assert.equal(d.trigger, "gap");
		assert.equal(d.why, "gap-reached (gap=20000, floor=20000)");
	}
});

test("gap class: measures since the LAST CLOSE (baseline), not absolute ctx", () => {
	// close at 50k, 20,001 tokens of new work ⇒ fire
	let d = decideNudge(base({ contextTokens: 70_001, st: withBaseline(50_000) }));
	assert.equal(d.fire, true);
	if (d.fire === true) assert.equal(d.trigger, "gap");
	// close at 50k, 19,999 tokens of new work ⇒ below the floor ⇒ silence
	d = decideNudge(base({ contextTokens: 69_999, st: withBaseline(50_000) }));
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "below-gap");
});

test("gap class: below the floor never fires (20k is Paul's absolute lower bound — retained-window yardstick + KV headroom; the P4 32k-fail bank carries the KV root cause, design note header)", () => {
	const d = decideNudge(base({ contextTokens: 19_999 }));
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "below-gap");
});

test("gap class: ONE nudge per stretch — a second stretch observation stays silent (the per-stretch flag is the anti-spam; NO time is involved — 2026-10-02 correction)", () => {
	const st = fresh();
	let d = decideNudge(base({ contextTokens: 25_000, st }));
	assert.equal(d.fire, true);
	applyNudgeFire(st, "gap");
	d = decideNudge(base({ contextTokens: 30_000, st })); // no close in between, no clock to wait for
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "gap-already-fired");
});

/* ── the band class (urgency) ────────────────────────────────────────────── */

test("band class: in-band with the gap over the floor fires (the fold-point rule)", () => {
	const d = decideNudge(base({ zone: "watch", contextTokens: 100_000, st: withBaseline(20_000) }));
	assert.equal(d.fire, true);
	if (d.fire === true) {
		assert.equal(d.trigger, "band");
		assert.match(d.why, /^band-pressure \(zone=watch, gap=80000, floor=20000\)$/);
	}
});

test("band class: `action` (at/over the native line) is in-band and fires", () => {
	const d = decideNudge(base({ zone: "action", contextTokens: 115_000, st: withBaseline(20_000) }));
	assert.equal(d.fire, true);
	if (d.fire === true) assert.equal(d.trigger, "band");
});

test("band class: PAUL'S RULE — allowed even though the earlier gap nudge went unanswered (no clock between them — 2026-10-02 correction)", () => {
	const st = fresh();
	// the gap nudge fired and the model has NOT closed:
	let d = decideNudge(base({ contextTokens: 21_000, st }));
	assert.equal(d.fire, true);
	if (d.fire === true) assert.equal(d.trigger, "gap");
	applyNudgeFire(st, "gap");
	// …context climbed straight into the band without a close ⇒ the urgency fires anyway:
	d = decideNudge(base({ zone: "watch", contextTokens: 100_000, st }));
	assert.equal(d.fire, true);
	if (d.fire === true) assert.equal(d.trigger, "band");
});

test("band class: ONE per stretch — a later in-band observation stays silent", () => {
	const st = fresh();
	const d = decideNudge(base({ zone: "watch", contextTokens: 100_000, st }));
	assert.equal(d.fire, true);
	applyNudgeFire(st, "band");
	const again = decideNudge(base({ zone: "action", contextTokens: 112_000, st }));
	assert.equal(again.fire, false);
	if (again.fire === false) assert.equal(again.why, "band-already-fired");
});

test("band class: IN BAND but the gap under the floor ⇒ SILENCE (the 96k/105k case: the unclosed tail of 9k fits the retained window — nothing at risk)", () => {
	// window 131,072 (the test slot); last close at 96k; ctx 105k = in the band
	// (watch ≥ 98,304); gap = 9,000 < 20,000.
	const d = decideNudge(base({ zone: "watch", contextTokens: 105_000, st: withBaseline(96_000) }));
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "below-gap");
});

/* ── stretch resets (close / settlement-less compaction) ─────────────────── */

test("stretch reset: close re-arms — the activity rulers are paid off too (Paul's goal: more checkpoints in one context window)", () => {
	const st = withActivity(fresh(), 40, 30_000);
	resetNudgeStretch(st);
	assert.equal(st.firedGap, false);
	assert.equal(st.firedBand, false);
	assert.equal(st.pendingBaselineReset, true);
	assert.equal(st.toolCallsSinceReset, 0, "the close paid off the tool-call meter");
	assert.equal(st.thinkingSinceReset, 0, "the close paid off the thinking budget");
	// the first observation of the new stretch stamps the baseline (gap 0 ⇒ silent this tick):
	assert.equal(applyBaselineReset(st, 90_000), 90_000);
	assert.equal(st.pendingBaselineReset, false);
});

test("stretch reset: a settlement-less compaction restarts from the post-compact view (the MEASURED ref-run cycle shape)", () => {
	const st = fresh();
	applyNudgeFire(st, "gap");
	resetNudgeStretch(st);
	// the post-compact context (measured ref-run value: dropped to ~41.9k) re-stamps the baseline:
	applyBaselineReset(st, 41_862);
	assert.equal(st.baselineTokens, 41_862);
	const d = decideNudge(base({ contextTokens: 41_862, st })); // first tick: gap 0
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "below-gap");
});

test("baseline re-stamp: a missing ruler keeps the reset PENDING (F3 — never drop it, never fabricate)", () => {
	const st = fresh();
	resetNudgeStretch(st);
	assert.equal(applyBaselineReset(st, null), null);
	assert.equal(st.pendingBaselineReset, true); // still pending
	assert.equal(st.baselineTokens, 0); // unchanged
	applyBaselineReset(st, 12_345);
	assert.equal(st.pendingBaselineReset, false);
	assert.equal(st.baselineTokens, 12_345);
});

test("baseline re-stamp: idempotent without a pending reset", () => {
	const st = fresh();
	st.baselineTokens = 50_000;
	assert.equal(applyBaselineReset(st, 999), 999);
	assert.equal(st.baselineTokens, 50_000); // untouched
});

/* ── the reasoning class: Paul's ACTIVITY rulers (2026-10-02) ────────────── */

test("reasoning class: BOTH floors crossed ⇒ fire — no ctx ruler needed (F3), no zone, NO time", () => {
	const st = withActivity(fresh(), 15, 5000);
	const d = decideNudge(base({ zone: "calm", contextTokens: null, st }));
	assert.equal(d.fire, true);
	if (d.fire === true) {
		assert.equal(d.trigger, "reasoning");
		assert.equal(d.why, "activity (calls=15≥15, thinking=5000≥5000)");
	}
});

test("reasoning class: ONE floor short on either ruler ⇒ silence (the AND gate: calls without reasoning = no findings; reasoning without research = nothing to evict)", () => {
	let st = withActivity(fresh(), DEFAULT_REASONING_CALLS - 1, 99_999);
	let d = decideNudge(base({ contextTokens: null, st }));
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "no-context-ruler"); // closest named class

	st = withActivity(fresh(), 99_999, DEFAULT_REASONING_CHARS - 1);
	d = decideNudge(base({ contextTokens: null, st }));
	assert.equal(d.fire, false);

	// ruler present but under the gap floor: same silence (both activity
	// floors short — the reasoning class is ctx-INDEPENDENT, so a crossed
	// pair fires even with the gap below the floor — that is the point of
	// the activity rulers: the ruler is work, not position)
	st = withActivity(fresh(), 10, 1000);
	d = decideNudge(base({ contextTokens: 5_000, st }));
	assert.equal(d.fire, false);
	if (d.fire === false) assert.equal(d.why, "below-gap");
	// …and the crossed pair under the same below-gap ruler DOES fire (F3
	// independence — pinned, the inverse case):
	st = withActivity(fresh(), 30, 5000);
	d = decideNudge(base({ contextTokens: 5_000, st }));
	assert.equal(d.fire, true, "activity rulers crossed ⇒ fire even with the gap below the floor");
	if (d.fire === true) assert.equal(d.trigger, "reasoning");
});

test("reasoning class: accumulates over the stretch — medium turns cross a 5k budget (Paul: 5k \"grants 2 or 3 medium reasoning turns, or a big one\" — the budget is incremental, so medium blocks add up)", () => {
	const st = fresh();
	for (let i = 0; i < 14; i++) bumpActivity(st, { toolCall: true });      // 14 research calls
	bumpActivity(st, { thinkingChars: 3000 });                              // first medium turn…
	let d = decideNudge(base({ contextTokens: null, st }));
	assert.equal(d.fire, false, "14 calls + 3000 chars: below BOTH floors");
	bumpActivity(st, { toolCall: true });                                    // 15th call
	bumpActivity(st, { thinkingChars: 2500 });                               // …+ the following turn
	d = decideNudge(base({ contextTokens: null, st }));
	assert.equal(d.fire, true, "15 calls + 5500 chars (two medium turns): both floors crossed");
	if (d.fire === true) assert.equal(d.trigger, "reasoning");
});

test("reasoning class: a write/edit MATERIALIZATION resets the ladder (Paul: \"a writing tool call should probably reset the reasoning-counter\" — extended to both rulers, labelled)", () => {
	assert.deepEqual([...MATERIALIZING_TOOLS], ["write", "edit"]); // the file-mutating tools (pi v0.87.1)
	const st = withActivity(fresh(), 25, 8000);
	materializeReset(st); // the wiring's materialization path (write/edit toolResult)
	const d = decideNudge(base({ contextTokens: null, st }));
	assert.equal(d.fire, false, "the ladder is zeroed — the findings are on disk, the meter starts over");
	assert.equal(st.firedBand, false, "a write is NOT a close: the stretch flags are untouched");
	assert.equal(CHECKPOINT_TOOL, "close_unit");
});

test("reasoning class: a NUDGE OFFER re-arms the ladder (soft checkpoint — re-crossing means more unmaterialized work; my extension, vetoable)", () => {
	const st = withActivity(fresh(), 20, 5000);
	let d = decideNudge(base({ contextTokens: null, st }));
	assert.equal(d.fire, true);
	applyNudgeFire(st, "reasoning"); // the wiring records the fire (no timestamp — NO time anywhere)
	assert.equal(st.toolCallsSinceReset, 0, "the offer paid off the meter");
	assert.equal(st.thinkingSinceReset, 0);
	assert.equal(st.lastFireTrigger, "reasoning");
	d = decideNudge(base({ contextTokens: null, st }));
	assert.equal(d.fire, false, "the very next observation is silent until the floors re-cross");
	// …and when the floors re-cross (long research turns — Paul's goal: MORE
	// than one checkpoint per context-sized window), it fires again:
	bumpActivity(st, { toolCall: true, thinkingChars: 3000 }); // one medium turn
	for (let i = 0; i < 14; i++) bumpActivity(st, { toolCall: true });
	bumpActivity(st, { thinkingChars: 2500 }); // the following turn
	d = decideNudge(base({ contextTokens: null, st }));
	assert.equal(d.fire, true, "the second offer — frequency ∝ unmaterialized work, not a clock");
});

/* ── precedence + ruler absence ──────────────────────────────────────────── */

test("precedence: urgency (`band`) beats the early class AND `reasoning` when all candidates hold", () => {
	const st = withActivity(fresh(), 20, 9000);
	const d = decideNudge(base({ zone: "action", contextTokens: 110_000, st }));
	assert.equal(d.fire, true);
	if (d.fire === true) assert.equal(d.trigger, "band");
});

test("precedence: `gap` beats `reasoning` when the gap floor is crossed (zone calm)", () => {
	const st = withActivity(fresh(), 20, 9000);
	const d = decideNudge(base({ zone: "calm", contextTokens: 25_000, st }));
	assert.equal(d.fire, true);
	if (d.fire === true) assert.equal(d.trigger, "gap");
});

test("ruler absent (ctx unknown): `gap`/`band` suspend, `reasoning` still fires (F3: never fabricate a ruler)", () => {
	const st = withActivity(fresh(), 15, 5000);
	const d = decideNudge(base({ zone: "action", contextTokens: null, st }));
	assert.equal(d.fire, true);
	if (d.fire === true) assert.equal(d.trigger, "reasoning");
});

/* ── measurement helpers + wiring ────────────────────────────────────────── */

test("reasoningCharsOf: sums thinking blocks only (kvllama `usage.reasoning` is always 0 — measured)", () => {
	const content = [
		{ type: "thinking", thinking: "ab" },
		{ type: "text", text: "should not count" },
		{ type: "toolCall" },
		{ type: "thinking", thinking: "cde" },
		{ type: "thinking" },
	];
	assert.equal(reasoningCharsOf(content), 5);
	assert.equal(reasoningCharsOf([]), 0);
	assert.equal(reasoningCharsOf(null), 0);
	assert.equal(reasoningCharsOf(undefined), 0);
});

test("bumpActivity: the pure accumulator (tool calls + thinking chars; zero/undefined are no-ops)", () => {
	const st = fresh();
	bumpActivity(st, { toolCall: true, thinkingChars: 300 });
	bumpActivity(st, { toolCall: true });
	bumpActivity(st, { thinkingChars: 200 });
	bumpActivity(st, {}); // no-op
	bumpActivity(st, { thinkingChars: 0 }); // no-op
	assert.equal(st.toolCallsSinceReset, 2);
	assert.equal(st.thinkingSinceReset, 500);
});

test("envInt: strict positive integers, anything else falls back (the dials never crash the session)", () => {
	assert.equal(envInt({ X: "42" }, "X", 10), 42);
	assert.equal(envInt({ X: "0" }, "X", 10), 10);
	assert.equal(envInt({ X: "-5" }, "X", 10), 10);
	assert.equal(envInt({ X: "1.5" }, "X", 10), 10);
	assert.equal(envInt({ X: "" }, "X", 10), 10);
	assert.equal(envInt({}, "X", 10), 10);
	assert.equal(envInt({ X: "3600000" }, "X", 10), 3_600_000);
});

test("childEnv: spawn-children get SAM_NUDGE=off forced; the other dials pass through", () => {
	const out = childEnv({
		[NUDGE_ENV]: "on",
		SAM_AUDIT_DELIVERY: "close",
		SAM_AUDIT_TIMEOUT_MS: "1800000",
		PATH: "/x",
	});
	assert.equal(out[NUDGE_ENV], "off");
	assert.equal(out["SAM_AUDIT_DELIVERY"], "close");
	assert.equal(out["SAM_AUDIT_TIMEOUT_MS"], "1800000");
	assert.equal(out["PATH"], "/x");
	// and from a bare env (the parent never set the dial):
	assert.equal(childEnv({})[NUDGE_ENV], "off");
});

/* ── texts (EXACT — PROVISIONAL until Paul's wording; reword = rewrite here) ── */

test("nudgeText (band): marker first, the % fact, the IMMINENT-FOLD warning, category (b) included — exact text", () => {
	const t = nudgeText("band", { contextPercent: 76.4 });
	assert.equal(
		t,
		"[sam-nudge] Context is at 76% of the window, climbing toward pi's compaction line. " +
			"If you have a checkable deliverable, or a substantial finding or question worth keeping, " +
			"close it now with close_unit (mark assumptions and leads as open, with their basis) — " +
			"unmarked context may be lost at compaction; otherwise just continue.",
	);
	assert.ok(t.startsWith(NUDGE_MARKER));
	assert.ok(t.includes("climbing toward pi's compaction line")); // the urgency warning
	assert.ok(t.includes("mark assumptions and leads as open, with their basis"));
	assert.ok(t.includes("close_unit"));
});

test("nudgeText (band, percent unknown): the unknown-share branch — exact text", () => {
	const t = nudgeText("band", { contextPercent: null });
	assert.equal(
		t,
		"[sam-nudge] Context is at an unknown share of the window, climbing toward pi's compaction line. " +
			"If you have a checkable deliverable, or a substantial finding or question worth keeping, " +
			"close it now with close_unit (mark assumptions and leads as open, with their basis) — " +
			"unmarked context may be lost at compaction; otherwise just continue.",
	);
});

test("nudgeText (gap): the CURRENT CONTEXT is included (Paul, 2026-10-02) + the early-checkpoint reason — exact text", () => {
	const t = nudgeText("gap", { contextPercent: 16.7 });
	assert.equal(
		t,
		"[sam-nudge] Context is at 17% of the window. It's been a while since your last close. " +
			"If a checkable deliverable is done — or there's a substantial finding, claim, or open question worth keeping — " +
			"close it now with close_unit (mark assumptions and leads as open, with their basis). " +
			"A close this early is a cheap checkpoint: the audit runs on a small, still-fast context; " +
			"a close this late may not be. Otherwise just continue.",
	);
	assert.ok(t.startsWith(NUDGE_MARKER));
	assert.ok(t.includes("Context is at 17% of the window")); // the current context
	assert.ok(t.includes("mark assumptions and leads as open, with their basis"));
	assert.ok(t.includes("close_unit"));
	assert.ok(!t.includes("compaction line"), "the early nudge must NOT carry the urgency warning");
});

test("nudgeText (gap, percent unknown): the unknown-share branch", () => {
	const t = nudgeText("gap", { contextPercent: null });
	assert.ok(t.startsWith("[sam-nudge] Context is at an unknown share of the window. It's been a while since your last close. "));
});

test("nudgeText (reasoning): Paul's shortened form (2026-10-02: the beginning + the question + the raw-reads note; the long version RETRACTED) — exact text", () => {
	const t = nudgeText("reasoning", {});
	assert.equal(
		t,
		"[sam-nudge] A lot of tool calls and a fair amount of reasoning have passed since the last checkpoint — " +
			"maybe we can already close some findings? A close would let the raw tool reads drop out of " +
			"compaction; otherwise just continue.",
	);
	assert.ok(t.startsWith(NUDGE_MARKER));
	assert.ok(t.includes("maybe we can already close some findings?"), "Paul's phrasing: a question, verbatim");
	assert.ok(t.includes("let the raw tool reads drop out of"), "the note: raw tool reads out of compaction");
});

/* ── ledger + state ───────────────────────────────────────────────────────── */

test("nudgeLedgerEntry: the F1 provenance shape incl. gapTokens (the session entry the readout keys on)", () => {
	const e = nudgeLedgerEntry({ trigger: "band", now: 42, zone: "watch", tokens: 100_000, contextWindow: 131_072, gapTokens: 80_000, reasoningChars: 120 });
	assert.deepEqual(e, {
		trigger: "band",
		at: 42,
		zone: "watch",
		tokens: 100_000,
		contextWindow: 131_072,
		gapTokens: 80_000,
		reasoningChars: 120,
		deliverAs: "steer",
	});
	assert.equal(NUDGE_LEDGER_CUSTOM_TYPE, "sam-nudge");
	// undefined window/gap → null (the entry must stay plain JSON for the session file)
	const e2 = nudgeLedgerEntry({ trigger: "reasoning", now: 1, zone: "calm", tokens: null, contextWindow: undefined, gapTokens: undefined, reasoningChars: 0 });
	assert.equal(e2.contextWindow, null);
	assert.equal(e2.gapTokens, null);
	// D9: the suppressed shape (ARM-4b carries the would-fire case end-to-end)
	const e3 = nudgeLedgerEntry({ trigger: "reasoning", now: 2, zone: "watch", tokens: 90_000, contextWindow: 131_072, gapTokens: 10_000, reasoningChars: 40, suppressed: true, suppressReason: "audit-in-flight", suppressDetail: "activity (...)" });
	assert.equal(e3.suppressed, true);
	assert.equal(e3.suppressReason, "audit-in-flight");
});

test("state integration: createSamState carries a fresh nudge runtime (re-armed per session)", () => {
	const state = createSamState(rebuildLedger([]));
	assert.deepEqual(state.nudge, createNudgeRuntime());
});

test("applyNudgeFire: `reasoning` fires set NO gap/band flag; `band` consumes BOTH (urgency supersedes); `gap` sets one; EVERY offer re-arms the activity ladder (NO timestamp argument — the 2026-10-02 correction)", () => {
	let st = withActivity(fresh(), 15, 5000);
	applyNudgeFire(st, "reasoning");
	assert.equal(st.lastFireTrigger, "reasoning");
	assert.equal(st.firedGap, false);
	assert.equal(st.firedBand, false);
	assert.equal(st.toolCallsSinceReset, 0, "the offer paid off the meter");
	assert.equal(st.thinkingSinceReset, 0);

	st = withActivity(fresh(), 15, 5000);
	applyNudgeFire(st, "gap");
	assert.equal(st.firedGap, true);
	assert.equal(st.firedBand, false);
	assert.equal(st.lastFireTrigger, "gap");
	assert.equal(st.toolCallsSinceReset, 0);

	st = withActivity(fresh(), 15, 5000);
	applyNudgeFire(st, "band");
	assert.equal(st.firedBand, true);
	assert.equal(st.firedGap, true); // consumed — the spam guard
	assert.equal(st.lastFireTrigger, "band");
	assert.equal(st.thinkingSinceReset, 0);
});

test("defaults: the shipped constants are the measured ones (floor = pi's keepRecent default; activity floors from the run-02 measurement; marker + env name)", () => {
	assert.equal(NUDGE_GAP_TOKENS, 20_000);
	assert.equal(NUDGE_GAP_TOKENS, PI_DEFAULT_KEEP_RECENT_TOKENS); // the floor IS pi's measured keepRecent default (no override — Paul, 2026-10-02)
	assert.equal(DEFAULT_REASONING_CHARS, 5000); // thinking floor (Paul, 2026-10-02: 5k ≈ 2–3 medium turns or one big turn — settled ref run: 14 blocks ≥ 5k chars, 24 ≥ 2.5k, max 13,589)
	assert.equal(DEFAULT_REASONING_CALLS, 15); // tool-call floor (run-02 stretches: 22 / 20 calls)
	assert.deepEqual([...MATERIALIZING_TOOLS], ["write", "edit"]); // file mutations = materialization (Paul's write-reset)
	assert.equal(CHECKPOINT_TOOL, "close_unit");
	assert.equal(NUDGE_MARKER, "[sam-nudge]");
	assert.equal(NUDGE_ENV, "SAM_NUDGE");
});

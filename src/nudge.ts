/**
 * D7 — mid-session nudge (v4-plan §7; this header is the design note).
 * FINAL SE 2026-10-02 (Paul's spec + confirmations; wording still PROVISIONAL — Paul's).
 *
 * **Problem (measured, 2026-10-01):** two live close-dial runs — the settled
 * reference run (W = 131,072: FOUR pi-base compactions across the native line
 * W−R, closes only at 109,732 / 89,139 ctx = 83.7% / 67.9% of W, the first
 * compactions inside the measured loss window `b10975|b11058|…` re-probe /
 * DS213j) and `sam-small-units` (operator-stopped at 82%, mid-collection, NO
 * self-close) — show the same behavior: the model works through the whole
 * collection/patch phase and closes at the END (or not at all). Static prompt
 * wording does not change the work ORDERING (read-all → write-all → one
 * natural completion point; the S7/S7.1 wording still has no live supporter).
 *
 * **Survival model (the thing the nudge protects against) — measured/sources,
 * 2026-10-02:**
 * - Channel A (settlement lines): distance-INDEPENDENT — the takeover
 *   (`session_before_compact` handler, index.ts) pulls settlement custom
 *   entries from the whole branch it is compacting; the ref-run u1 line rode
 *   compaction #4 verbatim (bank `main-242.jsonl` entry 205:
 *   `details.sam.u1`, summary tail "SAM settlement(s) … preserved verbatim").
 *   Caveat: that live case also had the close INSIDE the kept tail, so
 *   distance-independence is code-verified, not proven by that live rep.
 *   A DEFERRED audit (no settlement) makes the takeover bail to the native
 *   path — then even a "closed" stub survives only via channel B/C.
 * - Channel B (raw kept tail): pi keeps a ≥ 20k-token tail (settings
 *   `compaction.keepRecentTokens`, default 20,000 — pi v0.87.1 source,
 *   settings-manager.ts / compaction.ts cut-point walk; message-boundary
 *   aligned) in BOTH takeover and native compaction (the takeover returns pi's
 *   `firstKeptEntryId`). Measured in the ref-run compaction #4:
 *   `tokensBefore` 115,754, `firstKeptEntryId` at position 88,117 ⇒
 *   **27.6k kept**. pi v0.87.1 docs + source: default 20k, overridable —
 *   we do NOT override it (Paul, 2026-10-02).
 * - Channel C (retrieval): `details.sam` map + summary pointer + the
 *   `sam-tombstones/tombstone-<firstKeptEntryId>.jsonl` full-branch bank.
 * ⇒ the at-risk part at any fold = the **unclosed tail beyond the kept
 *   window**; "close now" converts work into settlement (A) and shrinks
 *   that tail.
 *
 * **Spec (Paul, 2026-10-02 — both classes share ONE ruler, the gap since the
 * last close; floor = the measured keepRecent default; NO override, NO dial):**
 *
 * `gap = ctx − baseline`. Baseline = session start (0), then re-stamped after
 * every successful `close_unit` and after every settlement-less compaction
 * (a loss event is a fresh stretch — the nudge "since the last close" clock
 * restarts). Nudges may only fire once `gap ≥ NUDGE_GAP_TOKENS`:
 *
 * | class    | condition                                   | fire policy                          |
 * |---       |---                                          |---                                   |
 * | `gap`    | `gap ≥ 20,000` (any zone)                   | ≤1 per stretch                        |
 * | `band`   | zone `watch`/`action` AND `gap ≥ 20,000`    | ≤1 per stretch (NOT an extra gate — "a second urgency nudge is allowed even if the earlier nudge still did not get a close_unit as answer" (Paul, verbatim); a band fire also consumes the gap flag of the stretch (the urgency supersedes it)) |
 * | `reasoning` | `toolCallsSinceReset ≥ 15` **AND** `thinkingSinceReset ≥ 5000` (Paul's ACTIVITY rulers, 2026-10-02; NO zone dependence, NO time) | re-armed after every fire / materialization — the frequency is proportional to the UNMATERIALIZED work (Paul's goal: "long research and reasoning turns result in more frequent checkpoints") |
 *
 * Floor rationale — 20k is Paul's ABSOLUTE LOWER BOUND (confirmed, 2026-10-02),
 * with two converging readings:
 * (1) the nudge rule itself: the retained window is the yardstick of what
 *     survives a fold (channel B) — a nudge below it anchors less than one
 *     retained window and is noise;
 * (2) the AUDITED CLOSE needs KV headroom — Paul's root cause of the 32k
 *     failure (his words, 2026-10-02): "the auditor failed because it tried
 *     to audit when kv was close to 32k context and failed because there was
 *     simply not much kv left". The banked pair (P4 armA @ registered 32,768 —
 *     audit stage FAILED, `report.md`: "no [sam-audit] user message", "verdict=
 *     undefined"; P5 armE @ 49,152 — 18/18 flawless) is that FAILURE MODE with
 *     this root cause. Nudging early (20k of new context) is exactly where KV
 *     headroom is maximal — the floor and the low-KV goal coincide.
 *     RETRACTION (2026-10-02, house rule): an earlier draft of this note read
 *     the P4 pair as a model-capability floor ("a sub-20k unit targets an
 *     audit case the model demonstrably cannot do") — Paul's KV root cause
 *     supersedes that reading; it is corrected here and in all shipped docs.
 *     ⇒ at a 42k window the floor degenerates (by design) to ONE nudge per
 *     stretch, at ~78% — the floor and the fold point coincide.
 *
 * Consequence in a healthy session (the "perfect scenario" property): if the
 * model closes at least every 20k of work, `gap` never reaches the floor ⇒
 * NO nudge ever fires; and at any fold the unclosed tail ≤ 20k ⇒ inside the
 * kept window (channel B) ⇒ nothing at risk. The nudges exist only for the
 * model that loses itself in a loop — exactly D7's purpose.
 *
 * **Mechanism (unchanged from the 2026-10-01 code-prep, still measured pi
 * 0.87.1):** evaluated per assistant `message_end` (a MEASURED decision
 * point — after the message, before the next LLM call); delivery ONE
 * `pi.sendUserMessage(text, { deliverAs: "steer" })` — streaming ⇒
 * steer-queue delivered after the current tool calls, BEFORE the next call
 * (zero extra model call by itself); idle ⇒ one short turn the model can act
 * on (close, or a brief continue). The nudge is a user message: visible to
 * the LLM AND in the session file.
 *
 * **Dials (house pattern):** `SAM_NUDGE` **DEFAULT ON** (Paul, 2026-10-02:
 * "nudge mode should be on by default"); the only opt-out is `SAM_NUDGE=off`;
 * active only under the v4 `close` dial (v3 dials stay byte-stable control
 * arms). ACTIVITY floors (dials, strict-int): `SAM_NUDGE_REASONING_CALLS`
 * (default 15 — measured: run-02's stretches are 22/20 calls; Paul: "tool count
 * seems fine as a start") and `SAM_NUDGE_REASONING_CHARS` (default 5000 —
 * Paul: "I suggest taking 5k, that grants 2 or 3 medium reasoning turns, or a
 * big one"; settled ref-run distribution: 24 blocks ≥ 2.5k, 14 ≥ 5k, max
 * 13,589 chars; the budget is incremental over the stretch). `NUDGE_GAP_TOKENS` is a CONSTANT (= 20,000, pi's
 * measured keepRecent default) — intentionally NOT a dial (Paul, 2026-10-02).
 * (Superseded 2026-10-02: `SAM_NUDGE_COOLDOWN_MS` — time is out of the
 * triggers, see the design correction below.)
 *
 * **DESIGN CORRECTION — NO TIME IN ANY TRIGGER (Paul, 2026-10-02, verbatim
 * core):** "we will never use actual time passed for our triggers if the
 * events they trigger are not time-related. time for nudges is irrelevant,
 * time passed is dependant on tool calls and the inference system used more
 * than the actual progress a model makes. only context size, amount of tool
 * calls, produced token[s], and maybe size of reasoning blocks should be
 * considered, time is not a good measure for llm work." Consequences:
 * - the 5-minute COOLDOWNS are gone from BOTH `gap` and `reasoning` (the
 *   per-stretch flags remain — activity-boundary, not time);
 * - `reasoning` gets its OWN rulers (not total context — Paul): a
 *   TOOL-CALL counter + a THINKING-CHARS budget since the last reset point,
 *   and it fires when BOTH cross their floors:
 *   "a reasoning nudge should happen after a significant amount of tool
 *   calls, especially after large tool calls and reasoning thereafter";
 * - `close_unit`, `write`, `edit` are RESET points, not counted (the close is
 *   the checkpoint; the write materializes the findings to disk — "a writing
 *   tool call should probably reset the reasoning-counter", Paul; extended to
 *   BOTH counters — my extension, vetoable); every other tool call
 *   (including failed ones — work and context were spent) increments the
 *   counter, and each assistant thinking block adds to the thinking budget;
 * - a NUDGE FIRE re-arms the counters (soft checkpoint: the ask was offered;
 *   re-crossing them means more unmaterialized work — my extension, vetoable:
 *   it is what makes long research turns yield MORE than one checkpoint in a
 *   context-sized window, Paul's stated goal);
 * - the surviving `at` field on the ledger entry is a provenance RECORD
 *   (F1), never a gate.
 * Wording (PROVISIONAL — Paul's style request, verbatim): "the nudge should
 * be more subtle, in the style of 'a lot of tool calls have passed, maybe we
 * can already close some findings'."
 *
 * **Hard guards (each pinned):** never while the close-audit is in flight
 * (D9 — the old `pendingCloses` co-guard was REMOVED 2026-10-02: it had been
 * silently swallowing every decision through run-02's ~36-min in-band
 * window, no trace — now only audit-in-flight/audit-fork suppress, and a
 * suppressed decision is LOGGED); never inside an audit-side session
 * (`lineIsAuditFork`), never on the v3 dials; the spawned prepare/audit
 * children are spawned with `SAM_NUDGE=off` forced (`childEnv` — they
 * inherit `process.env` by construction); a missing context ruler
 * (`getContextUsage()` without tokens) suspends `gap`/`band` (F3: the
 * governor never fabricates a ruler) — `reasoning` stays independent.
 *
 * **Known simplification (labelled, 2026-10-02):** on a RESUMED session the
 * baseline is 0 ⇒ `gap = current ctx` (the ledger's last-close position is
 * not re-derived into the runtime). Conservative direction (nudges more
 * likely, never less); a misfire costs one "continue". Battery + dry run
 * exercise fresh sessions; revisit if live reads flag it.
 *
 * **Provenance (F1 discipline):** the text starts with `NUDGE_MARKER`
 * ("[sam-nudge]" — model-visible AND in the session file), each nudge also
 * appends a `sam-nudge` CUSTOM ENTRY (not LLM-bound) carrying the class, the
 * gap, the zone and the ctx — the battery readout separates
 * self-partition from nudge-assisted; the operator gets an `emit()` note.
 *
 * **Text: PROVISIONAL — Paul owns the prompt wording (division of labor);
 * per the house rule the pins carry the exact current text — reword =
 * rewrite the pins (test/nudge.test.ts).**
 *
 * **Paul's goal (2026-10-02, verbatim):** "my goal is that long research and
 * reasoning turns result in more frequent checkpoints, so that even the huge
 * 'find any discrepancies' prompt has a chance of more than one close in one
 * context sized window". Measured support (run-02, bank `66cdd7b`): 70.5 %
 * of the message chars were tool results (reads alone 51.2 %, bash 19.2 %);
 * the close→fold stretch was 20 calls + 56,247 thinking chars with ZERO
 * checkpoints — exactly the shape this design re-arms.
 *
 * **Owed before any battery rep (D1 lesson — unit green ≠ process proof):**
 * a live dry run that a real steer/turn delivery reaches the model and a
 * `close_unit` answers it, covering `gap` and `band`, gated per F1.
 */
import { PI_DEFAULT_KEEP_RECENT_TOKENS } from "./gates.ts";
import type { Zone } from "./governor.ts";

export const NUDGE_ENV = "SAM_NUDGE";
export const NUDGE_MARKER = "[sam-nudge]";
export const NUDGE_LEDGER_CUSTOM_TYPE = "sam-nudge";

/** The gap floor — pi's measured keepRecent default (v0.87.1; the raw kept
 *  tail of every compaction, takeover and native). A CONSTANT by decision
 *  (Paul, 2026-10-02: no override, no dial) — it IS the "retain window" of
 *  the nudge rule (header: the 20k absolute lower bound — retained window +
 *  KV headroom — Paul's KV root cause on the P4/P5 pair supersedes the
 *  earlier capability-floor reading; retraction on record in the header). */
export const NUDGE_GAP_TOKENS = PI_DEFAULT_KEEP_RECENT_TOKENS; // = 20,000

export const DEFAULT_REASONING_CHARS = 5000; // the THINKING floor (Paul, 2026-10-02: "I suggest taking 5k, that grants 2 or 3 medium reasoning turns, or a big one" — settled ref run: 24 blocks ≥ 2.5k chars, 14 ≥ 5k, max 13,589; the budget is INCREMENTAL over the stretch, so 5k ≈ exactly that statement)
export const DEFAULT_REASONING_CALLS = 15; // the TOOL-CALL floor (Paul: "tool count seems fine as a start"); measured: run-02's two stretches are 22 and 20 calls (tool results = 70.5% of message chars)

/** Paul, 2026-10-02: the file-MUTATING tools are materialization points —
 *  the findings are on disk (auditable, re-derivable), so the long tool
 *  results may be discarded after the findings are made; the checkpoint
 *  meter starts over. `bash`/`read` etc. are the RESEARCH side (they
 *  accumulate the context the nudge protects). `close_unit` is the
 *  checkpoint itself (stretch reset). */
export const MATERIALIZING_TOOLS: readonly string[] = ["write", "edit"]; // pi v0.87.1 tool names (dist/core/tools/{write,edit})
export const CHECKPOINT_TOOL = "close_unit";

export type NudgeTrigger = "gap" | "band" | "reasoning";

/**
 * Nudge runtime bookkeeping (in SamState; rebuilt fresh per session — the
 * session file's own `sam-nudge` entries are the durable provenance).
 * NO TIME FIELDS (Paul, 2026-10-02): the triggers act on context position
 * and on unmaterialized WORK (calls + thinking since the last reset) —
 * "time is not a good measure for llm work"; the only timestamps anywhere
 * in this module are the ledger's `at` provenance records, never gates.
 */
export interface NudgeRuntime {
	/** Class of the last fire (ledger/readout aid only — never a gate). */
	lastFireTrigger: NudgeTrigger | null;
	/** The `gap` class already fired in the current stretch. */
	firedGap: boolean;
	/** The `band` class already fired in the current stretch. */
	firedBand: boolean;
	/** ctx-token baseline of the current stretch: session start (0), then
	 *  re-stamped after every close / settlement-less compaction. */
	baselineTokens: number;
	/** A stretch reset (close / settlement-less compaction) awaits the next
	 *  observed ctx: it then becomes the new baseline (fresh stretch). */
	pendingBaselineReset: boolean;
	/** ACTIVITY ruler (the `reasoning` class, Paul 2026-10-02): tool calls
	 *  since the last reset point (close / write-edit materialization / any
	 *  nudge fire) — the "significant amount of tool calls" meter. */
	toolCallsSinceReset: number;
	/** ACTIVITY ruler: THINKING chars since the last reset point — the
	 *  "reasoning thereafter" budget. Accumulates over the stretch. */
	thinkingSinceReset: number;
}

export function createNudgeRuntime(): NudgeRuntime {
	return {
		lastFireTrigger: null,
		firedGap: false,
		firedBand: false,
		baselineTokens: 0,
		pendingBaselineReset: false,
		toolCallsSinceReset: 0,
		thinkingSinceReset: 0,
	};
}

/* ── dials / env ─────────────────────────────────────────────────────────── */

export function nudgeEnabled(env: Record<string, string | undefined>): boolean {
	// D7 dial semantics — DEFAULT ON (Paul, 2026-10-02): the nudge is part
	// of the v4 `close`-dial behavior, not an opt-in experiment; the ONLY
	// opt-out is explicit `SAM_NUDGE=off`. (The nudge still activates only
	// under the `close` audit-delivery dial — v3 dials stay byte-stable
	// control arms, so this flip changes nothing on them.)
	return env[NUDGE_ENV] !== "off";
}

/** Strict int env reader (auditTimeoutMs precedent, closeaudit.ts): a value
 *  that is not a positive finite integer falls back — the dials never crash
 *  the session (F1). */
export function envInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
	const raw = env[key];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
	return n;
}

/** Force `SAM_NUDGE=off` for spawn-children (they inherit process.env by
 *  construction — the audit child's WHOLE job is one verdict line, never a
 *  nudge conversation). Other dials (audit delivery, timeout) pass through.
 *  Signature = node's `spawn` env shape (`string | undefined` values). */
export function childEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
	return { ...base, [NUDGE_ENV]: "off" };
}

/* ── measurement ─────────────────────────────────────────────────────────── */

/** Summed THINKING chars of a message content block array (the "big
 *  reasoning block" ruler — usage.reasoning is 0 on kvllama, measured). */
export function reasoningCharsOf(content: readonly { type: string; thinking?: string }[] | null | undefined): number {
	let n = 0;
	for (const b of content ?? []) {
		if (b.type === "thinking" && typeof b.thinking === "string") n += b.thinking.length;
	}
	return n;
}

/* ── stretch bookkeeping (pure mutations of NudgeRuntime) ───────────────── */

/** A stretch reset: a successful close_unit OR a settlement-less compaction.
 *  Both fired-flags clear (a close re-arms both; a loss event restarts the
 *  clock — "no close within the last X context" is measured from the
 *  post-compact view, which is exactly the fresh unclosed context). The
 *  baseline re-stamp happens at the NEXT observed ctx (applyBaselineReset) —
 *  the first observation of the new stretch defines where it starts. */
export function resetNudgeStretch(st: NudgeRuntime): void {
	st.firedGap = false;
	st.firedBand = false;
	st.pendingBaselineReset = true;
	materializeReset(st);
}

/** A MATERIALIZATION (Paul, 2026-10-02): the findings have reached disk via
 *  a `write`/`edit` — "a writing tool call should probably reset the
 *  reasoning-counter" (extended to BOTH activity counters — the extension is
 *  labelled in the design note; vetoable). The long tool results that
 *  preceded it become the evictable tail; the checkpoint meter starts over.
 *  (The stretch flags + baseline are untouched — a write is not a close, and
 *  the context position did not change.) */
export function materializeReset(st: NudgeRuntime): void {
	st.toolCallsSinceReset = 0;
	st.thinkingSinceReset = 0;
}

/** Bump the ACTIVITY rulers (pure, for the pins): one tool call (the
 *  research side) and/or `chars` more thinking. Accumulating over the
 *  stretch is the counter's job; deciding is `decideNudge`'s. */
export function bumpActivity(st: NudgeRuntime, over: { toolCall?: boolean; thinkingChars?: number } = {}): void {
	if (over.toolCall) st.toolCallsSinceReset += 1;
	if (over.thinkingChars) st.thinkingSinceReset += over.thinkingChars;
}

/** Stamp the new stretch baseline when a reset is pending and a ctx ruler
 *  exists. Pure/idempotent: without a pending reset it is a no-op; with a
 *  missing ruler the reset stays pending for the next observation (F3 —
 *  never fabricate a ruler, and never drop the pending reset). */
export function applyBaselineReset(st: NudgeRuntime, contextTokens: number | null): number | null {
	if (!st.pendingBaselineReset) return contextTokens;
	if (contextTokens === null) return null; // keep the reset pending
	st.baselineTokens = contextTokens;
	st.pendingBaselineReset = false;
	return contextTokens;
}

/** Record a fired nudge (wiring bookkeeping; kept pure for the pin). A
 *  `band` fire ALSO sets the gap flag of the stretch: the urgency supersedes
 *  the early nudge — the "close since the last close" ask has been delivered
 *  with the highest-priority wording, and the gap class must not re-fire on
 *  the very next observation (spam guard). */
export function applyNudgeFire(st: NudgeRuntime, trigger: NudgeTrigger): void {
	st.lastFireTrigger = trigger;
	if (trigger === "band") {
		st.firedBand = true;
		st.firedGap = true;
	} else if (trigger === "gap") st.firedGap = true;
	materializeReset(st);
}

/* ── decision ────────────────────────────────────────────────────────────── */

export interface NudgeDecisionInput {
	/** SAM_NUDGE enabled (DEFAULT ON; `off` = opt-out — wiring pre-checks;
	 *  re-checked here for the pure total). */
	enabled: boolean;
	/** the v4 `close` dial is active (wiring pre-checks; re-checked here). */
	closeDial: boolean;
	/** a close-audit is in flight (hard guard). */
	auditInFlight: boolean;
	/** this session is an audit side-session (hard guard). */
	auditFork: boolean;
	zone: Zone;
	/** the runtime CARRIES the activity rulers (Paul, 2026-10-02 — the
	 *  counters live on the stretch, not on the per-message decision). */
	st: NudgeRuntime;
	/** current ctx tokens; null = no ruler available (gap/band suspend — F3). */
	contextTokens: number | null;
	/** the gap floor (NUDGE_GAP_TOKENS by default; injectable for the pin). */
	gapFloorTokens: number;
	/** ACTIVITY floors (dials `SAM_NUDGE_REASONING_CALLS` /
	 *  `SAM_NUDGE_REASONING_CHARS`; injectable for the pin). NO TIME anywhere
	 *  in this type — Paul, 2026-10-02: time is not a measure of LLM work. */
	toolCallFloor: number;
	thinkingFloor: number;
}

export type NudgeDecision =
	| {
			fire: false;
			why:
				| "dial-off"
				| "not-close-dial"
				| "audit-in-flight"
				| "audit-fork"
				| "no-context-ruler"
				| "below-gap"
				| "gap-already-fired"
				| "band-already-fired";
			trigger?: never;
	  }
	| { fire: true; trigger: NudgeTrigger; why: string };

export function decideNudge(i: NudgeDecisionInput): NudgeDecision {
	if (!i.enabled) return { fire: false, why: "dial-off" };
	if (!i.closeDial) return { fire: false, why: "not-close-dial" };
	if (i.auditInFlight) return { fire: false, why: "audit-in-flight" };
	if (i.auditFork) return { fire: false, why: "audit-fork" };
	const inBand = i.zone === "watch" || i.zone === "action";
	if (i.contextTokens !== null) {
		const gap = Math.max(0, i.contextTokens - i.st.baselineTokens);
		if (gap >= i.gapFloorTokens) {
			if (inBand) {
				// urgency: one per stretch (the per-stretch flag IS the anti-spam
				// — NO time is involved; Paul, 2026-10-02).
				if (!i.st.firedBand)
					return { fire: true, trigger: "band", why: `band-pressure (zone=${i.zone}, gap=${gap}, floor=${i.gapFloorTokens})` };
				return { fire: false, why: "band-already-fired" };
			}
			if (!i.st.firedGap) return { fire: true, trigger: "gap", why: `gap-reached (gap=${gap}, floor=${i.gapFloorTokens})` };
			return { fire: false, why: "gap-already-fired" };
		}
		// (in band but gap < floor: the unclosed tail fits inside the kept
		//  window — channels A+B cover it — silence is the correct call; the
		//  decision falls through to the activity class below.)
	}
	// `reasoning` class — Paul's ACTIVITY rulers (2026-10-02): its own
	// counters, not total context, not time, not zone. A significant amount
	// of tool calls AND reasoning thereafter (both floors crossed since the
	// last close / write / nudge offer) — "a lot of tool calls have passed,
	// maybe we can already close some findings".
	if (i.st.toolCallsSinceReset >= i.toolCallFloor && i.st.thinkingSinceReset >= i.thinkingFloor) {
		return {
			fire: true,
			trigger: "reasoning",
			why: `activity (calls=${i.st.toolCallsSinceReset}≥${i.toolCallFloor}, thinking=${i.st.thinkingSinceReset}≥${i.thinkingFloor})`,
		};
	}
	// no class fired: the gap was below the floor (ruler present), or there
	// was no ruler at all (F3 — the governor never fabricates a ruler), and
	// the activity rulers have not crossed their floors yet.
	if (i.contextTokens !== null) return { fire: false, why: "below-gap" };
	return { fire: false, why: "no-context-ruler" };
}

/* ── text + ledger (PROVISIONAL — Paul's wording is the final one;
 *    reword = rewrite the test/nudge.test.ts pins, house rule) ──────────── */

/** The nudge the model reads. LIGHT by design: one state fact + one
 *  preserved decision (close the closable now, or continue) + the short
 *  reason. BOTH the `gap` and `band` variants carry the current context
 *  share when known (usage-backed; "an unknown share" branch) — Paul,
 *  2026-10-02: the current context is in the nudge, EXCEPT that the urgency
 *  call additionally carries the warning that a fold is imminent.
 *  `band` is that urgency variant (the fold-point rule: last close farther
 *  than the retained window, near the fold line → "climbing toward pi's
 *  compaction line" is the imminence warning). `gap` is the early-
 *  checkpoint variant (close while the audit fork is still small and fast).
 *  Both are aligned to the S7.1 unit categories (a substantial finding/
 *  question is closable too — mark assumptions and leads as open). */
export function nudgeText(trigger: NudgeTrigger, facts: { contextPercent?: number | null }): string {
	const p = facts.contextPercent;
	const pct = typeof p === "number" && Number.isFinite(p) ? `${Math.round(p)}%` : "an unknown share";
	if (trigger === "band") {
		return (
			NUDGE_MARKER +
			` Context is at ${pct} of the window, climbing toward pi's compaction line. ` +
			"If you have a checkable deliverable, or a substantial finding or question worth keeping, " +
			"close it now with close_unit (mark assumptions and leads as open, with their basis) — " +
			"unmarked context may be lost at compaction; otherwise just continue."
		);
	}
	if (trigger === "gap") {
		return (
			NUDGE_MARKER +
			` Context is at ${pct} of the window. It's been a while since your last close. ` +
			"If a checkable deliverable is done — or there's a substantial finding, claim, or open question worth keeping — " +
			"close it now with close_unit (mark assumptions and leads as open, with their basis). " +
			"A close this early is a cheap checkpoint: the audit runs on a small, still-fast context; " +
			"a close this late may not be. Otherwise just continue."
		);
	}
	return (
		NUDGE_MARKER +
		" A lot of tool calls and a fair amount of reasoning have passed since the last checkpoint — " +
		"maybe we can already close some findings? A close would let the raw tool reads drop out of " +
		"compaction; otherwise just continue."
	);
}

/** The `sam-nudge` custom entry (session provenance; NOT sent to the LLM).
 * D9 (2026-10-02): a SUPPRESSED decision (a nudge that would have fired
 * while a hard guard held — audit-in-flight / audit-fork) is logged here
 * with `suppressed: true` + the guard reason + the would-be trigger —
 * F1: a suppressed decision must leave a trace (the run-02 incident's
 * ~36-min blind in-band window left none; that is the gap this closes).
 * "Below threshold" / "already fired" / "cooldown" stays unlogged (it is
 * a decision not to act, not a suppression). */
export interface SamNudgeLedgerEntry {
	trigger: NudgeTrigger;
	at: number;
	zone: Zone;
	tokens: number | null;
	contextWindow: number | null;
	/** ctx − baseline at the fire (the stretch's unclosed gap). */
	gapTokens: number | null;
	reasoningChars: number;
	deliverAs: "steer";
	/** D9: true when the decision was suppressed by a hard guard (not sent). */
	suppressed?: boolean;
	/** D9: the guard that suppressed it ("audit-in-flight" | "audit-fork"). */
	suppressReason?: "audit-in-flight" | "audit-fork";
	/** D9: the suppressed decision's reason string (decideNudge `why`). */
	suppressDetail?: string;
}

export function nudgeLedgerEntry(f: {
	trigger: NudgeTrigger;
	now: number;
	zone: Zone;
	tokens: number | null;
	contextWindow: number | null | undefined;
	gapTokens: number | null | undefined;
	reasoningChars: number;
	suppressed?: boolean;
	suppressReason?: "audit-in-flight" | "audit-fork";
	suppressDetail?: string;
}): SamNudgeLedgerEntry {
	return {
		trigger: f.trigger,
		at: f.now,
		zone: f.zone,
		tokens: f.tokens,
		contextWindow: f.contextWindow ?? null,
		gapTokens: f.gapTokens ?? null,
		reasoningChars: f.reasoningChars,
		deliverAs: "steer",
		...(f.suppressed ? { suppressed: true, suppressReason: f.suppressReason, suppressDetail: f.suppressDetail } : {}),
	};
}

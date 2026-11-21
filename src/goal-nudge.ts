/**
 * D11b — the goal-clarification nudge (decided + landed 2026-10-03; design
 * note: dev-repo `2026-10-03-v4-goal-clarification-nudge.md`; wording is
 * Paul's, with the surgical fixes he delegated — the note lists them).
 *
 * **What it is:** one soft offer PER OUTSIDE USER-INPUT EVENT, asking the model
 * to store/refresh the goal (`adjust_goal`) — at the moment the goal becomes
 * (re)clear. It fires at the model's FIRST assistant message after the input
 * ("after user input and the first agent turn … only after the first agent
 * invocation, before the second round" — Paul, 2026-10-03) and is delivered in
 * the D7 steering channel (`[sam-nudge]` marker + `deliverAs: "steer"`).
 *
 * **Paul's classification, verbatim (2026-10-03):** "outside input, mostly from
 * users (or an outside agent) are what should trigger the goal nudge. tool
 * calls, and automatically generated steers from within the TUI session itself
 * should never trigger that." — plus the earlier turn's "not sam input which
 * also rides steer, mind you!". Realized on pi 0.87.1's `input` event
 * (measured source, dist/core/agent-session.js:1547-1575): `sendUserMessage()`
 * routes to `prompt(..., source: "extension")`; the TUI is `interactive`; the
 * RPC/harness channel is `rpc`; tool calls never fire `input` at all. So:
 *
 * | input                                                              | triggers? |
 * |---|---|
 * | TUI user (incl. a mid-turn operator steer) — `interactive`         | YES |
 * | harness / outside agent (battery RPC stages) — `rpc`              | YES |
 * | extension-delivered (D7 nudges, the goal offers, audit steers)     | NO |
 * | any text starting with `[sam-` (F4 convention — extension noise)   | NO (any source; defence in depth) |
 * | blank / whitespace-only text                                       | NO |
 *
 * The marker rule closes the self-trigger loop structurally: a goal offer is a
 * `[sam-nudge]` steer, so it can never arm the next goal-reminder event.
 *
 * **Firing (decided 2026-10-03, amended 2026-10-04):** armed at the `input`
 * event; consumed by the FIRST assistant `message_end` after the arm; once
 * per event (a NEW outside input is a NEW event; a re-input before the fire
 * replaces — latest event wins). Waivers (2026-10-04, Paul — the user may
 * refine the goal mid-run, even right after the model's own update, so the
 * UPDATE-CHECK is unconditional):
 * - `sessionstart` (A, the setup ask) is waived by a successful `adjust_goal`
 *   or a goal stored at fire time (the ask was answered — the goal record is
 *   the provenance);
 * - `userinput` (B, the update check) is waived by NOTHING — it fires on
 *   every outside user input whether or not a goal is stored or the model
 *   already updated it ("a user input should always fire the check-whether-
 *   to-update-the-goal nudge" — Paul, 2026-10-04);
 * - `close` (2026-10-04, Paul: "every time on close, until the model at
 *   least called adjust_goal once") — fired directly after an ACCEPTED
 *   close_unit call (new-unit and re-audit paths) while NO goal record
 *   exists on the branch; the file-derived record is the anchor (resume-
 *   proof), so once the model stores a goal the offer retires forever.
 *   By design it fires although the close's own audit may still be settling
 *   (the audit child is offer-free via childEnv — the family gate is off in
 *   spawn children). Suppressed (logged, D9 pattern) for B/A while a
 *   close-audit is in flight or the line is an audit fork (the `close`
 *   variant is exempt — the close IS the settlement moment). Gates (reused — NO new dial): the v4 `close`
 * dial + the `SAM_NUDGE` family gate (DEFAULT ON; `off` opts out D7 AND this —
 * `childEnv` forces it off in spawn children, so an audit child never sees an
 * offer). NO time, NO context ruler (2026-10-02 rule: "time is not a good
 * measure for llm work").
 *
 * **Provenance (F1):** the delivered text carries `NUDGE_MARKER` (the battery
 * readout classifies on it), and every offer — fired or suppressed — rides the
 * `sam-nudge` ledger custom type as `trigger: "goal"` + the variant (the arm-O
 * O1 assert grades this class by those fields — no gap-floor / zone clause
 * applies to `goal`).
 *
 * Scope guard (design note §5): D7 (`gap`/`band`/`reasoning`), the D11 goal
 * machinery (tools, latest-wins, the fold-time fallback, the takeover gate),
 * the `close_unit` contract and the audit dispatch are ALL untouched — this
 * module only reminds. Wording = pins (house rule): `GOAL_NUDGE_TEXTS` below
 * are the exact delivered strings; reword = rewrite the pins.
 */
import { NUDGE_MARKER } from "./nudge.ts";

export const GOAL_NUDGE_VARIANTS = ["sessionstart", "userinput", "close"] as const;
export type GoalNudgeVariant = (typeof GOAL_NUDGE_VARIANTS)[number];

/** The texts the model reads (WORDING = PINS — Paul's 2026-10-03 originals,
 *  surgical fixes only; the design note lists each fix). The delivered
 *  string = these literals, verbatim (marker prefix included). */
export const GOAL_NUDGE_TEXTS: Record<GoalNudgeVariant, string> = {
	/** A — the session's first outside user input, only when no goal is stored yet. */
	sessionstart:
		"[sam-nudge] As soon as you get an understanding of the current goal derived from user input and project status, " +
		"store this via adjust_goal. You can always adjust it mid-session, and re-read it to verify whether you're on track.",
	/** B — every other outside user input (the short reminder — the
	 *  UNCONDITIONAL update check, 2026-10-04). */
	userinput: "[sam-nudge] If the new input changes the shape of our current goal, you may update it via adjust_goal.",
	/** C — directly after an accepted close while no goal has ever been
	 *  stored (2026-10-04, Paul's exact wording: "you did not explicitly set
	 *  a goal yet, consider doing that with adjust_goal now"). */
	close:
		"[sam-nudge] You have not yet set an explicit goal. Consider doing that with adjust_goal.",
};

/** The F4 extension-noise prefix (goal.ts:116 convention: a `[sam-`-prefixed
 *  injection is extension noise, never user input). */
export const SAM_NOISE_PREFIX = "[sam-";

/** Paul's classification (2026-10-03, verbatim — header) as a pure total.
 *  `source` is pi 0.87.1's `InputEvent.source` (`"interactive" | "rpc" |
 *  "extension"`). */
export function isGoalUserInput(input: { text: string; source: string }): boolean {
	if (input.source === "extension") return false; // automatically generated within the session
	const t = (input.text ?? "").trim();
	if (t === "") return false;
	if (t.startsWith(SAM_NOISE_PREFIX)) return false; // extension noise (any delivery path)
	return true;
}

/**
 * Option 2 (WISHLIST 2026-11-20, Paul's ack ruling — "the ack message should
 *  always override any other steering aside from real user input"): a goal
 *  offer HELD at fire time because pi's auto-compaction was imminent (a steer
 *  queued then would land behind the fold ack — the measured 2026-11-20
 *  incident). The hold defers the release until the arming input has
 *  PROVABLY landed (the next message_end with a changed lastReal) or the
 *  agent run ends (nothing landed ⇒ invalidate — the arming input was edited
 *  away). The release-time check runs AFTER every queued steer of the run has
 *  drained, so it is definitive (the 162ms watermark-stamp race of the
 *  incident cannot replay: the stamp at hold time captures lastReal as it
 *  stood at fire time, and the release re-runs the comparison with the
 *  landed reality). `armedAt` (the input event's epoch-ms, recorded at the
 *  arm) is the arming identity — a queued steer that lands (even with its
 *  text edited in transit) is recognized by the ABSENCE of a newer arm
 *  (currentArmedAt === hold.armedAt), not by text match. */
export interface HeldGoalOffer {
	/** The pending variant at the hold. */
	variant: GoalNudgeVariant;
	/** The exact offer text (goalNudgeText(variant) — wording pins). */
	text: string;
	/** The arming input event's epoch-ms (the arm point's identity). */
	armedAt: number;
	/** The hold's epoch-ms (ledger provenance). */
	heldAt: number;
	/** The branch's last real user message AT THE HOLD (identity snapshot —
	 *  entry ids survive compaction; indices do not, so the release compares
	 *  by id when both sides carry one, by index only when neither does —
	 *  the goalNudgeLanding pattern). Null = no real user message on the
	 *  branch at the hold (any landed one is a change). */
	lastRealAtHold: { index: number; id?: string } | null;
}

/** Per-session runtime (in SamState; fresh per session — a resumed session
 *  has its own first invocation, so its first outside input may carry the
 *  `sessionstart` variant when no goal is stored yet). */
export interface GoalNudgeState {
	/** The offer pending for the current outside user-input event, or null. */
	pending: GoalNudgeVariant | null;
	/** Option 2 (2026-11-20): the arming input event's epoch-ms (recorded by
	 *  `armGoalOffer`; null if the arm predates the record — treated as
	 *  "no newer arm"-undecidable ⇒ supersede on release, the safe side).
	 *  Never a gate on its own — only the hold-release comparison reads it. */
	armedAt: number | null;
	/** Option 2 (2026-11-20): the offer held for the imminent compaction, or
	 *  null (the pending offer is the live one; at most one is held at a time
	 *  — a re-arm while held overwrites `pending`, never `heldOffer`). */
	heldOffer: HeldGoalOffer | null;
	/** Outside user inputs observed in the running session (the FIRST one
	 *  may carry the `sessionstart` variant — see `armGoalOffer`). */
	userInputsSeen: number;
	/** Bug A (Paul 2026-10-14): the last real user message COVERED by an
	 *  offer consumption (fire, suppression, invalidation, or a successful
	 *  adjust_goal waiver of the setup ask) — the fire-time landing check
	 *  (`goalNudgeLanding`) requires a NEWER real user message, so an offer
	 *  armed by an input event that never landed (a queued steer edited
	 *  away) is invalidated instead of fired. Null = nothing covered yet
	 *  (fresh session; any landed real user message is new). */
	lastCoveredRealUser: { index: number; id?: string } | null;
	/** Bug B (Paul 2026-10-14): the ONE-SHOT WAIVER — set by a successful
	 *  adjust_goal, it silently retires the NEXT `userinput` (update-check)
	 *  offer at fire time (moot: the goal was just stored; no ledger entry).
	 *  Subsequent offers fire normally. Consumed only on the live offer
	 *  paths (the waiver itself, and a real fire) — NOT by a hard-guard
	 *  suppression (an environmental block, not an answer to the offer) and
	 *  NOT by an invalidation (the arming input never landed — it was not
	 *  an offer). Per-session state: it dies with the session. */
	waivedNextUserinput: boolean;
}

export function createGoalNudgeState(): GoalNudgeState {
	return { pending: null, userInputsSeen: 0, lastCoveredRealUser: null, waivedNextUserinput: false, armedAt: null, heldOffer: null };
}

/** Bug B (Paul 2026-10-14): a successful adjust_goal stores the goal — the
 *  NEXT userinput offer is the model re-asking the user about a goal the
 *  model just wrote, which reads as noise (Paul's bug report: the nudge
 *  appeared although the model had adjusted the goal in the previous turn).
 *  The waiver retires exactly that one offer, silently (moot — like the
 *  sessionstart-moot path, no ledger entry); the update check stays
 *  unconditional for every offer after it (2026-10-04 design, untouched). */
export function waiveNextUserinput(st: GoalNudgeState): void {
	st.waivedNextUserinput = true;
}

/** An OUTSIDE user input was observed (the `input` event, classified): the
 *  offer is armed for exactly this event. Variant: `sessionstart` for the
 *  session's first outside input when the goal is not yet stored;
 *  `userinput` otherwise — including the first input of a session that
 *  already carries a stored goal (resumed: the goal is known, so the
 *  reminder, not the setup ask). A re-input before the fire replaces the
 *  pending one (latest event wins); after a fire, it is a new event. */
export function armGoalOffer(st: GoalNudgeState, opts: { goalStored: boolean; armedAt?: number }): GoalNudgeVariant {
	st.userInputsSeen += 1;
	const v: GoalNudgeVariant = st.userInputsSeen === 1 && !opts.goalStored ? "sessionstart" : "userinput";
	st.pending = v;
	st.armedAt = opts.armedAt ?? null; // Option 2 (2026-11-20): the arm point's identity (the hold-release comparison)
	return v;
}

/** The offer fired (delivery bookkeeping) — the event is consumed. */
export function consumeGoalOffer(st: GoalNudgeState): void {
	st.pending = null;
}

/** A `adjust_goal` committed (successful tool result, `isError === false`):
 *  the SESSIONSTART (setup-ask) offer's ask was answered — it is cleared
 *  (no offer, no ledger entry for it; the goal record it stored is the
 *  provenance). The USERINPUT (update-check) offer is NOT cleared
 *  (2026-10-04, Paul: the update check is unconditional — it may land right
 *  after the model's own adjust_goal, when the user refines again): it stays
 *  pending and fires at the next assistant message_end. A FAILED
 *  `adjust_goal` must NOT call this at all (the model may retry). */
export function clearGoalPending(st: GoalNudgeState): void {
	if (st.pending === "sessionstart") st.pending = null;
}

/* ── Bug A (Paul 2026-10-14): the landing check ───────────────────────────
 *  The goal-nudge must fire only if there was an ACTUAL user input — one
 *  that LANDED in the session. The `input` event (the arm point) fires
 *  BEFORE the session append (pi v0.87.1 `prompt()`: `_runInputHandlers`
 *  precedes the append; mid-turn steers are only queued and land when the
 *  agent consumes them — agent-session.ts, measured) — so a queued steer
 *  that the user edits away leaves NO session entry but has already armed
 *  the offer. The check runs at fire time (the first assistant message_end
 *  after the arm — by then every input that will land HAS landed: the new
 *  turn's user message is appended before the agent loop, a consumed
 *  mid-turn steer is appended before the LLM call it feeds): the last real
 *  user message on the branch (`goal.ts` `lastRealUserMessage` — already
 *  filters `[sam-` noise, blanks, audit/undo/stub injections) must be
 *  NEWER than the watermark of the last covered one. */

export type GoalNudgeLanding =
	| { ok: true }
	| { ok: false; why: "no-real-user-input" | "no-new-user-input" };

/** The fire-time landing decision (pure, for the pins). `covered` = the
 *  watermark (null = nothing covered yet); `lastReal` = the branch's last
 *  real user message or undefined (none on the branch). Identity by entry
 *  id when both carry one, else by branch index (append-only — a newer
 *  message has a strictly higher index). */
export function goalNudgeLanding(
	covered: { index: number; id?: string } | null,
	lastReal: { index: number; id?: string } | undefined,
): GoalNudgeLanding {
	if (lastReal === undefined) return { ok: false, why: "no-real-user-input" };
	if (covered !== null) {
		if (covered.id !== undefined && lastReal.id !== undefined) {
			if (covered.id === lastReal.id) return { ok: false, why: "no-new-user-input" };
		} else if (lastReal.index <= covered.index) {
			return { ok: false, why: "no-new-user-input" };
		}
	}
	return { ok: true };
}

/** Stamp the watermark after an offer consumption (fire, suppression,
 *  invalidation, or the adjust_goal waiver). Pure mutation, no-op when the
 *  branch carries no real user message (the watermark stays what it was —
 *  a later landed input is still "new" against it). */
export function stampGoalCovered(st: GoalNudgeState, lastReal: { index: number; id?: string } | undefined): void {
	if (lastReal !== undefined) st.lastCoveredRealUser = { index: lastReal.index, id: lastReal.id };
}

/** The `sam-nudge` ledger entry for a `goal` trigger (fired OR suppressed).
 *  Same custom type as the D7 entries — the readout grades the class by
 *  `trigger` + `variant`. NO gap/zone fields: the goal offer is event-based
 *  (no context ruler — the design note's no-time/no-ruler clause). */
export interface GoalNudgeLedgerEntry {
	trigger: "goal";
	variant: GoalNudgeVariant;
	at: number;
	/** 2026-11-06: "steer" (live, mid-turn) or "deferred" (appended; lands
	 *  with the next user turn — the model had settled, so no
	 *  SAM-initiated round). */
	deliverAs: "steer" | "deferred";
	/** D9 pattern (2026-10-02): true when a hard guard suppressed it (not sent). */
	suppressed?: boolean;
	/** D9 pattern: the guard that suppressed it (v0.0.25: + "stub-fork"). */
	suppressReason?: "audit-in-flight" | "audit-fork" | "stub-fork";
	/** Bug A (2026-10-14): true when the fire-time landing check invalidated
	 *  the arm — the input event fired but no (new) real user message
	 *  landed in the session (e.g. a queued steer edited away). Not sent;
	 *  the trace exists so the (formerly invisible) invalidation is
	 *  auditable (F1). */
	invalidated?: boolean;
	/** Bug A: the landing check's reason ("no-real-user-input" |
	 *  "no-new-user-input"). */
	invalidateReason?: "no-real-user-input" | "no-new-user-input";
	/** Option 2 (2026-11-20): true when the offer was HELD at fire time for
	 *  the imminent compaction (the delivery decision is pending — released
	 *  at the next message_end / agent_end; the hold itself is traced here). */
	held?: boolean;
	/** Option 2: why the offer was held (only "compaction-imminent"). */
	heldReason?: "compaction-imminent";
	/** Option 2: true when a held offer was dropped because a NEWER input
	 *  landed while it was held (that input's own arm carries the offer —
	 *  the held one is moot, not an invalidation). */
	superseded?: boolean;
}

export function goalNudgeLedgerEntry(f: {
	variant: GoalNudgeVariant;
	now: number;
	deliverAs?: "steer" | "deferred"; // 2026-11-06: default "steer" (the live channel)
	suppressed?: boolean;
	suppressReason?: "audit-in-flight" | "audit-fork" | "stub-fork"; // v0.0.25: the stub child
	invalidated?: boolean;
	invalidateReason?: "no-real-user-input" | "no-new-user-input";
	held?: boolean;
	heldReason?: "compaction-imminent";
	superseded?: boolean;
}): GoalNudgeLedgerEntry {
	return {
		trigger: "goal",
		variant: f.variant,
		at: f.now,
		deliverAs: f.deliverAs ?? "steer",
		...(f.suppressed ? { suppressed: true, suppressReason: f.suppressReason } : {}),
		...(f.invalidated ? { invalidated: true, invalidateReason: f.invalidateReason } : {}),
		...(f.held ? { held: true, heldReason: f.heldReason } : {}),
		...(f.superseded ? { superseded: true } : {}),
	};
}

/* ── Option 2 (WISHLIST 2026-11-20): the held-offer release decision ──────
 *  Runs at every non-toolResult message_end (final = false) and at
 *  agent_end (final = true — by then EVERY queued steer of the run has
 *  drained: the agent loop only exits when no tool calls AND no queued
 *  messages remain, measured pi 1.5.2/1.6.0 agent-loop.js). The four
 *  outcomes:
 *  - `hold`: no new real user message beyond the hold's snapshot (and the
 *    run is still going) — wait for the next observation.
 *  - `deliver`: the arming input itself landed — a new real user message
 *    exists and NO newer arm overwrote the arming identity (a queued steer
 *    is recognized even if its text was edited in transit). The wiring
 *    delivers via the offer's channel logic and stamps the watermark.
 *  - `supersede`: a DIFFERENT newer real input landed — its OWN arm
 *    (st.pending, re-armed by its input event) carries the offer; the held
 *    one is dropped WITHOUT stamping (stamping it here would invalidate the
 *    new arm's own landing check — the watermark must stay BEHIND the new
 *    input).
 *  - `invalidate` (final only): the run is over and nothing new landed —
 *    the arming input never landed (a queued steer edited away, the
 *    incident's case). The wiring stamps the watermark (it catches up — the
 *    15:30:17 stamp-race class is closed for later offers) and leaves the
 *    trace. */
export type HeldGoalRelease = "hold" | "deliver" | "supersede" | "invalidate";

/** The held-offer release decision (pure, for the pins). `lastNow` = the
 *  branch's current last real user message (goal.ts `lastRealUserMessage` —
 *  already filters [sam- noise, blanks, audit/undo/stub injections); its
 *  text is carried for pin fidelity but the decision keys on identity (id
 *  or index) + the arming-identity comparison. */
export function goalHoldRelease(f: {
	hold: HeldGoalOffer;
	lastNow: { index: number; id?: string; text?: string } | undefined;
	/** The CURRENT arm's epoch-ms (null = no live arm identity). */
	currentArmedAt: number | null;
	/** agent_end (the run is over — no further drain will happen). */
	final: boolean;
}): HeldGoalRelease {
	if (f.lastNow === undefined) return f.final ? "invalidate" : "hold";
	if (f.hold.lastRealAtHold !== null) {
		const h = f.hold.lastRealAtHold;
		const unchanged =
			(h.id !== undefined && f.lastNow.id !== undefined && h.id === f.lastNow.id) ||
			(h.id === undefined && f.lastNow.id === undefined && f.lastNow.index === h.index);
		if (unchanged) return f.final ? "invalidate" : "hold";
	}
	if (f.currentArmedAt !== null && f.currentArmedAt === f.hold.armedAt) return "deliver";
	return "supersede";
}

/** Marker-prefix consistency (F1 provenance — the battery readout keys on
 *  `NUDGE_MARKER` for all nudge-class messages, D7 and goal alike). */
export function goalNudgeText(variant: GoalNudgeVariant): string {
	const t = GOAL_NUDGE_TEXTS[variant];
	if (!t.startsWith(NUDGE_MARKER + " ")) throw new Error(`self-check failed: goal nudge text (${variant}) lost its marker prefix`);
	return t;
}

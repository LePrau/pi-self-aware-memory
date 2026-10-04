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

/** Per-session runtime (in SamState; fresh per session — a resumed session
 *  has its own first invocation, so its first outside input may carry the
 *  `sessionstart` variant when no goal is stored yet). */
export interface GoalNudgeState {
	/** The offer pending for the current outside user-input event, or null. */
	pending: GoalNudgeVariant | null;
	/** Outside user inputs observed in the running session (the FIRST one
	 *  may carry the `sessionstart` variant — see `armGoalOffer`). */
	userInputsSeen: number;
}

export function createGoalNudgeState(): GoalNudgeState {
	return { pending: null, userInputsSeen: 0 };
}

/** An OUTSIDE user input was observed (the `input` event, classified): the
 *  offer is armed for exactly this event. Variant: `sessionstart` for the
 *  session's first outside input when the goal is not yet stored;
 *  `userinput` otherwise — including the first input of a session that
 *  already carries a stored goal (resumed: the goal is known, so the
 *  reminder, not the setup ask). A re-input before the fire replaces the
 *  pending one (latest event wins); after a fire, it is a new event. */
export function armGoalOffer(st: GoalNudgeState, opts: { goalStored: boolean }): GoalNudgeVariant {
	st.userInputsSeen += 1;
	const v: GoalNudgeVariant = st.userInputsSeen === 1 && !opts.goalStored ? "sessionstart" : "userinput";
	st.pending = v;
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

/** The `sam-nudge` ledger entry for a `goal` trigger (fired OR suppressed).
 *  Same custom type as the D7 entries — the readout grades the class by
 *  `trigger` + `variant`. NO gap/zone fields: the goal offer is event-based
 *  (no context ruler — the design note's no-time/no-ruler clause). */
export interface GoalNudgeLedgerEntry {
	trigger: "goal";
	variant: GoalNudgeVariant;
	at: number;
	deliverAs: "steer";
	/** D9 pattern (2026-10-02): true when a hard guard suppressed it (not sent). */
	suppressed?: boolean;
	/** D9 pattern: the guard that suppressed it. */
	suppressReason?: "audit-in-flight" | "audit-fork";
}

export function goalNudgeLedgerEntry(f: {
	variant: GoalNudgeVariant;
	now: number;
	suppressed?: boolean;
	suppressReason?: "audit-in-flight" | "audit-fork";
}): GoalNudgeLedgerEntry {
	return {
		trigger: "goal",
		variant: f.variant,
		at: f.now,
		deliverAs: "steer",
		...(f.suppressed ? { suppressed: true, suppressReason: f.suppressReason } : {}),
	};
}

/** Marker-prefix consistency (F1 provenance — the battery readout keys on
 *  `NUDGE_MARKER` for all nudge-class messages, D7 and goal alike). */
export function goalNudgeText(variant: GoalNudgeVariant): string {
	const t = GOAL_NUDGE_TEXTS[variant];
	if (!t.startsWith(NUDGE_MARKER + " ")) throw new Error(`self-check failed: goal nudge text (${variant}) lost its marker prefix`);
	return t;
}

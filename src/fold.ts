import type { PlainEntry } from "./projection.ts";

/**
 * v0.0.4 FOLD (Paul 2026-10-14): model-initiated fold — the `fold_now` tool.
 *
 * Design note: dev-repo `2026-10-14-eval-model-initiated-fold-after-close-unit.md`
 * (feasibility evaluation, GO given by the 2026-10-14 task). The tool calls
 * pi's `ctx.compact()` — the SAME code path as the user's `/compact`
 * (pi 0.87.1 agent-session.ts: `compact()` manual path ~2685, the ctx
 * wiring ~3369, `ExtensionToolContext extends ExtensionContext`
 * types.ts:383). The takeover handler (reason-independent) owns the
 * summary; the retention cut is pi's (`keepRecentTokens`, default 20 000).
 *
 * F1 (contract, verified pi source): `compact()` aborts the calling turn
 * first — the tool's own result is never read by the model. The ack rides
 * a `sam-fold-ack` CUSTOM MESSAGE (`pi.sendMessage` — a CustomMessageEntry
 * participates in the LLM context, session-manager.ts:1332). v0.0.5
 * (Paul 2026-10-14, "implement the oncomplete trigger autonomously"): the
 * MODEL-INITIATED ack is sent with `triggerTurn: true` from the tool's
 * `onComplete` — the turn is already dead (F1), so `sendCustomMessage`
 * takes the not-streaming branch (`_runAgentPrompt`, agent-session.ts
 * ~2210) and the ack RESTARTS the turn right after the fold; the state it
 * resumes from is the takeover summary (goal + settlement lines) + pi's
 * retention tail, so the message carries no state of its own. User/
 * native folds stay queued for the next turn (`deliverAs: "nextTurn"`),
 * as before.
 *
 * F3 (single-flight): `compact()` is fire-and-forget; a second call would
 * abort the in-flight first (fresh `_compactionAbortController` per call).
 * SAM keeps `state.foldInFlight` (set by the tool, cleared by the
 * `session_compact` / `session_compact_failed` listeners) — a second call
 * is a plain refusal.
 *
 * F4 (guard family): a child fork (a session whose branch carries a
 * `[sam-…]` child instruction after the last close record) must refuse —
 * folding the child would burn its one-shot turn and trip the takeover
 * inside it.
 *
 * Dial: `SAM_FOLD` — DEFAULT ON (house practice: new behaviour behind a
 * dial so the current behaviour stays the control arm; the opt-out
 * `SAM_FOLD=off` restores the threshold-only fold). Rides the same
 * close-dial surface as the nudge family.
 */

/** The fold dial's env key (the nudge-family pattern: explicit `off`
 *  opts out; anything else — including unset — is on). */
export const FOLD_ENV = "SAM_FOLD";

/** v0.0.4 dial semantics — DEFAULT ON (Paul 2026-10-14): the fold tool is
 *  part of the v4 close-dial surface, not an opt-in experiment; the ONLY
 *  opt-out is explicit `SAM_FOLD=off` (the native threshold fold applies
 *  either way — the dial only arms the tool + the nudge hint). */
export function foldEnabled(env: Record<string, string | undefined>): boolean {
	return env[FOLD_ENV] !== "off";
}

/** The ack channel's custom type (a CustomMessageEntry — participates in
 *  the LLM context, in contrast to appendEntry's ledger records). */
export const FOLD_ACK_CUSTOM_TYPE = "sam-fold-ack";

/** The ack's marker (the nudge-marker pattern: the text carries its own
 *  provenance so the model can tell a fold ack from any other message). */
export const FOLD_ACK_MARKER = "[sam-fold-ack]";

/** v0.0.37 (Paul's option 1, 2026-11-16): the fold-ack channel decision.
 *
 * The model must know about a fold THE MOMENT it happened — the v0.0.36
 * pending channel (`triggerTurn: false` while streaming ⇒
 * `_pendingCustomMessages`, flushed at turn end) deferred the ack by one
 * FULL model turn (measured 2026-11-16: native fold 12:11:53 → ack seen
 * 12:21:47, after a 7-minute blind close turn; the blind turn even re-folded
 * — 00:44 — failing with "Nothing to compact (session too small)").
 *
 * "steer" — `{ deliverAs: "steer" }`: while the run is active pi queues the
 * message as a steer (agent-session.ts sendCustomMessage :2460 →
 * `agent.steer`) — it is injected at the NEXT LLM call of the active run,
 * so the model learns of the fold before acting on the post-fold context.
 * A steer sent while NOT streaming degrades to an immediate append (the
 * same branch cascade, last case) — safe.
 *
 * "append" — `{ triggerTurn: false }`: idle ⇒ appended immediately (the
 * model learns with the next user input); active ⇒ `_pendingCustomMessages`
 * (flushed at turn end — the model learns one turn late, but the 2026-11-06
 * settled-model guard holds: the pending channel never starts a turn).
 *
 * The steer is only safe where PI'S OWN FLOW continues the run without SAM
 * having to trigger the continuation — otherwise the steered ack becomes the
 * queued message that pi's settle check (agent-session.ts :2084
 * `hasQueuedMessages()`) continues ON, i.e. the v0.0.12 standalone-SAM-turn
 * regression (a model round that exists only to deliver the ack).
 * Measured pi 1.5.2 — the two safe cases:
 *  - the native REQUEST-PATH fold (mid-turn, `prepareRequest` :838/:897 —
 *    the very LLM request that triggered the fold runs right after it; the
 *    steer is drained at the next agent-loop iteration of the SAME turn or
 *    the continued one) — detected by the open-turn probe (a toolResult
 *    right before the compaction entry: the turn is still open);
 *  - ANY fold with user-queued work (`hasPendingMessages()` — pi's
 *    `_steeringMessages` + `_followUpMessages`, the same queue the settle
 *    check counts): the run continues on the user's own messages; the ack
 *    rides that continuation. (ESC abort: a queued steer lands in the next
 *    user prompt — measured by Paul, no special handling.)
 * Everywhere else (a run that would settle) the ack is appended.
 *
 * Accepted edge (discussed 2026-11-16): a mid-turn fold whose NEXT LLM
 * response ends with stop — the steer then forces one short extra ack turn
 * before the settle. The moderate overhead is acceptable (Paul); the prompt
 * level mitigates (fold_now: do not fold when you are about to settle — the
 * fold can be the first action after the next user interaction).
 */
export type FoldAckChannel = "steer" | "append";

export function foldAckChannel(args: {
	origin: "user" | "native";
	/** pi's isIdle() — false while a run is active (incl. between turns). */
	runActive: boolean;
	/** pi's ctx.hasPendingMessages() — user-queued steering/follow-up work. */
	hasPending: boolean;
	/** openTurnAtFold() — the fold landed mid-turn (a toolResult right
	 *  before the compaction entry / at the branch end for failures). */
	openTurn: boolean;
}): FoldAckChannel {
	const { origin, runActive, hasPending, openTurn } = args;
	if (!runActive) return "append"; // idle (incl. the pre-send catch of an aborted run)
	if (hasPending) return "steer"; // user-queued work continues the run anyway
	if (origin === "native" && openTurn) return "steer"; // request-path fold: the request itself continues
	return "append"; // the run would settle — no standalone SAM turn (2026-11-06)
}

/** v0.0.37: the open-turn probe (pure — the branch at the fold event).
 *
 * "Open turn" = the fold landed MID-TURN (between a tool result and the
 * next LLM call): the last MESSAGE entry before the newest compaction entry
 * is a toolResult — the walk skips non-message entries, because SAM's own
 * custom records (the session-start version entry, close/nudge ledger
 * records, earlier fold acks) interleave between the last model/tool
 * message and the compaction entry (measured 2026-11-16). For a FAILED
 * fold there is no compaction entry — the walk starts at the branch end
 * (a mid-turn failure leaves a toolResult at the end; a post-run failure
 * leaves an assistant message).
 *
 * Empty branch, absent compaction entry, or no message predecessor (or a
 * non-toolResult one) ⇒ false (the append channel — the safe default). */
export function openTurnAtFold(entries: readonly PlainEntry[], compactionEntryId?: string): boolean {
	const n = entries.length;
	if (n === 0) return false;
	let idx = n - 1;
	if (compactionEntryId !== undefined) {
		idx = entries.findIndex((e) => e.id === compactionEntryId);
		if (idx <= 0) return false; // absent, or nothing before it
		idx -= 1;
	}
	for (let i = idx; i >= 0; i--) {
		const e = entries[i];
		if (e.kind !== "message") continue; // SAM customs / older compactions carry no turn state
		return e.message.role === "toolResult";
	}
	return false;
}

/** The `fold_now` tool surface (name/label/description/snippet/guidelines
 *  — protocol strings ship with their pinned tests + this design note). */
export const FOLD_NOW_TOOL_ACTIVE = {
	name: "fold_now",
	label: "Fold the session context now",
	description:
		"Fold (compact) the session context NOW — the same code path as the user's /compact. " +
		"Call it at a clean unit boundary: right after a close_unit settled, when the context window is high " +
		"and everything up to the last close is summarized in the settlement lines. " +
		"Calling this tool ENDS YOUR CURRENT TURN: pi aborts the turn and rewrites the context (the takeover " +
		"summary + pi's ≤20,000-token retention tail). You will not read this tool's own result — the ack " +
		"arrives as a sam-fold-ack message that restarts your turn (tokens folded, banked spans). " +
		"Do not call it mid-unit unless you accept the ORPHANED section (the unsettled span becomes a " +
		"skeleton + retrieval id). Do not fold when you are about to settle (your answer is done and " +
		"nothing else is pending) — the fold can be the first action after the next user interaction instead. " +
		"One fold at a time: a second call while one is in flight is refused.",
	parametersDescription:
		"No parameters — the fold always compacts the whole session up to pi's retention cut.",
	promptSnippet:
		"fold_now — fold (compact) the session now, at a clean unit boundary; your turn ends, the next prompt starts with the compacted context + a sam-fold-ack",
	promptGuidelines: [
		"Call fold_now right after a close_unit's audit settled — a settled close is a clean fold point even at low context consumption — make it the final action of your turn (your turn ends when it runs).",
		"Do not fold as the last act of a settling turn — if your answer is done and nothing else is pending, leave the fold to the first action after the next user interaction.",
		"Never call fold_now inside a SAM side-branch audit session, and never call it twice while a fold is in flight (wait for the sam-fold-ack).",
	],
} as const;

/** The `fold_now` parameter schema (no parameters — the fold always
 *  compacts the whole session up to pi's retention cut). */
export const FOLD_NOW_PARAMS = { type: "object", properties: {}, required: [] } as const;

/** F4: the child-fork refusal (the guard family — one-liners, the
 *  close_unit/adjust_goal/retire family's shape). */
export const FOLD_NOW_AUDIT_FORK_TEXT =
	"This session is a SAM side-branch in progress: fold_now is not available here. " +
	"Complete the instructed work as usual.";

/** F3: the single-flight refusal (a fold is already in progress — a second
 *  compact() would abort the first; wait for the ack). */
export const FOLD_NOW_IN_FLIGHT_TEXT =
	"A fold is already in flight — wait for the sam-fold-ack message at the start of the next turn " +
	"before folding again.";

/** The dial-off refusal (the native threshold fold still applies). */
export const FOLD_NOW_DISABLED_TEXT =
	"fold_now is disabled (SAM_FOLD=off) — pi's native threshold fold still applies.";

/** The triggered acknowledgement (what lands in the session file's tool
 *  result; the model never reads it — the turn is aborted, F1 — but the
 *  line is the transcript's provenance and print mode shows it). */
export const FOLD_NOW_TRIGGERED_TEXT =
	"Fold triggered — your turn ends now. The sam-fold-ack message reports the result " +
	"(tokens folded, the surviving summaries, the banked span) and restarts your turn with the " +
	"compacted context.";

/** The deferred-ack facts stashed by the `session_compact` listener until
 *  the tool's `onComplete` delivers the exact CompactionResult (pi emits
 *  the event BEFORE the ctx-level onComplete resolves — measured at the
 *  pinned commit, agent-session.ts ~2774 vs ~2800). */
export interface FoldAckPending {
	tokensBefore: number;
	fromExtension: boolean;
	/** the compaction's span identity (pi's firstKeptEntryId) — the context-pressure
	 *  safenet's (2026-10-16) post-fold pressure check uses it as the fold id, the
	 *  same span identity the takeover hook and the retire-offer arming use. */
	firstKeptEntryId?: string;
}

/** The sam-fold-ack text (a pure, pinned builder).
 *
 * facts.origin — who folded: "model" (the fold_now tool), "user" (the
 *  /compact command), "native" (pi's threshold/overflow folds — the
 *  listener covers those too; the ack works for every fold kind).
 * facts.estimatedTokensAfter — exact (from the CompactionResult,
 *  model-initiated folds); null on native folds and on manual folds whose
 *  ack was not deferred (the honest phrase stands in).
 * facts.fromExtension — the takeover engaged (goal or settlement on the
 *  branch); false only for a truly empty branch or a takeover failure
 *  (F1: pi's own summary stands). */
export function foldAckText(facts: {
	origin: "model" | "user" | "native";
	tokensBefore: number;
	estimatedTokensAfter: number | null;
	fromExtension: boolean;
}): string {
	const who =
		facts.origin === "model"
			? "your fold_now call"
			: facts.origin === "user"
				? "the /compact command"
				: "pi's automatic fold";
	const summary = facts.fromExtension
		? "SAM's takeover summary (goal + settlement lines)"
		: "the compaction summary";
	const after =
		facts.estimatedTokensAfter !== null && Number.isFinite(facts.estimatedTokensAfter)
			? `≈ ${facts.estimatedTokensAfter.toLocaleString("en-US")} tokens`
			: "the ≤20,000-token retention tail";
	const tail = facts.fromExtension
		? "The settlement lines above are the surviving summaries; the raw span is banked (tombstone / sam_retrieve)."
		: "The compaction summary above carries the surviving context; the raw span is banked (tombstone / sam_retrieve).";
	// v0.0.5: model-initiated folds restart the turn (the ack is sent
	// triggerTurn — see the header note), so the message doubles as the
	// resume prompt. The state it resumes from is the takeover summary +
	// retention tail, so it carries no state of its own.
	const resume =
		facts.origin === "model"
		? " Your turn was compacted — resume the work from the settlement lines above (stop if the task is done)."
		: "";
	return (
		`${FOLD_ACK_MARKER} Fold complete (${who}) — ${facts.tokensBefore.toLocaleString("en-US")} tokens folded; ` +
		`the context now holds ${summary} + ${after}. ` +
		tail +
		resume
	);
}

/** The fold-failure ack text (the session_compact_failed listener — the
 *  turn was aborted, nothing compacted, no state change; a retry is
 *  possible because the in-flight flag was cleared). */
export function foldFailText(error: string): string {
	// v0.0.5: a genuine model-initiated failure restarts the turn too
	// (the model lost its turn and nothing was compacted) — so the text
	// must be an actionable resume, not just a report. User/native
	// failures reach the model the same way (queued for the next turn);
	// the line is accurate for all of them.
	return (
		`${FOLD_ACK_MARKER} Fold FAILED — ${error} — no state change; the context is unchanged. ` +
		"Your turn was aborted — resume the work: retry fold_now at a clean boundary, " +
		"or continue from where you left off."
	);
}

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
		"skeleton + retrieval id). One fold at a time: a second call while one is in flight is refused.",
	parametersDescription:
		"No parameters — the fold always compacts the whole session up to pi's retention cut.",
	promptSnippet:
		"fold_now — fold (compact) the session now, at a clean unit boundary; your turn ends, the next prompt starts with the compacted context + a sam-fold-ack",
	promptGuidelines: [
		"Call fold_now right after a close_unit's audit settled and the context is high — make it the final action of your turn (your turn ends when it runs).",
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

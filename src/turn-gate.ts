/**
 * The model-settled gate (Paul, 2026-11-06) — pure, pinned in
 * test/turn-gate.test.ts. Design note: the dev repo's
 * `2026-11-06-no-sam-output-after-settled-model.md`.
 *
 * Paul (2026-11-06, verbatim): "SAM nudges and SAM notices (e.g. after a fold) must only
 * appear if the last model output ALSO contained tool calls — i.e. if the model settled
 * its output and would have ended the turn, no SAM output should happen, and the model
 * must be prevented from going another round unless the user gives new input. If possible,
 * such a message should be delivered immediately with/after the user input, before the
 * next model turn."
 *
 * Mechanical translation (measured, pi 0.87.1 AND 1.5.0, agent-session.ts):
 * - an assistant message WITH toolCall blocks — OTHER THAN `fold_now` — ⇒ the
 *   turn is OPEN (pi is executing / about to execute the tool calls and will call
 *   the LLM again) ⇒ SAM may deliver LIVE (`sendUserMessage` steer — it rides the
 *   running loop, no extra round).
 * - an assistant message whose ONLY toolCall is `fold_now` is SETTLED, not open:
 *   `compact()` aborts the current turn (measured: the fold-ack restarts it), so a
 *   steer queued "before the next LLM call" never lands inside that turn — it
 *   degrades into a standalone SAM-initiated turn AFTER the model settled (the
 *   2026-11-10 session measured it: the v0.0.31 fold offer fired on the model's
 *   own fold_now message and surfaced as its own turn after the fold-ack) —
 *   exactly the extra round Paul's 2026-11-06 requirement forbids. Such a message
 *   takes the DEFERRED channel like any settled message: the nudge is appended
 *   and rides the NEXT real user turn (v0.0.32, Paul 2026-11-10: "the nudge
 *   should be delivered together with the following real user input just as the
 *   context-nudge would").
 * - an assistant message WITHOUT toolCall blocks (stop/length/error/aborted) ⇒ the
 *   model SETTLED ⇒ SAM must not start a turn: `sendUserMessage` ALWAYS triggers a
 *   turn (0.87.1 docstring + `prompt()`; 1.5.0 same) — instead the message is
 *   APPENDED (`pi.sendMessage` without options ⇒ `_appendCustomMessage` when not
 *   streaming, `_pendingCustomMessages` flush at turn end when streaming — never a
 *   turn) and rides the NEXT user turn (a custom message is LLM-visible as role
 *   `user`, `convertToLlm`, both versions).
 */

/** The minimal shape of an assistant content block the gate inspects. */
export type GateContentBlock = { type: string };

/** The assistant content shapes the gate accepts: the real pi block
 *  array, a plain string (some test fixtures use it — a string is
 *  no-tool-calls by definition), or null/undefined. */
export type GateContent = string | readonly GateContentBlock[] | null | undefined;

/** v0.0.32 (2026-11-10, Paul): the turn-terminating tool — `fold_now`
 *  triggers the compaction that aborts the current turn (see the header's
 *  measured degradation). The only toolCall whose execution ENDS the turn
 *  rather than continuing it. */
export const TURN_TERMINATING_TOOL = "fold_now";

/**
 * The gate: will the model's turn CONTINUE after this assistant message
 * (pi will execute a continuing tool call and call the LLM again in the
 * same turn)? `true` ⇒ deliver live (steer into the running turn);
 * `false` ⇒ the turn is over or will end (settled — or a fold_now-only
 * message, v0.0.32) ⇒ defer (append; delivered with the next user turn —
 * never an SAM-initiated round).
 */
export function modelTurnOpen(content: GateContent): boolean {
	if (typeof content === "string") return false; // no tool calls ⇒ settled
	if (!Array.isArray(content)) return false; // null/undefined ⇒ settled
	return content.some(
		(block) =>
			block !== null &&
			typeof block === "object" &&
			block.type === "toolCall" &&
			(block as { name?: string }).name !== TURN_TERMINATING_TOOL, // v0.0.32: fold_now ends the turn ⇒ not open
	);
}

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
 * - an assistant message WITH toolCall blocks ⇒ the turn is OPEN (pi is executing /
 *   about to execute the tool calls and will call the LLM again; for a fold_now,
 *   `compact()` aborted the dead turn and the ack's triggered turn continues it) ⇒
 *   SAM may deliver LIVE (`sendUserMessage` steer — it rides the running loop, no
 *   extra round).
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

/**
 * The gate: is the model's turn still open at this assistant message?
 * `true` ⇒ deliver live (steer into the running turn); `false` ⇒ the model
 * settled ⇒ defer (append; delivered with the next user turn — never an
 * SAM-initiated round).
 */
export function modelTurnOpen(content: GateContent): boolean {
	if (typeof content === "string") return false; // no tool calls ⇒ settled
	if (!Array.isArray(content)) return false; // null/undefined ⇒ settled
	return content.some((block) => block !== null && typeof block === "object" && block.type === "toolCall");
}

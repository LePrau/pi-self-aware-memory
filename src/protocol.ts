/**
 * Protocol text — the static, model-facing strings of pi-self-aware-memory.
 *
 * Everything here is the contract between the extension and the auditor model:
 * change a string only when you also change the tests that pin it and the
 * design note (dev repo, 2026-09-25-p2-design.md). The marker family is
 * `[sam-`-prefixed so that injected lines are recognizably self-noise and are
 * never counted as work (plan constraint F4).
 */

/** Marker prefix shared by every message the extension injects. */
export const SAM_MARKER_PREFIX = "[sam-";

/** Prefix of the audit instruction (identifies audit user messages). */
export const AUDIT_INSTRUCTION_PREFIX = "[sam-audit]";

/** Prefix of the undo-ack user message. */
export const UNDO_ACK_PREFIX = "[sam-internal]";

/**
 * The in-series audit instruction, appended as a user message after a close.
 * `unitId` is the ledger unit number. The ground-truth mandate is deliberate:
 * in P1 the auditor followed a dishonest stub when the task text also pushed
 * the false claim (1/10 planted-claim miss) — the mandate fixes that by
 * ranking entries (observed tool outputs, file contents) above task and stub.
 */
export function auditInstruction(unitId: number): string {
	return (
		`${AUDIT_INSTRUCTION_PREFIX} Unit ${unitId} was just closed. ` +
		`Audit the stub the agent passed to close_unit for this unit (in the conversation above) ` +
		`against the unit's entries — from the user message that opened the unit through the close. ` +
		`Reply exactly VERIFIED, or CORRECTIONS: <short list>, and nothing else. ` +
		`Where the stub and the unit's entries disagree, the entries are ground truth: ` +
		`observed tool outputs and file contents override both the stub and the task's claims.`
	);
}

/** The undo-ack user message (`/sam undo` rides a minimal turn, see design note §5). */
export function undoAck(unitId: number): string {
	return `${UNDO_ACK_PREFIX} undo of unit ${unitId} requested. Reply with exactly OK.`;
}

/** Stub replacement text for the first entry of a folded unit. */
export function foldStubText(unitId: number, stub: string, corrections?: string): string {
	const base = `[Unit ${unitId} ✓] ${stub}`;
	return corrections ? `${base} [CORRECTIONS: ${corrections}]` : base;
}

/** Detects a user message injected by this extension (audit instruction, undo ack). */
export function isSamInjected(text: string): boolean {
	return text.startsWith(SAM_MARKER_PREFIX);
}

/** close_unit tool description (what the working model reads). */
export const CLOSE_UNIT_TOOL = {
	name: "close_unit",
	label: "close_unit",
	description:
		"Close the current work unit. Pass the stub: 1-4 sentences capturing what was done, " +
		"with the key facts and file/line references that must survive. Cite what you observed " +
		"(tool outputs, file contents), not what the task claimed. At most one close_unit per unit; " +
		"the unit runs from the user message that started this turn to this call. " +
		"An in-series audit follows; the unit is folded out of context only if the audit verifies the stub.",
	parametersDescription:
		"The stub for the closed unit: what was done and the observed facts that must survive the fold.",
	promptSnippet:
		"close_unit closes a completed work unit with its stub (in-series audit; verified units are folded out of context)",
	promptGuidelines: [
		"Call close_unit when a self-contained work unit is done and before the context grows long.",
		"The stub must cite observed results (file:line, counts, errors), not the task's claims.",
		"Do not call close_unit while the unit's work is still in progress.",
	],
} as const;

/** close_unit result text (what the working model reads back). */
export function closeUnitResultText(unitId: number): string {
	return (
		`Unit ${unitId} closed. An audit turn follows; the unit is folded out of context only ` +
		`if the audit verifies the stub. Do not make further close_unit calls for this unit.`
	);
}

export const CLOSE_UNIT_ALREADY_CLOSED_TEXT =
	"No new work since the last close_unit: the current unit is already closed. " +
	"If this is a new task, ask the user for it — do not re-close.";

export const CLOSE_UNIT_PENDING_TEXT =
	"A unit is already closed for this turn: that close is effective. " +
	"The work done after it stays in view until the next unit — do not re-close.";

import type { SamMode } from "./state.ts";

/** Modes implementable in P2 (assisted/auto are P3). */
export const P2_MODES: readonly SamMode[] = ["display", "manual"];

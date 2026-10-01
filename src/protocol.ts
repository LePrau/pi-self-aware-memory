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

/** Prefix of the auto-mode stub request (P3; identifies auto stub turns). */
export const AUTO_STUB_PREFIX = "[sam-stub]";

/** Prefix of the undo-ack user message. */
export const UNDO_ACK_PREFIX = "[sam-internal]";

/**
 * The in-series audit instruction, appended as a user message after a close.
 * `unitId` is the ledger unit number. The ground-truth mandate is deliberate:
 * in P1 the auditor followed a dishonest stub when the task text also pushed
 * the false claim (1/10 planted-claim miss) — the mandate fixes that by
 * ranking entries (observed tool outputs, file contents) above task and stub.
 */
/**
 * The audit turn's instruction — SELF-CONTAINED (P4 R2, after the measured
 * live gap 2026-09-30: "in the conversation above" was unresolvable once
 * native compaction had compacted the span, and the auditor was left a
 * mandate with no reachable referent). The instruction now carries:
 * - the stub VERBATIM (the claim being audited — no lookup needed); the
 *   close-time floor when recorded (system-extracted facts: files touched,
 *   errors, retries, non-triviality — objective, code-computed, not claimed);
 * - the ground-truth mandate (unchanged P1 fix: entries override the stub);
 * - an honest pointer to the session file when the entries are out of view
 *   (F1: the session file preserves every original byte — the raw span is
 *   still there and may be read), so the audit remains decidable in the
 *   compacted case instead of degrading to a guess.
 * Shape compatibility: still `[sam-audit] Unit N …` (the rebuild finder,
 * isSamInjected and the walk guards match prefix + unit id).
 */
export interface SamAuditPayload {
	stub?: string;
	evidence?: { files?: string[]; errors?: number; retries?: number; nonTrivial?: boolean };
}

export function auditInstruction(unitId: number, payload?: SamAuditPayload): string {
	const stub = payload?.stub?.trim();
	const ev = payload?.evidence;
	const facts = ev
		? [
				`files: ${(ev.files ?? []).length === 0 ? "(none observed)" : (ev.files ?? []).join(", ")}`,
				`errors: ${ev.errors ?? 0}`,
				`retries: ${ev.retries ?? 0}`,
				`non-trivial work: ${ev.nonTrivial ? "yes" : "no"}`,
			].join(" · ")
		: null;
	return (
		`${AUDIT_INSTRUCTION_PREFIX} Unit ${unitId} was just closed. ` +
		`Audit the stub below against what actually happened in the unit. ` +
		(stub ? `\nSTUB (verbatim):\n${stub}\n` : "") +
		(facts ? `RECORDED AT CLOSE (system-extracted from the span): ${facts}. ` : "") +
		`Where the stub and the unit's entries disagree, the entries are ground truth: ` +
		`observed tool outputs and file contents override both the stub and the task's claims. ` +
		`If the unit's entries are no longer in view (for example, because native compaction compacted them), ` +
		`this instruction is self-contained: judge the stub against the recorded facts above; the raw span is ` +
		`preserved verbatim in this session's file (find the sam close record for Unit ${unitId}), and you may read it. ` +
		`Reply exactly VERIFIED, or CORRECTIONS: <short list>, and nothing else.`
	);
}

/** The undo-ack user message (`/sam undo` rides a minimal turn, see design note §5). */
export function undoAck(unitId: number): string {
	return `${UNDO_ACK_PREFIX} undo of unit ${unitId} requested. Reply with exactly OK.`;
}

/**
 * The auto-mode stub request (P3): for an UNMARKED closed-off block, one
 * in-series turn where the model writes the stub by calling close_unit —
 * the existing close flow (ledger, audit, fold) then carries it exactly as
 * a normal unit. Injected text, so `isSamInjected` excludes it from unit
 * openers (F4).
 */
export function autoStubInstruction(firstEntryId: string, lastEntryId: string): string {
	return (
		`${AUTO_STUB_PREFIX} Context pressure is high and the work block between entry ${firstEntryId} and entry ${lastEntryId} has no stub. ` +
		`Summarize that block now: what was done, the observed facts (tool outputs, file:line, counts, errors), ` +
		`and call close_unit with that stub (1-4 sentences, cite what you observed). Nothing else.`
	);
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

/* ── P5 (2026-09-30): branch-audit — the side-branch audit + settlement ── */

/**
 * The branch-audit's section names (Paul's Q3 shape, 2026-09-30). The audit
 * reply's FIRST LINE stays exactly `VERIFIED` or `CORRECTIONS: <list>` (the
 * existing parseVerdict contract — the fold policy keys off that class);
 * the sections follow on their own lines and are EXTRACTED by SAM into the
 * settlement line — zero added inference, single source of truth (the reply).
 * EVIDENCE is the P5 addition: verbatim must-survive output (e.g. the H1
 * MARKER lines) so the compaction-takeover summary keeps what the
 * continuation needs (the C/D battery showed the continuation depends on
 * such lines; the takeover summary is the only place they survive pi's
 * summarizer).
 */
export const BRANCH_AUDIT_SECTION_NAMES = ["FACTS", "DECISIONS", "DISPROVED", "EXPLORED-DISCARDED", "EVIDENCE"] as const;

/**
 * The branch-audit instruction (P5). Self-contained like the R2 in-series
 * audit (same `[sam-audit]` prefix + unit id — the rebuild finder and
 * isSamInjected keep working), plus the reply-format block. Delivered on the
 * FORK file (a side branch of the session tree); the main session never
 * sees it. Deliverable via pi.sendUserMessage on the fork, or via the /sam
 * audit command (which drives the fork/switch dance).
 */
export function branchAuditInstruction(unitId: number, payload?: SamAuditPayload): string {
	const base = auditInstruction(unitId, payload);
	const format =
		`Reply format: line 1 exactly VERIFIED, or CORRECTIONS: <short list>. ` +
		`Then, one line per section, each "NAME: content", omitting empty sections — ` +
		`FACTS: <comma-joined observed facts that must survive>; ` +
		`DECISIONS: <decisions made, comma-joined>; ` +
		`DISPROVED: <claims found false, with the observed value>; ` +
		`EXPLORED-DISCARDED: <paths explored and dropped>; ` +
		`EVIDENCE: <verbatim output lines that must survive afterwards (e.g. MARKER lines), separated by semicolons>. ` +
		`Nothing else after the sections.`;
	return base.replace(/Reply exactly VERIFIED, or CORRECTIONS: <short list>, and nothing else\.$/, format);
}

/**
 * Builds the settlement line (Paul's Q1/Q3 shape, retrievalId first — the
 * pi-smart-compact `smart_context` "ID on line 1" convention):
 *   `<hash> VERIFIED: fact 1, fact 2, decision 3, disproved 4, explored and discarded 5`
 * (+ `, evidence: <…>` when present). The record's `sections` map carries
 * the full values (the line is the display + compaction-summary form).
 * Pure; verified stable byte-for-byte by the suite pin.
 */
export function settlementLine(retrievalId: string, verdictClass: string, sections: Record<string, string>): string {
	const parts: string[] = [];
	if (verdictClass === "CORRECTIONS" && sections["CORRECTIONS"]) parts.push(sections["CORRECTIONS"]);
	if (sections["FACTS"]) parts.push(sections["FACTS"]);
	if (sections["DECISIONS"]) parts.push(sections["DECISIONS"]);
	if (sections["DISPROVED"]) parts.push(`disproved: ${sections["DISPROVED"]}`);
	if (sections["EXPLORED-DISCARDED"]) parts.push(`explored and discarded: ${sections["EXPLORED-DISCARDED"]}`);
	if (sections["EVIDENCE"]) parts.push(`evidence: ${sections["EVIDENCE"]}`);
	const tail = parts.length > 0 ? `: ${parts.join(", ")}` : "";
	return `${retrievalId} ${verdictClass}${tail}`;
}

/** Description of the `sam_retrieve` tool (what the working model reads). */
export const SAM_RETRIEVE_TOOL = {
	name: "sam_retrieve",
	label: "sam_retrieve",
	description:
		"Retrieve the original content behind a SAM record, by retrieval id (the <hash> on a " +
		"settlement line, e.g. from a compaction summary) or by unit number as 'unit 3'. " +
		"Returns the audit (instruction + full verdict reply with reasoning) from its banked " +
		"side-branch file, or the raw session entries for a compacted span. Read-only: " +
		"it never modifies the session.",
	parametersDescription:
		"id: the retrieval hash (12-hex) or 'unit 3'; section: optional section " +
		"(FACTS, DECISIONS, DISPROVED, EXPLORED-DISCARDED, EVIDENCE) or AUDIT for the full reply.",
	promptSnippet: "sam_retrieve recovers the original content behind a SAM settlement hash (audit reply, compacted span)",
	promptGuidelines: [
		"Use sam_retrieve when a settlement line, compaction summary, or ledger record references a retrieval id and you need the original content.",
	],
} as const;

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

/**
 * close_unit tool description under the v4 `close` dial (v4-plan §5 S6 — the
 * house rule: protocol strings ship with their pinned tests + the design
 * note; the v3 CLOSE_UNIT_TOOL above stays byte-stable for the v3 dials, and
 * the glue picks the copy from the dial's env value at registration).
 */
export const CLOSE_UNIT_TOOL_V4 = {
	name: CLOSE_UNIT_TOOL.name,
	label: CLOSE_UNIT_TOOL.label,
	description:
		"Close a completed work unit. A unit is a self-contained chunk of work — a task or part of " +
		"one that can be summarized on its own (for example: one function, one bug fix, one file " +
		"exploration). Pass the stub: 1-4 sentences capturing what was done, with the key facts and " +
		"file/line references that must survive; cite what you observed (tool outputs, file contents), " +
		"not what the task claimed. Closing a unit starts the next one — several closes per turn are " +
		"normal; each close audits its own span (from the turn's opener for the first close, from the " +
		"previous close for the next). Closing runs its verification audit on a side session: the " +
		"session waits while it runs (like any slow tool), the audit exchange never appears in this " +
		"conversation, and the close is effective even if the audit is deferred (the one-line result " +
		"tells you which).",
	parametersDescription:
		"The stub for the closed unit: what was done and the observed facts that must survive.",
	promptSnippet:
		"close_unit closes a completed work unit with its stub (the audit runs synchronously on a side session; the unit stays in view until compaction)",
	promptGuidelines: [
		"Call close_unit when a self-contained work unit is done and before the context grows long.",
		"The stub must cite observed results (file:line, counts, errors), not the task's claims.",
		"Do not call close_unit while the unit's work is still in progress or over work you have not done yet.",
		"If the result says the audit was deferred and you want it re-run, call close_unit again with the same stub.",
	],
} as const;

/** close_unit result text (what the working model reads back) — the v3 dials
 *  (byte-stable; the `close` dial returns the v4-plan §14 one-liners from
 *  closeaudit.ts instead). */
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

/** v4 (`close` dial): the no-work-since-previous-close refusal (v4-plan §4 —
 *  replaces the v3 one-close-per-turn refusal under that dial). */
export const CLOSE_UNIT_NO_NEW_WORK_TEXT =
	"No new work since the previous close_unit, so there is nothing to close for this unit. " +
	"The previous close is effective; do the remaining work first, then call close_unit for this unit.";

/** v4 (`close` dial): the audit-fork identity refusal — this session is
 *  itself a side-branch audit; close_unit is not part of the auditor's job. */
export const CLOSE_UNIT_AUDIT_FORK_TEXT =
	"This session is a SAM side-branch audit in progress: close_unit is not available here. " +
	"Complete the audit reply as instructed.";

/** close_unit refusal for an empty stub over demonstrable work (P3 anti-self-sealing gate). */
export function emptyStubRefusalText(detail: string): string {
	return (
		`close_unit refused — ${detail}. ` +
		`Call close_unit again with a real stub (1-4 sentences citing observed results).`
	);
}

import type { SamMode } from "./state.ts";

/** Modes implementable in P2 (assisted/auto are P3). */
export const P2_MODES: readonly SamMode[] = ["display", "manual"];

/** Modes implementable in P3 (assisted sweep + auto escape hatch delivered). */
export const P3_MODES: readonly SamMode[] = ["display", "manual", "assisted", "auto"];

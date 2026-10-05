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
		`A claim the stub marks as intermediate and open — an assumption, a lead, or a suspected ` +
		`conflict, with its observed basis and what would verify it — is not itself a correction; ` +
		`audit it for the marking (clearly open, named basis, verify pointer), not for whether the ` +
		`assumption holds. ` +
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
		`FACTS: <each observed fact that must survive, ONE ITEM PER LINE>; ` +
		`DECISIONS: <each decision made, ONE ITEM PER LINE>; ` +
		`DISPROVED: <each claim found false, with the observed value, one per line>; ` +
		`EXPLORED-DISCARDED: <each path explored and dropped, one per line>; ` +
		`EVIDENCE: <verbatim output lines that must survive afterwards (e.g. MARKER lines), one per line>. ` +
		`(the post-compaction summary renders each of these lines as its own bullet point — one item per line is the contract) ` +
		`Nothing else after the sections.`;
	return base.replace(/Reply exactly VERIFIED, or CORRECTIONS: <short list>, and nothing else\.$/, format);
}

/**
 * D8 (2026-10-02, decided by Paul — the LIGHT audit) — the instruction for
 * a close inside the band (\u2265 W−2R, near the compaction line). Contract
 * (Paul's words + labelled synthesis): ONE TURN, ZERO TOOL CALLS; it "just
 * checks that filenames and statements have been delivered, not verify
 * them all"; claims the stub marks open STAY open; every claim not marked
 * open is NOT YET VERIFIED; it may "burn through the last 16k of context
 * that usually are reserved for pi-compaction" (the child window is the
 * full slot; the child is disposable — compaction inside it is
 * cancelable, the child is used no further after the audit); it is NOT a
 * fold-avoidance mechanism (synthesis — vetoable).
 *
 * Wording = pins (house rule): this string ships with its test pins and is
 * vetoable by its owner (reword = pin rewrite).
 */
export function lightAuditInstruction(unitId: number, payload?: SamAuditPayload): string {
	const stub = payload?.stub?.trim();
	const ev = payload?.evidence;
	const facts = ev
		? [
				`files: ${(ev.files ?? []).length === 0 ? "(none observed)" : (ev.files ?? []).join(", ")}`,
				`errors: ${ev.errors ?? 0}`,
				`retries: ${ev.retries ?? 0}`,
				`non-trivial work: ${ev.nonTrivial ? "yes" : "no"}`,
			].join(" \u00b7 ")
		: null;
	return (
		`${AUDIT_INSTRUCTION_PREFIX} Unit ${unitId} was just closed. LIGHT AUDIT: the session is near the ` +
		`compaction line, so this is ONE turn and you make NO tool calls \u2014 no file reads, nothing executed; ` +
		`work only from what this session already shows. ` +
		`Check DELIVERY, not correctness: (1) that the files and outputs named in the stub and the recorded ` +
		`close facts are present in the unit's record above; (2) that the stub's statements are the delivered ` +
		`statements of the unit. ` +
		`Do NOT re-verify the content of any claim. ` +
		`A claim the stub marks as intermediate and open (an assumption, a lead, a suspected conflict) STAYS open. ` +
		`Every claim that is not marked open is NOT YET VERIFIED. ` +
		(stub ? `\nSTUB (verbatim):\n${stub}\n` : "") +
		(facts ? `RECORDED AT CLOSE (system-extracted from the span): ${facts}. ` : "") +
		`If the unit's entries are no longer in view, this instruction is self-contained: the raw span is ` +
		`preserved verbatim in this session's file (find the sam close record for Unit ${unitId}), and you may ` +
		`note that in the delivery check. ` +
		`Reply exactly NOT-YET-VERIFIED: \u003cfiles: \u003cdelivered\u003e/\u003ctotal\u003e present; statements: delivered\u003e, and nothing else.`
	);
}

/**
 * D9 (2026-10-02, decided by Paul — the audit-failure hatch): the section
 * names of the SYNTHESIZED settlement (built by the extension when the
 * audit failed completely — there is no auditor reply to parse). The
 * content survives channel A exactly as described in the decision: "it
 * would still hold the filenames, dates, hashes and whatever the model
 * summarized" — that is the STUB + the RECORDED AT CLOSE evidence (the
 * close record is the source; nothing is re-derived). The status carries
 * the model's instruction: claims are UNVERIFIED — "verify before
 * acting". (My naming — flagged, vetoable: `UNVERIFIED-AUDIT-FAILED`.)
 */
export const WEAK_SETTLEMENT_SECTION_NAMES = ["STUB", "FILES", "REASON"] as const;

/**
 * Builds the settlement line (Paul's Q1/Q3 shape, retrievalId first — the
 * pi-smart-compact `smart_context` "ID on line 1" convention):
 *   `<hash> VERIFIED: fact 1, fact 2, decision 3, disproved 4, explored and discarded 5`
 * (+ `, evidence: <…>` when present). The record's `sections` map carries
 * the full values (the line is the display + compaction-summary form).
 * Pure; verified stable byte-for-byte by the suite pin.
 */
export function settlementLine(retrievalId: string, verdictClass: string, sections: Record<string, string>): string {
	// D8/D9 (2026-10-02): the two new settlement classes carry their own
	// shapes — the must-survive content is the audit object itself (the
	// delivery note / the model's summary), not the five audit sections.
		if (verdictClass === "NOT-YET-VERIFIED") {
		const note = sections["NOT-YET-VERIFIED"] ?? "";
		// D11 batch (2026-10-02): the weak line carries the STUB when the record
		// has one (content survival — the D9-hatch parity: "so the summary does
		// not get lost"); records without one (v3-era / pre-batch) keep the old
		// shape byte-identical (backward compatible).
		const stub = sections["STUB"] ?? "";
		const parts: string[] = [];
		if (stub !== "") parts.push(stub);
		if (note !== "") parts.push(note);
		const head = parts.length > 0 ? `NOT-YET-VERIFIED: ${parts.join(" · ")}` : "NOT-YET-VERIFIED";
		return `${retrievalId} ${head} — unmarked claims: verify before acting`;
	}
	if (verdictClass === "UNVERIFIED-AUDIT-FAILED") {
		const parts: string[] = [];
		if (sections["STUB"]) parts.push(sections["STUB"]);
		if (sections["FILES"]) parts.push(`files: ${sections["FILES"]}`);
		if (sections["REASON"]) parts.push(`audit failed (${sections["REASON"]})`);
		const tail = parts.length > 0 ? `: ${parts.join(", ")}` : "";
		return `${retrievalId} UNVERIFIED-AUDIT-FAILED${tail} — claims UNVERIFIED: verify before acting`;
	}
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

/**
 * D11 (2026-10-02, DECIDED by Paul — goal persistence): the goal tools.
 * Soft expectation (Paul: "soft is what we want") — the model decides when a
 * goal update is appropriate; the deterministic takeover fallback is the
 * safety net. Wording = pins (house rule): these strings ship with their
 * test pins; reword = pin rewrite.
 */
export const ADJUST_GOAL_TOOL = {
	name: "adjust_goal",
	label: "adjust_goal",
	description:
		"Set or update the stored goal — the current objective, its scope, and the standing constraints " +
		"(acceptance criteria, permissions, any ask-me rules, and the open questions already agreed). " +
		"Call it as soon as the goal is clear: at the first user input, and after every change — steering " +
		"and answer rounds included — so the stored version always reflects the current agreement. " +
		"Each call REPLACES the previous version (latest wins; earlier versions stay in the session ledger — " +
		"read_goal lists them). The stored goal rides every compaction: it appears at the head of the " +
		"post-compaction summary, before the session content. To settle the goal as an audited fact, close it " +
		"with close_unit as a unit — the goal block itself is not audited.",
	parametersDescription:
		"goal: the FULL current goal (objective, scope, constraints, agreed open questions) — " +
		"a replacement, not a patch.",
	promptSnippet: "adjust_goal stores the current goal verbatim (replaces earlier versions; rides every compaction)",
	promptGuidelines: [
		"Call adjust_goal as soon as the goal is clear — the first user input and after every change (steering, answer rounds) — before closing units against it.",
		"Pass the whole current goal in one call: it replaces the stored version, it does not patch it.",
		"Before overwriting a stored goal, re-read it with read_goal so nothing important is lost.",
	],
} as const;

export const READ_GOAL_TOOL = {
	name: "read_goal",
	label: "read_goal",
	description:
		"Read the stored goal verbatim: the current (latest) version, when it was stored and how " +
		"(adjust_goal, or the takeover fallback — which means adjust_goal was never called), plus the " +
		"earlier versions still kept in the session ledger (time + how). Use it before overwriting the " +
		"goal (adjust_goal replaces, it does not append) so you can modify accordingly without dropping " +
		"important wording, and after a compaction to re-confirm what the goal is.",
	promptSnippet: "read_goal returns the stored goal verbatim (latest version, with the version history)",
	promptGuidelines: [
		"Read the goal before changing it; read it after any compaction to re-confirm it.",
	],
} as const;

/** `adjust_goal` result one-liner (what the working model reads back). Wording = pins. */
export function adjustGoalResultText(version: number): string {
	return (
		`Goal stored (version ${version}; latest wins — earlier versions stay in the ledger, listable via read_goal). ` +
		`The goal rides every compaction as the first block of the post-compaction summary. ` +
		`If it should settle as an audited fact, close it with close_unit as a unit.`
	);
}

/**
 * v5 RETIRE (2026-10-06, Paul): the retirement/upgrade tools.
 * RETIRE_UNITS_TOOL: bookkeeping-only (the curated content rides the NEW
 * unit's own close_unit stub — a normal close, audited like any close);
 * UNRETIRE_TOOL: the soft-reversal (retirement never deletes — the session
 * ledger + the banked sidecars are immutable; only the post-compaction
 * render changes). Wording = pins.
 */
export const RETIRE_UNITS_TOOL = {
	name: "retire_units",
	label: "retire_units",
	description:
		"Retire old settled units so they stop re-appearing at every fold — SOFT: nothing is deleted " +
		"(every retired unit stays retrievable via sam_retrieve <id>, listable via /sam, and restorable " +
		"via unretire); only the post-compaction summary render changes. TWO ways, one call, mixed routing: " +
		"(1) UPGRADE — superseded:[unit ids] + supersededBy:<the NEW unit id>: you FIRST write a normal " +
		"close_unit whose STUB deliberately carries over only what still matters from those units " +
		"(e.g. 2 files and a fact from u1, one open question from u2, most of u4 — that new unit is " +
		"audited like any close and gains a 'supersedes: …' line), THEN call retire_units with the old ids + " +
		"that unit's id; (2) DROP — dropped:[unit ids]: complete retirement (no content carried anywhere). " +
		"Leave units you still need ALONE (name them in NEITHER list). Use it when a retire offer fired " +
		"(after the first close following a fold, the settlement stack is large), or whenever you judge old " +
		"units stale — working on settled facts is ground truth; do not re-derive old work.",
	promptSnippet:
		"retire_units retires old settled units SOFT (retrievable + restorable): UPGRADE them into a new curated close_unit (superseded + supersededBy) or DROP them outright (dropped); unsuperseded unit ids stay untouched",
	promptGuidelines: [
		"The new unit's close_unit stub carries the selected content; retire_units only links/drops.",
		"supersededBy is required when superseded is non-empty; a bad id refuses the WHOLE call (atomic — nothing is committed).",
	],
} as const;

export const UNRETIRE_TOOL = {
	name: "unretire",
	label: "unretire",
	description:
		"Restore previously retired unit(s) to the post-compaction summary (the reversal of retire_units). " +
		"Retirement was soft — the summaries were never deleted (sam_retrieve served them all along), so " +
		"unretire only removes the retirement mark (latest-wins per unit); from the next fold the unit(s) " +
		"render in full again.",
	promptSnippet: "unretire restores retired units to the summary (soft reversal — nothing was ever deleted)",
	promptGuidelines: ["Use it when a retirement was a mistake or the unit becomes relevant again."],
} as const;

/** `retire_units` ack (what the model reads back). Wording = pins. */
export function retireAckText(superseded: readonly number[], supersededBy: number | undefined, dropped: readonly number[]): string {
	const parts: string[] = [];
	if (superseded.length > 0) parts.push(`superseded by u${supersededBy}: ${superseded.map((u) => `u${u}`).join(", ")}`);
	if (dropped.length > 0) parts.push(`dropped: ${dropped.map((u) => `u${u}`).join(", ")}`);
	return (
		`Retired — ${parts.join(" · ")} — effective from the next summary (older folded summaries already written are history); ` +
		`every retired unit stays retrievable (sam_retrieve <id>) and restorable (unretire).`
	);
}

/** `retire_units` refusal (atomic — nothing was committed). Wording = pins. */
export function retireRefuseText(why: string): string {
	return `Retire REFUSED: ${why} — nothing changed (no retirement was committed).`;
}

/** `unretire` ack. Wording = pins. */
export function unretireAckText(units: readonly number[]): string {
	return `Unretired: ${units.map((u) => `u${u}`).join(", ")} — back in the summary from the next fold (retirement was soft — nothing was deleted).`;
}

/** `read_goal` with no goal stored yet (guides the model to set one). Wording = pins. */
export const READ_GOAL_NO_GOAL_TEXT =
	"No goal stored yet. If the goal is clear, set it now with adjust_goal — " +
	"it will then ride every compaction and be retrievable at any point with read_goal.";

/** Goal tools on a side-branch audit (the rogue-auditor guard, goal family). Wording = pins. */
export function goalToolAuditForkText(tool: "adjust_goal" | "read_goal"): string {
	return `This session is a SAM side-branch audit in progress: ${tool} is not available here. Complete the audit reply as instructed.`;
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
 *
 * S6 iteration (banked from the 2026-10-01 reference run, dev-repo banks
 * `run-outputs/sam-close-ref-settled-2026-10-01/` + `run-baseline-sam-close-ref-2026-10-01.md`);
 * the "self-contained chunk" phrasing of the first v4 draft is superseded by
 * the sharper "checkable deliverable" definition.
 *
 * S7 iteration (wording of record 2026-10-01 eve — Paul's draft, implemented
 * as drafted; provenance = the TWO live close-dial runs (settled reference
 * run + `sam-small-units`, both without self-partitioning the
 * collect/patch phase — the S6 anti-batch clause had no live supporter) +
 * the D7 nudge design (dev-repo `329a96f`)):
 * a unit is (a) one checkable deliverable OR (b) a substantial finding or
 * question after multiple tool calls + reasoning turns (a discovery, a user
 * decision, a claim, a new finding needing verification — this is what makes
 * a collection phase closable by definition, the measured gap of both runs);
 * findings derived but not yet verified are marked "intermediate and open"
 * (the assumed-interface-mismatch example is Paul's live case);
 * the survival promise is stated ("key facts and datapoints of closed units
 * will survive a compaction"); the explicit "do not batch" line is out of
 * the description (kept in guideline 1); three mechanical fixes disclosed on
 * the first landing ("stores"→"store", "to"→"two" interfaces, one dangling
 * colon → period — any revertible).
 *
 * S7.1 (same day — agent grammar/semantic pass under Paul's explicit
 * mandate: fix minor grammar/semantic slips, the DIRECTION (the new category
 * for derived, open questions/assumptions/leads) is invariant; ALL CHANGES
 * DISCLOSED, VETOABLE): the two example lists attach to THEIR category
 * (either/or skeleton kept; the dangling list becomes appositives);
 * "Your stated" off the survival promise (it is the SYSTEM's promise to the
 * model); the new epistemic status is NAMED (assumptions, leads, suspected
 * conflicts) and its stub contract sharpened: "mark them as intermediate and
 * open, never as settled — and name the claim, the basis you observed, and
 * what would verify it"; the audit instruction now audits marked claims for
 * the MARKING, not the assumption's truth (auditInstruction below); guideline
 * 2 gains the escape clause for marked assumptions; the example names what
 * exactly seems to contradict (the checkable core of a lead); the nudge's
 * `context` text aligns to category (b) (nudge.ts).
 */
export const CLOSE_UNIT_TOOL_V4 = {
	name: CLOSE_UNIT_TOOL.name,
	label: CLOSE_UNIT_TOOL.label,
	description:
		"Close a completed work unit and store its intermediate summary. " +
		"Key facts and datapoints of closed units will survive a compaction. " +
		"Keep the stored goal current (D11): when the goal is (re)clear — the first user input, or a change " +
		"such as steering or an answer round — call adjust_goal with the current goal BEFORE closing units " +
		"that depend on it; the goal rides every compaction as the first summary block. " +
		"A unit is either one checkable deliverable — a task, or one checkable piece of it " +
		"(a verified-and-reconciled doc pair, a resolved conflict, an updated section, a function, " +
		"a bug fix) — or a substantial finding or question after multiple tool calls and reasoning " +
		"turns: a discovery, a user decision, a claim, a new finding that needs further verification. " +
		"Close it as it completes: closing is a checkpoint, not the end — open questions may stay " +
		"open; record them in the stub as open, never as resolved. " +
		"Pass the stub: 1-4 sentences capturing what was done AND what was checked, with the key " +
		"facts and file/line references that must survive; cite what you observed (tool outputs, " +
		"file contents), not what the task claimed — the reconciliation reasoning (what you verified, " +
		"what you left open) is precisely what the audit verifies. " +
		"For findings you derived, but could not yet verify (assumptions, leads, suspected conflicts), " +
		"mark them as intermediate and open, never as settled — and name the claim, the basis you " +
		"observed, and what would verify it. " +
		"Example: an assumed mismatch between two interfaces in code — name the files or sources " +
		"involved and what exactly seems to contradict. " +
		"Closing a unit starts the next one — several closes per turn are normal; each close " +
		"audits its own span (from the turn's opener for the first close, from the previous close " +
		"for the next). Closing runs its verification audit on a side session: the session waits " +
		"while it runs (like any slow tool), the audit exchange never appears in this " +
		"conversation, and the close is effective either way \u2014 the one-line result tells you which. " +
		"Two audit outcomes besides VERIFIED / CORRECTIONS: near pi's compaction line the audit runs " +
		"LIGHT (one turn, no tools) and the result is NOT-YET-VERIFIED \u2014 the stub and its evidence " +
		"settle as-is and every claim not marked open is marked \u2018verify before acting\u2019; and if the " +
		"audit fails entirely the close settles as UNVERIFIED (audit-failed) \u2014 the summary survives " +
		"with its claims marked \u2018verify before acting\u2019, and the same-stub re-close (or /sam reaudit) " +
		"upgrades it.",
	parametersDescription:
		"The stub for the closed unit: what was done and what was checked, with the observed facts that must survive.",
	promptSnippet:
		"close_unit closes a completed work unit with its stub (the audit runs synchronously on a side session; the unit stays in view until compaction)",
	promptGuidelines: [
		"Call close_unit when a unit's deliverable is done and checked — as it completes, before the context grows long; do not batch several deliverables into one close.",
		"Keep the goal stored as current as the work: adjust_goal as soon as the goal is clear and after every change (steering, answer rounds), before closing units that depend on it.",
		"The stub must cite observed results (file:line, counts, errors) and the checks that established them, not the task's claims — except for claims marked intermediate and open: name the claim, the basis you observed, and what would verify it.",
		"A close is a checkpoint, not the end: open questions stay open — state them as open in the stub.",
		"Do not call close_unit while the unit's work is still in progress or over work you have not done yet.",
		"If the result says the audit is UNVERIFIED (audit-failed) or NOT-YET-VERIFIED (light, near the fold) and you want it upgraded, call close_unit again with the same stub.",
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

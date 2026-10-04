/**
 * P5 branch-audit — pure logic (no pi, no fs in the parse family; the file
 * reader is the single fs touchpoint and is total: unreadable ⇒ the settle
 * is refused, never throws into the session).
 *
 * Design: dev repo `2026-09-30-p5-branch-audit.md` (v2, decisions absorbed
 * 2026-09-30 night). Flow: close (main line) → `/sam audit <unit>` command
 * forks the session at the current leaf (position "at" — the FULL unit
 * context, incl. the last assistant line, is on the fork), delivers
 * `branchAuditInstruction` on the FORK, waits for the reply, switches back;
 * the main session's next settle captures the verdict FROM THE FORK FILE
 * (this module), appends the settlement record (retrievalId + digest) and
 * commits the terminal through the UNCHANGED R3 gate/proof machinery.
 *
 * Invariants this file protects:
 * - the main session file never contains the `[sam-audit]` instruction or
 *   the audit reply (the battery asserts exactly that);
 * - verdict parseability: line 1 stays the R2 contract (VERIFIED /
 *   CORRECTIONS: …) so parseVerdict-based consumers keep working;
 * - settlement idempotence (a second settle for the same unit is a no-op —
 *   the double-settle trap of a flaky switch-back);
 * - retrieval: the retrievalId is a stable content sha (12 hex) over
 *   (auditFile + verdict-leaf id + reply text) — resolvable from the
 *   settlement record alone (sam_retrieve / compaction-takeover summary).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { parseVerdict, assistantText, type Verdict } from "./verdict.ts";
import { BRANCH_AUDIT_SECTION_NAMES, AUDIT_INSTRUCTION_PREFIX, settlementLine } from "./protocol.ts";
import { SAM_LEDGER_CUSTOM_TYPE } from "./ledger.ts";
import { goalBlock, softWrap, stripGoalBlock, type SamGoalRecord } from "./goal.ts";

/* ── raw entry view (pi's session-file shape; total over unknown types) ── */
export interface RawEntry {
	id: string;
	parentId?: string | null;
	type: string;
	message?: { role?: string; content?: unknown; stopReason?: unknown } | undefined;
	customType?: string;
	data?: unknown;
	summary?: string;
}

/**
 * Lenient reader for a pi session file (NDJSON, as measured on the live
 * banks — one JSON entry per line; a JSON array is tolerated too).
 * Unreadable / unparseable ⇒ [] (total: the settle refuses on empty).
 */
export function readRawSessionFile(filePath: string): RawEntry[] {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const trimmed = text.trim();
	if (trimmed === "") return [];
	try {
		const arr = JSON.parse(trimmed);
		if (Array.isArray(arr)) return arr as RawEntry[];
	} catch {
		// not a JSON array ⇒ try NDJSON
	}
	const out: RawEntry[] = [];
	for (const line of trimmed.split("\n")) {
		const t = line.trim();
		if (t === "") continue;
		try {
			out.push(JSON.parse(t) as RawEntry);
		} catch {
			// skip the bad line (total)
		}
	}
	return out;
}

export function entryText(e: RawEntry): string {
	if (e.type === "message" && e.message) {
		return assistantText((e.message.content ?? "") as string | unknown[]);
	}
	if (e.type === "compaction") return e.summary ?? "";
	if (e.type === "custom" && e.data !== undefined) {
		try {
			return JSON.stringify(e.data);
		} catch {
			return "";
		}
	}
	return "";
}

export function isAssistantMessage(e: RawEntry): boolean {
	return e.type === "message" && e.message?.role === "assistant";
}

export function isUserMessage(e: RawEntry): boolean {
	return e.type === "message" && e.message?.role === "user";
}

/* ── audit-instruction text (a user message with the SAM audit prefix) ── */

export interface AuditTurn {
	unitId: number;
	instructionId: string;
	replyId: string | undefined;
	replyText: string;
	/** 2026-10-04 (F-12 class): the stopReason of the LAST assistant entry
	 * after the instruction (the turn the audit ended on — the child's own
	 * session file carries it; measured F-12 u4 ×2: "length"). Undefined
	 * when no assistant entry followed the instruction. Used ONLY for the
	 * missing-reply class split (closeaudit.ts `missingAuditReplyClass`);
	 * a present reply is graded on the verdict contract unchanged. */
	lastAssistantStopReason?: string;
}

/**
 * Finds the LAST `[sam-audit] Unit N` instruction on an entry list and the
 * first assistant message after it (the verdict reply). Returns undefined
 * when no instruction is present (the settle must then refuse — F1: no
 * capture from a branch that has no audited turn).
 */
export function findLastAuditTurn(entries: readonly RawEntry[]): AuditTurn | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!isUserMessage(e)) continue;
		const text = (e as { message?: { content?: unknown } }).message?.content;
		const t = typeof text === "string" ? text : Array.isArray(text) ? text.map((b) => (b && typeof b === "object" && "text" in (b as object) ? String((b as { text: unknown }).text) : "")).join("") : "";
		if (!t.startsWith(AUDIT_INSTRUCTION_PREFIX)) continue;
		const m = t.slice(AUDIT_INSTRUCTION_PREFIX.length).match(/^\s*Unit\s*(\d+)/);
		if (!m) continue;
		let replyId: string | undefined;
		let replyText = "";
		let lastStopReason: string | undefined;
		// The reply is the LAST non-empty assistant entry after the instruction
		// (and before the next user turn). Live measurement (rep-1, banked): the
		// auditor legitimately works with tool calls between instruction and reply
		// (the instruction permits reading the raw span), so the first assistant
		// entry is often a thinking/toolCall step with no text — skipping empties
		// and keeping the last non-empty one is the correct final-reply semantics.
		// (Walk mocks answer in a single text assistant, where this is identical.)
		for (let j = i + 1; j < entries.length; j++) {
			if (isAssistantMessage(entries[j])) {
				// Last-turn observation (F-12 class, 2026-10-04): how the audit
			// ENDED — the child's own measured stopReason, for the no-reply
			// deferral site in the close pipeline (a reply, once present, is
			// graded on the verdict contract unchanged).
				const sr = (entries[j].message as { stopReason?: unknown })?.stopReason;
				if (typeof sr === "string") lastStopReason = sr;
				const content = (entries[j].message as { content?: unknown })?.content;
				const text = content !== undefined ? assistantText(content as string | unknown[]) : "";
				if (text.trim() !== "") {
					replyId = entries[j].id;
					replyText = text;
				}
				// empty assistant = tool-call step or a pi-banked empty message
				// (500-retry shape) — not a reply; keep scanning
				continue;
			}
			if (isUserMessage(entries[j])) break; // a later user turn interrupted — no clean reply
		}
		return { unitId: parseInt(m[1], 10), instructionId: e.id, replyId, replyText, ...(lastStopReason !== undefined ? { lastAssistantStopReason: lastStopReason } : {}) };
	}
	return undefined;
}

/* ── the structured reply (line 1 verdict + section lines) ── */

export interface BranchAuditParse {
	verdict: Verdict;
	sections: Record<string, string>;
	/** true when every line is accounted for (line 1 + known sections). */
	parsedClean: boolean;
}

/**
 * Staged capture of a completed branch audit (set by the /sam audit command
 * on the fork, and by the session_start backstop after a switch-back).
 * Consumed exactly once by the settle step-2 branch path.
 */
export interface BranchAuditStaged {
	unitId: number;
	auditFile: string;
	replyId: string;
	replyText: string;
}

/**
 * Parses the branch-audit reply. Line 1: the R2 verdict contract (so
 * VERIFIED / CORRECTIONS-classification is byte-identical to parseVerdict).
 * Remaining lines: `NAME: content` for the five known section names; a
 * section's content spans until the next known section name or EOF (EVIDENCE
 * may be long). Unknown lines do NOT fail the parse (tolerant — the verdict
 * is what gates; parsedClean reports whether anything unexplained showed up).
 */
export function parseBranchAuditReply(reply: string): BranchAuditParse {
	const lines = (reply ?? "").replace(/\r\n/g, "\n").split("\n");
	const first = (lines[0] ?? "").trim();
	const verdict = parseVerdict(first);
	const sections: Record<string, string> = {};
	let parsedClean = true;
	// CORRECTIONS: the list continues on line 1 (the R2 shape).
	if (verdict.class === "CORRECTIONS") sections["CORRECTIONS"] = verdict.corrections ?? "";
	const known = new Set<string>([...BRANCH_AUDIT_SECTION_NAMES, "CORRECTIONS"]);
	let current: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") continue;
		const m = line.match(/^([A-Za-z0-9_\-]+)\s*:\s?([\s\S]*)$/);
		const name = m ? m[1].toUpperCase() : null;
		if (name && known.has(name)) {
			current = name === "CORRECTIONS" ? "CORRECTIONS" : name;
			sections[current] = (m ? m[2] : "").trim();
		} else if (current !== null) {
			sections[current] = `${sections[current]}\n${line.trim()}`;
		} else if (parsedClean) {
			parsedClean = false; // an unexplained line outside a section
		}
	}
	return { verdict, sections, parsedClean };
}

/* ── retrieval id + settlement record ── */

/**
 * Stable retrieval id (12 hex): sha256 over auditFile + verdict-leaf id +
 * reply text (the exact bytes the model produced on the fork). Deterministic
 * ⇒ the settlement record is self-resolving (sam_retrieve needs nothing but
 * the record; the banked files carry the rest).
 */
export function retrievalIdOf(auditFile: string, replyId: string, replyText: string): string {
	const h = createHash("sha256");
	h.update(auditFile);
	h.update("\0");
	h.update(replyId ?? "");
	h.update("\0");
	h.update(replyText ?? "");
	return h.digest("hex").slice(0, 12);
}

/** The settlement ledger record (a `sam` custom entry, kind "settlement").
 * D8/D9 (2026-10-02): the verdict union gains the light rung
 * (`NOT-YET-VERIFIED`) and the audit-failure hatch (`UNVERIFIED-AUDIT-FAILED`);
 * `supersedes` names the retrieval id a later (upgrade) settlement replaces
 * — upgrades APPEND (the session journal is append-only), and the takeover
 * consumer keeps the latest-per-unit (latest-wins). */
export interface SamSettlementRecord {
	v: 1;
	kind: "settlement";
	unitId: number;
	retrievalId: string;
	/** D8/D9: + NOT-YET-VERIFIED (light) / UNVERIFIED-AUDIT-FAILED (hatch) */
	verdict: "VERIFIED" | "CORRECTIONS" | "NOT-YET-VERIFIED" | "UNVERIFIED-AUDIT-FAILED" | "UNAUDITABLE";
	sections: Record<string, string>;
	line: string;
	auditFile: string;
	replyId: string | null;
	parsedClean: boolean;
	/** D9 upgrade path: the retrieval id this settlement supersedes (if any) */
	supersedes?: string;
	ts: number;
	/** D11 batch (2026-10-02): the STUB for weak settlements (content survival —
	 *  "so the summary does not get lost"; the D9-hatch parity). Optional: pre-batch
	 *  records and the v3 dial never carry one (their line shape stays byte-stable). */
	stub?: string;
}

export function buildSettlementRecord(
	unitId: number,
	auditFile: string,
	replyId: string | undefined,
	replyText: string,
	timestamp?: number,
	stub?: string,
): SamSettlementRecord | undefined {
	if (replyId === undefined) return undefined; // no audited reply ⇒ no settlement (refuse)
	const parse = parseBranchAuditReply(replyText);
	const id = retrievalIdOf(auditFile, replyId, replyText);
	const sections: Record<string, string> = { ...parse.sections };
	// D8: the light rung's delivery note rides the record (sections map +
	// line), so retrieve/settlement-line/takeover all carry it.
	if (parse.verdict.class === "NOT-YET-VERIFIED" && parse.verdict.note !== undefined) {
		sections["NOT-YET-VERIFIED"] = parse.verdict.note;
	}
	// D11 batch (2026-10-02): the weak (light) settlement carries the STUB from
	// the close record (content survival — the model's summary must not be lost
	// in the post-compaction context); strong settlements are unchanged.
	if (stub !== undefined && stub.trim() !== "" && parse.verdict.class === "NOT-YET-VERIFIED") {
		sections["STUB"] = stub.trim();
	}
	return {
		v: 1,
		kind: "settlement",
		unitId,
		retrievalId: id,
		verdict: parse.verdict.class,
		sections,
		line: settlementLine(id, parse.verdict.class, sections),
		auditFile,
		replyId,
		parsedClean: parse.parsedClean,
		ts: timestamp ?? Date.now(),
		...(stub !== undefined && stub.trim() !== "" && parse.verdict.class === "NOT-YET-VERIFIED" ? { stub: stub.trim() } : {}),
	};
}

/**
 * D9 (2026-10-02, the audit-failure hatch): the SYNTHESIZED settlement —
 * the audit failed completely (spawn/timeout/handoff/unparseable, whatever
 * the reason), so there is no auditor reply to settle. Paul's contract:
 * the model's summary is treated as UNVERIFIED, its claims as "must be
 * verified before acted upon", yet it SETTLES — "it would still hold the
 * filenames, dates, hashes and whatever the model summarized" (that is the
 * STUB + the RECORDED AT CLOSE file list, straight from the close record —
 * nothing re-derived). Deterministic retrieval id over the close identity
 * + failure reason (stable across retries of observation; the content is
 * the line's job). */
export function weakRetrievalIdOf(unitId: number, stub: string, reason: string): string {
	const h = createHash("sha256");
	h.update("sam-weak-settlement\0");
	h.update(String(unitId));
	h.update("\0");
	h.update(stub ?? "");
	h.update("\0");
	h.update(reason ?? "");
	return h.digest("hex").slice(0, 12);
}

export function weakSettlementRecord(
	unitId: number,
	stub: string,
	files: readonly string[],
	reason: string,
	timestamp?: number,
): SamSettlementRecord {
	const sections: Record<string, string> = {
		STUB: stub,
		FILES: (files ?? []).join(", "),
		REASON: reason,
	};
	const id = weakRetrievalIdOf(unitId, stub, reason);
	return {
		v: 1,
		kind: "settlement",
		unitId,
		retrievalId: id,
		verdict: "UNVERIFIED-AUDIT-FAILED",
		sections,
		line: settlementLine(id, "UNVERIFIED-AUDIT-FAILED", sections),
		auditFile: "", // no auditor reply exists — the close record is the evidence
		replyId: null,
		parsedClean: false,
		ts: timestamp ?? Date.now(),
	};
}

/* ── settle guards (idempotence + eligibility), raw-entry level ── */

export interface SettleEligibility {
	ok: boolean;
	unitId: number;
	reason: string;
}

const SAM_LEDGER_TYPE_NOTE = "ledger record entries carry a customType containing 'ledger' (the exact constant lives with the extension entry point; this raw-level view matches by substring)";
void SAM_LEDGER_TYPE_NOTE;

/**
 * Determines whether the main session (given its raw entries + the unit id
 * from the audit turn) may settle THIS audit turn:
 * - the main line has a close record for the unit (the audit is for a real close);
 * - the main line has NO `[sam-audit]` instruction of its own (the audit really
 *   ran on the side branch — a main-line audit settles through the normal
 *   settle path instead);
 * - the main line has NO settlement/resolve record for the unit yet
 *   (idempotence — a flaky switch-back must not double-commit).
 * The audit file and main file are compared by the caller (they must
 * differ — a same-file "side branch" is the in-series shape).
 */
export function settleEligible(mainEntries: readonly RawEntry[], auditFile: string, mainFile: string, unitId: number): SettleEligibility {
	if (auditFile === mainFile) {
		return { ok: false, unitId, reason: "same-file audit (in-series shape settles through the normal path)" };
	}
	let closeFound = false;
	let mainLineAudit = false;
	let settled = false;
	for (const e of mainEntries) {
		if (e.type === "custom" && e.customType === SAM_LEDGER_CUSTOM_TYPE) {
			const data = e.data as { kind?: unknown; unitId?: unknown } | undefined;
			const kind = typeof data?.kind === "string" ? data.kind : undefined;
			const uid = typeof data?.unitId === "number" ? data.unitId : undefined;
			if (uid === unitId && kind === "close") closeFound = true;
			if (uid === unitId && (kind === "settlement" || kind === "resolve")) settled = true;
		}
		if (isUserMessage(e)) {
			const t = entryText(e);
			if (t.startsWith(AUDIT_INSTRUCTION_PREFIX)) mainLineAudit = true;
		}
	}
	if (!closeFound) return { ok: false, unitId, reason: "no close record for the unit on the main line" };
	if (settled) return { ok: false, unitId, reason: "already settled (idempotence)" };
	if (mainLineAudit) return { ok: false, unitId, reason: "main line carries an audit instruction (use the normal settle path)" };
	return { ok: true, unitId, reason: "eligible" };
}

/* ── compaction takeover (Q3: the digest rides the compaction) ── */

/**
 * True when the branch carries a settlement record — the D11-batch takeover
 * gate is STATE-LEVEL (goal on the branch OR settlement on the branch; D11(5),
 * Paul's ruling: the trigger is the branch state, not the summarized span —
 * this is what fixes the fold-2 corner while preserving the control arm:
 * a branch with NEITHER goal nor settlements goes through pi's own
 * summarization untouched, the arm-C shape unchanged).
 */
export function spanHasSettlement(entries: readonly RawEntry[]): boolean {
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
		const data = e.data as { kind?: unknown } | undefined;
		if (data?.kind === "settlement") return true;
	}
	return false;
}

/**
 * D11 batch (2026-10-02) — the re-formatted takeover summary: goal block
 * FIRST (D11, Paul: "the goal gets inserted before session content after
 * compaction"; latest version replaces earlier ones — the old goal block is
 * stripped from the carried previous summary via its pinned shape), then the
 * carried previous summary (pi convention), then one block per settlement
 * (unit-numbered, ALWAYS-LABELLED sections — the v1 flat comma-stream is
 * gone: the measured run-03 complaint "each settlement line = one unbroken
 * prose block; no lists/headers"), then the pointer (pinned).
 */

/** Pinned: the settlements-block header. */
export const SETTLEMENTS_HEADER = "SAM settlement record(s) for the compacted span(s), verbatim (original retrievable with sam_retrieve <id>):";

/** Pinned: the takeover pointer (tail of every takeover summary). */
export const TAKEOVER_POINTER =
	"(earlier context summarized by pi-self-aware-memory; the blocks above carry the stored goal and the audited facts — retrieve the originals with sam_retrieve <id>)";

/** Indented soft wrap (the section value under a 2-space label; no content change). */
function wrapIndented(value: string, indent = "  ", width = 96): string {
	const wrapped = softWrap(value, width - indent.length).split("\n");
	return wrapped.map((l, i) => (i === 0 || l === "" ? l : indent + l)).join("\n");
}

/**
 * Renders ONE settlement as its summary block. Labelled sections in
 * canonical order (the auditor's reply contract: omit empty sections),
 * verbatim content (soft-wrapped for display only). Weak (light)
 * settlements carry the STUB (D11 batch — content survival) + the delivery
 * note + the "verify before acting" mark; the D9 hatch carries STUB/FILES/
 * REASON. Wording = pins (house rule): reword = pin rewrite.
 */
export function settlementBlock(r: SamSettlementRecord): string {
	const v = r.verdict;
	const head =
		v === "VERIFIED"
			? `[u${r.unitId}] ${r.retrievalId} — VERIFIED`
			: v === "CORRECTIONS"
				? `[u${r.unitId}] ${r.retrievalId} — CORRECTIONS`
				: v === "NOT-YET-VERIFIED"
					? `[u${r.unitId}] ${r.retrievalId} — NOT-YET-VERIFIED (light)`
					: v === "UNVERIFIED-AUDIT-FAILED"
						? `[u${r.unitId}] ${r.retrievalId} — UNVERIFIED (audit-failed)`
						: `[u${r.unitId}] ${r.retrievalId} — ${v}`;
	if (v === "NOT-YET-VERIFIED") {
		const lines = [head];
		// D11 batch (2026-10-02): the STUB parity — the light weak line gains its
		// STUB exactly as the D9 hatch does (content survival). The stub rides
		// the record property (buildSettlementRecord) or sections (legacy).
		const stub = (r.stub ?? r.sections["STUB"]) ?? "";
		if (stub !== "") lines.push(`  STUB: ${wrapIndented(stub)}`);
		const note = r.sections["NOT-YET-VERIFIED"] ?? "";
		lines.push(`  DELIVERY: ${note === "" ? "(no delivery note)" : note} — unmarked claims: verify before acting`);
		return lines.join("\n");
	}
	if (v === "UNVERIFIED-AUDIT-FAILED") {
		const lines = [head];
		if (r.sections["STUB"]) lines.push(`  STUB: ${wrapIndented(r.sections["STUB"])}`);
		if (r.sections["FILES"]) lines.push(`  FILES: ${wrapIndented(r.sections["FILES"])}`);
		if (r.sections["REASON"]) lines.push(`  REASON: ${wrapIndented(r.sections["REASON"])}`);
		lines.push(`  claims UNVERIFIED: verify before acting`);
		return lines.join("\n");
	}
	const ordered: Array<[string, string]> = [];
	if (v === "CORRECTIONS" && r.sections["CORRECTIONS"]) ordered.push(["CORRECTIONS", r.sections["CORRECTIONS"]]);
	for (const name of BRANCH_AUDIT_SECTION_NAMES) {
		if (r.sections[name]) ordered.push([name, r.sections[name]]);
	}
	const lines = [head];
	for (const [name, value] of ordered) lines.push(`  ${name}: ${wrapIndented(value)}`);
	return lines.join("\n");
}

/**
 * The takeover summary, D11-batch shape (deterministic, zero model calls):
 *   [goal block — latest version, replaces earlier ones] →
 *   [carried previous summary (pi convention; its old goal block stripped)] →
 *   [settlement blocks — latest-per-unit, verbatim] →
 *   [the pointer].
 * A goal-only branch renders goal + pointer; a settlements-only branch keeps
 * the v1 relative order (previous summary first, records after). Wording = pins.
 */
/* ── 2026-10-02 orphan hatch (GO 2026-10-02, Paul: "no llm call, bare
   skeleton of calls plus last model text marked as 'orphaned'" — the
   model may ignore, re-derive or check what's done) ────────────────────────
   At a takeover, the span that is (a) in the folded region, (b) NOT part of
   a settled unit, (c) NOT the goal capture — and (d) not in the kept raw
   tail (pi's cut, which pi owns) — is "orphaned": it leaves the live
   context with no settlement line and no stub. It is conserved WITHOUT any
   model call: a deterministic extraction (call skeleton + last model text +
   touched files) rides the takeover summary as a clearly-labelled
   ORPHANED section (weak material after the settlements; the goal keeps the
   head), a ledger record carries it for later folds (upgradable: a later
   proper close + audit supersedes it via latest-wins), and the raw span
   stays banked — the orphan's retrieval id points at the fold tombstone,
   readable in anchored windows below.
*/

export interface OrphanCall {
	name: string;
	/** first argument, head-truncated (deterministic) — e.g. the path or command */
	arg: string;
}

export interface OrphanZone {
	spanFirstId: string;
	spanLastId: string;
	entryIds: string[];
	calls: OrphanCall[];
	/** call count dropped by the cap (0 = none) */
	callsTrunc: number;
	/** paths touched by read/write/edit call arguments (sorted, deduped) */
	files: string[];
	/** the zone's LAST assistant text, verbatim (head+tail capped when long) */
	lastText?: string;
}

export const ORPHAN_CALLS_CAP = 40;
export const ORPHAN_ARG_HEAD = 60;
export const ORPHAN_TEXT_CAP = 900;
const ORPHAN_TEXT_KEEP = 320;

/** head-truncate (deterministic; mid-word cuts are fine for a skeleton) */
function headCap(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

/** first-argument extraction per tool (total over unknown args) */
function orphanArgOf(name: string, args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const isPathTool = name === "read" || name === "write" || name === "edit" || name === "patch" || name === "move_file" || name === "delete_file";
	const isRunTool = name === "bash" || name === "shell" || name === "exec";
	const v = isPathTool
		? (typeof a.path === "string" ? a.path : undefined)
		: isRunTool
			? (typeof a.command === "string" ? a.command : undefined)
		: typeof a.path === "string" ? a.path : undefined;
	return v === undefined || v === null ? "" : headCap(v, ORPHAN_ARG_HEAD);
}

/** touched-file path (read/write/edit only — bash commands are not parsed;
 *  a bare skeleton, per the contract) */
function orphanPathOf(name: string, args: unknown): string | undefined {
	if ((name === "read" || name === "write" || name === "edit") && args !== null && typeof args === "object") {
		const p = (args as Record<string, unknown>).path;
		if (typeof p === "string" && p !== "") return p;
	}
	return undefined;
}

/**
 * The orphan zone: branch MESSAGES (model/user work — custom ledger records and
 * compaction headers are excluded: they ride elsewhere) minus the excluded ids
 * (settled spans + goal capture). Deterministic; total (no throws); `null` when
 * the zone is empty (nothing to conserve ⇒ the summary is unchanged).
 */
export function computeOrphanZone(entries: readonly RawEntry[], excludeIds: ReadonlySet<string>): OrphanZone | null {
	const zone = entries.filter((e) => e.type === "message" && typeof e.id === "string" && e.id !== "" && !excludeIds.has(e.id));
	if (zone.length === 0) return null;
	const calls: OrphanCall[] = [];
	const files = new Set<string>();
	let lastText: string | undefined;
	for (const e of zone) {
		if (e.message === undefined) continue;
		const isAssistant = (e.message as { role?: unknown }).role === "assistant";
		const content = (e.message as { content?: unknown }).content;
		if (typeof content === "string") {
			if (content.trim() !== "") lastText = content.trim();
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; name?: string; arguments?: unknown; text?: string }>) {
			if (block.type === "toolCall" && typeof block.name === "string" && isAssistant) {
				calls.push({ name: block.name, arg: orphanArgOf(block.name, block.arguments) });
				const p = orphanPathOf(block.name, block.arguments);
				if (p !== undefined) files.add(p);
			} else if (block.type === "text" && isAssistant && typeof block.text === "string" && block.text.trim() !== "") {
				// sam-06 (2026-10-04 run, measured): the label is "the last MODEL text" — a
				// toolResult/system line (extension output; sam-06 orphan c8c2ff4c8d4a had
				// captured the close_unit one-liner as LAST MODEL TEXT) is never the model's
				// words. Assistant-gated, symmetric to the toolCall captures above.
				lastText = block.text.trim();
			}
		}
	}
	const callsTrunc = calls.length > ORPHAN_CALLS_CAP ? calls.length - ORPHAN_CALLS_CAP : 0;
	let text = lastText;
	if (text !== undefined && text.length > ORPHAN_TEXT_CAP) {
		text = text.slice(0, ORPHAN_TEXT_KEEP).trimEnd() + " […] " + text.slice(-ORPHAN_TEXT_KEEP).trimStart();
	}
	return {
		spanFirstId: zone[0].id,
		spanLastId: zone[zone.length - 1].id,
		entryIds: zone.map((e) => e.id),
		calls: calls.slice(0, ORPHAN_CALLS_CAP),
		callsTrunc,
		files: [...files].sort(),
		lastText: text,
	};
}

/** deterministic 12-hex retrieval id (same family as weakRetrievalIdOf) */
export function orphanRetrievalIdOf(foldId: string, lastText: string, entryCount: number): string {
	return createHash("sha256").update(`SAM-ORPHAN:${foldId}:${entryCount}:${lastText}`).digest("hex").slice(0, 12);
}

export interface SamOrphanRecord {
	v: 1;
	kind: "orphan";
	retrievalId: string;
	/** the fold's first-kept entry id — `sam-tombstones/tombstone-<foldId>.jsonl` holds the raw span */
	foldId: string;
	spanFirstId: string;
	spanLastId: string;
	entryIds: string[];
	calls: OrphanCall[];
	callsTrunc: number;
	files: string[];
	lastText?: string;
	line: string;
	ts: number;
}

export function orphanRecord(zone: OrphanZone, foldId: string, ts: number): SamOrphanRecord {
	const retrievalId = orphanRetrievalIdOf(foldId, zone.lastText ?? "", zone.entryIds.length);
	const tail = zone.lastText === undefined ? "(no model text — call skeleton only)" : headCap(zone.lastText.replace(/\s+/g, " ").trim(), 80);
	return {
		v: 1, kind: "orphan", retrievalId, foldId,
		spanFirstId: zone.spanFirstId, spanLastId: zone.spanLastId, entryIds: [...zone.entryIds],
		calls: zone.calls.map((c) => ({ name: c.name, arg: c.arg })), callsTrunc: zone.callsTrunc, files: [...zone.files],
		lastText: zone.lastText,
		line: `ORPHANED ${retrievalId} UNVERIFIED (unclosed-at-fold — system-extracted, NOT audited, not settled): ${tail} — raw span banked (sam_retrieve ${retrievalId})`,
		ts,
	};
}

/** One ORPHANED section (rendered after the settlements, before the pointer). */
export function orphanBlock(rec: SamOrphanRecord): string {
	const l: string[] = ["ORPHANED AT FOLD — unclosed at fold time: NOT audited, NOT-YET-SETTLED (system-extracted skeleton; treat every claim as UNVERIFIED — it may have been corrected later; ignore, re-derive, or check what's done; raw span banked):"];
	l.push(`[orphaned] ${rec.retrievalId}`);
	if (rec.calls.length > 0) {
		l.push(`CALLS: ${rec.calls.map((c) => (c.arg === "" ? c.name : `${c.name}(${c.arg})`)).join(" · ")}${rec.callsTrunc > 0 ? ` · …+${rec.callsTrunc} more` : ""}`);
	}
	if (rec.files.length > 0) l.push(`FILES: ${rec.files.join(", ")}`);
	if (rec.lastText !== undefined && rec.lastText !== "") l.push(`LAST MODEL TEXT: ${rec.lastText}`);
	return l.join("\n");
}

/**
 * Exact-anchor window over a banked text (the "inspect part of your history
 * without loading it fully" ask, 2026-10-02): FIRST exact (case-sensitive)
 * occurrence of `anchor` in the line array, ±`context` lines, capped. Total:
 * a miss is a value, not a throw. No fuzzy, no ranking — deterministic.
 */
export interface AnchorWindow {
	found: boolean;
	/** total exact occurrences in the banked text */
	total: number;
	head: string[];
	hit: string;
	tail: string[];
	/** 1-based line number of the hit (0 when not found) */
	hitLine: number;
}
const ANCHOR_CONTEXT = 3;
const ANCHOR_WINDOW_CAP = 40;

export function anchorWindow(lines: readonly string[], anchor: string, context: number = ANCHOR_CONTEXT): AnchorWindow {
	const a = anchor.trim();
	if (a === "" || lines.length === 0) return { found: false, total: 0, head: [], hit: "", tail: [], hitLine: 0 };
	let total = 0;
	let idx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].includes(a)) continue;
		total++;
		if (idx === -1) idx = i;
	}
	if (idx === -1) return { found: false, total: 0, head: [], hit: "", tail: [], hitLine: 0 };
	const from = Math.max(0, idx - context);
	const to = Math.min(lines.length, idx + context + 1);
	let head = lines.slice(from, idx);
	let tail = lines.slice(idx + 1, to);
	if (head.length + 1 + tail.length > ANCHOR_WINDOW_CAP) {
		const per = Math.floor((ANCHOR_WINDOW_CAP - 1) / 2);
		if (head.length > per) head = head.slice(head.length - per);
		if (tail.length > per) tail = tail.slice(0, per);
	}
	return { found: true, total, head, hit: lines[idx], tail, hitLine: idx + 1 };
}

/** Render an anchor window as retrieval output text (total: miss message). */
export function renderAnchorWindow(w: AnchorWindow, source: string, anchor: string): string {
	if (!w.found) {
		return `ANCHOR NOT FOUND (exact, case-sensitive) in ${source}: '${anchor}'. Re-anchor with a shorter exact phrase, or fetch the full content (omit the anchor).`;
	}
	const parts: string[] = [];
	parts.push(w.head.length > 0 ? `… ${w.head.length} earlier line(s):` : "(hit is the first line)");
	parts.push(...w.head, `[hit L${w.hitLine}] ${w.hit}`, ...w.tail);
	if (w.tail.length === 0) parts.push("(end of content)");
	parts.push(`\n(anchor: first exact match at line ${w.hitLine}; ${w.total} occurrence(s) in ${source})`);
	return parts.join("\n");
}

export function takeoverSummary(previousSummary: string | undefined, goal: SamGoalRecord | null | undefined, records: readonly SamSettlementRecord[], orphan?: SamOrphanRecord | null): string {
	const prev =
		previousSummary === undefined || previousSummary.trim() === ""
			? undefined
			: stripGoalBlock(previousSummary.trim());
	const middle: string[] = [];
	if (goal !== null && goal !== undefined) middle.push(goalBlock(goal));
	if (prev !== undefined) middle.push(prev);
	if (records.length > 0) {
		middle.push(SETTLEMENTS_HEADER);
		for (const r of records) middle.push(settlementBlock(r));
	}
	if (orphan !== undefined && orphan !== null) middle.push(orphanBlock(orphan));
	const all = middle.length > 0 ? [...middle, TAKEOVER_POINTER] : [TAKEOVER_POINTER];
	return all.join("\n\n");
}

/**
 * The `details` slot content for the takeover compaction entry (verified
 * first-class: pi itself stores readFiles/modifiedFiles there — 2026-09-30,
 * banked B20 session file). Carries the retrieval map so a later
 * `sam_retrieve` works from the compaction entry alone.
 * D11 (2026-10-02): + the stored goal that rode this fold (auditability —
 * F1: the compaction entry stands alone as provenance).
 */
export interface TakeoverGoalMeta {
	text: string;
	basis: "adjust-goal" | "takeover-fallback";
	ts: number;
}

export interface TakeoverOrphanMeta {
	retrievalId: string;
	foldId: string;
	spanFirstId: string;
	spanLastId: string;
}

export function takeoverDetails(
	settlements: readonly Pick<SamSettlementRecord, "unitId" | "retrievalId" | "auditFile" | "replyId">[],
	goal?: TakeoverGoalMeta,
	orphan?: TakeoverOrphanMeta,
): { sam: { v: 1; kind: "branchAuditSettlements"; settlements: Array<Pick<SamSettlementRecord, "unitId" | "retrievalId" | "auditFile" | "replyId">>; goal?: TakeoverGoalMeta; orphan?: TakeoverOrphanMeta } } {
	return { sam: { v: 1, kind: "branchAuditSettlements", settlements: [...settlements], ...(goal !== undefined ? { goal } : {}), ...(orphan !== undefined ? { orphan } : {}) } };
}

/** Tombstone safety net: the raw summarized span as bankable JSONL (string). */
export function tombstoneJsonl(entries: readonly RawEntry[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}


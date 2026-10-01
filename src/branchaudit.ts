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

/* ── raw entry view (pi's session-file shape; total over unknown types) ── */
export interface RawEntry {
	id: string;
	parentId?: string | null;
	type: string;
	message?: { role?: string; content?: unknown } | undefined;
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
		for (let j = i + 1; j < entries.length; j++) {
			if (isAssistantMessage(entries[j])) {
				replyId = entries[j].id;
				replyText = (entries[j].message as { content?: unknown })?.content !== undefined
					? assistantText(((entries[j].message as { content?: unknown }).content ?? "") as string | unknown[])
					: "";
				break;
			}
			if (isUserMessage(entries[j])) break; // a later user turn interrupted — no clean reply
		}
		return { unitId: parseInt(m[1], 10), instructionId: e.id, replyId, replyText };
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

/** The settlement ledger record (a `sam` custom entry, kind "settlement"). */
export interface SamSettlementRecord {
	v: 1;
	kind: "settlement";
	unitId: number;
	retrievalId: string;
	verdict: "VERIFIED" | "CORRECTIONS" | "UNAUDITABLE";
	sections: Record<string, string>;
	line: string;
	auditFile: string;
	replyId: string | null;
	parsedClean: boolean;
	ts: number;
}

export function buildSettlementRecord(
	unitId: number,
	auditFile: string,
	replyId: string | undefined,
	replyText: string,
	timestamp?: number,
): SamSettlementRecord | undefined {
	if (replyId === undefined) return undefined; // no audited reply ⇒ no settlement (refuse)
	const parse = parseBranchAuditReply(replyText);
	const id = retrievalIdOf(auditFile, replyId, replyText);
	return {
		v: 1,
		kind: "settlement",
		unitId,
		retrievalId: id,
		verdict: parse.verdict.class,
		sections: parse.sections,
		line: settlementLine(id, parse.verdict.class, parse.sections),
		auditFile,
		replyId,
		parsedClean: parse.parsedClean,
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
 * True when the entries being summarized (pi's `messagesToSummarize` +
 * `turnPrefixMessages`, given as raw entries) contain a settlement record —
 * only then does the takeover handler fire (spans with no SAM settlement go
 * through pi's own summarization untouched — control semantics preserved).
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
 * The takeover summary (deterministic, zero model calls): the previous
 * cumulative summary (carried over — pi convention), then each settlement
 * line VERBATIM (the digest incl. its EVIDENCE), then the provenance pointer
 * (the retrievalIds are on the lines; sam_retrieve recovers the original).
 */
export function takeoverSummary(previousSummary: string | undefined, settlementLines: readonly string[]): string {
	const parts: string[] = [];
	if (previousSummary && previousSummary.trim() !== "") parts.push(previousSummary.trim());
	if (settlementLines.length > 0) {
		parts.push("SAM settlement(s) for the compacted span(s), preserved verbatim:");
		for (const line of settlementLines) parts.push(line);
	}
	parts.push("(earlier context summarized by pi-self-aware-memory; the settlement line(s) above carry the audited facts — retrieve the original with sam_retrieve <id>)");
	return parts.join("\n");
}

/**
 * The `details` slot content for the takeover compaction entry (verified
 * first-class: pi itself stores readFiles/modifiedFiles there — 2026-09-30,
 * banked B20 session file). Carries the retrieval map so a later
 * `sam_retrieve` works from the compaction entry alone.
 */
export function takeoverDetails(settlements: readonly Pick<SamSettlementRecord, "unitId" | "retrievalId" | "auditFile" | "replyId">[]): { sam: { v: 1; kind: "branchAuditSettlements"; settlements: Array<Pick<SamSettlementRecord, "unitId" | "retrievalId" | "auditFile" | "replyId">> } } {
	return { sam: { v: 1, kind: "branchAuditSettlements", settlements: [...settlements] } };
}

/** Tombstone safety net: the raw summarized span as bankable JSONL (string). */
export function tombstoneJsonl(entries: readonly RawEntry[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}


/**
 * The ledger — append-only `sam` custom entries in the session file plus the
 * pure rebuild that reconstructs it on load (design note §4).
 *
 * Custom entries are never sent to the LLM (pi v0.87.1 `CustomEntry`), so the
 * ledger is audit metadata, not context. The raw session file plus the ledger
 * is the full audit record (F3).
 *
 * P3 additions (all `v: 1`, optional-field-tolerant): `close.evidence` (the
 * deterministic unit floor — anti-self-sealing referent, ledger-only),
 * `noFold.reasons` (deterministic gate-reason list), `fold.sweep` /
 * `fold.commitTiming` / `fold.gate` (sweep origin, cache-coordination mark,
 * gate arithmetic at commit), and the `foldLost` / `resolve` tombstone
 * records (issued-vs-committed honesty + guard-fact resolutions). A
 * `foldLost` moves a folded unit to the tombstone state `resolved` — never
 * back to in-flight (no silent re-pending, the s5 retry-loop trap).
 *
 * Rebuild is fail-open: malformed records are counted and skipped, never
 * thrown; the extension announces what it skipped.
 */

import type { SamMode } from "./state.ts";
import { AUDIT_INSTRUCTION_PREFIX } from "./protocol.ts";
import { assistantText, parseVerdict, type Verdict } from "./verdict.ts";
import { messageText, type PlainEntry, type PlainUsage } from "./projection.ts";
import { getAssistantUsage } from "./estimate.ts";
import { resolveUnitSpan, type PendingClose, type UnitSpan } from "./units.ts";

const SAM_CUSTOM_TYPE = "sam";

/* ── record shapes (all `v: 1`) ─────────────────────────────────────────── */

export interface SamCloseRecord {
	v: 1;
	kind: "close";
	unitId: number;
	stub: string;
	toolCallId: string;
	ts: number;
	mode: SamMode;
	/** P3: the deterministic unit floor (ledger-only, zero prefix cost) */
	evidence?: { files: string[]; errors: number; retries: number; nonTrivial: boolean };
}

export interface SamFoldRecord {
	v: 1;
	kind: "fold";
	unitId: number;
	entryIds: string[];
	spanFirstId: string;
	spanLastId: string;
	stub: string;
	verdict: "VERIFIED";
	corrections?: string;
	/** true when a user `/sam fold` override folded despite CORRECTIONS (P3: delivered) */
	override?: boolean;
	/** P3: a sweep commit (assisted/auto) rather than a close-driven commit */
	sweep?: "assisted" | "auto";
	/** P3: the cache-coordination timing mark (cache-ledger.ts) */
	commitTiming?: "warm" | "cold" | "unknown";
	/** P3: the gate arithmetic at commit (single ruler, F3) */
	gate?: {
		spanTok: number;
		stubTok: number;
		savedTok: number;
		afterTok: number | null;
		keepOut: number | null;
	};
	/** pi's estimate of the pre-fold projection (single ruler, F3); null when ctx had no usage */
	beforeTokens: number | null;
	/** provider usage of the audit turn (the verdict message) */
	usage?: PlainUsage;
	ts: number;
	mode: SamMode;
}

export interface SamNoFoldRecord {
	v: 1;
	kind: "noFold";
	unitId: number;
	entryIds: string[];
	spanFirstId: string;
	spanLastId: string;
	stub: string;
	/** the actual audit verdict (display-mode noFolds record VERIFIED) */
	verdict: "VERIFIED" | "CORRECTIONS" | "UNAUDITABLE";
	corrections?: string;
	/** why the fold did not happen ("verdict CORRECTIONS", "display mode", "stale-span", gate heads, …) */
	reason: string;
	/** P3: the deterministic gate-reason list (empty when a non-gate reason applies) */
	reasons?: string[];
	/** P3: provider-busyness probe status for a deferred close (only when deferred) */
	probe?: "busy" | "idle" | "unavailable";
	ts: number;
	mode: SamMode;
}

export interface SamUndoRecord {
	v: 1;
	kind: "undo";
	unitId: number;
	/** span message entry ids restored to their original content */
	targets: string[];
	ts: number;
}

/**
 * P3 tombstone (commitproof.ts): the ledger recorded a fold, but the branch
 * carries no trace of its batch — pi discarded the whole draft batch (the
 * measured s5 failure). Append-only; moves the unit to `resolved` (tombstone
 * state, R2) so no retry loop can re-pend it silently.
 */
export interface SamFoldLostRecord {
	v: 1;
	kind: "foldLost";
	unitId: number;
	/** why the proof is missing (always "commit-rejected" in P3) */
	basis: string;
	ts: number;
}

/**
 * P3 positive resolution evidence for a guard fact (governor.ts R1/R2):
 * user-resolved (`/sam resolve`), undo, or override-fold. A resolved fact
 * becomes a tombstone (report-visible, never reactivated).
 */
export interface SamResolveRecord {
	v: 1;
	kind: "resolve";
	unitId: number;
	basis: "user-resolved" | "undo" | "override-fold";
	ts: number;
}

export interface SamModeRecord {
	v: 1;
	kind: "mode";
	mode: SamMode;
	ts: number;
}

export type SamRecord =
	| SamCloseRecord
	| SamFoldRecord
	| SamNoFoldRecord
	| SamUndoRecord
	| SamFoldLostRecord
	| SamResolveRecord
	| SamModeRecord;

/** The customType under which all ledger entries are appended. */
export const SAM_LEDGER_CUSTOM_TYPE = SAM_CUSTOM_TYPE;

const MODE_VALUES: readonly SamMode[] = ["display", "manual", "assisted", "auto"];

function isRecord(data: unknown): data is SamRecord {
	if (!data || typeof data !== "object") return false;
	const r = data as Record<string, unknown>;
	if (r.v !== 1) return false;
	if (typeof r.ts !== "number") return false;
	switch (r.kind) {
		case "close":
			return (
				typeof r.unitId === "number" &&
				typeof r.stub === "string" &&
				typeof r.toolCallId === "string" &&
				typeof r.mode === "string" &&
				MODE_VALUES.includes(r.mode as SamMode)
			);
		case "fold":
		case "noFold":
			return (
				typeof r.unitId === "number" &&
				Array.isArray(r.entryIds) &&
				r.entryIds.every((x) => typeof x === "string") &&
				typeof r.spanFirstId === "string" &&
				typeof r.spanLastId === "string" &&
				typeof r.stub === "string" &&
				typeof r.mode === "string" &&
				MODE_VALUES.includes(r.mode as SamMode)
			);
		case "undo":
			return typeof r.unitId === "number" && Array.isArray(r.targets) && r.targets.every((x) => typeof x === "string");
		case "foldLost":
			return typeof r.unitId === "number" && typeof r.basis === "string";
		case "resolve":
			return (
				typeof r.unitId === "number" &&
				(r.basis === "user-resolved" || r.basis === "undo" || r.basis === "override-fold")
			);
		case "mode":
			return typeof r.mode === "string" && MODE_VALUES.includes(r.mode as SamMode);
		default:
			return false;
	}
}

/** Parse one ledger custom-entry payload; undefined when malformed. */
export function parseSamRecord(data: unknown): SamRecord | undefined {
	return isRecord(data) ? (data as SamRecord) : undefined;
}

/* ── rebuilt state ───────────────────────────────────────────────────────── */

export type SamUnitState = "in-flight" | "folded" | "refused" | "undone" | "resolved";

export interface SamUnit {
	unitId: number;
	stub: string;
	state: SamUnitState;
	verdict?: Verdict;
	corrections?: string;
	reason?: string;
	beforeTokens?: number | null;
	usage?: PlainUsage;
	mode?: SamMode;
	/** span message entry ids (set by fold/noFold records; kept after undo) */
	entryIds?: string[];
	/** P3: sweep origin for the report */
	sweep?: "assisted" | "auto";
	/** P3: commit-timing mark (cache-ledger) for the report */
	commitTiming?: "warm" | "cold" | "unknown";
	/** P3: gate-rejection reasons (refused units) for the report */
	gateReasons?: string[];
	/** P3: the deterministic unit floor at close (evidence) */
	evidence?: { files: string[]; errors: number; retries: number; nonTrivial: boolean };
	/** P3: tombstone basis (foldLost / resolved) */
	resolvedBasis?: string;
}

/** An unresolved close: the audit turn's verdict reply is already in the file. */
export interface LedgerPendingCommit {
	unitId: number;
	span: UnitSpan;
	verdict: Verdict;
	usage?: PlainUsage;
}

/**
 * Unresolved closes whose verdict reply is in the file, oldest first. A
 * single process never has more than one (each settle commits the open one),
 * but a crash between verdict and commit can — they are then committed one
 * per settle, oldest first.
 */
export type LedgerPendingCommits = LedgerPendingCommit[];

/** An unresolved close whose audit user message is in the file but has no reply yet. */
export interface LedgerAuditInFlight {
	unitId: number;
	span: UnitSpan;
	stub: string;
}

/** An unresolved close with no audit user message in the file (crash before queue). */
export interface LedgerPendingReaudit {
	unitId: number;
	toolCallId: string;
	span: UnitSpan;
}

export interface SamLedger {
	units: SamUnit[];
	mode: SamMode;
	/** next unit id to assign (max existing + 1) */
	nextUnitId: number;
	/** ledger custom entries skipped as malformed (fail-open, announced) */
	malformedRecords: number;
	/** unresolved closes with a verdict reply in the file, oldest first */
	pendingCommits: LedgerPendingCommits;
	/** the most recent unresolved close whose audit message has no reply yet */
	auditInFlight: LedgerAuditInFlight | null;
	/** unresolved closes with no audit message (oldest first) */
	pendingReaudit: LedgerPendingReaudit[];
}

/**
 * Rebuild the ledger from a branch (ordered plain entries). Pure.
 *
 * In-flight resolution uses the branch content itself: a `close` record whose
 * unit's audit user message (`[sam-audit] Unit <n>`) appears in the file with
 * an assistant reply after it → the verdict is parseable now; without a reply
 * the audit turn is simply unfinished (pi resumes it); without the audit
 * message the process died before queueing (re-queue at the next settle).
 */
export function rebuildLedger(entries: PlainEntry[]): SamLedger {
	const units = new Map<number, SamUnit>();
	const terminals = new Map<number, "folded" | "refused" | "undone" | "resolved">();
	let mode: SamMode = "manual";
	let malformedRecords = 0;
	let maxUnitId = 0;

	const closes: { record: SamCloseRecord; index: number }[] = [];
	const folds: SamFoldRecord[] = [];

	/** Get-or-create the unit a record refers to (a fold/undo may outlive its close). */
	const upsertUnit = (unitId: number, stub: string): SamUnit => {
		let unit = units.get(unitId);
		if (!unit) {
			unit = { unitId, stub, state: "in-flight" };
			units.set(unitId, unit);
		}
		maxUnitId = Math.max(maxUnitId, unitId);
		return unit;
	};

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.kind !== "custom" || entry.customType !== SAM_CUSTOM_TYPE) continue;
		const record = parseSamRecord(entry.data);
		if (!record) {
			malformedRecords++;
			continue;
		}
		if (record.kind === "mode") {
			mode = record.mode;
			continue;
		}
		if (record.kind === "close") {
			closes.push({ record, index: i });
			const unit = upsertUnit(record.unitId, record.stub);
			unit.state = "in-flight";
			unit.mode = record.mode;
			if (record.evidence) unit.evidence = record.evidence;
			continue;
		}
		if (record.kind === "fold") {
			folds.push(record);
			terminals.set(record.unitId, "folded");
			const unit = upsertUnit(record.unitId, record.stub);
			unit.state = "folded";
			unit.entryIds = record.entryIds;
			unit.verdict = { class: "VERIFIED", corrections: record.corrections };
			unit.corrections = record.corrections;
			unit.beforeTokens = record.beforeTokens;
			unit.usage = record.usage;
			unit.mode = record.mode;
			if (record.sweep) unit.sweep = record.sweep;
			if (record.commitTiming) unit.commitTiming = record.commitTiming;
			continue;
		}
		if (record.kind === "noFold") {
			terminals.set(record.unitId, "refused");
			const unit = upsertUnit(record.unitId, record.stub);
			unit.state = "refused";
			unit.entryIds = record.entryIds;
			unit.verdict = { class: record.verdict, corrections: record.corrections };
			unit.corrections = record.corrections;
			unit.reason = record.reason;
			unit.mode = record.mode;
			if (record.reasons) unit.gateReasons = record.reasons;
			continue;
		}
		if (record.kind === "undo") {
			terminals.set(record.unitId, "undone");
			const unit = upsertUnit(record.unitId, "");
			if (unit.state === "folded" || unit.state === "in-flight") unit.state = "undone";
			continue;
		}
		if (record.kind === "foldLost") {
			// Tombstone (R2): the ledger once recorded a fold whose batch never
			// landed. Terminal state — never back to in-flight (retry-loop trap).
			terminals.set(record.unitId, "resolved");
			const unit = upsertUnit(record.unitId, "");
			unit.state = "resolved";
			unit.resolvedBasis = record.basis;
			continue;
		}
		if (record.kind === "resolve") {
			// Positive resolution evidence (R1): a guard fact on a refused unit
			// is resolved; the fact becomes a tombstone, never reactivated.
			const unit = upsertUnit(record.unitId, "");
			unit.resolvedBasis = record.basis;
			if (unit.state === "refused" || unit.state === "in-flight") unit.state = "resolved";
			continue;
		}
	}

	// Entry ids currently inside folded (not undone) spans — the
	// already-closed check for new closes and for span resolution below.
	const foldedEntryIds = new Set<string>();
	for (const fold of folds) {
		if (terminals.get(fold.unitId) === "folded") fold.entryIds.forEach((id) => foldedEntryIds.add(id));
	}

	// Unresolved closes, oldest first.
	const unresolved = closes.filter((c) => !terminals.has(c.record.unitId));

	const pendingCommits: LedgerPendingCommit[] = [];
	let auditInFlight: LedgerAuditInFlight | null = null;
	const pendingReaudit: LedgerPendingReaudit[] = [];

	for (const { record, index } of unresolved) {
		const auditIndex = findAuditMessageIndex(entries, index, record.unitId);
		const replyIndex = auditIndex === -1 ? -1 : auditReplyIndex(entries, auditIndex);

		if (replyIndex !== -1) {
			const reply = entries[replyIndex];
			if (reply.kind !== "message") continue;
			const spanResolution = resolveUnitSpan(entries, [pendingCloseOf(record)], foldedEntryIds);
			if (!spanResolution.ok) {
				malformedRecords++;
				continue;
			}
			pendingCommits.push({
				unitId: record.unitId,
				span: spanResolution.span,
				verdict: parseVerdict(assistantText(reply.message.content)),
				usage: getAssistantUsage(reply.message),
			});
		} else if (auditIndex !== -1) {
			const spanResolution = resolveUnitSpan(entries, [pendingCloseOf(record)], foldedEntryIds);
			if (!spanResolution.ok) {
				malformedRecords++;
				continue;
			}
			// Only the most recent unresolved close can still be in flight.
			auditInFlight = { unitId: record.unitId, span: spanResolution.span, stub: record.stub };
		} else {
			const spanResolution = resolveUnitSpan(entries, [pendingCloseOf(record)], foldedEntryIds);
			if (!spanResolution.ok) {
				malformedRecords++;
				continue;
			}
			pendingReaudit.push({ unitId: record.unitId, toolCallId: record.toolCallId, span: spanResolution.span });
		}
	}

	return {
		units: [...units.values()].sort((a, b) => a.unitId - b.unitId),
		mode,
		nextUnitId: maxUnitId + 1,
		malformedRecords,
		pendingCommits,
		auditInFlight,
		pendingReaudit,
	};
}

function pendingCloseOf(record: SamCloseRecord): PendingClose {
	return { unitId: record.unitId, stub: record.stub, toolCallId: record.toolCallId };
}

/** Index of the audit user message for a unit after the close record (-1 if absent). */
function findAuditMessageIndex(entries: PlainEntry[], afterIndex: number, unitId: number): number {
	// The prefix contains regex metacharacters ([, ]), so match it literally and
	// only regex the unit-number part (a number — no injection possible).
	const unitMarker = new RegExp(`^\\s+Unit\\s+${unitId}\\b`);
	for (let i = afterIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.kind !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message.content);
		if (text.startsWith(AUDIT_INSTRUCTION_PREFIX) && unitMarker.test(text.slice(AUDIT_INSTRUCTION_PREFIX.length))) {
			return i;
		}
	}
	return -1;
}

/**
 * Index of the audit turn's verdict reply: the LAST assistant message within
 * the audit window (handles in-turn tool loops: assistant(toolCall) →
 * toolResult → assistant(final)). The window ends at the next user message
 * or the next sam ledger record. Returns -1 when no reply exists.
 */
function auditReplyIndex(entries: PlainEntry[], auditIndex: number): number {
	let reply = -1;
	for (let i = auditIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.kind === "custom" && entry.customType === SAM_CUSTOM_TYPE) break;
		if (entry.kind === "message" && entry.message.role === "user") break;
		if (entry.kind === "message" && entry.message.role === "assistant") reply = i;
	}
	return reply;
}

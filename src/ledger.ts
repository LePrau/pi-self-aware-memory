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
import { assistantText, parseVerdict, type Verdict, type VerdictClass, type LedgerVerdict, type LedgerVerdictClass } from "./verdict.ts";
import { messageText, type PlainEntry, type PlainUsage } from "./projection.ts";
import { getAssistantUsage } from "./estimate.ts";
import { resolveUnitSpan, type PendingClose, type UnitSpan } from "./units.ts";
import type { SamSettlementRecord } from "./branchaudit.ts"; // type-only: no runtime cycle (branchaudit imports this file's runtime constants)
import type { RetireAction, RetireLedgerEntry, UnretireAction } from "./retire.ts"; // type-only: retire.ts imports only types from branchaudit (no cycle)
import { isGoalRecord, type SamGoalRecord } from "./goal.ts"; // goal.ts does not import this file — no cycle

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
	/** D8 audit depth ACTUALLY dispatched for this close (2026-10-03 decision-
	 *  in-ledger: the battery grades from this decision, not a re-derived zone).
	 *  Absent on pre-2026-10-03 records (old banks keep re-derivation). */
	depth?: "full" | "light";
	/** the zone the depth decision was made in (fresh zone at close time) */
	depthZone?: "calm" | "watch" | "action";
	/** the exact context tokens the decision used (pi getContextUsage().tokens;
	 *  null = unavailable ⇒ strict FULL — the recorded number IS the used number) */
	ctxTokens?: number | null;
	/** ruler provenance: the formula + pin + source the tokens came from */
	depthRuler?: string;
	/** v5 RETIRE light-carry (2026-10-06): the depth was FORCED to light by
	 *  the retire-carry marker (RETIRE-CARRY first stub line — the retire-
	 *  upgrade close is a curated carry-over, always light; the carried-over
	 *  claims are taken over as-is, not re-derived). Absent on every other
	 *  close (the zone/dial decision stands — decision-in-ledger: a forced
	 *  depth is auditable from the record alone). */
	depthForced?: "retire-carry";
	/** 2026-10-06 (Paul, audit-ergonomics): WHAT decided the depth on this close,
	 *  end-to-end: "retire-carry" (the carrier marker — strongest) > "command"
	 *  (/sam depth — the in-session switch, overrides the env dial) > "env"
	 *  (SAM_AUDIT_DEPTH) > "zone" (the context-pressure auto trigger).
	 *  Absent on pre-2026-10-06 records (the old fields stand). */
	depthSource?: "retire-carry" | "command" | "env" | "zone";
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
	verdict: VerdictClass; // D8 (2026-10-02): a model verdict can be NOT-YET-VERIFIED (light depth) — full model set
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
 *
 * P4 R3 (2026-09-30) adds the `compaction-owned` basis: a span native
 * compaction already summarized out of the view is terminal-resolved (not
 * folded, not ceiling-refused). The optional evidence fields make a
 * stand-alone tombstone self-documenting (the gate-pass case has no
 * noFold sibling to carry them); with a noFold sibling they mirror it.
 */
export interface SamResolveRecord {
	v: 1;
	kind: "resolve";
	unitId: number;
	basis: "user-resolved" | "undo" | "override-fold" | "compaction-owned" | "close-audit";
	/** P4 R3: the unit's span evidence (compaction-owned basis) */
	spanFirstId?: string;
	spanLastId?: string;
	entryIds?: string[];
	stub?: string;
	verdict?: LedgerVerdictClass; // D9 (2026-10-02): the resolve terminal also carries the hatch class
	corrections?: string;
	/** the gate arithmetic at resolve time (e.g. the ceiling reasons) */
	gateReasons?: string[];
	ts: number;
}

export interface SamModeRecord {
	v: 1;
	kind: "mode";
	mode: SamMode;
	ts: number;
}

/** Audit-depth dial values — the exact-value contract (same convention as the
 *  delivery dial): exactly "auto", "full" or "light"; anything else ⇒ unset. */
export type SamAuditDepth = "auto" | "full" | "light";

/** 2026-10-06 (Paul): the in-session audit-depth switch (`/sam depth <m>`).
 *  Latest-wins over the branch; the env dial SAM_AUDIT_DEPTH stays the machine
 *  default (the command overrides it for the session); the retire-carry marker
 *  stays strongest (a carrier's close is ALWAYS light). */
export interface SamDepthRecord {
	v: 1;
	kind: "depth";
	depth: SamAuditDepth;
	ts: number;
}

export type SamRecord =
	| SamCloseRecord
	| SamFoldRecord
	| SamNoFoldRecord
	| SamUndoRecord
	| SamFoldLostRecord
	| SamResolveRecord
	| SamModeRecord
	| SamDepthRecord
	| SamSettlementRecord
	| SamGoalRecord // D11 (2026-10-02): the stored goal (adjust-goal / takeover-fallback) — union order: see v5 RETIRE below
	| RetireAction
	| UnretireAction; // v5 RETIRE (Paul 2026-10-06): unit retirement + soft upgrade

/** The customType under which all ledger entries are appended. */
export const SAM_LEDGER_CUSTOM_TYPE = SAM_CUSTOM_TYPE;

const MODE_VALUES: readonly SamMode[] = ["display", "manual", "assisted", "auto"];

/** The depth-switch values (the exact-value convention; the handler rejects
 *  anything else with the list). */
export const DEPTH_VALUES: readonly SamAuditDepth[] = ["auto", "full", "light"];

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
			// P4 R3: the compaction-owned basis may carry the unit's evidence
			// (span anchors, ids, stub, verdict, gate arithmetic) — all optional,
			// all validated where present (the record stays self-describing).
			return (
				typeof r.unitId === "number" &&
				(r.basis === "user-resolved" ||
					r.basis === "undo" ||
					r.basis === "override-fold" ||
					r.basis === "compaction-owned" ||
					r.basis === "close-audit") &&
				(r.spanFirstId === undefined || typeof r.spanFirstId === "string") &&
				(r.spanLastId === undefined || typeof r.spanLastId === "string") &&
				(r.entryIds === undefined || (Array.isArray(r.entryIds) && r.entryIds.every((x) => typeof x === "string"))) &&
				(r.stub === undefined || typeof r.stub === "string") &&
				(r.verdict === undefined ||
					r.verdict === "VERIFIED" ||
					r.verdict === "CORRECTIONS" ||
					r.verdict === "UNAUDITABLE" ||
					r.verdict === "NOT-YET-VERIFIED" ||
					r.verdict === "UNVERIFIED-AUDIT-FAILED") &&
				(r.corrections === undefined || typeof r.corrections === "string") &&
				(r.gateReasons === undefined || (Array.isArray(r.gateReasons) && r.gateReasons.every((x) => typeof x === "string")))
			);
		case "mode":
			return typeof r.mode === "string" && MODE_VALUES.includes(r.mode as SamMode);
		case "depth":
			// 2026-10-06 (Paul): the in-session audit-depth switch — the exact-value
			// convention (auto|full|light), same shape as the mode record.
			return typeof r.depth === "string" && DEPTH_VALUES.includes(r.depth as SamAuditDepth);
		case "goal":
			// D11 (2026-10-02): the stored goal (defined in goal.ts — its own
			// total type guard; goal.ts never imports this file — no cycle).
			return isGoalRecord(r);
		case "retire":
			// v5 RETIRE (2026-10-06, Paul): the soft retirement (atomic contract
			// mirrored here — superseded non-empty ⇒ the superseding id must be
			// present; both routing lists are always arrays of unit ids).
			return (
				Array.isArray(r.superseded) &&
				r.superseded.every((x) => typeof x === "number") &&
				Array.isArray(r.dropped) &&
				r.dropped.every((x) => typeof x === "number") &&
				(r.supersededBy === undefined || typeof r.supersededBy === "number") &&
				(r.superseded.length === 0 || typeof r.supersededBy === "number") &&
				(r.reason === undefined || typeof r.reason === "string")
			);
		case "unretire":
			// v5 RETIRE: the soft reversal (latest-wins per unit at render time).
			return Array.isArray(r.units) && r.units.every((x) => typeof x === "number") && (r.reason === undefined || typeof r.reason === "string");
		case "settlement":
			// P5: the branch-audit settlement (defined in branchaudit.ts — type-
			// only import, no runtime cycle; branchaudit imports this file's
			// runtime constants).
			// D11 batch (2026-10-02) — MEASURED DEFECT FIX (D8/D9 residual): the
			// verdict set the LEDGER can carry is the full one (verdict.ts
			// LedgerVerdictClass): the D8 light (NOT-YET-VERIFIED) and D9 hatch
			// (UNVERIFIED-AUDIT-FAILED) settlements were committed by the code
			// but REJECTED here (run-03: their settlement + resolve records would
			// count as malformed on rebuild — measured against the banked
			// main-221.jsonl records). Now the validator matches the type.
			// (The `stub` slot (weak content survival) is optional-tolerant.)
			return (
				typeof r.unitId === "number" &&
				typeof r.retrievalId === "string" &&
				(r.verdict === "VERIFIED" ||
					r.verdict === "CORRECTIONS" ||
					r.verdict === "UNAUDITABLE" ||
					r.verdict === "NOT-YET-VERIFIED" ||
					r.verdict === "UNVERIFIED-AUDIT-FAILED") &&
				typeof r.line === "string" &&
				typeof r.auditFile === "string" &&
				(r.replyId === null || typeof r.replyId === "string") &&
				typeof r.parsedClean === "boolean" &&
				(r.stub === undefined || typeof r.stub === "string")
			);
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
	verdict?: LedgerVerdict; // D9 (2026-10-02): unit verdict slot carries the hatch class too
	corrections?: string;
	reason?: string;
	beforeTokens?: number | null;
	usage?: PlainUsage;
	mode?: SamMode;
	/** span message entry ids (set by fold/noFold records; kept after undo) */
	entryIds?: string[];
	/** P4 R3 (compaction-owned tombstone): span anchors carried by the resolve record */
	spanFirstId?: string;
	spanLastId?: string;
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
	/** D11 (2026-10-02): the goal records in branch order (oldest first;
	 *  latest-wins — the last entry is the current goal; earlier ones are the
	 *  tombstone history `read_goal` lists). Append-only provenance. */
	goals: SamGoalRecord[];
	/** v5 RETIRE (2026-10-06, Paul): the retire/unretire entries in branch
	 *  order (latest-wins per unit at render time — the RENDER is the only
	 *  thing they change; ledger + sidecars stay immutable, sam_retrieve
	 *  always serves the full original). */
	retirements: RetireLedgerEntry[];
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
	const goals: SamGoalRecord[] = []; // D11 (2026-10-02): goal records, branch order (later = latest)
	const retirements: RetireLedgerEntry[] = []; // v5 RETIRE: retire/unretire, branch order (later = latest)

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
		if (record.kind === "depth") {
			// 2026-10-06: the depth switch is a pure dial (latest-wins at
			// consume time — latestAuditDepth); it touches no unit state.
			continue;
		}
		if (record.kind === "goal") {
			// D11: goal records do not touch unit state — latest-wins is read at
			// consume time (latestGoal / read_goal / the takeover summary).
			goals.push(record);
			continue;
		}
		if (record.kind === "retire" || record.kind === "unretire") {
			// v5 RETIRE: append (soft state — the render consumes it; the entry
			// itself is the durable provenance, append-only).
			retirements.push(record);
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
			// P4 R3: a compaction-owned resolve is itself the UNIT TERMINAL —
			// register it, so a gate-passing tombstone (no noFold sibling)
			// never drops the unit into pendingReaudit. R1 records (guard-fact
		// evidence on already-terminal units) are unaffected: the set just
			// re-confirms a state the existing terminal already established.
			terminals.set(record.unitId, "resolved");
			const unit = upsertUnit(record.unitId, "");
			unit.resolvedBasis = record.basis;
			if (unit.state === "refused" || unit.state === "in-flight") unit.state = "resolved";
			// P4 R3 (compaction-owned): the tombstone may carry the unit's own
			// evidence — absorbed last, so a preceding noFold's values win when
			// both records exist (evidence → tombstone order is canonical).
			if (record.spanFirstId !== undefined) unit.spanFirstId = record.spanFirstId;
			if (record.spanLastId !== undefined) unit.spanLastId = record.spanLastId;
			if (record.entryIds !== undefined) unit.entryIds = record.entryIds;
			if (record.stub !== undefined) unit.stub = record.stub;
			if (record.verdict !== undefined) unit.verdict = { class: record.verdict };
			if (record.corrections !== undefined) {
				if (record.verdict) unit.verdict = { class: record.verdict, corrections: record.corrections };
				else unit.corrections = record.corrections;
			}
			if (record.gateReasons !== undefined) unit.gateReasons = record.gateReasons;
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
		goals,
		retirements,
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
 * Index of the audit turn's verdict reply within the audit window (from the
 * audit message to the next user message or the next sam ledger record):
 * - the LAST window assistant whose text parses as a valid verdict
 *   (VERIFIED or CORRECTIONS), which handles both the in-turn audit tool
 *   loop (assistant(toolCall) → toolResult → assistant(final)) and the
 *   P4-R1 steer shape where the model RETURNS TO TASK after the verdict —
 *   the continuation's assistant messages no longer displace the captured
 *   reply (measured failure mode: a steer-injected audit answered
 *   VERIFIED, the model then ran one more work step; "last assistant"
 *   would have captured the work step as the verdict);
 * - else the LAST window assistant (unchanged P2 behavior: an unreadable
 *   reply is still attributed — the terminal lands UNAUDITABLE either way).
 * Returns -1 when no assistant exists in the window.
 */
function auditReplyIndex(entries: PlainEntry[], auditIndex: number): number {
	let reply = -1;
	let lastParseable = -1;
	for (let i = auditIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.kind === "custom" && entry.customType === SAM_CUSTOM_TYPE) break;
		if (entry.kind === "message" && entry.message.role === "user") break;
		if (entry.kind !== "message" || entry.message.role !== "assistant") continue;
		reply = i;
		const v = parseVerdict(assistantText(entry.message.content));
		if (v.class === "VERIFIED" || v.class === "CORRECTIONS") lastParseable = i;
	}
	return lastParseable !== -1 ? lastParseable : reply;
}

/* ── 2026-10-06 (Paul, audit-ergonomics): the in-session depth switch ─────── */

/** Latest-wins the `/sam depth` records on the branch (the same resolution
 *  pattern as the mode/goal records — a pure dial, no unit state). `latest`
 *  undefined = never set (the env dial / zone decision stands); `"auto"` =
 *  explicitly released back to that default (consumers treat both the same:
 *  the env decision is preserved). */
export function latestAuditDepth(entries: readonly PlainEntry[]): SamAuditDepth | undefined {
	let latest: SamAuditDepth | undefined;
	for (const entry of entries) {
		if (entry.kind !== "custom" || entry.customType !== SAM_CUSTOM_TYPE) continue;
		const record = parseSamRecord(entry.data);
		if (record && record.kind === "depth") latest = record.depth;
	}
	return latest;
}

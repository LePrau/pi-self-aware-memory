/**
 * In-memory session state for the extension.
 *
 * P2: the durable state is the ledger (rebuildable from the session file on
 * load, see ledger.ts); this state adds the process-local action queues that
 * ride pi's settle boundary. Everything here is re-derivable from the ledger
 * plus the branch, so a crash loses at most one settle's worth of intent
 * (the rebuild re-re-resolves it — fail-open, F1).
 *
 * P3 adds the governor block (ladder/zone/hysteresis, R5 backoff memory,
 * guard facts, the host cache ledger, the D2 verdict, the probe config) and
 * the staged span proofs (commitproof.ts) — all plain data, all re-derivable
 * or process-local by design.
 *
 * P4 (R1) adds the audit-delivery dial: `auditDelivery` (DEFAULT "followUp" —
 * the P2/P3 behavior; "steer" = in-turn delivery at close, opt-in via the
 * `SAM_AUDIT_DELIVERY` env, plan carry #7) + `steeredAudits` (unit ids whose
 * close steered its audit into the running turn, pending the settle).
 *
 * Deliberately process-local: one pi process drives one session at a time.
 */

import type { PlainContent, PlainEntry, PlainUsage } from "./projection.ts";
import type { SamLedger } from "./ledger.ts";
import type { PendingClose, UnitSpan } from "./units.ts";
import type { Verdict } from "./verdict.ts";
import { fingerprintSpan, type StagedSpanProof } from "./commitproof.ts";
import { createHostCacheLedger, type HostCacheLedger } from "./cache-ledger.ts";
import { foldedRegions } from "./gates.ts";
import type { Ladder } from "./governor.ts";

/** Operating modes (plan §2). D5 default for a fresh install: `manual`. */
export const SAM_MODES = ["display", "manual", "assisted", "auto"] as const;
export type SamMode = (typeof SAM_MODES)[number];
export const DEFAULT_SAM_MODE: SamMode = "manual";

export function isSamMode(value: string): value is SamMode {
	return (SAM_MODES as readonly string[]).includes(value);
}

/** The audit turn for one closed unit, in flight (F7 keeps this 0 or 1). */
export interface SamAuditInFlight {
	unitId: number;
	span: UnitSpan;
	stub: string;
}

/** A verdict received; its fold (or noFold) commits at the next settle. */
export interface SamPendingCommit {
	unitId: number;
	span: UnitSpan;
	verdict: Verdict;
	/** provider usage of the audit turn (the verdict message) */
	usage?: PlainUsage;
}

/**
 * Audit delivery (P4 R1, plan carry #7): "followUp" = the P2/P3 in-series
 * audit turn after the close turn (DEFAULT); "steer" = the audit is injected
 * into the RUNNING turn at close (pi 0.87.1 `deliverAs: "steer"` — "after
 * the current tool calls, before the next LLM call"), so the verdict lands
 * on the still-warm prefix and the close settles the moment the turn ends.
 */
export type AuditDelivery = "followUp" | "steer";

/** `/sam undo` in flight: drafts computed, commit at the next settle. */
export interface SamPendingUndo {
	unitId: number;
	/** span message entry ids in span order, each with its original content */
	targets: { id: string; content: PlainContent }[];
}

/** `/sam fold <n>` in flight (P3): user override or plain fold, commit at the next settle. */
export interface SamPendingFold {
	unitId: number;
	spanFirstId: string;
	spanLastId: string;
	entryIds: string[];
	corrections?: string;
	/** true when overriding a CORRECTIONS verdict */
	override: boolean;
}

/* ── P3 governor state (plain data; the rules live in governor.ts/gates.ts) ─ */

import type { GuardFact, RejectMemory, ForeignFolderState } from "./governor.ts";

export interface SamGovernorState {
	/** the ladder as derived from the current model (null ⇒ governor inert, fail-safe) */
	ladder: Ladder | null;
	/** the model signature the ladder was derived from (model_select recompute) */
	lastModelSig: string | null;
	/** hysteresis-carrying zone (governor.pressureZone keeps it alive) */
	zone: "calm" | "watch" | "action";
	/** monotonically increasing settle counter (R5 backoff ticks) */
	settleCount: number;
	/** R5: sweep gate-rejection memory per unit (terminal marks never retry) */
	rejectMemory: Map<number, RejectMemory>;
	/** auto mode: spans already stubbed (tombstones — never retried) */
	autoTriedSpans: string[];
	/** auto mode: remaining stub-authoring deferrals (bounded, no livelock) */
	autoDeferralsLeft: number;
	/** R3: the mode breadcrumb trail (de-escalation active?) */
	modeHistory: { from: string; to: string; settle: number }[];
	/** guard facts (R1/R2; resolved entries stay as tombstones) */
	guardFacts: GuardFact[];
	/** the host cache ledger (port 2; observation + commit-timing marks) */
	cacheLedger: HostCacheLedger;
	/** D2: the coexistence verdict (settings + branch evidence) */
	foreignFolder: ForeignFolderState;
	/** provider-busyness probe config (DEFAULT off ⇒ null, no network at all) */
	probeUrl: string | null;
	/** close unit ids already deferred once by a busy probe (bounded, no livelock) */
	closeDeferrals: number[];
	/** per-close probe deferral budget (each close deferred at most once) */
	closeDeferralsLeft: number;
	/**
	 * P4 R3 (2026-09-30): terminal policy for spans native compaction already
	 * covers (spanCompactionCoverage, gates.ts).
	 * - "refuse" (DEFAULT, status quo): the gate outcome stands — the live
	 *   bank's ceiling noFold. R4's baseline semantics, byte-stable.
	 * - "tombstone" (opt-in, SAM_COMPACTED_SPAN=tombstone): terminal `resolved`
	 *   (compaction-owned); context_edits stay zero in both gate outcomes;
	 *   the gate arithmetic is recorded as evidence. A fold of a compacted
	 *   span would save ZERO view tokens and only rewrite preserved bytes,
	 *   which is why this exists.
	 */
	compactedSpanPolicy: "refuse" | "tombstone";
	/** whether the coexistence warning already went out this session */
	coexistWarned: boolean;
}

export interface SamState {
	/** Current mode; P3 implements all four (display manual assisted auto). */
	mode: SamMode;
	/**
	 * P4 R1: audit delivery dial. DEFAULT "followUp" (unchanged behavior);
	 * "steer" (operator opt-in, env `SAM_AUDIT_DELIVERY=steer`) delivers the
	 * close's audit into the running turn at close time instead of as a
	 * follow-up turn (plan carry #7; the steer-vs-ceiling orthogonality is
	 * measured — audit timing/quality never relaxes the commit gates).
	 */
	auditDelivery: AuditDelivery;
	/** P4 R1: unit ids whose close steered its audit, pending settle resolution. */
	steeredAudits: number[];
	/** Rebuilt from the session file at session_start. */
	ledger: SamLedger;
	/** close_unit executions of the current turn, awaiting settle resolution. */
	pendingCloses: PendingClose[];
	/** The audit in flight (at most one, F7). */
	audit: SamAuditInFlight | null;
	/** Verdicts awaiting commit (oldest first; normally 0 or 1). */
	pendingCommits: SamPendingCommit[];
	/** The undo in flight (at most one). */
	pendingUndo: SamPendingUndo | null;
	/** P3: the explicit /sam fold in flight (at most one). */
	pendingFold: SamPendingFold | null;
	/** P3: the governor (ladder, zone, backoff, facts, cache ledger, D2, probe). */
	governor: SamGovernorState;
	/**
	 * P3: staged span proofs keyed by unitId — created at capture/close-time
	 * (and at session_start for restored units), consumed at commit.
	 */
	spanProofs: Map<number, StagedSpanProof>;
}

export function createSamState(ledger: SamLedger, mode?: SamMode): SamState {
	return {
		mode: mode ?? ledger.mode,
		auditDelivery: "followUp", // DEFAULT — the P2/P3 behavior unless the operator opts in
		steeredAudits: [],
		ledger,
		pendingCloses: [],
		audit: null,
		pendingCommits: [...ledger.pendingCommits],
		pendingUndo: null,
		pendingFold: null,
		governor: {
			ladder: null,
			lastModelSig: null,
			zone: "calm",
			settleCount: 0,
			rejectMemory: new Map(),
			autoTriedSpans: [],
			autoDeferralsLeft: 2,
			modeHistory: [],
			guardFacts: [],
			cacheLedger: createHostCacheLedger(),
			foreignFolder: { present: false, basis: "not yet detected" },
			probeUrl: null,
			closeDeferrals: [],
			closeDeferralsLeft: 1,
			compactedSpanPolicy: "refuse",
			coexistWarned: false,
		},
		spanProofs: new Map(),
	};
}

/**
 * Stage the span proof for a unit about to be committed (commitproof.ts):
 * the fingerprint of the span's CURRENT branch content. Revalidation at
 * commit allows append-only growth beyond the span, invalidates any change
 * inside it, and fails closed on a missing proof.
 */
export function stageSpanProof(
	state: SamState,
	unitId: number,
	span: { spanFirstId: string; spanLastId: string; entryIds: string[] },
	branch: readonly PlainEntry[],
): StagedSpanProof {
	const byId = new Map<string, PlainEntry>();
	branch.forEach((entry) => byId.set(entry.id, entry));
	const entries: PlainEntry[] = [];
	for (const id of span.entryIds) {
		const entry = byId.get(id);
		if (entry) entries.push(entry);
	}
	const proof = {
		spanFirstId: span.spanFirstId,
		spanLastId: span.spanLastId,
		entryIds: [...span.entryIds],
		fingerprint: fingerprintSpan(entries),
		messageCount: entries.length,
		stagedAtSettle: state.governor.settleCount,
	};
	state.spanProofs.set(unitId, proof);
	return proof;
}

/* ── derived counters (for /sam status & the announce) ──────────────────── */

export interface SamCounts {
	folded: number;
	refused: number;
	undone: number;
	resolved: number;
	inFlight: number;
}

export function countUnits(ledger: SamLedger): SamCounts {
	const counts: SamCounts = { folded: 0, refused: 0, undone: 0, resolved: 0, inFlight: 0 };
	for (const unit of ledger.units) {
		if (unit.state === "in-flight") counts.inFlight += 1;
		else counts[unit.state] += 1;
	}
	return counts;
}

/**
 * Entry ids currently inside folded (not undone, not tombstoned) spans — the
 * already-closed check for new closes and span resolution (P2). P3:
 * branch-aware and EXTENDED (2026-09-30 banked finding #2): the fold's own
 * `context_edit` entries (stub + null edits) are part of the folded region,
 * and a candidate span touching them is the second-fold hazard (the s5
 * nine-batch discard, measured). Undone units stay out — their edits are
 * superseded and re-folding the work is legitimate intent.
 */
export function foldedEntryIdSet(ledger: SamLedger, branch?: readonly PlainEntry[]): Set<string> {
	const ids = new Set<string>();
	if (branch !== undefined) {
		for (const region of foldedRegions(ledger, branch)) region.entryIds.forEach((id) => ids.add(id));
		return ids;
	}
	for (const unit of ledger.units) {
		if (unit.state === "folded" && unit.entryIds) unit.entryIds.forEach((id) => ids.add(id));
	}
	return ids;
}

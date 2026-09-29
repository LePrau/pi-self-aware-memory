/**
 * In-memory session state for the extension.
 *
 * P2: the durable state is the ledger (rebuildable from the session file on
 * load, see ledger.ts); this state adds the process-local action queues that
 * ride pi's settle boundary. Everything here is re-derivable from the ledger
 * plus the branch, so a crash loses at most one settle's worth of intent
 * (the rebuild re-resolves it — fail-open, F1).
 *
 * Deliberately process-local: one pi process drives one session at a time.
 */

import type { PlainContent, PlainUsage } from "./projection.ts";
import type { SamLedger } from "./ledger.ts";
import type { PendingClose, UnitSpan } from "./units.ts";
import type { Verdict } from "./verdict.ts";

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

/** `/sam undo` in flight: drafts computed, commit at the next settle. */
export interface SamPendingUndo {
	unitId: number;
	/** span message entry ids in span order, each with its original content */
	targets: { id: string; content: PlainContent }[];
}

export interface SamState {
	/** Current mode; P2 implements display + manual (assisted/auto = P3). */
	mode: SamMode;
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
}

export function createSamState(ledger: SamLedger, mode?: SamMode): SamState {
	return {
		mode: mode ?? ledger.mode,
		ledger,
		pendingCloses: [],
		audit: null,
		pendingCommits: [...ledger.pendingCommits],
		pendingUndo: null,
	};
}

/* ── derived counters (for /sam status & the announce) ──────────────────── */

export interface SamCounts {
	folded: number;
	refused: number;
	undone: number;
	inFlight: number;
}

export function countUnits(ledger: SamLedger): SamCounts {
	const counts: SamCounts = { folded: 0, refused: 0, undone: 0, inFlight: 0 };
	for (const unit of ledger.units) {
		if (unit.state === "in-flight") counts.inFlight += 1;
		else counts[unit.state] += 1;
	}
	return counts;
}

/** Entry ids currently inside folded (not undone) spans. */
export function foldedEntryIdSet(ledger: SamLedger): Set<string> {
	const ids = new Set<string>();
	for (const unit of ledger.units) {
		if (unit.state === "folded" && unit.entryIds) {
			unit.entryIds.forEach((id) => ids.add(id));
		}
	}
	return ids;
}

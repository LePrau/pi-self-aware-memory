/**
 * Fold and undo drafts — the context_edit entries the extension commits at
 * pi's `agent_before_settle` boundary (design note §3-5).
 *
 * pi v0.87.1 semantics (verified): drafts are append-only, the latest edit
 * wins per target, a `null` replacement omits the entry from the projection
 * (the raw entry stays in the file). Undo therefore commits *new* edits that
 * re-apply each span entry's original content — latest-wins restores the
 * original view without touching history.
 */

import { foldStubText } from "./protocol.ts";
import { runCommitGates, type CommitGateInput, type CommitGateOutcome, type CompactionCoverage } from "./gates.ts";
import type { PlainContent, PlainEntry } from "./projection.ts";
import type { SamLedger, SamNoFoldRecord, SamResolveRecord } from "./ledger.ts";
import type { UnitSpan } from "./units.ts";
import type { SamMode } from "./state.ts";

/** A context_edit draft (pi's BoundaryResult entry shape, minus the base). */
export interface ContextEditDraft {
	type: "context_edit";
	targetId: string;
	replacement: { content: PlainContent } | null;
}

/**
 * The append-only fold: replace the unit's opening user message with the stub
 * text; null every later message entry of the span out of the projection.
 * Non-message entries in the span (custom ledger records) are not targeted —
 * they contribute no context either way.
 */
export function buildFoldDrafts(span: UnitSpan, corrections?: string): ContextEditDraft[] {
	const [first, ...rest] = span.targetIds;
	if (first === undefined) return [];
	return [
		{
			type: "context_edit",
			targetId: first,
			replacement: { content: foldStubText(span.unitId, span.stub, corrections) },
		},
		...rest.map((targetId): ContextEditDraft => ({ type: "context_edit", targetId, replacement: null })),
	];
}

/** The original content of one span message entry (read from the raw branch). */
export interface OriginalMessage {
	id: string;
	content: PlainContent;
}

/**
 * The append-only undo: re-apply each span message entry's original content,
 * in span order, so the latest-wins rule restores the pre-fold view exactly.
 */
export function buildUndoDrafts(targetIds: readonly string[], originals: readonly OriginalMessage[]): ContextEditDraft[] {
	const byId = new Map(originals.map((o) => [o.id, o.content]));
	return targetIds
		.map((targetId): ContextEditDraft | null => {
			const content = byId.get(targetId);
			return content === undefined ? null : { type: "context_edit", targetId, replacement: { content } };
		})
		.filter((d): d is ContextEditDraft => d !== null);
}

/* ── P3: the pre-commit gate (banked finding: validate BEFORE drafts) ────── */

/**
 * Prepare a fold commit: run the full gate chain (gates.ts) and return the
 * drafts ONLY when every gate passed. This is the single place the glue
 * calls before any context_edit draft exists — the 2026-09-30 banked finding
 * ("folder.ts must validate editability before returning drafts") lands here
 * so the draft path is structurally unreachable on a failed gate.
 *
 * The gate list is deterministic and ledger-ready (it goes verbatim into the
 * noFold record's `reasons`).
 */
export function prepareFoldCommit(
	span: { unitId: number; spanFirstId: string; spanLastId: string; entryIds: string[]; stub: string; targetIds: string[] },
	ctx: {
		branch: readonly PlainEntry[];
		ledger: SamLedger;
		beforeTokens: number | null;
		contextWindow: number;
	},
	opts?: { corrections?: string; applyKeepWindow?: boolean },
): { ok: true; drafts: ContextEditDraft[]; gate: CommitGateOutcome } | { ok: false; reasons: string[]; gate: CommitGateOutcome } {
	const input: CommitGateInput = {
		spanFirstId: span.spanFirstId,
		spanLastId: span.spanLastId,
		spanEntryIds: span.entryIds,
		targetIds: span.targetIds,
		unitId: span.unitId,
		stub: span.stub,
		corrections: opts?.corrections,
		branch: ctx.branch,
		ledger: ctx.ledger,
		beforeTokens: ctx.beforeTokens,
		contextWindow: ctx.contextWindow,
		applyKeepWindow: opts?.applyKeepWindow ?? false,
	};
	const outcome = runCommitGates(input);
	if (!outcome.ok) return { ok: false, reasons: outcome.reasons, gate: outcome };
	return { ok: true, drafts: buildFoldDrafts(span, opts?.corrections), gate: outcome };
}

/* ── P4 R3 (2026-09-30): the compaction-owned terminal (PURE — R4 replay discipline) ── */

/**
 * P4 R3: the terminal decision for a span native compaction ALREADY covers
 * (`spanCompactionCoverage`, gates.ts). Pure and ledger-ready so the replay
 * harness can drive it with banked-file inputs (R4 discipline: real src
 * modules, no factory, no glue) and so the glue stays a thin dispatcher.
 *
 * Semantics (policy "tombstone" — the opt-in; the default "refuse" leaves
 * the status-quo path above untouched, keeping R4's baseline byte-stable):
 * - gate REJECTED (the live bank's case, reason=ceiling): the gate outcome
 *   stays on record as a `noFold` SIBLING (the arithmetic is evidence, not
 *   the terminal); the unit terminals as `resolved` (compaction-owned).
 * - gate PASSED: the fold is still never issued — ZERO context_edits, because
 *   a compacted span is already out of the view (a fold would save nothing
 *   and only rewrite preserved ground-truth bytes); the unit terminals as
 *   `resolved` with empty gateReasons.
 * Either way the tombstone carries the unit's full evidence (stub, span
 * anchors, entry ids, verdict) so the ledger documents the unit stand-alone.
 * The close-flow caller only ever reaches here with a VERIFIED unit (the
 * CORRECTIONS/UNAUDITABLE branches settle earlier) — hence the fixed
 * verdict, mirroring `commitFoldDecision`'s existing records.
 */
export interface TombstoneEvidence {
	unitId: number;
	spanFirstId: string;
	spanLastId: string;
	entryIds: string[];
	stub: string;
	corrections?: string;
	/** the session's mode (the glue always has one; the record's mode field is required) */
	mode: SamMode;
}

export interface TombstoneDecision {
	record: SamResolveRecord;
	/** the sibling evidence record — present exactly when the gate rejected */
	noFold?: SamNoFoldRecord;
	/** always zero drafts (fold never issued for a compacted span) */
	drafts: [];
}

export function tombstoneCompactedSpan(
	prepared: { ok: boolean; reasons?: string[] },
	evidence: TombstoneEvidence,
	ts: number = Date.now(),
): TombstoneDecision {
	const { unitId, spanFirstId, spanLastId, entryIds, stub, corrections, mode } = evidence;
	const gateReasons = prepared.ok ? [] : (prepared.reasons ?? []);
	const record: SamResolveRecord = {
		v: 1,
		kind: "resolve",
		unitId,
		basis: "compaction-owned",
		spanFirstId,
		spanLastId,
		entryIds,
		stub,
		verdict: "VERIFIED",
		corrections,
		gateReasons,
		ts,
	};
	const noFold: SamNoFoldRecord | undefined = prepared.ok
		? undefined
		: {
				v: 1,
				kind: "noFold",
				unitId,
				entryIds,
				spanFirstId,
				spanLastId,
				stub,
				verdict: "VERIFIED",
				corrections,
				reason: gateReasons[0]?.split(":")[0] ?? "gate",
				reasons: gateReasons,
				ts,
				mode,
			};
	return { record, noFold, drafts: [] };
}

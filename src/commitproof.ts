/**
 * Commit proofs — the "issued vs committed" machinery (2026-09-30 banked
 * findings #2/#3, port list item 3).
 *
 * Measured on pi v0.87.1 (pinned source):
 * - `appendContextEdit` throws when a target is missing, off-branch, or
 *   non-editable (`session-manager.ts:1358-1381`);
 * - the extension runner rebuilds the boundary preview from the ACCUMULATED
 *   draft batch, and one thrown validation discards the WHOLE batch of every
 *   extension, `entries: []` (`extensions/runner.ts:944-971`), with our
 *   ledger record in that same batch;
 * - the extension handler receives NO callback about the discard (only an
 *   `emitError` to stderr, measured on the live s5 run: nine silent
 *   discards, zero committed).
 *
 * Consequence: "the extension emitted the fold" is NOT "the fold is in the
 * session". This module makes both directions checkable from the branch
 * alone (session file = ground truth, the s5 analyzer lesson):
 *
 * - `fingerprintSpan` / `revalidateSpan` (port of their `pending-slot.ts`
 *   `fingerprintContext` + `pendingMatchesBranch`): a staged span's proof —
 *   entry ids, order, content fingerprint — must still hold when the commit
 *   runs. Append-only growth beyond the span is allowed; any change inside
 *   the span, a missing entry, or a reordered span invalidates; a missing
 *   proof fails CLOSED (nothing commits), per their revalidatePending rule.
 * - `foldCommitProof` / `lostFolds`: a unit the ledger calls `folded` is
 *   only committed if the branch actually carries its stub edit (the batch
 *   is all-or-nothing, so the stub edit's presence proves the whole batch
 *   landed). A folded unit without proof is a LOST fold: the glue appends
 *   an append-only `foldLost` tombstone (port list item 7's rule: a
 *   resolved/dead fact becomes a tombstone, never silently reverted) and
 *   the unit's live state becomes `resolved`. The ledger then tells the
 *   truth — no more s5-style "telemetry says folded, session says nothing".
 */

import { createHash } from "node:crypto";

import { foldStubText } from "./protocol.ts";
import type { PlainEntry } from "./projection.ts";
import type { SamLedger } from "./ledger.ts";

/* ── staged-span proof (port: pending-slot revalidation) ─────────────────── */

/** Content-relevant view of one message entry (what a fold depends on). */
function entryFingerprintParts(entry: PlainEntry): unknown {
	if (entry.kind === "message") {
		const m = entry.message;
		return [
			entry.id,
			"message",
			m.role,
			m.content,
			m.stopReason ?? null,
			m.toolCallId ?? null,
			m.toolName ?? null,
			m.isError ?? null,
		];
	}
	return [entry.id, entry.kind];
}

/** SHA-256 over the staged span's content-relevant entries (order matters). */
export function fingerprintSpan(entries: readonly PlainEntry[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) {
		hash.update(JSON.stringify(entryFingerprintParts(entry)));
		hash.update("\n");
	}
	return hash.digest("hex");
}

export interface StagedSpanProof {
	spanFirstId: string;
	spanLastId: string;
	entryIds: string[];
	fingerprint: string;
	messageCount: number;
	/** the settle number the proof was staged at (for the ledger) */
	stagedAtSettle: number;
}

export type SpanRevalidation = { ok: true } | { ok: false; reason: "missing-entries" | "content-changed" };

/**
 * Re-validate a staged span against the CURRENT branch. The span must still
 * exist as the SAME contiguous block of entries with the SAME content; the
 * branch may have grown AFTER the span (audit exchange, new work) —
 * append-only growth is allowed (their pendingMatchesBranch rule). A missing
 * proof or a mismatch ⇒ the caller fails closed (no fold, no undo).
 */
export function revalidateSpan(proof: StagedSpanProof | null | undefined, branch: readonly PlainEntry[]): SpanRevalidation {
	if (proof === null || proof === undefined) return { ok: false, reason: "missing-entries" };
	const index = new Map<string, number>();
	branch.forEach((entry, i) => index.set(entry.id, i));
	const positions = proof.entryIds.map((id) => index.get(id));
	if (positions.some((p) => p === undefined)) return { ok: false, reason: "missing-entries" };
	const sorted = [...positions].sort((a, b) => (a as number) - (b as number));
	for (let i = 0; i < positions.length; i++) {
		if (sorted[i] !== positions[i]) return { ok: false, reason: "content-changed" }; // reordered ⇒ not the same span
	}
	let first = Infinity;
	let last = -Infinity;
	for (const p of positions) {
		first = Math.min(first, p as number);
		last = Math.max(last, p as number);
	}
	if (last - first + 1 !== positions.length) return { ok: false, reason: "content-changed" }; // not contiguous ⇒ interleaved
	const block = branch.slice(first, last + 1);
	if (block.length !== proof.entryIds.length) return { ok: false, reason: "content-changed" };
	if (fingerprintSpan(block) !== proof.fingerprint) return { ok: false, reason: "content-changed" };
	return { ok: true };
}

/* ── fold commit outcome (issued vs committed) ───────────────────────────── */

/** Normalized text of a context_edit replacement (string or text blocks). */
function replacementText(replacement: { content: unknown } | null): string | null {
	if (replacement === null) return null;
	const content = replacement.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let text = "";
		for (const block of content) {
			if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
				const t = (block as { text?: unknown }).text;
				if (typeof t === "string") text += t;
			}
		}
		return text;
	}
	return null;
}

/**
 * Does the branch prove this fold's batch was committed? The stub edit
 * targets the span's first entry with the exact stub text; the batch is
 * all-or-nothing, so its presence proves the whole batch (including every
 * null edit) landed. An UNDO does not negate the proof: the undo appends
 * NEWER edits, the fold's edits stay in the branch (append-only), and the
 * unit would then be `undone`, not `folded` — lostFolds only consults
 * folded-state units.
 */
export function foldCommitProof(
	fold: { unitId: number; spanFirstId: string; stub: string; corrections?: string },
	branch: readonly PlainEntry[],
): boolean {
	const expected = foldStubText(fold.unitId, fold.stub, fold.corrections);
	for (const entry of branch) {
		if (entry.kind !== "context_edit" || entry.targetId !== fold.spanFirstId) continue;
		const text = replacementText(entry.replacement);
		if (text === null) continue;
		if (text === expected) return true;
	}
	return false;
}

/**
 * Folded-state units whose stub edit is absent from the branch — i.e. the
 * fold was ISSUED but discarded by pi's boundary validation (whole-batch
 * discard, measured). Deterministic: ledger order.
 */
export function lostFolds(ledger: SamLedger, branch: readonly PlainEntry[]): number[] {
	const lost: number[] = [];
	for (const unit of ledger.units) {
		if (unit.state !== "folded" || !unit.entryIds || unit.entryIds.length === 0) continue;
		// spanFirstId is the first entry id of the folded span (records carry
		// entryIds in span order; the record's foldStubText is built from the
		// same stub — the unit's stub field).
		if (!foldCommitProof({ unitId: unit.unitId, spanFirstId: unit.entryIds[0], stub: unit.stub, corrections: unit.corrections }, branch)) {
			lost.push(unit.unitId);
		}
	}
	return lost;
}

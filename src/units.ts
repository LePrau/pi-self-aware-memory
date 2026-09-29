/**
 * Unit span resolution — pure logic over plain entries (no pi imports).
 *
 * Product semantics (design note §1, 2026-09-25-p2-design.md):
 * - a unit runs from the last *real* user message to the last `close_unit`
 *   toolResult in the turn; `[sam-`-injected user messages never open a unit
 *   (F4: injected lines are self-noise, not work);
 * - at most one close_unit per turn: the tool refuses a second call, so the
 *   ledger stays 1:1 with turns; the "last of pendingCloses" below remains a
 *   defensive over-run rule (restored/legacy state only);
 * - a close whose candidate span touches an already-folded span is refused
 *   (idempotent duplicate-close protection).
 */

import { isSamInjected } from "./protocol.ts";
import { messageText, type PlainEntry, type PlainMessage } from "./projection.ts";

/** A close_unit execution waiting for settle-time resolution. */
export interface PendingClose {
	unitId: number;
	stub: string;
	toolCallId: string;
}

/** The resolved fold span of one unit. */
export interface UnitSpan {
	unitId: number;
	/** the entry id of the real user message opening the unit */
	spanFirstId: string;
	/** the entry id of the close's toolResult */
	spanLastId: string;
	/** every entry id from spanFirstId to spanLastId, inclusive */
	entryIds: string[];
	/** the stub text passed to close_unit (of the effective close) */
	stub: string;
	/** the message-kind entry ids in span order (the fold/undo targets) */
	targetIds: string[];
}

export type SpanError =
	| { ok: false; error: "no-pending-close" }
	| { ok: false; error: "no-tool-result" }
	| { ok: false; error: "no-work" }
	| { ok: false; error: "already-closed" };

export type SpanResolution = { ok: true; span: UnitSpan } | SpanError;

/** Index of the last message-kind entry satisfying the predicate (-1 if none). */
function messageEntryIndex(entries: PlainEntry[], predicate: (message: PlainMessage) => boolean): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind === "message" && predicate(entry.message)) return i;
	}
	return -1;
}

/**
 * Resolve the unit that just closed, given this turn's pending closes and the
 * set of entry ids already inside folded spans. Pure.
 */
export function resolveUnitSpan(
	entries: PlainEntry[],
	pendingCloses: PendingClose[],
	foldedEntryIds: ReadonlySet<string>,
): SpanResolution {
	if (pendingCloses.length === 0) return { ok: false, error: "no-pending-close" };
	// Defensive: the last pending close is effective (the tool normally
	// allows at most one close per turn).
	const close = pendingCloses[pendingCloses.length - 1];

	// Locate the close's toolResult entry (pi appends it after execute).
	const toolResultIndex = messageEntryIndex(
		entries,
		(m) => m.role === "toolResult" && m.toolCallId === close.toolCallId,
	);
	if (toolResultIndex === -1) return { ok: false, error: "no-tool-result" };

	// Unit start: the last real user message at or before the toolResult.
	let startIndex = -1;
	for (let i = toolResultIndex; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind !== "message" || entry.message.role !== "user") continue;
		if (isSamInjected(messageText(entry.message.content))) continue;
		startIndex = i;
		break;
	}
	if (startIndex === -1) return { ok: false, error: "no-work" };

	// Duplicate-close protection: the candidate span must not touch a folded span.
	const spanEntries = entries.slice(startIndex, toolResultIndex + 1);
	if (spanEntries.some((entry) => foldedEntryIds.has(entry.id))) {
		return { ok: false, error: "already-closed" };
	}

	const span: UnitSpan = {
		unitId: close.unitId,
		spanFirstId: spanEntries[0].id,
		spanLastId: spanEntries[spanEntries.length - 1].id,
		entryIds: spanEntries.map((e) => e.id),
		stub: close.stub,
		targetIds: spanEntries.filter((e) => e.kind === "message").map((e) => e.id),
	};
	return { ok: true, span };
}

/**
 * Whether the last real (non-injected) user message lies inside an already
 * folded span — the cheap pre-check the tool execute() uses before creating a
 * ledger record (the full check happens at settle).
 */
export function lastRealUserEntryIsFolded(
	entries: PlainEntry[],
	foldedEntryIds: ReadonlySet<string>,
): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind !== "message" || entry.message.role !== "user") continue;
		if (isSamInjected(messageText(entry.message.content))) continue;
		return foldedEntryIds.has(entry.id);
	}
	return false;
}

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
	| { ok: false; error: "already-closed" }
	// v4 (close-audit, close-to-close spans — v4-plan §4): the unit's close
	// record is not in view, or the span since the previous close carries no
	// new work (the no-work-since-previous-close refusal, §3 step 2/S6).
	| { ok: false; error: "close-record-missing" }
	| { ok: false; error: "no-new-work" };

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

/* ── v4 (close-audit): close-to-close spans ─────────────────────────────────
 *
 * v4-plan §3 step 3 + §4. The v3 span (resolveUnitSpan, anchored on the
 * close's toolResult) stays byte-stable for the v3 dials (branch control,
 * followUp, steer). Under the `close` dial a turn may close N units, and
 * each unit's span is anchored on the CLOSE RECORD (a `sam` custom entry,
 * committed file-durable before its audit) rather than the close's
 * toolResult (which is appended after the handler returns and is a boundary
 * artifact — in NO span, F4 self-noise):
 *
 *   unit 1   : [last real (non-injected) user message … close 1's close record]
 *   unit k>1 : [after close (k−1)'s toolResult           … close k's close record]
 *
 * The close's own toolResult sits between the close record and the next
 * unit's start boundary, so it is carried by neither span.
 */

/** A `sam` custom close record (the file-durable close mark). */
function isSamCloseRecord(e: PlainEntry): e is PlainEntry & { customType: string; data: Record<string, unknown> } {
	if (e.kind !== "custom" || e.customType !== "sam") return false;
	const d = e.data as { kind?: unknown } | undefined;
	return typeof d?.kind === "string" && d.kind === "close";
}

/** Index of the toolResult for toolCallId before beforeIdx (-1 if absent). */
function toolResultIndex(entries: PlainEntry[], toolCallId: string, beforeIdx: number): number {
	for (let i = beforeIdx - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.kind === "message" && e.message.role === "toolResult" && e.message.toolCallId === toolCallId) return i;
	}
	return -1;
}

/** The span carries at least one work entry other than the close's own
 *  toolCall (user non-injected / assistant / any toolResult). */
function closeCallBlocks(content: unknown): { name?: unknown; id?: unknown }[] {
	if (!Array.isArray(content)) return [];
	return (content as unknown[]).filter(
		(b) => b && typeof b === "object" && (b as { type?: unknown }).type === "toolCall",
	) as { name?: unknown; id?: unknown }[];
}

/**
 * Is this assistant entry the close's OWN tool call (self-noise, F4)?
 * Measured pi 0.87.1 (probe bank r2): assistant entries carry NO message-
 * level toolCallId — the call identity is the content block
 * ({ type: "toolCall", name: "close_unit", id: … }). An entry whose tool
 * calls are all close_unit (and none carries another call's id) is the
 * close itself; any other tool call, any assistant TEXT, is work.
 */
function isCloseSelfCall(m: PlainMessage, closeToolCallId: string): boolean {
	const calls = closeCallBlocks(m.content);
	if (calls.length > 0) {
		if (!calls.every((c) => c.name === "close_unit")) return false; // a foreign call ⇒ work
		return calls.every((c) => c.id === undefined || c.id === closeToolCallId);
	}
	if (typeof m.content === "string") return m.content.trim() === ""; // text ⇒ work; empty ⇒ not
	const blocks = Array.isArray(m.content) ? (m.content as unknown[]) : [];
	// thinking-only (or empty) ⇒ not work
	return !blocks.some((b) => b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string");
}

/** The span carries at least one work entry other than the close's own
 *  call (user non-injected / assistant work / any toolResult). */
function spanHasNewWork(spanEntries: PlainEntry[], closeToolCallId: string): boolean {
	for (const e of spanEntries) {
		if (e.kind !== "message") continue; // custom (the close record) is not work
		const m = e.message;
		if (m.role === "user") {
			if (!isSamInjected(messageText(m.content))) return true;
			continue;
		}
		if (m.role === "toolResult") return true;
		if (m.role === "assistant") {
			if (m.toolCallId !== undefined && m.toolCallId !== closeToolCallId) return true; // marked as another call (synthetic shapes)
			if (isCloseSelfCall(m, closeToolCallId)) continue;
			return true;
		}
	}
	return false;
}


/** Input to a v4 close-span resolution. */
export interface CloseSpanInput {
	unitId: number;
	stub: string;
	/** this close's toolCall id (to exclude its own call from the work check) */
	toolCallId: string;
	/** the branch index of this unit's close record (the span's END) */
	closeRecordIndex: number;
}

export type CloseSpanResolution =
	| { ok: true; span: UnitSpan }
	| { ok: false; error: "close-record-missing" }
	| { ok: false; error: "no-new-work" }
	| { ok: false; error: "already-closed" };

/**
 * Resolve the close-to-close span of one close record (v4 `close` dial).
 * Pure. start = the last real user message (unit 1) or after the previous
 * close's toolResult (unit k>1); end = the close record; the close's own
 * toolResult is excluded (F4). Refusals: no close record in view, no new
 * work since the previous close, or the span touches a folded span.
 */
export function resolveCloseUnitSpan(
	entries: PlainEntry[],
	input: CloseSpanInput,
	foldedEntryIds: ReadonlySet<string>,
): CloseSpanResolution {
	const closeIdx = input.closeRecordIndex;
	if (closeIdx < 0 || closeIdx >= entries.length || !isSamCloseRecord(entries[closeIdx])) {
		return { ok: false, error: "close-record-missing" };
	}

	// Is there an earlier close record in view (unit k>1)?
	let prevCloseIdx = -1;
	for (let i = closeIdx - 1; i >= 0; i--) {
		if (isSamCloseRecord(entries[i])) { prevCloseIdx = i; break; }
	}

	let startIdx = -1;
	if (prevCloseIdx !== -1) {
		const prev = entries[prevCloseIdx] as unknown as { data: { toolCallId?: string } };
		const prevTool = prev.data.toolCallId;
		const tr = prevTool === undefined ? -1 : toolResultIndex(entries, prevTool, closeIdx);
		// The boundary is after the previous close's toolResult; if that
		// toolResult is absent (shouldn't be mid-turn), fall back to just
		// after the previous close record so the spans stay disjoint.
		startIdx = tr === -1 ? prevCloseIdx + 1 : tr + 1;
	} else {
		for (let i = closeIdx - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.kind === "message" && e.message.role === "user" && !isSamInjected(messageText(e.message.content))) {
				startIdx = i;
				break;
			}
		}
		if (startIdx === -1) return { ok: false, error: "no-new-work" };
	}

	if (startIdx > closeIdx) return { ok: false, error: "no-new-work" };
	const spanEntries = entries.slice(startIdx, closeIdx + 1);
	if (!spanHasNewWork(spanEntries, input.toolCallId)) return { ok: false, error: "no-new-work" };
	if (spanEntries.some((e) => foldedEntryIds.has(e.id))) return { ok: false, error: "already-closed" };

	const span: UnitSpan = {
		unitId: input.unitId,
		spanFirstId: spanEntries[0].id,
		spanLastId: spanEntries[spanEntries.length - 1].id,
		entryIds: spanEntries.map((e) => e.id),
		stub: input.stub,
		targetIds: spanEntries.filter((e) => e.kind === "message").map((e) => e.id),
	};
	return { ok: true, span };
}

/**
 * Pre-append guard for the v4 `close` dial, unit k>1 (v4-plan §3 step 2):
 * the LAST close record in view is the previous close, and the candidate
 * span since it (after its toolResult, through the current branch end)
 * must carry new work and touch no folded span — otherwise the close is
 * refused BEFORE anything is written. The final span (record-inclusive)
 * is resolved by resolveCloseUnitSpan once the record is committed.
 * The `already-closed` reuses the fold-overlap protection; `no-new-work`
 * is the replaced CLOSE_UNIT_PENDING refusal under this dial.
 */
export function closeCandidateSpanOk(
	entries: PlainEntry[],
	lastCloseIndex: number,
	currentToolCallId: string,
	foldedEntryIds: ReadonlySet<string>,
): "ok" | "no-new-work" | "already-closed" {
	if (lastCloseIndex < 0 || lastCloseIndex >= entries.length || !isSamCloseRecord(entries[lastCloseIndex])) {
		return "no-new-work";
	}
	const prev = entries[lastCloseIndex] as unknown as { data: { toolCallId?: string } };
	const tr = prev.data.toolCallId === undefined ? -1 : toolResultIndex(entries, prev.data.toolCallId, entries.length);
	const startIdx = tr === -1 ? lastCloseIndex + 1 : tr + 1;
	const endIdx = entries.length - 1;
	if (startIdx > endIdx) return "no-new-work";
	const spanEntries = entries.slice(startIdx, endIdx + 1);
	if (!spanHasNewWork(spanEntries, currentToolCallId)) return "no-new-work";
	if (spanEntries.some((e) => foldedEntryIds.has(e.id))) return "already-closed";
	return "ok";
}

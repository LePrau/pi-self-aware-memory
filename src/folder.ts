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
import type { PlainContent } from "./projection.ts";
import type { UnitSpan } from "./units.ts";

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

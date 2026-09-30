/**
 * Commit-time safety gates — the P3 governor's content-free predicates.
 *
 * Every gate runs BEFORE any context_edit draft is issued (plan §P3; 2026-09-30
 * port list item 1, "rejected content-free before any mutation"). Arithmetic
 * uses the SAME ruler as pi (F3): `estimate.ts` mirrors pi v0.87.1
 * `estimateTokens` byte-for-byte, and the before/after numbers a gate consumes
 * are pi's own `estimateProjectedContextTokens` values read at commit time
 * (the glue), never a second estimator.
 *
 * Port provenance (dev repo 2026-09-30 mechanism review; pi-smart-compact
 * v10.0.1 @ ce34692, MIT — logic ported, code not imported):
 * - `validateDraftTargets` mirrors pi v0.87.1 `appendContextEdit`'s own
   acceptance guards (`session-manager.ts:1358-1381`, pinned source,
   measured): a draft whose target does not exist, is off the active branch,
   or does not contribute editable model content makes pi's boundary preview
   THROW `Entry <id> does not contribute editable model content`, and pi then
   discards the ENTIRE draft batch of every extension, with the ledger record
   in that same batch (measured on the live s5 run: nine discarded batches,
   dev repo self-review 2026-09-30). Refusing here means pi's validation can
   never see an invalid target of ours.
 * - `toolPairIntegrity` ports the "never orphan a result from its tool call"
   hard-guard semantics of `steps/window.ts` + `helpers.ts
   guardToolCallBoundary` (the predicate, not their planner).
 * - `savingsGate` is the SAM adaptation of their yield gate
   (`domain/yield-gate.ts` + `MIN_COMPACTION_SAVING_RATIO = 0.1`): the ratio
   is measured against the SPAN being replaced (SAM folds one span; their
   compaction rewrites the whole prefix), so "stub at least 90 % of the span"
   rejects the pointlessly self-sealing fold — a stub nearly as long as the
   work it replaces.
 * - `keepWindowGate` carries plan §3.4: a fold is only worth automating for
   tokens OUTSIDE the keep window (pi v0.87.1 defaults
   `reserveTokens 16384`, `keepRecentTokens 20000`, measured in
   `settings-manager.ts:10-27`); at a 32k window those defaults make the keep
   window larger than the whole reachable context.
 */

import { estimateMessageTokens } from "./estimate.ts";
import { foldStubText } from "./protocol.ts";
import type { PlainEntry } from "./projection.ts";
import type { SamLedger } from "./ledger.ts";

/* ── defaults (documented single-source; P4 tunes against live windows) ─── */

/** pi v0.87.1 default reserveTokens (`settings-manager.ts:24`, measured). */
export const PI_DEFAULT_RESERVE_TOKENS = 16_384;
/** pi v0.87.1 default keepRecentTokens (`settings-manager.ts:25`, measured). */
export const PI_DEFAULT_KEEP_RECENT_TOKENS = 20_000;
/** Fold-ceiling fallback for an unknown window (see `defaultFoldCeiling`). */
const CEILING_NO_WINDOW = 16_384;
/** Minimum net-saving ratio of a fold — ported constant (0.1), see header. */
export const MIN_FOLD_SAVING_RATIO = 0.1;

export function defaultFoldCeiling(contextWindow: number | null | undefined): number {
	if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return CEILING_NO_WINDOW;
	// A fold's audit turn must read the whole span in one warm pass; a span
	// larger than a quarter of the window would wall-bind the audit itself.
	return Math.min(65_536, Math.max(4_096, Math.round(contextWindow / 4)));
}

/* ── drafts → pi acceptance (ported guards) ──────────────────────────────── */

/** The message roles pi v0.87.1 treats as editable context-edit targets. */
export const EDITABLE_ROLES: readonly string[] = ["user", "assistant", "toolResult"];

export type DraftProblemReason = "not-found" | "non-editable";

export interface DraftProblem {
	targetId: string;
	reason: DraftProblemReason;
	/** human-readable detail for ledger reasons / stderr */
	detail: string;
}

/**
 * Pre-validate a fold/undo draft batch against the branch, mirroring pi's
 * own `appendContextEdit` guards (see header). Pure; returns one problem per
 * offending target (empty ⇒ the batch can be accepted by pi's preview).
 *
 * SAM's plain model is single-branch, so pi's "not on the active branch"
 * guard maps onto "not-found" here (the adapter hands us exactly the active
 * branch). `custom_message` targets are never drafted by SAM, so they are
 * unreachable rather than a problem class.
 */
export function validateDraftTargets(
	drafts: readonly { targetId: string }[],
	branch: readonly PlainEntry[],
): DraftProblem[] {
	const byId = new Map<string, PlainEntry>();
	for (const entry of branch) byId.set(entry.id, entry);
	const problems: DraftProblem[] = [];
	for (const draft of drafts) {
		const entry = byId.get(draft.targetId);
		if (!entry) {
			problems.push({
				targetId: draft.targetId,
				reason: "not-found",
				detail: `entry ${draft.targetId} is not on the branch`,
			});
			continue;
		}
		if (entry.kind !== "message" || !EDITABLE_ROLES.includes(entry.message.role)) {
			const kind = entry.kind === "message" ? `message/${entry.message.role}` : `non-message entry (kind ${entry.kind})`;
			problems.push({
				targetId: draft.targetId,
				reason: "non-editable",
				detail: `${kind} does not contribute editable model content`,
			});
		}
	}
	return problems;
}

/* ── tool-call / tool-result pairing (ported hard-guard predicate) ───────── */

export interface PairProblem {
	kind: "orphaned-result" | "orphaned-call";
	/** the entry the fold batch removes from the projection */
	batchedId: string;
	/** the surviving entry whose pairing with it would break */
	otherId: string;
}

function blockToolCallId(block: { type: string; id?: unknown }): string | undefined {
	const v = (block as { id?: unknown }).id;
	return typeof v === "string" ? v : undefined;
}

/** toolCallId → entry id of the assistant message carrying the call. */
function toolCallIndex(branch: readonly PlainEntry[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of branch) {
		if (entry.kind !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (typeof content === "string") continue;
		for (const block of content) {
			if (block.type !== "toolCall") continue;
			const id = blockToolCallId(block);
			if (typeof id === "string" && id !== "") map.set(id, entry.id);
		}
	}
	return map;
}

/** toolCallId → entry id of the toolResult answering the call. */
function toolResultIndex(branch: readonly PlainEntry[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of branch) {
		if (entry.kind === "message" && entry.message.role === "toolResult" && entry.message.toolCallId) {
			map.set(entry.message.toolCallId, entry.id);
		}
	}
	return map;
}

function toolCallIdsOf(entry: PlainEntry): string[] {
	if (entry.kind !== "message" || entry.message.role !== "assistant") return [];
	const content = entry.message.content;
	if (typeof content === "string") return [];
	const ids: string[] = [];
	for (const block of content) {
		if (block.type !== "toolCall") continue;
		const id = blockToolCallId(block);
		if (typeof id === "string" && id !== "") ids.push(id);
	}
	return ids;
}

/**
 * Pair-integrity of a fold batch: the batched set (the entries the fold
 * removes from the projection — null-ed, or replaced by the stub) must be
 * CLOSED under the toolCall↔toolResult pairing. Splitting a pair orphaned
 * from its counterpart is the `tool_call_id is not found` class of provider
 * error the guard exists to prevent (pi-smart-compact's hard guard; plan
 * §P3 port item 4).
 *
 * Pairs that were already broken before the fold (one side absent from the
 * branch) are not the fold's problem and are not reported.
 */
export function toolPairIntegrity(batched: ReadonlySet<string>, branch: readonly PlainEntry[]): PairProblem[] {
	const calls = toolCallIndex(branch);
	const results = toolResultIndex(branch);
	const problems: PairProblem[] = [];

	for (const entry of branch) {
		if (!batched.has(entry.id) || entry.kind !== "message") continue;
		if (entry.message.role === "toolResult") {
			// A result the fold drops must have its call dropped with it.
			const callId = entry.message.toolCallId;
			if (!callId) continue;
			const callEntryId = calls.get(callId);
			if (callEntryId === undefined) continue; // orphan pre-exists; not the fold's
			if (!batched.has(callEntryId)) {
				problems.push({ kind: "orphaned-result", batchedId: entry.id, otherId: callEntryId });
			}
		} else if (entry.message.role === "assistant") {
			// A call the fold drops must have its result dropped with it.
			for (const callId of toolCallIdsOf(entry)) {
				const resultEntryId = results.get(callId);
				if (resultEntryId === undefined) continue; // pending result; nothing to orphan
				if (!batched.has(resultEntryId)) {
					problems.push({ kind: "orphaned-call", batchedId: entry.id, otherId: resultEntryId });
				}
			}
		}
	}
	return problems;
}

/* ── fold geometry over the branch ───────────────────────────────────────── */

/** Entry indices of [startId, endId] (inclusive); undefined when either is missing / out of order. */
export function spanIndexRange(
	branch: readonly PlainEntry[],
	startId: string,
	endId: string,
): { start: number; end: number } | undefined {
	let start = -1;
	let end = -1;
	for (let i = 0; i < branch.length; i++) {
		if (branch[i].id === startId) start = i;
		if (branch[i].id === endId) end = i;
	}
	if (start === -1 || end === -1 || start > end) return undefined;
	return { start, end };
}

/**
 * A folded unit's whole branch region: its span's entry ids plus the
 * `context_edit` entries that implement the fold (stub edit + null edits).
 * Undone units are excluded — their edits are superseded by the undo's
 * newer edits, and re-folding that work is legitimate user intent.
 */
export interface FoldRegion {
	unitId: number;
	/** every branch entry id inside the region (span + fold edits) */
	entryIds: string[];
	firstIndex: number;
	lastIndex: number;
}

export function foldedRegions(ledger: SamLedger, branch: readonly PlainEntry[]): FoldRegion[] {
	const idIndex = new Map<string, number>();
	branch.forEach((entry, i) => idIndex.set(entry.id, i));

	const targetToUnit = new Map<string, number>();
	for (const unit of ledger.units) {
		if (unit.state !== "folded" || !unit.entryIds) continue;
		for (const id of unit.entryIds) targetToUnit.set(id, unit.unitId);
	}
	const editsByUnit = new Map<number, string[]>();
	for (const entry of branch) {
		if (entry.kind !== "context_edit") continue;
		const unitId = targetToUnit.get(entry.targetId);
		if (unitId === undefined) continue;
		const list = editsByUnit.get(unitId) ?? [];
		list.push(entry.id);
		editsByUnit.set(unitId, list);
	}

	const regions: FoldRegion[] = [];
	for (const unit of ledger.units) {
		if (unit.state !== "folded" || !unit.entryIds) continue;
		const ids = [...unit.entryIds, ...(editsByUnit.get(unit.unitId) ?? [])];
		let first = Infinity;
		let last = -Infinity;
		for (const id of ids) {
			const i = idIndex.get(id);
			if (i === undefined) continue; // record outlived its branch (forked away)
			first = Math.min(first, i);
			last = Math.max(last, i);
		}
		if (first > last || !Number.isFinite(first)) continue;
		regions.push({ unitId: unit.unitId, entryIds: ids, firstIndex: first, lastIndex: last });
	}
	return regions;
}

/**
 * The "no second fold" predicate, extended (2026-09-30 banked finding #2):
 * not only must a candidate span avoid an already-folded span's MESSAGES
 * (P2), it must not intersect the fold's whole region — the stub edit and
 * null edits are non-editable entries, and they are exactly what made pi
 * discard nine whole batches on the s5 run. Returns the offending region or
 * undefined when the span is clear.
 */
export function spanIntersectsFoldedRegion(
	span: { spanFirstId: string; spanLastId: string },
	branch: readonly PlainEntry[],
	regions: readonly FoldRegion[],
): FoldRegion | undefined {
	const range = spanIndexRange(branch, span.spanFirstId, span.spanLastId);
	if (!range) return undefined;
	for (const region of regions) {
		if (range.start <= region.lastIndex && range.end >= region.firstIndex) return region;
	}
	return undefined;
}

/* ── arithmetic gates (single ruler, F3) ─────────────────────────────────── */

/**
 * Token mass of the span's MESSAGES (raw content, pi's per-message estimate).
 * A fold removes exactly this from the projection — except the first message,
 * which is REPLACED by the stub rather than dropped.
 */
export function spanTokenMass(span: { entryIds: readonly string[] }, branch: readonly PlainEntry[]): number {
	const byId = new Map<string, PlainEntry>();
	branch.forEach((entry) => byId.set(entry.id, entry));
	let tokens = 0;
	for (const id of span.entryIds) {
		const entry = byId.get(id);
		if (entry && entry.kind === "message") tokens += estimateMessageTokens(entry.message);
	}
	return tokens;
}

/** Token mass of the replacement stub (it lands as a user message). */
export function stubTokenMass(unitId: number, stub: string, corrections?: string): number {
	return estimateMessageTokens({ role: "user", content: foldStubText(unitId, stub, corrections) });
}

export interface GateArithmetic {
	spanTokens: number;
	stubTokens: number;
	/** max(0, span − stub): what the fold saves under the same-ruler estimate */
	savedTokens: number;
	ratio: number;
}

/**
 * Net-saving gate (yield-gate port, span-adapted — see header). Empty
 * savings is rejected outright; below the ratio the fold is pointlessly
 * self-sealing: it spends an audit turn + a cache rebuild to keep ~everything.
 */
export function savingsGate(spanTokens: number, stubTokens: number): { ok: boolean; reasons: string[]; arithmetic: GateArithmetic } {
	const savedTokens = Math.max(0, spanTokens - stubTokens);
	const ratio = spanTokens > 0 ? savedTokens / spanTokens : 0;
	const reasons: string[] = [];
	if (savedTokens < 1) reasons.push("savings: fold saves no tokens (stub >= span)");
	else if (ratio < MIN_FOLD_SAVING_RATIO) {
		reasons.push(`savings: net saving ${Math.round(ratio * 100)}% < ${Math.round(MIN_FOLD_SAVING_RATIO * 100)}% of the span`);
	}
	return { ok: reasons.length === 0, reasons, arithmetic: { spanTokens, stubTokens, savedTokens, ratio } };
}

/** F5 bounded (plan §4): a unit larger than the fold ceiling is not folded. */
export function ceilingGate(spanTokens: number, ceilingTokens: number): { ok: boolean; reasons: string[] } {
	if (spanTokens <= ceilingTokens) return { ok: true, reasons: [] };
	return {
		ok: false,
		reasons: [`ceiling: span ${spanTokens} tokens > fold ceiling ${ceilingTokens} tokens — left to native compaction (F5)`],
	};
}

/**
 * After-fold fit: pi's own pre-fold estimate minus the fold's saved tokens
 * must sit at or below the native trigger (window − reserve). Passes (no
 * numbers fabricated, F3) when pi's estimate or the window is unknown.
 */
export function fitsWindowGate(
	beforeTokens: number | null | undefined,
	savedTokens: number,
	contextWindow: number | null | undefined,
	reserveTokens: number,
): { ok: boolean; reasons: string[]; afterTokens: number | null } {
	if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return { ok: true, reasons: [], afterTokens: null };
	if (typeof beforeTokens !== "number" || !Number.isFinite(beforeTokens)) return { ok: true, reasons: [], afterTokens: null };
	const afterTokens = beforeTokens - savedTokens;
	const trigger = contextWindow - reserveTokens;
	if (afterTokens <= trigger) return { ok: true, reasons: [], afterTokens };
	return {
		ok: false,
		reasons: [`window: post-fold estimate ${afterTokens} tokens > native trigger ${trigger} tokens — the fold would not keep the session under the wall`],
		afterTokens,
	};
}

export interface KeepWindowResult {
	ok: boolean;
	reasons: string[];
	/** span tokens that lie OUTSIDE the keep window (the fold's honest gain) */
	outsideKeepTokens: number;
}

/**
 * The §3.4 keep-window rule: an AUTOMATIC fold is worth doing only for tokens
 * outside pi's keep window. Positioning uses the same per-message ruler
 * (chars/4) over the projected message order; the boundary is placed from
 * the larger of pi's total estimate and the chars/4 whole-branch sum (one
 * ruler, F3 — the split is labelled as a position split in the record).
 */
export function keepWindowGate(
	span: { entryIds: readonly string[] },
	branch: readonly PlainEntry[],
	piTotalTokens: number | null | undefined,
	keepRecentTokens: number,
): KeepWindowResult {
	const spanSet = new Set(span.entryIds);
	let total = 0;
	let spanStart = -1;
	let spanEnd = -1;
	let spanCount = 0;
	for (const entry of branch) {
		if (entry.kind !== "message") continue;
		const entryTokens = estimateMessageTokens(entry.message);
		const isSpanEntry = spanSet.has(entry.id);
		if (isSpanEntry && spanStart === -1) spanStart = total;
		total += entryTokens;
		if (isSpanEntry) {
			spanEnd = total;
			spanCount++;
		}
		if (spanCount >= span.entryIds.length) break;
	}
	const totalProject = Math.max(typeof piTotalTokens === "number" && Number.isFinite(piTotalTokens) ? piTotalTokens : 0, total);
	const keep = Math.max(0, Math.min(keepRecentTokens, totalProject));
	const keepStart = totalProject - keep;
	const outsideKeepTokens = spanStart === -1 || spanEnd === -1 ? 0 : Math.max(0, Math.min(spanEnd, keepStart) - spanStart);
	if (outsideKeepTokens > 0) return { ok: true, reasons: [], outsideKeepTokens };
	return {
		ok: false,
		reasons: [
			`keep-window: the span lies entirely inside pi's ${keep} token keep window — folding it would not save what native compaction keeps (plan §3.4)`,
		],
		outsideKeepTokens: 0,
	};
}

/**
 * The composite pre-commit gate chain — the ONE function the glue calls
 * BEFORE any fold draft exists. Deterministic order (tests pin it):
 * draft editability → pair integrity → fold-region intersection → savings →
 * ceiling → window fit → keep window.
 *
 * `applyKeepWindow` is the caller's decision: automatic folds (assisted
 * sweep, auto) apply it; an explicit close_unit in manual/display mode is
 * intent and is not keep-window-restricted (documented trade-off; the other
 * six gates still bind).
 */
export interface CommitGateInput {
	spanFirstId: string;
	spanLastId: string;
	spanEntryIds: readonly string[];
	/** fold: span message ids (stub target first); undo: restored ids */
	targetIds: readonly string[];
	unitId: number;
	stub: string;
	corrections?: string;
	branch: readonly PlainEntry[];
	ledger: SamLedger;
	/** pi's pre-fold estimate (F3 ruler); null when unknown */
	beforeTokens: number | null;
	/** pi's contextWindow (0/undefined = unknown) */
	contextWindow: number;
	reserveTokens?: number;
	keepRecentTokens?: number;
	applyKeepWindow?: boolean;
}

export interface CommitGateOutcome {
	ok: boolean;
	/** deterministic, ledger-ready reasons (empty when ok) */
	reasons: string[];
	arithmetic: {
		spanTokens: number;
		stubTokens: number;
		savedTokens: number;
		afterTokens: number | null;
		outsideKeepTokens: number | null;
	};
}

export function runCommitGates(input: CommitGateInput): CommitGateOutcome {
	const reserveTokens = input.reserveTokens ?? PI_DEFAULT_RESERVE_TOKENS;
	const keepRecentTokens = input.keepRecentTokens ?? PI_DEFAULT_KEEP_RECENT_TOKENS;
	const reasons: string[] = [];

	const draftTargets =
		input.targetIds.length > 0
			? input.targetIds
			: [input.spanFirstId, ...input.spanEntryIds.filter((id) => id !== input.spanFirstId)];

	const problems = validateDraftTargets(draftTargets.map((targetId) => ({ targetId })), input.branch);
	for (const problem of problems) reasons.push(`draft: ${problem.detail}`);

	const batched = new Set<string>(draftTargets);
	for (const pair of toolPairIntegrity(batched, input.branch)) {
		reasons.push(`integrity: ${pair.kind} — ${pair.batchedId} and ${pair.otherId} are one tool pair the fold would split`);
	}

	const regions = foldedRegions(input.ledger, input.branch);
	const region = spanIntersectsFoldedRegion(
		{ spanFirstId: input.spanFirstId, spanLastId: input.spanLastId },
		input.branch,
		regions,
	);
	if (region) {
		reasons.push(`second-fold: the span intersects folded unit ${region.unitId}'s region (span + fold edits) — no second fold (2026-09-30 banked finding)`);
	}

	const spanTokens = spanTokenMass({ entryIds: input.spanEntryIds }, input.branch);
	const stubTokens = stubTokenMass(input.unitId, input.stub, input.corrections);
	const savings = savingsGate(spanTokens, stubTokens);
	reasons.push(...savings.reasons);

	reasons.push(...ceilingGate(spanTokens, defaultFoldCeiling(input.contextWindow)).reasons);

	const windowFit = fitsWindowGate(input.beforeTokens, savings.arithmetic.savedTokens, input.contextWindow, reserveTokens);
	reasons.push(...windowFit.reasons);

	let outsideKeepTokens: number | null = null;
	if (input.applyKeepWindow) {
		const keep = keepWindowGate({ entryIds: input.spanEntryIds }, input.branch, input.beforeTokens, keepRecentTokens);
		outsideKeepTokens = keep.outsideKeepTokens;
		reasons.push(...keep.reasons);
	}

	return {
		ok: reasons.length === 0,
		reasons,
		arithmetic: {
			spanTokens,
			stubTokens,
			savedTokens: savings.arithmetic.savedTokens,
			afterTokens: windowFit.afterTokens,
			outsideKeepTokens,
		},
	};
}

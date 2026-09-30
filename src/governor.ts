/**
 * The P3 governor — when SAM acts, how much, and on whose evidence.
 *
 * Every rule here is a PURE function (or a pure state machine over plain
 * data) so the suite can prove each one (plan §P3 exit: "a suite that
 * proves each rule"):
 *
 * - pressure ladder + hysteresis under `ctx.getContextUsage()` (F3: one
 *   ruler — pi's estimate; pi v0.87.1 `agent-session.ts:3858` hands out
 *   exactly `estimateProjectedContextTokens`, measured);
 * - the threat predicate of plan §3.4 (a fold is only worth automating for
 *   tokens OUTSIDE the keep window) — enforced by `gates.keepWindowGate`,
 *   applied by the governor to automatic folds only;
 * - model_select recompute: the ladder re-derives and hysteresis/backoff
 *   reset when the model identity changes (pi 0.87.1 has no model_change
 *   EXTENSION EVENT — the session entry exists, the event does not,
 *   measured — so the glue signature-diffs at settle; the rule is pure);
 * - the om-guard curriculum, re-derived as port-list item 7's rule set:
 *   R1 guard facts persist until POSITIVE resolution evidence (negative
 *   silence never resolves a fact);
 *   R2 resolved facts become TOMBSTONES (kept for the report, never
 *   reactivated);
 *   R3 a mode de-escalation is a non-destructive breadcrumb — automatic
 *   sweeps refuse until the user positively re-escapes (anti-sweep);
 *   R4 self-noise excluded: sweep candidates come only from ledger units
 *     (whose spans are real work by construction — injected `[sam-`
 *     messages never open a unit, P2);
 *   R5 backoff: non-terminal gate rejections cool down (8 settles) instead
 *     of hot-looping (the om-guard "brake keeping itself hot" deadlock,
 *     re-derived for the sweep step);
 * - the coexistence guard (D2): detect + warn + refuse folds while another
 *   folding folder is active (port of om-guard's `omPresence` PATTERN —
 *   settings extensions array authoritative, leftover block ignored,
 *   unreadable ⇒ assume present);
 * - the provider-busyness probe (plan §P3, DEFAULT OFF): positive-only,
 *   `?autoload=false` MANDATORY (router is `--models-max 1`; a probe load
 *   would evict the resident model — om-guard patch-0013 precedent in
 *   ../../om-guard/provider-probe.ts), a busy read defers AT MOST ONCE
 *   (a probe failure never blocks — "a missed probe means nothing").
 */

import { PI_DEFAULT_KEEP_RECENT_TOKENS, PI_DEFAULT_RESERVE_TOKENS } from "./gates.ts";
import type { PlainEntry } from "./projection.ts";
import type { SamLedger } from "./ledger.ts";

/* ── model identity (model_select recompute) ─────────────────────────────── */

export interface GovernedModel {
	provider: string;
	id: string;
	contextWindow?: number;
}

/** Signature the governor diffs at settle (pi 0.87.1 has no model event — measured). */
export function modelSignature(model: GovernedModel | null | undefined): string {
	if (!model) return "none";
	return JSON.stringify([model.provider, model.id, model.contextWindow ?? null]);
}

/* ── pressure ladder + hysteresis ────────────────────────────────────────── */

export interface Ladder {
	window: number;
	reserve: number;
	keepRecent: number;
	/** hysteresis band: zones exit at entry − band (om-guard hysteresis precedent) */
	band: number;
}

/**
 * Derive the ladder. Passes (null ⇒ governor inert, fail-safe) when neither
 * pi nor the model reports a window. Reserve/keepRecent are pi v0.87.1
 * defaults (measured, `settings-manager.ts`); per-model settings plumbing
 * lands in P5 (labelled).
 */
export function ladderFor(contextWindow: number | null | undefined, model?: GovernedModel | null): Ladder | null {
	const window = contextWindow ?? model?.contextWindow;
	if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return null;
	const reserve = PI_DEFAULT_RESERVE_TOKENS;
	// A band smaller than this makes hysteresis jittery at small windows.
	const band = Math.max(1024, Math.round(reserve / 4));
	return { window, reserve, keepRecent: PI_DEFAULT_KEEP_RECENT_TOKENS, band };
}

export type Zone = "calm" | "watch" | "action";

/**
 * Zone with enter/exit hysteresis. `tokens === null` (no usage yet) keeps
 * the previous zone when one exists — the governor never fabricates a
 * ruler number (F3); with no previous zone it is `calm` (no automation).
 *
 * Layout (window = W, reserve = R):
 *   action: ≥ W − R            (at/over the native trigger — a fold here is
 *                              definitely worth it AND pre-empts native)
 *   watch:  ≥ W − 2R
 *   calm:   below
 * exits happen a band lower, so a fold's own relief cannot immediately
 * re-enter (the anti-flap the hysteresis exists for).
 */
export function pressureZone(ladder: Ladder, tokens: number | null, previousZone?: Zone | null): Zone {
	if (typeof tokens !== "number" || !Number.isFinite(tokens)) return previousZone ?? "calm";
	const { window, reserve, band } = ladder;
	const actionEnter = window - reserve;
	const actionExit = actionEnter - band;
	const watchEnter = window - 2 * reserve;
	const watchExit = watchEnter - band;

	const inAction = previousZone === "action" ? tokens >= actionExit : tokens >= actionEnter;
	if (inAction) return "action";
	const inWatch = previousZone === "watch" ? tokens >= watchExit : tokens >= watchEnter;
	if (inWatch) return "watch";
	return "calm";
}

/* ── guard facts (port-list item 7 rule set) ─────────────────────────────── */

export type GuardFactKind = "disputed-stub" | "gate-reject" | "commit-lost" | "user-deescalation";

export interface GuardFact {
	unitId?: number;
	kind: GuardFactKind;
	basis: string;
	sinceSettle: number;
	resolvedSettle?: number;
}

/** Active (unresolved) facts. R2: resolved facts stay in the list (tombstones). */
export function activeFacts(facts: readonly GuardFact[]): GuardFact[] {
	return facts.filter((f) => f.resolvedSettle === undefined);
}

/**
 * R1: positive resolution evidence for a fact on a unit. Negative silence
 * (settles passing, mode unchanged) is NOT resolution — the fact persists.
 * Evidence accepted in P3: explicit `/sam resolve`, undo, override-fold.
 */
export function resolveFactIfPositive(
	facts: readonly GuardFact[],
	unitId: number,
	kind: GuardFactKind,
	evidence: "user-resolved" | "undo" | "override-fold",
	settle: number,
): GuardFact[] | null {
	let changed = false;
	const next = facts.map((fact) => {
		if (fact.unitId !== unitId || fact.kind !== kind || fact.resolvedSettle !== undefined) return fact;
		changed = true;
		return { ...fact, resolvedSettle: settle };
	});
	return changed ? next : null;
}

/**
 * R3: the mode history is the breadcrumb trail. A de-escalation (auto mode
 * → display/manual) is ACTIVE while it is the most recent direction change;
 * a positive re-escalation clears it. Pure.
 */
export function userDeescalationActive(modeHistory: readonly { from: string; to: string }[]): boolean {
	for (let i = modeHistory.length - 1; i >= 0; i--) {
		const change = modeHistory[i];
		if (!change) continue;
		const down = (change.from === "assisted" || change.from === "auto") && (change.to === "display" || change.to === "manual");
		const up = (change.from === "display" || change.from === "manual") && (change.to === "assisted" || change.to === "auto");
		if (down) return true;
		if (up) return false;
	}
	return false;
}

/* ── R5 backoff (anti hot-loop) ──────────────────────────────────────────── */

/** Terminal rejects never auto-retry; non-terminal ones cool down. */
export const TERMINAL_GATE_REASONS = new Set([
	"draft",
	"integrity",
	"second-fold",
	"savings",
	"ceiling",
	"window",
	"keep-window",
	"empty-stub",
	"coexistence",
	"stale-span",
]);
export const NON_TERMINAL_COOLOWN_SETTLES = 8;

export interface RejectMemory {
	unitId: number;
	terminal: boolean;
	reason: string;
	rejections: number;
	nextEligibleSettle: number;
}

export function recordSweepReject(memory: Map<number, RejectMemory>, unitId: number, reasons: readonly string[], settle: number): Map<number, RejectMemory> {
	const head = reasons[0] ?? "unknown";
	const terminal = TERMINAL_GATE_REASONS.has(head.split(":")[0] ?? "");
	const existing = memory.get(unitId);
	const rejections = (existing?.rejections ?? 0) + 1;
	const nextEligibleSettle = terminal ? Number.MAX_SAFE_INTEGER : settle + NON_TERMINAL_COOLOWN_SETTLES;
	memory.set(unitId, { unitId, terminal, reason: head, rejections, nextEligibleSettle });
	return memory;
}

export function sweepEligible(memory: Map<number, RejectMemory>, unitId: number, settle: number): boolean {
	const record = memory.get(unitId);
	if (!record) return true;
	return settle >= record.nextEligibleSettle && !record.terminal;
}

/* ── sweep selection (assisted) ──────────────────────────────────────────── */

/**
 * The assisted-mode candidate: a unit the model CLOSED, the auditor
 * VERIFIED, and the display posture declined (reason "display mode") —
 * i.e. audit-verified, never folded, never refused on safety. CORRECTIONS
 * units are NEVER candidates (the disputed-stub rule keeps their raw span in
 * view — the risk-table safety). Deterministic: oldest first.
 */
export function sweepCandidates(ledger: SamLedger): number[] {
	return ledger.units
		.filter((u) => u.state === "refused" && u.verdict?.class === "VERIFIED" && u.reason === "display mode")
		.map((u) => u.unitId)
		.sort((a, b) => a - b);
}

/** R4 pin helper: candidates are ledger units only — never raw spans. */
export function sweepCandidateCount(ledger: SamLedger): number {
	return sweepCandidates(ledger).length;
}

/* ── auto mode: unmarked span selection ──────────────────────────────────── */

export interface AutoSpan {
	spanFirstId: string;
	spanLastId: string;
	/** message-kind entry ids in span order (the stub/audit/commit targets) */
	entryIds: string[];
}

export interface AutoSpanOptions {
	/** entry ids already inside folded (not undone) spans */
	foldedEntryIds: ReadonlySet<string>;
	/** ids of spans the model already stubbed+refused (tombstones) */
	triedSpans: ReadonlySet<string>;
	/** per-entry message-kind token split (same ruler) and ceiling test */
	spanTokens: (spanEntryIds: readonly string[]) => number;
	ceilingTokens: number;
	/** true when a non-editable message entry (system/bashExecution/…) lies in the span */
	nonEditableIds: (spanEntryIds: readonly string[]) => string[];
	/** true when the span carries a close_unit call/result — it is a ledger unit, not an auto target */
	hasCloseUnit: (spanEntryIds: readonly string[]) => boolean;
	/** true when the span has demonstrable work (≥1 toolResult or assistant text) */
	hasWork: (spanEntryIds: readonly string[]) => boolean;
}

/**
 * Pick the OLDEST fully-past unmarked block with demonstrable work — the
 * auto mode's escape-hatch target. A "block" = branch entries from one real
 * (non-injected) user message up to the next real user message. Rules (all
 * pure, all tested):
 * - the block must be CLOSED-OFF (a real user message follows it): the open
 *   tail is in-progress work, and folding it is the "folding something
 *   still needed" risk from plan §9 — `auto` refuses over it (kill
 *   criterion: unrecoverable loss of task-relevant context ⇒ auto never
 *   ships, plan §9);
 * - it must not be a ledger unit (no close_unit in it), must not touch
 *   folded or already-tried spans, and must not carry non-editable message
 *   entries (the commit gates would reject it anyway; the pre-filter keeps
 *   the reason list clean and the span small);
 * - ceiling + demonstrable work bind (F5 + the empty-stub floor).
 */
export function selectAutoSpan(
	entries: readonly PlainEntry[],
	isSamInjected: (text: string) => boolean,
	messageText: (content: unknown) => string,
	options: AutoSpanOptions,
): AutoSpan | undefined {
	// Pass 1: real user message positions.
	const userIndices: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.kind === "message" && entry.message.role === "user" && !isSamInjected(messageText(entry.message.content))) {
			userIndices.push(i);
		}
	}
	if (userIndices.length < 2) return undefined; // no closed-off block exists

	// Pass 2: blocks, oldest first. The LAST block is the open tail — skip.
	for (let b = 0; b < userIndices.length - 1; b++) {
		const start = userIndices[b] + 1;
		const end = userIndices[b + 1]; // exclusive
		const entryIds: string[] = [];
		let lastEntryId = "";
		for (let i = start; i < end; i++) {
			const entry = entries[i];
			if (entry.kind !== "message") continue;
			entryIds.push(entry.id);
			lastEntryId = entry.id;
		}
		const firstId = entries[userIndices[b]].id;
		if (entryIds.length === 0) continue; // work = nothing between the two users
		if (options.triedSpans.has(firstId)) continue;
		if (entryIds.some((id) => options.foldedEntryIds.has(id))) continue;
		if (options.hasCloseUnit(entryIds)) continue;
		if (options.nonEditableIds(entryIds).length > 0) continue;
		if (!options.hasWork(entryIds)) continue;
		const tokens = options.spanTokens(entryIds);
		if (tokens <= 0 || tokens > options.ceilingTokens) continue;
		return { spanFirstId: firstId, spanLastId: lastEntryId, entryIds };
	}
	return undefined;
}

/* ── coexistence guard (D2) ──────────────────────────────────────────────── */

export interface ForeignFolderState {
	present: boolean;
	basis: string;
}

/**
 * Port of the omPresence PATTERN (../../om-guard/om-presence.ts): the
 * settings `extensions` array is AUTHORITATIVE (an enabled block with
 * nothing loaded is the measured trap); no array ⇒ the block decides;
 * unreadable ⇒ assume present (conservative: the guard would rather refuse
 * folds than risk two folders editing one span, D2).
 */
export function detectForeignFolder(settings: Record<string, unknown> | null | undefined): ForeignFolderState {
	if (settings === null) return { present: true, basis: "settings unreadable — assuming a foreign folder (D2 conservative)" };
	if (settings === undefined) return { present: false, basis: "no settings read" };
	const extensions = settings["extensions"];
	if (Array.isArray(extensions)) {
		const listed = extensions.some((e) => typeof e === "string" && /observational-memory|om-guard/i.test(e));
		return listed
			? { present: true, basis: "settings.extensions lists a folding folder" }
			: { present: false, basis: "settings.extensions lists no folding folder (leftover block ignored)" };
	}
	const om = settings["observational-memory"];
	if (om && typeof om === "object") {
		return (om as { enabled?: boolean }).enabled === false
			? { present: false, basis: "observational-memory block present but enabled=false" }
			: { present: true, basis: "settings block present, no extensions array" };
	}
	return { present: false, basis: "no folding folder in settings" };
}

/**
 * Branch evidence outranks the settings read (a session may have started
 * before the config changed — omActiveInSession rule): any foreign ledger
 * entry with the `om.` customType prefix (measured: OM and om-guard both
 * use it, ../../om-guard/guard-types.ts:18).
 */
export function foreignFolderEvidence(branch: readonly PlainEntry[]): ForeignFolderState | null {
	for (const entry of branch) {
		if (entry.kind === "custom" && entry.customType.startsWith("om.")) {
			return { present: true, basis: `ledger evidence: ${entry.customType} entry on branch` };
		}
	}
	return null;
}

export function coexistenceGate(settingsState: ForeignFolderState, branch: readonly PlainEntry[]): ForeignFolderState {
	const evidence = foreignFolderEvidence(branch);
	if (evidence) return evidence;
	return settingsState;
}

/* ── provider busyness probe (DEFAULT OFF, positive-only) ────────────────── */

/**
 * `?autoload=false` is MANDATORY (plan §P3 line; om-guard patch-0013 §3.5):
 * in router mode the proxy's `models_autoload` defaults ON, so without the
 * param a probe LOADS the model and — with `--models-max 1` — evicts the
 * resident one.
 */
export function buildProbeUrl(baseUrl: string): string {
	let root = baseUrl.trim();
	while (root.endsWith("/")) root = root.slice(0, -1);
	if (root.endsWith("/v1")) root = root.slice(0, -3);
	else if (root.endsWith("/v1/")) root = root.slice(0, -4);
	return `${root}/slots?autoload=false`;
}

/** llama.cpp `/slots`: any slot with is_processing true ⇒ busy (positive-only). */
export function parseBusyStatus(body: unknown): "busy" | "idle" {
	if (Array.isArray(body)) {
		for (const slot of body) {
			if (slot && typeof slot === "object" && (slot as { is_processing?: unknown }).is_processing === true) return "busy";
		}
	}
	return "idle";
}

/**
 * The gate: `busy` defers (AT MOST ONCE per close — bounded, no livelock);
 * `idle` and `unavailable` proceed (a probe failure means nothing —
 * om-guard's "a missed probe means nothing" contract, re-derived).
 */
export function busynessGate(status: "busy" | "idle" | "unavailable"): "proceed" | "defer" {
	return status === "busy" ? "defer" : "proceed";
}

export const PROBE_DEFERRALS_PER_CLOSE = 1;

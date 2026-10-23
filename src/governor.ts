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
 *   (R3 mode de-escalation, R4 sweep self-noise and R5 reject backoff —
 *   removed 2026-10-16 with the display/assisted/auto modes: manual is the
 *   only mode, so there is no automatic sweep to protect or cool down.)
 * - the coexistence guard (D2): detect + warn + refuse folds while another
 *   folding folder is active (port of om-guard's `omPresence` PATTERN —
 *   settings extensions array authoritative, leftover block ignored,
 *   unreadable ⇒ assume present).
 *   (the provider-busyness probe moved out 2026-10-17 — Wave A extraction,
 *   see the dev repo provider-probe-base.ts)
 */

import { PI_DEFAULT_KEEP_RECENT_TOKENS, PI_DEFAULT_RESERVE_TOKENS } from "./gates.ts";
import type { PlainEntry } from "./projection.ts";
import { samEffectiveRaw } from "./settings.ts"; // v0.0.20/21: the settings dial layer (cycle is call-time-only)

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
 * pi's DEPLOYED compaction token settings (Q5, Paul 2026-10-16: read the
 * live values instead of hardcoding the built-ins — "avoid magic numbers").
 * Parsed from settings.json's `compaction` block; absent/invalid fields are
 * undefined and the caller falls back to the built-in defaults.
 */
export interface DeployedCompactionTokens {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

/** Positive finite integer tokens, else undefined (fail-safe). */
function positiveTokenValue(v: number | undefined): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/**
 * Derive the ladder. Passes (null ⇒ governor inert, fail-safe) when neither
 * pi nor the model reports a window. Reserve/keepRecent prefer pi's DEPLOYED
 * settings (`DeployedCompactionTokens`) over the built-in defaults
 * (measured, `settings-manager.ts`); a deployed value only wins when it is
 * a positive finite token count (the settings are operator-owned — a junk
 * value must not shrink the reserve).
 */
export function ladderFor(
	contextWindow: number | null | undefined,
	model?: GovernedModel | null,
	deployed?: DeployedCompactionTokens | null,
): Ladder | null {
	const window = contextWindow ?? model?.contextWindow;
	if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return null;
	const reserve = positiveTokenValue(deployed?.reserveTokens) ?? PI_DEFAULT_RESERVE_TOKENS;
	const keepRecent = positiveTokenValue(deployed?.keepRecentTokens) ?? PI_DEFAULT_KEEP_RECENT_TOKENS;
	// A band smaller than this makes hysteresis jittery at small windows.
	const band = Math.max(1024, Math.round(reserve / 4));
	return { window, reserve, keepRecent, band };
}

/** The native compaction line W−R (the `actionEnter` of the layout below) —
 *  single source for consumers (the nudge start-phase clamp, readouts). */
export function actionEnterOf(ladder: Ladder): number {
	return ladder.window - ladder.reserve;
}

/* ── context-pressure safenet (decision point 1, Paul 2026-10-16) ────────
 *
 * The post-fold summary can sit CLOSE to pi's own auto-fold line (W−R):
 * pi measures context the same way (F3) and will fold natively from there
 * without asking. The pressure nudge tells the model the summary is inside
 * `headroom` of that line, arms the auto-retire (part b), and consumes the
 * soft retire offer (Q4). Everything here is pure.
 */

/**
 * Post-fold summary headroom (Paul's ~20k, 2026-10-16). Env-overridable
 * (`SAM_PRESSURE_HEADROOM`, same envInt discipline as the other dials:
 * non-finite / non-positive ⇒ default). A headroom smaller than the
 * hysteresis band would make the nudge flap around the line — the
 * default (20k) sits well above any realistic band (band ≥ 1024).
 */
export const PRESSURE_HEADROOM_TOKENS = 20_000;

export function pressureHeadroomTokens(env: Record<string, string | undefined>): number {
	// v0.0.20: the settings.json dial joins — env (if set) wins temporarily.
	const raw = samEffectiveRaw("SAM_PRESSURE_HEADROOM", env); // v0.0.21: in-session > env > settings > default
	if (raw === undefined || raw.trim() === "") return PRESSURE_HEADROOM_TOKENS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : PRESSURE_HEADROOM_TOKENS;
}

/** The post-fold estimate at/above which the summary is within `headroom`
 *  of pi's auto-fold line (W−R). Pure. */
export function pressureLineOf(ladder: Ladder, headroom: number): number {
	return ladder.window - ladder.reserve - headroom;
}

/**
 * True when a post-fold estimate is within `headroom` of pi's auto-fold
 * line ⇒ the pressure nudge engages. `estimate` null/unknown ⇒ false
 * (fail-safe: the governor never fabricates a ruler number, F3 — an
 * unknown post-fold size gets no emergency order). Pure.
 */
export function pressureNudgeDue(ladder: Ladder, headroom: number, estimate: number | null): boolean {
	if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0) return false;
	return estimate >= pressureLineOf(ladder, headroom);
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

/**
 * D8 depth zone — the FRESH zone at close time (2026-10-02; Paul's ruling
 * (b): "the inheritance should be avoided — after a fold context SHOULD be
 * safe, so (b) is the right choice"). The audit child's depth is decided
 * from the LIVE close-time context on the same ladder — entry thresholds
 * only, NO hysteresis carryover: the dispatch runs mid-turn (inside the
 * close tool's execute), i.e. AFTER a mid-turn fold and BEFORE the next
 * message_end observation — so the governor's sticky state can still hold
 * the PRE-FOLD zone (measured 3×: rep-3 u2 @4,297 tok post-fold ⇒ LIGHT
 * dispatched (re-pinned as an honest F3-FAIL); rep-4 u1 ⇒ self-healed by
 * D9; rep-7 u4 ⇒ self-healed by D9). The hysteresis itself stays for the
 * governor's running decisions (anti-flap); this is the one-shot depth
 * ruling. Strict fail-safe: ladder or tokens unknown ⇒ calm (FULL — the
 * conservative rung; the battery's "ruler unavailable ⇒ strict" reading).
 */
export function closeAuditZone(ladder: Ladder | null, tokens: number | null | undefined): Zone {
	if (ladder === null || typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return "calm";
	return pressureZone(ladder, tokens, undefined);
}

/* ── guard facts (port-list item 7 rule set) ─────────────────────────────── */

export type GuardFactKind = "disputed-stub" | "gate-reject" | "commit-lost" | "close-audit";

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

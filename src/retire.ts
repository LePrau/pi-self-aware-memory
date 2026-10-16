/**
 * v5 RETIRE (Paul, 2026-10-06): unit retirement + soft upgrade.
 *
 * The problem (measured 2026-10-06, this workspace's own latest compaction):
 * the summary is 168,163 chars, of which the 39 settlement records are
 * 161,174 = 96% (largest single record 8,858 chars; even the smallest 2,410).
 * Every fold re-pushes the whole stale stack, and it only ever grows.
 *
 * Paul's mechanism (verbatim rulings, his words):
 *   - "the model should be allowed to either completely retire the units
 *       or 'upgrade' several older units to one new unit"
 *   - "retire_units takes the new target unit, closes the old unit with a
 *       link to the new, supersceding unit (multiple old units can be
 *       superseeded by a single new one), and the new unit carries as
 *       metadata all ids of old units it retired"
 *   - "the model can 'freely' take over the data in the same way a normal
 *       close would carry them — but properly selected, like 2 files and a
 *       fact from u1, only 1 open question from u2, drop u3, take most of
 *       u4, and not retire u5 at all"
 *   - "the reason for facts is especially so the model works on ground truth
 *       and does not have to rederive old work"
 *   - threshold: "40k characters sounds good"
 *   - trigger: "a trigger after the first close after a fold, and when the
 *       summarized units content are bigger than a certain threshold, either
 *       context or raw characterlength"
 *
 * The contract (locked):
 *   - the curated content RIDES IN A NORMAL NEW close_unit STUB — its audit
 *     validates it like any close ("in the same way a normal close would
 *     carry them"). retire_units is BOOKKEEPING ONLY.
 *   - one retire_units call, mixed routing:
 *       { superseded: [1,2,4], supersededBy: 17, dropped: [3] }
 *     (supersededBy REQUIRED when superseded is non-empty; u5 stays alone).
 *   - softness: ledger + banked sidecars are IMMUTABLE — sam_retrieve and
 *     /sam serve the full originals forever; only the RENDER changes;
 *     revocable via `unretire` (latest-wins per unit).
 *   - rendering (takeoverSummary): dropped → GONE from the summary;
 *     superseded → one line with the forward link + retrieval pointer;
 *     the superseding unit's block gains a "supersedes" metadata line
 *     (derived from the retire entry — settlement records stay append-only).
 *   - trigger: BOTH conditions — the first close in the post-fold span AND
 *     the rendered settlement stack > RETIRE_THRESHOLD_CHARS (code-measured
 *     chars, exact — no token math; env-overridable SAM_RETIRE_CHARS).
 *     ONE offer per post-fold span (per-fold arming, like the goal offer);
 *     the model may call retire_units manually ANYTIME (the tool is always
 *     registered). D7 delivery channel (steer), nudge-family gate shared
 *     with the other offers (SAM_NUDGE=off is the kill), suppression traces
 *     like the D9 pattern.
 */
import type { SamSettlementRecord } from "./branchaudit.ts";

/** A retirement ledger entry (a `sam` custom entry, kind "retire"). */
export interface RetireAction {
	v: 1;
	kind: "retire";
	ts: number;
	/** the unit ids whose content is carried into the superseding unit */
	superseded: number[];
	/** REQUIRED when `superseded` is non-empty (the new curated close_unit unit) */
	supersededBy?: number;
	/** the unit ids dropped outright (complete retirement) */
	dropped: number[];
	/** the model's own reason the batch is stale (auditable) */
	reason?: string;
}

/** A revocation (kind "unretire") — latest-wins per unit. */
export interface UnretireAction {
	v: 1;
	kind: "unretire";
	ts: number;
	units: number[];
	reason?: string;
}

/**
 * An AUTO-RETIRE ledger entry (a `sam` custom entry, kind "autoRetire") —
 * the context-pressure safenet's system retirement (decision point 1 part b,
 * Paul 2026-10-16). System bookkeeping, not an audited claim: at a fold
 * AFTER the pressure nudge armed it, the system retires the oldest settled
 * units the model did not retire itself. `absorbed` is the matryoshka — the
 * IMMEDIATELY previous auto-retire entry stops rendering and rides here
 * (constant-size chain, traversable via sam_retrieve; every entry stays on
 * the ledger forever). `items` copy each unit's verdict class as-is
 * (light-carry — the retirement does not re-verify).
 */
export interface AutoRetireAction {
	v: 1;
	kind: "autoRetire";
	ts: number;
	/** the fold that committed this retirement (span identity) */
	foldId: string;
	/** the synthesized settlement's unit id (the unit that owns this block) */
	unitId: number;
	/** the synthesized settlement's retrieval id (the sam_retrieve target of the block) */
	retrievalId: string;
	/** the retired unit ids (oldest first) */
	units: number[];
	/** per-unit info for the block + /sam (the verdict class is copied as-is) */
	items: { unitId: number; retrievalId: string; verdictClass: string }[];
	/** the immediately previous auto-retire entry absorbed into this one (the matryoshka) */
	absorbed?: { retrievalId: string; unitId: number; units: number[] };
	/** the audit trail (which fold, why the pressure was on) */
	reason?: string;
}

export type RetireLedgerEntry = RetireAction | UnretireAction | AutoRetireAction;

export function isRetireAction(e: RetireLedgerEntry | undefined | null): e is RetireAction {
	return e !== undefined && e !== null && (e as RetireAction).kind === "retire";
}

export function isAutoRetireAction(e: RetireLedgerEntry | undefined | null): e is AutoRetireAction {
	return e !== undefined && e !== null && (e as AutoRetireAction).kind === "autoRetire";
}

/**
 * v5 RETIRE light-carry (2026-10-06, Paul: the new unit created to retire the
 * old entries is ALWAYS audited LIGHT — "it is just a 'copy selected data
 * from a to b' … the verification claims of the carried-over content
 * (verified/unverified/orphaned etc.) should simply be taken over as-is, not
 * re-derived"). The carrier close happens BEFORE the retire_units call
 * (validateRetireCall requires `supersededBy` to be a KNOWN unit), so no
 * file signal exists at close time: the pinned retire-offer/tool text teach
 * the model to declare the carrier with a marker FIRST LINE in its stub:
 *   RETIRE-CARRY u1, u2, u4        (the units whose content it carries)
 *   RETIRE-CARRY                   (bare form — the ids ride the retire entry)
 * The close_unit site parses this (total): present ⇒ the depth decision is
 * FORCED to light (recorded on the close record, decision-in-ledger); absent
 * ⇒ the normal zone decision stands (fail-safe: a full audit is stronger,
 * never wrong — it just re-verifies what a carry-over need not re-verify).
 * Pure; the re-audit sites parse the SAME durable stub (the close record),
 * so a carrier's re-audit stays light by construction.
 */
export function parseRetireCarryMarker(stub: string): number[] | undefined {
	const first = (stub.split("\n")[0] ?? "").trim();
	if (first === "RETIRE-CARRY") return [];
	const rest = first.startsWith("RETIRE-CARRY ") ? first.slice("RETIRE-CARRY ".length).trim() : null;
	if (rest === null || rest === "") return undefined; // defensive — the trim above makes this unreachable (a trailing-space bare form trims to the bare form)
	if (!/^u\d+(?:\s*,\s*u\d+)*$/.test(rest)) return undefined;
	return rest.split(/\s*,\s*/).map((t) => parseInt(t.slice(1), 10));
}

/** Per-unit state after applying ALL retire/unretire entries in branch order
 *  (latest-wins; an unretire clears a unit's retirement). Pure. */
export function retiredStates(entries: readonly RetireLedgerEntry[]): Map<number, { shape: "superseded" | "dropped"; supersededBy?: number }> {
	const out = new Map<number, { shape: "superseded" | "dropped"; supersededBy?: number }>();
	for (const e of entries) {
		if (e.kind === "unretire") {
			for (const u of e.units) out.delete(u);
			continue;
		}
		if (e.kind === "autoRetire") {
			for (const u of e.units) out.set(u, { shape: "dropped" });
			continue;
		}
		for (const u of e.superseded) {
			if (e.supersededBy === undefined) continue; // malformed entry — fail open (ignored)
			out.set(u, { shape: "superseded", supersededBy: e.supersededBy });
		}
		for (const u of e.dropped) out.set(u, { shape: "dropped" });
	}
	return out;
}

/** The "supersedes" metadata: unit → the old units it retired (derived from
 *  the retire entries; the settlement records stay append-only, untouched). Pure. */
export function supersedesMap(entries: readonly RetireLedgerEntry[]): Map<number, number[]> {
	const out = new Map<number, number[]>();
	for (const e of entries) {
		if (e.kind !== "retire" || e.supersededBy === undefined || e.superseded.length === 0) continue;
		out.set(e.supersededBy, [...out.get(e.supersededBy) ?? [], ...e.superseded]);
	}
	return out;
}

/** The census the offer + the steer present. `render` is the live block
 *  renderer (branchaudit.settlementBlock), so the chars are EXACTLY what the
 *  next summary would push. Pure. */
export interface RetireCensus {
	records: number;
	chars: number;
	/** the three largest records, "u10 (8858), u4 (8702), u9 (8654)" or "(none)" */
	largest: string;
	/** the already-retired states (so the model sees what is already soft-deleted) */
	alreadyRetired: number;
}

export function retireCensus(
	records: readonly SamSettlementRecord[],
	render: (r: SamSettlementRecord) => string,
	entries: readonly RetireLedgerEntry[] = [],
): RetireCensus {
	let chars = 0;
	const sized: { id: number; len: number }[] = [];
	for (const r of records) {
		const len = render(r).length;
		chars += len;
		sized.push({ id: r.unitId, len });
	}
	sized.sort((a, b) => b.len - a.len || a.id - b.id);
	const largest = sized.length === 0 ? "(none)" : sized.slice(0, 3).map((s) => `u${s.id} (${s.len})`).join(", ");
	const alreadyRetired = retiredStates(entries).size;
	return { records: records.length, chars, largest, alreadyRetired };
}

/** The 40k threshold (Paul: "40k characters sounds good"). Raw CHARS of the
 *  rendered settlement stack — code-measurable, exact (no token estimates).
 *  `SAM_RETIRE_CHARS` overrides (same envInt discipline as the nudge dials:
 *  non-positive / non-finite ⇒ default). Pure. */
export const RETIRE_THRESHOLD_CHARS_DEFAULT = 40_000;

export function retireThresholdChars(env: Record<string, string | undefined>): number {
	const raw = env["SAM_RETIRE_CHARS"];
	if (raw === undefined || raw.trim() === "") return RETIRE_THRESHOLD_CHARS_DEFAULT;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : RETIRE_THRESHOLD_CHARS_DEFAULT;
}

/** Per-fold-span offer arming (one offer per post-fold span, like the goal
 *  offer — armed by a fold, consumed by the first close that crosses the
 *  threshold, or retired as moot below it). Pure state; no I/O. */
export interface RetireOfferState {
	foldDone: boolean;
	/** the fold that armed this span (span identity — a NEW fold re-arms) */
	spanId: string;
	offered: boolean;
}

export function createRetireOfferState(): RetireOfferState {
	return { foldDone: false, spanId: "", offered: false };
}

/** A fold happened ⇒ the post-fold span starts (re-arm, even if the previous
 *  span already offered). */
export function retireOfferArmedOnFold(st: RetireOfferState, spanId: string): void {
	st.foldDone = true;
	st.spanId = spanId;
	st.offered = false;
}

export type RetireOfferDecision = "fire" | "moot" | "wait";

/** fire = cross the threshold now · moot = armed but below it (retired as
 *  "nothing to clean up" — the offer would be noise) · wait = no fold yet or
 *  already consumed this span. Pure. */
export function retireOfferDecision(
	st: RetireOfferState,
	census: RetireCensus,
	threshold: number,
): RetireOfferDecision {
	if (!st.foldDone || st.offered) return "wait";
	if (census.records === 0) return "moot";
	return census.chars >= threshold ? "fire" : "moot";
}

/** The steer text (D7 delivery channel; the final-commitment wording
 *  discipline of the 2026-10-05 nudge texts applies: what it costs / what it
 *  guarantees / how to act). The byte shape is PINNED (wording = pins). */
export function retireOfferText(census: RetireCensus): string {
	return (
		`[sam-nudge] Retire offer — ${census.records} settled unit record(s) currently render as ` +
		`~${census.chars} chars (largest: ${census.largest}` +
		`${census.alreadyRetired > 0 ? `; ${census.alreadyRetired} already retired` : ""}). ` +
		`If older units are stale, retire them now (they would otherwise re-appear at every fold): ` +
		`(1) UPGRADE — take over only what still matters (2 files and a fact from uA, one open question from uB, most of uC…) ` +
		`into a NEW close_unit stub — start that stub with the first line "RETIRE-CARRY uA, uB, uC" (the units you carry), ` +
		`then call retire_units with {superseded:[A,B,C], supersededBy:<the new unit>, dropped:[D]}; ` +
		`the marked close is audited LIGHT (a curated carry-over is a copy, not new work — the old units' verification claims are taken over as-is, not re-derived); ` +
		`(2) DROP — retire_units with {superseded:[], dropped:[…]} for complete retirement. ` +
		`Retirement is soft: every retired unit stays retrievable (sam_retrieve <id>) and restorable (unretire). ` +
		`If nothing is stale, ignore this offer.`
	);
}

/* ── AUTO-RETIRE (context-pressure safenet part b, Paul 2026-10-16) ─────
 *
 * The pressure nudge (part a) is the model's warning + order; this is the
 * system's backstop: if the model did NOT retire after the nudge, the next
 * fold retires the oldest settled units itself. Q2 rulings: per-fold arming,
 * NO cool-down (a pending arm that finds no candidates at the fold is simply
 * re-armed by the next pressure nudge), and one auto-retire must make room
 * for MULTIPLE subsequent folds (the target below is token-aware, not just
 * the 40k-char default — Q1: that default stays a config value, here one of
 * two caps). The commit itself (appendEntry + the synthesized settlement +
 * the unit-id bump) is glue in index.ts — everything here is pure.
 */

/** Per-fold auto-retire arming — armed by the pressure nudge (a fold whose
 *  post-fold estimate is within headroom of pi's auto-fold line), consumed
 *  at the NEXT fold. Pure state; no I/O. */
export interface AutoRetireState {
	/** armed by the pressure nudge (its fold's post-fold estimate was within headroom of the line) */
	armed: boolean;
	/** the fold that armed this state (span identity) */
	foldId: string;
	/** arming epoch ms (bounds the "the model retired in between" check) */
	ts: number;
	/** the soft retire offer was consumed by the pressure nudge (Q4: the
 *  emergency order supersedes the soft suggestion for this span) */
	offerConsumed: boolean;
}

export function createAutoRetireState(): AutoRetireState {
	return { armed: false, foldId: "", ts: 0, offerConsumed: false };
}

/** The pressure nudge fires ⇒ arm (a new arm supersedes an older pending
 *  arm — Q2 has no cool-down; the newest pressure always wins). */
export function autoRetireArmOnNudge(st: AutoRetireState, foldId: string, ts: number): void {
	st.armed = true;
	st.foldId = foldId;
	st.ts = ts;
	st.offerConsumed = true;
}

/** True when the model already retired or unretired AFTER the arming (it
 *  obeyed the order — the system yields and does not double-act). The
 *  manual tools' ledger entries carry ts; a system autoRetire entry never
 *  counts as the model's action (it is the backstop itself). Pure. */
export function autoRetireSupersededByModel(st: AutoRetireState, entries: readonly RetireLedgerEntry[]): boolean {
	if (!st.armed) return false;
	return entries.some((e) => (e.kind === "retire" || e.kind === "unretire") && e.ts >= st.ts);
}

export type AutoRetireDecision = "commit" | "disarm" | "wait";

/** The commit decision AT A FOLD that followed the arm: `commit` when armed,
 *  the model did not act, and candidates exist; `disarm` when the arm is
 *  spent (model acted, or nothing to retire — Q2: no cool-down; the next
 *  pressure nudge re-arms); `wait` when not armed at all. Pure. */
export function autoRetireDecision(
	st: AutoRetireState,
	supersededByModel: boolean,
	candidateCount: number,
): AutoRetireDecision {
	if (!st.armed) return "wait";
	if (supersededByModel || candidateCount === 0) return "disarm";
	return "commit";
}

/**
 * The target rendered size for the retired stack (Q1+Q2, Paul 2026-10-16):
 * the min of (a) the configured 40k-char threshold (a CONFIG VALUE with a
 * default — `SAM_RETIRE_CHARS`) and (b) the TOKEN-AWARE headroom target —
 * the rendered chars that would keep the next post-fold estimate under
 * `headroom` of pi's auto-fold line (W−R): every token outside the keep
 * window must be gone, plus the keep window itself, plus a goal reserve, all
 * converted at the code's chars-per-token ruler, with a floor so tiny
 * windows never demand an absurd fraction. One auto-retire at this target
 * makes room for MULTIPLE subsequent folds (Q2) — the estimate only climbs
 * again once the model has generated that much new work.
 * Pure.
 */
export const AUTORETIRE_TARGET_FLOOR_CHARS = 16_000;
/** The summary's own bookkeeping reserve (goal block + carried previous +
 *  orphans + pointer + this block — code-measured order of magnitude;
 *  keeps the token target honest at the margin). */
export const AUTORETIRE_GOAL_RESERVE_TOKENS = 2_000;
/** The code's chars-per-token ruler — the same chars/4 convention the
 *  keep-window gate uses for its positioning (gates.keepWindowGate, one
 *  ruler, F3; it is a bound for planning, never a measurement). */
const CHARS_PER_TOKEN = 4;

export function autoRetireTargetChars(
	ladder: { window: number; reserve: number; keepRecent: number },
	headroom: number,
	configuredThreshold: number,
): number {
	const keepTokens = Math.max(0, ladder.window - ladder.reserve - headroom) - ladder.keepRecent - AUTORETIRE_GOAL_RESERVE_TOKENS;
	const tokenTarget = Math.floor(Math.max(keepTokens, 0) * CHARS_PER_TOKEN);
	const target = Math.min(configuredThreshold, tokenTarget);
	return Math.max(target, AUTORETIRE_TARGET_FLOOR_CHARS);
}

/**
 * Auto-retire candidates: units that HAVE a settlement record (settled —
 *  never an open unit), are not already retired (any shape), and are not
 *  among the newest `protectNewest` units (the freshest work stays in view —
 *  the sweep's "oldest first" safety, ported). Oldest first. Pure.
 */
export function autoRetireCandidates(
	records: readonly SamSettlementRecord[],
	entries: readonly RetireLedgerEntry[],
	protectNewest: number = 1,
): number[] {
	const retired = retiredStates(entries);
	const ids = [...new Set(records.map((r) => r.unitId))].sort((a, b) => a - b);
	const protect = Math.max(0, protectNewest);
	return ids.slice(0, Math.max(0, ids.length - protect)).filter((id) => !retired.has(id));
}

/**
 * The auto-retire selection: oldest candidates first, until the rendered
 * chars of the REMAINING stack would fall under `target` — but always at
 * least one unit (Q2's "multiple folds" headroom comes from the target size,
 *  not from stopping early). `render` is the live block renderer
 *  (branchaudit.settlementBlock) so the chars are exactly what the next
 *  summary would push. Pure; total (no candidates ⇒ no selection).
 */
export function autoRetireSelect(
	records: readonly SamSettlementRecord[],
	entries: readonly RetireLedgerEntry[],
	target: number,
	render: (r: SamSettlementRecord) => string,
	protectNewest: number = 1,
): number[] {
	const cands = autoRetireCandidates(records, entries, protectNewest);
	if (cands.length === 0) return [];
	const byId = new Map(records.map((r) => [r.unitId, r]));
	const retiredIds = new Set<number>();
	let remaining = 0;
	for (const r of records) {
		if (!retiredIds.has(r.unitId)) remaining += render(r).length;
	}
	const picked: number[] = [];
	for (const id of cands) {
		const r = byId.get(id);
		if (r === undefined) continue;
		picked.push(id);
		retiredIds.add(id);
		remaining -= render(r).length;
		if (picked.length > 1 && remaining < target) break; // at least one; stop once under target
	}
	return picked;
}

/** The matryoshka: the IMMEDIATELY previous auto-retire entry (branch order,
 *  the newest before the new one) — the new entry absorbs it (its id rides
 *  in `absorbed`); the old entry stops rendering. Pure. */
export function previousAutoRetire(entries: readonly RetireLedgerEntry[]): AutoRetireAction | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (isAutoRetireAction(e)) return e;
	}
	return undefined;
}

/** Tool-call validation (the contract's hard edges). Returns an error string
 *  or null (valid). Refusal is atomic — never partial application (F-class
 *  discipline: a bad batch changes nothing). Pure. */
export function validateRetireCall(
	knownUnits: readonly number[],
	superseded: readonly number[],
	supersededBy: number | undefined,
	dropped: readonly number[],
): string | null {
	const known = new Set(knownUnits);
	if (superseded.length === 0 && dropped.length === 0) return "nothing to retire (superseded and dropped are both empty)";
	if (superseded.length > 0 && (supersededBy === undefined || supersededBy === null)) {
		return "supersededBy is required when superseded is non-empty (the new curated close_unit unit)";
	}
	if (supersededBy !== undefined && supersededBy !== null && !known.has(supersededBy)) {
		return `supersededBy ${supersededBy} is not a unit on this branch (known: ${knownUnits.join(", ") || "none"})`;
	}
	const all = [...superseded, ...dropped];
	const unknown = all.filter((u) => !known.has(u));
	if (unknown.length > 0) return `unknown unit id(s): ${unknown.join(", ")} (known: ${knownUnits.join(", ") || "none"})`;
	const dup = superseded.filter((u) => dropped.includes(u));
	if (dup.length > 0) return `unit(s) routed twice: ${dup.join(", ")} (either superseded OR dropped, not both)`;
	return null;
}

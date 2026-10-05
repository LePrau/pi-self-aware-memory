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

export type RetireLedgerEntry = RetireAction | UnretireAction;

export function isRetireAction(e: RetireLedgerEntry | undefined | null): e is RetireAction {
	return e !== undefined && e !== null && (e as RetireAction).kind === "retire";
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
		`into a NEW close_unit stub, then call retire_units with {superseded:[A,B,C], supersededBy:<the new unit>, dropped:[D]}; ` +
		`(2) DROP — retire_units with {superseded:[], dropped:[…]} for complete retirement. ` +
		`Retirement is soft: every retired unit stays retrievable (sam_retrieve <id>) and restorable (unretire); ` +
		`the upgraded unit's claims ride its normal close audit. If nothing is stale, ignore this offer.`
	);
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

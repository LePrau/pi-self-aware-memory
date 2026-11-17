/**
 * SAM report UI (v0.0.41, 2026-11-16 — report v3) — `/sam report` as a
 * human-traversable ledger (WISHLIST MED #1).
 *
 * v0.0.41 design change (Paul's spec after the v0.0.40 live observation —
 * "most of the sam report features now work as expected"; the PgUp/PgDown
 * code STAYS even though pi captures those keys for the main scroll —
 * "we keep the code for a later different key mapping"):
 *
 *  1. THE ROWS ARE A FIXED COLUMN TABLE (no jumping widths):
 *        [label 15] [class 11] [time 11] [verdict slot] [stub…]
 *     - LABEL (the unit name) is a fixed 15 chars ("current goal" fits
 *       exactly), truncated with "…" when longer.
 *     - CLASS is a fixed 11 chars (Paul: "fixed width and not jump";
 *       captions may be shortened — NOT-YET-VERIFIED → "NOT-YET",
 *       UNVERIFIED-AUDIT-FAILED → "UNVERIFIED"; rows without a class
 *       show "—").
 *     - TIME is a fixed 11 chars, local, to the minute ("MM-DD HH:MM") —
 *       the close record's `ts` for units, the orphan record's `ts` for
 *       orphans, the goal record's `ts` for the goal (Paul: "take whatever
 *       time is already available for an entry"; operator aid — "around
 *       which time frame certain units were closed").
 *     - The DROPPED-UNITS LIST rides in the VERDICT-SLOT column (the
 *       dropped row's label is just "dropped").
 *  2. COLORS for the class column (Paul: "visible at a glance which are
 *     proper audits and which have failed"): VERIFIED = success;
 *     PLAUSIBLE and CORRECTIONS share the "successful audit" color —
 *     accent (Paul: the model incorporates corrections into the updated
 *     stub, so corrections are a successful audit); NOT-YET = dim;
 *     UNVERIFIED (audit-failed) + UNAUDITABLE = error; AUTO-RETIRE = muted.
 *     Theme tokens, not hardcoded ANSI — the current pi theme decides.
 *  3. THE DETAIL VIEW IS WINDOWED like the list (Paul: "same window height
 *     calculation, same scroll up/down behaviour") — the unit name stays
 *     at the top, the content lines are INDENTED on the left, up/down
 *     scroll (wrapping), PgUp/PgDown scroll by visible−1 (the code stays
 *     for a later key mapping). For a RETIREMENT UNIT the detail shows
 *     the unit name at the top + the child tree INDENTED (one line per
 *     child, annotated); a nested retirement unit (the matryoshka) gets
 *     ITS NAME AS ITS OWN LINE with proper indentation (deeper = further
 *     right).
 *  4. A SPLIT LINE at the very top of the rendered component separates the
 *     model output from the report list; it COUNTS towards the window
 *     size (list rows = window − 1).
 *  5. Everything else of v0.0.40 stays: the windowed list (visible =
 *     max(60% rows, 10); small terminals keep ≥ 2 rows for model output),
 *     the cursor starts at the BOTTOM, retired units live only inside
 *     their retirement unit (nested matryoshka included), the per-level
 *     cursors, right/enter opens, left/esc/enter closes (enter toggles),
 *     esc on the main list closes the menu, the carrier-less "dropped"
 *     row (a good addition — Paul).
 *
 * House pattern of settings-ui.ts: deliberately NO `@earendil-works/pi-tui`
 * import — the extension runtime resolves that package through pi's
 * virtual-module alias, but the pinned 0.87.1 capture does not ship it
 * (only 1.3.0 does — measured). So this file is typed against the minimal
 * structural surfaces the custom factory provides (Component =
 * render(width) / handleInput? / invalidate, KeybindingsManager =
 * matches(data, keyId) / getKeys(keyId), TUI = terminal.rows, Theme =
 * fg(token, text)) and builds its own wrap/truncate — no
 * `wrapTextWithAnsi`. The 1.5.x typechecks check us against the real
 * interfaces structurally; the 0.87.1 typecheck passes because
 * pi-coding-agent's own d.ts references are lib-skipped there.
 *
 * Read-only: the row model is built from the ledger + branch records
 * (latest-wins retirements via retiredStates); the detail callback may
 * read banked files, but nothing here writes.
 */

import type { SamGoalRecord } from "./goal.ts";
import type { SamUnit } from "./ledger.ts";
import { retiredStates, type RetireLedgerEntry } from "./retire.ts";
import { SAM_UI_KEYS, formatKeyHint, type SamKeybindings } from "./settings-ui.ts";

/** One row of the report list (the fixed column table — v0.0.41). */
export interface SamReportRow {
	kind: "retirement" | "unit" | "orphan" | "goal";
	/** the unit name (fixed 15-char column): "u12" · "dropped" · "current goal" */
	label: string;
	/** the unit id (unit/orphan/retirement rows — also the detail/subtree key) */
	unitId?: number;
	/** the VERDICT CLASS caption (the fixed 11-char class column): VERIFIED,
	 * PLAUSIBLE, CORRECTIONS, UNAUDITABLE, AUTO-RETIRE, NOT-YET, UNVERIFIED —
	 * undefined for rows without a class (rendered "—") */
	class?: string;
	/** the short text in the VERDICT-SLOT column: the state text for units
	 * without a class, "unaudited" for orphans, the goal's first line, the
	 * carrier's child list ("▸ u1, u3"), and — on the dropped row — the
	 * LIST OF THE DROPPED UNITS */
	verdict: string;
	/** the wide part of the row: the stub's first line (truncated at render) */
	stubLine?: string;
	/** orphan rows only: the retrieval id (the `/sam retrieve` pointer) */
	retrievalId?: string;
	/** local time, to the minute ("MM-DD HH:MM") — undefined when the entry
	 * carries no timestamp (rendered "—") */
	time?: string;
}

/**
 * The pure input to buildReportBoard — everything the report needs, already
 * extracted (no branch walking here, so the test can feed it plain data).
 */
export interface SamReportInput {
	units: readonly SamUnit[];
	/** orphan records with a minted unitId that are NOT already ledger units (ascending) */
	orphanRows: readonly { unitId: number; retrievalId: string; stubLine?: string; ts?: number }[];
	/** the retire/unretire entries in branch order (latest-wins per unit) */
	retirements: readonly RetireLedgerEntry[];
	/** the current goal (latest-wins) — undefined when none is stored */
	goal?: SamGoalRecord;
	/** unitId → the close record's `ts` (epoch ms) — the unit's TIME column */
	closeTs?: ReadonlyMap<number, number>;
}

/** The rendered board: the main list + one subtree per retirement unit. */
export interface SamReportBoard {
	header: string;
	/**
	 * The main list, chronologically (unitId ascending): the LIVE units —
	 * i.e. every unit that is neither retired nor absorbed — in which each
	 * RETIREMENT unit sits at its creation spot (kind "retirement", its
	 * direct children listed in the stub slot), plus the orphan rows
	 * (unaudited) at their unitId positions, and finally the current goal
	 * when one is stored. Retired units do NOT appear here — they live in
	 * the subtree of the retirement unit that retired them.
	 */
	rows: SamReportRow[];
	/**
	 * One subtree per RETIREMENT unit (a manual carrier close, or the
	 * synthesized auto-retire unit): the units it retired directly,
	 * ascending, rendered exactly like top-level rows — a nested retirement
	 * unit (one that was itself retired or absorbed later) appears as a
	 * "retirement" row that opens ITS subtree. A child that was un-retired
	 * later is NOT listed here (it returned to the main list, latest-wins).
	 */
	subtrees: { unitId: number; rows: SamReportRow[] }[];
	/**
	 * The units dropped WITHOUT a carrier (retired, but no retirement unit
	 * owns them — a `retire` entry with no supersededBy) — the flat subtree
	 * under the single "dropped" main-list row (its verdict slot carries
	 * the list of the dropped units). Empty when none.
	 */
	droppedRows: SamReportRow[];
}

/** The lazy detail for an opened row. */
export interface SamReportDetail {
	title: string;
	/** raw content lines (wrapped + indented at render) */
	lines: string[];
}

/** The model the view renders — the detail callback may take a couple of seconds. */
export interface SamReportModel {
	board: SamReportBoard;
	/** lazy: build the detail for a row (unit/goal/retirement rows; may read banked files) */
	detail: (row: SamReportRow) => SamReportDetail | undefined;
}

/** The result of a closed report session (pi's `done` payload — unused). */
export type SamReportResult = { kind: "closed" };

/**
 * The minimal structural surface of pi's TUI this view needs (house
 * pattern — no pi-tui import; pi's TUI satisfies it structurally:
 * `tui.terminal.rows` is the terminal's row count, live per render).
 */
export interface SamTui {
	terminal: { rows: number };
}

/** The minimal structural surface of pi's Theme this view needs —
 * `fg(token, text)` styles the text with a theme token's foreground
 * (the method form keeps the structural check bivariant against pi's
 * `fg(color: ThemeColor, text: string)`). */
export interface SamTheme {
	fg(color: string, text: string): string;
}

/**
 * The fixed dock lines below the list slot — the user input area
 * (editor, min 3 lines), the status bar (footer, 1 line) and the split
 * line (1 line). Measured from pi's chat viewport (v0.0.40 research,
 * u171): createChatViewport's dock = [input slot minSize 3, …, footer].
 * Paul's spec: when the available space (terminal height − these) is
 * < 10 rows, at least 2 rows stay reserved for model output.
 */
export const DOCK_RESERVE = 5;
export const MODEL_OUTPUT_RESERVE = 2;

/** The split line at the very top of the report (v0.0.41 — separates the
 * model output from the report list). It COUNTS towards the window size:
 * the list rows = window − 1. */
export const SPLIT_LINE_ROWS = 1;

/** The fixed column widths of the row table (v0.0.41 — no jumping):
 * the label (unit name, 15 so "current goal" fits exactly), the verdict
 * class (11 — the longest full captions; the two long classes are
 * shortened), the time (11 — "MM-DD HH:MM"). */
export const LABEL_W = 15;
export const CLASS_W = 11;
export const TIME_W = 11;

/**
 * The visible ROW COUNT of the report window for a terminal of `rows`
 * lines (Paul's v0.0.40 spec, point 1):
 *   available = rows − DOCK_RESERVE
 *   available < 10  → window = max(available − 2, 1)   (≥ 2 rows for model output)
 *   otherwise       → window = max(floor(rows × 0.6), 10)
 * This is the WINDOW — the rendered list shows `window − SPLIT_LINE_ROWS`
 * rows (the split line at the top counts towards the size, v0.0.41).
 * Pure; the view calls it per render with the live terminal height.
 */
export function visibleListRows(rows: number): number {
	const available = rows - DOCK_RESERVE;
	if (available < 10) return Math.max(available - MODEL_OUTPUT_RESERVE, 1);
	return Math.max(Math.floor(rows * 0.6), 10);
}

/** The list/content rows of a window (the window minus the split line). */
export function windowContentRows(rows: number): number {
	return Math.max(visibleListRows(rows) - SPLIT_LINE_ROWS, 1);
}

/** The class caption for the fixed 11-char column (v0.0.41 — Paul allows
 * shortened captions): the two long classes are cut, the rest fit as-is. */
export function classCaption(cls: string): string {
	if (cls === "NOT-YET-VERIFIED") return "NOT-YET";
	if (cls === "UNVERIFIED-AUDIT-FAILED") return "UNVERIFIED";
	return cls;
}

/** The theme token per class caption (v0.0.41 — Paul: "visible at a glance
 * which are proper audits and which have failed"):
 *   VERIFIED → success
 *   PLAUSIBLE + CORRECTIONS → accent (the "successful audit" group — Paul:
 *     the model incorporates the corrections into the updated stub, so a
 *     CORRECTIONS verdict is a successful audit)
 *   NOT-YET → dim · UNVERIFIED + UNAUDITABLE → error · AUTO-RETIRE → muted */
export const CLASS_COLORS: Readonly<Record<string, string>> = {
	VERIFIED: "success",
	PLAUSIBLE: "accent",
	CORRECTIONS: "accent",
	"NOT-YET": "dim",
	UNVERIFIED: "error",
	UNAUDITABLE: "error",
	"AUTO-RETIRE": "muted",
};

/** Local time to the minute ("MM-DD HH:MM" — the fixed 11-char TIME column).
 * Paul: "merely for the operator to tell around which time frame certain
 * units were closed" — local wall-clock time, no seconds. */
export function formatReportTime(ts: number | undefined): string | undefined {
	if (ts === undefined || !Number.isFinite(ts)) return undefined;
	const d = new Date(ts);
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const VERDICT_MIN = 10;
const VERDICT_MAX = 24;

/** Truncate to n chars, "…" when cut (single-line fields). */
function padTrunc(s: string, n: number): string {
	if (s.length <= n) return s.length < n ? s + " ".repeat(n - s.length) : s;
	return n > 1 ? s.slice(0, n - 1) + "…" : s;
}

/** Word-wrap text to at most width chars per line (no ANSI awareness needed —
 * report content is plain text). */
function wrapText(text: string, width: number): string[] {
	if (width < 4) width = 4;
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.length === 0 ? "" : rawLine;
		if (line.length <= width) {
			out.push(line);
			continue;
		}
		let rest = line;
		while (rest.length > width) {
			let cut = rest.lastIndexOf(" ", width);
			if (cut <= 0) cut = width;
			out.push(rest.slice(0, cut));
			rest = rest.slice(cut).replace(/^\s+/, "");
		}
		out.push(rest);
	}
	return out;
}

function firstLine(s: string | undefined): string | undefined {
	if (s === undefined) return undefined;
	const t = s.trim().split("\n")[0].trim();
	return t === "" ? undefined : t;
}

/** The state text for the VERDICT-SLOT column of a unit WITHOUT a verdict
 * class (units with a class get the class in the class column and an empty
 * slot — the slot width still keeps the stub column aligned). */
export function reportRowSlot(u: SamUnit): string {
	if (u.verdict !== undefined) return "";
	switch (u.state) {
		case "in-flight": return "awaiting audit";
		case "folded": return "folded";
		case "refused": return "refused";
		case "undone": return "undone";
		case "resolved": return "resolved";
		default: return u.state;
	}
}

/** The class caption of a ledger unit ("" when it has no verdict class —
 * the view renders "—" for that). */
export function reportRowClass(u: SamUnit): string {
	return u.verdict !== undefined ? classCaption(u.verdict.class) : "";
}

/** A retirement unit's DIRECT children, as recorded by the ledger entries
 * (append-only — latest-wins filtering happens at render time via
 * retiredStates/absorbed, not here). */
interface ChildSpec {
	unitId: number;
	/** how the child got there (annotation only) */
	shape: "superseded" | "dropped" | "absorbed";
	supersededBy?: number;
}

/**
 * Pure: the report board (v0.0.41 — the fixed column table).
 *
 * Main list: the live units ascending (retired and absorbed units are
 * excluded — they live in their retirement unit's subtree), with each
 * retirement unit at its creation spot and orphan rows merged at their
 * unitId positions; the goal row last when stored.
 * Subtrees: one per retirement unit — the units it retired directly
 * (ascending; a nested retirement unit as an expandable row), minus any
 * child that was un-retired later (latest-wins).
 * Dropped row: the single carrier-less retirement — units dropped by a
 * `retire` entry with no supersededBy (and not auto-retired) have no
 * retirement unit to enter, so they collapse into one top-level "dropped"
 * row whose verdict slot carries the LIST OF THE DROPPED UNITS.
 */
export function buildReportBoard(input: SamReportInput): SamReportBoard {
	const retired = retiredStates(input.retirements);
	const unitIds = new Set(input.units.map((u) => u.unitId));

	// Direct children per retirement unit (append-only, deduped).
	const children = new Map<number, Map<number, ChildSpec>>();
	const addChild = (carrier: number, spec: ChildSpec): void => {
		let m = children.get(carrier);
		if (m === undefined) {
			m = new Map<number, ChildSpec>();
			children.set(carrier, m);
		}
		if (!m.has(spec.unitId)) m.set(spec.unitId, spec);
	};
	const absorbedIds = new Set<number>();
	for (const e of input.retirements) {
		if (e.kind === "retire") {
			if (e.supersededBy !== undefined) {
				for (const u of e.superseded) addChild(e.supersededBy, { unitId: u, shape: "superseded", supersededBy: e.supersededBy });
				for (const u of e.dropped) addChild(e.supersededBy, { unitId: u, shape: "dropped" });
			}
		} else if (e.kind === "autoRetire") {
			for (const u of e.units) addChild(e.unitId, { unitId: u, shape: "dropped" });
			if (e.absorbed !== undefined) {
				addChild(e.unitId, { unitId: e.absorbed.unitId, shape: "absorbed" });
				absorbedIds.add(e.absorbed.unitId);
			}
		}
	}
	// Units that live inside a later retirement unit's subtree: the
	// carrier-less drops do NOT count (they get the dropped row).
	const absorbedAsChild = new Set<number>();
	for (const [carrier, m] of children) {
		void carrier;
		for (const spec of m.values()) {
			if (spec.shape === "absorbed") absorbedAsChild.add(spec.unitId);
		}
	}

	/** The visible rows of a retirement unit's subtree (latest-wins). */
	const subtreeOf = (carrierId: number): SamReportRow[] => {
		const m = children.get(carrierId);
		if (m === undefined) return [];
		return [...m.values()]
			.filter((c) => retired.has(c.unitId) || absorbedAsChild.has(c.unitId)) // un-retired children returned to the main list
			.sort((a, b) => a.unitId - b.unitId)
			.map((c) => unitRow(c.unitId, c.shape, c.supersededBy, c.shape === "absorbed"));
	};

	/** A unit row (top-level or subtree): retirement kind when the unit
	 * itself is a carrier (opens its own detail with the indented child
	 * tree — the matryoshka). */
	const unitRow = (
		id: number,
		shape: ChildSpec["shape"],
		supersededBy: number | undefined,
		isAbsorbed: boolean,
	): SamReportRow => {
		const u = input.units.find((x) => x.unitId === id);
		const note = isAbsorbed
			? "absorbed"
			: shape === "superseded" && supersededBy !== undefined
				? `→ u${supersededBy}`
				: shape === "dropped"
					? "dropped"
					: "";
		const isCarrier = children.has(id);
		const kids = isCarrier ? subtreeOf(id).map((r) => r.label.split(" ")[0]).join(", ") : "";
		return {
			kind: isCarrier ? "retirement" : "unit",
			unitId: id,
			label: `u${id}${note !== "" ? ` ${note}` : ""}`,
			class: u !== undefined ? reportRowClass(u) : undefined,
			verdict: u !== undefined ? reportRowSlot(u) : "(not in ledger)",
			// a carrier with no VISIBLE children (all un-retired) falls back to
			// its own stub line — the row stays informative
			stubLine: isCarrier && kids !== "" ? `▸ ${kids}` : u !== undefined ? firstLine(u.stub) : undefined,
			time: formatReportTime(input.closeTs?.get(id)),
		};
	};

	// Main list: live units + orphans, chronologically (the goal row last).
	const rows: SamReportRow[] = [];
	type MainItem = { unitId: number; row: SamReportRow };
	const items: MainItem[] = [];
	for (const u of input.units) {
		if (retired.has(u.unitId)) continue; // lives in its carrier's subtree (or the dropped row)
		if (absorbedAsChild.has(u.unitId)) continue; // matryoshka — lives in the absorber's subtree
		const isCarrier = children.has(u.unitId);
		const kids = isCarrier ? subtreeOf(u.unitId).map((r) => r.label.split(" ")[0]).join(", ") : "";
		items.push({
			unitId: u.unitId,
			row: {
				kind: isCarrier ? "retirement" : "unit",
				unitId: u.unitId,
				label: `u${u.unitId}`,
				class: reportRowClass(u),
				verdict: reportRowSlot(u),
				stubLine: isCarrier && kids !== "" ? `▸ ${kids}` : firstLine(u.stub),
				time: formatReportTime(input.closeTs?.get(u.unitId)),
			},
		});
	}
	for (const o of input.orphanRows) {
		if (unitIds.has(o.unitId)) continue; // orphans only mint ids outside ledger.units
		if (retired.has(o.unitId) || absorbedAsChild.has(o.unitId)) continue; // unreachable in practice — fail safe
		items.push({
			unitId: o.unitId,
			row: {
				kind: "orphan",
				unitId: o.unitId,
				label: `u${o.unitId}`,
				verdict: "unaudited",
				stubLine: o.stubLine,
				retrievalId: o.retrievalId,
				time: formatReportTime(o.ts),
			},
		});
	}
	items.sort((a, b) => a.unitId - b.unitId);
	for (const item of items) rows.push(item.row);

	// The carrier-less drops: retired, but no retirement unit owns them.
	const droppedIds = [...retired.keys()]
		.filter((id) => retired.get(id)!.shape === "dropped" && !absorbedAsChild.has(id))
		.filter((id) => {
			for (const m of children.values()) if (m.has(id)) return false; // it HAS a carrier after all
			return true;
		})
		.sort((a, b) => a - b);
	const droppedRows: SamReportRow[] = droppedIds.map((id) => {
		const u = input.units.find((x) => x.unitId === id);
		return {
			kind: "unit",
			unitId: id,
			label: `u${id} dropped`,
			class: u !== undefined ? reportRowClass(u) : undefined,
			verdict: u !== undefined ? reportRowSlot(u) : "(not in ledger)",
			stubLine: u !== undefined ? firstLine(u.stub) : undefined,
			time: formatReportTime(input.closeTs?.get(id)),
		};
	});
	if (droppedIds.length > 0) {
		rows.push({
			kind: "retirement",
			label: "dropped",
			verdict: `${droppedIds.map((id) => `u${id}`).join(", ")} (${droppedIds.length})`,
		});
	}

	if (input.goal !== undefined) {
		rows.push({
			kind: "goal",
			label: "current goal",
			verdict: firstLine(input.goal.text) ?? "(empty goal)",
			time: formatReportTime(input.goal.ts),
		});
	}

	const orphans = input.orphanRows.filter((o) => !unitIds.has(o.unitId) && !retired.has(o.unitId) && !absorbedAsChild.has(o.unitId)).length;
	// "retired" in the header = every unit hidden from the main list by a
	// retirement (retiredStates ∪ absorbed matryoshka units — the latter
	// ride in a later auto-retire's block and are not in retiredStates).
	const hidden = new Set<number>([...retired.keys(), ...absorbedAsChild]);
	const parts = [`SAM report — ${input.units.length + orphans} unit${input.units.length + orphans === 1 ? "" : "s"}`];
	if (hidden.size > 0) parts.push(`${hidden.size} retired`);
	if (orphans > 0) parts.push(`${orphans} orphaned`);
	if (input.goal !== undefined) parts.push("goal on file");
	return { header: parts.join(" · "), rows, subtrees: [...children.keys()].sort((a, b) => a - b).map((id) => ({ unitId: id, rows: subtreeOf(id) })), droppedRows };
}

/**
 * The interactive view (v0.0.41).
 *
 * One LIST level (the main list) — every opened row shows its DETAIL
 * (v0.0.41: a retirement unit shows its name at the top + the child tree
 * INDENTED; the dropped row shows the dropped list). The cursor stays
 * where it was when the detail closes. The LIST is windowed to
 * `windowContentRows(getRows())` rows (the window minus the split line)
 * centered on the cursor; the DETAIL is windowed with the SAME calculation
 * (the unit name stays at the top, the content indented, up/down scroll
 * like the list).
 *
 * Keys (all user-rebindable via <agentDir>/keybindings.json):
 *   up / down            move the cursor by one (wraps) — in the detail:
 *                        scroll the content (wraps)
 *   PgUp / PgDown        scroll by visible−1 rows (wraps — the topmost
 *                        entry becomes the bottommost visible) — pi currently
 *                        captures these for the main scroll; the code stays
 *                        for a later key mapping (Paul, 2026-11-16)
 *   right / enter        open the row under the cursor (a retirement row
 *                        opens its subtree; the dropped row its level)
 *   left / esc / enter   close the open detail (enter toggles) — or pop
 *                        the current level; esc on the main list closes
 *                        the whole menu
 */
export class SamReportView {
	private keybindings: SamKeybindings;
	private model: SamReportModel;
	private onDone: (result: SamReportResult) => void;
	private getRows: () => number;
	private theme?: SamTheme;
	private cursor = 0;
	private mode: "list" | "detail" = "list";
	private detail?: { row: SamReportRow; body: SamReportDetail };
	/** the detail content cursor (scroll position — the detail window is
	 * centered on it, like the list window is centered on its cursor) */
	private detailCursor = 0;
	private closed = false;

	constructor(
		keybindings: SamKeybindings,
		model: SamReportModel,
		onDone: (result: SamReportResult) => void,
		/** the live terminal height (pi's `tui.terminal.rows`; tests pass a
		 * fixed value or the null-guarded default from the factory) */
		getRows: () => number,
		/** pi's theme (the class-column colors) — undefined in the tests */
		theme?: SamTheme,
	) {
		this.keybindings = keybindings;
		this.model = model;
		this.onDone = onDone;
		this.getRows = getRows;
		this.theme = theme;
		this.cursor = this.levelRows().length - 1; // the cursor starts at the BOTTOM (the goal, or the newest unit)
	}

	/** The main list (the only list level — details are not levels). */
	private levelRows(): SamReportRow[] {
		return this.model.board.rows;
	}

	private cursorAt(): number {
		return Math.min(this.cursor, Math.max(this.levelRows().length - 1, 0));
	}

	/** The full window row count at the live terminal height (the split
	 * line counts towards it). */
	private visible(): number {
		const rows = this.getRows();
		const r = Number.isFinite(rows) && rows > 0 ? rows : 40; // null-guard default (tests pass 40)
		return visibleListRows(r);
	}

	/** The LIST/content rows of the window (the window minus the split line). */
	private contentRows(): number {
		return windowContentRows(this.getRows());
	}

	/** The color-styled class column text (padded to the fixed width first,
	 * so the color covers exactly the column). */
	private classText(r: SamReportRow): string {
		const text = padTrunc(r.class ?? "—", CLASS_W);
		const color = r.class !== undefined ? CLASS_COLORS[r.class] : undefined;
		return this.theme != null && color !== undefined ? this.theme.fg(color, text) : text;
	}

	/** One row of the fixed column table (v0.0.41):
	 *   [cursor][label 15][class 11][time 11][verdict slot][stub…] */
	private rowLine(r: SamReportRow, verdictCol: number, stubCol: number, cur: boolean): string {
		const label = padTrunc(r.label, LABEL_W);
		const cls = this.classText(r);
		const time = padTrunc(r.time ?? "—", TIME_W);
		const verdict = padTrunc(r.verdict, verdictCol);
		const stub = r.stubLine !== undefined && stubCol >= 8 ? ` ${padTrunc(r.stubLine, stubCol)}` : "";
		return `  ${cur ? ">" : " "} ${label} ${cls} ${time} ${verdict}${stub}`;
	}

	/** The shared split line (the separator between the model output and
	 * the report — counts towards the window size). */
	private splitLine(width: number): string {
		return "─".repeat(Math.max(width, 1));
	}

	render(width: number): string[] {
		if (this.mode === "detail" && this.detail !== undefined) return this.renderDetail(width);
		const rows = this.levelRows();
		const lines: string[] = [];
		lines.push(this.splitLine(width));
		lines.push(this.model.board.header);
		lines.push("");
		if (rows.length === 0) {
			lines.push("  (nothing here)");
			lines.push("");
			lines.push(this.hint());
			return lines;
		}
		const w = Math.max(width, 40);
		// fixed columns (v0.0.41): the label (15), the class (11), the time
		// (11) never jump; the verdict slot adapts to the visible rows
		// (capped) and the stub gets the rest.
		const vis = this.contentRows();
		const cur = this.cursorAt();
		// a list that fits the window renders in full (no point windowing);
		// otherwise the window centers on the cursor, clamped inside the list
		// — at a list end it pins there, showing a FULL `vis` rows.
		const start =
			rows.length <= vis
				? 0
				: Math.min(Math.max(cur - Math.floor(vis / 2), 0), rows.length - vis);
		const end = Math.min(rows.length, start + vis);
		// the window slides with the cursor; when the cursor is within
		// vis rows of a list end, the window pins to that end.
		const visibleRows = rows.slice(start, end);
		const verdictCol = Math.min(VERDICT_MAX, Math.max(VERDICT_MIN, w - 2 - LABEL_W - 2 - CLASS_W - 2 - TIME_W - 2 - 26));
		const stubCol = w - 4 - LABEL_W - CLASS_W - TIME_W - 2 * 3 - verdictCol;
		for (let i = start; i < end; i++) {
			lines.push(this.rowLine(rows[i], verdictCol, stubCol, i === cur));
		}
		lines.push("");
		lines.push(this.hint());
		return lines;
	}

	private hint(): string {
		const kb = this.keybindings;
		if (this.mode === "detail") {
			return `${formatKeyHint(kb, SAM_UI_KEYS.up)}/${formatKeyHint(kb, SAM_UI_KEYS.down)} scroll · ${formatKeyHint(kb, SAM_UI_KEYS.cancel)} to close`;
		}
		return (
			`${formatKeyHint(kb, SAM_UI_KEYS.up)}/${formatKeyHint(kb, SAM_UI_KEYS.down)}/${formatKeyHint(kb, SAM_UI_KEYS.pageUp)}/${formatKeyHint(kb, SAM_UI_KEYS.pageDown)} move · ` +
			`${formatKeyHint(kb, SAM_UI_KEYS.confirm)} to open · ${formatKeyHint(kb, SAM_UI_KEYS.cancel)} to close`
		);
	}

	private renderDetail(width: number): string[] {
		const w = Math.max(width, 40);
		const body = this.detail!.body;
		// the content lines, wrapped (the indent is added at render, so the
		// wrap width leaves room for it)
		const wrapped = wrapText(body.lines.join("\n"), w - 4);
		const n = wrapped.length;
		// the SAME window calculation as the list (v0.0.41): the split line
		// at the top counts towards the size; the content rows = window − 1.
		const vis = this.contentRows();
		const cur = n > 0 ? Math.min(this.detailCursor, n - 1) : 0;
		const start = n <= vis ? 0 : Math.min(Math.max(cur - Math.floor(vis / 2), 0), n - vis);
		const end = Math.min(n, start + vis);
		const lines: string[] = [this.splitLine(w), `  ${padTrunc(body.title, w - 2)}`];
		for (let i = start; i < end; i++) {
			lines.push(`    ${wrapped[i]}`); // the content indented under the name (v0.0.41)
		}
		lines.push("");
		lines.push(this.hint());
		return lines;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (this.mode === "detail") {
			const n = wrapText(this.detail!.body.lines.join("\n"), Math.max(this.getRows(), 40) - 4).length;
			if (n > 0) {
				if (kb.matches(data, SAM_UI_KEYS.up)) {
					this.detailCursor = (this.detailCursor + n - 1) % n;
					return;
				}
				if (kb.matches(data, SAM_UI_KEYS.down)) {
					this.detailCursor = (this.detailCursor + 1) % n;
					return;
				}
				if (kb.matches(data, SAM_UI_KEYS.pageUp) || kb.matches(data, SAM_UI_KEYS.pageDown)) {
					// the same step logic as the list (visible−1; at a window
					// edge the window shifts by one row; past an end it
					// wraps) — the code stays for a later key mapping
					const step = Math.max(this.contentRows() - 1, 1);
					if (n <= step) {
						this.detailCursor = (this.detailCursor + (kb.matches(data, SAM_UI_KEYS.pageDown) ? step : -step)) % n;
						return;
					}
					const vis = this.contentRows();
					const c = Math.min(this.detailCursor, n - 1);
					const st = Math.min(Math.max(c - Math.floor(vis / 2), 0), n - vis);
					const last = Math.min(n, st + vis) - 1;
					if (kb.matches(data, SAM_UI_KEYS.pageUp)) {
						this.detailCursor = c === st ? (st - 1 < 0 ? n - 1 : st - 1) : Math.max(st, c - step);
					} else {
						this.detailCursor = c === last ? (last + 1 >= n ? 0 : last + 1) : Math.min(last, c + step);
					}
					return;
				}
			}
			// left / esc / enter all close the detail (enter toggles, per Paul)
			if (kb.matches(data, SAM_UI_KEYS.cancel) || kb.matches(data, SAM_UI_KEYS.confirm) || kb.matches(data, "tui.editor.cursorLeft")) {
				this.detail = undefined;
				this.mode = "list";
			}
			return;
		}
		const rows = this.levelRows();
		if (kb.matches(data, SAM_UI_KEYS.up)) {
			this.cursor = (this.cursorAt() + rows.length - 1) % rows.length;
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.down)) {
			this.cursor = (this.cursorAt() + 1) % rows.length;
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.pageUp) || kb.matches(data, SAM_UI_KEYS.pageDown)) {
			const step = Math.max(this.contentRows() - 1, 1);
			const cur = this.cursorAt();
			if (rows.length <= step) {
				this.cursor = (cur + (kb.matches(data, SAM_UI_KEYS.pageDown) ? step : -step)) % rows.length;
			} else {
				// Spec-exact window shift (Paul: "scrolling up: the topmost
				// entry becomes the bottommost visible") — when the cursor is
				// at the edge of the window the whole window shifts by one row;
				// from the middle it moves by step (clamped inside the list).
				const vis = this.contentRows();
				const start =
					rows.length <= vis
						? 0
						: Math.min(Math.max(cur - Math.floor(vis / 2), 0), rows.length - vis);
				const lastVisible = Math.min(rows.length, start + vis) - 1;
				if (kb.matches(data, SAM_UI_KEYS.pageUp)) {
					this.cursor = cur === start ? (start - 1 < 0 ? rows.length - 1 : start - 1) : Math.max(start, cur - step);
				} else {
					this.cursor = cur === lastVisible ? (lastVisible + 1 >= rows.length ? 0 : lastVisible + 1) : Math.min(lastVisible, cur + step);
				}
			}
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.cancel) || kb.matches(data, "tui.editor.cursorLeft")) {
			this.closed = true;
			this.onDone({ kind: "closed" });
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.confirm) || kb.matches(data, "tui.editor.cursorRight")) {
			const r = rows[this.cursorAt()];
			if (r !== undefined) this.openRow(r); // empty list: nothing to open
		}
	}

	private openRow(row: SamReportRow): void {
		// v0.0.41: every row opens its DETAIL — a retirement row (and the
		// dropped row) show their child list INDENTED under the unit name
		// (the detail callback in index.ts builds the tree with proper
		// indentation for the matryoshka)
		const body = this.model.detail(row);
		if (body === undefined) return; // nothing to show (e.g. in-flight, no audit yet)
		this.detail = { row, body };
		this.detailCursor = 0; // the detail starts at the TOP (the name line)
		this.mode = "detail";
	}

	invalidate(): void {
		/* stateless render — nothing cached */
	}
}

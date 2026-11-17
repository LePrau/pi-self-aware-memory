/**
 * SAM report UI (v0.0.40, 2026-11-16 — report v2) — `/sam report` as a
 * human-traversable ledger (WISHLIST MED #1, design Paul 2026-11-16).
 *
 * v0.0.40 design change (Paul's spec — "a change in design, not in user
 * control/input, aside from pgup/pgdown"; everything else of v0.0.38 stays
 * good as-is):
 *
 *  1. THE LIST IS WINDOWED — the view asks for the TUI's terminal height
 *     (`tui.terminal.rows`, read per render so a resize re-windows) and
 *     shows only `visible` rows of the list:
 *        visible = max(floor(rows × 0.6), 10)
 *     where the AVAILABLE space (terminal height minus the fixed dock
 *     lines — user input, status bar, split line — DOCK_RESERVE = 5) is
 *     ≥ 10. If the available space is < 10 rows, at least 2 rows stay
 *     reserved for model output: visible = max(available − 2, 1).
 *  2. THE CURSOR STARTS AT THE BOTTOM — on the goal row (the most recent
 *     thing, directly below the newest close) when a goal is stored,
 *     otherwise on the newest unit.
 *  3. RETIRED UNITS LEAVE THE MAIN TREE — the main list shows only the
 *     LIVE units (and the goal, last); each RETIREMENT unit — a unit that
 *     retired others (a manual carrier close, or the synthesized
 *     auto-retire unit) — sits in the main list at its CREATION SPOT
 *     (its unitId position) and opens its SUBTREE: the units it retired
 *     directly, rendered exactly like top-level rows. A retirement unit
 *     that itself was retired/absorbed by a later one appears INSIDE THAT
 *     later unit's subtree (nested — including the auto-retire `absorbed`
 *     matryoshka). Units dropped WITHOUT a carrier (retired, but no
 *     retirement unit owns them) collapse into a single "dropped (…)"
 *     row (the flagged default — flagged for Paul 2026-11-16).
 *  4. PgUp/PgDown scroll the visible window by visible−1 rows (wrapping —
 *     scrolling up makes the topmost entry the bottommost visible);
 *     up/down keep the per-row step (wrapping).
 *  5. Everything else is unchanged: right/enter opens a row's FULL
 *     summary (lazy — the shared retrieveContent resolver), left/esc/enter
 *     close it again (enter toggles), esc on the main list closes the menu,
 *     the cursor is preserved when going back into a level.
 *
 * House pattern of settings-ui.ts: deliberately NO `@earendil-works/pi-tui`
 * import — the extension runtime resolves that package through pi's
 * virtual-module alias, but the pinned 0.87.1 capture does not ship it
 * (only 1.3.0 does — measured). So this file is typed against the minimal
 * structural surfaces the custom factory provides (Component =
 * render(width) / handleInput? / invalidate, KeybindingsManager =
 * matches(data, keyId) / getKeys(keyId), TUI = terminal.rows) and builds
 * its own wrap/truncate — no `wrapTextWithAnsi`. The 1.5.x typechecks
 * check us against the real interfaces structurally; the 0.87.1
 * typecheck passes because pi-coding-agent's own d.ts references are
 * lib-skipped there.
 *
 * Read-only: the row model is built from the ledger + branch records
 * (latest-wins retirements via retiredStates); the detail callback may
 * read banked files, but nothing here writes.
 */

import type { SamGoalRecord } from "./goal.ts";
import type { SamUnit } from "./ledger.ts";
import { retiredStates, type RetireLedgerEntry } from "./retire.ts";
import { SAM_UI_KEYS, formatKeyHint, type SamKeybindings } from "./settings-ui.ts";

/** One row of the report list. */
export interface SamReportRow {
	kind: "retirement" | "unit" | "orphan" | "goal";
	/** "u12" for unit rows · "dropped (u1, u4)" for the dropped row · "current goal" for the goal row */
	label: string;
	/** the unit id (unit/orphan/retirement rows — also the detail/subtree key) */
	unitId?: number;
	/** the short text in the verdict slot: verdict class, or state, or the goal's first line */
	verdict: string;
	/** the wide part of the row: the stub's first line (truncated at render) */
	stubLine?: string;
	/** orphan rows only: the retrieval id (the `/sam retrieve` pointer) */
	retrievalId?: string;
}

/**
 * The pure input to buildReportBoard — everything the report needs, already
 * extracted (no branch walking here, so the test can feed it plain data).
 */
export interface SamReportInput {
	units: readonly SamUnit[];
	/** orphan records with a minted unitId that are NOT already ledger units (ascending) */
	orphanRows: readonly { unitId: number; retrievalId: string; stubLine?: string }[];
	/** the retire/unretire entries in branch order (latest-wins per unit) */
	retirements: readonly RetireLedgerEntry[];
	/** the current goal (latest-wins) — undefined when none is stored */
	goal?: SamGoalRecord;
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
	 * under the single "dropped (…)" main-list row. Empty when none.
	 */
	droppedRows: SamReportRow[];
}

/** The lazy detail for an opened row. */
export interface SamReportDetail {
	title: string;
	/** raw content lines (wrapped to the TUI width at render) */
	lines: string[];
}

/** The model the view renders — the detail callback may take a couple of seconds. */
export interface SamReportModel {
	board: SamReportBoard;
	/** lazy: build the detail for a row (unit/goal rows; may read banked files) */
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

/**
 * The visible row count of the list for a terminal of `rows` lines
 * (Paul's v0.0.40 spec, point 1):
 *   available = rows − DOCK_RESERVE
 *   available < 10  → visible = max(available − 2, 1)   (≥ 2 rows for model output)
 *   otherwise       → visible = max(floor(rows × 0.6), 10)
 * Pure; the view calls it per render with the live terminal height.
 */
export function visibleListRows(rows: number): number {
	const available = rows - DOCK_RESERVE;
	if (available < 10) return Math.max(available - MODEL_OUTPUT_RESERVE, 1);
	return Math.max(Math.floor(rows * 0.6), 10);
}

const LABEL_CAP = 40; // the label column adapts to the longest row label (capped)
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

/** The short verdict-slot text for a ledger unit. */
export function reportRowVerdict(u: SamUnit): string {
	if (u.verdict !== undefined) return u.verdict.class;
	switch (u.state) {
		case "in-flight": return "awaiting audit";
		case "folded": return "folded";
		case "refused": return "refused";
		case "undone": return "undone";
		case "resolved": return "resolved";
		default: return u.state;
	}
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
 * Pure: the report board (v0.0.40).
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
 * retirement unit to enter, so they collapse into one top-level row.
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
	 * itself is a carrier (opens its own subtree — the matryoshka). */
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
			verdict: u !== undefined ? reportRowVerdict(u) : "(not in ledger)",
			// a carrier with no VISIBLE children (all un-retired) falls back to
			// its own stub line — the row stays informative
			stubLine: isCarrier && kids !== "" ? `▸ ${kids}` : u !== undefined ? firstLine(u.stub) : undefined,
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
				verdict: reportRowVerdict(u),
				stubLine: isCarrier && kids !== "" ? `▸ ${kids}` : firstLine(u.stub),
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
				verdict: "orphaned (unaudited)",
				stubLine: o.stubLine,
				retrievalId: o.retrievalId,
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
			verdict: u !== undefined ? reportRowVerdict(u) : "(not in ledger)",
			stubLine: u !== undefined ? firstLine(u.stub) : undefined,
		};
	});
	if (droppedIds.length > 0) {
		rows.push({
			kind: "retirement",
			label: `dropped (${droppedIds.map((id) => `u${id}`).join(", ")})`,
			verdict: `${droppedIds.length} dropped (no carrier)`,
		});
	}

	if (input.goal !== undefined) {
		rows.push({
			kind: "goal",
			label: "current goal",
			verdict: firstLine(input.goal.text) ?? "(empty goal)",
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
 * The interactive view (v0.0.40).
 *
 * Levels: the main list (empty stack) and one level per opened retirement
 * unit (its subtree) — the dropped row opens a pseudo-level. The cursor is
 * per level (preserved when going back in). The LIST is windowed to
 * `visibleListRows(getRows())` rows centered on the cursor; the DETAIL
 * stays full (unwindowed — Paul: everything else good as-is).
 *
 * Keys (all user-rebindable via <agentDir>/keybindings.json):
 *   up / down            move the cursor by one (wraps)
 *   PgUp / PgDown        scroll by visible−1 rows (wraps — the topmost
 *                        entry becomes the bottommost visible)
 *   right / enter        open the row under the cursor (a retirement row
 *                        opens its subtree)
 *   left / esc / enter   close the open detail (enter toggles) — or pop
 *                        the current level; esc on the main list closes
 *                        the whole menu
 */
export class SamReportView {
	private keybindings: SamKeybindings;
	private model: SamReportModel;
	private onDone: (result: SamReportResult) => void;
	private getRows: () => number;
	/** the open levels — [] = main list; each entry a retirement unit id,
	 * or null for the dropped pseudo-level */
	private stack: (number | null)[] = [];
	/** per-level cursors — index = level depth (0 = main list); the current
	 * cursor is cursor[stack.length] */
	private cursor: number[] = [0];
	private mode: "list" | "detail" = "list";
	/** the level depth to return to when the detail closes */
	private detailFrom = 0;
	private detail?: { row: SamReportRow; body: SamReportDetail };
	private closed = false;

	constructor(
		keybindings: SamKeybindings,
		model: SamReportModel,
		onDone: (result: SamReportResult) => void,
		/** the live terminal height (pi's `tui.terminal.rows`; tests pass a
		 * fixed value or the null-guarded default from the factory) */
		getRows: () => number,
	) {
		this.keybindings = keybindings;
		this.model = model;
		this.onDone = onDone;
		this.getRows = getRows;
		this.cursor[0] = this.levelRows().length - 1; // the cursor starts at the BOTTOM (the goal, or the newest unit)
	}

	/** The rows of the current level (main list, a subtree, or the dropped level). */
	private levelRows(): SamReportRow[] {
		const depth = this.stack.length;
		if (depth === 0) return this.model.board.rows;
		const top = this.stack[depth - 1];
		if (top === null) return this.model.board.droppedRows;
		const sub = this.model.board.subtrees.find((s) => s.unitId === top);
		return sub !== undefined ? sub.rows : [];
	}

	private depth(): number {
		return this.stack.length;
	}

	private cursorAt(): number {
		const d = this.depth();
		const rows = this.levelRows();
		return Math.min(this.cursor[d] ?? Math.max(rows.length - 1, 0), Math.max(rows.length - 1, 0));
	}

	private setCursorAt(i: number): void {
		const d = this.depth();
		while (this.cursor.length <= d) this.cursor.push(0);
		this.cursor[d] = i;
	}

	/** The visible row count of the list at the live terminal height. */
	private visible(): number {
		const rows = this.getRows();
		const r = Number.isFinite(rows) && rows > 0 ? rows : 40; // null-guard default (tests pass 40)
		return visibleListRows(r);
	}

	private rowLine(r: SamReportRow, idCol: number, verdictCol: number, stubCol: number, cur: boolean): string {
		const label = padTrunc(r.label, idCol);
		const verdict = padTrunc(r.verdict, verdictCol);
		const stub = r.stubLine !== undefined && stubCol >= 8 ? ` ${padTrunc(r.stubLine, stubCol)}` : "";
		return `  ${cur ? ">" : " "} ${label} ${verdict}${stub}`;
	}

	render(width: number): string[] {
		if (this.mode === "detail" && this.detail !== undefined) return this.renderDetail(width);
		const rows = this.levelRows();
		const lines: string[] = [];
		lines.push(this.stack.length === 0 ? this.model.board.header : this.stack[this.stack.length - 1] === null ? "SAM report — dropped units (no carrier)" : `SAM report — subtree of u${this.stack[this.stack.length - 1]}`);
		lines.push("");
		if (rows.length === 0) {
			lines.push("  (nothing here)");
			lines.push("");
			lines.push(this.hint());
			return lines;
		}
		const w = Math.max(width, 40);
		// the label column adapts to the longest VISIBLE row label, capped so
		// the stub always gets room; pi clips lines that still overflow.
		const vis = this.visible();
		const cur = this.cursorAt();
		// a list that fits the window renders in full (no point windowing);
		// otherwise the window centers on the cursor, clamped inside the list
		// — at a list end it pins there, showing a FULL `visible` rows.
		const start =
			rows.length <= vis
				? 0
				: Math.min(Math.max(cur - Math.floor(vis / 2), 0), rows.length - vis);
		const end = Math.min(rows.length, start + vis);
		// the window slides with the cursor; when the cursor is within
		// visible rows of a list end, the window pins to that end.
		const visibleRows = rows.slice(start, end);
		const idCol = Math.min(LABEL_CAP, Math.max(...visibleRows.map((r) => Math.min(r.label.length, LABEL_CAP)), 2));
		const verdictCol = Math.min(VERDICT_MAX, Math.max(VERDICT_MIN, w - idCol - 26));
		const stubCol = w - 4 - idCol - verdictCol;
		for (let i = start; i < end; i++) {
			lines.push(this.rowLine(rows[i], idCol, verdictCol, stubCol, i === cur));
		}
		lines.push("");
		lines.push(this.hint());
		return lines;
	}

	private hint(): string {
		const kb = this.keybindings;
		if (this.depth() > 0) {
			return (
				`${formatKeyHint(kb, SAM_UI_KEYS.up)}/${formatKeyHint(kb, SAM_UI_KEYS.down)}/${formatKeyHint(kb, SAM_UI_KEYS.pageUp)}/${formatKeyHint(kb, SAM_UI_KEYS.pageDown)} move · ` +
				`${formatKeyHint(kb, SAM_UI_KEYS.confirm)} to open · ${formatKeyHint(kb, SAM_UI_KEYS.cancel)} back`
			);
		}
		return (
			`${formatKeyHint(kb, SAM_UI_KEYS.up)}/${formatKeyHint(kb, SAM_UI_KEYS.down)}/${formatKeyHint(kb, SAM_UI_KEYS.pageUp)}/${formatKeyHint(kb, SAM_UI_KEYS.pageDown)} move · ` +
			`${formatKeyHint(kb, SAM_UI_KEYS.confirm)} to open · ${formatKeyHint(kb, SAM_UI_KEYS.cancel)} to close`
		);
	}

	private renderDetail(width: number): string[] {
		const w = Math.max(width, 40);
		const body = this.detail!.body;
		const lines: string[] = [`  ${padTrunc(body.title, w - 2)}`, ""];
		for (const line of wrapText(body.lines.join("\n"), w - 4)) {
			lines.push(`  ${line}`);
		}
		lines.push("");
		lines.push(
			`  ${formatKeyHint(this.keybindings, SAM_UI_KEYS.confirm)} / ${formatKeyHint(this.keybindings, SAM_UI_KEYS.cancel)} to close`,
		);
		return lines;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (this.mode === "detail") {
			// left / esc / enter all close the detail (enter toggles, per Paul)
			if (kb.matches(data, SAM_UI_KEYS.cancel) || kb.matches(data, SAM_UI_KEYS.confirm) || kb.matches(data, "tui.editor.cursorLeft")) {
				this.detail = undefined;
				this.mode = "list";
			}
			return;
		}
		const rows = this.levelRows();
		if (kb.matches(data, SAM_UI_KEYS.up)) {
			this.setCursorAt((this.cursorAt() + rows.length - 1) % rows.length);
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.down)) {
			this.setCursorAt((this.cursorAt() + 1) % rows.length);
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.pageUp) || kb.matches(data, SAM_UI_KEYS.pageDown)) {
			const step = Math.max(this.visible() - 1, 1);
			const cur = this.cursorAt();
			if (rows.length <= step) {
				this.setCursorAt((cur + (kb.matches(data, SAM_UI_KEYS.pageDown) ? step : -step)) % rows.length);
			} else {
				// Spec-exact window shift (Paul: "scrolling up: the topmost
				// entry becomes the bottommost visible") — when the cursor is
				// at the edge of the window the whole window shifts by one row;
				// from the middle it moves by step (clamped inside the list).
				const vis = this.visible();
				const start =
					rows.length <= vis
						? 0
						: Math.min(Math.max(cur - Math.floor(vis / 2), 0), rows.length - vis);
				const lastVisible = Math.min(rows.length, start + vis) - 1;
				if (kb.matches(data, SAM_UI_KEYS.pageUp)) {
					if (cur === start) this.setCursorAt(start - 1 < 0 ? rows.length - 1 : start - 1);
					else this.setCursorAt(Math.max(start, cur - step));
				} else {
					if (cur === lastVisible) this.setCursorAt(lastVisible + 1 >= rows.length ? 0 : lastVisible + 1);
					else this.setCursorAt(Math.min(lastVisible, cur + step));
				}
			}
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.cancel) || kb.matches(data, "tui.editor.cursorLeft")) {
			if (this.depth() > 0) {
				this.stack.pop(); // back to the parent level (cursor preserved per level)
			} else {
				this.closed = true;
				this.onDone({ kind: "closed" });
			}
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.confirm) || kb.matches(data, "tui.editor.cursorRight")) {
			const r = rows[this.cursorAt()];
			if (r !== undefined) this.openRow(r); // empty level: nothing to open
		}
	}

	private openRow(row: SamReportRow): void {
		if (row.kind === "retirement") {
			// a retirement row opens its subtree (null = the dropped pseudo-level)
			const top = row.unitId ?? null;
			const sub = top === null ? this.model.board.droppedRows : this.model.board.subtrees.find((s) => s.unitId === top)?.rows;
			if (sub === undefined || sub.length === 0) return; // nothing to show (e.g. all children un-retired)
			this.stack.push(top);
			const d = this.depth();
			while (this.cursor.length <= d) this.cursor.push(0);
			this.cursor[d] = 0;
			return;
		}
		const body = this.model.detail(row);
		if (body === undefined) return; // nothing to show (e.g. in-flight, no audit yet)
		this.detailFrom = this.depth();
		this.detail = { row, body };
		this.mode = "detail";
	}

	invalidate(): void {
		/* stateless render — nothing cached */
	}
}

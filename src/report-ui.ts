/**
 * SAM report UI (v0.0.38, 2026-11-16) — `/sam report` as a human-traversable
 * ledger (WISHLIST MED #1).
 *
 * Paul's design (2026-11-16): a traversable list of the audited entries —
 * oldest at the top, newest at the bottom, and (when a goal is stored) a
 * "current goal" entry at the very bottom showing the goal's first line in
 * the verdict slot. Each entry carries the short verdict next to its id
 * (cut off on a slim TUI if necessary). Right or ENTER opens the entry and
 * shows the full summary; left, ESC, or ENTER closes it again. ESC on the
 * main list closes the menu. Retired units collapse into a single
 * "retirement (u1, u3, u4, u6, u7)" entry at the top — opening it shows a
 * subtree with the retired units rendered just like the top level (each of
 * those opens its own full summary). Entries are NOT pre-fetched: content is
 * loaded when an entry is opened, so a couple of seconds there is fine.
 *
 * House pattern of settings-ui.ts: deliberately NO `@earendil-works/pi-tui`
 * import — the extension runtime resolves that package through pi's
 * virtual-module alias, but the pinned 0.87.1 capture does not ship it
 * (only 1.3.0 does — measured). So this file is typed against the minimal
 * structural surface the custom factory provides (Component =
 * render(width) / handleInput? / invalidate, KeybindingsManager =
 * matches(data, keyId) / getKeys(keyId)) and builds its own wrap/truncate —
 * no `wrapTextWithAnsi`. The 1.3.0 typecheck checks us against the real
 * interfaces structurally; the 0.87.1 typecheck passes because
 * pi-coding-agent's own d.ts references are lib-skipped there.
 *
 * Read-only: the row model is built from the ledger + branch records
 * (latest-wins retirements via retiredStates); the detail callback may read
 * banked files, but nothing here writes.
 */

import type { SamGoalRecord } from "./goal.ts";
import type { SamUnit } from "./ledger.ts";
import { retiredStates, type RetireLedgerEntry } from "./retire.ts";
import { SAM_UI_KEYS, formatKeyHint, type SamKeybindings } from "./settings-ui.ts";

/** One row of the report list. */
export interface SamReportRow {
	kind: "retirement" | "unit" | "goal";
	/** "u12" for unit rows · "retirement (…)" for the retirement row · "current goal" for the goal row */
	label: string;
	/** the unit id (unit rows only — also the detail/retire-subtree key) */
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

/** The rendered top level + the retirement subtree. */
export interface SamReportBoard {
	header: string;
	rows: SamReportRow[];
	/** the subtree under the retirement row (empty when nothing is retired) */
	retiredRows: SamReportRow[];
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

/**
 * Pure: the report board — retirement row first (when anything is retired,
 * latest-wins), then the units ascending (oldest on top, newest at the
 * bottom), then orphan rows (unaudited), and finally the current goal when
 * one is stored (its first line sits in the verdict slot, per Paul).
 */
export function buildReportBoard(input: SamReportInput): SamReportBoard {
	const retired = retiredStates(input.retirements);
	const retiredIds = [...retired.keys()].sort((a, b) => a - b);
	const unitIds = new Set(input.units.map((u) => u.unitId));

	const rows: SamReportRow[] = [];
	if (retiredIds.length > 0) {
		rows.push({
			kind: "retirement",
			label: `retirement (${retiredIds.map((u) => `u${u}`).join(", ")})`,
			verdict: `${retiredIds.length} retired (latest-wins)`,
		});
	}
	for (const u of [...input.units].sort((a, b) => a.unitId - b.unitId)) {
		rows.push({
			kind: "unit",
			unitId: u.unitId,
			label: `u${u.unitId}`,
			verdict: reportRowVerdict(u),
			stubLine: firstLine(u.stub),
		});
	}
	for (const o of [...input.orphanRows].sort((a, b) => a.unitId - b.unitId)) {
		if (unitIds.has(o.unitId)) continue; // orphans only mint ids outside ledger.units
		rows.push({
			kind: "unit",
			unitId: o.unitId,
			label: `u${o.unitId}`,
			verdict: "orphaned (unaudited)",
			stubLine: o.stubLine,
			retrievalId: o.retrievalId,
		});
	}
	if (input.goal !== undefined) {
		rows.push({
			kind: "goal",
			label: "current goal",
			verdict: firstLine(input.goal.text) ?? "(empty goal)",
		});
	}

	const retiredRows: SamReportRow[] = retiredIds.map((id) => {
		const u = input.units.find((x) => x.unitId === id);
		const shape = retired.get(id);
		const note =
			shape?.shape === "superseded" && shape.supersededBy !== undefined
				? `→ u${shape.supersededBy}`
				: shape?.shape === "dropped"
					? "dropped"
					: "";
		return {
			kind: "unit" as const,
			unitId: id,
			label: `u${id}${note !== "" ? ` ${note}` : ""}`,
			verdict: u !== undefined ? reportRowVerdict(u) : "(not in ledger)",
			stubLine: u !== undefined ? firstLine(u.stub) : undefined,
		};
	});

	const orphans = input.orphanRows.filter((o) => !unitIds.has(o.unitId)).length;
	const parts = [`SAM report — ${input.units.length + orphans} unit${input.units.length + orphans === 1 ? "" : "s"}`];
	if (retiredIds.length > 0) parts.push(`${retiredIds.length} retired`);
	if (orphans > 0) parts.push(`${orphans} orphaned`);
	if (input.goal !== undefined) parts.push("goal on file");
	return { header: parts.join(" · "), rows, retiredRows };
}

/**
 * The interactive view. Modes: "list" (the top level), "retired" (the subtree
 * under the retirement row), "detail" (an opened entry).
 *
 * Keys (all user-rebindable via <agentDir>/keybindings.json):
 *   up/down                  move the cursor (wraps)
 *   right / enter            open the row under the cursor
 *   left / esc / enter       close the open detail (enter toggles, per Paul)
 *   esc (on the main list)   close the whole menu
 */
export class SamReportView {
	private keybindings: SamKeybindings;
	private model: SamReportModel;
	private onDone: (result: SamReportResult) => void;
	private mode: "list" | "retired" | "detail" = "list";
	private topCursor = 0;
	private subCursor = 0;
	/** which list to return to when the detail closes (list vs. retired subtree) */
	private detailRowMode: "list" | "retired" = "list";
	private detail?: { row: SamReportRow; body: SamReportDetail };
	private closed = false;

	constructor(
		keybindings: SamKeybindings,
		model: SamReportModel,
		onDone: (result: SamReportResult) => void,
	) {
		this.keybindings = keybindings;
		this.model = model;
		this.onDone = onDone;
	}

	private rows(): SamReportRow[] {
		return this.mode === "retired" ? this.model.board.retiredRows : this.model.board.rows;
	}

	private cursor(): number {
		return this.mode === "retired" ? this.subCursor : this.topCursor;
	}

	private setCursor(i: number): void {
		if (this.mode === "retired") this.subCursor = i;
		else this.topCursor = i;
	}

	render(width: number): string[] {
		if (this.mode === "detail" && this.detail !== undefined) return this.renderDetail(width);
		const rows = this.rows();
		const lines: string[] = [
			this.mode === "retired" ? "SAM report — retired units" : this.model.board.header,
			"",
		];
		const w = Math.max(width, 40);
		// the label column adapts to the longest row label (the retirement row's
		// "retirement (u1, u3, …)" list usually dominates), capped so the stub
		// always gets room; pi clips lines that still overflow on a slim TUI.
		const idCol = Math.min(LABEL_CAP, Math.max(...rows.map((r) => Math.min(r.label.length, LABEL_CAP)), 2));
		const verdictCol = Math.min(VERDICT_MAX, Math.max(VERDICT_MIN, w - idCol - 26));
		const stubCol = w - 4 - idCol - verdictCol;
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const cur = i === this.cursor() ? ">" : " ";
			const label = padTrunc(r.label, idCol);
			const verdict = padTrunc(r.verdict, verdictCol);
			const stub = r.stubLine !== undefined && stubCol >= 8 ? ` ${padTrunc(r.stubLine, stubCol)}` : "";
			lines.push(`  ${cur} ${label} ${verdict}${stub}`);
		}
		lines.push("");
		const hint =
			this.mode === "retired"
				? `${formatKeyHint(this.keybindings, SAM_UI_KEYS.confirm)} to open · ${formatKeyHint(this.keybindings, SAM_UI_KEYS.cancel)} back to the list`
				: `${formatKeyHint(this.keybindings, SAM_UI_KEYS.up)}/${formatKeyHint(this.keybindings, SAM_UI_KEYS.down)} move · ${formatKeyHint(this.keybindings, SAM_UI_KEYS.confirm)} to open · ${formatKeyHint(this.keybindings, SAM_UI_KEYS.cancel)} to close`;
		lines.push(`  ${hint}`);
		return lines;
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
		const rows = this.rows();
		if (this.mode === "detail") {
			// left / esc / enter all close the detail (enter toggles, per Paul)
			if (kb.matches(data, SAM_UI_KEYS.cancel) || kb.matches(data, SAM_UI_KEYS.confirm) || kb.matches(data, "tui.editor.cursorLeft")) {
				this.detail = undefined;
				this.mode = this.detailRowMode;
			}
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.up)) {
			this.setCursor((this.cursor() + rows.length - 1) % rows.length);
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.down)) {
			this.setCursor((this.cursor() + 1) % rows.length);
			return;
		}
		if (this.mode === "retired" && (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, SAM_UI_KEYS.cancel))) {
			this.mode = "list";
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.cancel)) {
			this.closed = true;
			this.onDone({ kind: "closed" });
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.confirm) || kb.matches(data, "tui.editor.cursorRight")) {
			const r = rows[this.cursor()];
			if (r !== undefined) this.openRow(r); // empty board: nothing to open
		}
	}

	private openRow(row: SamReportRow): void {
		if (row.kind === "retirement") {
			if (this.model.board.retiredRows.length === 0) return;
			this.detailRowMode = "list";
			this.mode = "retired";
			this.subCursor = 0;
			return;
		}
		const body = this.model.detail(row);
		if (body === undefined) return; // nothing to show (e.g. in-flight, no audit yet)
		this.detailRowMode = this.mode === "detail" ? this.detailRowMode : this.mode; // openRow is only reachable from a list mode
		this.detail = { row, body };
		this.mode = "detail";
	}

	invalidate(): void {
		/* stateless render — nothing cached */
	}
}

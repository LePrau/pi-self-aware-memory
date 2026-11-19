/**
 * SAM report UI (v0.0.42, 2026-11-17 — report v3.1) — `/sam report` as a
 * human-traversable ledger (WISHLIST MED #1).
 *
 * v0.0.42 design change (Paul's live observation of v0.0.41: scrolling in
 * the entries did not work, the dropped row could not be opened, the
 * retirement rows showed the child list but the tree could not be
 * accessed):
 *
 *  A. A RETIREMENT UNIT gets TWO ROWS at its creation spot (Paul's sketch):
 *        u123  10:00  PLAUSIBLE  <the unit's own stub line>
 *        ▸ u123          —       —    retired u17, u33, u817
 *     - The FIRST row is the entry itself — a normal unit row (kind
 *       "unit"), opened like any other unit (the full summary detail).
 *     - The SECOND row is the TREE row (kind "subtree"): the retired units
 *       rendered as TEXT in the verdict slot; ENTER pushes the SUBTREE as a
 *       NAVIGABLE LEVEL (one row per child — a nested carrier gets its own
 *       entry + tree rows there, the matryoshka). ESC/LEFT pops back to the
 *       parent level (the cursor preserved per level).
 *     - The carrier-less "dropped" row is the same construct without a
 *       carrier unit: ENTER pushes the dropped units as a level (each
 *       openable).
 *  B. THE DETAIL IS A NATURAL SCROLL (the v0.0.41 bug): the wrapped-line
 *     count is computed with the SAME width as the render (the v0.0.41
 *     handleInput wrapped at the terminal ROWS, not columns — the cursor
 *     moved through phantom space while the render saw the content as
 *     fitting), and up/down move the window by one row (clamped at the
 *     ends, no centered-cursor dead zone, no wrapping). PgUp/PgDown in the
 *     detail scroll by visible−1 (clamped; the keys are captured by pi —
 *     the code stays for a later key mapping).
 *  C. AUTO-RETIRE CARRIERS get rows like manual carriers: the synthesized
 *     auto-retire settlement never lands in ledger.units (the commit
 *     appends the ledger action + settlement records only), so the caller
 *     (index.ts) SYNTHESIZES a SamUnit per auto-retire settlement and
 *     merges it into the board's units — the carrier then gets its entry +
 *     tree rows like any other carrier.
 *
 * v0.0.41 design (kept; Paul's spec after the v0.0.40 live observation —
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
import { ORPHAN_KEEP_DEFAULT } from "./branchaudit.ts"; // v0.0.49: the carried-orphan cap (default for the report)
import { SAM_UI_KEYS, formatKeyHint, type SamKeybindings } from "./settings-ui.ts";

/** One row of the report list (the fixed column table — v0.0.41). */
export interface SamReportRow {
	/**
	 * "unit" — a unit's own entry (a carrier's FIRST row, or any unit);
	 * "subtree" — a carrier's TREE row (ENTER pushes the subtree level —
	 * the second row of a carrier, or the carrier-less "dropped" row);
	 * "orphan" — an unaudited fold span (retrieval id); "goal" — the stored
	 * goal. (The v0.0.41 "retirement" kind is gone — carriers are now a
	 * unit row + a subtree row.)
	 */
	kind: "subtree" | "unit" | "orphan" | "goal";
	/** the unit name (fixed 15-char column): "u12" · "▸ u12" · "dropped" ·
	 * "current goal" */
	label: string;
	/** the unit id (unit/orphan/subtree rows — a subtree row's unitId is its
	 * carrier; the dropped row has none) */
	unitId?: number;
	/** v0.0.49: an "older orphans" run's key into `board.orphanRuns` (ENTER
	 * pushes that run's rows as a level) — set on the run's TREE row only */
	subtreeKey?: string;
	/** the VERDICT CLASS caption (the fixed 11-char class column): VERIFIED,
	 * PLAUSIBLE, CORRECTIONS, UNAUDITABLE, AUTO-RETIRE, NOT-YET, UNVERIFIED —
	 * undefined for rows without a class (rendered "—") */
	class?: string;
	/** the short text in the VERDICT-SLOT column: the state text for units
	 * without a class, "unaudited" for orphans, the goal's first line, the
	 * carrier's child list ("retired u17, u33, u817" — the TREE row), and —
	 * on the dropped row — the LIST OF THE DROPPED UNITS */
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
	/** v0.0.49: the carried-orphan cap (the resolved `orphanKeep` dial) —
	 * the report keeps the LAST K orphan rows visible in the main list; older
	 * orphans collapse into "older orphans (n)" tree runs. ORPHAN_KEEP_DEFAULT
	 * when undefined. */
	orphanKeep?: number;
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
	 * One SUBTREE LEVEL per RETIREMENT unit (a manual carrier close, or the
	 * synthesized auto-retire unit): the units it retired directly,
	 * ascending — one ENTRY row per child (a nested carrier gets its entry
	 * row + its own TREE row, the matryoshka), rendered exactly like
	 * top-level rows. A child that was un-retired later is NOT listed here
	 * (it returned to the main list, latest-wins). ENTER on the carrier's
	 * tree row pushes these rows as a navigable level.
	 */
	subtrees: { unitId: number; rows: SamReportRow[] }[];
	/**
	 * v0.0.49: one SUBTREE LEVEL per collapsed run of STALE orphans (older
	 * than the last `orphanKeep`): that run's orphan rows, ascending —
	 * rendered exactly like top-level orphan rows. ENTER on the run's
	 * "older orphans" main-list row pushes these rows as a navigable level.
	 * Empty when no run collapsed.
	 */
	orphanRuns: { key: string; rows: SamReportRow[] }[];
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
	/** v0.0.43: pre-styled header lines (rendered under the title, above
	 * the body — wrapped ANSI-safe when the view has wrapAnsi) */
	header?: string[];
	/** v0.0.43: the body as markdown source (rendered through the view's
	 * injectable markdownRender — TUI-only; absent on the plain path) */
	markdown?: string;
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
 * `fg(token, text)` styles the text with a theme token's foreground, and
 * `bold(text)` bolds it (the v0.0.43 detail header; the method forms keep
 * the structural check bivariant against pi's
 * `fg(color: ThemeColor, text: string)` / `bold(text: string)`). */
export interface SamTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
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

/* ── v0.0.43: the detail header (per-token theme styling) + the loose
 * markdown body (pi renders it with its Markdown component) ─────────── */

/** The unit data the detail view needs (evidence counts as scalars — the
 * callback reads `files.length`; the banked text is the retrieved content,
 * already near-markdown from the settlement/orphan blocks). */
export interface SamUnitDetailInput {
	unitId: number;
	state: string;
	verdictClass?: string;
	evidence?: { files: number; errors: number; retries: number; nonTrivial: boolean };
	reason?: string;
	corrections?: string;
	resolvedBasis?: string;
	stub: string;
	/** the banked content text ("" when unreachable) */
	banked?: string;
	/** orphan rows (unaudited) — the state line reads "orphaned (unaudited)" */
	orphan?: boolean;
	orphanStubLine?: string;
}

/** One styled token (the null-guarded house pattern — no theme, no
 * styling): bold first (pi's `theme.bold`), then the fg token. (`== null`
 * — the fake-ctx tests pass a NULL theme, not undefined.) */
function styled(theme: SamTheme | undefined, color: string | undefined, text: string, bold = false): string {
	if (theme == null || text === "") return text;
	let out = text;
	if (bold && theme.bold !== undefined) out = theme.bold(out);
	if (color !== undefined) out = theme.fg(color, out);
	return out;
}

/** The color of the state token (v0.0.43, Paul): resolved + folded are
 * settled (dim); in-flight / refused / undone / orphaned are unresolved
 * (warning). */
export function samUnitStateColor(state: string, orphan: boolean): string {
	if (orphan) return "warning";
	if (state === "resolved" || state === "folded") return "dim";
	return "warning";
}

/** The v0.0.43 detail header (Paul's per-token spec):
 *   line 1: `unit N` bold · ` — ` dim · `state <s>` (dim when settled,
 *           warning otherwise) · ` · ` dim · `verdict` dim · ` <CLASS>` in
 *           CLASS_COLORS
 *   line 2: `evidence:` bold, file count normal, `file(s)` dim, error count
 *           error when > 0 else dim, `error(s)` dim, retrial count warning
 *           when > 0 else normal, `retrial(s)` dim, `nonTrivial` dim,
 *           true → success / false → normal
 *   then `reason:` / `corrections:` / `basis:` — label bold, text normal.
 * Plain (unstyled) when the theme is undefined (the tests). */
export function samUnitHeader(input: SamUnitDetailInput, theme?: SamTheme): string[] {
	const dim = (t: string): string => styled(theme, "dim", t);
	const lines: string[] = [];
	if (input.orphan) {
		lines.push(`${styled(theme, undefined, `unit ${input.unitId}`, true)} ${dim("— ")}${styled(theme, "warning", "orphaned (unaudited)")}`);
	} else {
		const v =
			input.verdictClass !== undefined ? ` ${dim("· verdict")} ${styled(theme, CLASS_COLORS[input.verdictClass], input.verdictClass)}` : "";
		lines.push(`${styled(theme, undefined, `unit ${input.unitId}`, true)} ${dim("— ")}${styled(theme, samUnitStateColor(input.state, false), `state ${input.state}`)}${v}`);
	}
	const e = input.evidence;
	if (e !== undefined) {
		lines.push(
			`${styled(theme, undefined, "evidence:", true)} ${e.files} ${dim("file(s)")} ${dim("· ")}${styled(theme, e.errors > 0 ? "error" : "dim", String(e.errors))} ${dim("error(s)")} ${dim("· ")}${styled(theme, e.retries > 0 ? "warning" : undefined, String(e.retries))} ${dim("retrial(s)")} ${dim("· ")}${dim("nonTrivial")} ${e.nonTrivial ? styled(theme, "success", "true") : "false"}`,
		);
	}
	if (input.reason !== undefined) lines.push(`${styled(theme, undefined, "reason:", true)} ${input.reason}`);
	if (input.corrections !== undefined) lines.push(`${styled(theme, undefined, "corrections:", true)} ${input.corrections}`);
	if (input.resolvedBasis !== undefined) lines.push(`${styled(theme, undefined, "basis:", true)} ${input.resolvedBasis}`);
	return lines;
}

/** The v0.0.43 loose markdown transform (Paul: first version, only what
 * pi offers, no over-fancy): existing backtick spans are kept untouched;
 * UNQUOTED 12+ hex hashes (retrieval ids) and `\d+.\d+.\d+` version
 * numbers get code spans. Line-based and idempotent. */
export function samLooseMarkdown(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			// odd split parts sit INSIDE existing backtick spans
			const parts = line.split("`");
			for (let i = 0; i < parts.length; i += 2) {
				parts[i] = parts[i]
					.replace(/\b[0-9a-f]{12,}\b/g, "`$&`")
					.replace(/\bv?\d+\.\d+\.\d+\b/g, "`$&`");
			}
			return parts.join("`");
		})
		.join("\n");
}

/** The v0.0.43 detail body as markdown source: the unit's own stub as a
 * `**STUB**` section (orphan rows: their verdict-slot stub line first),
 * then the banked content (already near-markdown — the settlement / orphan
 * block with `##` headings and `**SECTION**` captions). Both sides get the
 * loose transform. The plain fallback (no markdown available) keeps today's
 * exact format — `STUB:` + stub + banked text. */
export function samUnitDetailBody(input: SamUnitDetailInput): { markdown: string; plain: string[] } {
	const plain: string[] = [];
	if (input.orphan) {
		if (input.orphanStubLine !== undefined) plain.push(input.orphanStubLine);
	} else if (input.stub.trim() !== "") {
		plain.push("", "STUB:", input.stub);
	}
	const banked = input.banked ?? "";
	if (banked.trim() !== "") plain.push("", banked);
	else plain.push("", "(no banked content reachable for this unit)");
	const md: string[] = [];
	if (input.orphan) {
		if (input.orphanStubLine !== undefined) md.push(samLooseMarkdown(input.orphanStubLine));
	} else if (input.stub.trim() !== "") {
		md.push("**STUB**", "", samLooseMarkdown(input.stub));
	}
	if (banked.trim() !== "") md.push("", samLooseMarkdown(banked));
	else md.push("", "(no banked content reachable for this unit)");
	return { markdown: md.join("\n"), plain };
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

	/** The carrier's visible CHILDREN (latest-wins, ascending) — a child
	 * un-retired later is not listed (it returned to the main list). */
	const childSpecsOf = (carrierId: number): ChildSpec[] => {
		const m = children.get(carrierId);
		if (m === undefined) return [];
		return [...m.values()]
			.filter((c) => retired.has(c.unitId) || absorbedAsChild.has(c.unitId))
			.sort((a, b) => a.unitId - b.unitId);
	};

	/** A unit's ENTRY row (kind "unit" — always): the carrier's FIRST row at
	 * its creation spot, or a nested carrier's entry inside a parent's
	 * subtree level. Opened like any other unit (the full summary detail). */
	const unitEntryRow = (
		id: number,
		shape: ChildSpec["shape"] | undefined,
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
		return {
			kind: "unit",
			unitId: id,
			label: `u${id}${note !== "" ? ` ${note}` : ""}`,
			class: u !== undefined ? reportRowClass(u) : undefined,
			verdict: u !== undefined ? reportRowSlot(u) : "(not in ledger)",
			stubLine: u !== undefined ? firstLine(u.stub) : undefined,
			time: formatReportTime(input.closeTs?.get(id)),
		};
	};

	/** The carrier's TREE row (kind "subtree"): the retired units rendered
	 * as TEXT in the verdict slot; ENTER pushes the subtree level. */
	const subtreeRow = (carrierId: number): SamReportRow => {
		const kids = childSpecsOf(carrierId).map((c) => `u${c.unitId}`).join(", ");
		return {
			kind: "subtree",
			unitId: carrierId,
			label: `▸ u${carrierId}`,
			verdict: `retired ${kids}`,
		};
	};

	/** The visible ROWS of a carrier's subtree LEVEL (latest-wins,
	 * ascending): one entry row per child — a nested carrier (one that was
	 * itself retired or absorbed later) gets its entry row + its own TREE
	 * row (the matryoshka). */
	const subtreeRowsOf = (carrierId: number): SamReportRow[] => {
		const out: SamReportRow[] = [];
		for (const c of childSpecsOf(carrierId)) {
			out.push(unitEntryRow(c.unitId, c.shape, c.supersededBy, c.shape === "absorbed"));
			if (children.has(c.unitId) && childSpecsOf(c.unitId).length > 0) out.push(subtreeRow(c.unitId));
		}
		return out;
	};

	// Main list: live units + orphans, chronologically (the goal row last).
	// A carrier gets TWO rows at its creation spot (v0.0.42 — Paul's
	// sketch): the entry itself, then its tree row. v0.0.49: only the LAST
	// `orphanKeep` orphan rows stay visible — older orphans collapse into
	// an "older orphans (n)" tree row per consecutive run (a real unit in
	// between splits the runs, so the order stays true to the appearance).
	const rows: SamReportRow[] = [];
	type OrphanView = { unitId: number; retrievalId: string; stubLine?: string; ts?: number };
	type MainItem =
		| { unitId: number; kind: "unit"; rows: SamReportRow[] }
		| { unitId: number; kind: "orphan"; view: OrphanView }
		| { unitId: number; kind: "orphanRun"; views: OrphanView[] };
	const orphanRowOf = (o: OrphanView): SamReportRow => ({
		kind: "orphan",
		unitId: o.unitId,
		label: `u${o.unitId}`,
		verdict: "unaudited",
		stubLine: o.stubLine,
		retrievalId: o.retrievalId,
		time: formatReportTime(o.ts),
	});
	const items: MainItem[] = [];
	for (const u of input.units) {
		if (retired.has(u.unitId)) continue; // lives in its carrier's subtree (or the dropped row)
		if (absorbedAsChild.has(u.unitId)) continue; // matryoshka — lives in the absorber's subtree
		const itemRows = [unitEntryRow(u.unitId, undefined, undefined, false)];
		if (children.has(u.unitId) && childSpecsOf(u.unitId).length > 0) itemRows.push(subtreeRow(u.unitId));
		items.push({ unitId: u.unitId, kind: "unit", rows: itemRows });
	}
	// The displayable orphans, ascending (the input is already ascending —
	// re-sort after the filters for safety).
	const orphanViews: OrphanView[] = [];
	for (const o of input.orphanRows) {
		if (unitIds.has(o.unitId)) continue; // orphans only mint ids outside ledger.units
		if (retired.has(o.unitId) || absorbedAsChild.has(o.unitId)) continue; // unreachable in practice — fail safe
		orphanViews.push(o);
	}
	orphanViews.sort((a, b) => a.unitId - b.unitId);
	// The LAST K orphans stay visible (K = the orphanKeep dial); the rest
	// collapse into runs of consecutive stale orphan rows.
	const keep = input.orphanKeep ?? ORPHAN_KEEP_DEFAULT;
	const recentFrom = Math.max(orphanViews.length - keep, 0);
	const recentIds = new Set(orphanViews.slice(recentFrom).map((o) => o.unitId));
	for (const o of orphanViews) items.push({ unitId: o.unitId, kind: "orphan", view: o });
	items.sort((a, b) => a.unitId - b.unitId);
	// Walk the sorted items: fold each maximal run of consecutive STALE
	// orphan items into ONE run (its rows ride board.orphanRuns).
	const finalItems: MainItem[] = [];
	let run: OrphanView[] = [];
	const flushRun = (): void => {
		if (run.length === 0) return;
		const views = run;
		run = [];
		finalItems.push({ unitId: views[0].unitId, kind: "orphanRun", views });
	};
	for (const item of items) {
		if (item.kind === "orphan" && !recentIds.has(item.unitId)) {
			run.push(item.view);
			continue;
		}
		flushRun();
		if (item.kind === "orphan") finalItems.push({ unitId: item.unitId, kind: "orphan", view: item.view });
		else finalItems.push(item);
	}
	flushRun();
	for (const item of finalItems) {
		if (item.kind === "unit") {
			rows.push(...item.rows);
		} else if (item.kind === "orphan") {
			rows.push(orphanRowOf(item.view));
		} else {
			// The run's TREE row — styled like a retirement's second row (the
			// dim "▸" tree row; ENTER pushes the run's rows as a level).
			const idList = item.views.map((v) => `u${v.unitId}`).join(", ");
			rows.push({
				kind: "subtree",
				label: "▸ older orphans",
				verdict: `${idList} (${item.views.length})`,
				subtreeKey: `orphan-run-${item.views[0].unitId}`,
			});
		}
	}
	const orphanRuns = finalItems
		.filter((i): i is Extract<MainItem, { kind: "orphanRun" }> => i.kind === "orphanRun")
		.map((i) => ({ key: `orphan-run-${i.views[0].unitId}`, rows: i.views.map(orphanRowOf) }));

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
	// The carrier-less drops: ONE tree row (kind "subtree" — ENTER pushes
	// the dropped units as a level, each openable; the list rides the
	// verdict slot, v0.0.41).
	if (droppedIds.length > 0) {
		rows.push({
			kind: "subtree",
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
	return { header: parts.join(" · "), rows, subtrees: [...children.keys()].sort((a, b) => a - b).map((id) => ({ unitId: id, rows: subtreeRowsOf(id) })), orphanRuns, droppedRows };
}

/**
 * The interactive view (v0.0.42).
 *
 * LEVELS: the main list is level 0. ENTER on a TREE row (a carrier's
 * second row, or the carrier-less "dropped" row) pushes that SUBTREE as a
 * navigable level (the rows from `board.subtrees` / `board.droppedRows` —
 * a nested carrier gets its entry + tree rows there, the matryoshka); the
 * cursor starts at the TOP of the pushed level and each level keeps its
 * OWN cursor, so ESC/LEFT back preserves where you were in the parent.
 * ENTER on a unit/orphan/goal row opens the DETAIL overlay (the lazy
 * callback's text) — the cursor and the level are restored on close.
 *
 * Every level is windowed to `windowContentRows(getRows())` rows (the
 * window minus the split line) centered on its cursor, pinned at the ends;
 * the DETAIL is windowed with the SAME calculation (the title stays at the
 * top, the content indented).
 *
 * Keys (all user-rebindable via <agentDir>/keybindings.json):
 *   up / down            move the cursor by one (wraps) — in the detail:
 *                        scroll the content by one row (CLAMPED at the ends
 *                        — natural scroll, v0.0.42)
 *   PgUp / PgDown        scroll by visible−1 rows (wraps — the topmost
 *                        entry becomes the bottommost visible) — pi currently
 *                        captures these for the main scroll; the code stays
 *                        for a later key mapping (Paul, 2026-11-16)
 *   right / enter        open the row under the cursor (a TREE row pushes
 *                        its subtree level; everything else its detail)
 *   left / esc / enter   close the open detail (enter toggles) — or pop the
 *                        current subtree level; esc on the main list closes
 *                        the whole menu
 *
 * The v0.0.41 detail-scroll bug (fixed in v0.0.42): the input handler
 * wrapped the content at `getRows() - 4` — the terminal's ROWS (a vertical
 * dimension), while the render wrapped at the render's WIDTH minus the
 * indent. The cursor then moved through phantom space while the render
 * saw the content as fitting, and the centered-cursor window had a dead
 * zone (floor(vis/2) rows) at the top before anything moved. Now: the
 * render tracks its width (`lastWidth`), the input computes the wrapped
 * line count at that same width, and up/down move a scroll OFFSET by one
 * row, clamped at the ends.
 */
export class SamReportView {
	private keybindings: SamKeybindings;
	private model: SamReportModel;
	private onDone: (result: SamReportResult) => void;
	private getRows: () => number;
	private theme?: SamTheme;
	/** The level stack — level 0 is the main list; each pushed level is a
	 * subtree (a carrier's children, or the dropped units). Each level
	 * keeps its OWN cursor (v0.0.42). */
	private levels: { rows: SamReportRow[]; cursor: number; title: string }[];
	private detail?: { row: SamReportRow; body: SamReportDetail };
	/** the detail scroll OFFSET (the first visible content line) —
	 * v0.0.42 natural scroll (clamped at the ends, no wrap) */
	private detailScroll = 0;
	/** the last render width — the detail's wrap width must match the
	 * render's (the v0.0.41 bug) */
	private lastWidth = 0;
	private closed = false;
	/** v0.0.43: ANSI-aware line wrapper for the styled header lines (pi-tui's
	 * wrapTextWithAnsi — feature-detected by the TUI wiring; undefined in the
	 * tests and on the legacy sets) */
	private wrapAnsi?: (text: string, width: number) => string[];
	/** v0.0.43: the markdown body renderer (pi-tui's Markdown component —
	 * feature-detected; undefined in the tests and on the legacy sets) */
	private markdownRender?: (markdown: string, width: number) => string[];
	/** the markdown body's rendered lines, cached per (width, detail) */
	private mdCache?: { width: number; lines: string[] };
	/** v0.0.49+: visible-width measurer for the scrollbar column padding
	 * (pi-tui's `visibleWidth` — feature-detected by the TUI wiring; falls
	 * back to string length in the tests and on the legacy sets, whose
	 * report lines are plain there) */
	private visibleWidthFn?: (s: string) => number;
	/** v0.0.49+: the last column is reserved for the scrollbar when it is
	 * up (1) — the detail's wrap width and its line count stay exact
	 * between the render and the input handler (the v0.0.42 invariant) */
	private detailWrapReserve = 0;

	constructor(
		keybindings: SamKeybindings,
		model: SamReportModel,
		onDone: (result: SamReportResult) => void,
		/** the live terminal height (pi's `tui.terminal.rows`; tests pass a
		 * fixed value or the null-guarded default from the factory) */
		getRows: () => number,
		/** pi's theme (the class-column colors) — undefined in the tests */
		theme?: SamTheme,
		/** v0.0.43: ANSI-aware wrapper for the styled header lines */
		wrapAnsi?: (text: string, width: number) => string[],
		/** v0.0.43: the markdown body renderer */
		markdownRender?: (markdown: string, width: number) => string[],
		/** v0.0.49+: visible-width measurer for the scrollbar padding */
		visibleWidth?: (s: string) => number,
	) {
		this.keybindings = keybindings;
		this.model = model;
		this.onDone = onDone;
		this.getRows = getRows;
		this.theme = theme;
		this.wrapAnsi = wrapAnsi;
		this.markdownRender = markdownRender;
		this.visibleWidthFn = visibleWidth;
		const main = model.board.rows;
		this.levels = [{ rows: main, cursor: Math.max(main.length - 1, 0), title: model.board.header }]; // the cursor starts at the BOTTOM (the goal, or the newest unit)
	}

	/** The current level (the main list, or a pushed subtree). */
	private level(): { rows: SamReportRow[]; cursor: number; title: string } {
		return this.levels[this.levels.length - 1];
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
		if (this.detail !== undefined) return this.renderDetail(width);
		this.lastWidth = Math.max(width, 40);
		const lv = this.level();
		const rows = lv.rows;
		const lines: string[] = [];
		const w = this.lastWidth;
		lines.push(this.splitLine(w));
		// level 0 keeps the board header verbatim; a pushed subtree level
		// gets its own title line (indented)
		lines.push(this.levels.length > 1 ? `  ${padTrunc(lv.title, w - 2)}` : lv.title);
		lines.push("");
		if (rows.length === 0) {
			lines.push("  (nothing here)");
			lines.push("");
			lines.push(this.hint());
			return lines;
		}
		// fixed columns (v0.0.41): the label (15), the class (11), the time
		// (11) never jump; the verdict slot adapts to the visible rows
		// (capped) and the stub gets the rest.
		const vis = this.contentRows();
		const cur = Math.min(lv.cursor, rows.length - 1);
		// a level that fits the window renders in full (no point windowing);
		// otherwise the window centers on the cursor, clamped inside the
		// level — at a level end it pins there, showing a FULL `vis` rows.
		const start =
			rows.length <= vis
				? 0
				: Math.min(Math.max(cur - Math.floor(vis / 2), 0), rows.length - vis);
		const end = Math.min(rows.length, start + vis);
		// v0.0.49+: the right-edge scrollbar (pi chat style — drawn only
		// when the level overflows the window) reserves the last column,
		// so the content columns compute at w−1 while it is up.
		const scrollable = rows.length > vis;
		const cw = scrollable ? w - 1 : w;
		const verdictCol = Math.min(VERDICT_MAX, Math.max(VERDICT_MIN, cw - 2 - LABEL_W - 2 - CLASS_W - 2 - TIME_W - 2 - 26));
		const stubCol = cw - 4 - LABEL_W - CLASS_W - TIME_W - 2 * 3 - verdictCol;
		const geom = scrollable ? this.scrollbarGeom(rows.length, end - start, start) : undefined;
		for (let i = start; i < end; i++) {
			const line = this.rowLine(rows[i], verdictCol, stubCol, i === cur);
			lines.push(geom !== undefined ? this.withScrollbar(line, w - 1, i - start, geom) : line);
		}
		lines.push("");
		lines.push(this.hint());
		return lines;
	}

	/** The pi chat-viewport scrollbar geometry (pi 1.5.2, layout.ts —
	 * measured): track = the window's content rows, thumb height =
	 * max(min(2, track), min(track, round(track² / total))), thumb top =
	 * round(scrollTop / maxScrollTop × (track − thumbHeight)). */
	private scrollbarGeom(total: number, track: number, scrollTop: number): { top: number; height: number } {
		const height = Math.max(Math.min(2, track), Math.min(track, Math.round((track * track) / total)));
		const maxStart = Math.max(0, total - track);
		const top = maxStart === 0 ? 0 : Math.round((scrollTop / maxStart) * (track - height));
		return { top, height };
	}

	/** Pad the line out to the visible width `target` (ANSI-aware when the
	 * feature-detected measurer is present) and append the scrollbar char
	 * for row `i` of the window (thumb vs. track). */
	private withScrollbar(line: string, target: number, i: number, geom: { top: number; height: number }): string {
		const vw = this.visibleWidthFn !== undefined ? this.visibleWidthFn(line) : line.length;
		const inThumb = i >= geom.top && i < geom.top + geom.height;
		return line + " ".repeat(Math.max(0, target - vw)) + (inThumb ? this.thumbChar() : this.trackChar());
	}

	private trackChar(): string {
		return this.theme != null ? this.theme.fg("scrollbarTrack", "│") : "│";
	}

	private thumbChar(): string {
		return this.theme != null ? this.theme.fg("scrollbarThumb", "┃") : "┃";
	}

	private hint(): string {
		const kb = this.keybindings;
		if (this.detail !== undefined) {
			return `${formatKeyHint(kb, SAM_UI_KEYS.up)}/${formatKeyHint(kb, SAM_UI_KEYS.down)} scroll · ${formatKeyHint(kb, SAM_UI_KEYS.cancel)} to close`;
		}
		const back = this.levels.length > 1 ? "go back" : "close";
		return (
			`${formatKeyHint(kb, SAM_UI_KEYS.up)}/${formatKeyHint(kb, SAM_UI_KEYS.down)}/${formatKeyHint(kb, SAM_UI_KEYS.pageUp)}/${formatKeyHint(kb, SAM_UI_KEYS.pageDown)} move · ` +
			`${formatKeyHint(kb, SAM_UI_KEYS.confirm)} to open · ${formatKeyHint(kb, SAM_UI_KEYS.cancel)} to ${back}`
		);
	}

	/** The detail's FULL content lines at the last render width — shared
	 * by the render and the input handler (the v0.0.42 scroll math stays
	 * exact: both compute the SAME line count). v0.0.43: the styled header
	 * lines first (ANSI-wrapped when wrapAnsi is available — plain wrapText
	 * would break escape codes), then the body: the markdown rendering when
	 * available, the plain lines otherwise (legacy fallback). */
	private detailContentLines(): string[] {
		const w = Math.max(this.lastWidth, 40) - this.detailWrapReserve; // v0.0.49+: the scrollbar column, when up
		const body = this.detail!.body;
		const out: string[] = [];
		if (body.header !== undefined) {
			for (const h of body.header) {
				out.push(...(this.wrapAnsi !== undefined ? this.wrapAnsi(h, w - 4) : [h]));
			}
		}
		if (body.markdown !== undefined && this.markdownRender !== undefined) {
			if (this.mdCache === undefined || this.mdCache.width !== w - 4) {
				this.mdCache = { width: w - 4, lines: this.markdownRender(body.markdown, w - 4) };
			}
			out.push(...this.mdCache.lines);
		} else {
			out.push(...wrapText(body.lines.join("\n"), w - 4));
		}
		return out;
	}

	private renderDetail(width: number): string[] {
		const w = Math.max(width, 40);
		this.lastWidth = w;
		const body = this.detail!.body;
		// the SAME window calculation as the list (v0.0.41): the split line
		// at the top counts towards the size; the content rows = window − 1.
		const vis = this.contentRows();
		// v0.0.49+: the scrollbar reserves the last column when it is up —
		// two-pass (re-wrapping narrower can only ADD lines, so the check at
		// the full width is the decision; the reserve then stays exact for
		// the input handler's shared line count).
		this.detailWrapReserve = 0;
		let content = this.detailContentLines();
		if (content.length > vis) {
			this.detailWrapReserve = 1;
			content = this.detailContentLines();
		}
		const n = content.length;
		const scrollable = n > vis;
		// natural scroll (v0.0.42): the scroll OFFSET, clamped so the window
		// never runs past the content
		const maxStart = Math.max(0, n - vis);
		const start = Math.min(this.detailScroll, maxStart);
		const end = Math.min(n, start + vis);
		const geom = scrollable ? this.scrollbarGeom(n, end - start, start) : undefined;
		const lines: string[] = [this.splitLine(w), `  ${padTrunc(body.title, w - 2)}`];
		for (let i = start; i < end; i++) {
			const line = `    ${content[i]}`; // the content indented under the name (v0.0.41)
			lines.push(geom !== undefined ? this.withScrollbar(line, w - 1, i - start, geom) : line);
		}
		lines.push("");
		lines.push(this.hint());
		return lines;
	}

	/** The mouse wheel (v0.0.49+ — the report now runs as a full-width,
	 * bottom-anchored OVERLAY (pi's own settings placement — the bottom
	 * editor slot), so pi's alt-screen mouse dispatch reaches us —
	 * dispatchMouseToOverlay → handleMouse; wheel over the chat area above
	 * the overlay still scrolls the chat; as a plain dialog the alt-screen
	 * consumed every wheel sequence and the fallback scrolled the chat
	 * transcript behind the report). The alt-screen's
	 * WheelScrollAccelerator already applies the "auto" velocity and the
	 * Alt ×5, so we just get line counts. Detail open ⇒ scroll the detail;
	 * otherwise move the current level's cursor (the window follows it,
	 * clamped at the ends — the house wrap stays for the arrow keys).
	 * `{handled: true}` consumes the event (no fallthrough to the chat
	 * scroll); non-wheel events pass through (pi's text selection etc.). */
	handleMouse(event: { type: string; wheelDelta?: number }): { handled: true } | undefined {
		if (this.closed || event.type !== "wheel") return undefined;
		const delta = event.wheelDelta ?? 0; // pi types wheelDelta as optional
		if (!Number.isFinite(delta) || delta === 0) return undefined;
		if (this.detail !== undefined) {
			const n = this.detailContentLines().length;
			const maxStart = Math.max(0, n - this.contentRows());
			this.detailScroll = Math.max(0, Math.min(maxStart, this.detailScroll + delta));
		} else {
			const lv = this.level();
			if (lv.rows.length > 0) {
				lv.cursor = Math.max(0, Math.min(lv.rows.length - 1, lv.cursor + delta));
			}
		}
		return { handled: true };
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (this.detail !== undefined) {
			// the FULL content line count at the RENDER width (v0.0.42 — the
			// v0.0.41 bug wrapped at the terminal ROWS instead; v0.0.43: header
			// + markdown body, the shared detailContentLines math)
			const n = this.detailContentLines().length;
			if (n > 0) {
				const vis = this.contentRows();
				const maxStart = Math.max(0, n - vis);
				if (kb.matches(data, SAM_UI_KEYS.up)) {
					this.detailScroll = Math.max(this.detailScroll - 1, 0);
					return;
				}
				if (kb.matches(data, SAM_UI_KEYS.down)) {
					this.detailScroll = Math.min(this.detailScroll + 1, maxStart);
					return;
				}
				if (kb.matches(data, SAM_UI_KEYS.pageUp) || kb.matches(data, SAM_UI_KEYS.pageDown)) {
					// page scroll: visible−1 rows, clamped at the ends (v0.0.42)
					// — the keys are captured by pi for the main scroll; the
					// code stays for a later key mapping
					const step = Math.max(vis - 1, 1);
					this.detailScroll = kb.matches(data, SAM_UI_KEYS.pageUp)
						? Math.max(this.detailScroll - step, 0)
						: Math.min(this.detailScroll + step, maxStart);
					return;
				}
			}
			// left / esc / enter all close the detail (enter toggles, per Paul)
			if (kb.matches(data, SAM_UI_KEYS.cancel) || kb.matches(data, SAM_UI_KEYS.confirm) || kb.matches(data, "tui.editor.cursorLeft")) {
				this.detail = undefined;
			}
			return;
		}
		const lv = this.level();
		const rows = lv.rows;
		const cur = Math.min(lv.cursor, rows.length - 1);
		if (kb.matches(data, SAM_UI_KEYS.up)) {
			if (rows.length > 0) lv.cursor = (cur + rows.length - 1) % rows.length; // wraps (house)
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.down)) {
			if (rows.length > 0) lv.cursor = (cur + 1) % rows.length; // wraps (house)
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.pageUp) || kb.matches(data, SAM_UI_KEYS.pageDown)) {
			if (rows.length === 0) return;
			const step = Math.max(this.contentRows() - 1, 1);
			if (rows.length <= step) {
				lv.cursor = (cur + (kb.matches(data, SAM_UI_KEYS.pageDown) ? step : -step)) % rows.length;
			} else {
				// Spec-exact window shift (Paul: "scrolling up: the topmost
				// entry becomes the bottommost visible") — when the cursor is
				// at the edge of the window the whole window shifts by one row;
				// from the middle it moves by step (clamped inside the level).
				const vis = this.contentRows();
				const start =
					rows.length <= vis
						? 0
						: Math.min(Math.max(cur - Math.floor(vis / 2), 0), rows.length - vis);
				const lastVisible = Math.min(rows.length, start + vis) - 1;
				if (kb.matches(data, SAM_UI_KEYS.pageUp)) {
					lv.cursor = cur === start ? (start - 1 < 0 ? rows.length - 1 : start - 1) : Math.max(start, cur - step);
				} else {
					lv.cursor = cur === lastVisible ? (lastVisible + 1 >= rows.length ? 0 : lastVisible + 1) : Math.min(lastVisible, cur + step);
				}
			}
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.cancel) || kb.matches(data, "tui.editor.cursorLeft")) {
			if (this.levels.length > 1) {
				this.levels.pop(); // back to the parent level (its cursor is intact)
				return;
			}
			this.closed = true;
			this.onDone({ kind: "closed" });
			return;
		}
		if (kb.matches(data, SAM_UI_KEYS.confirm) || kb.matches(data, "tui.editor.cursorRight")) {
			const r = rows[cur];
			if (r === undefined) return; // empty level: nothing to open
			if (r.kind === "subtree") {
				this.pushSubtreeLevel(r); // ENTER pushes the SUBTREE level (v0.0.42)
			} else {
				this.openRow(r);
			}
		}
	}

	/** ENTER on a TREE row (a carrier's second row, or the carrier-less
	 * "dropped" row): push the subtree's rows as a navigable level — the
	 * cursor starts at its top (the parent's cursor is kept in the stack). */
	private pushSubtreeLevel(row: SamReportRow): void {
		let rows: SamReportRow[] = [];
		let title: string;
		if (row.subtreeKey !== undefined) {
			rows = this.model.board.orphanRuns.find((s) => s.key === row.subtreeKey)?.rows ?? [];
			title = `older orphans (${rows.length})`;
		} else if (row.unitId !== undefined) {
			rows = this.model.board.subtrees.find((s) => s.unitId === row.unitId)?.rows ?? [];
			title = `unit ${row.unitId} — subtree (${rows.length} row${rows.length === 1 ? "" : "s"})`;
		} else {
			rows = this.model.board.droppedRows;
			title = `dropped units (${rows.length})`;
		}
		if (rows.length === 0) return; // nothing to navigate (fail safe)
		this.levels.push({ rows, cursor: 0, title });
	}

	private openRow(row: SamReportRow): void {
		// v0.0.42: unit/orphan/goal rows open their DETAIL (the lazy
		// callback); TREE rows push their subtree level instead (the
		// children are navigable rows, not indented text — the matryoshka
		// nests via the nested carrier's own entry + tree rows).
		const body = this.model.detail(row);
		if (body === undefined) return; // nothing to show (e.g. in-flight, no audit yet)
		this.detail = { row, body };
		this.detailScroll = 0; // the detail starts at the TOP (the title line)
		this.mdCache = undefined; // the new detail's markdown is not rendered yet
	}

	invalidate(): void {
		this.mdCache = undefined; // a resize re-renders the markdown at the new width
	}
}

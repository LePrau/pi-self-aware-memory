/**
 * SAM report UI (v0.0.40 — report v2) — pins:
 *  - visibleListRows: the window math (60%/10 floor, the small-available
 *    reserve — ≥ 2 rows for model output when available < 10);
 *  - buildReportBoard: the pure row model — the main list is the LIVE units
 *    (retired/absorbed units leave it), each retirement unit at its creation
 *    spot, orphans merged chronologically, the goal row last; one subtree per
 *    retirement unit (nested matryoshka included, latest-wins), the
 *    carrier-less drops in a single "dropped (…)" row;
 *  - SamReportView: the state machine — the windowed render, the bottom
 *    initial cursor, up/down, PgUp/PgDown (the spec-exact edge shift),
 *    subtree navigation (push/pop, per-level cursors), the dropped level,
 *    the detail open/close — driven through a fake Keybindings.
 *
 * The view is the house TUI pattern of settings-ui.ts (structural typing,
 * no pi-tui import); the test exercises it exactly as pi's ctx.ui.custom
 * would: render(width) lines + handleInput(keyId). The fake `getRows`
 * stands in for pi's live `tui.terminal.rows`.
 */
import assert from "node:assert";
import { test } from "node:test";
import {
	buildReportBoard,
	reportRowVerdict,
	SamReportView,
	visibleListRows,
	type SamReportBoard,
	type SamReportModel,
	type SamReportRow,
} from "../src/report-ui.ts";
import type { SamKeybindings } from "../src/settings-ui.ts";
import type { LedgerVerdict, SamUnit } from "../src/ledger.ts";
import type { SamGoalRecord } from "../src/goal.ts";
import type { AutoRetireAction, RetireLedgerEntry } from "../src/retire.ts";

/** The fake keybinding manager: handleInput is called with the key id itself. */
function fakeKeybindings(): SamKeybindings {
	return {
		matches: (data: string, keyId: string) => data === keyId,
		getKeys: (keyId: string) => [keyId],
	};
}

function unit(n: number, state: SamUnit["state"], stub: string, verdictClass?: LedgerVerdict["class"]): SamUnit {
	return {
		unitId: n,
		stub,
		state,
		verdict: verdictClass !== undefined ? { class: verdictClass } : undefined,
	};
}

function fixtureUnits(): SamUnit[] {
	return [
		unit(1, "folded", "did A\nsecond line", "VERIFIED"),
		unit(2, "in-flight", "did B"),
		unit(3, "refused", "did C", "PLAUSIBLE"),
	];
}

/** n plain units u1..un */
function manyUnits(n: number, verdictClass: LedgerVerdict["class"] = "VERIFIED"): SamUnit[] {
	return Array.from({ length: n }, (_, i) => unit(i + 1, "folded", `stub ${i + 1}`, verdictClass));
}

const FIXTURE_GOAL: SamGoalRecord = { v: 1, kind: "goal", text: "GOAL line one\nGOAL line two", ts: 5, basis: "model" };

function autoRetire(unitId: number, units: number[], folded: string, absorbed?: { retrievalId: string; unitId: number; units: number[] }): AutoRetireAction {
	return {
		v: 1,
		kind: "autoRetire",
		ts: unitId,
		foldId: folded,
		unitId,
		retrievalId: `ret${unitId}ret${unitId}`,
		units,
		items: units.map((u) => ({ unitId: u, retrievalId: `retu${u}retu${u}`, verdictClass: "PLAUSIBLE" })),
		absorbed,
	};
}

/** Build a view over a fixed board (the fake terminal is `rows` lines tall). */
function makeView(board: SamReportBoard, detailCalls: { rows: SamReportRow[] }, rows: number): SamReportView {
	const model: SamReportModel = {
		board,
		detail: (row) => {
			detailCalls.rows.push(row);
			if (row.kind === "goal") return { title: "goal detail", lines: ["GOAL line one", "GOAL line two"] };
			return { title: `detail ${row.label}`, lines: [`stub body for ${row.label}`] };
		},
	};
	return new SamReportView(fakeKeybindings(), model, () => {}, () => rows);
}

/** The list row lines of a render (the `  > …` / `    …` body lines). */
function rowLines(lines: string[]): string[] {
	return lines.filter((l) => /^ {2}[> ] /.test(l) && !l.includes("move ·"));
}

/** True if a unit label appears as the label of some visible row. */
function hasLabel(lines: string[], label: string): boolean {
	return rowLines(lines).some((l) => {
		const m = l.match(/^ {2}[> ] (\S+)/);
		return m !== null && m[1] === label;
	});
}

// ── visibleListRows — the window math ──────────────────────────────────────

test("window: visibleListRows — 60% of the terminal rows, 10-row floor (above the small-available boundary)", () => {
	assert.equal(visibleListRows(40), 24); // 0.6 × 40
	assert.equal(visibleListRows(15), 10); // 0.6 × 15 = 9 → the 10-row floor (available = exactly 10)
	assert.equal(visibleListRows(100), 60);
});

test("window: small available space (< 10 rows) reserves ≥ 2 rows for model output", () => {
	// available = rows − DOCK_RESERVE(5): rows 10 → available 5 → visible 5−2 = 3
	assert.equal(visibleListRows(10), 3);
	// rows 12 → available 7 → visible 5; rows 14 → available 9 → visible 7
	assert.equal(visibleListRows(12), 5);
	assert.equal(visibleListRows(14), 7);
	// the boundary: rows 15 → available 10 → the normal rule applies (10)
	assert.equal(visibleListRows(15), 10);
});

// ── buildReportBoard — the pure row model ───────────────────────────────────

test("board: empty input → no rows, plain header, no subtrees", () => {
	const board = buildReportBoard({ units: [], orphanRows: [], retirements: [] });
	assert.equal(board.header, "SAM report — 0 units");
	assert.deepEqual(board.rows, []);
	assert.deepEqual(board.subtrees, []);
	assert.deepEqual(board.droppedRows, []);
});

test("board: units ascending (oldest on top), verdict in the row, stub first line", () => {
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements: [] });
	assert.equal(board.header, "SAM report — 3 units");
	assert.deepEqual(board.rows.map((r) => r.label), ["u1", "u2", "u3"]);
	assert.equal(board.rows[0].verdict, "VERIFIED");
	assert.equal(board.rows[0].stubLine, "did A");
	assert.equal(board.rows[1].verdict, "awaiting audit");
	assert.equal(board.rows[2].verdict, "PLAUSIBLE");
});

test("board: current goal is the last row, first line of the goal in the verdict slot", () => {
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements: [], goal: FIXTURE_GOAL });
	const last = board.rows[board.rows.length - 1];
	assert.equal(last.kind, "goal");
	assert.equal(last.label, "current goal");
	assert.equal(last.verdict, "GOAL line one");
	assert.equal(board.header, "SAM report — 3 units · goal on file");
});

test("board: orphan rows are merged CHRONOLOGICALLY at their unitId position", () => {
	const board = buildReportBoard({
		units: [unit(1, "folded", "did A"), unit(3, "folded", "did C")],
		orphanRows: [{ unitId: 2, retrievalId: "abc123def456", stubLine: "orphan span line" }],
		retirements: [],
	});
	assert.equal(board.header, "SAM report — 3 units · 1 orphaned");
	assert.deepEqual(board.rows.map((r) => r.label), ["u1", "u2", "u3"]);
	const o = board.rows[1];
	assert.equal(o.kind, "orphan");
	assert.equal(o.verdict, "orphaned (unaudited)");
	assert.equal(o.retrievalId, "abc123def456");
	assert.equal(o.stubLine, "orphan span line");
});

test("board: an orphan whose id is already a ledger unit gets no row (id consumed elsewhere)", () => {
	const board = buildReportBoard({
		units: fixtureUnits(),
		orphanRows: [{ unitId: 1, retrievalId: "abc123def456" }],
		retirements: [],
	});
	assert.equal(board.header, "SAM report — 3 units");
	assert.deepEqual(board.rows.map((r) => r.label), ["u1", "u2", "u3"]);
});

test("board: the retirement unit sits in the main list at its CREATION SPOT; the retired units are gone from it", () => {
	const units = manyUnits(7);
	const retirements: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 1, superseded: [1, 3], supersededBy: 6, dropped: [] }];
	const board = buildReportBoard({ units, orphanRows: [], retirements });
	assert.equal(board.header, "SAM report — 7 units · 2 retired");
	assert.deepEqual(board.rows.map((r) => r.label), ["u2", "u4", "u5", "u6", "u7"]);
	const carrier = board.rows[3];
	assert.equal(carrier.kind, "retirement");
	assert.equal(carrier.unitId, 6);
	assert.equal(carrier.stubLine, "▸ u1, u3"); // its direct children in the stub slot
	const sub = board.subtrees.find((s) => s.unitId === 6);
	assert.ok(sub !== undefined, "the carrier owns a subtree");
	assert.deepEqual(sub!.rows.map((r) => r.label), ["u1 → u6", "u3 → u6"]);
});

test("board: the auto-retire matryoshka nests — the absorbed auto-retire unit sits INSIDE the later one's subtree as an expandable row", () => {
	const units = [...manyUnits(5), ...manyUnits(2).map((u) => ({ ...u, unitId: u.unitId + 9 }))]; // u1..u5, u10, u11
	const a1 = autoRetire(10, [1, 2], "f1");
	const a2 = autoRetire(11, [3, 4], "f2", { retrievalId: a1.retrievalId, unitId: a1.unitId, units: a1.units });
	const board = buildReportBoard({ units, orphanRows: [], retirements: [a1, a2] });
	assert.equal(board.header, "SAM report — 7 units · 5 retired"); // 4 auto-retired + the absorbed u10
	// u1..u4 are auto-retired, u10 is ABSORBED (rides in u11's block) — none in the main list
	assert.deepEqual(board.rows.map((r) => r.label), ["u5", "u11"]);
	const sub11 = board.subtrees.find((s) => s.unitId === 11);
	assert.ok(sub11 !== undefined);
	assert.deepEqual(sub11!.rows.map((r) => r.label), ["u3 dropped", "u4 dropped", "u10 absorbed"]);
	assert.equal(sub11!.rows[2].kind, "retirement"); // the matryoshka is expandable
	const sub10 = board.subtrees.find((s) => s.unitId === 10);
	assert.ok(sub10 !== undefined);
	assert.deepEqual(sub10!.rows.map((r) => r.label), ["u1 dropped", "u2 dropped"]);
});

test("board: a retirement unit retired by a LATER manual retire nests under the later carrier", () => {
	const units = [unit(1, "folded", "stub 1", "VERIFIED"), unit(6, "folded", "stub 6", "PLAUSIBLE"), unit(9, "folded", "stub 9", "PLAUSIBLE")];
	const retirements: RetireLedgerEntry[] = [
		{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 6, dropped: [] },
		{ v: 1, kind: "retire", ts: 2, superseded: [6], supersededBy: 9, dropped: [] },
	];
	const board = buildReportBoard({ units, orphanRows: [], retirements });
	assert.equal(board.header, "SAM report — 3 units · 2 retired");
	assert.deepEqual(board.rows.map((r) => r.label), ["u9"]);
	assert.equal(board.rows[0].kind, "retirement");
	const sub9 = board.subtrees.find((s) => s.unitId === 9);
	assert.ok(sub9 !== undefined);
	assert.deepEqual(sub9!.rows.map((r) => r.label), ["u6 → u9"]);
	assert.equal(sub9!.rows[0].kind, "retirement"); // nested expandable row
	const sub6 = board.subtrees.find((s) => s.unitId === 6);
	assert.ok(sub6 !== undefined);
	assert.deepEqual(sub6!.rows.map((r) => r.label), ["u1 → u6"]);
});

test("board: latest-wins — an UN-RETIED unit returns to the main list and leaves its carrier's subtree", () => {
	const units = [unit(1, "folded", "did A", "VERIFIED"), unit(6, "folded", "stub 6", "PLAUSIBLE")];
	const retirements: RetireLedgerEntry[] = [
		{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 6, dropped: [] },
		{ v: 1, kind: "unretire", ts: 2, units: [1] },
	];
	const board = buildReportBoard({ units, orphanRows: [], retirements });
	assert.equal(board.header, "SAM report — 2 units");
	assert.deepEqual(board.rows.map((r) => r.label), ["u1", "u6"]);
	assert.equal(board.rows[0].kind, "unit");
	const carrier = board.rows[1];
	assert.equal(carrier.kind, "retirement");
	assert.equal(carrier.stubLine, "stub 6"); // no visible children → the carrier's own stub line
	assert.equal(board.subtrees.find((s) => s.unitId === 6)!.rows.length, 0);
});

test("board: a carrier's dropped children ride in its subtree (annotated); only CARRIER-LESS drops get the dropped row", () => {
	const units = manyUnits(6);
	const retirements: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 6, dropped: [2] }];
	const board = buildReportBoard({ units, orphanRows: [], retirements });
	assert.equal(board.header, "SAM report — 6 units · 2 retired");
	assert.deepEqual(board.rows.map((r) => r.label), ["u3", "u4", "u5", "u6"]);
	const sub = board.subtrees.find((s) => s.unitId === 6);
	assert.ok(sub !== undefined);
	assert.deepEqual(sub!.rows.map((r) => r.label), ["u1 → u6", "u2 dropped"]);
	assert.deepEqual(board.droppedRows, []); // u2 has a carrier — no dropped row
});

test("board: units dropped WITHOUT a carrier collapse into the single 'dropped (…)' row", () => {
	const units = manyUnits(3);
	const retirements: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 1, superseded: [], supersededBy: undefined, dropped: [2] }];
	const board = buildReportBoard({ units, orphanRows: [], retirements });
	assert.equal(board.header, "SAM report — 3 units · 1 retired");
	assert.deepEqual(board.rows.map((r) => r.label), ["u1", "u3", "dropped (u2)"]);
	assert.equal(board.rows[2].kind, "retirement");
	assert.equal(board.rows[2].verdict, "1 dropped (no carrier)");
	assert.deepEqual(board.droppedRows.map((r) => r.label), ["u2 dropped"]);
	assert.equal(board.droppedRows[0].stubLine, "stub 2");
});

test("rowVerdict: states without a verdict map to the short texts", () => {
	assert.equal(reportRowVerdict(unit(1, "in-flight", "s")), "awaiting audit");
	assert.equal(reportRowVerdict(unit(1, "folded", "s")), "folded");
	assert.equal(reportRowVerdict(unit(1, "refused", "s")), "refused");
	assert.equal(reportRowVerdict(unit(1, "undone", "s")), "undone");
	assert.equal(reportRowVerdict(unit(1, "resolved", "s")), "resolved");
	assert.equal(reportRowVerdict(unit(1, "folded", "s", "UNVERIFIED-AUDIT-FAILED")), "UNVERIFIED-AUDIT-FAILED");
});

// ── SamReportView — the state machine ───────────────────────────────────────

test("view: the CURSOR STARTS AT THE BOTTOM — on the goal row (below the newest close)", () => {
	const board = buildReportBoard({ units: manyUnits(5), orphanRows: [], retirements: [], goal: FIXTURE_GOAL });
	const view = makeView(board, { rows: [] }, 40);
	assert.ok(view.render(100).some((l) => l.startsWith("  > current goal")));
	const bare = buildReportBoard({ units: manyUnits(5), orphanRows: [], retirements: [] });
	const view2 = makeView(bare, { rows: [] }, 40);
	assert.ok(view2.render(100).some((l) => l.startsWith("  > u5")));
});

test("view: the list is WINDOWED — only `visible` rows render, the window pinned at the list end", () => {
	// 30 units + goal = 31 rows; terminal 40 → visible = max(0.6×40, 10) = 24.
	// Cursor at the bottom (goal) → the window pins there: rows 7..30.
	const board = buildReportBoard({ units: manyUnits(30), orphanRows: [], retirements: [], goal: FIXTURE_GOAL });
	const view = makeView(board, { rows: [] }, 40);
	const lines = view.render(100);
	const body = rowLines(lines);
	assert.equal(body.length, 24, "the full window renders (pinned at the bottom: start = 31 − 24 = 7)");
	assert.ok(lines.some((l) => l.startsWith("  > current goal")));
	assert.ok(hasLabel(lines, "u8"), "u8 is the first visible row (row 7)");
	assert.ok(!hasLabel(lines, "u1"), "u1 is outside the window");
	assert.ok(!hasLabel(lines, "u7"), "u7 is outside the window");
	assert.equal(lines[0], board.header);
	assert.equal(lines[1], "");
	assert.ok(lines.at(-1)!.includes("move ·"), "the key hint is the last line");
});

test("view: a SMALL terminal (available < 10) reserves ≥ 2 rows for model output", () => {
	const board = buildReportBoard({ units: manyUnits(10), orphanRows: [], retirements: [] });
	// terminal 10 → available = 10 − 5 = 5 < 10 → visible = 5 − 2 = 3
	const view = makeView(board, { rows: [] }, 10);
	assert.equal(rowLines(view.render(100)).length, 3);
	// terminal 14 → available 9 → visible 7
	const view2 = makeView(board, { rows: [] }, 14);
	assert.equal(rowLines(view2.render(100)).length, 7);
	// terminal 15 → available 10 → the normal rule: visible = max(9, 10) = 10
	const view3 = makeView(board, { rows: [] }, 15);
	assert.equal(rowLines(view3.render(100)).length, 10);
});

test("view: up/down wrap the cursor (per level)", () => {
	const board = buildReportBoard({ units: manyUnits(3), orphanRows: [], retirements: [] });
	const view = makeView(board, { rows: [] }, 40);
	// the cursor starts at the bottom (u3)
	assert.ok(view.render(100).some((l) => l.startsWith("  > u3")));
	view.handleInput("tui.select.up");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u2")));
	view.handleInput("tui.select.up");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1")));
	// up from the first wraps to the last
	view.handleInput("tui.select.up");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u3")));
	// down from the last wraps to the first
	view.handleInput("tui.select.down");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1")));
});

test("view: PgDown from the bottom edge WRAPS to the top; from the middle it steps by visible−1 (clamped)", () => {
	// 12 units, terminal 20 → visible = max(12, 10) = 12 = exactly the list:
	// the whole list renders, the cursor sits on the last row (the list end).
	const board = buildReportBoard({ units: manyUnits(12), orphanRows: [], retirements: [] });
	const view = makeView(board, { rows: [] }, 20);
	const r0 = view.render(100);
	assert.equal(rowLines(r0).length, 12);
	assert.ok(r0.some((l) => l.startsWith("  > u12")));
	view.handleInput("tui.select.pageDown");
	// at the list end: past the bottom → wrap to the top
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1")));
	// from the middle: step = visible − 1 = 11 — from u6 → clamped at u12
	for (let i = 0; i < 5; i++) view.handleInput("tui.select.down"); // u1 → u6
	view.handleInput("tui.select.pageDown");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u12")));
});

test("view: PgUp — scrolls by visible−1 (24 − 1 = 23): from the bottom it lands on the topmost visible entry, then on u1, then wraps at the list top", () => {
	// 30 units (no goal), terminal 40 → visible 24. Cursor at the bottom (u30):
	// window = rows 6..30 (start = 30 − 24 = 6) — the TOPMOST visible entry is u7.
	const board = buildReportBoard({ units: manyUnits(30), orphanRows: [], retirements: [] });
	const view = makeView(board, { rows: [] }, 40);
	let lines = view.render(100);
	assert.ok(lines.some((l) => l.startsWith("  > u30")));
	assert.ok(hasLabel(lines, "u7"), "u7 is the topmost visible row");
	// PgUp: 30 − 23 → clamped to the window start (u7)
	view.handleInput("tui.select.pageUp");
	lines = view.render(100);
	assert.ok(lines.some((l) => l.startsWith("  > u7")));
	assert.ok(hasLabel(lines, "u1"), "the window pinned at the list top: u1 is now topmost");
	// PgUp again: clamped to the window start (u1)
	view.handleInput("tui.select.pageUp");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1")));
	// at the list top: past the top → wrap to the bottom
	view.handleInput("tui.select.pageUp");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u30")));
});

test("view: a retirement row opens its SUBTREE; esc goes back (cursor preserved); esc on the main list closes the menu", () => {
	const units = manyUnits(7);
	const retirements: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 1, superseded: [1, 3], supersededBy: 6, dropped: [] }];
	const board = buildReportBoard({ units, orphanRows: [], retirements });
	let closed = 0;
	const model: SamReportModel = {
		board,
		detail: (row) => ({ title: `detail ${row.label}`, lines: [`stub body for ${row.label}`] }),
	};
	const view = new SamReportView(fakeKeybindings(), model, () => {
		closed += 1;
	}, () => 40);
	// the cursor starts at the bottom (u7) — move to the carrier u6
	view.handleInput("tui.select.up");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u6")));
	view.handleInput("tui.select.confirm"); // → the carrier's subtree
	assert.ok(view.render(100)[0].startsWith("SAM report — subtree of u6"));
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1 → u6")), "the subtree cursor starts at its first row");
	view.handleInput("tui.select.down"); // cursor → u3
	assert.ok(view.render(100).some((l) => l.startsWith("  > u3 → u6")));
	// esc back to the main list (the main cursor is still on u6)
	view.handleInput("tui.select.cancel");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u6")));
	// esc on the main list closes the menu
	view.handleInput("tui.select.cancel");
	assert.equal(closed, 1);
});

test("view: NESTED subtrees — from the matryoshka you descend into the absorbed auto-retire unit, and back-nav restores each level's cursor", () => {
	const units = [...manyUnits(5), ...manyUnits(2).map((u) => ({ ...u, unitId: u.unitId + 9 }))]; // u1..u5, u10, u11
	const a1 = autoRetire(10, [1, 2], "f1");
	const a2 = autoRetire(11, [3, 4], "f2", { retrievalId: a1.retrievalId, unitId: a1.unitId, units: a1.units });
	const board = buildReportBoard({ units, orphanRows: [], retirements: [a1, a2] });
	const model: SamReportModel = {
		board,
		detail: (row) => ({ title: `detail ${row.label}`, lines: [`stub body for ${row.label}`] }),
	};
	const view = new SamReportView(fakeKeybindings(), model, () => {}, () => 40);
	// the cursor starts at the bottom (u11)
	view.handleInput("tui.select.confirm"); // → u11's subtree
	assert.ok(view.render(100)[0].startsWith("SAM report — subtree of u11"));
	assert.ok(view.render(100).some((l) => l.startsWith("  > u3 dropped")));
	// to the matryoshka row (u10 absorbed — the last)
	view.handleInput("tui.select.down");
	view.handleInput("tui.select.down");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u10 absorbed")));
	view.handleInput("tui.select.confirm"); // → u10's subtree (nested)
	assert.ok(view.render(100)[0].startsWith("SAM report — subtree of u10"));
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1 dropped")));
	// back: the u11 level's cursor is PRESERVED on u10 absorbed
	view.handleInput("tui.select.cancel");
	assert.ok(view.render(100)[0].startsWith("SAM report — subtree of u11"));
	assert.ok(view.render(100).some((l) => l.startsWith("  > u10 absorbed")));
	// back again: the main list's cursor is preserved on u11
	view.handleInput("tui.select.cancel");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u11")));
});

test("view: the 'dropped (…)' row opens the dropped level", () => {
	const units = manyUnits(3);
	const retirements: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 1, superseded: [], supersededBy: undefined, dropped: [2] }];
	const board = buildReportBoard({ units, orphanRows: [], retirements });
	const model: SamReportModel = {
		board,
		detail: (row) => ({ title: `detail ${row.label}`, lines: [`stub body for ${row.label}`] }),
	};
	const view = new SamReportView(fakeKeybindings(), model, () => {}, () => 40);
	// the cursor starts at the bottom — on the dropped row
	assert.ok(view.render(100).some((l) => l.startsWith("  > dropped (u2)")));
	view.handleInput("tui.select.confirm");
	assert.ok(view.render(100)[0].startsWith("SAM report — dropped units (no carrier)"));
	assert.ok(view.render(100).some((l) => l.startsWith("  > u2 dropped")));
	// the dropped unit opens its detail; back returns to the dropped level
	view.handleInput("tui.select.confirm");
	assert.ok(view.render(100).some((l) => l.startsWith("  detail u2 dropped")));
	view.handleInput("tui.select.cancel");
	assert.ok(view.render(100)[0].startsWith("SAM report — dropped units (no carrier)"));
	view.handleInput("tui.select.cancel"); // back to the main list
	assert.ok(view.render(100).some((l) => l.startsWith("  > dropped (u2)")));
});

test("view: enter/right opens the detail; enter, esc, and left all close it (cursor preserved, per level)", () => {
	const board = buildReportBoard({ units: manyUnits(5), orphanRows: [], retirements: [] });
	const calls: { rows: SamReportRow[] } = { rows: [] };
	const view = makeView(board, calls, 40);
	view.handleInput("tui.select.up"); // u4
	view.handleInput("tui.select.confirm");
	let lines = view.render(100);
	assert.ok(lines.some((l) => l.startsWith("  detail u4")));
	assert.equal(calls.rows.length, 1);
	assert.equal(calls.rows[0].unitId, 4);
	// enter toggles the detail closed again
	view.handleInput("tui.select.confirm");
	lines = view.render(100);
	assert.ok(lines.some((l) => l.startsWith("  > u4")));
	// right opens
	view.handleInput("tui.editor.cursorRight");
	assert.ok(view.render(100).some((l) => l.startsWith("  detail u4")));
	// left closes
	view.handleInput("tui.editor.cursorLeft");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u4")));
	// enter opens, esc closes
	view.handleInput("tui.select.confirm");
	assert.ok(view.render(100).some((l) => l.startsWith("  detail u4")));
	view.handleInput("tui.select.cancel");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u4")));
});

test("view: from a SUBTREE, enter opens the unit's detail and closing returns to the SUBTREE (not the main list)", () => {
	const units = manyUnits(7);
	const retirements: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 1, superseded: [1, 3], supersededBy: 6, dropped: [] }];
	const board = buildReportBoard({ units, orphanRows: [], retirements });
	const model: SamReportModel = {
		board,
		detail: (row) => ({ title: `detail ${row.label}`, lines: [`stub body for ${row.label}`] }),
	};
	const view = new SamReportView(fakeKeybindings(), model, () => {}, () => 40);
	view.handleInput("tui.select.up"); // u6
	view.handleInput("tui.select.confirm"); // → subtree
	view.handleInput("tui.select.confirm"); // → detail for u1
	assert.ok(view.render(100).some((l) => l.startsWith("  detail u1 → u6")));
	view.handleInput("tui.select.cancel"); // back to the SUBTREE (not the main list)
	assert.ok(view.render(100)[0].startsWith("SAM report — subtree of u6"));
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1 → u6")));
});

test("view: a retirement row with NO visible children does not open (nothing to show)", () => {
	const units = [unit(1, "folded", "did A", "VERIFIED"), unit(6, "folded", "stub 6", "PLAUSIBLE")];
	const retirements: RetireLedgerEntry[] = [
		{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 6, dropped: [] },
		{ v: 1, kind: "unretire", ts: 2, units: [1] },
	];
	const board = buildReportBoard({ units, orphanRows: [], retirements });
	const model: SamReportModel = {
		board,
		detail: (row) => ({ title: `detail ${row.label}`, lines: [`stub body for ${row.label}`] }),
	};
	const view = new SamReportView(fakeKeybindings(), model, () => {}, () => 40);
	// the cursor starts at the bottom — already on u6 (rows: u1, u6)
	assert.ok(view.render(100).some((l) => l.startsWith("  > u6")));
	view.handleInput("tui.select.confirm");
	assert.ok(view.render(100)[0].startsWith("SAM report — 2 units"), "still on the main list");
});

test("view: the goal row opens the full goal text", () => {
	const board = buildReportBoard({ units: manyUnits(5), orphanRows: [], retirements: [], goal: FIXTURE_GOAL });
	const view = makeView(board, { rows: [] }, 40);
	// the cursor starts on the goal
	view.handleInput("tui.select.confirm");
	const lines = view.render(100);
	assert.ok(lines.some((l) => l.startsWith("  goal detail")));
	assert.ok(lines.some((l) => l.includes("GOAL line two")));
});

test("view: a row with no detail (callback undefined) does not open", () => {
	const board = buildReportBoard({ units: manyUnits(3), orphanRows: [], retirements: [] });
	const model: SamReportModel = {
		board,
		detail: () => undefined,
	};
	const view = new SamReportView(fakeKeybindings(), model, () => {}, () => 40);
	view.handleInput("tui.select.confirm");
	assert.ok(view.render(100)[0].startsWith("SAM report — 3 units"));
});

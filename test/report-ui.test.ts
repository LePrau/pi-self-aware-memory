/**
 * SAM report UI (v0.0.38) — pins:
 *  - buildReportBoard: the pure row model (ordering oldest→newest→goal,
 *    retirement row first, latest-wins retirements, orphan rows, verdict text);
 *  - SamReportView: the state machine (up/down cursor, enter/right open,
 *    left/esc/enter close the detail, esc closes the menu, the retired
 *    subtree, cursor preservation) — driven through a fake Keybindings.
 *
 * The view is the house TUI pattern of settings-ui.ts (structural typing,
 * no pi-tui import); the test exercises it exactly as pi's ctx.ui.custom
 * would: render(width) lines + handleInput(keyId).
 */
import assert from "node:assert";
import { test } from "node:test";
import {
	buildReportBoard,
	reportRowVerdict,
	SamReportView,
	type SamReportBoard,
	type SamReportModel,
	type SamReportRow,
} from "../src/report-ui.ts";
import type { SamKeybindings } from "../src/settings-ui.ts";
import type { LedgerVerdict, SamUnit } from "../src/ledger.ts";
import type { SamGoalRecord } from "../src/goal.ts";
import type { RetireLedgerEntry } from "../src/retire.ts";

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

const FIXTURE_GOAL: SamGoalRecord = { v: 1, kind: "goal", text: "GOAL line one\nGOAL line two", ts: 5, basis: "model" };

test("board: empty input → no rows, plain header", () => {
	const board = buildReportBoard({ units: [], orphanRows: [], retirements: [] });
	assert.equal(board.header, "SAM report — 0 units");
	assert.deepEqual(board.rows, []);
	assert.deepEqual(board.retiredRows, []);
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

test("board: retirement row first, latest-wins (unretire wins over retire), subtree rows annotated", () => {
	const retirements: RetireLedgerEntry[] = [
		{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 3, dropped: [2] },
		{ v: 1, kind: "unretire", ts: 2, units: [2] },
	];
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements, goal: FIXTURE_GOAL });
	assert.equal(board.rows[0].kind, "retirement");
	assert.equal(board.rows[0].label, "retirement (u1)");
	assert.equal(board.header, "SAM report — 3 units · 1 retired · goal on file");
	assert.deepEqual(
		board.retiredRows.map((r) => ({ label: r.label, verdict: r.verdict, stubLine: r.stubLine })),
		[{ label: "u1 → u3", verdict: "VERIFIED", stubLine: "did A" }],
	);
});

test("board: orphan rows after the units (unaudited), with the retrieval id", () => {
	const board = buildReportBoard({
		units: fixtureUnits(),
		orphanRows: [{ unitId: 4, retrievalId: "abc123def456", stubLine: "orphan span line" }],
		retirements: [],
	});
	assert.equal(board.header, "SAM report — 4 units · 1 orphaned");
	const last = board.rows[board.rows.length - 1];
	assert.equal(last.label, "u4");
	assert.equal(last.verdict, "orphaned (unaudited)");
	assert.equal(last.retrievalId, "abc123def456");
	assert.equal(last.stubLine, "orphan span line");
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

test("rowVerdict: states without a verdict map to the short texts", () => {
	assert.equal(reportRowVerdict(unit(1, "in-flight", "s")), "awaiting audit");
	assert.equal(reportRowVerdict(unit(1, "folded", "s")), "folded");
	assert.equal(reportRowVerdict(unit(1, "refused", "s")), "refused");
	assert.equal(reportRowVerdict(unit(1, "undone", "s")), "undone");
	assert.equal(reportRowVerdict(unit(1, "resolved", "s")), "resolved");
	assert.equal(reportRowVerdict(unit(1, "folded", "s", "UNVERIFIED-AUDIT-FAILED")), "UNVERIFIED-AUDIT-FAILED");
});

/** Build a view over a fixed board with a counting detail callback. */
function makeView(board: SamReportBoard, detailCalls: { rows: SamReportRow[] }): SamReportView {
	const model: SamReportModel = {
		board,
		detail: (row) => {
			detailCalls.rows.push(row);
			if (row.kind === "goal") return { title: "goal detail", lines: ["GOAL line one", "GOAL line two"] };
			return { title: `detail ${row.label}`, lines: [`stub body for ${row.label}`] };
		},
	};
	return new SamReportView(fakeKeybindings(), model, () => {});
}

test("view: list render — header, rows, cursor marker on the first row", () => {
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements: [], goal: FIXTURE_GOAL });
	const view = makeView(board, { rows: [] });
	const lines = view.render(100);
	assert.equal(lines[0], board.header);
	assert.ok(lines.some((l) => /^  > u1\s+VERIFIED/.test(l)));
	assert.ok(lines.some((l) => /^\s+u3\s+PLAUSIBLE/.test(l)));
	assert.ok(lines.some((l) => /^\s+current goal\s+GOAL line one/.test(l)));
});

test("view: up/down wrap the cursor", () => {
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements: [] });
	const view = makeView(board, { rows: [] });
	view.handleInput("tui.select.down");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u2")));
	view.handleInput("tui.select.down");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u3")));
	// 3 rows: down from the last wraps to the first
	view.handleInput("tui.select.down");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1")));
	view.handleInput("tui.select.up");
	// up from the first wraps to the last
	assert.ok(view.render(100).some((l) => l.startsWith("  > u3")));
});

test("view: enter/right opens the detail; enter, esc, and left all close it (cursor preserved)", () => {
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements: [] });
	const calls: { rows: SamReportRow[] } = { rows: [] };
	const view = makeView(board, calls);
	view.handleInput("tui.select.down"); // cursor on u2
	view.handleInput("tui.select.confirm");
	let lines = view.render(100);
	assert.ok(lines.some((l) => l.startsWith("  detail u2")));
	assert.equal(calls.rows.length, 1);
	assert.equal(calls.rows[0].unitId, 2);
	// enter toggles the detail closed again
	view.handleInput("tui.select.confirm");
	lines = view.render(100);
	assert.ok(lines.some((l) => l.startsWith("  > u2")));
	// right opens
	view.handleInput("tui.editor.cursorRight");
	assert.ok(view.render(100).some((l) => l.startsWith("  detail u2")));
	// left closes
	view.handleInput("tui.editor.cursorLeft");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u2")));
	// enter opens, esc closes
	view.handleInput("tui.select.confirm");
	assert.ok(view.render(100).some((l) => l.startsWith("  detail u2")));
	view.handleInput("tui.select.cancel");
	assert.ok(view.render(100).some((l) => l.startsWith("  > u2")));
});

test("view: the retirement row opens the subtree; esc goes back; esc on the top list closes the menu", () => {
	const retirements: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 3, dropped: [] }];
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements });
	let closed = 0;
	const model: SamReportModel = {
		board,
		detail: (row) => ({ title: `detail ${row.label}`, lines: [`stub body for ${row.label}`] }),
	};
	const view = new SamReportView(fakeKeybindings(), model, () => {
		closed += 1;
	});
	assert.ok(view.render(100)[0].includes("1 retired"));
	// open the retirement subtree (cursor starts on the retirement row)
	view.handleInput("tui.select.confirm");
	assert.ok(view.render(100)[0].startsWith("SAM report — retired units"));
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1 → u3")));
	// esc back to the top list (cursor still on the retirement row)
	view.handleInput("tui.select.cancel");
	assert.ok(view.render(100).some((l) => l.startsWith("  > retirement (u1)")));
	// esc on the top list closes the menu
	view.handleInput("tui.select.cancel");
	assert.equal(closed, 1);
});

test("view: from the subtree, enter opens the unit's detail and closing returns to the subtree", () => {
	const retirements: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 3, dropped: [] }];
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements });
	const model: SamReportModel = {
		board,
		detail: (row) => ({ title: `detail ${row.label}`, lines: [`stub body for ${row.label}`] }),
	};
	const view = new SamReportView(fakeKeybindings(), model, () => {});
	view.handleInput("tui.select.confirm"); // → subtree (u1 → u3 under the cursor)
	view.handleInput("tui.select.confirm"); // → detail for u1
	assert.ok(view.render(100).some((l) => l.startsWith("  detail u1 → u3")));
	view.handleInput("tui.select.cancel"); // back to the SUBTREE (not the top list)
	assert.ok(view.render(100)[0].startsWith("SAM report — retired units"));
	assert.ok(view.render(100).some((l) => l.startsWith("  > u1 → u3")));
});

test("view: the goal row opens the full goal text", () => {
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements: [], goal: FIXTURE_GOAL });
	const view = makeView(board, { rows: [] });
	// cursor to the last row (4 rows: u1..u3 + goal)
	view.handleInput("tui.select.down");
	view.handleInput("tui.select.down");
	view.handleInput("tui.select.down");
	assert.ok(view.render(100).some((l) => l.startsWith("  > current goal")));
	view.handleInput("tui.select.confirm");
	const lines = view.render(100);
	assert.ok(lines.some((l) => l.startsWith("  goal detail")));
	assert.ok(lines.some((l) => l.includes("GOAL line two")));
});

test("view: a row with no detail (callback undefined) does not open", () => {
	const board = buildReportBoard({ units: fixtureUnits(), orphanRows: [], retirements: [] });
	const model: SamReportModel = {
		board,
		detail: () => undefined,
	};
	const view = new SamReportView(fakeKeybindings(), model, () => {});
	view.handleInput("tui.select.confirm");
	assert.ok(view.render(100)[0].startsWith("SAM report — 3 units"));
});

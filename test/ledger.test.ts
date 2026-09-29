/**
 * Unit tests: append-only ledger reconstruction (crash-proof truth source).
 * Run: node --test test/
 *
 * Branches below mirror the real session shape: a close is always followed by
 * its close_unit toolResult (pi appends it after execute), so spans resolve
 * from the raw entries.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { rebuildLedger } from "../src/ledger.ts";
import { auditInstruction } from "../src/protocol.ts";
import { type PlainEntry } from "../src/projection.ts";

let n = 0;
const id = () => `e${++n}`;
const sam = (data: unknown): PlainEntry => ({ id: id(), kind: "custom", customType: "sam", data });
const otherCustom = (data: unknown): PlainEntry => ({ id: id(), kind: "custom", customType: "other", data });
const userMsg = (content: string): PlainEntry => ({ id: id(), kind: "message", message: { role: "user", content } });
const assistantMsg = (content: string): PlainEntry => ({
	id: id(),
	kind: "message",
	message: { role: "assistant", content, stopReason: "stop" },
});
const toolResultMsg = (toolCallId: string): PlainEntry => ({
	id: id(),
	kind: "message",
	message: { role: "toolResult", content: "ok", toolCallId, toolName: "close_unit", isError: false },
});
const closeData = (unitId: number, stub: string, toolCallId: string) => ({
	v: 1,
	kind: "close",
	unitId,
	stub,
	toolCallId,
	ts: unitId,
	mode: "manual",
});

/** The realistic branch around one close: task, work, close record, toolResult. */
function closeBranch(stub: string, unitId: number, toolCallId: string): PlainEntry[] {
	return [userMsg(`do thing ${unitId}`), assistantMsg("calling tool"), sam(closeData(unitId, stub, toolCallId)), toolResultMsg(toolCallId)];
}

test("empty branch → empty ledger, manual mode, nextUnitId 1", () => {
	n = 0;
	const l = rebuildLedger([]);
	assert.equal(l.mode, "manual");
	assert.equal(l.nextUnitId, 1);
	assert.deepEqual(l.units, []);
	assert.equal(l.malformedRecords, 0);
	assert.equal(l.auditInFlight, null);
	assert.equal(l.pendingCommits.length, 0);
	assert.equal(l.pendingReaudit.length, 0);
});

test("non-sam custom entries are ignored", () => {
	n = 0;
	const l = rebuildLedger([otherCustom({ anything: true })]);
	assert.equal(l.malformedRecords, 0);
	assert.equal(l.nextUnitId, 1);
});

test("unresolved close with no audit message → pendingReaudit (crash between settle and audit)", () => {
	n = 0;
	const l = rebuildLedger(closeBranch("did X", 1, "tc1"));
	assert.equal(l.pendingReaudit.length, 1);
	assert.equal(l.pendingReaudit[0].unitId, 1);
	assert.equal(l.auditInFlight, null);
	assert.equal(l.pendingCommits.length, 0);
});

test("close + audit message, no reply → auditInFlight (pi resumes that turn on reload)", () => {
	n = 0;
	const l = rebuildLedger([...closeBranch("did X", 1, "tc1"), userMsg(auditInstruction(1))]);
	assert.equal(l.auditInFlight?.unitId, 1);
	assert.equal(l.auditInFlight?.span.stub, "did X");
	assert.equal(l.pendingReaudit.length, 0);
});

test("close + audit + VERIFIED reply → pendingCommits with verdict and usage", () => {
	n = 0;
	const usage = { totalTokens: 1000, input: 900, output: 100, cacheRead: 0, cacheWrite: 0 };
	const l = rebuildLedger([
		...closeBranch("did X", 1, "tc1"),
		userMsg(auditInstruction(1)),
		assistantMsg("VERIFIED"),
		assistantMsg("x"), // earlier assistant, no usage — the window must take the LAST assistant
		assistantMsg("VERIFIED"), // last assistant wins
	]);
	assert.equal(l.pendingCommits.length, 1);
	const pc = l.pendingCommits[0];
	assert.equal(pc.unitId, 1);
	assert.equal(pc.verdict.class, "VERIFIED");
	assert.equal(pc.span.stub, "did X");

	// usage comes from the LAST assistant with usage
	const l2 = rebuildLedger([
		...closeBranch("did X", 1, "tc1"),
		userMsg(auditInstruction(1)),
		assistantMsg("VERIFIED"),
		{ ...assistantMsg("VERIFIED"), message: { role: "assistant", content: "VERIFIED", stopReason: "stop", usage } },
	]);
	assert.equal(l2.pendingCommits[0]?.usage?.totalTokens, 1000);
});

test("multiple unresolved closes → FIFO pendingCommits", () => {
	n = 0;
	const l = rebuildLedger([
		...closeBranch("s1", 1, "tc1"),
		userMsg(auditInstruction(1)),
		assistantMsg("VERIFIED"),
		...closeBranch("s2", 2, "tc2"),
		userMsg(auditInstruction(2)),
		assistantMsg("CORRECTIONS: wrong"),
	]);
	assert.equal(l.pendingCommits.length, 2);
	assert.deepEqual(l.pendingCommits.map((p) => p.unitId), [1, 2]);
	assert.equal(l.pendingCommits[1].verdict.class, "CORRECTIONS");
});

test("terminal fold record → folded unit with span, verdict, tokens", () => {
	n = 0;
	const u = userMsg("task");
	const tr = assistantMsg("result");
	const l = rebuildLedger([
		sam(closeData(1, "did X", "tc1")),
		tr,
		userMsg(auditInstruction(1)),
		assistantMsg("VERIFIED"),
		sam({
			v: 1,
			kind: "fold",
			unitId: 1,
			entryIds: [u.id, tr.id],
			spanFirstId: u.id,
			spanLastId: tr.id,
			stub: "did X",
			verdict: "VERIFIED",
			corrections: undefined,
			override: undefined,
			beforeTokens: 4242,
			usage: { totalTokens: 50, input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
			ts: 10,
			mode: "manual",
		}),
	]);
	assert.equal(l.units.length, 1);
	assert.equal(l.units[0].state, "folded");
	assert.deepEqual(l.units[0].entryIds, [u.id, tr.id]);
	assert.equal(l.units[0].beforeTokens, 4242);
	assert.equal(l.units[0].verdict?.class, "VERIFIED");
	assert.equal(l.pendingCommits.length, 0);
	assert.equal(l.nextUnitId, 2);
});

test("noFold record → refused unit with reason", () => {
	n = 0;
	const u = userMsg("task");
	const l = rebuildLedger([
		sam(closeData(1, "did X", "tc1")),
		u,
		userMsg(auditInstruction(1)),
		assistantMsg("CORRECTIONS: the stub lies"),
		sam({
			v: 1,
			kind: "noFold",
			unitId: 1,
			entryIds: [u.id],
			spanFirstId: u.id,
			spanLastId: u.id,
			stub: "did X",
			verdict: "CORRECTIONS",
			corrections: "the stub lies",
			reason: "verdict CORRECTIONS",
			ts: 11,
			mode: "manual",
		}),
	]);
	assert.equal(l.units[0].state, "refused");
	assert.equal(l.units[0].reason, "verdict CORRECTIONS");
	assert.equal(l.units[0].corrections, "the stub lies");
});

test("undo record → undone unit; mode record → mode restored; nextUnitId = max+1", () => {
	n = 0;
	const u = userMsg("task");
	const l = rebuildLedger([
		sam(closeData(5, "did X", "tc1")),
		u,
		userMsg(auditInstruction(5)),
		assistantMsg("VERIFIED"),
		sam({ v: 1, kind: "fold", unitId: 5, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "did X", verdict: "VERIFIED", ts: 12, mode: "manual" }),
		sam({ v: 1, kind: "undo", unitId: 5, targets: [u.id], ts: 13 }),
		sam({ v: 1, kind: "mode", mode: "display", ts: 14 }),
	]);
	assert.equal(l.units[0].state, "undone");
	assert.equal(l.mode, "display");
	assert.equal(l.nextUnitId, 6);
});

test("malformed records are counted and skipped, good records still apply", () => {
	n = 0;
	const u = userMsg("task");
	const l = rebuildLedger([
		{ id: id(), kind: "custom", customType: "sam", data: "garbage" },
		{ id: id(), kind: "custom", customType: "sam", data: { v: 1, kind: "nope" } },
		sam(closeData(1, "s", "tc")),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "s", verdict: "VERIFIED", ts: 1, mode: "manual" }),
	]);
	assert.equal(l.malformedRecords, 2);
	assert.equal(l.units.length, 1);
	assert.equal(l.units[0].state, "folded");
});

test("mode record stays in effect even if a later unit is folded", () => {
	n = 0;
	const u = userMsg("task");
	const l = rebuildLedger([
		sam({ v: 1, kind: "mode", mode: "display", ts: 1 }),
		sam(closeData(1, "s", "tc")),
		u,
		userMsg(auditInstruction(1)),
		assistantMsg("VERIFIED"),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "s", verdict: "VERIFIED", ts: 2, mode: "display" }),
	]);
	assert.equal(l.mode, "display");
	assert.equal(l.units[0].state, "folded");
});

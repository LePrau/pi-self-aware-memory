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

// P4 R1 (steer audit): the reply is answered IN THE TURN, and the model then
// RETURNS TO TASK. The capture must attribute the verdict, not the
// continuation (measured failure mode of "last assistant wins").
test("steer shape: VERIFIED + follow-up tool step + continuation → verdict captured (not the continuation)", () => {
	n = 0;
	const l = rebuildLedger([
		...closeBranch("did X", 1, "tc1"),
		userMsg(auditInstruction(1)),
		{
			...assistantMsg(""), // in-turn: model answers the audit with VERIFIED and keeps a tool step going
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "VERIFIED" },
					{ type: "toolCall", toolCallId: "tc2", name: "bash", arguments: { command: "echo r1-marathon-continues" } },
				],
				stopReason: "toolUse",
			},
		},
		{ ...toolResultMsg("2"), message: { role: "toolResult", content: "r1-marathon-continues", toolCallId: "tc2", toolName: "bash", isError: false } },
		assistantMsg("Done — the marathon continues."), // the model's return to task
	]);
	assert.equal(l.pendingCommits.length, 1);
	assert.equal(l.pendingCommits[0].verdict.class, "VERIFIED");
	assert.equal(l.auditInFlight, null);
});

test("steer shape: in-turn tool loop before the verdict still captures the verdict", () => {
	n = 0;
	const l = rebuildLedger([
		...closeBranch("did X", 1, "tc1"),
		userMsg(auditInstruction(1)),
		{
			...assistantMsg(""),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", toolCallId: "tc2", name: "bash", arguments: { command: "true" } }],
				stopReason: "toolUse",
			},
		},
		{ ...toolResultMsg("3"), message: { role: "toolResult", content: "", toolCallId: "tc2", toolName: "bash", isError: false } },
		assistantMsg("VERIFIED"),
	]);
	assert.equal(l.pendingCommits.length, 1);
	assert.equal(l.pendingCommits[0].verdict.class, "VERIFIED");
});

test("steer shape: no parseable verdict in the window → UNAUDITABLE from the last assistant (fallback kept)", () => {
	n = 0;
	const l = rebuildLedger([
		...closeBranch("did X", 1, "tc1"),
		userMsg(auditInstruction(1)),
		assistantMsg("garbled reply"),
		assistantMsg("Done with everything."),
	]);
	assert.equal(l.pendingCommits.length, 1);
	assert.equal(l.pendingCommits[0].verdict.class, "UNAUDITABLE");
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

/* ── P4 R3: the compaction-owned tombstone — terminal + invariants ──────── */

const CEILING_REASON = "ceiling: span 46914 tokens > fold ceiling 32768 tokens — left to native compaction (F5)";

test("R3: [noFold (ceiling), resolve (compaction-owned)] ⇒ resolved terminal, evidence kept (R3 invariants)", () => {
	const u = userMsg("do the marathon task");
	const ledger = rebuildLedger([
		u,
		sam(closeData(1, "did the marathon work", "tc1")),
		sam({
			v: 1, kind: "noFold", unitId: 1,
			entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "did the marathon work",
			verdict: "VERIFIED", reason: "ceiling", reasons: [CEILING_REASON],
			ts: 2, mode: "auto",
		}),
		sam({
			v: 1, kind: "resolve", unitId: 1, basis: "compaction-owned",
			spanFirstId: u.id, spanLastId: u.id, entryIds: [u.id], stub: "did the marathon work",
			verdict: "VERIFIED", gateReasons: [CEILING_REASON], ts: 3,
		}),
	]);
	const unit = ledger.units.find((x) => x.unitId === 1)!;
	assert.equal(unit.state, "resolved", "the tombstone is terminal — refused→resolved promotion on replay (F1)");
	assert.equal(unit.resolvedBasis, "compaction-owned");
	assert.equal(unit.verdict?.class, "VERIFIED");
	// the R3 invariants: the ledger preserves stub + entry ids
	assert.equal(unit.stub, "did the marathon work");
	assert.deepEqual(unit.entryIds, [u.id]);
	// the gate arithmetic stays on record as evidence
	assert.deepEqual(unit.gateReasons, [CEILING_REASON]);
});

test("R3: stand-alone resolve (gate-passing hypothetical) carries the evidence itself", () => {
	const u = userMsg("short task");
	const ledger = rebuildLedger([
		u,
		sam(closeData(2, "short stub", "tc2")),
		sam({
			v: 1, kind: "resolve", unitId: 2, basis: "compaction-owned",
			spanFirstId: u.id, spanLastId: u.id, entryIds: [u.id], stub: "short stub",
			verdict: "VERIFIED", gateReasons: [], ts: 5,
		}),
	]);
	const unit = ledger.units.find((x) => x.unitId === 2)!;
	assert.equal(unit.state, "resolved");
	assert.equal(unit.resolvedBasis, "compaction-owned");
	assert.equal(unit.verdict?.class, "VERIFIED");
	assert.equal(unit.stub, "short stub", "stand-alone tombstone is self-documenting");
	assert.deepEqual(unit.entryIds, [u.id]);
	assert.deepEqual(unit.gateReasons, [], "no gate rejection happened — evidence says so");
});

/* ── v4 (close-audit): the "close-audit" resolve basis (S5) ──────────────── */

import { parseSamRecord } from "../src/ledger.ts";

test("parseSamRecord: a resolve record with basis 'close-audit' is valid", () => {
	const rec = { v: 1, kind: "resolve", unitId: 4, basis: "close-audit", spanFirstId: "a", spanLastId: "b", entryIds: ["a"], stub: "s", verdict: "VERIFIED", gateReasons: [], ts: 1 };
	const parsed = parseSamRecord(rec);
	assert.ok(parsed);
	assert.equal(parsed?.kind, "resolve");
});

test("parseSamRecord: an unknown basis is still rejected (the union stays closed)", () => {
	const rec = { v: 1, kind: "resolve", unitId: 4, basis: "made-up-basis", ts: 1 };
	assert.equal(parseSamRecord(rec), undefined);
});

test("rebuildLedger: close + settlement + resolve(close-audit) ⇒ unit resolved, NOT pendingReaudit", () => {
	// v4 shape: the main line carries NO [sam-audit] message (the audit ran
	// on the fork) — just the close + its settlement + the close-audit resolve.
	const l = rebuildLedger([
		...closeBranch("did X", 1, "tc1"),
		{ id: "s1", kind: "custom", customType: "sam", data: { v: 1, kind: "settlement", unitId: 1, retrievalId: "abcd1234ef56", verdict: "VERIFIED", sections: {}, line: "abcd1234ef56 VERIFIED: fact", auditFile: "/f.jsonl", replyId: "r1", parsedClean: true, ts: 1 } },
		{ id: "z1", kind: "custom", customType: "sam", data: { v: 1, kind: "resolve", unitId: 1, basis: "close-audit", ts: 1 } },
	]);
	const unit = l.units.find((u) => u.unitId === 1);
	assert.ok(unit);
	assert.equal(unit.state, "resolved");
	assert.equal(unit.resolvedBasis, "close-audit");
	assert.equal(l.pendingReaudit.some((r) => r.unitId === 1), false);
	assert.equal(l.pendingCommits.some((r) => r.unitId === 1), false);
});

/**
 * Unit tests: unit-span resolution (the rules a fold may touch).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isSamInjected } from "../src/protocol.ts";
import { lastRealUserEntryIsFolded, resolveUnitSpan } from "../src/units.ts";
import { type PlainEntry } from "../src/projection.ts";

let n = 0;
const id = () => `e${++n}`;
const userMsg = (content: string): PlainEntry => ({ id: id(), kind: "message", message: { role: "user", content } });
const assistantMsg = (content: string): PlainEntry => ({
	id: id(),
	kind: "message",
	message: { role: "assistant", content, stopReason: "stop" },
});
const closeRecord = (unitId: number, stub: string, toolCallId: string): PlainEntry => ({
	id: id(),
	kind: "custom",
	customType: "sam",
	data: { v: 1, kind: "close", unitId, stub, toolCallId, ts: 0 },
});
const toolResultMsg = (toolCallId: string): PlainEntry => ({
	id: id(),
	kind: "message",
	message: { role: "toolResult", content: `Unit ${toolCallId} closed`, toolCallId, toolName: "close_unit", isError: false },
});
const auditUserMsg = (unitId: number): PlainEntry => userMsg(`[sam-audit] Unit ${unitId} ...`);
const verdictMsg = (text: string): PlainEntry => assistantMsg(text);

test("simple close: span = last real user message → last close toolResult", () => {
	n = 0;
	const u = userMsg("write data.txt with the count");
	const a = assistantMsg("toolCall read+write");
	const rec = closeRecord(1, "wrote data.txt", "tc1");
	const tr = toolResultMsg("tc1");
	const res = resolveUnitSpan([u, a, rec, tr], [{ unitId: 1, stub: "wrote data.txt", toolCallId: "tc1" }], new Set());
	assert.ok(res.ok, JSON.stringify(res));
	assert.equal(res.span.unitId, 1);
	assert.deepEqual(res.span.spanFirstId, u.id);
	assert.deepEqual(res.span.spanLastId, tr.id);
	assert.deepEqual(res.span.targetIds, [u.id, a.id, tr.id]);
	assert.deepEqual(res.span.entryIds, [u.id, a.id, rec.id, tr.id]);
});

test("overrun: two closes in one turn → last close wins, span reaches the last toolResult", () => {
	n = 0;
	const u = userMsg("do a and b");
	const a1 = assistantMsg("calls close_unit twice");
	const rec1 = closeRecord(1, "did a", "tc1");
	const tr1 = toolResultMsg("tc1");
	const rec2 = closeRecord(2, "did a and b", "tc2");
	const tr2 = toolResultMsg("tc2");
	const res = resolveUnitSpan([u, a1, rec1, tr1, rec2, tr2], [
		{ unitId: 1, stub: "did a", toolCallId: "tc1" },
		{ unitId: 2, stub: "did a and b", toolCallId: "tc2" },
	], new Set());
	assert.ok(res.ok, JSON.stringify(res));
	assert.equal(res.span.unitId, 2);
	assert.equal(res.span.stub, "did a and b");
	assert.deepEqual(res.span.targetIds, [u.id, a1.id, tr1.id, tr2.id]);
	assert.deepEqual(res.span.spanLastId, tr2.id);
});

test("no real user message → no-work (sam-injected user messages never open units, F4)", () => {
	n = 0;
	const injected = userMsg("[sam-audit] Unit 9 ...");
	const a = assistantMsg("VERIFIED");
	const rec = closeRecord(2, "stub", "tc");
	const tr = toolResultMsg("tc");
	const res = resolveUnitSpan([injected, a, rec, tr], [{ unitId: 2, stub: "stub", toolCallId: "tc" }], new Set());
	assert.deepEqual(res, { ok: false, error: "no-work" });
});

test("close whose toolResult is missing from the branch → no-tool-result", () => {
	n = 0;
	const u = userMsg("do X");
	const res = resolveUnitSpan([u], [{ unitId: 1, stub: "s", toolCallId: "tc" }], new Set());
	assert.deepEqual(res, { ok: false, error: "no-tool-result" });
});

test("close record without a toolResult → no-tool-result", () => {
	n = 0;
	const u = userMsg("do X");
	const rec = closeRecord(1, "s", "tc");
	const res = resolveUnitSpan([u, rec], [{ unitId: 1, stub: "s", toolCallId: "tc" }], new Set());
	assert.deepEqual(res, { ok: false, error: "no-tool-result" });
});

test("candidate span touching a folded span → already-closed (duplicate close across turns)", () => {
	n = 0;
	const u1 = userMsg("first task");
	const u2 = userMsg("second task");
	const rec = closeRecord(2, "did second", "tc2");
	const tr = toolResultMsg("tc2");
	// unit 1's fold covered entries up to u1's era; u2 is AFTER, but the
	// new span starts at u2 — not folded. Add a folded id inside the span:
	const folded = new Set([u2.id]);
	const res = resolveUnitSpan([u1, u2, rec, tr], [{ unitId: 2, stub: "did second", toolCallId: "tc2" }], folded);
	assert.deepEqual(res, { ok: false, error: "already-closed" });
});

test("clean span with folded entries elsewhere → ok", () => {
	n = 0;
	const u1 = userMsg("first");
	const tr1 = toolResultMsg("tc1");
	const u2 = userMsg("second");
	const a2 = assistantMsg("working");
	const rec = closeRecord(2, "second done", "tc2");
	const tr2 = toolResultMsg("tc2");
	const folded = new Set([u1.id, tr1.id]);
	const res = resolveUnitSpan([u1, tr1, u2, a2, rec, tr2], [{ unitId: 2, stub: "second done", toolCallId: "tc2" }], folded);
	assert.ok(res.ok, JSON.stringify(res));
	assert.equal(res.span.unitId, 2);
	assert.deepEqual(res.span.spanFirstId, u2.id);
});

test("audit exchange after the close sits outside the span (visible trail)", () => {
	n = 0;
	const u = userMsg("do X");
	const a = assistantMsg("call");
	const rec = closeRecord(1, "did X", "tc1");
	const tr = toolResultMsg("tc1");
	const au = auditUserMsg(1);
	const av = verdictMsg("VERIFIED");
	const res = resolveUnitSpan([u, a, rec, tr, au, av], [{ unitId: 1, stub: "did X", toolCallId: "tc1" }], new Set());
	assert.ok(res.ok);
	assert.equal(res.span.spanLastId, tr.id);
	assert.ok(!res.span.entryIds.includes(au.id));
	assert.ok(!res.span.entryIds.includes(av.id));
});

test("lastRealUserEntryIsFolded: guards against a close after the last real message is folded", () => {
	n = 0;
	const u1 = userMsg("first");
	const u2 = userMsg("second");
	assert.equal(lastRealUserEntryIsFolded([u1, u2], new Set([u1.id])), false);
	assert.equal(lastRealUserEntryIsFolded([u1, u2], new Set([u2.id])), true);
	// only sam-injected user messages → no real user message → false (no-work path elsewhere)
	const onlyInjected = [userMsg("[sam-internal] ack"), userMsg("[sam-audit] x")];
	assert.equal(lastRealUserEntryIsFolded(onlyInjected, new Set()), false);
	// isSamInjected sanity
	assert.equal(isSamInjected("[sam-audit] Unit 1"), true);
	assert.equal(isSamInjected("do X"), false);
});

/* ── v4 (close-audit): close-to-close spans (v4-plan §4) ─────────────────── */

import { closeCandidateSpanOk, resolveCloseUnitSpan } from "../src/units.ts";

/** The measured pi 0.87.1 shape (probe bank r2): assistant entries carry no
 * message-level toolCallId — the close call is a content block named
 * close_unit (that is what spanHasNewWork must recognize as self-noise). */
const closeCallAssistant = (stub: string): PlainEntry =>
	({
		id: id(),
		kind: "message",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "done" }, { type: "toolCall", name: "close_unit", arguments: { stub } }], stopReason: "toolUse" },
	} as unknown) as PlainEntry;

test("v4: two closes in one turn ⇒ disjoint close-to-close spans (unit 1 opener→rec1, unit 2 after tr1→rec2)", () => {
	n = 0;
	const u = userMsg("do a, then do b");
	const a1 = assistantMsg("work a; toolCall close_unit");
	const rec1 = closeRecord(1, "did a", "tc1");
	const tr1 = toolResultMsg("tc1");
	const a2 = assistantMsg("work b");
	const a2b = assistantMsg("toolCall close_unit");
	const rec2 = closeRecord(2, "did b", "tc2");
	const branch = [u, a1, rec1, tr1, a2, a2b, rec2];

	const r1 = resolveCloseUnitSpan(branch, { unitId: 1, stub: "did a", toolCallId: "tc1", closeRecordIndex: 2 }, new Set());
	assert.ok(r1.ok, JSON.stringify(r1));
	if (r1.ok) {
		assert.equal(r1.span.spanFirstId, u.id);
		assert.equal(r1.span.spanLastId, rec1.id); // the CLOSE RECORD — not the toolResult (F4)
		assert.deepEqual(r1.span.entryIds, [u.id, a1.id, rec1.id]);
		assert.ok(r1.span.entryIds.includes(tr1.id) === false, "close 1's own toolResult is NOT in its own span");
	}

	const r2 = resolveCloseUnitSpan(branch, { unitId: 2, stub: "did b", toolCallId: "tc2", closeRecordIndex: 6 }, new Set());
	assert.ok(r2.ok, JSON.stringify(r2));
	if (r2.ok) {
		assert.equal(r2.span.spanFirstId, a2.id, "unit 2 starts AFTER close 1's toolResult");
		assert.equal(r2.span.spanLastId, rec2.id);
		assert.deepEqual(r2.span.entryIds, [a2.id, a2b.id, rec2.id]);
		assert.ok(r2.span.entryIds.includes(tr1.id) === false, "close 1's toolResult is in NO span (boundary artifact, F4)");
	}
});

test("v4: a second close over NO new work ⇒ no-new-work (the refusal that replaces CLOSE_UNIT_PENDING)", () => {
	n = 0;
	const u = userMsg("do a");
	const a1 = assistantMsg("work a; close_unit");
	const rec1 = closeRecord(1, "did a", "tc1");
	const tr1 = toolResultMsg("tc1");
	const a2 = closeCallAssistant("did a again");
	const rec2 = closeRecord(2, "did a again", "tc2");
	const res = resolveCloseUnitSpan([u, a1, rec1, tr1, a2, rec2], { unitId: 2, stub: "did a again", toolCallId: "tc2", closeRecordIndex: 5 }, new Set());
	assert.deepEqual(res, { ok: false, error: "no-new-work" });
});

test("v4: unit 1 with no real user message ⇒ no-new-work (injected openers never open a unit, F4)", () => {
	n = 0;
	const injected = userMsg("[sam-stub] please summarize");
	const a = assistantMsg("close_unit");
	const rec = closeRecord(1, "stub", "tc1");
	const res = resolveCloseUnitSpan([injected, a, rec], { unitId: 1, stub: "stub", toolCallId: "tc1", closeRecordIndex: 2 }, new Set());
	assert.deepEqual(res, { ok: false, error: "no-new-work" });
});

test("v4: the close record at closeRecordIndex is not a close record ⇒ close-record-missing", () => {
	n = 0;
	const u = userMsg("work");
	const a = assistantMsg("close_unit");
	const rec = closeRecord(1, "s", "tc1");
	const tr = toolResultMsg("tc1");
	const res = resolveCloseUnitSpan([u, a, rec, tr], { unitId: 1, stub: "s", toolCallId: "tc1", closeRecordIndex: 3 }, new Set());
	assert.deepEqual(res, { ok: false, error: "close-record-missing" });
});

test("v4: a span touching a folded span ⇒ already-closed (the duplicate-close protection, re-keyed on the span)", () => {
	n = 0;
	const u = userMsg("do a and b");
	const a1 = assistantMsg("work a; close");
	const rec1 = closeRecord(1, "did a", "tc1");
	const tr1 = toolResultMsg("tc1");
	const a2 = assistantMsg("work b; close");
	const rec2 = closeRecord(2, "did b", "tc2");
	// folding UNIT 2's own work (a2) overlaps the candidate span ⇒ refused;
	// folding unit 1's work (a1) does NOT (plan §4: closing unit k must not be
	// blocked by unit k−1's fold)
	const res = resolveCloseUnitSpan([u, a1, rec1, tr1, a2, rec2], { unitId: 2, stub: "did b", toolCallId: "tc2", closeRecordIndex: 5 }, new Set([a2.id]));
	assert.deepEqual(res, { ok: false, error: "already-closed" });
	const notBlocked = resolveCloseUnitSpan([u, a1, rec1, tr1, a2, rec2], { unitId: 2, stub: "did b", toolCallId: "tc2", closeRecordIndex: 5 }, new Set([a1.id]));
	assert.ok(notBlocked.ok, "unit 2 must NOT be blocked by unit 1's fold");
});

test("v4: closeCandidateSpanOk — the pre-write guard (no-new-work / already-closed / ok)", () => {
	n = 0;
	const u = userMsg("do a and b");
	const a1 = assistantMsg("work a; close");
	const rec1 = closeRecord(1, "did a", "tc1");
	const tr1 = toolResultMsg("tc1");
	const a2 = assistantMsg("work b");
	const a2b = assistantMsg("close");
	// guard pass: the CURRENT close record is not appended yet (branch end = the close toolCall)
	const branchNoWork = [u, a1, rec1, tr1, closeCallAssistant("again")];
	assert.equal(closeCandidateSpanOk(branchNoWork, 2, "tc2", new Set()), "no-new-work");
	const branchOk = [u, a1, rec1, tr1, a2, a2b];
	assert.equal(closeCandidateSpanOk(branchOk, 2, "tc2", new Set()), "ok");
	assert.equal(closeCandidateSpanOk(branchOk, 2, "tc2", new Set([a2.id])), "already-closed");
	// a non-close index is not a valid previous close
	assert.equal(closeCandidateSpanOk([a1], 0, "tc1", new Set()), "no-new-work");
});

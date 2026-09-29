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

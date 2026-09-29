/**
 * Unit tests: session state derivation from the ledger (P2).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { rebuildLedger } from "../src/ledger.ts";
import { auditInstruction } from "../src/protocol.ts";
import { type PlainEntry } from "../src/projection.ts";
import { countUnits, createSamState, foldedEntryIdSet, isSamMode, SAM_MODES } from "../src/state.ts";

let n = 0;
const id = () => `e${++n}`;
const sam = (data: unknown): PlainEntry => ({ id: id(), kind: "custom", customType: "sam", data });
const userMsg = (content: string): PlainEntry => ({ id: id(), kind: "message", message: { role: "user", content } });
const assistantMsg = (content: string): PlainEntry => ({
	id: id(),
	kind: "message",
	message: { role: "assistant", content, stopReason: "stop" },
});

test("createSamState: mode from the ledger, pendingCommits copied, in-flight reset", () => {
	n = 0;
	const l = rebuildLedger([
		sam({ v: 1, kind: "mode", mode: "display", ts: 1 }),
		userMsg("do X"),
		assistantMsg("calling tool"),
		sam({ v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "tc", ts: 2, mode: "display" }),
		{ id: id(), kind: "message", message: { role: "toolResult", content: "ok", toolCallId: "tc", toolName: "close_unit", isError: false } },
		userMsg(auditInstruction(1)),
		assistantMsg("VERIFIED"),
	]);
	const s = createSamState(l);
	assert.equal(s.mode, "display");
	assert.equal(s.pendingCommits.length, 1);
	assert.equal(s.pendingCommits[0].unitId, 1);
	assert.equal(s.audit, null);
	assert.equal(s.pendingUndo, null);
	assert.equal(s.pendingCloses.length, 0);
});

test("countUnits buckets every state exactly once", () => {
	n = 0;
	const u1 = userMsg("a");
	const u2 = userMsg("b");
	const u3 = userMsg("c");
	const foldRec = (unitId: number, entryIds: string[]) => ({
		v: 1,
		kind: "fold",
		unitId,
		entryIds,
		spanFirstId: entryIds[0],
		spanLastId: entryIds[entryIds.length - 1],
		stub: `s${unitId}`,
		verdict: "VERIFIED" as const,
		ts: unitId,
		mode: "manual" as const,
	});
	const l = rebuildLedger([
		sam(foldRec(1, [u1.id])),
		sam({ v: 1, kind: "close", unitId: 2, stub: "s2", toolCallId: "tc2", ts: 20, mode: "manual" }),
		sam({ v: 1, kind: "close", unitId: 3, stub: "s3", toolCallId: "tc3", ts: 30, mode: "manual" }),
		userMsg(auditInstruction(3)),
		assistantMsg("VERIFIED"),
		sam({ v: 1, kind: "undo", unitId: 1, targets: [u1.id], ts: 40 }),
	]);
	const c = countUnits(l);
	assert.equal(c.folded, 0);
	assert.equal(c.refused, 0);
	assert.equal(c.undone, 1); // unit 1
	assert.equal(c.inFlight, 2); // unit 2 (awaiting re-audit) + unit 3 (awaiting commit)
});

test("foldedEntryIdSet: only folded units contribute their span entry ids", () => {
	n = 0;
	const u1 = userMsg("a");
	const u2 = userMsg("b");
	const l = rebuildLedger([
		sam({ v: 1, kind: "close", unitId: 1, stub: "s1", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u1.id], spanFirstId: u1.id, spanLastId: u1.id, stub: "s1", verdict: "VERIFIED", ts: 2, mode: "manual" }),
		sam({ v: 1, kind: "close", unitId: 2, stub: "s2", toolCallId: "tc2", ts: 3, mode: "manual" }),
		sam({ v: 1, kind: "noFold", unitId: 2, entryIds: [u2.id], spanFirstId: u2.id, spanLastId: u2.id, stub: "s2", verdict: "CORRECTIONS", corrections: "x", reason: "verdict CORRECTIONS", ts: 4, mode: "manual" }),
	]);
	const folded = foldedEntryIdSet(l);
	assert.equal(folded.has(u1.id), true);
	assert.equal(folded.has(u2.id), false);
});

test("SAM_MODES / isSamMode unchanged from P0", () => {
	assert.deepEqual([...SAM_MODES], ["display", "manual", "assisted", "auto"]);
	for (const m of SAM_MODES) assert.equal(isSamMode(m), true);
	assert.equal(isSamMode("off"), false);
});

/**
 * Unit tests: fold/undo draft construction.
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildFoldDrafts, buildUndoDrafts } from "../src/folder.ts";
import { resolveUnitSpan, type UnitSpan } from "../src/units.ts";
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
	message: { role: "toolResult", content: "ok", toolCallId, toolName: "close_unit", isError: false },
});

function makeSpan(stub = "wrote data.txt", unitId = 1): UnitSpan {
	n = 0;
	const entries: PlainEntry[] = [userMsg("write data.txt"), assistantMsg("call"), closeRecord(unitId, stub, "tc1"), toolResultMsg("tc1")];
	const res = resolveUnitSpan(entries, [{ unitId, stub, toolCallId: "tc1" }], new Set());
	if (!res.ok) throw new Error("expected span");
	return res.span;
}

test("fold drafts: stub on the first target, null on the rest — only message entries targeted", () => {
	const span = makeSpan();
	const drafts = buildFoldDrafts(span);
	assert.equal(drafts.length, 3); // user, assistant, toolResult (custom close record not targeted)
	assert.deepEqual(drafts[0], { type: "context_edit", targetId: span.targetIds[0], replacement: { content: "[Unit 1 ✓] wrote data.txt" } });
	for (let i = 1; i < drafts.length; i++) {
		assert.deepEqual(drafts[i], { type: "context_edit", targetId: span.targetIds[i], replacement: null });
	}
});

test("fold drafts: corrections are appended to the stub text", () => {
	const span = makeSpan("counted 5 lines", 2);
	const drafts = buildFoldDrafts(span, "line count is actually 6");
	assert.equal(
		(drafts[0].replacement as { content: string }).content,
		"[Unit 2 ✓] counted 5 lines [CORRECTIONS: line count is actually 6]",
	);
});

test("undo drafts: originals restored in span order, missing originals skipped", () => {
	const span = makeSpan("wrote data.txt");
	const originals = span.targetIds.map((tid) => ({ id: tid, content: `original of ${tid}` }));
	const drafts = buildUndoDrafts(span.targetIds, originals);
	assert.equal(drafts.length, 3);
	for (const d of drafts) {
		assert.equal(d.type, "context_edit");
		assert.ok(d.replacement !== null);
	}
	assert.equal((drafts[0].replacement as { content: string }).content, `original of ${span.targetIds[0]}`);

	// one original missing → skipped, the rest still restored
	const partial = originals.slice(1);
	const drafts2 = buildUndoDrafts(span.targetIds, partial);
	assert.equal(drafts2.length, 2);
	assert.deepEqual(drafts2.map((d) => d.targetId), span.targetIds.slice(1));
});

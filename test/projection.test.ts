/**
 * Unit tests: the plain-entry projection (pi v0.87.1 semantics, mirrored).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildProjection, messageText, projectedText, type PlainEntry, type PlainMessage } from "../src/projection.ts";

let n = 0;
const id = () => `e${++n}`;

function userMessage(text: string, injected = false): PlainEntry {
	return { id: id(), kind: "message", message: { role: "user", content: injected ? `[sam-audit] ${text}` : text } };
}

function assistantMessage(text: string, extra: Partial<PlainMessage> = {}): PlainEntry {
	return { id: id(), kind: "message", message: { role: "assistant", content: text, stopReason: "stop", ...extra } };
}

function toolResult(text: string, toolName = "bash"): PlainEntry {
	return {
		id: id(),
		kind: "message",
		message: { role: "toolResult", content: text, toolCallId: "tc", toolName, isError: false },
	};
}

function edit(targetId: string, replacement: { content: string } | null): PlainEntry {
	return { id: id(), kind: "context_edit", targetId, replacement };
}

function custom(customType: string, data?: unknown): PlainEntry {
	return { id: id(), kind: "custom", customType, data };
}

test("no edits → all messages in order, custom entries ignored", () => {
	n = 0;
	const a = userMessage("do X");
	const b = assistantMessage("working");
	const c = custom("sam", { kind: "close" });
	const proj = buildProjection([a, b, c]);
	assert.deepEqual(proj.messages.map((m) => m.role), ["user", "assistant"]);
	assert.deepEqual(proj.entries.map((e) => e.sourceEntryId), [a.id, b.id, c.id]);
	assert.equal(proj.entries[2].messages.length, 0, "custom entries contribute no messages");
});

test("null replacement omits the entry; raw content is untouched", () => {
	n = 0;
	const a = userMessage("do X");
	const b = assistantMessage("working");
	const c = toolResult("output");
	const proj = buildProjection([a, b, c, edit(a.id, null), edit(c.id, null)]);
	assert.deepEqual(proj.messages.map((m) => projectedText(m)), ["working"]);
	// the omitted entries still exist as sources with no messages (raw stays):
	assert.deepEqual(
		proj.entries.filter((e) => e.messages.length > 0).map((e) => e.sourceEntryId),
		[b.id],
	);
	assert.equal(proj.entries.find((e) => e.sourceEntryId === a.id)?.messages.length, 0);
});

test("string replacement on assistant/toolResult is normalized to text blocks; latest wins", () => {
	n = 0;
	const a = assistantMessage("old");
	const b = toolResult("old tool");
	const proj = buildProjection([
		a,
		b,
		edit(a.id, { content: "replaced" }),
		edit(a.id, { content: "replaced again" }),
		edit(b.id, { content: "tool replaced" }),
	]);
	assert.deepEqual(proj.messages.map((m) => projectedText(m)), ["replaced again", "tool replaced"]);
	assert.deepEqual(proj.messages[0].content, [{ type: "text", text: "replaced again" }]);
	assert.deepEqual(proj.messages[1].content, [{ type: "text", text: "tool replaced" }]);
});

test("replacement on user/system is passed through as-is (pi only normalizes assistant/toolResult)", () => {
	n = 0;
	const a = userMessage("old");
	const proj = buildProjection([a, edit(a.id, { content: "replaced" })]);
	assert.equal(proj.messages[0].content, "replaced");
});

test("omitted entries do not reappear when a later edit replaces them (latest-wins only)", () => {
	n = 0;
	const a = userMessage("do X");
	const proj = buildProjection([a, edit(a.id, null), edit(a.id, { content: "back" })]);
	assert.equal(proj.messages.length, 1);
	assert.equal(messageText(proj.messages[0].content), "back");
});

test("compaction: checkpoint drops pre-firstKept entries; only the newest compaction contributes", () => {
	n = 0;
	const u1 = userMessage("old work");
	const c1: PlainEntry = { id: "c1", kind: "compaction", summary: "old summary", firstKeptEntryId: "c1" };
	const u2 = userMessage("new work");
	const c2: PlainEntry = { id: "c2", kind: "compaction", summary: "new summary", firstKeptEntryId: u2.id };
	const u3 = userMessage("after");
	const proj = buildProjection([u1, c1, u2, c2, u3]);
	assert.equal(proj.messages.length, 3);
	assert.deepEqual(proj.messages.map((m) => m.role), ["compactionSummary", "user", "user"]);
	assert.equal(projectedText(proj.messages[0]), "new summary");
	// u1 and c1 (before the newest compaction's firstKeptEntryId) are dropped
	assert.ok(!proj.entries.some((e) => e.sourceEntryId === u1.id));
	assert.ok(!proj.entries.some((e) => e.sourceEntryId === c1.id));
});

test("compaction: firstKeptEntryId keeps earlier messages; system message is replaced by its snapshot", () => {
	n = 0;
	const sys = { id: id(), kind: "message" as const, message: { role: "system" as const, content: "sys prompt" } };
	const u1 = userMessage("kept");
	const c: PlainEntry = {
		id: "c",
		kind: "compaction",
		summary: "summary",
		firstKeptEntryId: u1.id,
		systemMessage: { role: "system", content: "sys snapshot" },
	};
	const u2 = userMessage("after");
	const proj = buildProjection([sys, u1, c, u2]);
	assert.deepEqual(proj.messages.map((m) => m.role), ["system", "compactionSummary", "user", "user"]);
	assert.equal(proj.messages[0].content, "sys snapshot"); // the snapshot, not the original
	assert.equal(proj.messages[2].content, "kept");
});

test("system messages: none invented; none dropped unless edited away", () => {
	n = 0;
	const sys = { id: id(), kind: "message" as const, message: { role: "system" as const, content: "sys prompt" } };
	const proj = buildProjection([sys, userMessage("hi")]);
	assert.equal(proj.messages[0].role, "system");
	assert.deepEqual(proj.messages.map((m) => m.role), ["system", "user"]);
});

/**
 * P3 tests: extraction.ts — the deterministic unit floor (slim port of
 * pi-smart-compact's extraction floor, port list item 6) and the close-time
 * empty-stub gate (anti-self-sealing; the s5 9-of-10-empty-stub failure).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	commandFailureEvidence,
	commandOf,
	emptyStubGate,
	extractText,
	extractUnitFloor,
	flattenToolCallBlock,
	hasCommandFailureSignal,
	isTransientToolDiagnostic,
} from "../src/extraction.ts";
import type { PlainMessage } from "../src/projection.ts";

function assistantText(text: string): PlainMessage {
	return { role: "assistant", content: text };
}
function assistantCall(name: string, args: unknown, text = ""): PlainMessage {
	const content: unknown[] = [];
	if (text) content.push({ type: "text", text });
	content.push({ type: "toolCall", name, id: `call-${name}`, arguments: args });
	return { role: "assistant", content };
}
function result(text: string, isError = false, toolCallId?: string, toolName?: string): PlainMessage {
	return { role: "toolResult", content: text, isError, toolCallId, toolName };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

test("extractText: strings and text-block arrays only", () => {
	assert.equal(extractText("abc"), "abc");
	assert.equal(extractText([{ type: "text", text: "hi" }, { type: "toolCall", name: "x", arguments: {} }]), "hi");
	assert.equal(extractText(42), "");
	assert.equal(extractText(null), "");
});

test("flattenToolCallBlock: only well-formed toolCall blocks", () => {
	const flat = flattenToolCallBlock({ type: "toolCall", name: "read", id: "c1", arguments: { path: "f" } });
	assert.deepEqual(flat, [{ name: "read", id: "c1", arguments: { path: "f" } }]);
	assert.deepEqual(flattenToolCallBlock({ type: "text", text: "no" }), []);
	assert.deepEqual(flattenToolCallBlock("junk"), []);
});

test("commandOf: argument-shape first, then command-ish names; close_unit is self-noise (F4)", () => {
	assert.equal(commandOf("anything", { command: "ls -la" }), "ls -la");
	assert.equal(commandOf("run", { cmd: "make" }), "make");
	assert.equal(commandOf("bash", {}), "", "command tool with no text = command with empty text");
	assert.equal(commandOf("read", { path: "f" }), undefined, "a file op is not a command tool");
	assert.equal(commandOf("close_unit", { command: "echo hi" }), undefined, "F4: protocol tool is self-noise");
});

test("hasCommandFailureSignal: non-zero exit / leading error markers", () => {
	assert.equal(hasCommandFailureSignal("Command exited with code 1"), true);
	assert.equal(hasCommandFailureSignal("no such file or directory: build/output"), true, "leading error line");
	assert.equal(hasCommandFailureSignal("command not found\n..."), true);
	assert.equal(hasCommandFailureSignal("all good\noutput here"), false);
	assert.equal(hasCommandFailureSignal(""), false);
	// mid-output mentions of error words are NOT leading markers:
	assert.equal(hasCommandFailureSignal("done; the log said error once but exit 0"), false);
});

test("isTransientToolDiagnostic: their four signatures + the generic network class", () => {
	assert.equal(isTransientToolDiagnostic("Brave Search API error (429): rate limited"), true);
	assert.equal(isTransientToolDiagnostic("npm error code ENOLOCK\nExisting lockfile"), true);
	assert.equal(isTransientToolDiagnostic("Found 3 occurrences of edits[2]"), true);
	assert.equal(isTransientToolDiagnostic("Unknown JSON field: foo\nAvailable fields: a, b"), true);
	assert.equal(isTransientToolDiagnostic("fetch failed: ECONNRESET"), true, "generic network class");
	assert.equal(isTransientToolDiagnostic("ETIMEDOUT after 30s"), true);
	assert.equal(isTransientToolDiagnostic("real compile error: type mismatch"), false);
});

test("commandFailureEvidence: keeps the actionable part, bounded budget", () => {
	const noisy = "some padding ".repeat(200) + "command not found: make\n" + "more noise ".repeat(200);
	const evidence = commandFailureEvidence(noisy, 400);
	assert.ok(evidence.includes("command not found: make"));
	assert.ok(evidence.length <= 400 + "\n...\n".length + 60, "bounded (evidence + small tail)");
	assert.equal(commandFailureEvidence("short", 400), "short");
});

/* ── the floor (deterministic, ledger-ready) ─────────────────────────────── */

test("floor: file ops are argument-shape based (path-family keys), ops deduped", () => {
	const messages: PlainMessage[] = [
		assistantCall("read_file", { path: "src/a.ts" }),
		result("file content", false, "call-read_file", "read_file"),
		assistantCall("write_file", { path: "src/a.ts", content: "new" }),
		result("ok", false, "call-write_file", "write_file"),
		assistantCall("note", { target_file: "notes.md" }),
		result("ok", false, "call-note", "note"),
	];
	const floor = extractUnitFloor(messages);
	assert.equal(floor.files.length, 2);
	assert.deepEqual(floor.files[0], { path: "notes.md", ops: ["read"] }, "path-family arg key counts as a file op (read)");
	assert.deepEqual(floor.files[1], { path: "src/a.ts", ops: ["mutate", "read"] }, "same path, both ops, sorted");
	assert.equal(floor.retries, 0);
	assert.equal(floor.nonTrivial, true);
});

test("floor: close_unit is self-noise (F4) — never a file op, never a command, never work", () => {
	const messages: PlainMessage[] = [
		assistantCall("close_unit", { stub: "done" }),
		result("close recorded", false, "call-close_unit", "close_unit"),
	];
	const floor = extractUnitFloor(messages);
	assert.deepEqual(floor.files, []);
	assert.deepEqual(floor.errors, []);
	assert.equal(floor.nonTrivial, false, "a close-only unit has no demonstrable work (F4)");
});

test("floor: command failures are errors; a successing repeat is a retry (window-bounded)", () => {
	const failing = { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "c1", arguments: { command: "make build" } }] };
	const ok = { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "c2", arguments: { command: "make build" } }] };
	const messages: PlainMessage[] = [
		failing,
		{ role: "toolResult", content: "Command exited with code 2", toolCallId: "c1", isError: true, toolName: "bash" },
		ok,
		{ role: "toolResult", content: "success", toolCallId: "c2", isError: false, toolName: "bash" },
	];
	const floor = extractUnitFloor(messages);
	assert.equal(floor.errors.length, 1);
	assert.equal(floor.errors[0].tool, "bash");
	assert.equal(floor.retries, 1, "same signature within the retry window ⇒ retry");

	// window-bounded: 5 assistant steps after the failure is outside the window
	const far = { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "c9", arguments: { command: "make build" } }] };
	const messagesFar: PlainMessage[] = [
		failing,
		{ role: "toolResult", content: "Command exited with code 2", toolCallId: "c1", isError: true, toolName: "bash" },
		assistantText("thinking"),
		assistantText("more"),
		assistantText("still"),
		assistantText("and"),
		assistantText("five"),
		far,
		{ role: "toolResult", content: "success", toolCallId: "c9", isError: false, toolName: "bash" },
	];
	const floorFar = extractUnitFloor(messagesFar);
	assert.equal(floorFar.retries, 0, "outside the retry window: not a retry");
});

test("floor: transient diagnostics are noise for the floor", () => {
	const messages: PlainMessage[] = [
		{ role: "assistant", content: [{ type: "toolCall", name: "search", id: "s1", arguments: { query: "x" } }] },
		{ role: "toolResult", content: "Brave Search API error (429)", toolCallId: "s1", isError: true, toolName: "search" },
	];
	const floor = extractUnitFloor(messages);
	assert.deepEqual(floor.errors, [], "a 429 diagnostic is transient noise, not a remembered error");
});

test("floor: nonTrivial = tool results, ≥100 assistant chars, errors, or files", () => {
	assert.equal(extractUnitFloor([]).nonTrivial, false, "no messages: trivial");
	assert.equal(extractUnitFloor([assistantText("short")]).nonTrivial, false, "30 chars: trivial");
	assert.equal(extractUnitFloor([assistantText("x".repeat(100))]).nonTrivial, true, "100 assistant chars: work");
	assert.equal(
		extractUnitFloor([
			assistantCall("read_file", { path: "f" }),
			result("ok"),
		]).nonTrivial,
		true,
		"a tool result: work",
	);
});

/* ── the empty-stub gate (anti-self-sealing) ─────────────────────────────── */

test("emptyStubGate: empty stub over demonstrable work is refused with the reason", () => {
	const floor = extractUnitFloor([
		assistantCall("write_file", { path: "src/x.ts", content: "y" }),
		result("ok", false, "call-write_file", "write_file"),
	]);
	assert.equal(floor.nonTrivial, true, "precondition: the unit did demonstrable work");
	const gate = emptyStubGate("", floor);
	assert.equal(gate.ok, false);
	assert.match(gate.reason as string, /empty stub over demonstrable work/);
	assert.match(gate.reason as string, /1 file/);
	const whitespace = emptyStubGate("   \n\t ", floor);
	assert.equal(whitespace.ok, false, "whitespace-only stub is empty");
});

test("emptyStubGate: a real stub always passes; an empty stub over a trivial unit passes (nothing to lose)", () => {
	const floor = extractUnitFloor([
		assistantText("Sure — closing this unit now after a quick check."),
	]);
	assert.equal(emptyStubGate("", floor).ok, true, "nothing demonstrable: an empty close is a no-op the audit would reject anyway — no special gate needed");
	assert.equal(emptyStubGate("did the thing", floor).ok, true);
});

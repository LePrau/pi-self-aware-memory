/**
 * Unit tests: token estimation (pi v0.87.1 rules, mirrored 1:1).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { calculateContextTokens, estimateProjectedTokens, getAssistantUsage, estimateMessagesTokens } from "../src/estimate.ts";
import { buildProjection, type PlainEntry } from "../src/projection.ts";

let n = 0;
const id = () => `e${++n}`;
const userMsg = (content: string): PlainEntry => ({ id: id(), kind: "message", message: { role: "user", content } });
const assistantMsg = (content: string, extra: Partial<{ stopReason: string; usage: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }> = {}): PlainEntry => ({
	id: id(),
	kind: "message",
	message: { role: "assistant", content, stopReason: "stop", ...extra },
});
const edit = (targetId: string, replacement: { content: string } | null): PlainEntry => ({
	id: id(),
	kind: "context_edit",
	targetId,
	replacement,
});

test("calculateContextTokens: totalTokens wins, else input+output+cache", () => {
	assert.equal(calculateContextTokens({ totalTokens: 500, input: 10, output: 20 }), 500);
	assert.equal(calculateContextTokens({ totalTokens: 0, input: 10, output: 20, cacheRead: 30, cacheWrite: 5 }), 65);
	assert.equal(calculateContextTokens({ input: 1, output: 1 }), 2);
});

test("getAssistantUsage: stop/error/aborted and zero totals yield no usage", () => {
	const u = { totalTokens: 42, input: 1, output: 2, cacheRead: 3, cacheWrite: 0 };
	assert.equal(getAssistantUsage({ role: "assistant", content: "", stopReason: "stop", usage: u })?.totalTokens, 42);
	assert.equal(getAssistantUsage({ role: "assistant", content: "", stopReason: "aborted", usage: u }), undefined);
	assert.equal(getAssistantUsage({ role: "assistant", content: "", stopReason: "error", usage: u }), undefined);
	assert.equal(getAssistantUsage({ role: "assistant", content: "", stopReason: "stop", usage: { totalTokens: 0, input: 0, output: 0 } }), undefined);
	assert.equal(getAssistantUsage({ role: "assistant", content: "", stopReason: "stop" }), undefined);
});

test("per-message estimation: ceil(chars/4); toolCall adds name + JSON(arguments); image = 4800 chars", () => {
	assert.equal(estimateMessagesTokens([{ role: "user", content: "hello" }]).tokens, 2); // 5/4 → 2
	const toolCallMsg = {
		role: "assistant" as const,
		content: [
			{ type: "text" as const, text: "" },
			{ type: "toolCall" as const, name: "bash", arguments: { command: "ls" } },
		],
	};
	// 0 text + (4 + 15) toolCall chars = 19 → ceil(19/4) = 5
	assert.equal(estimateMessagesTokens([toolCallMsg]).tokens, 5);
	const imageMsg = { role: "user" as const, content: [{ type: "image" as const, data: "x", mimeType: "image/png" }] };
	assert.equal(estimateMessagesTokens([imageMsg]).tokens, 1200);
});

test("last-usage shortcut: trusted when no later context_edit, else per-message sum", () => {
	n = 0;
	const u = { totalTokens: 500, input: 400, output: 100 };
	const a = assistantMsg("worked", { usage: u });
	const tail = userMsg("abc"); // 3 chars → 1
	const branch = [a, tail];
	const proj = buildProjection(branch);
	const est = estimateProjectedTokens(proj, branch);
	assert.equal(est.tokens, 501); // usage 500 + trailing 1
	assert.equal(est.lastUsageIndex, 0);

	// a later context_edit invalidates the shortcut → per-message sum:
	// the tail is edited away, the assistant remains → "worked" (6 → 2)
	const branch2 = [...branch, edit(tail.id, null)];
	const proj2 = buildProjection(branch2);
	const est2 = estimateProjectedTokens(proj2, branch2);
	assert.equal(est2.tokens, 2);
	assert.equal(est2.lastUsageIndex, null);
});

test("fallback sums system once when present", () => {
	n = 0;
	const sys: PlainEntry = { id: id(), kind: "message", message: { role: "system", content: "sys" } };
	const u1 = userMsg("abc");
	const branch = [sys, u1];
	assert.equal(estimateProjectedTokens(buildProjection(branch), branch).tokens, 2); // 1 + 1
});

test("aborted assistant usage is never trusted", () => {
	n = 0;
	const a = assistantMsg("boom", { stopReason: "aborted", usage: { totalTokens: 900, input: 0, output: 0 } });
	assert.equal(estimateProjectedTokens(buildProjection([a]), [a]).tokens, 1); // "boom": 4 chars → 1
});

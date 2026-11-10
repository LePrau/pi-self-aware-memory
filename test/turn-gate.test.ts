/**
 * The settled-model gate (2026-11-06, Paul's requirement) — the pure core
 * (src/turn-gate.ts) and its pins. Design note: the dev repo's
 * `2026-11-06-no-sam-output-after-settled-model.md`.
 *
 * What this suite fixes (house rule: strings ship with their pins):
 * - the gate itself: an assistant message with toolCall blocks ⇒ the turn
 *   is OPEN (deliver live — the steer rides the running loop); without
 *   toolCall blocks (stop/length/error/aborted) ⇒ SETTLED (defer — append,
 *   rides the next user turn; never an SAM-initiated round),
 * - the content shapes: the real pi block array, a plain string (some test
 *   fixtures use it — no-tool-calls by definition), null/undefined,
 * - the defensive shape handling (non-object blocks must not throw — the
 *   gate runs inside the D7 fail-safe, but a throw costs the whole
 *   observation, so the gate itself is total).
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { modelTurnOpen, type GateContent } from "../src/turn-gate.ts";

test("a continuing toolCall block anywhere in the content ⇒ the turn is open (live channel)", () => {
	assert.equal(modelTurnOpen([{ type: "text", text: "working on it…" }, { type: "toolCall", name: "bash", id: "tc1", arguments: {} }]), true);
	assert.equal(modelTurnOpen([{ type: "toolCall", name: "read", id: "tc2", arguments: {} }]), true);
	assert.equal(modelTurnOpen([{ type: "thinking", thinking: "hmm" }, { type: "toolCall", name: "close_unit", id: "tc3", arguments: { stub: "s" } }]), true, "close_unit continues the turn (its tool result lands in-turn)");
});

test("v0.0.32: a fold_now toolCall does NOT open the turn — it ends it (compact aborts the turn; the steer would degrade into a standalone SAM turn)", () => {
	assert.equal(modelTurnOpen([{ type: "text", text: "folding:" }, { type: "toolCall", name: "fold_now", id: "tc4", arguments: {} }]), false, "fold_now-only ⇒ settled ⇒ deferred channel");
	assert.equal(modelTurnOpen([{ type: "toolCall", name: "fold_now", id: "tc5", arguments: {} }]), false);
	assert.equal(modelTurnOpen([{ type: "toolCall", name: "bash", id: "tc6", arguments: {} }, { type: "toolCall", name: "fold_now", id: "tc7", arguments: {} }]), true, "a continuing tool call keeps the turn open (the steer lands before the next LLM call, in-turn)");
});

test("no toolCall blocks ⇒ the model settled (deferred channel)", () => {
	assert.equal(modelTurnOpen([{ type: "text", text: "All done — the report is on disk." }]), false);
	assert.equal(modelTurnOpen([{ type: "thinking", thinking: "let me check…" }, { type: "text", text: "…" }]), false);
	assert.equal(modelTurnOpen([]), false, "empty content = nothing was called");
});

test("the non-array content shapes are settled (total function — never throws)", () => {
	assert.equal(modelTurnOpen("All done."), false, "a plain string has no tool calls");
	assert.equal(modelTurnOpen(""), false);
	assert.equal(modelTurnOpen(null), false);
	assert.equal(modelTurnOpen(undefined), false);
});

test("defensive: malformed blocks are skipped, not a throw", () => {
	const content: GateContent = [{ type: "text" } as never, null as never, { nope: true } as never, { type: "toolCall" }];
	assert.equal(modelTurnOpen(content), true, "a toolCall block without a name still counts (only a NAMED fold_now is turn-terminating)");
	assert.equal(modelTurnOpen([{ nope: true } as never, null as never]), false);
});

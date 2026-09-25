/**
 * Unit tests: /sam status rendering and output-channel choice (P0).
 * renderSamStatus is pure — the exact text a user sees is pinned here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { EXTENSION_NAME, SAM_VERSION } from "../src/identity.ts";
import { renderSamStatus, samOutputChannel, type SamStatusInput } from "../src/output.ts";
import { createSamState } from "../src/state.ts";

function input(over: Partial<SamStatusInput> = {}): SamStatusInput {
  return { state: createSamState(), ...over };
}

test("status: fresh session, no usage yet, no model", () => {
  const lines = renderSamStatus(input());
  assert.deepEqual(lines, [
    `── sam ── ${EXTENSION_NAME} ${SAM_VERSION} ──`,
    `mode: manual   [P0 scaffold — loads and reports only, folds nothing in any mode]`,
    "model: none",
    "context: unknown (no usage yet)",
    "units: open 0 · closed 0 · folds 0 · audits 0",
    "commands: /sam · /sam mode <m>   (fold · report · undo: not yet — P2)",
  ]);
});

test("status: with usage, model, and non-zero counters", () => {
  const state = createSamState();
  state.mode = "display";
  state.openUnits = 2;
  state.closedUnits = 5;
  state.folds = 3;
  state.audits = 3;
  state.inFlight = 1;
  const lines = renderSamStatus(
    input({
      state,
      usage: { tokens: 16384, contextWindow: 32768, percent: 50.123 },
      model: { provider: "openai-completions", id: "some-model" },
    }),
  );
  assert.equal(lines[0], `── sam ── ${EXTENSION_NAME} ${SAM_VERSION} ──`);
  assert.equal(lines[1], "mode: display   [P0 scaffold — loads and reports only, folds nothing in any mode]");
  assert.equal(lines[2], "model: openai-completions/some-model");
  assert.equal(lines[3], "context: 16,384 / 32,768 (50.1 %)");
  assert.equal(lines[4], "units: open 2 · closed 5 · folds 3 · audits 3 · audit in flight");
});

test("status: usage present but tokens null (right after start/compaction)", () => {
  const lines = renderSamStatus(input({ usage: { tokens: null, contextWindow: 32768, percent: null } }));
  assert.equal(lines[3], "context: ? / 32,768 (tokens unknown — right after start or compaction)");
});

test("channel: UI wins, json is silent, print goes to stderr", () => {
  assert.equal(samOutputChannel(true, "tui"), "ui");
  assert.equal(samOutputChannel(true, "rpc"), "ui");
  assert.equal(samOutputChannel(false, "print"), "stderr");
  assert.equal(samOutputChannel(false, "json"), "none");
  // hasUI false with tui/rpc mode is not expected from pi; document the rule anyway:
  assert.equal(samOutputChannel(false, "tui"), "stderr");
  assert.equal(samOutputChannel(false, "rpc"), "stderr");
});

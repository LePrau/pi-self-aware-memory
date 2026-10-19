/**
 * Unit tests: /sam status + report rendering and output-channel choice (P2).
 * renderSamStatus/renderSamReport are pure — the exact text a user sees is
 * pinned here.
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { EXTENSION_NAME, SAM_VERSION } from "../src/identity.ts";
import { rebuildLedger, type SamLedger } from "../src/ledger.ts";
import { renderSamReport, renderSamStatus, samOutputChannel, type SamStatusInput } from "../src/output.ts";
import { auditInstruction } from "../src/protocol.ts";
import { type PlainEntry } from "../src/projection.ts";
import { countUnits, createSamState } from "../src/state.ts";

function input(state: SamStatusInput["state"] = createSamState(rebuildLedger([])), over: Partial<SamStatusInput> = {}): SamStatusInput {
	return { state, ...over };
}

test("status: fresh session, no usage yet, no model (P3 surface)", () => {
	const lines = renderSamStatus(input(), countUnits(rebuildLedger([])));
	assert.deepEqual(lines, [
		`── sam ── ${EXTENSION_NAME} ${SAM_VERSION} ──`,
		"model: none",
		"context: unknown (no usage yet)",
		"units: folded 0 · refused 0 · undone 0 · resolved 0 · in flight 0",
		"commands: /sam · /sam report · /sam undo · /sam fold <n> · /sam resolve <n>",
	]);
});

test("status: usage present, units counted", () => {
	const ledger: SamLedger = rebuildLedger([]);
	const state = createSamState(ledger);
	const lines = renderSamStatus(
		input(state, { usage: { tokens: 16384, contextWindow: 32768, percent: 50.123 }, model: { provider: "openai-completions", id: "some-model" } }),
		countUnits(ledger),
	);
	assert.equal(lines[1], "model: openai-completions/some-model");
	assert.equal(lines[2], "context: 16,384 / 32,768 (50.1%)");
	assert.equal(lines[3], "units: folded 0 · refused 0 · undone 0 · resolved 0 · in flight 0");
});

test("status: P3 governor extras render when present", () => {
	const lines = renderSamStatus(input(), countUnits(rebuildLedger([])), {
		zone: "action",
		window: 32768,
		reserve: 16384,
		keepRecent: 20000,
		foreignFolder: { present: true, basis: "ledger evidence: om.compaction entry on branch" },
		rebuilds: { continuity: 2, "idle-expiry": 1, foreign: 0 },
	});
	const zone = lines.find((l) => l.startsWith("governor:"));
	assert.match(zone as string, /zone action \(window 32,768, reserve 16,384, keep 20,000\)/);
	const coexist = lines.find((l) => l.startsWith("coexistence:"));
	assert.match(coexist as string, /ledger evidence: om\.compaction/);
	const cache = lines.find((l) => l.startsWith("cache:"));
	assert.equal(cache, "cache: 3 rebuild(s) (2 ours · 1 idle · 0 foreign)");
});

test("status: tokens unknown right after start", () => {
	const lines = renderSamStatus(input(undefined, { usage: { tokens: null, contextWindow: 32768, percent: null } }), countUnits(rebuildLedger([])));
	assert.equal(lines[2], "context: ? / 32,768 (tokens unknown — right after start or compaction)");
});

test("status: context bar renders directly after the context line (v0.0.15)", () => {
	const lines = renderSamStatus(
		input(undefined, {
			usage: { tokens: 10_000, contextWindow: 20_000, percent: 50 },
			contextBar: {
				tokens: 10_000,
				window: 20_000,
				reserve: 2_000,
				sysPromptTokens: 2_000,
				goalTokens: 250,
				stackTokens: 3_000,
				auditDepth: "light",
			},
		}),
		countUnits(rebuildLedger([])),
	);
	assert.equal(lines[2], "context: 10,000 / 20,000 (50.0%)");
	assert.equal(lines[3], "SAM [" + "OOOOO" + "......" + "xxxxxxxxxx" + " ".repeat(15) + "|" + " ".repeat(3) + "] audit: light");
	assert.match(lines[4], /^units: /); // the bar pushes the units line down by one
});

test("status: context bar note line when tokens are unknown (v0.0.15)", () => {
	const lines = renderSamStatus(
		input(undefined, {
			usage: { tokens: null, contextWindow: 20_000, percent: null },
			contextBar: {
				tokens: null,
				window: 20_000,
				reserve: 2_000,
				sysPromptTokens: 2_000,
				goalTokens: 250,
				stackTokens: 3_000,
				auditDepth: "medium",
			},
		}),
		countUnits(rebuildLedger([])),
	);
	assert.equal(lines[2], "context: ? / 20,000 (tokens unknown — right after start or compaction)");
	assert.equal(lines[3], "SAM (context tokens unknown) audit: medium");
});

test("report: empty ledger says so plainly", () => {
	assert.deepEqual(renderSamReport(rebuildLedger([])), ["no units yet (close_unit closes one)"]);
});

test("report: one line per unit with state and detail", () => {
	const u1: PlainEntry = { id: "e1", kind: "message", message: { role: "user", content: "task" } };
	const u2: PlainEntry = { id: "e2", kind: "message", message: { role: "user", content: "task" } };
	const ledger = rebuildLedger([
		{ id: "s1", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 1, stub: "did A", toolCallId: "tc1", ts: 1, mode: "manual" } },
		{ id: "s2", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 2, stub: "did B", toolCallId: "tc2", ts: 2, mode: "manual" } },
		{ id: "m1", kind: "message", message: { role: "user", content: auditInstruction(1) } },
		{ id: "m2", kind: "message", message: { role: "assistant", content: "VERIFIED", stopReason: "stop" } },
		{ id: "s3", kind: "custom", customType: "sam", data: { v: 1, kind: "fold", unitId: 1, entryIds: [u1.id], spanFirstId: u1.id, spanLastId: u1.id, stub: "did A", verdict: "VERIFIED", ts: 3, mode: "manual" } },
		{ id: "m3", kind: "message", message: { role: "user", content: auditInstruction(2) } },
		{ id: "m4", kind: "message", message: { role: "assistant", content: "CORRECTIONS: the stub says 3 lines but the file has 5", stopReason: "stop" } },
		{ id: "s4", kind: "custom", customType: "sam", data: { v: 1, kind: "noFold", unitId: 2, entryIds: [u2.id], spanFirstId: u2.id, spanLastId: u2.id, stub: "did B", verdict: "CORRECTIONS", corrections: "the stub says 3 lines but the file has 5", reason: "verdict CORRECTIONS", ts: 4, mode: "manual" } },
	]);
	assert.deepEqual(renderSamReport(ledger), [
		"unit 1: folded",
		"unit 2: refused (verdict CORRECTIONS · the stub says 3 lines but the file has 5)",
	]);
});

test("report: P3 unit states — sweep fold, gate refusal, unresolved tombstone", () => {
	const ledger = rebuildLedger([
		{ id: "s1", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 1, stub: "s1", toolCallId: "t1", ts: 1, mode: "assisted" } },
		{ id: "s2", kind: "custom", customType: "sam", data: { v: 1, kind: "fold", unitId: 1, entryIds: ["a"], spanFirstId: "a", spanLastId: "a", stub: "s1", verdict: "VERIFIED", sweep: "assisted", commitTiming: "cold", gate: { spanTok: 94, stubTok: 31, savedTok: 63, afterTok: 200, keepOut: 94 }, beforeTokens: 300, ts: 2, mode: "assisted" } },
		{ id: "s3", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 2, stub: "s2", toolCallId: "t2", ts: 3, mode: "assisted" } },
		{ id: "s4", kind: "custom", customType: "sam", data: { v: 1, kind: "noFold", unitId: 2, entryIds: ["b"], spanFirstId: "b", spanLastId: "b", stub: "s2", verdict: "VERIFIED", reason: "savings", reasons: ["savings: fold saves no tokens (stub >= span)"], ts: 4, mode: "assisted" } },
		{ id: "s5", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 3, stub: "s3", toolCallId: "t3", ts: 5, mode: "auto" } },
		{ id: "s6", kind: "custom", customType: "sam", data: { v: 1, kind: "foldLost", unitId: 3, basis: "commit-rejected: the fold batch never landed in the branch (pi all-or-nothing discard, measured on pi 0.87.1)", ts: 6 } },
	]);
	const unit1 = ledger.units.find((u) => u.unitId === 1);
	assert.equal(unit1?.state, "folded");
	assert.equal(unit1?.sweep, "assisted");
	assert.equal(unit1?.commitTiming, "cold");
	assert.equal(ledger.units.find((u) => u.unitId === 2)?.gateReasons?.length, 1);
	assert.equal(ledger.units.find((u) => u.unitId === 3)?.state, "resolved");
	assert.deepEqual(renderSamReport(ledger), [
		"unit 1: folded · pre-fold 300 tokens (pi estimate) · assisted sweep · cache cold",
		"unit 2: refused (savings · gates: savings: fold saves no tokens (stub >= span)…)",
		"unit 3: resolved (tombstone — commit-rejected: the fold batch never landed in the branch (pi all-or-nothing discard, measured on pi 0.87.1))",
	]);
});

test("output channel: ui > stderr > none (json is silent)", () => {
	assert.equal(samOutputChannel(true, "tui"), "ui");
	assert.equal(samOutputChannel(true, "rpc"), "ui");
	assert.equal(samOutputChannel(false, "print"), "stderr");
	assert.equal(samOutputChannel(false, "json"), "none");
});

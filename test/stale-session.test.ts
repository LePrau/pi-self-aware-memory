/**
 * v0.0.26 (2026-10-26): the stale-session tool heal — pure core
 * (src/stale-session.ts). All functions are total and side-effect free;
 * the wiring (pi.appendEntry / getActiveTools / setActiveTools at
 * session_start, the session_tree re-heal, the close backstop) is glue in
 * index.ts, covered live by probe Run G (dev repo
 * probe/stalesession-probe.mjs).
 *
 * The defect these guard against (measured, pi 1.3.0): resuming a session
 * that predates an extension upgrade restores the transcript's declared
 * tool set (a REPLACEMENT), dropping the new build's tools from the active
 * set — invisible AND unroutable; a fold replays the stale declaration.
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	SAM_VERSION_CUSTOM_TYPE,
	SAM_TOOL_NAMES,
	isSamVersionMarker,
	samVersionMarkers,
	latestSamVersion,
	compareSamVersion,
	missingSamTools,
	type SamVersionMarker,
} from "../src/stale-session.ts";
import { UPDATE_UNIT_TOOL } from "../src/protocol.ts";
import type { PlainEntry } from "../src/projection.ts";

let n = 0;
function customEntry(customType: string, data: unknown): PlainEntry {
	n += 1;
	return { id: `id-${n}`, kind: "custom", customType, data };
}
function messageEntry(): PlainEntry {
	n += 1;
	return { id: `id-${n}`, kind: "message", message: { role: "user", content: [{ type: "text", text: "x" }] } };
}

const MARKER = (version: string, ts: number): SamVersionMarker => ({ v: 1, version, ts });

test("constants: the marker customType is distinct from the ledger type; SAM_TOOL_NAMES is the 8 registered names", () => {
	assert.equal(SAM_VERSION_CUSTOM_TYPE, "sam/version");
	assert.notEqual(SAM_VERSION_CUSTOM_TYPE, "sam", "the marker must NOT be a ledger customType (the ledger rebuild counts unknown kinds as malformed)");
	assert.deepEqual([...SAM_TOOL_NAMES], [
		"close_unit",
		"update_unit",
		"retire_units",
		"unretire",
		"adjust_goal",
		"read_goal",
		"fold_now",
		"sam_retrieve",
	]);
	// cross-check against the protocol constant (the 8th tool, v0.0.25):
	assert.ok(SAM_TOOL_NAMES.includes(UPDATE_UNIT_TOOL.name), "SAM_TOOL_NAMES must carry the update_unit name verbatim");
	assert.ok(!SAM_TOOL_NAMES.includes("read"), "builtin tools are not SAM tools");
});

test("isSamVersionMarker: only a well-formed {v:1, version, ts} record passes", () => {
	assert.ok(isSamVersionMarker(MARKER("0.0.26", 1_700_000_000_000)));
	assert.ok(!isSamVersionMarker({ v: 2, version: "0.0.26", ts: 1 }), "wrong v");
	assert.ok(!isSamVersionMarker({ v: 1, version: 26, ts: 1 }), "version not a string");
	assert.ok(!isSamVersionMarker({ v: 1, version: "", ts: 1 }), "empty version");
	assert.ok(!isSamVersionMarker({ v: 1, version: "0.0.26" }), "ts missing");
	assert.ok(!isSamVersionMarker({ v: 1, version: "0.0.26", ts: "now" }), "ts not a number");
	assert.ok(!isSamVersionMarker(null));
	assert.ok(!isSamVersionMarker("0.0.26"));
	assert.ok(!isSamVersionMarker(undefined));
});

test("samVersionMarkers: only the marker customType counts, in branch order", () => {
	const branch: PlainEntry[] = [
		messageEntry(),
		customEntry("sam", { v: 1, kind: "close", unitId: 1, stub: "x" }), // ledger record — not a marker
		customEntry(SAM_VERSION_CUSTOM_TYPE, MARKER("0.0.24", 100)),
		customEntry(SAM_VERSION_CUSTOM_TYPE, { v: 1, version: "garbage", ts: "no" }), // malformed — skipped
		customEntry(SAM_VERSION_CUSTOM_TYPE, MARKER("0.0.25", 200)),
		messageEntry(),
	];
	const markers = samVersionMarkers(branch);
	assert.deepEqual(markers, [MARKER("0.0.24", 100), MARKER("0.0.25", 200)]);
});

test("latestSamVersion: undefined without a marker; highest ts wins; ties keep the first entry", () => {
	assert.equal(latestSamVersion([]), undefined);
	assert.equal(latestSamVersion([messageEntry()]), undefined);
	assert.equal(latestSamVersion([customEntry(SAM_VERSION_CUSTOM_TYPE, MARKER("0.0.24", 500))]), "0.0.24");
	assert.equal(latestSamVersion([
		customEntry(SAM_VERSION_CUSTOM_TYPE, MARKER("0.0.24", 500)),
		customEntry(SAM_VERSION_CUSTOM_TYPE, MARKER("0.0.25", 400)),
	]), "0.0.24", "the highest ts wins, not the last entry");
	assert.equal(latestSamVersion([
		customEntry(SAM_VERSION_CUSTOM_TYPE, MARKER("0.0.24", 500)),
		customEntry(SAM_VERSION_CUSTOM_TYPE, MARKER("0.0.25", 500)),
	]), "0.0.24", "on an ts tie the first (earlier) entry wins");
});

test("compareSamVersion: numeric dot-tuple compare for the warning text (older/newer)", () => {
	assert.ok(compareSamVersion("0.0.25", "0.0.26") < 0);
	assert.ok(compareSamVersion("0.0.26", "0.0.25") > 0);
	assert.equal(compareSamVersion("0.0.25", "0.0.25"), 0);
	assert.ok(compareSamVersion("0.0.9", "0.1.0") < 0, "numeric compare, not lexicographic (\"9\" > \"1\")");
	assert.equal(compareSamVersion("1.2.3", "1.2.3"), 0);
	assert.equal(compareSamVersion("0.1.0", "0.1.0.0"), 0, "trailing zero segments compare equal");
	// the detection itself is exact string inequality + the missing-tool diff
	// (any mismatch is stale, downgrade included) — compareSamVersion only
	// feeds the "older"/"newer" wording.
});

test("missingSamTools: registered-but-not-active, in SAM_TOOL_NAMES order; unregistered names never count", () => {
	const all = new Set<string>([...SAM_TOOL_NAMES, "read", "bash"]);
	const noneMissing = missingSamTools(SAM_TOOL_NAMES, all, all);
	assert.deepEqual(noneMissing, []);

	const registered = new Set<string>(["read", ...SAM_TOOL_NAMES]);
	const active = new Set<string>(["read", "close_unit", "adjust_goal", "fold_now"]);
	assert.deepEqual(missingSamTools(SAM_TOOL_NAMES, registered, active), [
		"update_unit",
		"retire_units",
		"unretire",
		"read_goal",
		"sam_retrieve",
	]);

	// a tool not registered in this process is NOT "missing" (nothing to heal):
	const noUpdateUnit = new Set<string>(["read", ...SAM_TOOL_NAMES.filter((x) => x !== "update_unit")]);
	assert.deepEqual(missingSamTools(SAM_TOOL_NAMES, noUpdateUnit, new Set(["read"])), [
		"close_unit",
		"retire_units",
		"unretire",
		"adjust_goal",
		"read_goal",
		"fold_now",
		"sam_retrieve",
	], "update_unit is absent from the registry — it must not appear in the missing list");
});

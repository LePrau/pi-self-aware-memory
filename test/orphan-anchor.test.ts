/**
 * Orphan-hatch + exact-anchor pins (2026-10-02; GO 2026-10-02, Paul):
 * "no llm call, bare skeleton of calls plus last model text marked as
 * 'orphaned' is good. the model probably can either just ignore, rederive or
 * check whats done" + "can the model retrieve only selected parts of a
 * tombstone, like read can access specific lines? … simple 'exact anchor'
 * search, and allowing to get just a substring of the content".
 *
 * Pure logic only (the handler-level arm is ARM-6 in d8d9-arms.test.ts).
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	computeOrphanZone,
	orphanRecord,
	orphanBlock,
	orphanRetrievalIdOf,
	anchorWindow,
	renderAnchorWindow,
	takeoverSummary,
	weakSettlementRecord,
	type RawEntry,
	type SamSettlementRecord,
} from "../src/branchaudit.ts";
import type { SamGoalRecord } from "../src/goal.ts";

const raw = (o: Partial<RawEntry> & { id: string }): RawEntry => ({
	type: "message",
	message: { role: "assistant", content: "" },
	...o,
});
const text = (t: string) => ({ type: "text", text: t });
const call = (name: string, arguments_: Record<string, unknown> = {}) => ({ type: "toolCall", name, arguments: arguments_ });

test("computeOrphanZone: excludes settled spans + goal capture; skeleton of calls; files; LAST text wins", () => {
	const entries: RawEntry[] = [
		raw({ id: "u1", type: "message", message: { role: "user", content: "goal-defining input" } }),
		raw({ id: "c1", type: "message", message: { role: "assistant", content: [call("close_unit", { stub: "s1" }), text("closed u1")] } }),
		raw({ id: "w1", type: "message", message: { role: "assistant", content: [call("read", { path: "audit/build-info.txt" }), text("reading the file")] } }),
		raw({ id: "w2", type: "message", message: { role: "assistant", content: [text("I think the latency sum is 139587 — but unconfirmed")] } }),
	];
	const zone = computeOrphanZone(entries, new Set(["u1", "c1"]));
	assert.ok(zone, "non-empty zone after exclusions");
	assert.deepEqual(zone?.entryIds, ["w1", "w2"], "the zone is exactly the excluded-free remainder");
	assert.deepEqual(zone?.calls, [{ name: "read", arg: "audit/build-info.txt" }], "the call skeleton is bare name+arg");
	assert.deepEqual(zone?.files, ["audit/build-info.txt"], "touched files from read args (sorted, deduped)");
	assert.equal(zone?.lastText, "I think the latency sum is 139587 — but unconfirmed", "the LAST model text of the zone (not the first)");
	assert.equal(zone?.callsTrunc, 0);
});

test("computeOrphanZone: empty when everything is excluded (null — summary unchanged)", () => {
	const entries: RawEntry[] = [raw({ id: "u1" }), raw({ id: "c1" })];
	assert.equal(computeOrphanZone(entries, new Set(["u1", "c1"])), null);
	assert.equal(computeOrphanZone([], new Set()), null);
});

test("computeOrphanZone: caps + truncation are deterministic", () => {
	const calls = Array.from({ length: 45 }, (_, i) => call("read", { path: `f${i}.txt` }));
	const long = "x".repeat(2000);
	const entries: RawEntry[] = [raw({ id: "a", message: { role: "assistant", content: calls } }), raw({ id: "b", message: { role: "assistant", content: [text(long)] } })];
	const zone = computeOrphanZone(entries, new Set());
	assert.ok(zone);
	assert.equal(zone.calls.length, 40, "the skeleton is capped at ORPHAN_CALLS_CAP");
	assert.equal(zone.callsTrunc, 5, "the drop count is reported");
	assert.ok(zone.lastText !== undefined && zone.lastText.length <= 900 + 5, "long text is head+tail capped");
	assert.ok(zone.lastText?.includes(" […] "), "the cap marker separates head and tail");
	assert.equal(zone.files.length, 45, "files are NOT capped (the index stays complete)");
});

test("computeOrphanZone: custom/compaction entries are not zone material (messages only)", () => {
	const entries: RawEntry[] = [
		{ id: "x1", type: "custom", customType: "sam", data: { kind: "settlement" } },
		{ id: "x2", type: "compaction", summary: "old", data: {} },
	];
	assert.equal(computeOrphanZone(entries, new Set()), null, "no messages ⇒ no zone");
});

test("orphanRecord: deterministic retrieval id; the pinned ORPHANED line shape; upgradable record", () => {
	const zoneA = computeOrphanZone([raw({ id: "w1", message: { role: "assistant", content: [text("svc-c looked like 8000")] } })], new Set());
	assert.ok(zoneA);
	const r1 = orphanRecord(zoneA, "fold-1", 1000);
	const r2 = orphanRecord(zoneA, "fold-1", 9999); // ts is NOT part of the id
	assert.match(r1.retrievalId, /^[0-9a-f]{12}$/, "12-hex retrieval id (same family as the settlement ids)");
	assert.equal(r1.retrievalId, r2.retrievalId, "deterministic (ts-independent)");
	assert.notEqual(r1.retrievalId, orphanRecord(zoneA, "fold-2", 1000).retrievalId, "fold-scoped");
	assert.match(r1.line, /^ORPHANED [0-9a-f]{12} UNVERIFIED \(unclosed-at-fold — system-extracted, NOT audited, not settled\): /, "the pinned line shape (labelled ORPHANED + UNVERIFIED)");
	assert.equal(r1.kind, "orphan", "kind discriminates from settlements (latest-wins chains stay per-kind)");
	assert.deepEqual(r1.spanFirstId, "w1");
});

test("orphanBlock: CALLS · FILES · LAST MODEL TEXT under the pinned header; the model's three dispositions are named", () => {
	const zone = computeOrphanZone([raw({ id: "w1", message: { role: "assistant", content: [call("read", { path: "audit/audit-log.txt" }), text("the build line says 2026.09.01")] } })], new Set());
	assert.ok(zone);
	const rec = orphanRecord(zone, "fold-1", 1);
	const block = orphanBlock(rec);
	assert.match(block, /^ORPHANED AT FOLD — unclosed at fold time:/, "the pinned section header");
	assert.ok(block.includes("NOT audited, NOT-YET-SETTLED"), "the disposition hint is there (UNVERIFIED — ignore, re-derive, or check)");
	assert.ok(block.includes(`[orphaned] ${rec.retrievalId}`), "the retrieval id rides the block");
	assert.ok(block.includes("CALLS: read(audit/audit-log.txt)"), "the bare call skeleton");
	assert.ok(block.includes("FILES: audit/audit-log.txt"), "the touched files");
	assert.ok(block.includes("LAST MODEL TEXT: the build line says 2026.09.01"), "the last model text, verbatim");
});

test("takeoverSummary: order goal → settlement → ORPHANED → pointer (weak after strong, goal first)", () => {
	const goal: SamGoalRecord = { v: 1, kind: "goal", text: "GOAL TEXT", ts: 1, basis: "takeover-fallback", userEntryId: "u1" };
	const settlement = weakSettlementRecord(1, "stub-1", ["audit/log.txt"], "audit-failed", 1);
	const zone = computeOrphanZone([raw({ id: "w1", message: { role: "assistant", content: [text("unconfirmed: svc-c=8000")] } })], new Set());
	assert.ok(zone);
	const orphan = orphanRecord(zone, "fold-1", 1);
	const sum = takeoverSummary(undefined, goal, [settlement], orphan);
	const iGoal = sum.indexOf("Goal (takeover fallback");
	const iSettle = sum.indexOf("SAM settlement record(s)");
	const iOrphan = sum.indexOf("ORPHANED AT FOLD");
	const iPointer = sum.indexOf("the blocks above");
	assert.ok(iGoal !== -1 && iSettle !== -1 && iOrphan !== -1 && iPointer !== -1, "all four sections render");
	assert.ok(iGoal < iSettle && iSettle < iOrphan && iOrphan < iPointer, "goal → settlement → orphaned → pointer");
	// and the previous variants are unchanged:
	assert.equal(takeoverSummary(undefined, goal, [], null), takeoverSummary(undefined, goal, []), "no orphan ⇒ byte-identical to the pre-orphan shape");
});

test("anchorWindow: first EXACT match, ±3-line window, total occurrences, 1-based hit line", () => {
	const lines = ["alpha", "beta", "the needle is here", "delta", "epsilon", "another the needle is here", "zeta"];
	const w = anchorWindow(lines, "needle");
	assert.ok(w.found);
	assert.equal(w.total, 2, "all exact occurrences are counted");
	assert.equal(w.hitLine, 3, "the FIRST occurrence wins (deterministic, no ranking)");
	assert.equal(w.head.length, 2, "±3 context — bounded above by the hit");
	assert.equal(w.tail.length, 3);
	assert.ok(w.hit.includes("the needle is here"));
	// case-sensitivity (exact):
	assert.equal(anchorWindow(lines, "NEEDLE").found, false, "case-sensitive (no fuzzy, no ranking)");
	// no match:
	assert.deepEqual(anchorWindow(lines, "not-present"), { found: false, total: 0, head: [], hit: "", tail: [], hitLine: 0 });
	// blank anchor = no-op (not an error):
	assert.equal(anchorWindow(lines, "   ").found, false);
});

test("anchorWindow: the window cap bounds long contexts; renderAnchorWindow is total (miss message, never a throw)", () => {
	const lines = Array.from({ length: 200 }, (_, i) => `L${i}`);
	const w = anchorWindow(lines, "L150", 100); // 100 above + hit + 49 below = 150
	assert.ok(w.found);
	assert.ok(w.head.length + w.tail.length <= 39, "the ±100 context is capped to the window budget (±3 default stays default; 39+1 hit)");
	const miss = renderAnchorWindow(anchorWindow(lines, "nope"), "the fold tombstone (f1)", "nope");
	assert.match(miss, /^ANCHOR NOT FOUND \(exact, case-sensitive\) in the fold tombstone \(f1\): 'nope'\./, "the miss is an actionable message");
	assert.match(renderAnchorWindow(w, "src", "L150"), /\[hit L151\] L150/, "the hit line is marked (1-based)");
	const first = anchorWindow(lines, "L0");
	assert.ok(renderAnchorWindow(first, "src", "L0").includes("(hit is the first line)"), "a first-line hit renders its bound");
	// the trailing bound:
	const last = anchorWindow(lines, "L199");
	assert.ok(renderAnchorWindow(last, "src", "L199").includes("(end of content)"), "a last-line hit renders its bound");
});

test("orphanRetrievalIdOf: stable + content-sensitive", () => {
	const a = orphanRetrievalIdOf("f1", "same-text", 3);
	assert.equal(a, orphanRetrievalIdOf("f1", "same-text", 3), "stable");
	assert.notEqual(a, orphanRetrievalIdOf("f1", "other-text", 3), "content-sensitive");
	assert.notEqual(a, orphanRetrievalIdOf("f1", "same-text", 4), "count-sensitive");
});

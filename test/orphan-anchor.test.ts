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
	keptTailIds,
	orphanZoneGapIds,
	orphanRecord,
	orphanBlock,
	orphanRetrievalIdOf,
	anchorWindow,
	renderAnchorWindow,
	takeoverSummary,
	weakSettlementRecord,
	stripOldOrphanBlocks,
	orphanKeepCount,
	ORPHAN_KEEP_DEFAULT,
	ORPHAN_HEADING_PREFIX,
	TAKEOVER_POINTER,
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
	assert.match(block, /^## ORPHANED AT FOLD · [0-9a-f]{12}$/m, "the pinned section heading (2026-10-05 markup)");
	assert.ok(block.includes("NOT audited, NOT-YET-SETTLED"), "the disposition hint is there (UNVERIFIED — ignore, re-derive, or check)");
	assert.ok(block.includes(rec.retrievalId), "the retrieval id rides the block (heading + the sam_retrieve pointer)");
	assert.ok(block.includes("**CALLS**\n- read(audit/audit-log.txt)"), "the bare call skeleton (one bullet per call)");
	assert.ok(block.includes("**FILES**\n- audit/audit-log.txt"), "the touched files");
	assert.ok(block.includes("**LAST MODEL TEXT**\nthe build line says 2026.09.01"), "the last model text, verbatim");
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

/* 2026-10-15 fix: carried-orphan cap (the measured 01a13a33 failure: 13 orphan
   blocks ≈ 30k chars riding every fold; orphan records carry no unitId, so
   retire_units cannot target them — the cap is the only bound). The CURRENT
   fold's own orphan block is never capped: a summary carries ≤ keep + 1. */

const orphanSec = (id: string, body: string) => `${ORPHAN_HEADING_PREFIX}${id}\n${body}`;

test("stripOldOrphanBlocks: total — at/below the cap ⇒ byte-identical; the stale carried pointer line is dropped", () => {
	const noOrphans = "no orphans here\njust prose";
	assert.equal(stripOldOrphanBlocks(noOrphans, 2), noOrphans, "no orphan headings ⇒ byte-identical (total)");
	const two = ["prose", orphanSec("aaaaaaaaaaaa", "one"), orphanSec("bbbbbbbbbbbb", "two")].join("\n\n");
	assert.equal(stripOldOrphanBlocks(two, 2), two, "exactly the cap ⇒ byte-identical (total)");
	assert.equal(stripOldOrphanBlocks("A\n\n" + TAKEOVER_POINTER, 2), "A", "a lone stale pointer line is dropped (the fresh render re-appends the pointer)");
});

test("stripOldOrphanBlocks: drops the OLDEST blocks, keeps the LAST `keep`, one blank between sections", () => {
	const three = ["prose that stays", orphanSec("aaaaaaaaaaaa", "one"), orphanSec("bbbbbbbbbbbb", "two"), orphanSec("cccccccccccc", "three")].join("\n\n");
	const out = stripOldOrphanBlocks(three, 2);
	assert.ok(!out.startsWith("## ORPHANED AT FOLD · aaaa"), "the oldest orphan is dropped");
	assert.ok(out.includes("prose that stays"), "the leading prose stays");
	assert.ok(out.includes(orphanSec("bbbbbbbbbbbb", "two")), "the second orphan stays");
	assert.ok(out.includes(orphanSec("cccccccccccc", "three")), "the newest orphan stays");
	assert.equal(out.match(/## ORPHANED AT FOLD · /g)!.length, 2, "exactly `keep` blocks remain");
	assert.ok(out.startsWith("prose that stays\n\n## ORPHANED AT FOLD · bbbb"), "one blank between the kept sections");
});

test("stripOldOrphanBlocks: keep = 0 drops every orphan block (everything from the first heading to EOF)", () => {
	const two = ["prose", orphanSec("aaaaaaaaaaaa", "one"), orphanSec("bbbbbbbbbbbb", "two"), "trailing prose"].join("\n\n");
	assert.equal(stripOldOrphanBlocks(two, 0), "prose", "everything from the first orphan heading is dropped");
	assert.equal(stripOldOrphanBlocks(two, -3), "prose", "negative keep behaves as 0");
});

test("orphanKeepCount: SAM_ORPHAN_KEEP dial discipline (default 2; non-finite/negative ⇒ default)", () => {
	assert.equal(ORPHAN_KEEP_DEFAULT, 2);
	assert.equal(orphanKeepCount({}), 2, "no env ⇒ default");
	assert.equal(orphanKeepCount({ SAM_ORPHAN_KEEP: "1" }), 1, "explicit override");
	assert.equal(orphanKeepCount({ SAM_ORPHAN_KEEP: "0" }), 0, "0 is legal (drop all carried orphans)");
	assert.equal(orphanKeepCount({ SAM_ORPHAN_KEEP: "" }), 2, "empty ⇒ default");
	assert.equal(orphanKeepCount({ SAM_ORPHAN_KEEP: "abc" }), 2, "non-numeric ⇒ default");
	assert.equal(orphanKeepCount({ SAM_ORPHAN_KEEP: "-1" }), 2, "negative ⇒ default");
	assert.equal(orphanKeepCount({ SAM_ORPHAN_KEEP: "3.9" }), 3, "floored");
});

test("takeoverSummary: the carried-orphan cap bounds prev; the CURRENT fold's orphan is never capped (≤ keep + 1 total)", () => {
	const goal: SamGoalRecord = { v: 1, kind: "goal", text: "G", ts: 1, basis: "takeover-fallback", userEntryId: "u1" };
	const settlement = weakSettlementRecord(1, "stub-1", ["audit/log.txt"], "audit-failed", 1);
	const oldOrphan = (tag: string) => orphanSec(`${tag}${"a".repeat(11)}`, `old body ${tag}`);
	const prev5 = ["o1", "o2", "o3", "o4", "o5"].map(oldOrphan).join("\n\n");
	const zone = computeOrphanZone([raw({ id: "w1", message: { role: "assistant", content: [text("fresh zone text")] } })], new Set());
	assert.ok(zone);
	const fresh = orphanRecord(zone, "fold-9", 9);
	const count = (s: string) => (s.match(/## ORPHANED AT FOLD · /g) ?? []).length;
	const sumDef = takeoverSummary(prev5, goal, [settlement], fresh);
	assert.equal(count(sumDef), 3, "default keep=2: the 2 NEWEST old orphans + the fresh one");
	assert.ok(!sumDef.includes("old body o1"), "o1 (oldest) is dropped");
	assert.ok(!sumDef.includes("old body o3"), "o3 is dropped");
	assert.ok(sumDef.includes("old body o4"), "o4 stays");
	assert.ok(sumDef.includes("old body o5"), "o5 stays");
	assert.ok(sumDef.includes("fresh zone text"), "the current fold's own orphan is never capped");
	const sumKeep1 = takeoverSummary(prev5, goal, [settlement], fresh, undefined, 1);
	assert.equal(count(sumKeep1), 2, "keep=1: the 1 newest old orphan + the fresh one");
	assert.equal(count(takeoverSummary(prev5, goal, [settlement], fresh, undefined, 0)), 1, "keep=0: only the fresh orphan");
	assert.equal(count(takeoverSummary(prev5, goal, [settlement], null)), 2, "no fresh orphan: prev keeps `keep` old blocks");
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

/* ── v0.0.36 (2026-11-15, Paul's orphan decision — option 2): orphaned units cover ONLY
 * the context actually LOST at the fold, never the retention tail itself. The kept raw
 * tail (from firstKeptEntryId to the end of the branch) is excluded from the orphan zone
 * at the fold site (index.ts merges keptTailIds into the existing `excluded` set, which
 * already carries the closed spans' resolve ids + the goal capture). Measured driver:
 * u143/u146 — every fold banks exactly one orphan record (the open span), 100% of them on
 * SAFE folds where the span's raw content stays in the live context. ── */

test("keptTailIds: the kept tail runs from the cut (inclusive) to the end of the branch", () => {
	const entries: RawEntry[] = ["a", "b", "c", "d", "e"].map((id) => raw({ id }));
	assert.deepEqual([...keptTailIds(entries, "c")], ["c", "d", "e"], "cut in the middle");
	assert.deepEqual([...keptTailIds(entries, "a")], ["a", "b", "c", "d", "e"], "cut at the head keeps everything");
	assert.deepEqual([...keptTailIds(entries, "e")], ["e"], "cut at the tail");
	assert.equal(keptTailIds(entries, "z").size, 0, "cut id not on the branch ⇒ empty (degrade to the pre-v0.0.36 zone)");
	assert.equal(keptTailIds(entries, undefined).size, 0, "no cut id ⇒ empty");
	assert.equal(keptTailIds(entries, "").size, 0, "empty cut id ⇒ empty");
	assert.equal(keptTailIds([], "a").size, 0, "empty branch ⇒ empty");
});

test("v0.0.36 SAFE fold: open span fully inside the kept tail ⇒ NO orphan zone (null — nothing lost, nothing banked)", () => {
	// The closed spans tile the head of the branch (excluded by their resolve ids, exactly as
	// the fold site builds `excluded`); the open span s1..s3 starts AT the cut — everything is kept.
	const closed = raw({ id: "r1", message: { role: "assistant", content: [text("closed unit span")] } });
	const s1 = raw({ id: "s1", message: { role: "assistant", content: [call("bash", { command: "gate" }), text("working")] } });
	const s2 = raw({ id: "s2", message: { role: "user", content: "next input" } });
	const s3 = raw({ id: "s3", message: { role: "assistant", content: [text("done-ish")] } });
	const branch = [closed, s1, s2, s3];
	const excluded = new Set<string>(["r1"]);
	for (const id of keptTailIds(branch, "s1")) excluded.add(id);
	assert.equal(computeOrphanZone(branch, excluded), null, "safe fold ⇒ no orphan record, no unit id, no ORPHANED section");
});

test("v0.0.36 STRADDLING fold: the orphan zone is exactly the LOST part (last close → pi's cut)", () => {
	const closed = raw({ id: "r1", message: { role: "assistant", content: [text("closed unit span")] } });
	const lost1 = raw({ id: "l1", message: { role: "assistant", content: [call("read", { path: "a.txt" }), text("reading the file")] } });
	const kept1 = raw({ id: "k1", message: { role: "user", content: "input inside the kept tail" } });
	const kept2 = raw({ id: "k2", message: { role: "assistant", content: [text("kept work")] } });
	const branch = [closed, lost1, kept1, kept2];
	const excluded = new Set<string>(["r1"]);
	for (const id of keptTailIds(branch, "k1")) excluded.add(id);
	const zone = computeOrphanZone(branch, excluded);
	assert.ok(zone, "a straddling fold still banks an orphan — for the lost part");
	assert.deepEqual(zone?.entryIds, ["l1"], "only the lost part is orphaned — the kept tail is never claimed");
	assert.deepEqual(zone?.calls, [{ name: "read", arg: "a.txt" }], "the skeleton covers the lost part only");
	assert.equal(zone?.lastText, "reading the file");
});

test("v0.0.36 degradation: cut id not on the branch ⇒ the WHOLE open span is orphaned (pre-v0.0.36 behaviour — never lossier)", () => {
	const closed = raw({ id: "r1", message: { role: "assistant", content: [text("closed unit span")] } });
	const o1 = raw({ id: "o1", message: { role: "assistant", content: [text("open work 1")] } });
	const o2 = raw({ id: "o2", message: { role: "user", content: "open input" } });
	const branch = [closed, o1, o2];
	const excluded = new Set<string>(["r1"]);
	for (const id of keptTailIds(branch, "not-on-branch")) excluded.add(id);
	const zone = computeOrphanZone(branch, excluded);
	assert.ok(zone);
	assert.deepEqual(zone?.entryIds, ["o1", "o2"], "no kept-tail exclusion possible ⇒ the old over-inclusive zone (still complete)");
});

/** A toolResult entry (RawEntry's typed message view lacks toolCallId — runtime-only field). */
const toolResult = (id: string, toolCallId: string, t: string): RawEntry => ({
	id,
	type: "message",
	message: { role: "toolResult", toolCallId, content: [text(t)] } as unknown as RawEntry["message"],
});
const samCloseRecord = (id: string, toolCallId: string): RawEntry => ({
	id,
	type: "custom",
	customType: "sam",
	data: { kind: "close", toolCallId },
});

test("v0.0.39 orphanZoneGapIds: exactly the preamble + each close's own toolResult; work content stays out", () => {
	const sys: RawEntry = { id: "sys", type: "message", message: { role: "system", content: "system prompt" } };
	const inj = raw({ id: "inj", message: { role: "user", content: "[sam-nudge] something injected" } });
	const u1 = raw({ id: "u1", message: { role: "user", content: "do the thing" } });
	const workTR = toolResult("tr-work", "tc-work", "work output");
	const closeRec = samCloseRecord("cr1", "tc-close");
	const closeTR = toolResult("tr-close", "tc-close", "Unit 1 closed — audit VERIFIED");
	const branch = [sys, inj, u1, workTR, closeRec, closeTR];
	const gap = orphanZoneGapIds(branch);
	assert.deepEqual([...gap].sort(), ["inj", "sys", "tr-close"], "preamble (system + injected pre-user entry) + the close's own toolResult");
	assert.ok(!gap.has("tr-work"), "a toolResult without a matching close record is work, not a gap entry");
	assert.ok(!gap.has("u1") && !gap.has("cr1"), "the first real user message and the close record itself are not gap entries");
	assert.equal(orphanZoneGapIds([]).size, 0, "empty branch ⇒ no gap");
});

test("v0.0.39 SAFE-2: a safe fold whose ONLY uncovered messages are span-gap entries ⇒ NO orphan zone (the live u162/u165 artifact)", () => {
	// Measured 2026-11-16 (zones u162/u165): the branch's only messages outside every
	// close span, the goal, and the kept tail were the system preamble + the old closes'
	// own toolResults — yet a fold there minted an orphan with calls 0 and no text.
	const sys: RawEntry = { id: "sys", type: "message", message: { role: "system", content: "system prompt" } };
	const u1 = raw({ id: "u1", message: { role: "user", content: "do the thing" } });
	const w1 = raw({ id: "w1", message: { role: "assistant", content: [call("bash", { command: "gate" }), text("working")] } });
	const closeRec = samCloseRecord("cr1", "tc1");
	const closeTR = toolResult("trc", "tc1", "Unit 1 closed — audit VERIFIED");
	const s1 = raw({ id: "s1", message: { role: "assistant", content: [text("post-close work")] } });
	const branch = [sys, u1, w1, closeRec, closeTR, s1];
	const excluded = new Set<string>(["u1", "w1"]); // unit 1's resolve ids
	for (const id of keptTailIds(branch, "trc")) excluded.add(id); // cut AT the close's toolResult ⇒ s1 kept
	assert.notEqual(computeOrphanZone(branch, excluded), null, "pre-v0.0.39: the gap entries alone manufactured a zone");
	const withGap = new Set(excluded);
	for (const id of orphanZoneGapIds(branch)) withGap.add(id);
	assert.equal(computeOrphanZone(branch, withGap), null, "v0.0.39: the gap exclusion empties the zone ⇒ no artifact orphan, no ORPHANED section");
});

test("v0.0.39 STRADDLING-2: the lost zone is exactly the lost work — the gap entries stay out", () => {
	const sys: RawEntry = { id: "sys", type: "message", message: { role: "system", content: "system prompt" } };
	const u1 = raw({ id: "u1", message: { role: "user", content: "do the thing" } });
	const w1 = raw({ id: "w1", message: { role: "assistant", content: [call("bash", { command: "gate" }), text("working")] } });
	const closeRec = samCloseRecord("cr1", "tc1");
	const closeTR = toolResult("trc", "tc1", "Unit 1 closed — audit VERIFIED");
	const s1 = raw({ id: "s1", message: { role: "assistant", content: [text("lost work")] } });
	const s2 = raw({ id: "s2", message: { role: "user", content: "later input" } });
	const branch = [sys, u1, w1, closeRec, closeTR, s1, s2];
	const excluded = new Set<string>(["u1", "w1"]);
	for (const id of keptTailIds(branch, "s2")) excluded.add(id); // s1 is LOST
	const withGap = new Set(excluded);
	for (const id of orphanZoneGapIds(branch)) withGap.add(id);
	const zone = computeOrphanZone(branch, withGap);
	assert.ok(zone);
	assert.deepEqual(zone?.entryIds, ["s1"], "exactly the lost work — the preamble and the old close's toolResult stay out of the zone");
});

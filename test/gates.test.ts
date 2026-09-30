/**
 * P3 tests: gates.ts — draft editability (port of pi v0.87.1's
 * appendContextEdit guards, the s5 discard class), tool-pair integrity
 * (ported hard-guard predicate), fold regions (extended second-fold),
 * savings/ceiling/window/keep-window arithmetic, and the composite chain
 * (drafts only exist after all gates pass — the banked placement rule).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	fitsWindowGate,
	foldedRegions,
	keepWindowGate,
	ceilingGate,
	defaultFoldCeiling,
	runCommitGates,
	savingsGate,
	PI_DEFAULT_KEEP_RECENT_TOKENS,
	PI_DEFAULT_RESERVE_TOKENS,
	spanTokenMass,
	spanIntersectsFoldedRegion,
	spanCompactionCoverage,
	stubTokenMass,
	toolPairIntegrity,
	validateDraftTargets,
} from "../src/gates.ts";
import { rebuildLedger, type SamLedger } from "../src/ledger.ts";
import type { PlainEntry } from "../src/projection.ts";

function user(id: string, text: string): PlainEntry {
	return { id, kind: "message", message: { role: "user", content: text } };
}
function assistantText(id: string, text: string): PlainEntry {
	return { id, kind: "message", message: { role: "assistant", content: text } };
}
function toolResult(id: string, toolCallId: string, text = "ok", toolName?: string): PlainEntry {
	return { id, kind: "message", message: { role: "toolResult", content: text, toolCallId, toolName, isError: false } };
}
function assistantToolCall(id: string, name: string, callId: string, args: unknown): PlainEntry {
	return { id, kind: "message", message: { role: "assistant", content: [{ type: "toolCall", name, id: callId, arguments: args }] } };
}
function contextEdit(id: string, targetId: string, replacement: { content: unknown } | null): PlainEntry {
	return { id, kind: "context_edit", targetId, replacement };
}

/* ── draft editability (port of pi v0.87.1 appendContextEdit guards) ─────── */

test("validateDraftTargets: editable message roles pass (user/assistant/toolResult)", () => {
	const branch: PlainEntry[] = [user("u1", "x"), assistantText("a1", "y"), toolResult("t1", "c1")];
	assert.deepEqual(validateDraftTargets([{ targetId: "u1" }, { targetId: "a1" }, { targetId: "t1" }], branch), []);
});

test("validateDraftTargets: missing target → not-found", () => {
	const branch: PlainEntry[] = [user("u1", "x")];
	const problems = validateDraftTargets([{ targetId: "ghost" }], branch);
	assert.equal(problems.length, 1);
	assert.equal(problems[0].reason, "not-found");
});

test("validateDraftTargets: non-message entries and non-editable roles are refused (the s5 discard class)", () => {
	const branch: PlainEntry[] = [
		user("u1", "x"),
		{ id: "s1", kind: "message", message: { role: "system", content: "sys" } },
		{ id: "b1", kind: "message", message: { role: "bashExecution", content: "", command: "ls", output: "x" } },
		contextEdit("e1", "u1", { content: "[Unit 1 ✓] stub" }),
		{ id: "c1", kind: "custom", customType: "sam", data: {} },
	];
	const problems = validateDraftTargets(
		[{ targetId: "s1" }, { targetId: "b1" }, { targetId: "e1" }, { targetId: "c1" }],
		branch,
	);
	assert.equal(problems.length, 4);
	assert.ok(problems.every((p) => p.reason === "non-editable"));
	assert.match(problems[0].detail, /message\/system does not contribute editable model content/);
	assert.match(problems[1].detail, /message\/bashExecution/);
	assert.match(problems[2].detail, /non-message entry \(kind context_edit\)/);
	assert.match(problems[3].detail, /non-message entry \(kind custom\)/);
});

/* ── tool-pair integrity (ported hard-guard predicate) ────────────────────── */

test("toolPairIntegrity: batch containing both sides of a pair passes", () => {
	const branch: PlainEntry[] = [
		user("u1", "task"),
		assistantToolCall("a1", "read", "c1", { path: "f" }),
		toolResult("t1", "c1", "file content"),
	];
	assert.deepEqual(toolPairIntegrity(new Set(["a1", "t1"]), branch), []);
});

test("toolPairIntegrity: dropping the result while the call survives is refused", () => {
	const branch: PlainEntry[] = [
		user("u1", "task"),
		assistantToolCall("a1", "read", "c1", { path: "f" }),
		toolResult("t1", "c1", "file content"),
	];
	const problems = toolPairIntegrity(new Set(["t1"]), branch);
	assert.equal(problems.length, 1);
	assert.equal(problems[0].kind, "orphaned-result");
	assert.equal(problems[0].otherId, "a1");
});

test("toolPairIntegrity: dropping the call while the result survives is refused", () => {
	const branch: PlainEntry[] = [
		user("u1", "task"),
		assistantToolCall("a1", "read", "c1", { path: "f" }),
		toolResult("t1", "c1", "file content"),
	];
	const problems = toolPairIntegrity(new Set(["a1"]), branch);
	assert.equal(problems.length, 1);
	assert.equal(problems[0].kind, "orphaned-call");
	assert.equal(problems[0].otherId, "t1");
});

test("toolPairIntegrity: pre-existing orphans are not the fold's problem", () => {
	const branch: PlainEntry[] = [
		toolResult("t1", "ghost-call", "orphan from before"),
		assistantToolCall("a1", "read", "never-answered", {}),
	];
	assert.deepEqual(toolPairIntegrity(new Set(["t1", "a1"]), branch), []);
});

/* ── fold regions (extended second-fold) ──────────────────────────────────── */

function foldedLedger(entryIds: string[], unitId = 1): SamLedger {
	return rebuildLedger([
		user("u1", "task"),
		{ id: "c1", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId, stub: "s", toolCallId: "tc", ts: 1, mode: "manual" } },
		{
			id: "c2",
			kind: "custom",
			customType: "sam",
			data: {
				v: 1,
				kind: "fold",
				unitId,
				entryIds,
				spanFirstId: entryIds[0],
				spanLastId: entryIds[entryIds.length - 1],
				stub: "s",
				verdict: "VERIFIED",
				beforeTokens: 100,
				ts: 2,
				mode: "manual",
			},
		},
	]);
}

test("foldedRegions: a folded unit's region includes its stub + null edits", () => {
	const branch: PlainEntry[] = [
		user("u1", "task"),
		assistantText("a1", "work"),
		user("u2", "task2"),
		contextEdit("e1", "u1", { content: "[Unit 1 ✓] stub" }),
		contextEdit("e2", "a1", null),
		assistantText("a2", "more"),
	];
	const regions = foldedRegions(foldedLedger(["u1", "a1"]), branch);
	assert.equal(regions.length, 1);
	assert.deepEqual([...regions[0].entryIds].sort(), ["a1", "e1", "e2", "u1"]);
});

test("spanIntersectsFoldedRegion: touching the region (span or its edits) is refused", () => {
	const branch: PlainEntry[] = [
		user("u1", "task"),
		assistantText("a1", "work"),
		user("u2", "task2"),
		contextEdit("e1", "u1", { content: "[Unit 1 ✓] stub" }),
		contextEdit("e2", "a1", null),
		assistantText("a2", "more"),
		user("u3", "task3"),
		assistantText("a3", "work3"),
	];
	const regions = foldedRegions(foldedLedger(["u1", "a1"]), branch);
	// candidate span crossing the fold's stub edit (the s5 shape):
	assert.notEqual(
		spanIntersectsFoldedRegion({ spanFirstId: "u1", spanLastId: "u3" }, branch, regions),
		undefined,
		"span containing the fold's context_edit entries must be refused",
	);
	// a clean span after the region:
	assert.equal(spanIntersectsFoldedRegion({ spanFirstId: "u3", spanLastId: "a3" }, branch, regions), undefined);
	// a span inside the folded messages:
	assert.notEqual(spanIntersectsFoldedRegion({ spanFirstId: "u1", spanLastId: "a1" }, branch, regions), undefined);
});

test("foldedRegions: an UNDONE unit is not a region (re-fold is legitimate)", () => {
	const branch: PlainEntry[] = [
		user("u1", "task"),
		assistantText("a1", "work"),
		contextEdit("e1", "u1", { content: "[Unit 1 ✓] stub" }),
		contextEdit("e2", "a1", null),
		contextEdit("e3", "u1", { content: "task" }),
		contextEdit("e4", "a1", { content: "work" }),
		user("u2", "task2"),
		assistantText("a2", "work2"),
	];
	const ledger = rebuildLedger([
		user("u1", "task"),
		assistantText("a1", "work"),
		{ id: "c1", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "tc", ts: 1, mode: "manual" } },
		{
			id: "c2",
			kind: "custom",
			customType: "sam",
			data: { v: 1, kind: "fold", unitId: 1, entryIds: ["u1", "a1"], spanFirstId: "u1", spanLastId: "a1", stub: "s", verdict: "VERIFIED", beforeTokens: 100, ts: 2, mode: "manual" },
		},
		{ id: "c3", kind: "custom", customType: "sam", data: { v: 1, kind: "undo", unitId: 1, targets: ["u1", "a1"], ts: 3 } },
		user("u2", "task2"),
		assistantText("a2", "work2"),
	]);
	assert.equal(ledger.units.find((u) => u.unitId === 1)?.state, "undone");
	assert.equal(foldedRegions(ledger, branch).length, 0, "an undone unit leaves no folded region");
});

/* ── arithmetic (deterministic: the single ruler is chars/4, F3) ─────────── */

test("savingsGate: boundary pinned (ratio vs SPAN, stub ≤ 8 tokens always passes)", () => {
	assert.equal(savingsGate(200, 30).ok, true, "85 % saved passes");
	assert.equal(savingsGate(200, 180).ok, true, "exactly 10 % saved passes (boundary inclusive)");
	assert.equal(savingsGate(200, 181).ok, false, "9.5 % saved is refused");
	assert.equal(savingsGate(200, 200).ok, false, "zero savings is refused (anti-self-sealing)");
	assert.equal(savingsGate(10, 3).ok, true, "tiny span, header-only stub: saved 7 → 70 % → passes");
	assert.equal(savingsGate(10, 10).ok, false, "no savings, stub > 8 tokens → refused");
});

test("savingsGate: a 71 % stub on a 20-token span is refused unless it saves ≥ 2 (pin)", () => {
	// span 20 tokens, stub 15 tokens → saved 5 → 25 % → passes.
	assert.equal(savingsGate(20, 15).ok, true);
	// span 20, stub 19 → saved 1 → 5 % → refused, and stub > 8 tokens → refused.
	assert.equal(savingsGate(20, 19).ok, false);
	// span 20, stub 8 → passed by the ≤8 clause even though saved 6/20 = 30 %.
	assert.equal(savingsGate(20, 8).ok, true);
});

test("ceilingGate: span above the ceiling is refused (F5)", () => {
	assert.equal(ceilingGate(1000, 16384).ok, true);
	assert.equal(ceilingGate(20000, 16384).ok, false);
	assert.match(ceilingGate(20000, 16384).reasons[0], /F5/);
});

test("defaultFoldCeiling: quarter window, clamped; no window → 16384", () => {
	assert.equal(defaultFoldCeiling(0), 16384);
	assert.equal(defaultFoldCeiling(undefined), 16384);
	assert.equal(defaultFoldCeiling(32768), 8192);
	assert.equal(defaultFoldCeiling(131072), 32768);
	assert.equal(defaultFoldCeiling(1_000_000), 65536, "upper clamp");
});

test("fitsWindowGate: post-fold above the native trigger is refused; unknowns pass", () => {
	// window 32768, reserve 16384 → trigger 16384.
	assert.equal(fitsWindowGate(20000, 5000, 32768, 16384).ok, true, "after 15000 ≤ trigger 16384 → passes");
	const refused = fitsWindowGate(22000, 5000, 32768, 16384);
	assert.equal(refused.ok, false, "after 17000 > trigger → refused");
	assert.match(refused.reasons[0], /native trigger/);
	const beforeUnknown = fitsWindowGate(null, 5000, 32768, 16384);
	assert.equal(beforeUnknown.ok, true, "no known before-estimate: pass, no fabrication");
	assert.equal(beforeUnknown.afterTokens, null);
	const noWindow = fitsWindowGate(20000, 5000, 0, 16384);
	assert.equal(noWindow.ok, true, "no known window: pass, no fabrication");
});

test("keepWindowGate: outside the keep window passes, fully inside is refused (§3.4)", () => {
	// 60 messages × 1000 tokens = 60000; keep 20000 → keep window = tail
	// 40000..60000. (Keep clamps to total: with the MEASURED v0.87.1 default
	// (20k), sessions under ~20k tokens are fully inside ⇒ automatic folds
	// refuse — the documented conservative posture; P4 tunes the defaults.)
	const branch: PlainEntry[] = [];
	for (let i = 0; i < 60; i++) branch.push({ id: `m${i}`, kind: "message", message: { role: "assistant", content: "x".repeat(4000) } });
	const early = keepWindowGate({ entryIds: branch.slice(0, 4).map((e) => e.id) }, branch, 60000, PI_DEFAULT_KEEP_RECENT_TOKENS);
	assert.equal(early.ok, true, "tokens 0..4000 are outside keep 40000..60000 → passes for automatic folds");
	assert.equal(early.outsideKeepTokens, 4000);

	const late = keepWindowGate({ entryIds: branch.slice(56, 60).map((e) => e.id) }, branch, 60000, PI_DEFAULT_KEEP_RECENT_TOKENS);
	assert.equal(late.ok, false, "tokens 56000..60000 fully inside the keep window → refused");
	assert.match(late.reasons[0], /keep window/);

	// a span crossing the 40000 boundary (starts at 32000, ends at 40000):
	const crossing = keepWindowGate({ entryIds: branch.slice(32, 40).map((e) => e.id) }, branch, 60000, PI_DEFAULT_KEEP_RECENT_TOKENS);
	assert.equal(crossing.ok, true, "32000..40000 straddles the boundary → 8000 outside → passes");
	assert.equal(crossing.outsideKeepTokens, 8000);
});

test("spanTokenMass + stubTokenMass: the single ruler (chars/4)", () => {
	const branch: PlainEntry[] = [user("u1", "ab".repeat(100))]; // 200 chars → 50 tokens
	assert.equal(spanTokenMass({ entryIds: ["u1"] }, branch), 50);
	assert.equal(stubTokenMass(1, ""), Math.ceil("[Unit 1 ✓] ".length / 4));
});

/* ── the composite chain ──────────────────────────────────────────────────── */

test("runCommitGates: a clean span against a folded NEIGHBOUR passes (manual close = intent)", () => {
	const branch: PlainEntry[] = [
		user("u1", "task1 " + "x".repeat(200)),
		assistantText("a1", "work1 " + "x".repeat(200)),
		contextEdit("e1", "u1", { content: "[Unit 1 ✓] stub" }),
		contextEdit("e2", "a1", null),
		user("u2", "task2 " + "x".repeat(200)),
		assistantText("a2", "work2 " + "x".repeat(200)),
	];
	const outcome = runCommitGates({
		spanFirstId: "u2",
		spanLastId: "a2",
		spanEntryIds: ["u2", "a2"],
		targetIds: ["u2", "a2"],
		unitId: 2,
		stub: "did task2 (observed: file written)",
		branch,
		ledger: foldedLedger(["u1", "a1"]),
		beforeTokens: 3000,
		contextWindow: 32768,
		applyKeepWindow: false, // explicit close_unit: intent, not keep-window restricted
	});
	assert.equal(outcome.ok, true, `expected clean pass, got: ${outcome.reasons.join(" ; ")}`);
});

test("runCommitGates: the SAME span as an AUTOMATIC fold — the arithmetic gates decide (pinned)", () => {
	const branch: PlainEntry[] = [
		user("u1", "task1 " + "x".repeat(200)),
		assistantText("a1", "work1 " + "x".repeat(200)),
		contextEdit("e1", "u1", { content: "[Unit 1 ✓] stub" }),
		contextEdit("e2", "a1", null),
		user("u2", "task2 " + "x".repeat(200)),
		assistantText("a2", "work2 " + "x".repeat(200)),
	];
	const base = {
		spanFirstId: "u2",
		spanLastId: "a2",
		spanEntryIds: ["u2", "a2"],
		targetIds: ["u2", "a2"],
		unitId: 2,
		stub: "did task2 (observed: file written)",
		branch,
		ledger: foldedLedger(["u1", "a1"]),
		contextWindow: 32768,
		applyKeepWindow: true,
	};
	// (a) Under the MEASURED v0.87.1 defaults (reserve 16384, keep 20000) at a
	// 32k window the two gates are mutually exclusive BY DESIGN: the session is
	// either small enough that the keep window clamps to the whole branch (keep
	// window refuses) or big enough that the fold cannot bring it under the
	// native trigger (window-fit refuses). Pin the first shape:
	const small = runCommitGates({ ...base, beforeTokens: 16000 });
	assert.equal(small.ok, false);
	assert.match(small.reasons.find((r) => r.startsWith("keep-window")) as string, /keep window/);
	// (b) A session the fold cannot rescue (100k − ~100 ≥ trigger) is refused
	// by the window-fit gate BEFORE the keep window is consulted:
	const huge = runCommitGates({ ...base, beforeTokens: 100_000 });
	assert.equal(huge.ok, false);
	assert.match(huge.reasons.find((r) => r.startsWith("window")) as string, /native trigger/);
	// (c) With a TUNED keep window (the P4 posture), the §3.4 gate does its
	// honest job: span near the start of a 16k session, keep 4000 → outside:
	const tuned = runCommitGates({ ...base, beforeTokens: 16000, keepRecentTokens: 4000 });
	assert.equal(tuned.ok, true, `tuned keep window: automatic fold passes, got: ${tuned.reasons.join(" ; ")}`);
	const spanTokens = tuned.arithmetic.spanTokens; // ~104
	assert.equal(tuned.arithmetic.outsideKeepTokens, spanTokens, "the whole span sits outside the tuned keep window");
});

test("runCommitGates: a span crossing the fold region is refused — the s5 class, pinned by reason", () => {
	const branch: PlainEntry[] = [
		user("u1", "task1 " + "x".repeat(200)),
		assistantText("a1", "work1 " + "x".repeat(200)),
		contextEdit("e1", "u1", { content: "[Unit 1 ✓] stub" }),
		contextEdit("e2", "a1", null),
		user("u2", "task2 " + "x".repeat(200)),
		assistantText("a2", "work2 " + "x".repeat(200)),
	];
	const outcome = runCommitGates({
		spanFirstId: "u1",
		spanLastId: "a2",
		spanEntryIds: ["u1", "a1", "u2", "a2"],
		targetIds: ["u1", "a1", "u2", "a2"],
		unitId: 2,
		stub: "did everything",
		branch,
		ledger: foldedLedger(["u1", "a1"]),
		beforeTokens: 3000,
		contextWindow: 32768,
		applyKeepWindow: true,
	});
	assert.equal(outcome.ok, false);
	assert.match(outcome.reasons.find((r) => r.startsWith("second-fold")) as string, /unit 1/);
});

test("runCommitGates: a span containing a system message is refused before any draft (P3 exit test)", () => {
	const branch: PlainEntry[] = [
		user("u1", "task " + "x".repeat(200)),
		{ id: "s1", kind: "message", message: { role: "system", content: "injected system line" } },
		assistantText("a1", "work " + "x".repeat(200)),
	];
	const outcome = runCommitGates({
		spanFirstId: "u1",
		spanLastId: "a1",
		spanEntryIds: ["u1", "s1", "a1"],
		targetIds: ["u1", "s1", "a1"],
		unitId: 1,
		stub: "did work",
		branch,
		ledger: rebuildLedger([]),
		beforeTokens: 3000,
		contextWindow: 32768,
		applyKeepWindow: false,
	});
	assert.equal(outcome.ok, false);
	assert.ok(
		outcome.reasons[0].startsWith("draft"),
		`the draft-editability gate fires first, got: ${outcome.reasons[0]}`,
	);
	assert.match(outcome.reasons[0], /draft: message\/system does not contribute editable model content/);
});

test("runCommitGates: a stub longer than the span is refused (anti-self-sealing)", () => {
	const branch: PlainEntry[] = [
		{ id: "u1", kind: "message", message: { role: "assistant", content: "x".repeat(400) } },
		{ id: "a1", kind: "message", message: { role: "assistant", content: "y".repeat(400) } },
	]; // 200 tokens of span
	const base = {
		spanFirstId: "u1",
		spanLastId: "a1",
		spanEntryIds: ["u1", "a1"],
		targetIds: ["u1", "a1"],
		unitId: 1,
		branch,
		ledger: rebuildLedger([]),
		beforeTokens: 3000,
		contextWindow: 32768,
		applyKeepWindow: false,
	};
	assert.equal(runCommitGates({ ...base, stub: "z".repeat(220) }).ok, true, "~71 % saved passes (the gate is about waste, not quality)");
	const refused = runCommitGates({ ...base, stub: "z".repeat(900) });
	assert.equal(refused.ok, false);
	assert.match(refused.reasons[0], /savings/);
});

test("PI defaults are the v0.87.1 measured values (provenance pin)", () => {
	assert.equal(PI_DEFAULT_RESERVE_TOKENS, 16384);
	assert.equal(PI_DEFAULT_KEEP_RECENT_TOKENS, 20000);
});

/* ── P4 R3: compaction coverage — policy input, deliberately NOT a gate ──── */

function compaction(id: string, firstKeptEntryId: string, summary = "summary"): PlainEntry {
	return { id, kind: "compaction", summary, firstKeptEntryId };
}

test("R3 coverage: live-bank geometry ⇒ covered (span before the kept boundary, compaction after)", () => {
	// Reconstructed from the 2026-09-30 live bank (session 01a0f294, measured,
	// F1): span entries 5..35, compaction at 107 with firstKeptEntryId at 97
	// ⇒ 35 < 97 ⇒ fully inside the summarized prefix.
	const branch: PlainEntry[] = [];
	for (let i = 0; i < 5; i++) branch.push(user(`p${i}`, "prefix " + i));
	const span = [user("s1", "the unit work"), assistantText("s2", "did it"), toolResult("s3", "c1")];
	for (const e of span) branch.push(e);
	for (let i = 0; i < 61; i++) branch.push(assistantText(`m${i}`, "marathon turn " + i));
	const keptId = branch[5 + 3 + 41].id; // firstKeptEntryId lands INSIDE the kept block, after the span
	branch.push(compaction("c0", keptId));
	const r = spanCompactionCoverage(branch, span.map((e) => e.id));
	assert.equal(r.covered, true, "span strictly before the kept boundary ⇒ already out of the view");
	assert.equal(r.compactionEntryId, "c0");
});

test("R3 coverage: kept boundary before the span tail ⇒ not covered (the span is still in view)", () => {
	const s1 = user("s1", "a");
	const s2 = assistantText("s2", "b");
	const s3 = toolResult("s3", "c1");
	const branch: PlainEntry[] = [s1, s2, s3, compaction("c0", s2.id)]; // kept = s2 ⇒ s2, s3 in view
	const r = spanCompactionCoverage(branch, [s1.id, s2.id, s3.id]);
	assert.equal(r.covered, false);
});

test("R3 coverage: span written AFTER the compaction ⇒ not covered (it survived the checkpoint)", () => {
	const u = user("u0", "before");
	const a = assistantText("a0", "after the compaction");
	const branch: PlainEntry[] = [u, compaction("c0", u.id), a];
	assert.equal(spanCompactionCoverage(branch, [a.id]).covered, false, "only entries before firstKeptEntryId are summarized");
});

test("R3 coverage: firstKeptEntryId absent from the branch ⇒ covered (everything before the compaction is summarized)", () => {
	const branch: PlainEntry[] = [user("u0", "x"), assistantText("a0", "y"), compaction("c0", "pruned-id")];
	const r = spanCompactionCoverage(branch, ["u0", "a0"]);
	assert.equal(r.covered, true);
	assert.equal(r.compactionEntryId, "c0");
});

test("R3 coverage: no compaction / unresolvable span ids ⇒ not covered (fail-safe)", () => {
	const u = user("u0", "x");
	assert.equal(spanCompactionCoverage([u], [u.id]).covered, false);
	assert.equal(spanCompactionCoverage([u], ["ghost"]).covered, false, "unresolvable span ids never count as covered");
	assert.equal(spanCompactionCoverage([u], []).covered, false);
});

test("R3 coverage: the NEWEST compaction decides (pi keeps only the newest checkpoint)", () => {
	const s1 = user("s1", "span");
	const kept1 = assistantText("k1", "kept by the older one");
	const branch: PlainEntry[] = [s1, compaction("cOld", kept1.id), kept1, compaction("cNew", s1.id)];
	// cOld would cover the span (kept1 after it); cNew (newer) keeps s1 ⇒ in view.
	const r = spanCompactionCoverage(branch, [s1.id]);
	assert.equal(r.covered, false, "the newest checkpoint wins");
});

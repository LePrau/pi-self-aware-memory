/**
 * P3 tests: governor.ts — pressure ladder + hysteresis, model_select
 * recompute, guard facts R1/R2, R3 de-escalation, R4/R5 sweep selection and
 * backoff, the D2 coexistence guard, and the positive-only probe contract.
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	modelSignature,
	ladderFor,
	pressureZone,
	closeAuditZone,
	activeFacts,
	resolveFactIfPositive,
	userDeescalationActive,
	recordSweepReject,
	sweepEligible,
	sweepCandidates,
	selectAutoSpan,
	detectForeignFolder,
	foreignFolderEvidence,
	coexistenceGate,
	buildProbeUrl,
	parseBusyStatus,
	busynessGate,
	PROBE_DEFERRALS_PER_CLOSE,
	NON_TERMINAL_COOLOWN_SETTLES,
} from "../src/governor.ts";
import { isSamInjected } from "../src/protocol.ts";
import { messageText } from "../src/projection.ts";
import type { PlainEntry } from "../src/projection.ts";

function user(id: string, text: string): PlainEntry {
	return { id, kind: "message", message: { role: "user", content: text } };
}
function assistantText(id: string, text: string): PlainEntry {
	return { id, kind: "message", message: { role: "assistant", content: text } };
}

/* ── model identity + ladder ─────────────────────────────────────────────── */

test("modelSignature: identity includes provider, id, and window (diff target)", () => {
	assert.notEqual(modelSignature({ provider: "a", id: "m" }), modelSignature({ provider: "a", id: "m2" }));
	assert.notEqual(modelSignature({ provider: "a", id: "m" }), modelSignature({ provider: "a", id: "m", contextWindow: 32768 }));
	assert.equal(modelSignature(null), "none");
	assert.equal(modelSignature(undefined), "none");
});

test("ladderFor: inert without a window (fail-safe); band ≥ 1024", () => {
	assert.equal(ladderFor(null, null), null);
	assert.equal(ladderFor(0), null);
	const ladder = ladderFor(32768, null);
	assert.ok(ladder);
	assert.equal(ladder.window, 32768);
	assert.equal(ladder.band, Math.max(1024, Math.round(16384 / 4)), "band = max(1024, reserve/4)");
	// the model's own window is the fallback
	const fromModel = ladderFor(undefined, { provider: "p", id: "m", contextWindow: 65536 });
	assert.equal(fromModel?.window, 65536);
});

test("pressureZone: enter/exit hysteresis — a fold's own relief does not re-flap", () => {
	const ladder = ladderFor(131072, null)!; // W=131072 R=16384 band=4096
	const actionEnter = 131072 - 16384; // 114688
	const watchEnter = 131072 - 2 * 16384; // 98304
	// below watch: calm
	assert.equal(pressureZone(ladder, 90_000), "calm");
	assert.equal(pressureZone(ladder, 98_299), "calm", "one below watchEnter → calm");
	assert.equal(pressureZone(ladder, watchEnter), "watch", "at watchEnter → watch");
	// watch entry: ≥ W − 2R = 98304
	assert.equal(pressureZone(ladder, 99_000), "watch", "99k ≥ 98304 → watch");
	assert.equal(pressureZone(ladder, 98_000), "calm", "98k < 98304 → calm");
	// action entry: ≥ 114688
	assert.equal(pressureZone(ladder, 114_688), "action");
	assert.equal(pressureZone(ladder, 114_687), "watch", "one below the action line → watch (still ≥ watchEnter)");
	// hysteresis: once in action, stay until actionExit = 114688 − 4096 = 110592
	assert.equal(pressureZone(ladder, 111_000, "action"), "action", "111k is below actionEnter but above actionExit — hysteresis holds");
	assert.equal(pressureZone(ladder, 110_000, "action"), "watch", "below actionExit → fall to watch (watchExit = 98304−4096 = 94208 ≤ 110k)");
	assert.equal(pressureZone(ladder, 95_000, "watch"), "watch", "hysteresis in watch too (95k ≥ 94208)");
	assert.equal(pressureZone(ladder, 94_000, "watch"), "calm", "below watchExit → calm");
	// null tokens keep the previous zone (no fabricated ruler, F3); first-time null is calm
	assert.equal(pressureZone(ladder, null, "action"), "action");
	assert.equal(pressureZone(ladder, null), "calm");
});

test("closeAuditZone: FRESH zone at close time (2026-10-02, Paul: 'the inheritance should be avoided — after a fold context SHOULD be safe') — live-ctx entry thresholds; strict when unknown", () => {
	const ladder = ladderFor(131072, null)!; // W=131072 R=16384 band=4096
	const watchEnter = 131072 - 2 * 16384; // 98304
	const actionEnter = 131072 - 16384; // 114688
	assert.equal(closeAuditZone(ladder, 90_000), "calm", "below the band → calm (full)");
	assert.equal(closeAuditZone(ladder, watchEnter), "watch", "at the watch line → light");
	assert.equal(closeAuditZone(ladder, actionEnter), "action", "at the action line → light");
	// the measured rep shapes (pre-fix these closes dispatched LIGHT via the stale
	// stored zone — the stored state is NO LONGER AN INPUT to this ruling):
	assert.equal(closeAuditZone(ladder, 5_000), "calm", "a post-fold low ctx → full depth");
	const small = ladderFor(49152, null)!; // the battery geometry
	assert.equal(closeAuditZone(small, 36_621), "action", "rep-7 u5's close (36,621 @ 49,152) → action (light stays legal in-band)");
	assert.equal(closeAuditZone(small, 5_392), "calm", "rep-7 u4's close (5,392 @ 49,152) → calm (full)");
	assert.equal(closeAuditZone(small, 4_297), "calm", "rep-3 u2's close (4,297 @ 49,152) → calm (full)");
	// strict fail-safe (the battery's "ruler unavailable ⇒ strict" reading):
	assert.equal(closeAuditZone(null, 99_000), "calm", "no ladder ⇒ calm (full)");
	assert.equal(closeAuditZone(ladder, null), "calm", "no tokens yet ⇒ calm (full)");
	assert.equal(closeAuditZone(ladder, undefined), "calm");
	assert.equal(closeAuditZone(ladder, Number.NaN), "calm");
	assert.equal(closeAuditZone(ladder, -5), "calm", "negative ⇒ calm");
});

/* ── guard facts (R1 / R2) ───────────────────────────────────────────────── */

test("R1: a guard fact persists until POSITIVE evidence; silence never resolves", () => {
	const facts = [{ unitId: 3, kind: "disputed-stub" as const, basis: "audit CORRECTIONS", sinceSettle: 5 }];
	assert.equal(activeFacts(facts).length, 1);
	// a fact on a DIFFERENT unit is untouched:
	assert.equal(resolveFactIfPositive(facts, 4, "disputed-stub", "undo", 9), null, "different unit: no change");
	// positive evidence resolves exactly the matching fact:
	const after = resolveFactIfPositive(facts, 3, "disputed-stub", "user-resolved", 9);
	assert.ok(after);
	assert.equal(activeFacts(after).length, 0, "positive evidence resolves");
});

test("R2: a resolved fact stays in the list as a tombstone, never reactivated", () => {
	const facts = [{ unitId: 3, kind: "disputed-stub" as const, basis: "b", sinceSettle: 5 }];
	const resolved = resolveFactIfPositive(facts, 3, "disputed-stub", "undo", 8);
	assert.ok(resolved);
	assert.equal(resolved[0].resolvedSettle, 8);
	assert.equal(resolveFactIfPositive(resolved as typeof facts, 3, "disputed-stub", "undo", 9), null, "already resolved: no further change");
	// a NEW fact on the same unit is a new fact (rejection after resolution is fresh evidence)
	const newFacts = [...(resolved as typeof facts), { unitId: 3, kind: "gate-reject" as const, basis: "savings: ...", sinceSettle: 10 }];
	const again = resolveFactIfPositive(newFacts, 3, "gate-reject", "override-fold", 12);
	assert.ok(again);
	assert.equal(again.find((f) => f.kind === "gate-reject")?.resolvedSettle, 12);
	assert.equal(again.find((f) => f.kind === "disputed-stub")?.resolvedSettle, 8);
});

/* ── R3 de-escalation ────────────────────────────────────────────────────── */

test("R3: a mode de-escalation blocks sweeps until a positive re-escalation", () => {
	assert.equal(userDeescalationActive([]), false);
	assert.equal(userDeescalationActive([{ from: "manual", to: "assisted" }]), false, "escalation: not a de-escalation");
	assert.equal(userDeescalationActive([{ from: "auto", to: "display" }]), true, "de-escalation active");
	assert.equal(userDeescalationActive([{ from: "assisted", to: "manual" }]), true);
	assert.equal(
		userDeescalationActive([
			{ from: "assisted", to: "manual" },
			{ from: "manual", to: "assisted" },
		]),
		false,
		"re-escalation clears it (the user positively escaped)",
	);
	assert.equal(
		userDeescalationActive([
			{ from: "manual", to: "assisted" },
			{ from: "assisted", to: "auto" },
			{ from: "auto", to: "display" },
		]),
		true,
		"the LATEST direction change decides",
	);
});

/* ── R5 backoff ──────────────────────────────────────────────────────────── */

test("R5: terminal rejects never auto-retry; non-terminal cool down 8 settles", () => {
	const memory = new Map();
	// terminal: the reason HEAD is a terminal class
	recordSweepReject(memory, 7, ["second-fold: the span intersects folded unit 1's region"], 10);
	assert.equal(sweepEligible(memory, 7, 99), false, "terminal reasons are never eligible again");
	// non-terminal: head not in the terminal set
	recordSweepReject(memory, 8, ["provider-degraded: upstream 503 (non-terminal)"], 10);
	assert.equal(sweepEligible(memory, 8, 10 + NON_TERMINAL_COOLOWN_SETTLES - 1), false, "still cooling");
	assert.equal(sweepEligible(memory, 8, 10 + NON_TERMINAL_COOLOWN_SETTLES), true, "cooled down");
	// an unknown unit is eligible (no memory)
	assert.equal(sweepEligible(memory, 99, 0), true);
});

/* ── R4 sweep candidates ─────────────────────────────────────────────────── */

function ledgerFixture(units: Record<number, { state: string; verdictClass?: string; reason?: string }>) {
	// minimal fake ledger — sweepCandidates only reads units[].state/verdict/reason
	return { units: Object.entries(units).map(([id, u]) => ({
		unitId: Number(id),
		stub: `s${id}`,
		state: u.state as never,
		verdict: u.verdictClass ? { class: u.verdictClass as never, corrections: undefined } : undefined,
		reason: u.reason,
	})) } as never;
}

test("R4: only VERIFIED display-era refused units are sweep candidates — CORRECTIONS never", () => {
	const ledger = ledgerFixture({
		1: { state: "refused", verdictClass: "VERIFIED", reason: "display mode" },
		2: { state: "refused", verdictClass: "CORRECTIONS", reason: "verdict CORRECTIONS" },
		3: { state: "refused", verdictClass: "VERIFIED", reason: "savings: net saving 3% < 10% of the span" },
		4: { state: "folded" },
		5: { state: "refused", verdictClass: "VERIFIED", reason: "display mode" },
	});
	assert.deepEqual(sweepCandidates(ledger), [1, 5], "oldest first; CORRECTIONS and gate-refused units excluded (R4 + disputed-stub rule)");
});

/* ── auto span selection ─────────────────────────────────────────────────── */

test("selectAutoSpan: oldest CLOSED-OFF work block; open tail never touched", () => {
	const branch: PlainEntry[] = [
		user("u1", "old task"),
		assistantText("a1", "old work " + "x".repeat(40)),
		{ id: "t1", kind: "message", message: { role: "toolResult", content: "ok", toolCallId: "c1", toolName: "read", isError: false } },
		user("u2", "second task"),
		assistantText("a2", "second work " + "x".repeat(40)),
		user("u3", "current work in progress"),
		assistantText("a3", "still working on u3 " + "x".repeat(40)),
	];
	const opts = (extra?: Partial<Parameters<typeof selectAutoSpan>[3]>): Parameters<typeof selectAutoSpan>[3] => ({
		foldedEntryIds: new Set<string>(),
		triedSpans: new Set<string>(),
		spanTokens: (ids) => ids.length * 50,
		ceilingTokens: 65536,
		nonEditableIds: () => [],
		hasCloseUnit: () => false,
		hasWork: () => true,
		...extra,
	});
	const span = selectAutoSpan(branch, isSamInjected, (c) => (typeof c === "string" ? c : ""), opts());
	assert.ok(span);
	assert.equal(span.spanFirstId, "u1", "the oldest closed-off block (a real user message follows it)");
	assert.equal(span.spanLastId, "t1");
	assert.deepEqual(span.entryIds, ["a1", "t1"], "message-kind ids between the two users, span order");
});

test("selectAutoSpan: the open tail is NEVER a target (kill-criterion guard)", () => {
	const branch: PlainEntry[] = [
		user("u1", "only one task so far"),
		assistantText("a1", "working " + "x".repeat(40)),
	];
	const opts: Parameters<typeof selectAutoSpan>[3] = {
		foldedEntryIds: new Set(),
		triedSpans: new Set(),
		spanTokens: () => 100,
		ceilingTokens: 65536,
		nonEditableIds: () => [],
		hasCloseUnit: () => false,
		hasWork: () => true,
	};
	assert.equal(selectAutoSpan(branch, isSamInjected, (c) => (typeof c === "string" ? c : ""), opts), undefined, "one user message = only the open tail → nothing eligible");
});

test("selectAutoSpan: blocks with non-editable entries, close_unit, no work, or over the ceiling are skipped", () => {
	const branch: PlainEntry[] = [
		user("u1", "block with system line"),
		{ id: "s1", kind: "message", message: { role: "system", content: "injected" } },
		assistantText("a1", "text " + "x".repeat(40)),
		user("u2", "block with close_unit"),
		assistantText("a2", "closing " + "x".repeat(40)),
		{ id: "tr1", kind: "message", message: { role: "toolResult", content: "close recorded", toolCallId: "cc", toolName: "close_unit", isError: false } },
		user("u3", "block without work"),
		user("u4", "block over the ceiling"),
		assistantText("a4", "huge " + "x".repeat(40)),
		user("u5", "the one good block"),
		assistantText("a5", "good work " + "x".repeat(40)),
		{ id: "tr2", kind: "message", message: { role: "toolResult", content: "ok", toolCallId: "c", toolName: "read", isError: false } },
		user("u6", "moving on"),
	];
	const nonEditableIn = (ids: string[]) => (ids.includes("s1") ? ["s1"] : []);
	const closeIn = (ids: string[]) => ids.includes("tr1");
	const noWorkIn = (ids: string[]) => !(ids.includes("a5") || ids.includes("tr2"));
	const opts: Parameters<typeof selectAutoSpan>[3] = {
		foldedEntryIds: new Set(),
		triedSpans: new Set(),
		spanTokens: (ids) => (ids.includes("a4") ? 1_000_000 : ids.length * 50),
		ceilingTokens: 65536,
		nonEditableIds: nonEditableIn,
		hasCloseUnit: closeIn,
		hasWork: (ids) => !noWorkIn(ids),
	};
	const span = selectAutoSpan(branch, isSamInjected, (c) => (typeof c === "string" ? c : ""), opts);
	assert.ok(span);
	assert.equal(span.spanFirstId, "u5", "skipped: non-editable block, close_unit block, no-work block, over-ceiling block");
});

test("selectAutoSpan: folded and already-tried spans are skipped", () => {
	const branch: PlainEntry[] = [
		user("u1", "folded block"),
		assistantText("a1", "old " + "x".repeat(40)),
		user("u2", "tried block"),
		assistantText("a2", "tried " + "x".repeat(40)),
		{ id: "tr", kind: "message", message: { role: "toolResult", content: "ok", toolCallId: "c", toolName: "read", isError: false } },
		user("u3", "fresh block"),
		assistantText("a3", "fresh " + "x".repeat(40)),
		{ id: "tr2", kind: "message", message: { role: "toolResult", content: "ok", toolCallId: "c2", toolName: "read", isError: false } },
		user("u4", "moving on"),
	];
	const opts: Parameters<typeof selectAutoSpan>[3] = {
		foldedEntryIds: new Set(["a1"]),
		triedSpans: new Set(["u2"]),
		spanTokens: () => 100,
		ceilingTokens: 65536,
		nonEditableIds: () => [],
		hasCloseUnit: () => false,
		hasWork: () => true,
	};
	const span = selectAutoSpan(branch, isSamInjected, (c) => (typeof c === "string" ? c : ""), opts);
	assert.ok(span);
	assert.equal(span.spanFirstId, "u3");
});

/* ── D2 coexistence ──────────────────────────────────────────────────────── */

test("D2: settings extensions array is authoritative; unreadable ⇒ assume present", () => {
	assert.equal(detectForeignFolder(null).present, true, "settings unreadable → conservative (refuse)");
	assert.ok(detectForeignFolder(null).basis.includes("unreadable"));
	assert.equal(detectForeignFolder({ extensions: ["pi-self-aware-memory"] }).present, false, "array present, no folding folder → absent (leftover block ignored)");
	assert.equal(detectForeignFolder({ extensions: ["observational-memory/om-compact.ts"] }).present, true, "array lists a folding folder → present");
	assert.equal(detectForeignFolder({ "observational-memory": { enabled: true } }).present, true, "no array: the block decides (enabled)");
	assert.equal(detectForeignFolder({ "observational-memory": { enabled: false } }).present, false, "no array, block disabled → absent");
	assert.equal(detectForeignFolder({}).present, false, "no evidence at all → absent");
});

test("D2: branch evidence outranks the settings read (omActiveInSession rule)", () => {
	const branch: PlainEntry[] = [
		user("u1", "x"),
		{ id: "c1", kind: "custom", customType: "om.compact", data: {} },
	];
	const evidence = foreignFolderEvidence(branch);
	assert.ok(evidence?.present);
	assert.equal(coexistenceGate({ present: false, basis: "settings say absent" }, branch).present, true, "a foreign ledger entry in the session wins");
	assert.equal(coexistenceGate({ present: false, basis: "x" }, [user("u1", "y")]).present, false, "no evidence: settings stand");
});

/* ── probe (DEFAULT OFF, positive-only) ──────────────────────────────────── */

test("probe: ?autoload=false is mandatory (om-guard patch-0013 precedent)", () => {
	assert.equal(buildProbeUrl("http://host:8080"), "http://host:8080/slots?autoload=false");
	assert.equal(buildProbeUrl("http://host:8080/"), "http://host:8080/slots?autoload=false");
	assert.equal(buildProbeUrl("http://host:8080/v1"), "http://host:8080/slots?autoload=false");
	assert.equal(buildProbeUrl("http://host:8080/v1/"), "http://host:8080/slots?autoload=false");
});

test("probe: positive-only parsing; any failure proceeds", () => {
	assert.equal(parseBusyStatus([{ id: "0", is_processing: false }]), "idle");
	assert.equal(parseBusyStatus([{ id: "0", is_processing: false }, { id: "1", is_processing: true }]), "busy");
	assert.equal(parseBusyStatus("garbage"), "idle");
	assert.equal(parseBusyStatus(null), "idle");
	assert.equal(busynessGate("busy"), "defer", "busy defers");
	assert.equal(busynessGate("idle"), "proceed");
	assert.equal(busynessGate("unavailable"), "proceed", "a missed probe means nothing");
	assert.equal(PROBE_DEFERRALS_PER_CLOSE, 1, "defer at most once per close");
});

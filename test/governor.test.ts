/**
 * P3 tests: governor.ts — pressure ladder + hysteresis, model_select
 * recompute, guard facts R1/R2, the D2 coexistence guard, plus the
 * context-pressure safenet (2026-10-16). (The positive-only probe contract
 * tests went 2026-10-17 with the Wave A probe extraction to the dev repo.) (The R3 de-escalation, R4 sweep-candidate, R5 backoff and
 * auto span-selection tests went 2026-10-16 with the display/assisted/auto
 * modes — manual is the only behaviour.)
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
	detectForeignFolder,
	foreignFolderEvidence,
	coexistenceGate,
} from "../src/governor.ts";
import type { PlainEntry } from "../src/projection.ts";

function user(id: string, text: string): PlainEntry {
	return { id, kind: "message", message: { role: "user", content: text } };
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

/* ══ context-pressure safenet (2026-10-16): deployed values + pressure line ══ */

import {
	PI_DEFAULT_RESERVE_TOKENS,
	PI_DEFAULT_KEEP_RECENT_TOKENS,
} from "../src/gates.ts";
import {
	PRESSURE_HEADROOM_TOKENS,
	pressureHeadroomTokens,
	pressureLineOf,
	pressureNudgeDue,
	ladderFor as ladderForSaf,
} from "../src/governor.ts";

test("SAFENET: ladderFor reads pi's DEPLOYED compaction settings (Q5 — no hardcoded values)", () => {
	const base = ladderForSaf(131_072);
	assert.ok(base);
	assert.equal(base.reserve, PI_DEFAULT_RESERVE_TOKENS, "no deployed settings ⇒ pi's built-in default");
	assert.equal(base.keepRecent, PI_DEFAULT_KEEP_RECENT_TOKENS, "no deployed settings ⇒ pi's built-in default");
	const deployed = ladderForSaf(131_072, undefined, { reserveTokens: 8_000, keepRecentTokens: 10_000 });
	assert.ok(deployed);
	assert.equal(deployed.reserve, 8_000, "a deployed reserve wins over the built-in");
	assert.equal(deployed.keepRecent, 10_000, "a deployed keepRecent wins over the built-in");
	assert.equal(deployed.band, 2_000, "the band follows the deployed reserve (R/4, floor 1024)");
});

test("SAFENET: ladderFor rejects junk deployed values (fail-safe to the built-ins)", () => {
	// each field is judged independently: junk ⇒ built-in, valid positive ⇒ kept.
const cases: { deployed: { reserveTokens?: number; keepRecentTokens?: number }; expR: number; expK: number }[] = [
	{ deployed: { reserveTokens: -1 }, expR: PI_DEFAULT_RESERVE_TOKENS, expK: PI_DEFAULT_KEEP_RECENT_TOKENS },
	{ deployed: { reserveTokens: Number.NaN }, expR: PI_DEFAULT_RESERVE_TOKENS, expK: PI_DEFAULT_KEEP_RECENT_TOKENS },
	{ deployed: { reserveTokens: Number.POSITIVE_INFINITY }, expR: PI_DEFAULT_RESERVE_TOKENS, expK: PI_DEFAULT_KEEP_RECENT_TOKENS },
	{ deployed: { reserveTokens: 0 }, expR: PI_DEFAULT_RESERVE_TOKENS, expK: PI_DEFAULT_KEEP_RECENT_TOKENS },
	{ deployed: { keepRecentTokens: -4 }, expR: PI_DEFAULT_RESERVE_TOKENS, expK: PI_DEFAULT_KEEP_RECENT_TOKENS },
	{ deployed: { keepRecentTokens: Number.NaN }, expR: PI_DEFAULT_RESERVE_TOKENS, expK: PI_DEFAULT_KEEP_RECENT_TOKENS },
	// a valid value in one field must not disturb the other's fallback
	{ deployed: { reserveTokens: -1, keepRecentTokens: 10_000 }, expR: PI_DEFAULT_RESERVE_TOKENS, expK: 10_000 },
	{ deployed: { reserveTokens: 8_000, keepRecentTokens: -4 }, expR: 8_000, expK: PI_DEFAULT_KEEP_RECENT_TOKENS },
];
for (const c of cases) {
	const l = ladderForSaf(131_072, undefined, c.deployed);
	assert.ok(l);
	assert.equal(l.reserve, c.expR, `reserve for ${JSON.stringify(c.deployed)}`);
	assert.equal(l.keepRecent, c.expK, `keepRecent for ${JSON.stringify(c.deployed)}`);
}
	// a positive deployed value is floored (settings are numbers; fractions make no sense)
	const frac = ladderForSaf(131_072, undefined, { reserveTokens: 100.9 });
	assert.ok(frac);
	assert.equal(frac.reserve, 100);
});

test("SAFENET: pressure headroom — the env dial (SAM_PRESSURE_HEADROOM, default 20k)", () => {
	assert.equal(PRESSURE_HEADROOM_TOKENS, 20_000, "the default is Paul's ~20k");
	assert.equal(pressureHeadroomTokens({}), 20_000);
	assert.equal(pressureHeadroomTokens({ SAM_PRESSURE_HEADROOM: "5000" }), 5_000);
	assert.equal(pressureHeadroomTokens({ SAM_PRESSURE_HEADROOM: "12.9" }), 12, "fractional ⇒ floor");
	assert.equal(pressureHeadroomTokens({ SAM_PRESSURE_HEADROOM: "0" }), 20_000, "non-positive ⇒ default");
	assert.equal(pressureHeadroomTokens({ SAM_PRESSURE_HEADROOM: "  " }), 20_000, "blank ⇒ default");
	assert.equal(pressureHeadroomTokens({ SAM_PRESSURE_HEADROOM: "abc" }), 20_000, "non-numeric ⇒ default");
});

test("SAFENET: the pressure line + nudge due (the fail-safe: no estimate ⇒ no order)", () => {
	const ladder = { window: 131_072, reserve: 16_384, keepRecent: 20_000, band: 4_096 };
	const line = pressureLineOf(ladder, 20_000);
	assert.equal(line, 131_072 - 16_384 - 20_000, "line = W − R − headroom");
	assert.equal(pressureNudgeDue(ladder, 20_000, line), true, "at the line ⇒ due");
	assert.equal(pressureNudgeDue(ladder, 20_000, line + 1), true, "above the line ⇒ due");
	assert.equal(pressureNudgeDue(ladder, 20_000, line - 1), false, "below the line ⇒ not due");
	assert.equal(pressureNudgeDue(ladder, 20_000, null), false, "unknown post-fold size ⇒ NO order (F3)");
	assert.equal(pressureNudgeDue(ladder, 20_000, Number.NaN), false, "NaN ⇒ no order");
	assert.equal(pressureNudgeDue(ladder, 20_000, -1), false, "negative ⇒ no order");
});

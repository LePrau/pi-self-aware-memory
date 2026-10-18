/**
 * v5 RETIRE (Paul 2026-10-06): unit retirement + soft upgrade — the pins.
 *
 * Three layers (the house discipline):
 *   A. the PURE core (retire.ts): states/supersedes/census/threshold/decision/
 *      text/validation — env-safe, no I/O.
 *   B. the RENDER (branchaudit.ts): the retired shapes in the takeover
 *      summary + the byte-identity of the no-retirements path + the ledger
 *      ROUND-TRIP (the retire entries survive rebuild — the u23 audit's
 *      true verify-pointer).
 *   C. the GLUE (extension level): the fold-armed once-per-span offer
 *      (fire / moot / dial-off) + the retire_units/unretire tools, driven
 *      through the fake ExtensionAPI with the REAL close-audit child recipe
 *      (the suite never spawns a real process).
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["SAM_SETTINGS_JSON"] = JSON.stringify({ extensions: ["pi-self-aware-memory"] });

import {
	RETIRE_THRESHOLD_CHARS_DEFAULT,
	retiredStates,
	supersedesMap,
	retireCensus,
	retireThresholdChars,
	createRetireOfferState,
	retireOfferArmedOnFold,
	retireOfferDecision,
	retireOfferText,
	validateRetireCall,
	parseRetireCarryMarker, // v5 RETIRE light-carry (2026-10-06)
	type RetireLedgerEntry,
} from "../src/retire.ts";
import { takeoverSummary, settlementBlock, stripOldSettlementStacks, retiredSupersededLine, TAKEOVER_POINTER, SETTLEMENTS_HEADER, type SamSettlementRecord } from "../src/branchaudit.ts";
import { RETIRE_UNITS_TOOL, UNRETIRE_TOOL, retireAckText, retireRefuseText, unretireAckText, AUDIT_INSTRUCTION_PREFIX } from "../src/protocol.ts";
import { rebuildLedger } from "../src/ledger.ts";
import type { PlainEntry } from "../src/projection.ts";

/* ══ A. the pure core ════════════════════════════════════════════════════ */

const rec = (unitId: number, fact = `f${unitId}`): SamSettlementRecord => ({
	v: 1,
	kind: "settlement",
	unitId,
	retrievalId: `${String(unitId).padStart(12, "0")}`,
	verdict: "VERIFIED",
	sections: { FACTS: fact },
	line: `u${unitId}`,
	auditFile: "a.jsonl",
	replyId: "r",
	parsedClean: true,
	ts: unitId,
});
// distinct FACTS lengths ⇒ distinct rendered block sizes (the top-3 ordering is then unambiguous)
const RECS = [rec(1, "a"), rec(2, "bb"), rec(3, "ccc"), rec(4, "dddd")];

test("retiredStates: latest-wins per unit; superseded keeps the target; unretire CLEARS (the soft reversal)", () => {
	const base: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 1, superseded: [1, 2], supersededBy: 9, dropped: [3] }];
	const m = retiredStates(base);
	assert.deepEqual(m.get(1), { shape: "superseded", supersededBy: 9 });
	assert.deepEqual(m.get(3), { shape: "dropped" });
	assert.equal(m.get(4), undefined, "untouched units stay alone (u5-never-retired, Paul's example)");
	// a later DROP of a superseded unit wins (latest-wins)
	const m2 = retiredStates([...base, { v: 1, kind: "retire", ts: 2, superseded: [], dropped: [1] }]);
	assert.deepEqual(m2.get(1), { shape: "dropped" });
	// unretire clears the unit
	const m4 = retiredStates([...base, { v: 1, kind: "unretire", ts: 3, units: [1, 3] }]);
	assert.equal(m4.get(1), undefined, "unretired ⇒ full render again");
	assert.equal(m4.get(3), undefined);
	assert.deepEqual(m4.get(2), { shape: "superseded", supersededBy: 9 }, "other units unaffected");
});

test("supersedesMap: the superseding unit accumulates ALL the old ids it retired (the 'metadata' Paul named)", () => {
	const e: RetireLedgerEntry[] = [
		{ v: 1, kind: "retire", ts: 1, superseded: [1, 2], supersededBy: 9, dropped: [] },
		{ v: 1, kind: "retire", ts: 2, superseded: [4], supersededBy: 9, dropped: [] },
		{ v: 1, kind: "retire", ts: 3, superseded: [], dropped: [3] },
	];
	const m = supersedesMap(e);
	assert.deepEqual(m.get(9), [1, 2, 4]);
	assert.equal(m.get(3), undefined, "a pure drop carries no supersedes metadata");
});

test("retireCensus: the exact rendered shape + the top-3 largest (and the empty form)", () => {
	const c = retireCensus(RECS, (r) => settlementBlock(r));
	assert.equal(c.records, 4);
	assert.ok(c.chars > 0, "the chars are the RENDERED block sizes (what the summary would push)");
	assert.ok(/^u4 \(\d+\), u3 \(\d+\), u2 \(\d+\)$/.test(c.largest), `largest = top-3 by rendered size: ${c.largest}`);
	assert.equal(c.alreadyRetired, 0);
	const none = retireCensus([], (r) => settlementBlock(r));
	assert.equal(none.records, 0);
	assert.equal(none.largest, "(none)");
	const withRetired = retireCensus(RECS, (r) => settlementBlock(r), [{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 9, dropped: [] }]);
	assert.equal(withRetired.alreadyRetired, 1);
});

test("retireCensus (2026-10-18 fix): counts EXACTLY what the summary pushes — dropped GONE, superseded as pointer line, supersedes metadata on the live block", () => {
	const entries: RetireLedgerEntry[] = [
		{ v: 1, kind: "retire", ts: 1, superseded: [1, 2], supersededBy: 9, dropped: [3] },
	];
	// no retirements ⇒ all four render as full blocks (unchanged behaviour)
	const plain = retireCensus(RECS, (r) => settlementBlock(r));
	assert.equal(plain.records, 4);
	// u1+u2 superseded ⇒ pointer lines; u3 dropped ⇒ GONE; u4 live (no metadata here)
	const c = retireCensus(RECS, (r, sup) => settlementBlock(r, sup), entries);
	assert.equal(c.records, 3, "the dropped unit is not a rendered record (pre-fix it was counted)");
	assert.equal(c.alreadyRetired, 3, "u1, u2 superseded + u3 dropped");
	const expectLargest = [
		{ id: 4, len: settlementBlock(RECS[3]).length },
		{ id: 1, len: retiredSupersededLine(RECS[0], 9).length },
		{ id: 2, len: retiredSupersededLine(RECS[1], 9).length },
	]
		.sort((a, b) => b.len - a.len || a.id - b.id)
		.map((s) => `u${s.id} (${s.len})`)
		.join(", ");
	assert.equal(c.largest, expectLargest, `the top-3 are the RENDERED units: ${c.largest}`);
	assert.equal(
		c.chars,
		retiredSupersededLine(RECS[0], 9).length + retiredSupersededLine(RECS[1], 9).length + settlementBlock(RECS[3]).length,
		"chars = pointer + pointer + live block (exactly the summary's stack; pre-fix the dropped full block + 2 full blocks were counted)",
	);
	// a live unit that SUPERSEDED old units carries the metadata line in its render
	const carrier = rec(9, "carried");
	const c2 = retireCensus([carrier], (r, s) => settlementBlock(r, s), entries);
	assert.equal(c2.chars, settlementBlock(carrier, [1, 2]).length, "the 'supersedes' metadata line counts (parity with the takeover render)");
});

test("retireThresholdChars: the 40k default (Paul: '40k characters sounds good'), env override, malformed ⇒ default (F3)", () => {
	assert.equal(RETIRE_THRESHOLD_CHARS_DEFAULT, 40_000);
	assert.equal(retireThresholdChars({}), 40_000);
	assert.equal(retireThresholdChars({ SAM_RETIRE_CHARS: "123" }), 123, "a test/operator override");
	assert.equal(retireThresholdChars({ SAM_RETIRE_CHARS: "junk" }), 40_000, "malformed ⇒ default");
	assert.equal(retireThresholdChars({ SAM_RETIRE_CHARS: "0" }), 40_000, "non-positive ⇒ default");
	assert.equal(retireThresholdChars({ SAM_RETIRE_CHARS: "-5" }), 40_000, "negative ⇒ default");
});

test("retireOfferDecision: pre-fold wait · armed fire/moot · one-per-span (offered) · zero records moot", () => {
	const st = createRetireOfferState();
	const census = { records: 4, chars: 60_000, largest: "x", alreadyRetired: 0 };
	assert.equal(retireOfferDecision(st, census, 40_000), "wait", "no fold yet ⇒ nothing to offer");
	retireOfferArmedOnFold(st, "span1");
	assert.equal(retireOfferDecision(st, census, 40_000), "fire");
	const st2 = createRetireOfferState();
	retireOfferArmedOnFold(st2, "span1");
	assert.equal(retireOfferDecision(st2, { records: 4, chars: 1_000, largest: "x", alreadyRetired: 0 }, 40_000), "moot", "below threshold ⇒ nothing to clean up");
	assert.equal(retireOfferDecision(st2, { records: 0, chars: 0, largest: "(none)", alreadyRetired: 0 }, 1), "moot", "zero records ⇒ moot (never a fire)");
	st2.offered = true;
	assert.equal(retireOfferDecision(st2, census, 1), "wait", "already offered this span ⇒ consumed (one-per-span)");
	retireOfferArmedOnFold(st2, "span2");
	assert.equal(retireOfferDecision(st2, census, 1), "fire", "a NEW fold re-arms (offered resets)");
});

test("retireOfferText: the steer text is byte-pinned (the cost + the options + the softness commitment, the 2026-10-05 wording discipline)", () => {
	const t = retireOfferText({ records: 3, chars: 52_345, largest: "u9 (8858), u4 (8702), u2 (2410)", alreadyRetired: 1 });
	assert.equal(
		t,
		"[sam-nudge] Retire offer — 3 settled unit record(s) currently render as ~52345 chars (largest: u9 (8858), u4 (8702), u2 (2410); 1 already retired). " +
			"If older units are stale, retire them now (they would otherwise re-appear at every fold): " +
			"(1) UPGRADE — take over only what still matters (2 files and a fact from uA, one open question from uB, most of uC…) " +
			"into a NEW close_unit stub — start that stub with the first line \"RETIRE-CARRY uA, uB, uC\" (the units you carry), " +
			"then call retire_units with {superseded:[A,B,C], supersededBy:<the new unit>, dropped:[D]}; " +
			"the marked close is audited LIGHT (a curated carry-over is a copy, not new work — the old units' verification claims are taken over as-is, not re-derived); " +
			"(2) DROP — retire_units with {superseded:[], dropped:[…]} for complete retirement. " +
			"Retirement is soft: every retired unit stays retrievable (sam_retrieve <id>) and restorable (unretire). " +
			"If nothing is stale, ignore this offer.",
	);
});

test("validateRetireCall: the atomic-contract edge set (empty / supersededBy-required / unknown / double-routing; known-lists ride the message)", () => {
	assert.equal(validateRetireCall([1, 2, 3, 4], [1, 2], 4, [3]), null, "Paul's own example: u1+u2 → u4, drop u3, u… untouched — VALID");
	assert.equal(validateRetireCall([1, 2, 3], [1, 2], 3, []), null, "pure upgrade");
	assert.equal(validateRetireCall([1, 2], [], undefined, [1, 2]), null, "pure drop (no supersededBy needed)");
	assert.match(validateRetireCall([1], [], undefined, []) as string, /nothing to retire/);
	assert.match(validateRetireCall([1, 2], [1], undefined, []) as string, /supersededBy is required/);
	assert.match(validateRetireCall([1, 2], [1], 9, []) as string, /supersededBy 9 is not a unit on this branch \(known: 1, 2\)/);
	assert.match(validateRetireCall([1, 2], [1], 2, [5]) as string, /unknown unit id\(s\): 5 \(known: 1, 2\)/);
	assert.match(validateRetireCall([1, 2, 3], [1, 3], 2, [3]) as string, /unit\(s\) routed twice: 3/);
});

test("parseRetireCarryMarker: the RETIRE-CARRY first-line marker (total: any malform ⇒ undefined — fail-safe)", () => {
	assert.deepEqual(parseRetireCarryMarker("RETIRE-CARRY"), [], "bare marker = valid (the ids ride the retire entry)");
	assert.deepEqual(parseRetireCarryMarker("RETIRE-CARRY u1, u2, u4\nthe curated carry-over"), [1, 2, 4], "the carried ids parse");
	assert.deepEqual(parseRetireCarryMarker("RETIRE-CARRY u7\ncarry content"), [7], "single id");
	assert.deepEqual(parseRetireCarryMarker("  RETIRE-CARRY u1  "), [1], "surrounding whitespace is trimmed");
	assert.equal(parseRetireCarryMarker("retire-carry u1"), undefined, "lowercase ≠ the pinned marker");
	assert.equal(parseRetireCarryMarker("RETIRE-CARRY u1 extra"), undefined, "no trailing text after the ids");
	assert.equal(parseRetireCarryMarker("RETIRE-CARRY u1 u2"), undefined, "comma-separated only (no space form)");
	assert.equal(parseRetireCarryMarker("RETIRE-CARRY u1, 2"), undefined, "every id needs the u- prefix");
	assert.equal(parseRetireCarryMarker("RETIRE-CARRY u1, u2 (carried)"), undefined, "no trailing text");
	assert.equal(parseRetireCarryMarker("did the work\nRETIRE-CARRY u1"), undefined, "the marker must be the FIRST line");
	assert.deepEqual(parseRetireCarryMarker("RETIRE-CARRY "), [], "trailing whitespace is trimmed — the bare form survives (model-tolerant)");
});

/* tool-wording pins (the model reads these back) */
test("the tool wording constants: acks + the two tool surfaces (wording = pins)", () => {
	assert.equal(
		retireAckText([1, 2, 4], 17, [3]),
		"Retired — superseded by u17: u1, u2, u4 · dropped: u3 — effective from the next summary (older folded summaries already written are history); " +
			"every retired unit stays retrievable (sam_retrieve <id>) and restorable (unretire).",
	);
	assert.equal(
		retireAckText([], undefined, [3]),
		"Retired — dropped: u3 — effective from the next summary (older folded summaries already written are history); every retired unit stays retrievable (sam_retrieve <id>) and restorable (unretire).",
	);
	assert.equal(retireRefuseText("oops"), "Retire REFUSED: oops — nothing changed (no retirement was committed).");
	assert.equal(unretireAckText([1, 2]), "Unretired: u1, u2 — back in the summary from the next fold (retirement was soft — nothing was deleted).");
	assert.equal(RETIRE_UNITS_TOOL.name, "retire_units");
	assert.ok(RETIRE_UNITS_TOOL.description.includes("unretire"), "the description names the softness (retrievable + restorable)");
	assert.ok(RETIRE_UNITS_TOOL.description.includes("2 files and a fact from u1"), "Paul's own selection example is the exemplar");
	assert.equal(UNRETIRE_TOOL.name, "unretire");
});

/* ══ B. the render + the ledger round-trip ══════════════════════════════ */

test("takeoverSummary WITH retirements: dropped → GONE · superseded → one line + link · the superseding unit gains its supersedes line", () => {
	const act: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 9, superseded: [1, 2], supersededBy: 4, dropped: [3] }];
	const sum = takeoverSummary(undefined, null, RECS, null, act);
	assert.ok(!sum.includes("## u3 — "), "dropped u3 is GONE from the summary (complete retirement)");
	assert.ok(sum.includes("## u1 — VERIFIED (superseded → u4) · 000000000001"), "superseded u1 = one line + forward link");
	assert.ok(sum.includes("- content carried into u4 (the superseding unit) · original: sam_retrieve 000000000001"), "the one line stays retrievable (soft)");
	assert.ok(sum.includes("## u4 — VERIFIED · 000000000004"), "the superseding unit keeps its FULL block");
	assert.ok(sum.includes("- supersedes: u1, u2 (retired — their content is carried in this unit; each original stays retrievable)"), "the metadata line (Paul: the new unit carries all the old ids)");
});

test("takeoverSummary default: NO retirements arg ⇒ byte-identical to the pre-retire shape (all existing suites depend on this)", () => {
	const legacy = takeoverSummary(undefined, null, RECS, null);
	const empty = takeoverSummary(undefined, null, RECS, null, []);
	assert.equal(legacy, empty, "empty retirements list = the legacy path");
	assert.ok(legacy.includes("## u1 — VERIFIED · 000000000001"), "u1 renders full (not retired)");
});

/* v5 RETIRE fix (2026-10-06): the carried previous summary's OLD settlement-stack
   layers are duplicates of the fresh all-unit render — retired units must be
   GONE from the WHOLE summary, not just the current stack. */

test("stripOldSettlementStacks: old stack layers are stripped, everything else stays (total: no header ⇒ byte-identical)", () => {
	const layer1 =
		`${SETTLEMENTS_HEADER}\n\n## u1 — VERIFIED · 000000000001\n- FACTS: a\n- EVIDENCE: e1\n- audit: a.jsonl\n\n## u2 — UNVERIFIED (audit-failed) · 000000000002\n- FACTS: b\n- EVIDENCE: e2\n- audit: a.jsonl`;
	const layer2 = `${SETTLEMENTS_HEADER}\n\n## u3 — VERIFIED · 000000000003\n- FACTS: c\n- EVIDENCE: e3\n- audit: a.jsonl`;
	const orphan1 = "## ORPHANED AT FOLD · abc123456789\norphaned span text one";
	const orphan2 = "## ORPHANED AT FOLD · def123456789\norphaned span text two";
	const prev = ["opening prose that must stay", layer1, orphan1, TAKEOVER_POINTER, layer2, orphan2, TAKEOVER_POINTER].join("\n\n");
	const out = stripOldSettlementStacks(prev);
	assert.ok(!out.includes(SETTLEMENTS_HEADER), "both old layers' headers are gone");
	assert.ok(!out.includes("## u1 — VERIFIED · 000000000001"), "u1's old block is gone");
	assert.ok(!out.includes("## u2 — UNVERIFIED (audit-failed) · 000000000002"), "u2's old block is gone");
	assert.ok(!out.includes("## u3 — VERIFIED · 000000000003"), "u3's old block is gone");
	assert.ok(out.includes("opening prose that must stay"), "the prose before the first layer stays");
	assert.ok(out.includes(orphan1), "orphan section 1 stays (out of scope)");
	assert.ok(out.includes(orphan2), "orphan section 2 stays (out of scope)");
	assert.equal((out.match(/earlier context summarized by pi-self-aware-memory/g) ?? []).length, 2, "both pointer lines stay");
	assert.equal(stripOldSettlementStacks("no header here\njust prose"), "no header here\njust prose", "no header ⇒ byte-identical (total)");
});

test("takeoverSummary: prev's OLD stack layers are ALWAYS stripped (2026-10-15: the retire-gate is gone — zero retirements must not accumulate O(N²))", () => {
	// a realistic previous fold: its own stack layer + an orphan section + the pointer
	const priorFold = takeoverSummary(undefined, null, RECS, null);
	const prev =
		priorFold.slice(0, -TAKEOVER_POINTER.length - 2) +
		"\n\n## ORPHANED AT FOLD · abc123456789\norphaned span text\n\n" +
		TAKEOVER_POINTER;
	const act: RetireLedgerEntry[] = [{ v: 1, kind: "retire", ts: 9, superseded: [1], supersededBy: 2, dropped: [3] }];
	const fixed = takeoverSummary(prev, null, RECS, null, act);
	assert.ok(fixed.includes("## u1 — VERIFIED (superseded → u2) · 000000000001"), "superseded u1 = the fresh one-liner");
	assert.ok(!fixed.includes("- FACTS: a\n"), "u1's OLD full body is GONE from the whole summary");
	assert.ok(!fixed.includes("## u3 — "), "dropped u3: gone from the old layer AND the fresh render");
	assert.equal(fixed.match(/## u2 — VERIFIED · 000000000002/g)!.length, 1, "active u2 appears exactly once (the fresh render) — the old layer's duplicate is stripped");
	assert.ok(fixed.includes("## ORPHANED AT FOLD · abc123456789"), "the old orphan section stays (within the keep cap)");
	assert.ok(fixed.includes(TAKEOVER_POINTER), "the pointer stays");
	// 2026-10-15: WITHOUT retirements the old layer is stripped too — the measured
	// 01a13a33 failure mode was 10 folds with zero retirements ⇒ O(N²) accumulation
	// (summary 4,461 → 191,152 chars); the old layers are pure duplication of the
	// fresh all-unit render (v5 RETIRE doc), so nothing is lost by stripping them.
	const untouched = takeoverSummary(prev, null, RECS, null);
	assert.equal(untouched, takeoverSummary(prev, null, RECS, null, []), "undefined = empty list (the same render)");
	assert.equal(untouched.match(/## u2 — VERIFIED · 000000000002/g)!.length, 1, "the old layer is GONE even with no retirements (u2 once: the fresh render only)");
});

test("unretire (render): a later unretire entry restores the unit for the NEXT fold (latest-wins through the same list)", () => {
	const act: RetireLedgerEntry[] = [
		{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 2, dropped: [] },
		{ v: 1, kind: "unretire", ts: 2, units: [1] },
	];
	const sum = takeoverSummary(undefined, null, RECS, null, act);
	assert.ok(sum.includes("## u1 — VERIFIED · 000000000001"), "unretired u1 renders full again");
	assert.ok(!sum.includes("(superseded → u2)"), "the superseded mark is gone");
});

test("LEDGER ROUND-TRIP (the u23 audit's true verify-pointer): retire/unretire entries SURVIVE rebuildLedger — the total isRecord validator admits them, malformed is 0", () => {
	const custom = (data: unknown): PlainEntry => ({ id: `x${Math.random()}`, kind: "custom", customType: "sam", data });
	const branch: PlainEntry[] = [
		custom({ v: 1, kind: "retire", ts: 1, superseded: [1, 2], supersededBy: 3, dropped: [4], reason: "stale" }),
		custom({ v: 1, kind: "unretire", ts: 2, units: [4] }),
	];
	const ledger = rebuildLedger(branch);
	assert.equal(ledger.retirements.length, 2, "both entries are collected (not silently dropped — the v:1 + case-branch fix)");
	assert.equal(ledger.malformedRecords, 0, "zero malformed on a valid pair");
	assert.deepEqual(ledger.retirements[0].superseded, [1, 2]);
	assert.equal((ledger.retirements[0] as { supersededBy?: number }).supersededBy, 3);
	// the negative: the atomic contract is enforced at the validator too (superseded non-empty WITHOUT supersededBy ⇒ malformed)
	const bad = rebuildLedger([custom({ v: 1, kind: "retire", ts: 1, superseded: [1], dropped: [] })]);
	assert.equal(bad.retirements.length, 0);
	assert.equal(bad.malformedRecords, 1, "an invalid retire entry is counted (announced), not lost");
});

/* ══ C. the glue (fold-armed offer + the tools, through the fake pi) ═════ */

import factory, { __setCloseAuditRunner, type CloseAuditRunner } from "../extensions/self-aware-memory/index.ts";
import { NUDGE_LEDGER_CUSTOM_TYPE } from "../src/nudge.ts";

interface PiEntry {
	id: string;
	type: "message" | "custom" | "compaction" | "context_edit";
	message?: { role: string; content: unknown; timestamp?: number; toolCallId?: string; toolName?: string; isError?: boolean };
	customType?: string;
	data?: unknown;
}
interface ToolResult { content: { type: string; text: string }[]; details?: unknown }
interface FakeToolDef {
	name: string;
	description?: string;
	executionMode?: string;
	execute: (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
}
interface FakePi {
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	tools: Map<string, FakeToolDef>;
	listeners: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
	appended: { customType: string; data?: unknown }[];
	sent: { text: string; options?: { deliverAs?: string } }[];
	messages: { customType?: string; content?: string; options?: { deliverAs?: string } }[];
	notifyCalls: { text: string; type?: string }[];
	branch: PiEntry[];
	contextUsage?: { tokens: number | null; contextWindow: number };
	idle: boolean;
}
function makeFakePi(branch: PiEntry[] = []): FakePi {
	return { commands: new Map(), tools: new Map(), listeners: new Map(), appended: [], sent: [], messages: [], notifyCalls: [], branch, idle: true };
}
let seq = 0;
const nextId = () => `r${++seq}`;
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}): PiEntry => ({ id: nextId(), type: "message", message: { role, content, timestamp: Date.now(), ...extra } });
function makeApi(f: FakePi) {
	return {
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => f.commands.set(name, def),
		registerTool: (def: FakeToolDef) => f.tools.set(def.name, def),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = f.listeners.get(event) ?? [];
			list.push(handler);
			f.listeners.set(event, list);
		},
		appendEntry: (customType: string, data?: unknown) => {
			f.appended.push({ customType, data });
			f.branch.push({ id: nextId(), type: "custom", customType, data });
		},
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => {
			f.sent.push({ text, options });
			f.idle = false;
		},
		sendMessage: (custom: { customType?: string; content?: string }, options?: { deliverAs?: string }) => {
			f.messages.push({ customType: custom.customType, content: custom.content, options });
		},
	};
}
function makeFakeCtx(f: FakePi, sessionFile: string): Record<string, unknown> {
	return {
		ui: { notify: (text: string, type?: string) => f.notifyCalls.push({ text, type }) },
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		isIdle: () => f.idle,
		waitForIdle: async () => {
			f.idle = true;
		},
		sessionManager: {
			getBranch: () => f.branch,
			getEntry: (id: string) => f.branch.find((e) => e.id === id) ?? null,
			getSessionFile: () => sessionFile,
			getSessionDir: () => path.dirname(sessionFile),
			getLeafId: () => (f.branch.length > 0 ? f.branch[f.branch.length - 1].id : null),
		},
		model: { provider: "qube", id: "test-model" },
		getContextUsage: () => f.contextUsage,
	};
}
async function load(pi: FakePi, ctx: Record<string, unknown>): Promise<void> {
	factory(makeApi(pi) as never);
	const starts = pi.listeners.get("session_start") ?? [];
	assert.equal(starts.length, 1, "exactly one session_start listener");
	await starts[0]({ reason: "startup" }, ctx);
}
async function compact(pi: FakePi, ctx: Record<string, unknown>, firstKeptEntryId: string): Promise<{ summary: string }> {
	const hooks = pi.listeners.get("session_before_compact") ?? [];
	assert.equal(hooks.length, 1, "exactly one session_before_compact listener");
	const out = (await hooks[0]({ preparation: { firstKeptEntryId, tokensBefore: 120_000, previousSummary: undefined }, branchEntries: pi.branch as never }, ctx)) as
		| { compaction: { summary: string } }
		| undefined;
	assert.ok(out, "the branch carries a settlement ⇒ the takeover owns the summary");
	return out.compaction;
}

/* the REAL close-audit child recipe (copied from the close-audit suite):
   writeFork builds the fork session file the pipeline's VALIDATE step reads
   (the verdict reply); the fake prepare child points at it; the fake audit
   child returns an empty stdout — the verdict comes from the fork file. */
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sam-retire-test-"));
const MAIN_FILE = path.join(WORKDIR, "main.jsonl");
function writeFork(unitId: number, reply: string, name = `fork-u${unitId}.jsonl`): string {
	const f = path.join(WORKDIR, name);
	const lines = [
		{ type: "session", id: "forkroot", version: 3, timestamp: "2026-10-01T00:00:00.000Z", cwd: WORKDIR },
		{ id: "instr", parentId: "forkroot", type: "message", message: { role: "user", content: `${AUDIT_INSTRUCTION_PREFIX} Unit ${unitId} was just closed. Audit the stub below.` } },
		{ id: "reply", parentId: "instr", type: "message", message: { role: "assistant", content: reply } },
	];
	fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return f;
}
function makeRunner(forkFile: string): CloseAuditRunner {
	return {
		run: async (args, opts) => {
			if (opts.label.startsWith("close-audit-prepare")) {
				const unitId = (opts.label.match(/u(\d+)$/) ?? [])[1] ?? "1";
				const stdout =
					"boot\n" +
					JSON.stringify({
						"sam-branch-prepare": { unitId: Number(unitId), forkFile, forkSessionId: `fork-${unitId}`, instruction: "[sam-audit] Unit " + unitId + " ..." },
					}) +
					"\n";
				return { code: 0, stdout, stderr: "", timedOut: false };
			}
			return { code: 0, stdout: "", stderr: "", timedOut: false };
		},
	};
}
const setRunnerFor = (forkFile: string) => __setCloseAuditRunner(makeRunner(forkFile));

async function closeUnit(pi: FakePi, ctx: Record<string, unknown>, stub: string, toolCallId: string): Promise<ToolResult> {
	const tool = pi.tools.get("close_unit");
	assert.ok(tool, "the close_unit tool must be registered");
	const result = (await tool.execute(toolCallId, { stub }, new AbortController().signal, undefined, ctx)) as ToolResult;
	pi.branch.push({ id: nextId(), type: "message", message: { role: "toolResult", content: [{ type: "text", text: (result.content[0] as { text: string }).text }], timestamp: Date.now(), toolCallId, toolName: "close_unit", isError: false } });
	return result;
}
const retireTraces = (pi: FakePi) =>
	pi.appended.filter((a) => a.customType === NUDGE_LEDGER_CUSTOM_TYPE).map((a) => a.data as Record<string, unknown>).filter((d) => d.trigger === "retire");

const withEnv = (key: string, value: string | undefined): (() => void) => {
	const prev = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	return () => {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	};
};

test("GLUE: fold + first close over the threshold ⇒ the retire offer FIRES once (steer + trace); a 2nd close stays silent; the NEXT fold re-arms", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "on");
	const restoreThr = withEnv("SAM_RETIRE_CHARS", "10"); // test-scale threshold (crossed by any settlement)
	try {
		const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
		// NB: the close-GOAL offer (a different ledger line — the goal is never stored in the fake) also sends on each accepted close; the contract here is the RETIRE offer, so the asserts count the retire text specifically (pi.sent would double-count the family's other member).
		const retireSends = (p: FakePi) => p.sent.filter((s) => s.text.startsWith("[sam-nudge] Retire offer —"));
		pi.contextUsage = { tokens: 30_000, contextWindow: 131_072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		assert.equal(retireSends(pi).length, 0, "no RETIRE offer before any close (not a close moment)");

		setRunnerFor(writeFork(1, "VERIFIED\nFACTS: data.txt was written with 42\nEVIDENCE: MARKER-R1", "fork-r1.jsonl"));
		const r1 = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc-r1");
		assert.match(r1.content[0].text as string, /Unit 1 closed — audit VERIFIED/, "the close is unaffected by the offer machinery");
		assert.equal(retireSends(pi).length, 0, "u1 closed PRE-fold ⇒ no RETIRE offer yet (the trigger is the first close AFTER a fold)");

		await compact(pi, ctx, pi.branch[1].id); // the fold (arms the span)
		pi.branch.push(msg("user", "and now the second task, done in full"));

		// 2026-10-16 (context-pressure safenet): the orphan minted at fold 1 consumes a
		// unitId (unit 2 — orphans are units from fold time on, Paul Q3), so the first
		// post-fold close is Unit 3 (the pin moved with the behaviour; the 2026-10-15
		// commit set this precedent).
		setRunnerFor(writeFork(3, "VERIFIED\nFACTS: the second fact holds\nEVIDENCE: MARKER-R2", "fork-r2.jsonl"));
		const r2 = await closeUnit(pi, ctx, "did the second task", "tc-r2");
		assert.match(r2.content[0].text as string, /Unit 3 closed — audit VERIFIED/, "the close itself is unaffected (fail-safe)");
		assert.equal(retireSends(pi).length, 1, "the offer FIRED at the first close of the post-fold span");
		assert.equal(retireSends(pi)[0].options?.deliverAs, "steer", "the D7 channel: queued, before the next LLM call");
		assert.ok(retireSends(pi)[0].text.startsWith("[sam-nudge] Retire offer —"), "the byte-pinned steer text");
		const traces = retireTraces(pi);
		assert.equal(traces.length, 1, "exactly one retire ledger trace");
		assert.equal(traces[0].decision, "fire");

		// 2nd close in the SAME span ⇒ consumed (one-per-span)
		pi.branch.push(msg("user", "a third task, done"));
		setRunnerFor(writeFork(4, "VERIFIED\nFACTS: third fact holds\nEVIDENCE: MARKER-R3", "fork-r3.jsonl"));
		const r3 = await closeUnit(pi, ctx, "did the third task", "tc-r3");
		assert.match(r3.content[0].text as string, /Unit 4 closed — audit VERIFIED/);
		assert.equal(retireSends(pi).length, 1, "the SAME span's second close does NOT re-offer (one-per-span — consumed)");

		// a NEW fold re-arms
		await compact(pi, ctx, pi.branch[pi.branch.length - 2].id);
		pi.branch.push(msg("user", "a fourth task, done"));
		// fold 2's orphan consumed unit 5 ⇒ the fourth close is Unit 6 (same drift as above).
		setRunnerFor(writeFork(6, "VERIFIED\nFACTS: fourth fact holds\nEVIDENCE: MARKER-R4", "fork-r4.jsonl"));
		const r4 = await closeUnit(pi, ctx, "did the fourth task", "tc-r4");
		assert.match(r4.content[0].text as string, /Unit 6 closed — audit VERIFIED/);
		assert.equal(retireSends(pi).length, 2, "the NEXT fold re-armed the once-per-span offer (fired again)");
		const traces2 = retireTraces(pi);
		assert.equal(traces2.length, 2);
		assert.equal(traces2[1].decision, "fire");
	} finally {
		restoreNudge();
		restoreThr();
		__setCloseAuditRunner(null);
	}
});

test("GLUE: fold + close BELOW the (default 40k) threshold ⇒ MOOT (trace, no offer, span consumed)", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "on");
	const restoreThr = withEnv("SAM_RETIRE_CHARS", undefined); // the 40k default — a small arm never crosses it
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		pi.contextUsage = { tokens: 30_000, contextWindow: 131_072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		setRunnerFor(writeFork(1, "VERIFIED\nFACTS: a small fact\nEVIDENCE: M1", "fork-moot1.jsonl"));
		await closeUnit(pi, ctx, "wrote data.txt", "tc-m1");
		await compact(pi, ctx, pi.branch[1].id);
		pi.branch.push(msg("user", "one more small task"));
		setRunnerFor(writeFork(2, "VERIFIED\nFACTS: the small task done\nEVIDENCE: M2", "fork-moot2.jsonl"));
		await closeUnit(pi, ctx, "did the small task", "tc-m2");
		const retireSends = pi.sent.filter((s) => s.text.startsWith("[sam-nudge] Retire offer —"));
		assert.equal(retireSends.length, 0, "below the 40k threshold ⇒ NO retire send (moot — the offer would be noise; the close-GOAL offer's send is a different family member and filtered out here)");
		const traces = retireTraces(pi);
		assert.equal(traces.length, 1);
		assert.equal(traces[0].decision, "moot", "the suppressed decision leaves a trace (the D9 pattern)");
	} finally {
		restoreNudge();
		restoreThr();
		__setCloseAuditRunner(null);
	}
});

test("GLUE: SAM_NUDGE=off kills the retire offer too (the shared nudge-family gate — no send, no trace)", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "off");
	const restoreThr = withEnv("SAM_RETIRE_CHARS", "10");
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		pi.contextUsage = { tokens: 30_000, contextWindow: 131_072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		setRunnerFor(writeFork(1, "VERIFIED\nFACTS: small fact\nEVIDENCE: M3", "fork-off1.jsonl"));
		await closeUnit(pi, ctx, "wrote data.txt", "tc-o1");
		await compact(pi, ctx, pi.branch[1].id);
		pi.branch.push(msg("user", "another task"));
		setRunnerFor(writeFork(2, "VERIFIED\nFACTS: the task done\nEVIDENCE: M4", "fork-off2.jsonl"));
		await closeUnit(pi, ctx, "did the task", "tc-o2");
		assert.equal(pi.sent.length, 0, "SAM_NUDGE=off ⇒ the offer is off with the family");
		assert.equal(retireTraces(pi).length, 0, "dial-off clears silently (parity with the goal offer)");
	} finally {
		restoreNudge();
		restoreThr();
		__setCloseAuditRunner(null);
	}
});

test("GLUE: retire_units commits the SOFT ledger entry (v:1 durable record) + the ack; the NEXT fold renders superseded-one-line + supersedes; unretire restores it for the fold after that", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "off");
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		pi.contextUsage = { tokens: 30_000, contextWindow: 131_072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		setRunnerFor(writeFork(1, "VERIFIED\nFACTS: fact one stands\nEVIDENCE: T1", "fork-tool1.jsonl"));
		await closeUnit(pi, ctx, "wrote data.txt", "tc-t1");
		pi.branch.push(msg("user", "carry the still-valid parts of u1 into a new unit"));
		setRunnerFor(writeFork(2, "VERIFIED\nFACTS: the curated carry-over from u1 (2 files + the fact)\nEVIDENCE: T2", "fork-tool2.jsonl"));
		await closeUnit(pi, ctx, "the curated carry-over (carried from u1: the 2 files + the fact)", "tc-t2");
		assert.ok(pi.tools.has("retire_units"), "the tool is registered (manual-anytime)");
		assert.ok(pi.tools.has("unretire"), "the reversal is registered too");
		const res = (await pi.tools.get("retire_units")!.execute("tc-tu1", { superseded: [1], supersededBy: 2, dropped: [], reason: "u1 is stale except the carried parts" }, new AbortController().signal, undefined, ctx)) as ToolResult;
		assert.equal(res.content[0].text as string, retireAckText([1], 2, []), "the ack is byte-pinned");
		const entries = pi.appended.filter((a) => a.customType === "sam").map((a) => a.data as Record<string, unknown>);
		const retireEntry = [...entries].reverse().find((d) => d.kind === "retire");
		assert.ok(retireEntry, "the retire entry is on the branch (the durable, append-only provenance)");
		assert.equal(retireEntry!.supersededBy, 2);
		assert.deepEqual(retireEntry!.superseded, [1]);
		assert.equal(retireEntry!.v, 1, "the entry carries v:1 (parseSamRecord's isRecord gate — without it the retirement would be LOST at session_start)");

		// the next fold renders the retirement (superseded one-line + supersedes on u2)
		const { summary } = await compact(pi, ctx, pi.branch[1].id);
		assert.ok(summary.includes("## u1 — VERIFIED (superseded → u2)"), "u1 renders as the forward-linked one line");
		assert.ok(summary.includes("- supersedes: u1 (retired — their content is carried in this unit; each original stays retrievable)"), "u2 carries the supersedes metadata");

		// and unretire RESTORES it for the fold AFTER that
		const res2 = (await pi.tools.get("unretire")!.execute("tc-tu2", { units: [1] }, new AbortController().signal, undefined, ctx)) as ToolResult;
		assert.equal(res2.content[0].text as string, unretireAckText([1]), "the unretire ack is byte-pinned");
		const { summary: summary2 } = await compact(pi, ctx, pi.branch[pi.branch.length - 2].id);
		assert.ok(summary2.includes("## u1 — VERIFIED · "), "after unretire, u1 renders FULL again (soft reversal)");
		assert.ok(!summary2.includes("(superseded → u2)"), "the superseded mark is gone");
	} finally {
		restoreNudge();
		__setCloseAuditRunner(null);
	}
});

test("GLUE: retire_units refuses atomically — unknown id ⇒ REFUSED ack + NO ledger entry; unretire refuses empty", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "off");
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		pi.contextUsage = { tokens: 30_000, contextWindow: 131_072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		setRunnerFor(writeFork(1, "VERIFIED\nFACTS: fact one\nEVIDENCE: T4", "fork-refuse.jsonl"));
		await closeUnit(pi, ctx, "wrote data.txt", "tc-rf1");
		pi.branch.push(msg("user", "a second task, done"));
		setRunnerFor(writeFork(2, "VERIFIED\nFACTS: fact two stands\nEVIDENCE: T5", "fork-refuse2.jsonl"));
		await closeUnit(pi, ctx, "the second task done", "tc-rf1b"); // now both u1 AND u2 are known on the branch
		// superseded non-empty WITHOUT supersededBy ⇒ refuse
		const res = (await pi.tools.get("retire_units")!.execute("tc-rf2", { superseded: [1], dropped: [] }, new AbortController().signal, undefined, ctx)) as ToolResult;
		assert.equal(res.content[0].text as string, retireRefuseText("supersededBy is required when superseded is non-empty (the new curated close_unit unit)"));
		// unknown id ⇒ refuse, and NOTHING is appended
		const before = pi.appended.length;
		const res2 = (await pi.tools.get("retire_units")!.execute("tc-rf3", { superseded: [1], supersededBy: 2, dropped: [9] }, new AbortController().signal, undefined, ctx)) as ToolResult;
		assert.ok((res2.content[0].text as string).startsWith("Retire REFUSED: unknown unit id(s): 9"), "the known-list rides the message");
		assert.equal(pi.appended.length, before, "ATOMIC — the whole batch is refused, no entry is appended");
		// unretire with no units ⇒ refuse
		const res3 = (await pi.tools.get("unretire")!.execute("tc-rf4", { units: [] }, new AbortController().signal, undefined, ctx)) as ToolResult;
		assert.ok((res3.content[0].text as string).startsWith("Retire REFUSED: no unit ids given"), "empty unretire is refused, not a no-op success");
	} finally {
		restoreNudge();
		__setCloseAuditRunner(null);
	}
});

/* v5 RETIRE light-carry (2026-10-06 fix, Paul: the retire-upgrade close is
   ALWAYS light — a curated carry-over is a copy, not new work; the carried-over
   claims are taken over as-is, not re-derived). The deterministic close-time
   signal is the RETIRE-CARRY first stub line (the retire_units entry lands
   AFTER the close — validateRetireCall requires supersededBy to be known). */

test("GLUE: a RETIRE-CARRY-marked close is audited LIGHT (forced, recorded on the close record); an unmarked close keeps the zone decision (fail-safe)", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "off");
	try {
		const pi = makeFakePi([msg("user", "task one, done in full")]);
		pi.contextUsage = { tokens: 30_000, contextWindow: 131_072 }; // calm zone ⇒ the zone call is MEDIUM (below band, 2026-10-17)
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const closeRecords = (p: FakePi) =>
			p.appended
				.filter((a) => a.customType === "sam") // SAM_LEDGER_CUSTOM_TYPE — the close records (the retire TRACES ride the nudge type)
				.map((a) => a.data as Record<string, unknown>)
				.filter((d) => d.kind === "close");

		// unmarked close in the calm zone ⇒ MEDIUM (the zone decision stands — below band, 2026-10-17)
		setRunnerFor(writeFork(1, "VERIFIED\nFACTS: task one done\nEVIDENCE: T-L1", "fork-lc1.jsonl"));
		const r1 = await closeUnit(pi, ctx, "did task one", "tc-lc1");
		assert.match(r1.content[0].text as string, /Unit 1 closed — audit VERIFIED/);
		const rec1 = closeRecords(pi).find((d) => d.unitId === 1);
		assert.ok(rec1, "u1's close record is on the ledger");
		assert.equal(rec1.depth, "medium", "no marker ⇒ the calm zone's MEDIUM stands (below band; never a silent LIGHT)");
		assert.equal(rec1.depthForced, undefined, "no forced depth recorded");

		// marked close (the retire-upgrade carrier) ⇒ FORCED light, even in the calm zone
		pi.branch.push(msg("user", "carry the still-relevant parts of u1 forward"));
		setRunnerFor(writeFork(2, "NOT-YET-VERIFIED: files: 1/1 present; statements: delivered", "fork-lc2.jsonl"));
		const r2 = await closeUnit(pi, ctx, "RETIRE-CARRY u1\nthe curated carry-over of u1's still-relevant files and facts", "tc-lc2");
		assert.match(r2.content[0].text as string, /Unit 2 closed — audit NOT-YET-VERIFIED/, "the light rung's contract verdict (one turn, no tools)");
		const rec2 = closeRecords(pi).find((d) => d.unitId === 2);
		assert.ok(rec2, "u2's close record is on the ledger");
		assert.equal(rec2.depth, "light", "the marker FORCED light despite the calm zone (a full audit would re-derive the carried claims — Paul: taken over as-is)");
		assert.equal(rec2.depthForced, "retire-carry", "the forced depth is recorded on the close record (decision-in-ledger — auditable from the file)");
	} finally {
		restoreNudge();
		__setCloseAuditRunner(null);
	}
});

/* ══ context-pressure safenet (2026-10-16): the auto-retire pure core ══
 *  Section A layer (pure core, retire.ts) — state machine, selection,
 *  target sizing, matryoshka. The glue (index.ts) is tested by the
 *  GLUE scenario below it. */

import {
	createAutoRetireState,
	autoRetireArmOnNudge,
	autoRetireSupersededByModel,
	autoRetireDecision,
	autoRetireCandidates,
	autoRetireSelect,
	autoRetireTargetChars,
	previousAutoRetire,
	isAutoRetireAction,
	AUTORETIRE_TARGET_FLOOR_CHARS,
	AUTORETIRE_GOAL_RESERVE_TOKENS,
	type AutoRetireAction,
} from "../src/retire.ts";

const safRec = (unitId: number, chars: number, verdict: "VERIFIED" | "UNVERIFIED-AUDIT-FAILED" = "VERIFIED"): SamSettlementRecord => ({
	v: 1,
	kind: "settlement",
	unitId,
	retrievalId: `r${unitId}0000000000`.slice(0, 12),
	verdict,
	sections: { FACTS: "x".repeat(chars) },
	line: `${unitId}`,
	auditFile: "",
	replyId: null,
	parsedClean: true,
});
const autoRec = (unitId: number, units: number[], retrievalId = `a${unitId}000000000`.slice(0, 12)): AutoRetireAction => ({
	v: 1,
	kind: "autoRetire",
	ts: 100,
	foldId: `fold-${unitId}`,
	unitId,
	retrievalId,
	units,
	items: units.map((u) => ({ unitId: u, retrievalId: `r${u}0000000000`.slice(0, 12), verdictClass: "VERIFIED" })),
});

test("SAFENET: the auto-retire arming state machine (arm → supersede → decision)", () => {
	const st = createAutoRetireState();
	assert.equal(st.armed, false);
	assert.equal(st.offerConsumed, false);
	autoRetireArmOnNudge(st, "fold-1", 1_000);
	assert.deepEqual(st, { armed: true, foldId: "fold-1", ts: 1_000, offerConsumed: true }, "the arm sets all four fields (Q4: the offer is consumed)");
	// a later arm supersedes (no cool-down — Q2)
	autoRetireArmOnNudge(st, "fold-2", 2_000);
	assert.equal(st.foldId, "fold-2");
	// the model acting AFTER the arming yields the system
	assert.equal(autoRetireSupersededByModel(st, []), false);
	assert.equal(autoRetireSupersededByModel(st, [{ v: 1, kind: "retire", ts: 999, superseded: [1], supersededBy: 9, dropped: [] }]), false, "a retire BEFORE the arm does not count");
	assert.equal(autoRetireSupersededByModel(st, [{ v: 1, kind: "unretire", ts: 2_000, units: [1] }]), true, "an unretire AT the arm ts counts (the model acted)");
	assert.equal(autoRetireSupersededByModel(createAutoRetireState(), [{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 2, dropped: [] }]), false, "unarmed ⇒ never superseded");
	// the decision matrix
	assert.equal(autoRetireDecision(createAutoRetireState(), false, 3), "wait", "not armed ⇒ wait");
	assert.equal(autoRetireDecision(st, false, 3), "commit", "armed + model idle + candidates ⇒ commit");
	assert.equal(autoRetireDecision(st, true, 3), "disarm", "the model acted ⇒ disarm (no double-act)");
	assert.equal(autoRetireDecision(st, false, 0), "disarm", "nothing to retire ⇒ disarm");
});

test("SAFENET: autoRetireCandidates — settled, not retired, oldest first, newest protected", () => {
	const records = [safRec(5), safRec(1), safRec(3), safRec(2)];
	const c = autoRetireCandidates(records, []);
	assert.deepEqual(c, [1, 2, 3], "sorted ascending, the newest (u5) protected by default");
	assert.deepEqual(autoRetireCandidates(records, [], 0), [1, 2, 3, 5], "protectNewest=0 lifts the protection");
	assert.deepEqual(autoRetireCandidates(records, [], 2), [1, 2], "protectNewest=2 protects u3 and u5");
	assert.deepEqual(autoRetireCandidates([safRec(1)], []), [], "a single settled unit is protected ⇒ no candidates");
	assert.deepEqual(autoRetireCandidates([], []), [], "no settlements ⇒ no candidates");
	// already-retired units (any shape) are excluded
	const entries = [
		{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 5, dropped: [2] },
	];
	assert.deepEqual(autoRetireCandidates(records, entries), [3], "u1 (superseded) and u2 (dropped) are gone; u5 is protected");
	// an autoRetire entry's units are already retired too
	assert.deepEqual(autoRetireCandidates([safRec(1), safRec(2), safRec(3)], [autoRec(4, [1])]), [2], "autoRetire'd u1 is not a candidate again");
});

test("SAFENET: autoRetireSelect — pre-existing retirements excluded from `remaining` (2026-10-18 fix)", () => {
	const render = (r: SamSettlementRecord) => r.sections.FACTS;
	const records = [safRec(1, 10_000), safRec(2, 10_000), safRec(3, 10_000), safRec(4, 10_000), safRec(5, 10_000), safRec(6, 10_000)];
	const entries = [{ v: 1, kind: "retire", ts: 1, superseded: [], dropped: [1, 2] }];
	// rendered stack = u3+u4+u5+u6 = 40k (u6 protected); candidates u3, u4, u5
	// post-fix: pick u3 → 30k (first pick, never stops), pick u4 → 20k < 25k ⇒ stop
	assert.deepEqual(
		autoRetireSelect(records, entries, 25_000, render),
		[3, 4],
		"remaining starts at 40k (the dropped units' 20k are excluded) ⇒ stop after u4; the pre-fix empty seed (60k) would have run out of candidates at [3, 4, 5]",
	);
	// the rendered stack already under the target ⇒ the minimum two picks (the 'first pick never stops' pin), then stop
	assert.deepEqual(autoRetireSelect(records, entries, 50_000, render), [3, 4], "under-target from the start ⇒ pick u3 (30k, never stops), pick u4 (20k < 50k ⇒ stop); the 25k pin above is the pre/post discriminator");
});

test("SAFENET: autoRetireSelect — oldest first, at least one, stops under the target", () => {
	const render = (r: SamSettlementRecord) => r.sections.FACTS;
	const records = [safRec(1, 10_000), safRec(2, 10_000), safRec(3, 10_000), safRec(4, 10_000)];
	// start: 40k rendered (u4 protected). target 25k: pick u1 → 30k (first pick, no stop),
	// pick u2 → 20k < 25k ⇒ stop
	assert.deepEqual(autoRetireSelect(records, [], 25_000, render), [1, 2]);
	// target 15k: u1 → 30k, u2 → 20k (not under 15k), u3 → 10k < 15k ⇒ stop
	assert.deepEqual(autoRetireSelect(records, [], 15_000, render), [1, 2, 3]);
	// target 0: the remaining (10k blocks) never falls under 0 ⇒ every candidate
	assert.deepEqual(autoRetireSelect(records, [], 0, render), [1, 2, 3]);
	// a single candidate: it is protected ⇒ no selection
	assert.deepEqual(autoRetireSelect([safRec(1)], [], 25_000, render), []);
	// no candidates ⇒ no selection
	assert.deepEqual(autoRetireSelect([], [], 25_000, render), []);
});

test("SAFENET: autoRetireTargetChars — min(configured, token-aware) with the floor (Q1+Q2)", () => {
	assert.equal(AUTORETIRE_TARGET_FLOOR_CHARS, 16_000, "the floor is pinned");
	assert.equal(AUTORETIRE_GOAL_RESERVE_TOKENS, 2_000, "the goal reserve is pinned");
	const ladder64 = { window: 64_000, reserve: 16_384, keepRecent: 20_000 };
	// token-aware: (64000−16384−20000) − 20000 − 2000 = 5616 tokens → 22464 chars
	// ⇒ below the 40k config ⇒ the token-aware value binds at 64k windows
	assert.equal(autoRetireTargetChars(ladder64, 20_000, 40_000), 22_464);
	// a bigger window: (131072−16384−20000) − 20000 − 2000 = 72688 tokens → 290752 chars
	// ⇒ the 40k config binds (the Q1 default is a CONFIG VALUE)
	assert.equal(autoRetireTargetChars({ window: 131_072, reserve: 16_384, keepRecent: 20_000 }, 20_000, 40_000), 40_000);
	// a tiny window: the headroom term is clamped at 0 ⇒ (0) − 20000 − 2000 < 0 → 0 chars
	// ⇒ the floor takes over (a tiny window never demands an absurd fraction)
	assert.equal(autoRetireTargetChars({ window: 8_000, reserve: 16_384, keepRecent: 20_000 }, 20_000, 40_000), 16_000, "the floor binds");
	// a smaller configured threshold still binds when both are above the floor
	assert.equal(autoRetireTargetChars({ window: 131_072, reserve: 16_384, keepRecent: 20_000 }, 20_000, 20_000), 20_000);
});

test("SAFENET: the matryoshka (previousAutoRetire) + retiredStates over autoRetire entries", () => {
	const a1 = autoRec(4, [1, 2], "a10000000000".slice(0, 12));
	const a2 = autoRec(6, [3, 4], "a20000000000".slice(0, 12));
	assert.equal(previousAutoRetire([a1]), a1);
	assert.equal(previousAutoRetire([a1, a2]), a2, "the IMMEDIATELY previous entry (newest)");
	assert.equal(previousAutoRetire([]), undefined);
	assert.equal(previousAutoRetire([{ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 2, dropped: [] }]), undefined, "manual entries are not auto-retires");
	// the state guard
	assert.equal(isAutoRetireAction(a1), true);
	assert.equal(isAutoRetireAction({ v: 1, kind: "retire", ts: 1, superseded: [1], supersededBy: 2, dropped: [] }), false);
	assert.equal(isAutoRetireAction(undefined), false);
	// retiredStates: an autoRetire's units are all "dropped" (soft — retrievable, restorable)
	const st = retiredStates([a1]);
	assert.equal(st.get(1)?.shape, "dropped");
	assert.equal(st.get(2)?.shape, "dropped");
	assert.equal(st.has(3), false);
});

/* ══ context-pressure safenet (decision point 1, Paul 2026-10-16): the GLUE
 *  end-to-end — the pressure nudge at fold time (part a), the consumed
 *  retire offer (Q4), and the auto-retire commit at the NEXT fold (part b).
 *  The test-scale forcing: a context window (10_000) BELOW the reserve
 *  (16_384) makes the pressure line negative ⇒ every finite estimate is
 *  under pressure (deterministic; the production line is W−R−headroom). */

test("GLUE: SAFENET — pressure nudge after fold 1, offer consumed, u1 system-retired at fold 2", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "on");
	const restoreThr = withEnv("SAM_RETIRE_CHARS", "10");
	try {
		const pi = makeFakePi([msg("user", "first task, done in full")]);
		// a window below the reserve ⇒ the pressure line is negative ⇒ any
		// finite estimate triggers the nudge (deterministic test-scale forcing)
		pi.contextUsage = { tokens: null, contextWindow: 10_000 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		// u1 closed before fold 1 (the future auto-retire candidate)
		setRunnerFor(writeFork(1, "VERIFIED\nFACTS: first fact holds\nEVIDENCE: MARKER-S1", "fork-s1.jsonl"));
		const r1 = await closeUnit(pi, ctx, "did the first task", "tc-s1");
		assert.match(r1.content[0].text as string, /Unit 1 closed — audit VERIFIED/);

		// fold 1 (takeover): the safenet is NOT armed yet (no session_compact yet)
		const compact1 = await compact(pi, ctx, pi.branch[1].id);
		assert.ok(!compact1.summary.includes("## AUTO-RETIRE"), "no auto-retire yet (not armed)");

		// pi emits session_compact AFTER the takeover → the post-fold pressure
		// check (part a): nudge + arm + offer consumed
		const compacts = pi.listeners.get("session_compact") ?? [];
		assert.equal(compacts.length, 1, "exactly one session_compact listener");
		await compacts[0](
			{
				reason: "native",
				fromExtension: false,
				compactionEntry: { type: "compaction", id: "comp-1", parentId: "x", summary: "old", firstKeptEntryId: "k1", tokensBefore: 120_000 },
			},
			ctx,
		);
		assert.ok(pi.messages.some((m) => m.content?.includes("[sam-fold-ack]")), "the fold ack still queues (F1: ack first, order second)");
		const nudges = pi.sent.filter((s) => s.text.startsWith("[sam-pressure] ACT NOW"));
		assert.equal(nudges.length, 1, "the act-now nudge was sent");
		assert.equal(nudges[0].options?.deliverAs, "steer", "the D7 channel (queued for the next LLM call)");

		// Q4: the soft offer is CONSUMED — the next close in this span does not offer
		pi.branch.push(msg("user", "second task, done in full"));
		setRunnerFor(writeFork(3, "VERIFIED\nFACTS: second fact holds\nEVIDENCE: MARKER-S2", "fork-s2.jsonl"));
		const r2 = await closeUnit(pi, ctx, "did the second task", "tc-s2");
		assert.match(r2.content[0].text as string, /Unit 3 closed — audit VERIFIED/);
		assert.equal(pi.sent.filter((s) => s.text.startsWith("[sam-nudge] Retire offer —")).length, 0, "the soft offer was consumed by the emergency order (Q4)");

		// fold 2 (takeover): the armed auto-retire COMMITS — u1 is system-retired
		const compact2 = await compact(pi, ctx, pi.branch[pi.branch.length - 2].id);
		assert.ok(compact2.summary.includes("## AUTO-RETIRE — u1 · "), "the AUTO-RETIRE block names u1");
		const u1Settlement = pi.appended.find((a) => { const d = a.data as { kind?: string; unitId?: number } | undefined; return d?.kind === "settlement" && d.unitId === 1; });
		const u1RetrievalId = (u1Settlement.data as { retrievalId: string }).retrievalId;
		assert.ok(compact2.summary.includes(`original: sam_retrieve ${u1RetrievalId}`), "the per-unit retrieval pointer");
		assert.ok(!compact2.summary.includes("## u1 — "), "retired u1 is GONE from the settlement stack");
		assert.ok(compact2.summary.includes("## u3 — VERIFIED"), "u3 (the newest) still renders");
		// the durable write: the autoRetire entry + the synthesized settlement
		const autoEntries = pi.appended.filter((a) => (a.data as { kind?: string } | undefined)?.kind === "autoRetire");
		assert.equal(autoEntries.length, 1, "exactly one autoRetire ledger entry");
		assert.deepEqual((autoEntries[0].data as { units: number[] }).units, [1]);
		const synth = pi.appended.filter((a) => {
			const d = a.data as { kind?: string; verdict?: string } | undefined;
			return d?.kind === "settlement" && d.verdict === "AUTO-RETIRE";
		});
		assert.equal(synth.length, 1, "the synthesized AUTO-RETIRE settlement was committed");

		// Q3: 'unit N' retrieval serves the minted orphan (the banked raw span)
		// and the AUTO-RETIRE unit (its items + the synthesized settlement line)
		const orphanRes = (await pi.tools.get("sam_retrieve")!.execute("tc-rv1", { id: "unit 4" }, new AbortController().signal, undefined, ctx)) as ToolResult;
		assert.match(orphanRes.content[0].text as string, /^\[orphan unit 4 — raw span banked at fold /, "the minted orphan is retrievable as 'unit N' (fold 2: u1, u2=orphan-1, u3, u4=orphan-2)");
		assert.ok((orphanRes.content[0].text as string).includes("Unit 1 closed — audit VERIFIED"), "the banked span is the answer");
		const autoRes = (await pi.tools.get("sam_retrieve")!.execute("tc-rv2", { id: "unit 5" }, new AbortController().signal, undefined, ctx)) as ToolResult;
		assert.match(autoRes.content[0].text as string, /\[\w{12}\] unit 5 — settlement/, "the AUTO-RETIRE unit is retrievable as 'unit N' (via its synthesized settlement record — the shared unitId)");
		assert.ok((autoRes.content[0].text as string).includes("AUTO-RETIRE: u1 (VERIFIED) #"), "the settlement line (with u1's retrieval pointer) is the answer");
		const noneRes = (await pi.tools.get("sam_retrieve")!.execute("tc-rv3", { id: "unit 9" }, new AbortController().signal, undefined, ctx)) as ToolResult;
		assert.match(noneRes.content[0].text as string, /no SAM record found for 'unit 9'/, "an unknown unit still degrades to the actionable not-found");
	} finally {
		restoreNudge();
		restoreThr();
		__setCloseAuditRunner(null);
	}
});

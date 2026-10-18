/**
 * P5 branch-audit — pure logic pins (no pi, no live inference).
 * The model-facing strings are pinned by test/protocol pins (extension.test.ts)
 * and this file; the settle orchestration (index.ts) is exercised by the walk
 * E-scenario (zero-inference) and the live E27 (banked).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	readRawSessionFile,
	findLastAuditTurn,
	parseBranchAuditReply,
	retrievalIdOf,
	buildSettlementRecord,
	spanHasSettlement,
	takeoverSummary,
	takeoverDetails,
	tombstoneJsonl,
	SETTLEMENTS_HEADER,
	TAKEOVER_POINTER,
	computeOrphanZone,
} from "../src/branchaudit.ts";
import type { RawEntry } from "../src/projection.ts";
import { GOAL_FALLBACK_HEADER } from "../src/goal.ts";
import { branchAuditInstruction, mediumAuditInstruction, settlementLine, AUDIT_INSTRUCTION_PREFIX, AUDIT_DEADLINE_PREFIX, auditDeadlineNudgeText } from "../src/protocol.ts";

/* ── the audit instruction (P5 shape) ────────────────────────────────────── */

test("branchAuditInstruction keeps the R2 contract + prefix/unit-id, adds the five sections", () => {
	const base = require_protocol_base(1);
	const p5 = branchAuditInstruction(1, { stub: "STUB unit 1: svc-a=8123", evidence: { files: ["a.json[read,stat]"], errors: 0, retries: 1, nonTrivial: true } });
	assert.ok(p5.startsWith(`${AUDIT_INSTRUCTION_PREFIX} Unit 1 was just closed.`), "prefix + unit id (the rebuild finder contract)");
	assert.ok(p5.includes("STUB (verbatim):"), "R2 self-containment: the stub verbatim");
	for (const s of ["FACTS:", "DECISIONS:", "DISPROVED:", "EXPLORED-DISCARDED:", "EVIDENCE:"]) {
		assert.ok(p5.includes(s), `section '${s}' in the instruction`);
	}
	// 2026-10-06 (Paul): the per-fact unverified escape in the sectioned format.
	assert.match(p5, /unverified: \u003cfact\u003e/, "the escape names the exact 'unverified: ' prefix");
	assert.match(p5, /the unit's verdict line is not downgraded for it/, "per-fact escape does not downgrade the unit verdict");
	// MEDIUM AUDIT TIER (2026-10-17): the per-fact PLAUSIBLE marker + the new
	// full line-1 contract (PLAUSIBLE is now a full-depth verdict too).
	// v0.0.11 (2026-10-17, Paul): full also carries the NYV total-failure
	// escape (a completed audit that verified nothing settles at the
	// weakest rung — the D9 hatch is reserved for process failures).
	assert.match(p5, /plausible: \u003cfact\u003e/, "the PLAUSIBLE marker names the exact 'plausible: ' prefix");
	assert.match(p5, /line 1 exactly VERIFIED, PLAUSIBLE, or CORRECTIONS: \u003cshort list\u003e, or \(if you could not check anything at all\) NOT-YET-VERIFIED: \u003cshort reason\u003e\./, "full's line-1 contract: PLAUSIBLE + the NYV escape (v0.0.11)");
	assert.ok(!base.replace(/Reply exactly VERIFIED, PLAUSIBLE, or CORRECTIONS: <short list>, and nothing else\.$/, "").includes("FACTS:"), "the base (in-series) instruction has no sections — the P5 shape is branch-only");
});

/* ── MEDIUM AUDIT TIER (2026-10-17): the routine-close instruction (wording = pins) ── */

test("mediumAuditInstruction: the cheap cross-check contract (tool calls only to confirm/refute named claims; no redo of the unit's work; contradiction detection, not a cheaper verified)", () => {
	const m = mediumAuditInstruction(4, { stub: "STUB unit 4: did the thing.", evidence: { files: ["a.ts[read]"], errors: 0, retries: 0, nonTrivial: true } });
	assert.ok(m.startsWith(`${AUDIT_INSTRUCTION_PREFIX} Unit 4 was just closed.`), "prefix + unit id (the rebuild finder contract)");
	assert.ok(m.includes("MEDIUM AUDIT (the routine close):"), "names the rung");
	assert.ok(m.includes("STUB (verbatim):"), "R2 self-containment: the stub verbatim");
	assert.match(m, /RECORDED AT CLOSE/);
	assert.match(m, /entries are ground truth/, "ground-truth mandate");
	assert.match(m, /ONLY to confirm or refute a specific claim/, "tool calls are claim-scoped");
	assert.match(m, /You may not redo\n?\s*the unit's work/, "no redo of the unit's work");
	assert.match(m, /no re-running tests, builds, sweeps or research/, "the costly-work list");
	assert.match(m, /evidence of record/, "recorded outputs are the evidence");
	assert.match(m, /Batching several small checks over a few/, "batching fine (the qualitative budget — no hard cap)");
	assert.match(m, /nothing long-running or complex/, "the qualitative incentive");
	assert.match(m, /contradiction detection, not a cheaper verified/, "the aim (Paul's R1)");
	assert.match(m, /plausible: \u003cfact\u003e/, "the PLAUSIBLE per-fact marker");
	// medium's line-1 contract: VERIFIED / PLAUSIBLE / CORRECTIONS / the
	// NOT-YET-VERIFIED total-failure escape (as of v0.0.11, 2026-10-17,
	// shared with full — a completed audit that verified nothing settles at
	// the weakest rung; the D9 hatch is reserved for process failures).
	assert.match(m, /line 1 exactly VERIFIED, PLAUSIBLE, or CORRECTIONS: \u003cshort list\u003e, or \(if you could not check anything at all\) NOT-YET-VERIFIED: \u003cshort reason\u003e\./, "the medium line-1 contract");
	for (const s of ["FACTS:", "DECISIONS:", "DISPROVED:", "EXPLORED-DISCARDED:", "EVIDENCE:"]) {
		assert.ok(m.includes(s), `section '${s}' in the medium instruction (the shared sectioned format)`);
	}
});

test("mediumAuditInstruction: payload-less call stays valid (restored/legacy closes)", () => {
	const m = mediumAuditInstruction(9);
	assert.ok(m.startsWith(`${AUDIT_INSTRUCTION_PREFIX} Unit 9 was just closed.`));
	assert.ok(!m.includes("STUB (verbatim):"), "no stub line without a stub");
	assert.ok(!m.includes("RECORDED AT CLOSE"), "no facts line without evidence");
});

// the R2 base text is imported indirectly (protocol exports auditInstruction)
import { auditInstruction } from "../src/protocol.ts";
function require_protocol_base(unit: number): string {
	return auditInstruction(unit);
}

/* ── reply parsing (line-1 contract + sections) ──────────────────────────── */

const FULL_REPLY = [
	"VERIFIED",
	"FACTS: svc-a=8123, svc-b=9455, 77 ERROR lines, build 2026.09.01, latency sum 139587 ms",
	"DECISIONS: unit closed with stub as claimed",
	"DISPROVED: summary.md claim svc-b 8111 (observed 9455)",
	"EXPLORED-DISCARDED: none",
	"EVIDENCE: MARKER: filler-one-7f3a9c; MARKER: filler-two-2c81b6",
].join("\n");

test("parseBranchAuditReply: VERIFIED + all five sections, clean", () => {
	const p = parseBranchAuditReply(FULL_REPLY);
	assert.equal(p.verdict.class, "VERIFIED");
	assert.equal(p.sections["FACTS"], "svc-a=8123, svc-b=9455, 77 ERROR lines, build 2026.09.01, latency sum 139587 ms");
	assert.equal(p.sections["EVIDENCE"], "MARKER: filler-one-7f3a9c; MARKER: filler-two-2c81b6");
	assert.ok(p.parsedClean, "every line accounted for");
});

test("parseBranchAuditReply: CORRECTIONS keeps the R2 list on line 1", () => {
	const p = parseBranchAuditReply("CORRECTIONS: svc-b is 9455 not 8111\nFACTS: svc-b=9455 (observed)");
	assert.equal(p.verdict.class, "CORRECTIONS");
	assert.equal(p.verdict.corrections, "svc-b is 9455 not 8111");
	assert.equal(p.sections["CORRECTIONS"], "svc-b is 9455 not 8111");
	assert.equal(p.sections["FACTS"], "svc-b=9455 (observed)");
});

test("parseBranchAuditReply: line 1 stays the R2 contract (parseVerdict parity)", () => {
	assert.equal(parseBranchAuditReply("verified").verdict.class, "VERIFIED");
	assert.equal(parseBranchAuditReply("CORRECTIONS: list\nDISPROVED: none").verdict.class, "CORRECTIONS");
	assert.equal(parseBranchAuditReply("some other line\nFACTS: x").verdict.class, "UNAUDITABLE");
});

test("parseBranchAuditReply: EVIDENCE spans until the next section/EOF (multi-line content)", () => {
	const reply = "VERIFIED\nEVIDENCE: MARKER: filler-one-7f3a9c;\nMARKER: filler-two-2c81b6\nFACTS: a=1";
	const p = parseBranchAuditReply(reply);
	// FACTS after EVIDENCE — the EVIDENCE must NOT swallow the FACTS line
	assert.equal(p.sections["FACTS"], "a=1");
	assert.ok(p.sections["EVIDENCE"].includes("filler-one-7f3a9c"));
});

test("parseBranchAuditReply: unexplained lines mark parsedClean=false but do not fail the verdict", () => {
	const p = parseBranchAuditReply("VERIFIED\nI also did other things\nFACTS: a=1");
	assert.equal(p.verdict.class, "VERIFIED");
	assert.equal(p.parsedClean, false);
	assert.ok("I also did other things" in p.sections || p.sections["FACTS"] === "a=1");
});

/* ── settlement line (Paul's Q1/Q3 shape, retrievalId first) ─────────────── */

test("settlementLine: ID VERIFIED: fact 1, fact 2, decision 3, disproved 4, explored and discarded 5", () => {
	const line = settlementLine("abcdef123456", "VERIFIED", {
		FACTS: "svc-a=8123, svc-b=9455",
		DECISIONS: "unit closed",
		DISPROVED: "8111 claim",
		"EXPLORED-DISCARDED": "none",
	});
	assert.equal(line, "abcdef123456 VERIFIED: svc-a=8123, svc-b=9455, unit closed, disproved: 8111 claim, explored and discarded: none");
});

test("settlementLine: EVIDENCE rides at the end (the compaction-takeover lifeline)", () => {
	const line = settlementLine("abcdef123456", "VERIFIED", { FACTS: "a=1", EVIDENCE: "MARKER: filler-one-7f3a9c; MARKER: filler-two-2c81b6" });
	assert.equal(line, "abcdef123456 VERIFIED: a=1, evidence: MARKER: filler-one-7f3a9c; MARKER: filler-two-2c81b6");
});

test("settlementLine: an OMITTED section (the audit instruction's 'omitting empty sections') stays absent, the rest keeps canonical order (rep-2 live shape)", () => {
	// Live rep-2 (bank p5-live-ab-2026-10-01-armE-rep2): the auditor replied
	// VERIFIED + FACTS/DECISIONS/DISPROVED/EVIDENCE and correctly OMITTED the
	// empty EXPLORED-DISCARDED section — the digest must drop it, keep the
	// others in order, and never invent a placeholder.
	const line = settlementLine("5845c1830ce5", "VERIFIED", {
		FACTS: "svc-a=8123, svc-b=9455, ERROR=77",
		DECISIONS: "bash cross-checks",
		DISPROVED: "summary.md svc-b 8111 → 9455",
		EVIDENCE: "port 8123; port 9455",
	});
	assert.equal(line, "5845c1830ce5 VERIFIED: svc-a=8123, svc-b=9455, ERROR=77, bash cross-checks, disproved: summary.md svc-b 8111 → 9455, evidence: port 8123; port 9455");
	assert.ok(!/explored and discarded/i.test(line), "the omitted section must not appear");
	const iDis = line.search(/disproved:/i);
	const iEv = line.search(/evidence:/i);
	assert.ok(iDis >= 0 && iEv >= 0 && iDis < iEv, "canonical order among the present sections");
});

test("settlementLine: CORRECTIONS keeps the list first after the class word", () => {
	const line = settlementLine("abcdef123456", "CORRECTIONS", { CORRECTIONS: "svc-b is 9455", FACTS: "svc-b=9455" });
	assert.equal(line, "abcdef123456 CORRECTIONS: svc-b is 9455, svc-b=9455");
});

test("retrievalIdOf: stable 12-hex, content-sensitive", () => {
	const a = retrievalIdOf("/s/fork.jsonl", "leaf-1", "VERIFIED\nFACTS: x");
	const b = retrievalIdOf("/s/fork.jsonl", "leaf-1", "VERIFIED\nFACTS: x");
	const c = retrievalIdOf("/s/fork.jsonl", "leaf-2", "VERIFIED\nFACTS: x");
	const d = retrievalIdOf("/s/fork.jsonl", "leaf-1", "VERIFIED\nFACTS: y");
	assert.match(a, /^[0-9a-f]{12}$/);
	assert.equal(a, b, "deterministic");
	assert.notEqual(a, c, "reply-id sensitive");
	assert.notEqual(a, d, "content sensitive");
});

/* ── shared raw-entry fixtures (MAIN = a close on the main line; FORK = a
 * branch audit turn: the instruction + the full reply) ──────────────────── */

const MAIN = [
	{ id: "m1", type: "message", message: { role: "user", content: "do the work" } },
	{ id: "m2", type: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 1, stub: "stub text" } },
];
const FORK = [
	{ id: "f1", type: "message", message: { role: "user", content: `${AUDIT_INSTRUCTION_PREFIX} Unit 1 was just closed. Reply format: ...` } },
	{ id: "f2", type: "message", message: { role: "assistant", content: FULL_REPLY } },
];

/* ── findLastAuditTurn ────────────────────────────────────────────────────── */

test("findLastAuditTurn: last instruction + first assistant reply after it", () => {
	const turn = findLastAuditTurn(FORK);
	assert.equal(turn?.unitId, 1);
	assert.equal(turn?.replyId, "f2");
	assert.ok(turn?.replyText.startsWith("VERIFIED"));
});

test("findLastAuditTurn: the auditor works with tool calls between instruction and reply — the reply is the LAST non-empty assistant (rep-1 live shape, banked)", () => {
	const live = [
		FORK[0],
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "check the raw span" }, { type: "toolCall", id: "t1", name: "read", arguments: {} }] } },
		{ id: "a2", type: "message", message: { role: "toolResult", content: "raw span bytes" } },
		{ id: "a3", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "re-verify the facts" }, { type: "toolCall", id: "t2", name: "bash", arguments: {} }] } },
		{ id: "a4", type: "message", message: { role: "toolResult", content: "77" } },
		{ id: "a5", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "done" }, { type: "text", text: "VERIFIED\nFACTS: svc-a=8123, svc-b=9455\nDISPROVED: svc-b 8111 (observed 9455)" }] } },
	];
	const t = findLastAuditTurn(live);
	assert.equal(t?.replyId, "a5", "the final reply wins over the intermediate tool-call steps");
	assert.ok(t?.replyText.startsWith("VERIFIED"));
	assert.ok(t?.replyText.includes("DISPROVED:"));
});

test("findLastAuditTurn: a trailing pi-banked EMPTY assistant after the reply keeps the real reply", () => {
	const t = findLastAuditTurn([...FORK, { id: "f5", type: "message", message: { role: "assistant", content: "" } }]);
	assert.equal(t?.replyId, "f2");
	assert.ok(t?.replyText.startsWith("VERIFIED"));
});

/* v0.0.11 (2026-10-17, Paul — the deadline nudge): the [sam-audit-deadline]
 * user message is TRANSPARENT for the forward scan. Measured pi 0.87.1: the
 * print-run loop continues with a further turn whenever a message is queued,
 * so the verdict may legitimately FOLLOW the nudge; the reply of record is
 * the last non-empty assistant turn AFTER the LAST nudge (the nudge's
 * re-emit clause keeps that turn a clean verdict block). */

test("findLastAuditTurn: a deadline nudge MID-audit is transparent — the verdict AFTER the nudge is the reply of record (the nudge is not a user-turn boundary)", () => {
	const nudged = [
		FORK[0],
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "checking the stub claims" }, { type: "toolCall", id: "t1", name: "read", arguments: {} }] } },
		{ id: "n1", type: "message", message: { role: "user", content: auditDeadlineNudgeText(480_000) } },
		{ id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: FULL_REPLY }] } },
	];
	const t = findLastAuditTurn(nudged);
	assert.equal(t?.replyId, "a2", "the post-nudge verdict is picked (not cut off at the nudge)");
	assert.ok(t?.replyText.startsWith("VERIFIED"));
});

test("findLastAuditTurn: a LATE deadline nudge (after the verdict) — the re-emitted verdict after the LAST nudge is the reply of record", () => {
	const late = [
		FORK[0],
		{ id: "a1", type: "message", message: { role: "assistant", content: FULL_REPLY } },
		{ id: "n1", type: "message", message: { role: "user", content: auditDeadlineNudgeText(480_000) } },
		{ id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: FULL_REPLY }] } },
	];
	const t = findLastAuditTurn(late);
	assert.equal(t?.replyId, "a2", "the re-emission after the nudge wins over the pre-nudge verdict");
	assert.ok(t?.replyText.startsWith("VERIFIED"));
});

test("findLastAuditTurn: transparency is prefix-scoped — a NON-nudge user turn after the instruction still breaks the scan (no clean reply)", () => {
	const other = [
		FORK[0],
		{ id: "n1", type: "message", message: { role: "user", content: `[something-else] ${auditDeadlineNudgeText(480_000)}` } },
		{ id: "a1", type: "message", message: { role: "assistant", content: FULL_REPLY } },
	];
	const t = findLastAuditTurn(other);
	assert.equal(t?.replyId, undefined, "a foreign user turn still breaks the scan (only the exact AUDIT_DEADLINE_PREFIX is transparent)");
});

/* 2026-10-04 (F-12 class, banked rep-12 u4, BOTH attempts measured verbatim:
   last assistant turn = one thinking fragment, stopReason "length",
   usage.output 1, no text). The turn view now carries the child's last
   measured stopReason — the input of the missing-reply class split. */

test("findLastAuditTurn: F-12 u4 shape (banked rep-12): a length-cut thinking-only final turn carries NO reply, and the last measured stopReason rides the turn (the class-split input — budget exhaustion, not a pipe defect)", () => {
	const bank = [
		FORK[0],
		{ id: "u1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "check the raw span" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "raw.jsonl" } }] } },
		{ id: "u2", type: "message", message: { role: "toolResult", content: "raw span bytes" } },
		// the F-12 verbatim final turn (attempt 1: thinking "Now"): the last
		// assistant entry ends truncated, no text — the reply must NOT be found
		{ id: "u3", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "Now" }], stopReason: "length" } },
	];
	const t = findLastAuditTurn(bank);
	assert.ok(t, "the instruction turn is still found");
	assert.equal(t?.replyId, undefined, "a thinking-only length-cut turn has no reply text (nothing settles)");
	assert.equal(t?.replyText, "");
	assert.equal(t?.lastAssistantStopReason, "length", "the child's last measured stopReason rides the turn (missingAuditReplyClass reads it)");
});

test("findLastAuditTurn: class-split controls — last turn 'stop' (non-truncated) or no assistant turn at all ⇒ the observation stays on the reply-missing side (undefined)", () => {
	const stopped = [
		FORK[0],
		{ id: "s1", type: "message", message: { role: "assistant", content: "", stopReason: "stop" } },
	];
	assert.equal(findLastAuditTurn(stopped)?.lastAssistantStopReason, "stop", "the last turn's stopReason is observed even without text");
	assert.equal(findLastAuditTurn([FORK[0]])?.lastAssistantStopReason, undefined, "no assistant turn at all ⇒ undefined (the missing-class shape: no turn to end)");
});

test("findLastAuditTurn: all-assistant steps without any text (auditor abandoned mid-tool-calls) ⇒ empty reply (the settle refuses)", () => {
	const t = findLastAuditTurn([
		FORK[0],
		{ id: "b1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] } },
		{ id: "b2", type: "message", message: { role: "toolResult", content: "…" } },
	]);
	assert.ok(t, "the instruction turn is still found");
	assert.equal(t?.replyId, undefined);
	assert.equal(t?.replyText, "");
});

test("findLastAuditTurn: none present ⇒ undefined", () => {
	assert.equal(findLastAuditTurn(MAIN), undefined);
});

test("findLastAuditTurn: a user message BEFORE any assistant reply ⇒ no clean reply", () => {
	const t = findLastAuditTurn([
		FORK[0],
		{ id: "f3", type: "message", message: { role: "user", content: "next task" } },
		{ id: "f4", type: "message", message: { role: "assistant", content: "ok done" } },
	]);
	assert.equal(t?.replyId, undefined, "the interrupted turn has no capturable reply (the settle refuses)");
});

/* ── compaction takeover ─────────────────────────────────────────────────── */

test("spanHasSettlement: only settlement-bearing branches fire the takeover", () => {
	assert.equal(spanHasSettlement([...MAIN, { id: "m9", type: "custom", customType: "sam", data: { kind: "settlement", line: "… VERIFIED: …" } }]), true);
	assert.equal(spanHasSettlement(MAIN), false);
});

test("takeoverSummary (D11 2026-10-02): goal FIRST, then the verbatim settlement BLOCKS, then the pointer", () => {
	const rec = buildSettlementRecord(1, "/s/fork.jsonl", "f2", "VERIFIED\nFACTS: a=1\nEVIDENCE: MARKER: x", 1761985613000);
	assert.ok(rec, "fixture record builds");
	const goal = { text: "Migrate the scheduler to the v4 dials", ts: 1761985200000, basis: "adjust-goal" as const };
	const s = takeoverSummary("## Goal — the old work", goal, [rec]);
	assert.ok(s.startsWith(`Goal (stored ${new Date(goal.ts).toISOString()} via adjust_goal — latest version, replaces earlier ones):`), "the goal block is FIRST — Pauls before-session-content rule");
	assert.ok(s.includes("Migrate the scheduler to the v4 dials\n[end of goal]"), "the goal text is verbatim, closed by the pinned marker");
	assert.ok(s.includes("## Goal — the old work"), "the carried previous summary survives (pi-native prose is never touched)");
	assert.ok(s.includes(SETTLEMENTS_HEADER), "the settlement section is labelled");
	assert.ok(s.includes(`## u1 — VERIFIED · ${rec.retrievalId}`), "unit-numbered settlement block heading (2026-10-05 markup)");
	assert.ok(s.includes("**FACTS**\n- a=1"), "FACTS section headed + bullet, verbatim (2026-10-05 markup)");
	assert.ok(s.includes("**EVIDENCE**\n- MARKER: x"), "EVIDENCE section headed + bullet, verbatim (the quoted item keeps its inner quote — no splitting, Pauls counter-example)");
	assert.ok(s.trimEnd().endsWith(TAKEOVER_POINTER), "the retrieval pointer stays last");

	// D11 replacement: an OLD goal block inside the carried previous summary is
	// stripped (latest wins — the earlier version stays a ledger tombstone only).
	const oldSummary = "Goal (stored 123 via adjust_goal — latest version, replaces earlier ones):\nOLD GOAL TEXT\n[end of goal]\nrest of the old summary";
	const s2 = takeoverSummary(oldSummary, goal, [rec]);
	assert.ok(!s2.includes("OLD GOAL TEXT"), "replaced goal: the old block is gone (no accumulation)");
	assert.ok(s2.includes("Migrate the scheduler to the v4 dials"), "the new goal carries at the head");
	assert.ok(s2.includes("rest of the old summary"), "non-goal prose of the old summary survives");

	// the fallback label (takeover-derived)
	const s3 = takeoverSummary(undefined, { text: "do the thing; keep the stubs", ts: 5, basis: "takeover-fallback" }, []);
	assert.ok(s3.startsWith(GOAL_FALLBACK_HEADER), "the fallback goal is labelled takeover-derived");
	assert.ok(!s3.includes(SETTLEMENTS_HEADER), "a goal-only fold has no settlement section");
});

test("takeoverDetails: the retrieval map for the compaction entry details slot", () => {
	const d = takeoverDetails([{ unitId: 1, retrievalId: "abcdef123456", auditFile: "/s/fork.jsonl", replyId: "f2" }]);
	assert.equal(d.sam.kind, "branchAuditSettlements");
	assert.equal(d.sam.settlements.length, 1);
	assert.equal(d.sam.settlements[0].retrievalId, "abcdef123456");
});

test("tombstoneJsonl: one entry per line, the bankable raw span", () => {
	const j = tombstoneJsonl(MAIN);
	const lines = j.trim().split("\n");
	assert.equal(lines.length, 2);
	assert.equal(JSON.parse(lines[1]).data.kind, "close");
});

/* ── reader (total) ──────────────────────────────────────────────────────── */

test("readRawSessionFile: NDJSON and JSON-array banks both parse; garbage ⇒ []", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sam-ba-"));
	const nd = path.join(dir, "nd.jsonl");
	fs.writeFileSync(nd, JSON.stringify(FORK[0]) + "\n" + JSON.stringify(FORK[1]) + "\n");
	assert.equal(readRawSessionFile(nd).length, 2);
	const arr = path.join(dir, "arr.jsonl");
	fs.writeFileSync(arr, JSON.stringify(FORK));
	assert.equal(readRawSessionFile(arr).length, 2);
	const bad = path.join(dir, "bad.jsonl");
	fs.writeFileSync(bad, "{ not json\n{also not");
	assert.deepEqual(readRawSessionFile(bad), []);
	assert.deepEqual(readRawSessionFile(path.join(dir, "missing.jsonl")), []);
});

/* ── buildSettlementRecord ───────────────────────────────────────────────── */

test("buildSettlementRecord: from a full reply; UNAUDITABLE reply still records (no fold) but no missing-reply", () => {
	const rec = buildSettlementRecord(1, "/s/fork.jsonl", "f2", FULL_REPLY, 1234);
	assert.equal(rec?.kind, "settlement");
	assert.equal(rec?.verdict, "VERIFIED");
	assert.match(rec?.retrievalId ?? "", /^[0-9a-f]{12}$/);
	assert.ok((rec?.line ?? "").startsWith(rec?.retrievalId + " VERIFIED: "));
	assert.equal(rec?.ts, 1234);
	assert.equal(buildSettlementRecord(1, "/s/fork.jsonl", undefined, "x"), undefined, "no reply ⇒ no record (the settle refuses)");
});

/* ── orphan zone: the LAST MODEL TEXT label says MODEL (sam-06 defect, 2026-10-05) ─ */

test("orphan zone lastText (sam-06 pin): a toolResult/system line is NEVER 'the last model text' — the label must not lie", () => {
	// sam-06's actual orphan zone (c8c2ff4c8d4a): [system line, the close_unit toolResult
	// one-liner] — the old code surfaced the one-liner as LAST MODEL TEXT.
	const entries = [
		{ id: "s1", type: "message", message: { role: "system", content: [{ type: "text", text: "session context line" }] } },
		{ id: "t1", type: "message", message: { role: "toolResult", toolCallId: "tc", toolName: "close_unit", content: [{ type: "text", text: "Unit 1 closed — audit NOT-YET-VERIFIED: (4e04c85c0072)" }] } },
	] as unknown as RawEntry[];
	const z = computeOrphanZone(entries, new Set());
	assert.ok(z, "the zone renders (it still banks the raw span)");
	assert.equal(z.lastText, undefined, "no assistant text in the zone ⇒ no LAST MODEL TEXT line (a toolResult one-liner is extension output, not the model's words)");
});

test("orphan zone lastText (regression guard): the last ASSISTANT text block is still captured, and its toolCall still lands in CALLS", () => {
	const entries = [
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "the model's last actual words" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] } },
		{ id: "t1", type: "message", message: { role: "toolResult", toolCallId: "tc", toolName: "bash", content: [{ type: "text", text: "total 0" }] } },
	] as unknown as RawEntry[];
	const z = computeOrphanZone(entries, new Set());
	assert.equal(z?.lastText, "the model's last actual words", "the ASSISTANT text is the label's only valid source");
	assert.equal(z?.calls.length, 1, "the assistant toolCall stays in the CALLS line");
	assert.equal(z?.calls[0]?.name, "bash");
});

/* ══ context-pressure safenet (2026-10-16): the takeover-summary safenet ══
 *  The AUTO-RETIRE block, the retired-orphan exclusion, the orphan unitId
 *  heading, and the carried-block strip. All pure; no pi, no inference. */

import { orphanBlock, stripOldAutoRetireBlocks, stripOldOrphanBlocks, ORPHAN_HEADING_PREFIX, type SamOrphanRecord, type SamSettlementRecord } from "../src/branchaudit.ts";
import { AUTO_RETIRE_HEADING_PREFIX } from "../src/protocol.ts";
import type { AutoRetireAction, RetireLedgerEntry } from "../src/retire.ts";

const baRec = (unitId: number): SamSettlementRecord => ({
	v: 1,
	kind: "settlement",
	unitId,
	retrievalId: String(unitId).padStart(12, "0"),
	verdict: "VERIFIED",
	sections: { FACTS: `fact-${unitId}` },
	line: `${String(unitId).padStart(12, "0")} VERIFIED: fact-${unitId}`,
	auditFile: "a.jsonl",
	replyId: "r",
	parsedClean: true,
});
const baAuto = (unitId: number, units: number[]): AutoRetireAction => ({
	v: 1,
	kind: "autoRetire",
	ts: 100,
	foldId: `fold-${unitId}`,
	unitId,
	retrievalId: `a${unitId}0000000000`.slice(0, 12),
	units,
	items: units.map((u) => ({ unitId: u, retrievalId: String(u).padStart(12, "0"), verdictClass: "VERIFIED" })),
});
const baOrphan = (retrievalId: string, unitId?: number): SamOrphanRecord => ({
	v: 1,
	kind: "orphan",
	retrievalId,
	foldId: "f1",
	spanFirstId: "e1",
	spanLastId: "e2",
	entryIds: ["e1", "e2"],
	calls: [],
	callsTrunc: 0,
	files: [],
	line: "",
	ts: 1,
	...(unitId === undefined ? {} : { unitId }),
});

test("SAFENET: takeoverSummary renders the ACTIVE auto-retire block (newest only, matryoshka)", () => {
	const records = [baRec(1), baRec(2), baRec(3)];
	// one autoRetire entry: u1 retired ⇒ GONE from the stack; the block is its only trace
	const a1 = baAuto(4, [1]);
	const s1 = takeoverSummary(undefined, null, records, null, [a1]);
	assert.ok(!s1.includes("## u1 — "), "retired u1 is GONE from the settlement stack");
	assert.ok(s1.includes("## u2 — VERIFIED"), "u2 renders (not retired)");
	assert.ok(s1.includes(`${AUTO_RETIRE_HEADING_PREFIX}u1 · ${a1.retrievalId}`), "the block names its units + its own retrieval id");
	assert.ok(s1.includes("- u1 (VERIFIED) · original: sam_retrieve " + String(1).padStart(12, "0")), "the per-unit retrieval pointer");
	assert.ok(s1.indexOf(AUTO_RETIRE_HEADING_PREFIX) > s1.indexOf(SETTLEMENTS_HEADER), "the block sits AFTER the settlement stack");
	assert.ok(s1.indexOf(AUTO_RETIRE_HEADING_PREFIX) < s1.lastIndexOf(TAKEOVER_POINTER), "…and BEFORE the pointer");
	// two entries: ONLY the newest renders (the older one was absorbed)
	const a2 = baAuto(5, [2], "a20000000000".slice(0, 12));
	a2.absorbed = { retrievalId: a1.retrievalId, unitId: a1.unitId, units: a1.units };
	const s2 = takeoverSummary(undefined, null, records, null, [a1, a2]);
	assert.equal(s2.match(new RegExp(AUTO_RETIRE_HEADING_PREFIX, "g"))!.length, 1, "exactly one AUTO-RETIRE block (the newest)");
	assert.ok(s2.includes(`${AUTO_RETIRE_HEADING_PREFIX}u2 · ${a2.retrievalId}`), "the newest block's heading");
	assert.ok(!s2.includes(`${AUTO_RETIRE_HEADING_PREFIX}u1 · ${a1.retrievalId}`), "the older block's heading is gone (absorbed)");
	assert.ok(s2.includes(`- absorbed: #${a1.retrievalId} (u${a1.unitId}; u1 — earlier auto-retire, chain via sam_retrieve ${a1.retrievalId})`), "the matryoshka line keeps the chain retrievable");
	assert.ok(!s2.includes("## u2 — "), "u2 (now retired by the newest entry) is GONE from the stack too");
});

test("SAFENET: the orphan unitId heading (retirable orphans) + the pre-unitId shape (backward compatible)", () => {
	const withUnit = orphanBlock(baOrphan("abc123456789", 5));
	assert.ok(withUnit.startsWith(`${ORPHAN_HEADING_PREFIX}u5 · abc123456789`), "the unitId rides the heading (the retire_units / sam_retrieve 'unit N' id)");
	const noUnit = orphanBlock(baOrphan("abc123456789"));
	assert.ok(noUnit.startsWith(`${ORPHAN_HEADING_PREFIX}abc123456789`), "pre-unitId orphans keep the old heading byte-identically");
});

test("SAFENET: stripOldAutoRetireBlocks — carried blocks are pure duplication (keep 0)", () => {
	// realistic carried structure: sections → AUTO-RETIRE block → ORPHANED block → pointer
	// (the render order is settlements → AUTO-RETIRE → ORPHANED → pointer).
	const text = [
		"some earlier section",
		"",
		`${AUTO_RETIRE_HEADING_PREFIX}u1, u2 · aaaa11111111`,
		"",
		"- u1 (VERIFIED) · original: sam_retrieve 000000000001",
		"",
		"## ORPHANED AT FOLD · orph1aaaaaaaa",
		"unclosed…",
		"",
		`${AUTO_RETIRE_HEADING_PREFIX}u3 · bbbb22222222`,
		"",
		"- u3 (VERIFIED) · original: sam_retrieve 000000000003",
		"",
		TAKEOVER_POINTER,
	].join("\n");
	const out = stripOldAutoRetireBlocks(text);
	assert.ok(!out.includes(AUTO_RETIRE_HEADING_PREFIX), "ALL carried AUTO-RETIRE blocks are dropped (the fresh render re-emits the newest)");
	assert.ok(out.includes("some earlier section"), "the earlier sections survive");
	assert.ok(out.includes("## ORPHANED AT FOLD · orph1aaaaaaaa"), "the orphan section survives");
	assert.ok(out.endsWith(TAKEOVER_POINTER), "the pointer survives");
	// idempotent
	assert.equal(stripOldAutoRetireBlocks(out), out);
});

test("SAFENET: retired orphan units are excluded from the carried stack (before the cap)", () => {
	// a carried summary with TWO orphan blocks; the first is retired by now
	const prev = [
		`## ORPHANED AT FOLD · orph1aaaaaaaa`,
		"unclosed at fold time: …",
		"",
		`## ORPHANED AT FOLD · orph2bbbbbbbb`,
		"unclosed at fold time: …",
		"",
		TAKEOVER_POINTER,
	].join("\n");
	const excluded = new Set(["orph1aaaaaaaa"]);
	const stripped = stripOldOrphanBlocks(prev, 2, excluded);
	assert.ok(!stripped.includes("## ORPHANED AT FOLD · orph1aaaaaaaa"), "the retired orphan's block is dropped");
	assert.ok(stripped.includes("## ORPHANED AT FOLD · orph2bbbbbbbb"), "the unretired one stays");
	// through the full takeover: the carried block drops, the FRESH orphan appends
	const fresh = baOrphan("orph3ccccccc", 7);
	const sum = takeoverSummary(prev, null, [], fresh, undefined, 2, excluded);
	assert.ok(!sum.includes("## ORPHANED AT FOLD · orph1aaaaaaaa"), "the retired carried orphan is gone from the new summary");
	assert.ok(sum.includes("## ORPHANED AT FOLD · orph2bbbbbbbb"), "the surviving carried orphan stays");
	assert.ok(sum.includes(`${ORPHAN_HEADING_PREFIX}u7 · orph3ccccccc`), "the fresh (unit-bearing) orphan appends");
	// without the exclusion set the carry behaves as before (cap only)
	const noExcl = takeoverSummary(prev, null, [], fresh);
	assert.ok(noExcl.includes("## ORPHANED AT FOLD · orph1aaaaaaaa"), "no exclusion ⇒ both carried blocks stay (within the cap)");
});

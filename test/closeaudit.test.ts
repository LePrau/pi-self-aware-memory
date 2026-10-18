/**
 * v4 close-audit pure core (src/closeaudit.ts) — the S2 gate (v4-plan §5).
 * All functions are total and side-effect free; the spawn itself is glue
 * (index.ts) with an injectable runner (the handler matrix is
 * test/close-audit.test.ts, no real process in any suite).
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	CLOSE_AUDIT_DEFER_REASONS,
	closeRecordForUnit,
	stripIncompatibleArgs,
	prepareChildArgs,
	auditChildArgs,
	parseGlobalCompactionEnabled,
	parseArmMarker,
	shouldRestoreCompaction,
	D10A_ARM_MARKER,
	parsePrepareHandoffLine,
	parsePrepareHandoff,
	auditTimeoutMs,
	SAM_AUDIT_TIMEOUT_DEFAULT_MS,
	SAM_AUDIT_TIMEOUT_MAX_MS,
	classifyReClose,
	closeAuditResultLine,
	stubLineCount,
	stubCharCount,
	lineIsAuditFork,
	settledUnitIds,
	lastCloseRecord,
	autoAuditDepth,
	auditDepthOf,
	closeAuditDecision,
	missingAuditReplyClass,
	settlementRung,
	strengthRung,
	canSupersede,
} from "../src/closeaudit.ts";
import { ladderFor } from "../src/governor.ts";

/* ── D8 depth decision (single derivation — 2026-10-03 decision-in-ledger) ── */

test("closeAuditDecision: ONE derivation of zone + depth + tokens (auto dial), so the recorded number IS the used number", () => {
	const ladder = ladderFor(131072, null)!; // W=131072 R=16384 → watch line 98304
	const ctxCal = { getContextUsage: () => ({ tokens: 90_000, contextWindow: 131072 }) };
	const dec = closeAuditDecision(ladder, ctxCal as never);
	assert.equal(dec.ctxTokens, 90_000, "the exact tokens the ruler read are returned");
	assert.equal(dec.zone, "calm");
	assert.equal(dec.depth, "medium", "auto dial: calm (below band) ⇒ medium — the routine close (2026-10-17)");

	const ctxWatch = { getContextUsage: () => ({ tokens: 100_000, contextWindow: 131072 }) };
	assert.equal(closeAuditDecision(ladder, ctxWatch as never).depth, "light", "auto dial: watch ⇒ light");
	assert.equal(closeAuditDecision(ladder, ctxWatch as never).zone, "watch");

	// unavailable tokens / no ruler ⇒ the below-band default MEDIUM (R6 2026-10-17:
	// auto never dispatches full — full is explicit-only; the fail-safe direction is
	// never a silent LIGHT — the light rung needs a MEASURED band)
	const ctxNull = { getContextUsage: () => ({ tokens: null, contextWindow: 131072 }) };
	assert.equal(closeAuditDecision(ladder, ctxNull as never).depth, "medium");
	assert.equal(closeAuditDecision(ladder, ctxNull as never).ctxTokens, null);
	// no getContextUsage at all (older pi shapes) ⇒ the same below-band default
	assert.equal(closeAuditDecision(ladder, {} as never).depth, "medium");
	// no ladder (the ruler is unreadable) ⇒ the same below-band default
	assert.equal(closeAuditDecision(null, ctxWatch as never).depth, "medium");
});

test("closeAuditDecision: the env dial ALWAYS wins over the auto zone (and the tokens still ride the record)", () => {
	const ladder = ladderFor(131072, null)!;
	const ctxWatch = { getContextUsage: () => ({ tokens: 100_000, contextWindow: 131072 }) };
	const ctxCal = { getContextUsage: () => ({ tokens: 90_000, contextWindow: 131072 }) };
	assert.equal(closeAuditDecision(ladder, ctxCal as never, { SAM_AUDIT_DEPTH: "light" }).depth, "light", "dial light beats calm zone");
	assert.equal(closeAuditDecision(ladder, ctxWatch as never, { SAM_AUDIT_DEPTH: "full" }).depth, "full", "dial full beats watch zone");
	assert.equal(closeAuditDecision(ladder, ctxCal as never, { SAM_AUDIT_DEPTH: "medium" }).depth, "medium", "dial medium beats calm zone (explicit, not auto)");
	assert.equal(auditDepthOf({ SAM_AUDIT_DEPTH: "medium" }), "medium", "auditDepthOf accepts the medium rung");
	assert.equal(auditDepthOf({ SAM_AUDIT_DEPTH: "bogus" }), "auto", "an unknown dial value stays auto (the validator rejects it)");
	// the dial case still records the tokens the zone WAS computed from
	assert.equal(closeAuditDecision(ladder, ctxCal as never, { SAM_AUDIT_DEPTH: "light" }).ctxTokens, 90_000);
});

test("closeAuditDecision: the F-14 u1 shape — a ruler that DROPS the close turn's output (input+cacheRead) lands calm; the totalTokens ruler lands light — both at the measured 65,536 geometry", () => {
	const W = 65_536, R = 16_384;
	const ladder = ladderFor(W, null)!;
	const watchLine = W - 2 * R; // 32768
	// F-14 u1 close turn (measured, banked run of 2026-10-03): input=49 output=1359 cacheRead=32627
	const narrow = 49 + 32_627; // old harness ruler (in+cr): 32676 — 92 UNDER the line
	const total = 49 + 1_359 + 32_627; // totalTokens: 34035 — 1267 OVER the line
	assert.equal(narrow, total - 1_359, "premise: the whole gap is the close turn's 1,359 output tokens");
	assert.equal(closeAuditDecision(ladder, { getContextUsage: () => ({ tokens: narrow, contextWindow: W }) } as never).zone, "calm", "narrow ruler ⇒ calm ⇒ medium (below band) — the F-14 u1 shape, re-rung 2026-10-17");
	assert.equal(closeAuditDecision(ladder, { getContextUsage: () => ({ tokens: total, contextWindow: W }) } as never).zone, "watch", "totalTokens ruler ⇒ watch ⇒ light-legal (what the extension dispatched)");
});


test("stripIncompatibleArgs: drops session/mode/print flags (and their values), keeps model/provider/extensions", () => {
	const out = stripIncompatibleArgs([
		"--model", "qwen38-gsq-rco-kv",
		"--mode", "rpc",
		"-e", "slow-qube",
		"---custom",
	]);
	// note: "---custom" is NOT in the strip list → passes through (total unknown-flag rule)
	assert.deepEqual(out, ["--model", "qwen38-gsq-rco-kv", "-e", "slow-qube", "---custom"]);
});

test("stripIncompatibleArgs: --session-id (walk parent argv) is dropped WITH its value — the S9-measured collision (pi: --session-id cannot be combined with --session)", () => {
	const out = stripIncompatibleArgs(["--provider", "p1mock", "--session-id", "some-id", "--session", "/x/main.jsonl", "-p", "prompt text", "--offline"]);
	assert.deepEqual(out, ["--provider", "p1mock", "--offline"]);
});



test("stripIncompatibleArgs: value-required flags consume their value; booleans drop alone (pi 0.87.1 cli/args.ts grammar)", () => {
	const out = stripIncompatibleArgs([
		"-p", "a prompt",
		"--mode", "-weird",
		"--resume",
		"--session", "x",
		"--fork", "f",
		"--name", "n",
		"-c",
		"--model", "m",
	]);
	assert.deepEqual(out, ["--model", "m"]);
});

test("stripIncompatibleArgs: -p value rule is pi's exact rule (no '@'/single-dash value taken; triple-dash excepted)", () => {
	assert.deepEqual(stripIncompatibleArgs(["-p", "-x", "--model", "m"]), ["-x", "--model", "m"]);
	assert.deepEqual(stripIncompatibleArgs(["-p", "@file", "--model", "m"]), ["@file", "--model", "m"]);
	assert.deepEqual(stripIncompatibleArgs(["-p", "---x", "--model", "m"]), ["--model", "m"]); // pi takes this as the message
	assert.deepEqual(stripIncompatibleArgs(["--print", "hi", "--model", "m"]), ["--model", "m"]);
});

test("prepareChildArgs: [cli, ...stripped, --session \u003cmainFile\u003e, -p, /sam-prepare-audit N] (D1: the MAIN session pin is mandatory; 2026-10-16: the internal command replaced the user-facing /sam audit)", () => {
	const out = prepareChildArgs("/pi/cli.js", ["--mode", "rpc", "-p", "old", "--model", "m"], "/sessions/main.jsonl", 3);
	assert.deepEqual(out, ["/pi/cli.js", "--model", "m", "--session", "/sessions/main.jsonl", "-p", "/sam-prepare-audit 3"]);
	// an inherited --session is incompatible (stripped with its value) — the main-file pin is the one that lands
	const b = prepareChildArgs("/pi/cli.js", ["--session", "foreign"], "/sessions/main.jsonl", 3);
	assert.deepEqual(b, ["/pi/cli.js", "--session", "/sessions/main.jsonl", "-p", "/sam-prepare-audit 3"]);
});

test("closeRecordForUnit: the unit's own committed close record (stub-identity-free; the /sam reaudit key)", () => {
	const branch = [
		{ id: "u1", kind: "message", message: { role: "user", content: "work" } },
		{ id: "c1", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 1, stub: "did A", toolCallId: "tcA" } },
		{ id: "c2", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 2, stub: "did B", toolCallId: "tcB" } },
		{ id: "c1b", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 1, stub: "did A", toolCallId: "tcA2" } },
	];
	assert.deepEqual(closeRecordForUnit(branch, 2), { unitId: 2, stub: "did B", toolCallId: "tcB", index: 2 });
	// the NEWEST record of a re-issued unit wins
	assert.deepEqual(closeRecordForUnit(branch, 1), { unitId: 1, stub: "did A", toolCallId: "tcA2", index: 3 });
	assert.equal(closeRecordForUnit(branch, 9), undefined);
	// a record missing its toolCallId is not a usable close record
	const bad = [{ id: "x", kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 7, stub: "no call id" } }];
	assert.equal(closeRecordForUnit(bad, 7), undefined);
});

test("auditChildArgs: pins --session <forkFile> (the strongest pin; added only when absent) and -p last", () => {
	const a = auditChildArgs("/cli", ["--model", "m"], "/sessions/fork.jsonl", "INSTR");
	assert.deepEqual(a, ["/cli", "--model", "m", "--session", "/sessions/fork.jsonl", "-p", "INSTR"]);
	const b = auditChildArgs("/cli", ["--session", "already"], "/sessions/fork.jsonl", "INSTR");
	// an inherited --session is INCOMPATIBLE (stripped with its value) — the fork file pin is always the one that lands
	assert.deepEqual(b, ["/cli", "--session", "/sessions/fork.jsonl", "-p", "INSTR"]);
});

/* ── handoff parse (the stdout capture channel) ──────────────────────────── */

const HANDOFF = {
	"sam-branch-prepare": {
		unitId: 1,
		forkFile: "/sessions/fork.jsonl",
		forkSessionId: "fork-01",
		instruction: "[sam-audit] Unit 1 was just closed.",
	},
};

test("handoff: the plain JSON line parses (rep-0/rep-3 capture channel)", () => {
	const h = parsePrepareHandoffLine(JSON.stringify(HANDOFF));
	assert.deepEqual(h, HANDOFF["sam-branch-prepare"]);
});

test("handoff: the RPC-wrapped form (JSON in .message) parses too (walk v3 / live-e-shape)", () => {
	const wrapped = { type: "extension_ui_request", message: JSON.stringify(HANDOFF) };
	const h = parsePrepareHandoffLine(JSON.stringify(wrapped));
	assert.deepEqual(h, HANDOFF["sam-branch-prepare"]);
});

test("handoff: garbage / wrong-key lines → undefined (total)", () => {
	assert.equal(parsePrepareHandoffLine("not json"), undefined);
	assert.equal(parsePrepareHandoffLine(JSON.stringify({ other: 1 })), undefined);
	assert.equal(parsePrepareHandoffLine(JSON.stringify({ "sam-branch-prepare": { unitId: 1 } })), undefined);
});

test("handoff: a multi-line stream finds the handoff line", () => {
	const stream = "boot log\n" + JSON.stringify(HANDOFF) + "\ntrailing\n";
	assert.deepEqual(parsePrepareHandoff(stream), HANDOFF["sam-branch-prepare"]);
});

/* ── timeout dial ────────────────────────────────────────────────────────── */

test("auditTimeoutMs: unset ⇒ 8-minute default (D3)", () => {
	assert.equal(auditTimeoutMs({}), SAM_AUDIT_TIMEOUT_DEFAULT_MS);
	assert.equal(auditTimeoutMs({ SAM_AUDIT_TIMEOUT_MS: "" }), SAM_AUDIT_TIMEOUT_DEFAULT_MS);
	assert.equal(auditTimeoutMs({ SAM_AUDIT_TIMEOUT_MS: "not-a-number" }), SAM_AUDIT_TIMEOUT_DEFAULT_MS);
	assert.equal(auditTimeoutMs({ SAM_AUDIT_TIMEOUT_MS: "0" }), SAM_AUDIT_TIMEOUT_DEFAULT_MS);
	assert.equal(auditTimeoutMs({ SAM_AUDIT_TIMEOUT_MS: "-5" }), SAM_AUDIT_TIMEOUT_DEFAULT_MS);
});

test("auditTimeoutMs: a valid value wins; absurd values are capped, never infinite", () => {
	assert.equal(auditTimeoutMs({ SAM_AUDIT_TIMEOUT_MS: "90000" }), 90_000);
	assert.equal(auditTimeoutMs({ SAM_AUDIT_TIMEOUT_MS: "999999999999" }), SAM_AUDIT_TIMEOUT_MAX_MS);
});

/* ── the D5 re-audit discriminator ───────────────────────────────────────── */

test("classifyReClose: no last close ⇒ new-unit", () => {
	assert.equal(classifyReClose({ lastCloseUnitId: null, lastCloseStub: "", lastCloseSettled: false, nextUnitId: 1 }, "stub"), "new-unit");
});

test("classifyReClose: committed-unsettled + SAME stub ⇒ re-audit (D5)", () => {
	assert.equal(
		classifyReClose({ lastCloseUnitId: 1, lastCloseStub: "the stub", lastCloseSettled: false, nextUnitId: 2 }, "  the stub "),
		"re-audit",
	);
});

test("classifyReClose: settled OR different stub ⇒ new-unit (the no-work guard then decides)", () => {
	assert.equal(classifyReClose({ lastCloseUnitId: 1, lastCloseStub: "a", lastCloseSettled: true, nextUnitId: 2 }, "a"), "new-unit");
	assert.equal(classifyReClose({ lastCloseUnitId: 1, lastCloseStub: "a", lastCloseSettled: false, nextUnitId: 2 }, "b"), "new-unit");
});

test("classifyReClose: MEDIUM AUDIT TIER (2026-10-17) — a settled WEAK or MEDIUM unit + SAME stub ⇒ re-audit (the upgrade lever); STRONG is final", () => {
	assert.equal(
		classifyReClose({ lastCloseUnitId: 1, lastCloseStub: "a", lastCloseSettled: true, lastSettlementStrength: "WEAK", nextUnitId: 2 }, "a"),
		"re-audit",
		"weak settlement (light / audit-failed) + same stub ⇒ the D5 upgrade lever");
	assert.equal(
		classifyReClose({ lastCloseUnitId: 1, lastCloseStub: "a", lastCloseSettled: true, lastSettlementStrength: "MEDIUM", nextUnitId: 2 }, "a"),
		"re-audit",
		"MEDIUM settlement (PLAUSIBLE) + same stub ⇒ the upgrade lever (2026-10-17)");
	assert.equal(
		classifyReClose({ lastCloseUnitId: 1, lastCloseStub: "a", lastCloseSettled: true, lastSettlementStrength: "STRONG", nextUnitId: 2 }, "a"),
		"new-unit",
		"STRONG settlement is final — the same stub opens a new unit");
});

/* ── MEDIUM AUDIT TIER (2026-10-17): the rung-ordered settlement upgrade guard ── */

test("settlementRung / strengthRung: the rung ordering (NYV=1 < PLAUSIBLE=2 < VERIFIED/CORRECTIONS=3)", () => {
	assert.equal(settlementRung("NOT-YET-VERIFIED"), 1);
	assert.equal(settlementRung("UNVERIFIED-AUDIT-FAILED"), 1, "audit-failed rides the weak rung");
	assert.equal(settlementRung("UNAUDITABLE"), 1, "the gate verdict rides the weak rung (lastSettlementStrengthFor parity)");
	assert.equal(settlementRung("PLAUSIBLE"), 2);
	assert.equal(settlementRung("VERIFIED"), 3);
	assert.equal(settlementRung("CORRECTIONS"), 3);
	assert.equal(strengthRung("WEAK"), 1);
	assert.equal(strengthRung("MEDIUM"), 2);
	assert.equal(strengthRung("STRONG"), 3);
});

test("canSupersede: commits iff no existing settlement or the existing rung is strictly lower (no downgrades, no re-sets)", () => {
	assert.equal(canSupersede(undefined, "VERIFIED"), true, "no existing settlement ⇒ first commit");
	assert.equal(canSupersede("WEAK", "VERIFIED"), true, "weak ⇒ strong");
	assert.equal(canSupersede("WEAK", "PLAUSIBLE"), true, "weak ⇒ medium (2026-10-17)");
	assert.equal(canSupersede("MEDIUM", "VERIFIED"), true, "medium ⇒ strong");
	assert.equal(canSupersede("MEDIUM", "CORRECTIONS"), true, "medium ⇒ strong (corrections)");
	assert.equal(canSupersede("WEAK", "NOT-YET-VERIFIED"), false, "weak-over-weak — the run-03 re-settle wave");
	assert.equal(canSupersede("MEDIUM", "NOT-YET-VERIFIED"), false, "no downgrade (medium ⇒ weak)");
	assert.equal(canSupersede("MEDIUM", "PLAUSIBLE"), false, "equal rung — never re-set");
	assert.equal(canSupersede("STRONG", "VERIFIED"), false, "strong is final");
	assert.equal(canSupersede("STRONG", "CORRECTIONS"), false, "strong is final (corrections)");
	assert.equal(canSupersede("STRONG", "NOT-YET-VERIFIED"), false, "strong is final (any new verdict)");
});

/* ── the one-line toolResults ────────────────────────────────────────────── */

test("the v4 one-liners (v4-plan §1/§3.7; D8/D9 2026-10-02): verified / corrections / NOT-YET-VERIFIED / UNVERIFIED (audit-failed) shapes — each carries the stub size (2026-10-05) + the char count (2026-10-06: line count near-constant in practice — measured 454/486 real stubs are 1 line — so chars are the varying metric)", () => {
	assert.equal(closeAuditResultLine({ unitId: 2, form: "verified", retrievalId: "abcd1234ef56", stubLines: 1, stubChars: 7 }), "Unit 2 closed — audit VERIFIED (abcd1234ef56) — stub: 1 line · 7 chars");
	assert.equal(
		closeAuditResultLine({ unitId: 3, form: "corrections", corrections: "fact X is 2, not 3", retrievalId: "abcd1234ef56", stubLines: 2, stubChars: 41 }),
		"Unit 3 closed — audit CORRECTIONS: fact X is 2, not 3 (abcd1234ef56) — stub: 2 lines · 41 chars",
	);
	// D8 (light): the non-verifying verdict is NAMED — the claims ride
	// "verify before acting" and the upgrade lever is stated.
	// v0.0.11 (2026-10-17, Paul): the line is DEPTH-AWARE — light offers both
	// upgrades, medium offers the full upgrade, full offers a plain re-audit
	// (its depth is the ceiling — the upgrade-only lever has nothing above it).
	assert.equal(
		closeAuditResultLine({ unitId: 4, form: "notYetVerified", note: "files: 3/3 present; statements: delivered", depth: "light", retrievalId: "abcd1234ef56", stubLines: 3, stubChars: 118 }),
		"Unit 4 closed — audit NOT-YET-VERIFIED: files: 3/3 present; statements: delivered (abcd1234ef56). Unmarked claims are not yet verified — verify them before acting. To upgrade, call close_unit again with the same stub and depth: 'medium' (quick check) or 'full' (thorough) (or run /sam reaudit 4). — stub: 3 lines · 118 chars",
	);
	assert.equal(
		closeAuditResultLine({ unitId: 7, form: "notYetVerified", note: "the span was compacted before the audit started", depth: "medium", retrievalId: "abcd1234ef56", stubLines: 2, stubChars: 90 }),
		"Unit 7 closed — audit NOT-YET-VERIFIED: the span was compacted before the audit started (abcd1234ef56). Unmarked claims are not yet verified — verify them before acting. To upgrade to a full audit, call close_unit again with the same stub and depth: 'full' (thorough) (or run /sam reaudit 7). — stub: 2 lines · 90 chars",
	);
	assert.equal(
		closeAuditResultLine({ unitId: 8, form: "notYetVerified", note: "no tool call landed before the budget ran out", depth: "full", retrievalId: "abcd1234ef56", stubLines: 1, stubChars: 12 }),
		"Unit 8 closed — audit NOT-YET-VERIFIED: no tool call landed before the budget ran out (abcd1234ef56). Unmarked claims are not yet verified — verify them before acting. To re-audit, call close_unit again with the same stub (or run /sam reaudit 8). — stub: 1 line · 12 chars",
	);
	// MEDIUM AUDIT TIER (2026-10-17): the PLAUSIBLE verdict line — the routine
	// close's own outcome (no contradiction observed on the quick check).
	assert.equal(
		closeAuditResultLine({ unitId: 6, form: "plausible", note: "the long-run claim stands plausibility-level", retrievalId: "abcd1234ef56", stubLines: 2, stubChars: 90 }),
		"Unit 6 closed — audit PLAUSIBLE: the long-run claim stands plausibility-level (abcd1234ef56). No contradiction observed on the quick check; cheaply checkable claims are verified, the rest stand plausibility-level (plausible: markers). To upgrade to a full audit, call close_unit again with the same stub and depth: 'full' (or run /sam reaudit 6). — stub: 2 lines · 90 chars",
	);
	// D9 (hatch): a total audit failure never leaves the close unsettled.
	assert.equal(
		closeAuditResultLine({ unitId: 5, form: "unverifiedAuditFailed", reason: "audit-timeout", why: "the audit child outlived its budget", stubLines: 1, stubChars: 12 }),
		"Unit 5 closed — audit UNVERIFIED (audit-failed: the audit child outlived its budget; audit-timeout). The close and its summary are committed — the summary is UNVERIFIED: verify its claims before acting. To upgrade, call close_unit again with the same stub and depth: 'full' (or run /sam reaudit 5). — stub: 1 line · 12 chars",
	);
});

test(
	"stubLineCount: the write-tool-style count (2026-10-05) — the split semantics + the total-safe fallback (never undefined in the rendered line)",
	() => {
		assert.equal(stubLineCount("one line"), 1, "a single line ⇒ 1");
		assert.equal(stubLineCount("a\nb"), 2, "two lines ⇒ 2 (split on the newline)");
		assert.equal(stubLineCount(undefined), 0, "no stub ⇒ 0 (total-safe)");
		assert.equal(stubLineCount(""), 0, "empty stub ⇒ 0");
	},
);

test(
	"stubCharCount: the char metric (2026-10-06) — the total-safe fallback + the point itself (a stub's chars vary where its lines hardly do)",
	() => {
		assert.equal(stubCharCount("abc"), 3, "length is the char count");
		assert.equal(stubCharCount("a\nb"), 3, "chars ≠ lines (the 1-line/507–6,188-char distribution the ack was blind to)");
		assert.equal(stubCharCount(undefined), 0, "no stub ⇒ 0 (total-safe — the rendered line can never say 'undefined')");
		assert.equal(stubCharCount(""), 0, "empty stub ⇒ 0");
	},
);

test("the deferred reason enum is stable (the fail-open matrix)", () => {
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("prepare-spawn-failed"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("span-unresolved"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("audit-timeout"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("reply-missing"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("audit-reply-truncated(length)"), "2026-10-04 (F-12 class): the budget-exhaustion class is a distinct reason (not reply-missing)");
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("reply-unparseable"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("pipeline-crashed"));
});

/* ── the missing-reply class split (2026-10-04, F-12 class — banked rep-12 u4 ×2) ── */

test("missingAuditReplyClass: stopReason 'length' ⇒ the budget class; everything else (incl. undefined) stays reply-missing (total, exact-value convention)", () => {
	assert.equal(missingAuditReplyClass("length"), "audit-reply-truncated(length)", "the measured F-12 token names the class");
	assert.equal(missingAuditReplyClass(undefined), "reply-missing", "no assistant turn at all (undefined) ⇒ the transport/pipe shape");
	for (const r of ["stop", "toolUse", "error", "aborted", "Length", "length ", "lengthy"]) {
		assert.equal(missingAuditReplyClass(r), "reply-missing", `${r}: exact-value match only (no case/trim/fuzzy)`);
	}
});

test("the F-12 class line (2026-10-04): the deferred one-liner names audit-reply-truncated(length) + the budget wording (wording = pin)", () => {
	assert.equal(
		closeAuditResultLine({
			unitId: 4,
			form: "unverifiedAuditFailed",
			reason: "audit-reply-truncated(length)",
			why: "the audit child's last turn ended stopReason=length with no reply text — the per-request output budget ran out on a thinking-only turn (a budget limit, not a transport/pipe defect)",
			stubLines: 1,
			stubChars: 5,
		}),
		"Unit 4 closed — audit UNVERIFIED (audit-failed: the audit child's last turn ended stopReason=length with no reply text — the per-request output budget ran out on a thinking-only turn (a budget limit, not a transport/pipe defect); audit-reply-truncated(length)). The close and its summary are committed — the summary is UNVERIFIED: verify its claims before acting. To upgrade, call close_unit again with the same stub and depth: 'full' (or run /sam reaudit 4). — stub: 1 line · 5 chars",
	);
	// the transport class keeps its existing line unchanged (the two stay distinguishable by the reason token)
	assert.equal(
		closeAuditResultLine({ unitId: 4, form: "unverifiedAuditFailed", reason: "reply-missing", why: "the fork file carries no clean audit reply for this unit (nothing settled)", stubLines: 1, stubChars: 9 }),
		"Unit 4 closed — audit UNVERIFIED (audit-failed: the fork file carries no clean audit reply for this unit (nothing settled); reply-missing). The close and its summary are committed — the summary is UNVERIFIED: verify its claims before acting. To upgrade, call close_unit again with the same stub and depth: 'full' (or run /sam reaudit 4). — stub: 1 line · 9 chars",
	);
});

/* ── entry-view helpers (plain + raw shapes) ─────────────────────────────── */

const E = {
	close: (unitId: number, toolCallId: string) => ({ kind: "custom", customType: "sam", data: { v: 1, kind: "close", unitId, stub: `stub ${unitId}`, toolCallId, ts: 1, mode: "manual" } }),
	closeRaw: (unitId: number, toolCallId: string) => ({ type: "custom", customType: "sam", data: { v: 1, kind: "close", unitId, stub: `stub ${unitId}`, toolCallId, ts: 1, mode: "manual" } }),
	auditUser: (unitId: number) => ({ kind: "message", message: { role: "user", content: `[sam-audit] Unit ${unitId} was just closed.` } }),
	receipt: (unitId: number) => ({ kind: "custom", customType: "sam", data: { v: 1, kind: "resolve", unitId, basis: "close-audit", ts: 1 } }),
	otherUser: () => ({ kind: "message", message: { role: "user", content: "keep working" } }),
};

test("lastCloseRecord: the LAST close record (plain AND raw entry shapes)", () => {
	assert.deepEqual(lastCloseRecord([E.close(1, "tc1"), E.otherUser(), E.closeRaw(2, "tc2")]), { unitId: 2, stub: "stub 2", toolCallId: "tc2", index: 2 });
	assert.equal(lastCloseRecord([E.otherUser()]), undefined);
});

test("settledUnitIds: settlement and resolve records both settle a unit", () => {
	const entries = [
		E.close(1, "a"),
		{ kind: "custom", customType: "sam", data: { v: 1, kind: "settlement", unitId: 1, retrievalId: "x", verdict: "VERIFIED", line: "x VERIFIED", auditFile: "f", replyId: "r", parsedClean: true, ts: 1 } },
		E.close(2, "b"),
		E.receipt(2),
	];
	assert.deepEqual([...settledUnitIds(entries)].sort(), [1, 2]);
	assert.equal(settledUnitIds([E.close(9, "z")]).size, 0);
});

test("lineIsAuditFork: instruction AFTER the last close ⇒ the audit fork; instruction BEFORE (followUp history) or no close ⇒ not", () => {
	assert.equal(lineIsAuditFork([E.close(1, "a"), E.auditUser(1)]), true);
	assert.equal(lineIsAuditFork([E.auditUser(1), E.close(1, "a")]), false); // followUp-dial history shape: audit precedes the later close
	assert.equal(lineIsAuditFork([E.auditUser(1)]), false); // no close at all
	assert.equal(lineIsAuditFork([E.close(1, "a"), E.otherUser(), E.auditUser(2)]), true);
});

/* ── D10-A (2026-10-13): the never-fold audit child — the shared settings toggle ── */

test("D10-A: parseGlobalCompactionEnabled (pi's default is true; total — never throws)", () => {
	assert.equal(parseGlobalCompactionEnabled(null), true, "absent file ⇒ pi default (true)");
	assert.equal(parseGlobalCompactionEnabled(""), true, "empty ⇒ true");
	assert.equal(parseGlobalCompactionEnabled("   "), true, "whitespace ⇒ true");
	assert.equal(parseGlobalCompactionEnabled("{ not json"), true, "unparseable ⇒ true");
	assert.equal(parseGlobalCompactionEnabled("[]"), true, "array root ⇒ true");
	assert.equal(parseGlobalCompactionEnabled("{}"), true, "no compaction key ⇒ true");
	assert.equal(parseGlobalCompactionEnabled(JSON.stringify({ compaction: "nope" })), true, "non-object compaction ⇒ true");
	assert.equal(parseGlobalCompactionEnabled(JSON.stringify({ compaction: { reserveTokens: 12000 } })), true, "compaction without enabled ⇒ true");
	assert.equal(parseGlobalCompactionEnabled(JSON.stringify({ compaction: { enabled: "yes" } })), true, "non-boolean enabled ⇒ true");
	assert.equal(parseGlobalCompactionEnabled(JSON.stringify({ compaction: { enabled: true } })), true);
	assert.equal(parseGlobalCompactionEnabled(JSON.stringify({ compaction: { enabled: false } })), false, "explicit false ⇒ false");
});

test("D10-A: parseArmMarker (total — wrong shape ⇒ null)", () => {
	assert.equal(parseArmMarker(null), null);
	assert.equal(parseArmMarker(""), null);
	assert.equal(parseArmMarker("{ not json"), null);
	assert.equal(parseArmMarker("[]"), null);
	assert.equal(parseArmMarker(JSON.stringify({ prev: "true", unit: 1, at: 2 })), null, "prev must be a boolean");
	assert.equal(parseArmMarker(JSON.stringify({ prev: true, unit: "1", at: 2 })), null, "unit must be a number");
	assert.equal(parseArmMarker(JSON.stringify({ prev: true, at: 2 })), null, "unit missing");
	assert.deepEqual(parseArmMarker(JSON.stringify({ prev: true, unit: 7, at: 2, extra: 1 })), { prev: true, unit: 7, at: 2 }, "extra keys are kept out of the parsed shape");
	assert.deepEqual(parseArmMarker(JSON.stringify({ prev: true, unit: 7, at: 123 })), { prev: true, unit: 7, at: 123 });
});

test("D10-A: shouldRestoreCompaction (the backstop decision — idempotent, conservative)", () => {
	const m = { prev: true, unit: 7, at: 123 };
	assert.equal(shouldRestoreCompaction(m, false), true, "marker prev:true + file false ⇒ restore");
	assert.equal(shouldRestoreCompaction(m, true), false, "file already true ⇒ nothing to fix (idempotent)");
	assert.equal(shouldRestoreCompaction(null, false), false, "no marker ⇒ no restore (the caller's unparseable-marker path restores conservatively)");
	assert.equal(shouldRestoreCompaction({ ...m, prev: false }, false), false, "marker prev:false ⇒ never flip a user preference on");
});

test("D10-A pin: the arm-marker filename (under the session dir — the bank home)", () => {
	assert.equal(D10A_ARM_MARKER, "sam-audit-compaction-arm.json");
});

/* ══ context-pressure safenet (2026-10-16): the deployed-settings parser (Q5) ══ */

import { parseCompactionTokens } from "../src/closeaudit.ts";

test("SAFENET: parseCompactionTokens — pure + total over settings.json raw text", () => {
	// absent / unreadable / wrong shape ⇒ empty (the caller falls back to pi's built-ins)
	assert.deepEqual(parseCompactionTokens(null), {});
	assert.deepEqual(parseCompactionTokens(undefined), {});
	assert.deepEqual(parseCompactionTokens(""), {});
	assert.deepEqual(parseCompactionTokens("   "), {});
	assert.deepEqual(parseCompactionTokens("not json"), {});
	assert.deepEqual(parseCompactionTokens("[1,2,3]"), {}, "a JSON array is not a settings object");
	assert.deepEqual(parseCompactionTokens("{}"), {}, "no compaction block");
	assert.deepEqual(parseCompactionTokens('{"other": 1}'), {}, "no compaction block");
	assert.deepEqual(parseCompactionTokens('{"compaction": "nope"}'), {}, "compaction not an object");
	assert.deepEqual(parseCompactionTokens('{"compaction": null}'), {}, "compaction null");
});

test("SAFENET: parseCompactionTokens — positive finite integers only, floored", () => {
	assert.deepEqual(parseCompactionTokens('{"compaction": {"reserveTokens": 8000}}'), { reserveTokens: 8000 });
	assert.deepEqual(parseCompactionTokens('{"compaction": {"keepRecentTokens": 10000}}'), { keepRecentTokens: 10000 });
	assert.deepEqual(
		parseCompactionTokens('{"compaction": {"reserveTokens": 8000, "keepRecentTokens": 10000, "enabled": true}}'),
		{ reserveTokens: 8000, keepRecentTokens: 10000 },
		"other compaction fields are ignored",
	);
	assert.deepEqual(parseCompactionTokens('{"compaction": {"reserveTokens": 100.9}}'), { reserveTokens: 100 }, "fraction ⇒ floor");
});

test("SAFENET: parseCompactionTokens — junk fields are omitted (never zero, never NaN)", () => {
	assert.deepEqual(parseCompactionTokens('{"compaction": {"reserveTokens": 0}}'), {});
	assert.deepEqual(parseCompactionTokens('{"compaction": {"reserveTokens": -5}}'), {});
	assert.deepEqual(parseCompactionTokens('{"compaction": {"reserveTokens": "8000"}}'), {}, "a string is not a number");
	assert.deepEqual(parseCompactionTokens('{"compaction": {"keepRecentTokens": true}}'), {}, "a boolean is not a number");
	assert.deepEqual(
		parseCompactionTokens('{"compaction": {"reserveTokens": 8000, "keepRecentTokens": -1}}'),
		{ reserveTokens: 8000 },
		"one valid field survives a junk sibling",
	);
});

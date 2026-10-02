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
	auditChildCompactionSettings,
	D10_AGENT_DIR_ENV,
	D10_CHILD_DIRNAME,
	parsePrepareHandoffLine,
	parsePrepareHandoff,
	auditTimeoutMs,
	SAM_AUDIT_TIMEOUT_DEFAULT_MS,
	SAM_AUDIT_TIMEOUT_MAX_MS,
	classifyReClose,
	closeAuditResultLine,
	lineIsAuditFork,
	settledUnitIds,
	lastCloseRecord,
} from "../src/closeaudit.ts";

/* ── argv hygiene ────────────────────────────────────────────────────────── */

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

test("prepareChildArgs: [cli, ...stripped, --session \u003cmainFile\u003e, -p, /sam audit N] (D1: the MAIN session pin is mandatory)", () => {
	const out = prepareChildArgs("/pi/cli.js", ["--mode", "rpc", "-p", "old", "--model", "m"], "/sessions/main.jsonl", 3);
	assert.deepEqual(out, ["/pi/cli.js", "--model", "m", "--session", "/sessions/main.jsonl", "-p", "/sam audit 3"]);
	// an inherited --session is incompatible (stripped with its value) — the main-file pin is the one that lands
	const b = prepareChildArgs("/pi/cli.js", ["--session", "foreign"], "/sessions/main.jsonl", 3);
	assert.deepEqual(b, ["/pi/cli.js", "--session", "/sessions/main.jsonl", "-p", "/sam audit 3"]);
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

/* ── the one-line toolResults ────────────────────────────────────────────── */

test("the v4 one-liners (v4-plan §1/§3.7; D8/D9 2026-10-02): verified / corrections / NOT-YET-VERIFIED / UNVERIFIED (audit-failed) shapes", () => {
	assert.equal(closeAuditResultLine({ unitId: 2, form: "verified", retrievalId: "abcd1234ef56" }), "Unit 2 closed — audit VERIFIED (abcd1234ef56)");
	assert.equal(
		closeAuditResultLine({ unitId: 3, form: "corrections", corrections: "fact X is 2, not 3", retrievalId: "abcd1234ef56" }),
		"Unit 3 closed — audit CORRECTIONS: fact X is 2, not 3 (abcd1234ef56)",
	);
	// D8 (light): the non-verifying verdict is NAMED — the claims ride
	// "verify before acting" and the upgrade lever is stated.
	assert.equal(
		closeAuditResultLine({ unitId: 4, form: "notYetVerified", note: "files: 3/3 present; statements: delivered", retrievalId: "abcd1234ef56" }),
		"Unit 4 closed — audit NOT-YET-VERIFIED: files: 3/3 present; statements: delivered (abcd1234ef56). Unmarked claims are not yet verified — verify them before acting. To upgrade to a full audit, call close_unit again with the same stub (or run /sam reaudit 4).",
	);
	// D9 (hatch): a total audit failure never leaves the close unsettled.
	assert.equal(
		closeAuditResultLine({ unitId: 5, form: "unverifiedAuditFailed", reason: "audit-timeout", why: "the audit child outlived its budget" }),
		"Unit 5 closed — audit UNVERIFIED (audit-failed: the audit child outlived its budget; audit-timeout). The close and its summary are committed — the summary is UNVERIFIED: verify its claims before acting. To upgrade, call close_unit again with the same stub (or run /sam reaudit 5).",
	);
});

test("the deferred reason enum is stable (the fail-open matrix)", () => {
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("prepare-spawn-failed"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("span-unresolved"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("audit-timeout"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("reply-missing"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("reply-unparseable"));
	assert.ok(CLOSE_AUDIT_DEFER_REASONS.includes("pipeline-crashed"));
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

/* ── D10 (2026-10-02): the never-fold audit child — the settings merge ──── */

test("D10: auditChildCompactionSettings forces compaction.enabled=false and preserves everything else (the child-dir settings.json content)", () => {
	assert.deepEqual(auditChildCompactionSettings(null), { compaction: { enabled: false } }, "absent parent ⇒ minimal object");
	assert.deepEqual(auditChildCompactionSettings("   "), { compaction: { enabled: false } }, "empty parent ⇒ minimal object");
	assert.deepEqual(auditChildCompactionSettings("{ not json"), { compaction: { enabled: false } }, "unparseable parent ⇒ minimal object (never throws — F1)");
	const out = auditChildCompactionSettings(JSON.stringify({
		model: { provider: "openai", id: "gpt" },
		compaction: { enabled: true, reserveTokens: 12000, keepRecentTokens: 8000, modelOverrides: { x: 1 } },
		other: { keep: true },
	}));
	assert.equal(out["compaction"]["enabled"], false, "D10 — forced, never inherited");
	assert.equal((out["compaction"] as Record<string, unknown>)["reserveTokens"], 12000, "other compaction keys preserved");
	assert.equal((out["compaction"] as Record<string, unknown>)["keepRecentTokens"], 8000);
	assert.deepEqual((out["compaction"] as Record<string, unknown>)["modelOverrides"], { x: 1 });
	assert.deepEqual(out["model"], { provider: "openai", id: "gpt" }, "top-level keys preserved");
	assert.deepEqual(out["other"], { keep: true });
	assert.deepEqual(auditChildCompactionSettings(JSON.stringify({ compaction: "nope" })), { compaction: { enabled: false } }, "non-object compaction degrades");
});

test("D10 pins: the agent-dir env override + the throwaway child dirname (the spawn mechanism, pi 0.87.1)", () => {
	assert.equal(D10_AGENT_DIR_ENV, "PI_CODING_AGENT_DIR", "the pi 0.87.1 agent-dir env override (measured: dist/config.js getAgentDir)");
	assert.equal(D10_CHILD_DIRNAME, "sam-audit-agentdir", "the child dir sits UNDER the session dir (the bank home — nothing extra leaves it)");
});

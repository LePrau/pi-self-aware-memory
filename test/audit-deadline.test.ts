/**
 * v0.0.11 (2026-10-17, Paul): the audit-child deadline nudge.
 *
 * The PARENT stamps SAM_AUDIT_STARTED_AT_MS (the spawn time) into the audit
 * child's env; the CHILD-side SAM arms one one-shot timer at 50 % of the
 * shared budget (SAM_AUDIT_TIMEOUT_MS — one dial, one default, R4) and
 * steers the pinned verdict reminder in. Measured pi 0.87.1: a queued steer
 * continues the print run with a further turn, so the nudge reaches the
 * model mid-audit; findLastAuditTurn treats the nudge message as
 * TRANSPARENT (pinned in branchaudit.test.ts). Deliberately UNGATED by
 * SAM_NUDGE (D7 keeps the pressure/goal nudges off in the child; this is
 * the audit's own deadline — separate mechanism, no new dial).
 *
 * Pure wiring pins — no pi, no live inference:
 *   1. no stamp (main session / prepare child) ⇒ no-op, ever;
 *   2. stamp present ⇒ exactly ONE steer, pinned text, at ~50 % of the budget;
 *   3. already past the halfway mark ⇒ no-op (the SIGKILL backstop still applies).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { armAuditDeadlineNudge } from "../extensions/self-aware-memory/index.ts";
import { AUDIT_STARTED_AT_ENV } from "../src/nudge.ts";
import { auditDeadlineNudgeText } from "../src/protocol.ts";

type Sent = { text: string; options?: { deliverAs?: string } };

function fakePi(sent: Sent[]) {
	return {
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => {
			sent.push({ text, options });
		},
	} as unknown as Parameters<typeof armAuditDeadlineNudge>[0];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("armAuditDeadlineNudge: no stamp (main session / prepare child) ⇒ no-op — no nudge is ever sent", async () => {
	delete process.env[AUDIT_STARTED_AT_ENV];
	delete process.env["SAM_AUDIT_TIMEOUT_MS"];
	const sent: Sent[] = [];
	armAuditDeadlineNudge(fakePi(sent));
	await sleep(150);
	assert.equal(sent.length, 0, "no message in a non-audit-child process");
});

test("armAuditDeadlineNudge: stamp present ⇒ exactly ONE steer with the pinned text at ~50 % of the budget (deliverAs: 'steer')", async () => {
	process.env[AUDIT_STARTED_AT_ENV] = String(Date.now());
	process.env["SAM_AUDIT_TIMEOUT_MS"] = "1400"; // 1.4 s budget → the nudge lands at ~0.7 s
	try {
		const sent: Sent[] = [];
		armAuditDeadlineNudge(fakePi(sent));
		await sleep(400);
		assert.equal(sent.length, 0, "nothing before the halfway mark");
		await sleep(500); // ~0.9 s > the 0.7 s mark
		assert.equal(sent.length, 1, "exactly one nudge (one-shot)");
		assert.equal(sent[0].text, auditDeadlineNudgeText(1400), "the pinned reminder text (budget-quoted)");
		assert.deepEqual(sent[0].options, { deliverAs: "steer" }, "queued as a steer (measured pi 0.87.1: continues the print run)");
		await sleep(500);
		assert.equal(sent.length, 1, "one-shot: no second nudge");
	} finally {
		delete process.env[AUDIT_STARTED_AT_ENV];
		delete process.env["SAM_AUDIT_TIMEOUT_MS"];
	}
});

test("armAuditDeadlineNudge: already past the halfway mark ⇒ no-op (nothing to save — the runner's SIGKILL timeout is the backstop)", async () => {
	process.env[AUDIT_STARTED_AT_ENV] = String(Date.now() - 60_000); // started a minute ago
	process.env["SAM_AUDIT_TIMEOUT_MS"] = "480000"; // default 8 min
	try {
		const sent: Sent[] = [];
		armAuditDeadlineNudge(fakePi(sent));
		await sleep(100);
		assert.equal(sent.length, 0, "past the halfway mark — the budget runs out without a nudge");
	} finally {
		delete process.env[AUDIT_STARTED_AT_ENV];
		delete process.env["SAM_AUDIT_TIMEOUT_MS"];
	}
});

/**
 * Unit tests: protocol text — the model-facing contract.
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	AUDIT_INSTRUCTION_PREFIX,
	CLOSE_UNIT_TOOL,
	P2_MODES,
	SAM_MARKER_PREFIX,
	UNDO_ACK_PREFIX,
	auditInstruction,
	closeUnitResultText,
	foldStubText,
	isSamInjected,
	undoAck,
} from "../src/protocol.ts";

test("audit instruction: prefix, unit id, ground-truth mandate, S7 marked-claims audit, reply discipline", () => {
	const text = auditInstruction(3);
	assert.ok(text.startsWith(AUDIT_INSTRUCTION_PREFIX), "starts with the marker prefix");
	assert.match(text, /^\[sam-audit\] Unit 3\b/, "names the unit (the rebuild finder depends on this shape)");
	assert.match(text, /VERIFIED/, "demands the VERIFIED verdict word");
	assert.match(text, /CORRECTIONS:/, "demands the CORRECTIONS format");
	assert.match(text, /ground truth/i, "carries the ground-truth mandate (P1 fix)");
	// S7 (2026-10-01): the third epistemic status — claims the close description
	// tells the model to mark "intermediate and open" (assumptions, leads,
	// suspected conflicts) must NOT be CORRECTION targets for their
	// unverifiedness: the auditor checks the MARKING, or the model learns not
	// to mark (the training failure the clause exists to prevent).
	assert.match(text, /marks as intermediate and open/, "S7: marked claims are part of the audit contract");
	assert.match(text, /is not itself a correction/, "S7: marked assumptions/leads are not CORRECTION targets");
	assert.match(text, /audit it for the marking/, "S7: the audit checks the marking (open, named basis, verify pointer)");
	assert.match(text, /not for whether the assumption holds/, "S7: nor the assumption's truth");
	assert.match(text, /nothing else/, "demands the exact-reply discipline");
	// 2026-10-06 (Paul, audit-ergonomics): economy + the evidence hierarchy + the
	// per-fact unverified escape (long audits were the slow tail; the child must
	// not earn its cost by re-running what the unit already ran).
	assert.match(text, /evidence of record/i, "economy: the span's recorded outputs are the evidence");
	assert.match(text, /do not re-derive it/, "recorded evidence is trusted, not re-derived");
	assert.match(text, /Long-running or expensive commands are discouraged/, "long/expensive commands discouraged");
	assert.match(text, /low-latency timeout/, "a command that must run stays short-lived");
	assert.match(text, /never re-run a test suite, a build/, "costly work is not re-run");
	assert.match(text, /stays as claimed, marked unverified/, "the per-fact unverified escape exists");
});

test("P4 R2: the audit instruction is SELF-CONTAINED — stub verbatim + recorded facts + session-file pointer", () => {
	const stub = "Wrote config.ts (3 lines) and verified the build.";
	const text = auditInstruction(7, {
		stub,
		evidence: { files: ["config.ts[write]"], errors: 2, retries: 1, nonTrivial: true },
	});
	// shape compatibility (rebuild finder / isSamInjected / walk guards)
	assert.match(text, /^\[sam-audit\] Unit 7\b/, "still prefix + unit id first");
	// the claim is carried inline — no lookup into the (possibly compacted) conversation
	assert.ok(text.includes(`STUB (verbatim):\n${stub}`), "the stub is inline, exactly as closed");
	// the objective close-time floor is carried (system-extracted, not claimed)
	assert.match(text, /RECORDED AT CLOSE/, "the recorded-facts line is present");
	assert.match(text, /files: config\.ts\[write\]/, "files touched are named");
	assert.match(text, /errors: 2/, "error count carried");
	assert.match(text, /retries: 1/, "retry count carried");
	assert.match(text, /non-trivial work: yes/, "non-triviality carried");
	// honest ground-truth order: entries (when in view) override the stub
	assert.match(text, /entries are ground truth/, "ground-truth mandate intact");
	// the compacted case has a reachable referent (F1: the file keeps every original byte)
	assert.match(text, /session's file/, "points at the session file when entries are out of view");
	assert.match(text, /sam close record for Unit 7/, "names how to find the raw span there");
	assert.match(text, /compaction/i, "explicitly covers the native-compaction case");
});

test("P4 R2: payload-less call stays valid (restored/legacy closes) — self-contained via the mandate + pointer", () => {
	const text = auditInstruction(2);
	assert.match(text, /^\[sam-audit\] Unit 2\b/);
	assert.match(text, /ground truth/i);
	assert.match(text, /session's file/);
	assert.ok(!text.includes("STUB (verbatim):"), "no stub line without a stub (nothing inline-quoted that isn't there)");
	assert.ok(!text.includes("RECORDED AT CLOSE"), "no facts line without evidence (no fabricated floor)");
});

test("P4 R2: zero-value evidence is rendered honestly (the floor found nothing — the auditor sees that)", () => {
	const text = auditInstruction(4, { stub: "touched nothing notable.", evidence: { files: [], errors: 0, retries: 0, nonTrivial: false } });
	assert.match(text, /files: \(none observed\)/);
	assert.match(text, /errors: 0/);
	assert.match(text, /non-trivial work: no/);
});

test("fold stub text: marker + stub, corrections appended when present", () => {
	assert.equal(foldStubText(1, "wrote data.txt"), "[Unit 1 ✓] wrote data.txt");
	assert.equal(
		foldStubText(2, "counted 5 lines", "line count is actually 6"),
		"[Unit 2 ✓] counted 5 lines [CORRECTIONS: line count is actually 6]",
	);
});

test("undo ack: marker family, unit id, exact reply demanded", () => {
	const text = undoAck(7);
	assert.ok(text.startsWith(UNDO_ACK_PREFIX));
	assert.match(text, /unit 7/);
	assert.match(text, /exactly OK/);
});

test("isSamInjected: the whole [sam- family is self-noise", () => {
	assert.equal(isSamInjected("[sam-audit] Unit 1 ..."), true);
	assert.ok(isSamInjected(UNDO_ACK_PREFIX + " x"), true);
	assert.equal(isSamInjected("[sam] no dash"), false, "[sam] without the dash is not our marker");
	assert.equal(isSamInjected("the user said [sam-...]"), false, "must be a prefix");
	assert.equal(isSamInjected("hello"), false);
});

test("marker prefixes share the [sam- family", () => {
	assert.ok(AUDIT_INSTRUCTION_PREFIX.startsWith(SAM_MARKER_PREFIX));
	assert.ok(UNDO_ACK_PREFIX.startsWith(SAM_MARKER_PREFIX));
});

test("P2 modes are exactly display + manual, in order", () => {
	assert.deepEqual([...P2_MODES], ["display", "manual"]);
});

test("close_unit tool definition: name, label, description, schema text, guidelines", () => {
	assert.equal(CLOSE_UNIT_TOOL.name, "close_unit");
	assert.equal(CLOSE_UNIT_TOOL.label, "close_unit");
	assert.ok(CLOSE_UNIT_TOOL.description.length > 40);
	assert.match(CLOSE_UNIT_TOOL.description, /ground truth|observed|tool outputs/i);
	assert.ok(CLOSE_UNIT_TOOL.promptSnippet.length > 10);
	assert.ok(Array.isArray(CLOSE_UNIT_TOOL.promptGuidelines) && CLOSE_UNIT_TOOL.promptGuidelines.length >= 2);
	assert.ok(CLOSE_UNIT_TOOL.parametersDescription.length > 10);
	assert.match(closeUnitResultText(2), /^Unit 2 closed/);
});

/* ── v4 (close-audit) protocol strings (S6 — house rule: strings + pins +
   design note together; note = dev repo v4-plan §5 S6) ──────────────────── */

import { CLOSE_UNIT_TOOL_V4, CLOSE_UNIT_NO_NEW_WORK_TEXT, CLOSE_UNIT_AUDIT_FORK_TEXT } from "../src/protocol.ts";

test("v4 close_unit copy (S7 iteration, wording of record 2026-10-01 eve — Paul's draft): two unit categories (checkable deliverable OR substantial finding/question after multiple tool calls + reasoning turns), intermediate-and-open marking for unverified derived findings (the assumed-mismatch example), checkpoint-not-end, reconciliation-reasoning stub, closing starts the next one, synchronous side-session audit, close effective on deferral", () => {
	assert.equal(CLOSE_UNIT_TOOL_V4.name, "close_unit");
	assert.equal(CLOSE_UNIT_TOOL_V4.label, "close_unit");
	// S6 clauses (kept verbatim in S7 — the reference-run iteration):
	assert.match(CLOSE_UNIT_TOOL_V4.description, /one checkable deliverable/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /Close it as it completes/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /checkpoint, not the end/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /open questions may stay open/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /as open, never as resolved/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /what was done AND what was checked/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /reconciliation reasoning/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /precisely what the audit verifies/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /Closing a unit starts the next one/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /several closes per turn are normal/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /side session/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /the session waits while it runs/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /the audit exchange never appears in this conversation/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /the close is effective either way/);
	// D8 + D9 (2026-10-02): the two added audit outcomes ride the copy (pins):
	assert.match(CLOSE_UNIT_TOOL_V4.description, /near pi's compaction line the audit runs LIGHT \(one turn, no tools\)/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /NOT-YET-VERIFIED/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /settles as UNVERIFIED \(audit-failed\)/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /the same-stub re-close \(or \/sam reaudit\) upgrades it/);
	// S7 + S7.1 clauses (2026-10-01 eve wording — the two live runs showed the
	// collection phase was not closable as a "deliverable"; category (b) makes
	// it closable by definition, and the third epistemic status — assumptions,
	// leads, suspected conflicts ("intermediate and open", never settled) —
	// rides the stub with its claim, observed basis, and verify pointer):
	assert.match(CLOSE_UNIT_TOOL_V4.description, /and store its intermediate summary/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /Key facts and datapoints of closed units will survive a compaction/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /or a substantial finding or question after multiple tool calls and reasoning turns/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /a discovery, a user decision, a claim, a new finding that needs further verification/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /assumptions, leads, suspected conflicts/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /mark them as intermediate and open/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /never as settled/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /name the claim, the basis you observed, and what would verify it/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /assumed mismatch between two interfaces in code/);
	assert.match(CLOSE_UNIT_TOOL_V4.description, /name the files or sources involved and what exactly seems to contradict/);
	// the v3 "at most one per unit" + "runs from the user message" claims are gone
	assert.ok(!/At most one close_unit per unit/.test(CLOSE_UNIT_TOOL_V4.description));
	assert.ok(!/the unit runs from the user message/.test(CLOSE_UNIT_TOOL_V4.description));
	// the first-draft "self-contained chunk" phrasing is superseded by the
	// sharper checkable-deliverable definition (S6 wording of record)
	assert.ok(!/self-contained chunk of work/.test(CLOSE_UNIT_TOOL_V4.description));
	assert.match(CLOSE_UNIT_TOOL_V4.promptSnippet, /synchronously on a side session/);
	assert.match(CLOSE_UNIT_TOOL_V4.promptSnippet, /stays in view until compaction/);
	const g = CLOSE_UNIT_TOOL_V4.promptGuidelines;
	assert.ok(g.some((line) => line.includes("checkpoint, not the end")), "guideline carries the checkpoint semantics");
	assert.ok(g.some((line) => line.includes("do not batch several deliverables into one close")), "guideline: close per deliverable, as it completes");
	assert.ok(g.some((line) => line.includes("except for claims marked intermediate and open")), "guideline: the S7 escape — marked assumptions carry claim + observed basis + verify pointer");
	assert.ok(g.some((line) => line.includes("close_unit again with the same stub")), "guideline: the deferred-retry affordance");
	// the v3 copy is byte-stable (the dials keep their contract incl. the control arm)
	assert.match(CLOSE_UNIT_TOOL.description, /At most one close_unit per unit/);
});

test("v4 refusal texts (the replaced CLOSE_UNIT_PENDING role + the audit-fork guard)", () => {
	assert.equal(
		CLOSE_UNIT_NO_NEW_WORK_TEXT,
		"No new work since the previous close_unit, so there is nothing to close for this unit. " +
			"The previous close is effective; do the remaining work first, then call close_unit for this unit.",
	);
	assert.equal(
		CLOSE_UNIT_AUDIT_FORK_TEXT,
		"This session is a SAM side-branch audit in progress: close_unit is not available here. " +
			"Complete the audit reply as instructed.",
	);
});

test("v3 close result text stays byte-stable (the followUp/steer/branch dials)", () => {
	assert.equal(
		closeUnitResultText(3),
		"Unit 3 closed. An audit turn follows; the unit is folded out of context only if the audit verifies the stub. Do not make further close_unit calls for this unit.",
	);
});

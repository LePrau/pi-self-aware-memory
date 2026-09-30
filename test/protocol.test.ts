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

test("audit instruction: prefix, unit id, ground-truth mandate, reply discipline", () => {
	const text = auditInstruction(3);
	assert.ok(text.startsWith(AUDIT_INSTRUCTION_PREFIX), "starts with the marker prefix");
	assert.match(text, /^\[sam-audit\] Unit 3\b/, "names the unit (the rebuild finder depends on this shape)");
	assert.match(text, /VERIFIED/, "demands the VERIFIED verdict word");
	assert.match(text, /CORRECTIONS:/, "demands the CORRECTIONS format");
	assert.match(text, /ground truth/i, "carries the ground-truth mandate (P1 fix)");
	assert.match(text, /nothing else/, "demands the exact-reply discipline");
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

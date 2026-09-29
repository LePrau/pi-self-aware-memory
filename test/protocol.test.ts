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

test("audit instruction: prefix, unit id, ground-truth mandate", () => {
	const text = auditInstruction(3);
	assert.ok(text.startsWith(AUDIT_INSTRUCTION_PREFIX), "starts with the marker prefix");
	assert.match(text, /^\[sam-audit\] Unit 3\b/, "names the unit");
	assert.match(text, /VERIFIED/, "demands the VERIFIED verdict word");
	assert.match(text, /CORRECTIONS:/, "demands the CORRECTIONS format");
	assert.match(text, /ground truth/i, "carries the ground-truth mandate (P1 fix)");
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

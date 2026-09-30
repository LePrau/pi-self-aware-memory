/**
 * P3 tests: commitproof.ts — the commit proof mechanism (port 3):
 * staging a fingerprinted span view, revalidating at commit time (append-only
 * growth allowed; any change inside the span fails closed), and the
 * ISSUED-vs-COMMITTED proof (the stub edit is in the branch ⇒ the batch
 * landed; undo-invariant).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fingerprintSpan, revalidateSpan, lostFolds, foldCommitProof } from "../src/commitproof.ts";
import { stageSpanProof } from "../src/state.ts";
import { rebuildLedger } from "../src/ledger.ts";
import { createSamState } from "../src/state.ts";
import type { PlainEntry } from "../src/projection.ts";

function user(id: string, text: string): PlainEntry {
	return { id, kind: "message", message: { role: "user", content: text } };
}
function assistantText(id: string, text: string): PlainEntry {
	return { id, kind: "message", message: { role: "assistant", content: text } };
}
function contextEdit(id: string, targetId: string, replacement: { content: unknown } | null): PlainEntry {
	return { id, kind: "context_edit", targetId, replacement };
}
function samRecord(id: string, data: Record<string, unknown>): PlainEntry {
	return { id, kind: "custom", customType: "sam", data };
}

test("staging pins the exact branch view of the span", () => {
	const branch: PlainEntry[] = [user("u1", "task"), assistantText("a1", "work")];
	const state = createSamState(rebuildLedger(branch));
	stageSpanProof(state, 1, { spanFirstId: "u1", spanLastId: "a1", entryIds: ["u1", "a1"] }, branch);
	const proof = state.spanProofs.get(1);
	assert.ok(proof);
	// stable: staging twice over the same view is a no-op
	stageSpanProof(state, 1, { spanFirstId: "u1", spanLastId: "a1", entryIds: ["u1", "a1"] }, branch);
	assert.equal(state.spanProofs.get(1)?.fingerprint, proof?.fingerprint);
});

test("revalidation: append-only growth after the span is allowed", () => {
	const branch: PlainEntry[] = [user("u1", "task"), assistantText("a1", "work")];
	const state = createSamState(rebuildLedger(branch));
	stageSpanProof(state, 1, { spanFirstId: "u1", spanLastId: "a1", entryIds: ["u1", "a1"] }, branch);
	const grown = [...branch, assistantText("a2", "next"), user("u2", "later")];
	const result = revalidateSpan(state.spanProofs.get(1), grown);
	assert.equal(result.ok, true, `growth after the span must be allowed, got: ${result.ok ? "" : result.reason}`);
});

test("revalidation: a CHANGE inside the span fails closed", () => {
	// In a single branch this means the span's entries are missing (forked
	// away) or the fingerprint differs; the observable refusal is the same.
	const branch: PlainEntry[] = [user("u1", "task"), assistantText("a1", "work")];
	const state = createSamState(rebuildLedger(branch));
	stageSpanProof(state, 1, { spanFirstId: "u1", spanLastId: "a1", entryIds: ["u1", "a1"] }, branch);
	const forked: PlainEntry[] = [
		user("u1", "task"),
		samRecord("c1", { v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "t", ts: 1, mode: "manual" }),
		user("u2", "task2"),
		assistantText("a2", "work2"),
	];
	const result = revalidateSpan(state.spanProofs.get(1), forked);
	assert.equal(result.ok, false);
	assert.match(result.reason as string, /missing-entries|fingerprint|order|contiguity/);
});

test("revalidation: entry reordering fails closed (order is part of the view)", () => {
	const branchA: PlainEntry[] = [user("u1", "first"), assistantText("a1", "second")];
	const branchB: PlainEntry[] = [assistantText("a1", "second"), user("u1", "first")];
	const state = createSamState(rebuildLedger(branchA));
	stageSpanProof(state, 1, { spanFirstId: "u1", spanLastId: "a1", entryIds: ["u1", "a1"] }, branchA);
	const result = revalidateSpan(state.spanProofs.get(1), branchB);
	assert.equal(result.ok, false, "same entries, different order: the view changed");
});

test("no proof staged → fail closed (never guess)", () => {
	assert.equal(revalidateSpan(null, [user("u1", "x")]).ok, false);
	assert.equal(revalidateSpan(undefined, [user("u1", "x")]).ok, false);
	assert.equal((revalidateSpan(null, [user("u1", "x")]) as { reason: string }).reason, "missing-entries");
});

test("fingerprintSpan: content-relevant (id/role/content), order-sensitive", () => {
	const a: PlainEntry[] = [user("u1", "task"), assistantText("a1", "work")];
	const b: PlainEntry[] = [assistantText("a1", "work"), user("u1", "task")];
	const changed: PlainEntry[] = [user("u1", "task"), assistantText("a1", "work CHANGED")];
	assert.notEqual(fingerprintSpan(a), fingerprintSpan(b), "order matters");
	assert.notEqual(fingerprintSpan(a), fingerprintSpan(changed), "content matters");
	assert.equal(fingerprintSpan(a), fingerprintSpan([...a]), "stable for the same view");
	// a non-content entry (stopReason) is part of the view:
	const c: PlainEntry[] = [user("u1", "task"), { id: "a1", kind: "message", message: { role: "assistant", content: "work", stopReason: "stop" } }];
	assert.notEqual(fingerprintSpan(a), fingerprintSpan(c));
	void foldCommitProof;
});

/* ── ISSUED vs COMMITTED (the s5 discard, made loud) ─────────────────────── */

test("lostFolds: a folded unit whose stub edit is missing gets a tombstone (the s5 case)", () => {
	// Session file as the s5 run left it: fold RECORD survived, batch (incl.
	// stub edit + fold record batch) — only the record, no edits:
	const branch: PlainEntry[] = [
		user("u1", "task " + "x".repeat(100)),
		samRecord("c1", { v: 1, kind: "close", unitId: 1, stub: "did work", toolCallId: "t", ts: 1, mode: "manual" }),
		samRecord("c2", {
			v: 1, kind: "fold", unitId: 1, entryIds: ["u1"], spanFirstId: "u1", spanLastId: "u1",
			stub: "did work", verdict: "VERIFIED", beforeTokens: 500, ts: 2, mode: "manual",
		}),
		// the stub edit + null edits never landed (pi discarded the batch):
		user("u2", "task2"),
		assistantText("a1", "work2"),
	];
	const ledger = rebuildLedger(branch);
	assert.equal(ledger.units.find((u) => u.unitId === 1)?.state, "folded");
	const lost = lostFolds(ledger, branch);
	assert.deepEqual(lost, [1], "unit 1 was ISSUED but never COMMITTED");
});

test("lostFolds: a landed fold (stub edit present) is NOT lost", () => {
	const branch: PlainEntry[] = [
		user("u1", "task " + "x".repeat(100)),
		samRecord("c1", { v: 1, kind: "close", unitId: 1, stub: "did work", toolCallId: "t", ts: 1, mode: "manual" }),
		samRecord("c2", {
			v: 1, kind: "fold", unitId: 1, entryIds: ["u1"], spanFirstId: "u1", spanLastId: "u1",
			stub: "did work", verdict: "VERIFIED", beforeTokens: 500, ts: 2, mode: "manual",
		}),
		contextEdit("e1", "u1", { content: "[Unit 1 ✓] did work" }),
		user("u2", "task2"),
	];
	const ledger = rebuildLedger(branch);
	assert.deepEqual(lostFolds(ledger, branch), []);
});

test("lostFolds: an UNDONE fold is not lost (the newer restore edits supersede)", () => {
	const branch: PlainEntry[] = [
		user("u1", "task " + "x".repeat(100)),
		samRecord("c1", { v: 1, kind: "close", unitId: 1, stub: "did work", toolCallId: "t", ts: 1, mode: "manual" }),
		samRecord("c2", {
			v: 1, kind: "fold", unitId: 1, entryIds: ["u1"], spanFirstId: "u1", spanLastId: "u1",
			stub: "did work", verdict: "VERIFIED", beforeTokens: 500, ts: 2, mode: "manual",
		}),
		contextEdit("e1", "u1", { content: "task " + "x".repeat(100) }), // undo restore
		samRecord("c3", { v: 1, kind: "undo", unitId: 1, targets: ["u1"], ts: 3 }),
		user("u2", "task2"),
	];
	const ledger = rebuildLedger(branch);
	assert.equal(ledger.units.find((u) => u.unitId === 1)?.state, "undone");
	assert.deepEqual(lostFolds(ledger, branch), []);
});

test("lostFolds: multiple folded units — only the lost ones tombstone", () => {
	const branch: PlainEntry[] = [
		user("u1", "task1"),
		samRecord("c1", { v: 1, kind: "close", unitId: 1, stub: "s1", toolCallId: "t", ts: 1, mode: "manual" }),
		samRecord("c2", { v: 1, kind: "fold", unitId: 1, entryIds: ["u1"], spanFirstId: "u1", spanLastId: "u1", stub: "s1", verdict: "VERIFIED", beforeTokens: 100, ts: 2, mode: "manual" }),
		// unit 1's edits LOST (no e-entries)
		user("u2", "task2"),
		samRecord("c3", { v: 1, kind: "close", unitId: 2, stub: "s2", toolCallId: "t", ts: 3, mode: "manual" }),
		samRecord("c4", { v: 1, kind: "fold", unitId: 2, entryIds: ["u2"], spanFirstId: "u2", spanLastId: "u2", stub: "s2", verdict: "VERIFIED", beforeTokens: 100, ts: 4, mode: "manual" }),
		contextEdit("e1", "u2", { content: "[Unit 2 ✓] s2" }), // unit 2 LANDED
		user("u3", "task3"),
	];
	const ledger = rebuildLedger(branch);
	assert.deepEqual(lostFolds(ledger, branch), [1]);
});

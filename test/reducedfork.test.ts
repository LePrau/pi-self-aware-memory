/**
 * v0.0.24 reduced fork (option B) — pure suite.
 * The pi-semantics equivalence test (test/pi-semantics.test.ts, D7b) pins
 * the CONTEXT invariant against each gated pi's own buildContextEntries.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildReducedFork, type RawCompactionEntry } from "../src/reducedfork.ts";
import type { RawEntry } from "../src/branchaudit.ts";

/* ── fixture builders (session-file shapes, NDJSON order = path order) ───── */

let seq = 0;
function nid(): string {
	seq += 1;
	return `id${seq.toString().padStart(2, "0")}`;
}
function header(id = "hdr1"): RawEntry {
	return { id, type: "session", parentId: null, version: 3, cwd: "/tmp/x", parentSession: "/tmp/main.jsonl" } as RawEntry;
}
function msg(role: "user" | "assistant" | "system", parentId: string | null, text: string): RawEntry {
	const id = nid();
	return { id, parentId, type: "message", message: { role, content: [{ type: "text", text }] } };
}
function custom(parentId: string | null, customType: string, data: unknown): RawEntry {
	const id = nid();
	return { id, parentId, type: "custom", customType, data };
}
function compaction(parentId: string | null, summary: string, firstKeptEntryId: string | null): RawCompactionEntry {
	const id = nid();
	return { id, parentId, type: "compaction", summary, firstKeptEntryId };
}
function label(parentId: string | null): RawEntry {
	const id = nid();
	return { id, parentId, type: "label", customType: "label", data: { name: "L" } };
}
function lastId(es: RawEntry[]): string {
	return es[es.length - 1].id;
}
/** the re-chained expectation: first parentId null, each next = previous id */
function rechainIds(es: RawEntry[]): string[] {
	assert.equal(es[0].parentId, null);
	for (let i = 1; i < es.length; i++) assert.equal(es[i].parentId, es[i - 1].id);
	return es.map((e) => e.id);
}

test("no compaction: full path, labels excluded, re-chained, truncated=false", () => {
	seq = 0;
	const a = msg("user", null, "hi");
	const b = label(a.id);
	const c = msg("assistant", b.id, "hello");
	const file = [header(), a, b, c];
	const r = buildReducedFork(file, c.id);
	assert.ok(r !== undefined);
	assert.equal(r!.truncated, false);
	assert.deepEqual(rechainIds(r!.entries), [a.id, c.id]); // the label dropped
});

test("compaction: truncated at firstKeptEntryId, chain restarts at null", () => {
	seq = 0;
	const a = msg("user", null, "old");
	const b = msg("assistant", a.id, "old reply");
	const fk = msg("user", b.id, "kept-start");
	const d = msg("assistant", fk.id, "kept");
	const C = compaction(d.id, "SUMMARY", fk.id);
	const e = msg("user", C.id, "after");
	const f = msg("assistant", e.id, "after reply");
	const file = [header(), a, b, fk, d, C, e, f];
	const r = buildReducedFork(file, f.id);
	assert.ok(r !== undefined);
	assert.equal(r!.truncated, true);
	assert.deepEqual(rechainIds(r!.entries), [fk.id, d.id, C.id, e.id, f.id]); // a,b dropped
	const comp = r!.entries.find((x) => x.id === C.id) as RawCompactionEntry;
	assert.equal(comp.firstKeptEntryId, fk.id); // still resolves in the file
});

test("firstKept is a system message: kept in the file, truncation there", () => {
	seq = 0;
	const a = msg("user", null, "old");
	const sys = msg("system", a.id, "SYS");
	const b = msg("user", sys.id, "after-sys");
	const C = compaction(b.id, "S", sys.id);
	const file = [header(), a, sys, b, C];
	const r = buildReducedFork(file, C.id);
	assert.ok(r !== undefined);
	assert.equal(r!.truncated, true);
	assert.deepEqual(rechainIds(r!.entries), [sys.id, b.id, C.id]); // a dropped, sys KEPT
});

test("firstKept is a label: remapped to the next kept entry, truncation there", () => {
	seq = 0;
	const a = msg("user", null, "old");
	const L = label(a.id);
	const b = msg("user", L.id, "kept-start");
	const C = compaction(b.id, "S", L.id); // points at the label
	const file = [header(), a, L, b, C];
	const r = buildReducedFork(file, C.id);
	assert.ok(r !== undefined);
	assert.equal(r!.truncated, true);
	assert.deepEqual(rechainIds(r!.entries), [b.id, C.id]); // label dropped, remapped to b
	const comp = r!.entries.find((x) => x.id === C.id) as RawCompactionEntry;
	assert.equal(comp.firstKeptEntryId, b.id);
});

test("branched leaf: only the active path is forked", () => {
	seq = 0;
	const a = msg("user", null, "root");
	const b1 = msg("assistant", a.id, "branch one");
	const c1 = msg("user", b1.id, "deeper one");
	const b2 = msg("user", a.id, "branch two");
	const c2 = msg("assistant", b2.id, "deeper two");
	const file = [header(), a, b1, c1, b2, c2];
	const r = buildReducedFork(file, c2.id);
	assert.ok(r !== undefined);
	assert.deepEqual(rechainIds(r!.entries), [a.id, b2.id, c2.id]);
});

test("two compactions: both kept when the earlier one is inside the kept window; last wins", () => {
	seq = 0;
	const a = msg("user", null, "v1");
	const C1 = compaction(a.id, "S1", a.id);
	const b = msg("user", C1.id, "v2");
	const C2 = compaction(b.id, "S2", a.id); // kept window reaches back to a (before C1)
	const c = msg("assistant", C2.id, "v3");
	const file = [header(), a, C1, b, C2, c];
	const r = buildReducedFork(file, c.id);
	assert.ok(r !== undefined);
	assert.equal(r!.truncated, true);
	assert.deepEqual(rechainIds(r!.entries), [a.id, C1.id, b.id, C2.id, c.id]); // nothing dropped
});

test("total over garbage: empty, no leaf, unknown leaf, header-only, bad entries", () => {
	seq = 0;
	assert.equal(buildReducedFork([], "x"), undefined);
	assert.equal(buildReducedFork([header()], "x"), undefined);
	assert.equal(buildReducedFork([header(), msg("user", null, "hi")], "missing"), undefined);
	assert.equal(buildReducedFork([header(), msg("user", null, "hi")], null), undefined);
	assert.equal(buildReducedFork([header(), msg("user", null, "hi")], undefined), undefined);
	// a corrupt entry without an id is skipped, not thrown
	const bad = [{ type: "message", message: { role: "user", content: "x" } }] as unknown as RawEntry[];
	assert.equal(buildReducedFork(bad, "x"), undefined);
	// path of only labels ⇒ no kept entries ⇒ undefined (caller falls back)
	seq = 0;
	const L1 = label(null);
	const L2 = label(L1.id);
	assert.equal(buildReducedFork([header(), L1, L2], L2.id), undefined);
});

test("firstKept unresolvable (corrupt): no truncation, full kept list", () => {
	seq = 0;
	const a = msg("user", null, "old");
	const b = msg("user", a.id, "new");
	const C = compaction(b.id, "S", "ghost"); // points at nothing
	const file = [header(), a, b, C];
	const r = buildReducedFork(file, C.id);
	assert.ok(r !== undefined);
	assert.equal(r!.truncated, true); // a compaction IS on the path
	assert.deepEqual(rechainIds(r!.entries), [a.id, b.id, C.id]); // nothing dropped
});

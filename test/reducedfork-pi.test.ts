/**
 * v0.0.24 reduced fork (option B) — CONTEXT equivalence against real pi.
 *
 * The whole point of the reduced child session file (dev repo
 * notes/2026-10-24-reduced-fork-child.md, invariant): pi's
 * `buildSessionContext(full root→leaf path).messages` MUST equal
 * `buildSessionContext(reduced entries).messages` — truncation at the last
 * compaction's `firstKeptEntryId` drops only entries pi's context builder
 * never projects (its `foundFirstKept` guard).
 *
 * The pi import is optional: set SAM_PI_DIR to a node_modules directory
 * containing @earendil-works/pi-coding-agent (e.g. a pi-binary dir).
 * Without it, every test here is SKIPPED — the pure suite still runs.
 * The gate runs this under all three pi versions, so a semantic change in
 * pi's context builder fails the gate before ship (D7b).
 *
 * Run: SAM_PI_DIR=/workspace/pi-binary/1.4.0/node_modules node --test test/reducedfork-pi.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildReducedFork } from "../src/reducedfork.ts";
import type { RawEntry } from "../src/branchaudit.ts";

const PI_DIR = process.env.SAM_PI_DIR;
const t = PI_DIR ? test : test.skip;

let buildSessionContext: (entries: unknown[], leafId: string | null) => { messages: unknown[] };
if (PI_DIR) {
	const mod = await import(pathToFileURL(join(PI_DIR, "@earendil-works/pi-coding-agent", "dist", "index.js")).href);
	buildSessionContext = mod.buildSessionContext;
}

/* ── synthetic session-file entries (pi's shapes) ───────────────────────── */

let seq = 0;
function nid(): string {
	seq += 1;
	return `e${seq.toString().padStart(2, "0")}`;
}
function ts(): number {
	return Date.now();
}
function header(id = "h0"): RawEntry {
	return { id, type: "session", parentId: null, version: 3, timestamp: ts(), cwd: "/tmp/x", parentSession: "/tmp/main.jsonl" } as RawEntry;
}
function user(parentId: string | null, text: string): RawEntry {
	const id = nid();
	return { id, parentId, type: "message", timestamp: ts(), message: { role: "user", content: text, timestamp: ts() } };
}
function assistant(parentId: string | null, text: string): RawEntry {
	const id = nid();
	return {
		id, parentId, type: "message", timestamp: ts(),
		message: {
			role: "assistant", content: [{ type: "text", text }], api: "faux", provider: "faux", model: "faux",
			usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: ts(),
		},
	};
}
function system(parentId: string | null, text: string): RawEntry {
	const id = nid();
	return { id, parentId, type: "message", timestamp: ts(), message: { role: "system", content: text, timestamp: ts() } };
}
function label(parentId: string | null, targetId: string): RawEntry {
	const id = nid();
	return { id, parentId, type: "label", customType: "label", label: "L", targetId, timestamp: ts() } as RawEntry;
}
function compaction(parentId: string | null, firstKeptEntryId: string): RawEntry {
	const id = nid();
	return { id, parentId, type: "compaction", summary: `SUMMARY-${id}`, firstKeptEntryId, tokens: 100, timestamp: ts() };
}

/** The claim under test: reduced ⇒ identical pi context messages. */
function assertSameContext(full: RawEntry[], leafId: string, label: string) {
	const reduced = buildReducedFork(full, leafId);
	assert.ok(reduced !== undefined, label + ": buildReducedFork returned undefined");
	assert.equal(reduced!.truncated, true, label + ": expected truncation (a compaction is on the path)");
	const a = buildSessionContext(full, leafId);
	const b = buildSessionContext(reduced!.entries as unknown[], reduced!.entries[reduced!.entries.length - 1].id);
	assert.deepEqual(b.messages, a.messages, label);
}

t("reduced fork ⇒ identical pi context (compaction mid-path, firstKept = message)", () => {
	seq = 0;
	const a = user(null, "old one");
	const b = assistant(a.id, "old reply");
	const fk = user(b.id, "kept start");
	const d = assistant(fk.id, "kept reply");
	const C = compaction(d.id, fk.id);
	const e = user(C.id, "after");
	const f = assistant(e.id, "after reply");
	const file = [header(), a, b, fk, d, C, e, f];
	// sanity: the truncation actually dropped entries
	const r = buildReducedFork(file, f.id)!;
	assert.equal(r.entries.length, 5); // a, b dropped (8 file lines − header − 2 dropped)
	assertSameContext(file, f.id, "mid-path");
});

t("reduced fork ⇒ identical pi context (firstKept = system message)", () => {
	seq = 0;
	const a = user(null, "old one");
	const sys = system(a.id, "SYSTEM");
	const b = user(sys.id, "after system");
	const C = compaction(b.id, sys.id);
	const f = assistant(C.id, "reply");
	const file = [header(), a, sys, b, C, f];
	const r = buildReducedFork(file, f.id)!;
	assert.deepEqual(r.entries.map((x) => x.id), [sys.id, b.id, C.id, f.id]); // a dropped, sys kept
	assertSameContext(file, f.id, "system-firstKept");
});

t("reduced fork ⇒ identical pi context (firstKept = label, remapped)", () => {
	seq = 0;
	const a = user(null, "old one");
	const L = label(a.id, a.id);
	const b = user(L.id, "kept start");
	const C = compaction(b.id, L.id); // firstKept points at the label
	const f = assistant(C.id, "reply");
	const file = [header(), a, L, b, C, f];
	const r = buildReducedFork(file, f.id)!;
	assert.deepEqual(r.entries.map((x) => x.id), [b.id, C.id, f.id]); // label dropped + remapped to b
	assertSameContext(file, f.id, "label-firstKept");
});

t("reduced fork ⇒ identical pi context (two compactions, earlier one inside the kept window)", () => {
	seq = 0;
	const a = user(null, "v1");
	const C1 = compaction(a.id, a.id);
	const b = user(C1.id, "v2");
	const C2 = compaction(b.id, a.id);
	const c = assistant(C2.id, "v3 reply");
	const file = [header(), a, C1, b, C2, c];
	const r = buildReducedFork(file, c.id)!;
	assert.equal(r.entries.length, 5); // nothing dropped (C1 inside the kept window)
	assertSameContext(file, c.id, "two-compactions");
});

t("no compaction ⇒ no truncation, but the label-free re-chain still projects identically", () => {
	seq = 0;
	const a = user(null, "one");
	const L = label(a.id, a.id);
	const b = assistant(L.id, "two");
	const file = [header(), a, L, b];
	const r = buildReducedFork(file, b.id);
	assert.ok(r !== undefined);
	assert.equal(r!.truncated, false); // D3: the caller keeps pi's ctx.fork here
	const aa = buildSessionContext(file, b.id);
	const bb = buildSessionContext(r!.entries as unknown[], b.id);
	assert.deepEqual(bb.messages, aa.messages, "label-free re-chain projects identically");
});

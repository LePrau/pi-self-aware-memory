/**
 * Stub pre-check — the parser port (src/precheck-parse.ts).
 *
 * Port fidelity is the contract: the regexes and guards are 1:1 with dev-repo
 * `measurements/audit-quality/parse-stubs.mjs` (validated against dataset
 * rows 120/300/306). The pinned cases here are the dataset spot-checks from
 * `stub-structure.md` §2–§3: marker ownership in the split, the comma-guarded
 * testcounts, the apostrophe-safe quotes, the tagged-commit dedupe, and the
 * method-chain/version/time/TLD guards on file-like tokens — plus the one
 * deliberate port fix (the file-range sed window now spans a-5..b+5).
 *
 * Run: node --test test/precheck-parse.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { extractFacts, splitClaims, type ParsedFact } from "../src/precheck-parse.ts";

const byType = (facts: ParsedFact[], type: string) => facts.filter((f) => f.type === type);

test("splitClaims: marker ownership (pinned to the parse-stubs.mjs output)", () => {
	const stub = "1. First claim; second claim. (A) After the marker. Third `line`.";
	const out = splitClaims(stub);
	assert.deepEqual(out, [
		"1", // the numeric marker "1." splits off as its own fragment (". " split)
		"First claim",
		"second claim.", // period before " (A)" stays (the marker regex only takes the space)
		"(A) After the marker", // the (A) marker attaches to what follows
		"Third `line`.",
	]);
});
// marker-ownership note verified against parse-stubs.mjs: the numeric marker
// "1." splits off as its own fragment; the " (A)" marker attaches to the text
// that FOLLOWS it.

test("splitClaims: blank lines drop, finer adds comma splits", () => {
	const stub = "alpha, beta; gamma";
	assert.deepEqual(splitClaims(stub), ["alpha, beta", "gamma"]);
	assert.deepEqual(splitClaims(stub, true), ["alpha", "beta", "gamma"]);
});

test("extractFacts: tagged commit is one fact (the bare pass is suppressed)", () => {
	const facts = extractFacts("the ext eace7ac landed (8 files)");
	const tagged = byType(facts, "commit-tagged");
	assert.equal(tagged.length, 1);
	assert.equal(tagged[0].value, "ext eace7ac");
	assert.ok(tagged[0].spec.includes("git -C <repo:ext>"));
	assert.equal(byType(facts, "commit").length, 0); // no duplicate bare commit
});

test("extractFacts: bare commit with commit vocab, longest-first (12-hex not double-counted)", () => {
	const facts = extractFacts("commit 920fea2be71d shipped; short abc1234 after");
	const commits = byType(facts, "commit");
	assert.deepEqual(commits.map((c) => c.value), ["920fea2be71d", "abc1234"]);
});

test("extractFacts: all-digit hash is flagged ambiguous-digit", () => {
	const facts = extractFacts("commit 1234567 verified");
	const commits = byType(facts, "commit");
	assert.equal(commits.length, 1);
	assert.equal(commits[0].note, "ambiguous-digit");
});

test("extractFacts: 01a-prefixed 8-hex lands as a commit fact with note 'session-id' (the executor must filter on the note)", () => {
	const facts = extractFacts("session 01a12345 banked");
	// Fidelity: the commit8 pass consumes every 8-hex token first, so the 01a
	// session id is a `commit` fact CARRYING note "session-id" (the .mjs'
	// separate session-id path is dead code — seen.has() always skips it).
	const commits = byType(facts, "commit");
	assert.equal(commits.length, 1);
	assert.equal(commits[0].value, "01a12345");
	assert.equal(commits[0].note, "session-id");
});

test("extractFacts: file-line ref with the ±5 sed window", () => {
	const facts = extractFacts("see src/closeaudit.ts:1135");
	const fl = byType(facts, "file-line");
	assert.equal(fl.length, 1);
	assert.equal(fl[0].value, "src/closeaudit.ts:1135");
	assert.ok(fl[0].spec.includes("ls <cwd-or-repo>/src/closeaudit.ts"));
	assert.ok(fl[0].spec.includes("sed -n '1130,1140p'"));
});

test("extractFacts: file-range window spans a-5..b+5 (the port fix)", () => {
	const facts = extractFacts("the change at src/closeaudit.ts:100-139");
	const fr = byType(facts, "file-range");
	assert.equal(fr.length, 1);
	assert.ok(fr[0].spec.includes("sed -n '95,144p'"));
});

test("extractFacts: time-like :N and domain:port are not file refs (port fix 3)", () => {
	const facts = extractFacts("at 18:24 on host.example.com:443");
	assert.equal(byType(facts, "file-line").length, 0); // time-like prefix guard
	assert.equal(byType(facts, "file").length, 0); // the :443 tail no longer leaks a bare file
});

test("extractFacts: implicit-file bare-line ref", () => {
	const facts = extractFacts("the marker (:1135) marks it");
	const bl = byType(facts, "bare-line");
	assert.equal(bl.length, 1);
	assert.equal(bl[0].value, ":1135");
});

test("extractFacts: approximate line refs", () => {
	const facts = extractFacts("around ~line 95 the gate line");
	const ap = byType(facts, "line-approx");
	assert.deepEqual(ap.map((a) => a.value), ["~95"]);
});

test("extractFacts: bare files keep, versions/method-chains/numeric drop", () => {
	const facts = extractFacts("updated CURRENT_TASK.md and notes/x.md; task.tokens.size() vs v1.3.0 and 7.0.2 and 1.2.3.4");
	const files = byType(facts, "file").map((f) => f.value);
	assert.ok(files.includes("CURRENT_TASK.md"));
	assert.ok(files.includes("notes/x.md"));
	assert.ok(!files.some((f) => f.includes("tokens") || f.includes("size"))); // method chain
	assert.ok(!files.includes("v1.3.0") && !files.includes("7.0.2") && !files.includes("1.2.3.4")); // version-like / numeric
	const versions = byType(facts, "version").map((v) => v.value);
	assert.ok(versions.includes("1.3.0"));
	assert.ok(versions.includes("7.0.2"));
});

test("extractFacts: comma-guarded testcount (decimal-comma numbers yield NO fact)", () => {
	// Fidelity: "9,142/92,688" yields ZERO testcount facts (the comma guards on
	// both sides block it — the guard's job is to NOT emit 142/92); a plain
	// digit run yields exactly one.
	assert.equal(byType(extractFacts("gate at 9,142/92,688 passed"), "testcount").length, 0);
	assert.deepEqual(byType(extractFacts("gate at 9142/92688 passed"), "testcount").map((t) => t.value), ["9142/92688"]);
});

test("extractFacts: plain testcount", () => {
	const facts = extractFacts("731/731 green ×3");
	const tc = byType(facts, "testcount");
	assert.deepEqual(tc.map((t) => t.value), ["731/731"]);
});

test("extractFacts: sizes — unit suffix required, decimals whole (port fix 2)", () => {
	const facts = extractFacts("the note is 10.3 KB, the log 4.5 MB, the stub 2305 B");
	const sizes = byType(facts, "size").map((s) => s.value);
	assert.deepEqual(sizes, ["10.3 KB", "4.5 MB", "2305 B"]);
	// no double capture of the fraction as its own size
	assert.ok(!sizes.includes("3 KB"));
	// bare 'bytes' is not a unit
	const none = extractFacts("contains 7361 bytes");
	assert.equal(byType(none, "size").length, 0);
});

test("extractFacts: dates, unit refs, exit codes, gates", () => {
	const facts = extractFacts("on 2026-11-18 u185 VERIFIED; exit 1 once; GATE: PASS");
	assert.deepEqual(byType(facts, "date").map((d) => d.value), ["2026-11-18"]);
	assert.deepEqual(byType(facts, "unit-ref").map((u) => u.value), ["u185"]);
	assert.deepEqual(byType(facts, "exit-code").map((e) => e.value), ["1"]);
	const gate = byType(facts, "gate");
	assert.equal(gate.length, 1);
});

test("extractFacts: quotes — apostrophes in words are not quotes; user-word context flagged", () => {
	const facts = extractFacts("Paul's edit and the user said \"keep the block flat\"");
	const quotes = byType(facts, "quote");
	assert.equal(quotes.length, 1);
	assert.ok(quotes[0].value.startsWith('"keep the block flat"'));
	assert.ok(quotes[0].spec.includes("user's verbatim words"));
});

test("extractFacts: OPEN section marker", () => {
	const facts = extractFacts("done. OPEN: Paul's commit + the anomaly analyses");
	const open = byType(facts, "open-section");
	assert.equal(open.length, 1);
	assert.ok(open[0].value.startsWith("OPEN:"));
});

test("extractFacts: facts ordered by offset", () => {
	const facts = extractFacts("b 2026-11-18 a commit abc1234 c u7");
	const at = facts.map((f) => f.at);
	assert.deepEqual(at, [...at].sort((x, y) => x - y));
});

test("extractFacts: empty stub yields no facts (total)", () => {
	assert.deepEqual(extractFacts(""), []);
	assert.deepEqual(splitClaims(""), []);
});

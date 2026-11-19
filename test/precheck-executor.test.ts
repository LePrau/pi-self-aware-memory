/**
 * Stub pre-check — executor (src/precheck-executor.ts).
 *
 * Pins the settled display spec (dev-repo notes/2026-11-18-stub-precheck-
 * prompt-mockup.md, all rounds) and the circuit-breaker classification
 * (u299): the fake runner scripts exact command→output pairs, so the
 * tests assert the block VERBATIM, not by re-deriving.
 *
 * Run: node --test test/precheck-executor.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runPrechecks, type Runner, type RunResult } from "../src/precheck-executor.ts";
import type { ParsedFact } from "../src/precheck-parse.ts";
import type { Discovery } from "../src/precheck-discovery.ts";

/* ── fixtures ───────────────────────────────────────────────────────────── */

const W = "/workspace";
const EXT = "/workspace/pi-agent/extensions/pi-self-aware-memory";
const DEV = "/workspace/pi-agent/development/context-management/pi-self-aware-memory-dev";

const clock = { long: "Wed Nov 18 17:26:29 UTC 2026", short: "2026-11-18 17:26:29" };

const discovery: Discovery = {
	repos: [
		{ path: DEV, lastEntryIndex: 5, evidence: "cd " + DEV + " && git status" },
		{ path: EXT, lastEntryIndex: 3, evidence: "cd " + EXT + " && git status" },
		{ path: W, lastEntryIndex: 1, evidence: "session cwd" },
	],
	files: [
		{ absPath: W + "/CURRENT_TASK.md", lastTool: "write", lastEntryIndex: 2 },
		{ absPath: EXT + "/src/x.ts", lastTool: "edit", lastEntryIndex: 4 },
	],
	cwd: W,
	scanStart: 0,
};

const fact = (type: string, value: string): ParsedFact => ({ type, value, spec: "", at: 0 });

/** A fake runner that answers from a script (exact-command match). */
function scripted(script: Map<string, RunResult>): Runner {
	return async (command) => {
		const hit = script.get(command);
		if (!hit) throw new Error("UNSCRIPTED COMMAND: " + command);
		return hit;
	};
}

/** The executor's exact command strings (mirroring withExit + q() quoting). */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const c = {
	date: `date -u; date -u '+%Y-%m-%d %H:%M:%S' 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
	status: (dir: string) => `git -C ${q(dir)} status --porcelain 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
	log: (dir: string, h: string) => `git -C ${q(dir)} log -1 --stat --format='%ad%x09%s' --date=short ${q(h)} 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
	ls: (p: string) => `ls ${q(p)} 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
	probe: (candidates: string[]) =>
		candidates.map((p) => `[ -f ${q(p)} ] && printf 'HIT %s\\n' ${q(p)}`).join(" ; ") + ` ; true 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
	sed: (range: string, p: string) => `sed -n '${range}p' ${q(p)} 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
};

const ok = (body: string): RunResult => ({ stdout: body + "\nEXIT:0\n", isError: false });
const err = (body: string, code: number): RunResult => ({ stdout: body + `\nEXIT:${code}\n`, isError: false });
const toolErr = (msg: string): RunResult => ({ stdout: msg, isError: true });

/* ── the u8 scenario (the mockup's real data, end to end) ───────────────── */

test("u8 scenario: three found commits, two files, the flat no-result lines, reduced-noise header", async () => {
	const facts = [
		fact("commit-tagged", "root 2ad7a8f"),
		fact("commit-tagged", "ext eace7ac"),
		fact("commit-tagged", "dev 78423bc"),
		fact("file", "CURRENT_TASK.md"),
		fact("file", "node_modules/install-pi-0.87.1.sh"),
		fact("testcount", "9/9"),
		fact("version", "0.0.28"),
		fact("version", "0.0.27"),
		fact("version", "0.87.1"),
		fact("date", "2026-10-28"),
	];
	const script = new Map<string, RunResult>();
	script.set(c.date, ok("Wed Nov 18 17:26:29 UTC 2026\n2026-11-18 17:26:29"));
	script.set(c.status(W), ok(" M CURRENT_TASK.md"));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	// most-recent-first: DEV, then EXT, then W
	// most-recent-first: DEV, then EXT, then W (misses until the hit)
	script.set(c.log(DEV, "2ad7a8f"), err("fatal: bad revision '2ad7a8f'", 128));
	script.set(c.log(EXT, "2ad7a8f"), err("fatal: bad revision '2ad7a8f'", 128));
		script.set(c.log(W, "2ad7a8f"), ok('2026-10-28\tCURRENT_TASK.md: v0.0.28 shipped + live\n\n CURRENT_TASK.md | 6 ++++--\n 1 file changed, 4 insertions(+), 2 deletions(-)'));
	script.set(c.log(DEV, "eace7ac"), err("fatal: bad revision 'eace7ac'", 128));
		script.set(c.log(EXT, "eace7ac"), ok("2026-10-27\tv0.0.28: elapsed time on close and audit\n\n CHANGELOG.md | 6 ++++--\n src/closeaudit.ts | 200 ++++++++++++++++++++++++++++++++++++----\n 8 files changed, 527 insertions(+), 13 deletions(-)"));
		script.set(c.log(DEV, "78423bc"), ok("2026-10-27\telapsed-time feature shipped as v0.0.28\n\n WISHLIST.md | 90 ++++++++++++++++-\n notes/2026-10-27-close-audit-elapsed-time.md | 14 ++--\n 2 files changed, 104 insertions(+), 1 deletion(-)"));
	script.set(c.ls(W + "/CURRENT_TASK.md"), ok("CURRENT_TASK.md"));
	script.set(c.probe([W + "/node_modules/install-pi-0.87.1.sh", DEV + "/node_modules/install-pi-0.87.1.sh", EXT + "/node_modules/install-pi-0.87.1.sh"]), ok("HIT /workspace/node_modules/install-pi-0.87.1.sh"));

	const r = await runPrechecks(facts, discovery, scripted(script), clock);

	// every scripted command was consumed exactly (the runner would have thrown otherwise)
	assert.ok(r.commands > 5);
	assert.equal(r.hardErrors, 0);

	const expected = [
		"Clock: Wed Nov 18 17:26:29 UTC 2026 · 2026-11-18 17:26:29",
		"Git repos checked:",
		`- ${W}`,
		`- ${EXT}`,
		`- ${DEV}`,
		"- commit 2ad7a8f exists in " + W,
		'    2026-10-28 "CURRENT_TASK.md: v0.0.28 shipped + live"',
		"    (1 file: CURRENT_TASK.md +4/−2)",
		"- commit eace7ac exists in " + EXT,
		'    2026-10-27 "v0.0.28: elapsed time on close and audit"',
		"    (8 files, +527/−13)",
		"- commit 78423bc exists in " + DEV,
		'    2026-10-27 "elapsed-time feature shipped as v0.0.28"',
		"    (2 files, +104/−1)",
		"- file CURRENT_TASK.md exists at " + W + "/CURRENT_TASK.md",
		"- file node_modules/install-pi-0.87.1.sh exists at " + W + "/node_modules/install-pi-0.87.1.sh",
		"- testcount 9/9 — no cheap result (no gate log named in the stub)",
		"- versions 0.0.28 / 0.0.27 / 0.87.1 — no cheap result (not checkable from the stub alone)",
		"- date 2026-10-28 — no cheap result (consistent with the commit dates found above, not independently checked)",
	].join("\n");
	assert.equal(r.block, expected);

	// positives (summary-carry, phase D): only actual hits, no verbose info
	assert.deepEqual(r.positives.commitsFound, [
		{ hash: "2ad7a8f", repo: W },
		{ hash: "eace7ac", repo: EXT },
		{ hash: "78423bc", repo: DEV },
	]);
	assert.deepEqual(r.positives.filesFound, [
		{ claim: "CURRENT_TASK.md", paths: [W + "/CURRENT_TASK.md"] },
		{ claim: "node_modules/install-pi-0.87.1.sh", paths: [W + "/node_modules/install-pi-0.87.1.sh"] },
	]);
	// insertion order = first-hit order (most-recent repos first)
	assert.deepEqual(r.positives.reposUsed, [W, EXT, DEV]);
});

/* ── the reduced-noise rule, both branches ───────────────────────────────── */

test("header: one hash missing → ALL valid repos listed; the miss line has no repo enumeration", async () => {
	const facts = [fact("commit", "a1b2c3d"), fact("commit", "2ad7a8f")];
	const script = new Map<string, RunResult>();
	script.set(c.status(W), ok(""));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	script.set(c.log(DEV, "a1b2c3d"), err("fatal: ambiguous argument 'a1b2c3d': unknown revision or path not in the working tree.\nfatal: bad revision 'a1b2c3d'", 128));
	script.set(c.log(EXT, "a1b2c3d"), err("fatal: bad revision 'a1b2c3d'", 128));
	script.set(c.log(W, "a1b2c3d"), err("fatal: bad revision 'a1b2c3d'", 128));
	script.set(c.log(DEV, "2ad7a8f"), err("fatal: bad revision '2ad7a8f'", 128));
	script.set(c.log(EXT, "2ad7a8f"), err("fatal: bad revision '2ad7a8f'", 128));
	script.set(c.log(W, "2ad7a8f"), ok('2026-10-28\tCURRENT_TASK.md: v0.0.28 shipped\n\n CURRENT_TASK.md | 6 ++++--\n 1 file changed, 4 insertions(+), 2 deletions(-)'));

	const r = await runPrechecks(facts, discovery, scripted(script), clock);
	assert.equal(r.hardErrors, 0); // the unknown-revision negatives are EXPECTED
	const header = r.block.split("\n").slice(0, 5);
	assert.deepEqual(header, [
		"Clock: Wed Nov 18 17:26:29 UTC 2026 · 2026-11-18 17:26:29",
		"Git repos checked:",
		`- ${DEV}`,
		`- ${EXT}`,
		`- ${W}`,
	]);
	assert.ok(r.block.includes("- commit a1b2c3d not found in the named repos"));
	assert.ok(!r.block.includes("a1b2c3d not found in " + W)); // no per-hash enumeration
	assert.ok(r.block.includes("- commit 2ad7a8f exists in " + W));
	// positives carry only the hit
	assert.deepEqual(r.positives.commitsFound, [{ hash: "2ad7a8f", repo: W }]);
});

test("header: all hashes found → only repos with hits (no header at all when there are no commit claims)", async () => {
	const facts = [fact("commit", "2ad7a8f")];
	const script = new Map<string, RunResult>();
	script.set(c.status(W), ok(""));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	script.set(c.log(DEV, "2ad7a8f"), err("fatal: bad revision '2ad7a8f'", 128));
	script.set(c.log(EXT, "2ad7a8f"), err("fatal: bad revision '2ad7a8f'", 128));
	script.set(c.log(W, "2ad7a8f"), ok('2026-10-28\tCURRENT_TASK.md: v0.0.28 shipped\n\n CURRENT_TASK.md | 6 ++++--\n 1 file changed, 4 insertions(+), 2 deletions(-)'));
	const r = await runPrechecks(facts, discovery, scripted(script), clock);
	assert.ok(r.block.includes("Git repos checked:\n- " + W));
	assert.ok(!r.block.includes(EXT) && !r.block.includes(DEV));

	// no commit claims → no header, even with valid repos around
	const r2 = await runPrechecks([fact("file", "CURRENT_TASK.md")], discovery, scripted(new Map([
		[c.status(W), ok("")],
		[c.status(EXT), ok("")],
		[c.status(DEV), ok("")],
		[c.ls(W + "/CURRENT_TASK.md"), ok("CURRENT_TASK.md")],
	])), clock);
	assert.ok(!r2.block.includes("Git repos checked:"));
	assert.ok(r2.block.includes("- file CURRENT_TASK.md exists at " + W + "/CURRENT_TASK.md"));
});

/* ── file checks ─────────────────────────────────────────────────────────── */

test("files: not-found wording, multiple matches listed without extract", async () => {
	const facts = [fact("file", "tmp/scratch/foo.log"), fact("file", "src/x.ts")];
	const script = new Map<string, RunResult>();
	script.set(c.status(W), ok(""));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	script.set(c.probe([W + "/tmp/scratch/foo.log", DEV + "/tmp/scratch/foo.log", EXT + "/tmp/scratch/foo.log"]), ok(""));
	// src/x.ts hits in TWO roots (the file index has EXT/src/x.ts; the claim is relative →
	// the index wins only on an exact abs match, so this exercises the probe path)
	script.set(c.probe([W + "/src/x.ts", DEV + "/src/x.ts", EXT + "/src/x.ts"]), ok("HIT /workspace/src/x.ts\nHIT /workspace/pi-agent/extensions/pi-self-aware-memory/src/x.ts"));

	const r = await runPrechecks(facts, discovery, scripted(script), clock);
	assert.ok(r.block.includes("- file tmp/scratch/foo.log could not cheaply be found — checked: workspace root, known git repos"));
	assert.ok(r.block.includes("- file src/x.ts exists at /workspace/src/x.ts and /workspace/pi-agent/extensions/pi-self-aware-memory/src/x.ts"));
	// both roots attributed in the positives
	const x = r.positives.filesFound.find((f) => f.claim === "src/x.ts");
	assert.ok(x && x.paths.length === 2);
	assert.ok(r.positives.reposUsed.includes(W) && r.positives.reposUsed.includes(EXT));
});

/* ── file:line windows and file:range sizes ──────────────────────────────── */

test("file-line: ±5 verbatim window in a fence; oversize → byte warning; ambiguous → no window", async () => {
	const lineFact = (value: string) => fact("file-line", value);
	const body = "line11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20\nline21";
	const big = Array.from({ length: 60 }, (_, i) => "x".repeat(60) + " line" + i).join("\n");

	const script = new Map<string, RunResult>();
	script.set(c.status(W), ok(""));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	script.set(c.ls(EXT + "/src/x.ts"), ok("src/x.ts"));
	script.set(c.sed("11,21", EXT + "/src/x.ts"), ok(body));
	const r = await runPrechecks([lineFact(EXT + "/src/x.ts:16")], { ...discovery, files: [{ absPath: EXT + "/src/x.ts", lastTool: "edit", lastEntryIndex: 1 }] }, scripted(script), clock);
	const expectedWindow = [
		"- file /workspace/pi-agent/extensions/pi-self-aware-memory/src/x.ts:16",
		"```",
		...body.split("\n"),
		"```",
	].join("\n");
	assert.ok(r.block.includes(expectedWindow), "verbatim fenced window");

	// oversize window → the byte warning instead of content
	const script2 = new Map<string, RunResult>();
	script2.set(c.status(W), ok(""));
	script2.set(c.status(EXT), ok(""));
	script2.set(c.status(DEV), ok(""));
	script2.set(c.ls(EXT + "/src/x.ts"), ok("src/x.ts"));
	script2.set(c.sed("1,11", EXT + "/src/x.ts"), ok(big));
	const r2 = await runPrechecks([lineFact(EXT + "/src/x.ts:6")], { ...discovery, files: [{ absPath: EXT + "/src/x.ts", lastTool: "edit", lastEntryIndex: 1 }] }, scripted(script2), clock);
	const bytes = Buffer.byteLength(big, "utf8");
	assert.ok(r2.block.includes(`- file /workspace/pi-agent/extensions/pi-self-aware-memory/src/x.ts:6 — surrounding lines 1-11 contain ${bytes} bytes`));
	assert.ok(!r2.block.includes("```"));

	// ambiguous (two hits) → no window
	const script3 = new Map<string, RunResult>();
	script3.set(c.status(W), ok(""));
	script3.set(c.status(EXT), ok(""));
	script3.set(c.status(DEV), ok(""));
	script3.set(c.probe([W + "/src/x.ts", DEV + "/src/x.ts", EXT + "/src/x.ts"]), ok("HIT /workspace/src/x.ts\nHIT /workspace/pi-agent/extensions/pi-self-aware-memory/src/x.ts"));
	const r3 = await runPrechecks([lineFact("src/x.ts:16")], discovery, scripted(script3), clock);
	assert.ok(r3.block.includes("- file src/x.ts:16 — no cheap result (ambiguous: /workspace/src/x.ts, /workspace/pi-agent/extensions/pi-self-aware-memory/src/x.ts)"));
});

test("file-range: size-only line (no content)", async () => {
	const script = new Map<string, RunResult>();
	script.set(c.status(W), ok(""));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	script.set(c.ls(EXT + "/src/x.ts"), ok("src/x.ts"));
	script.set(`sed -n '10,20p' ${q(EXT + "/src/x.ts")} | wc -c 2>&1; printf '\\nEXIT:%s\\n' "$?"`, ok("7361"));
	const r = await runPrechecks([fact("file-range", EXT + "/src/x.ts:10-20")], { ...discovery, files: [{ absPath: EXT + "/src/x.ts", lastTool: "edit", lastEntryIndex: 1 }] }, scripted(script), clock);
	assert.ok(r.block.includes("- file /workspace/pi-agent/extensions/pi-self-aware-memory/src/x.ts:10-20 — contains 7361 bytes"));
	assert.ok(!r.block.includes("```"));
});

/* ── validity pre-filter + circuit breaker ───────────────────────────────── */

test("validity: non-repo candidates are discarded; hard errors are counted and stop the commit walk", async () => {
	const facts = [fact("commit", "a1b2c3d")];
	const script = new Map<string, RunResult>();
	// DEV fails validity (not a git repo), EXT is valid, W has a HARD error
	script.set(c.status(W), toolErr("permission denied"));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), err("fatal: not a git repository (or any of the parent directories): .git", 128));
	script.set(c.log(EXT, "a1b2c3d"), err("fatal: bad revision 'a1b2c3d'", 128));
	const r = await runPrechecks(facts, discovery, scripted(script), clock);
	// W's hard error counted; the commit walk tried only the VALID repos —
	// DEV was discarded by the validity filter (its status negative is EXPECTED,
	// not a hard error), W was never valid (hard error)
	assert.equal(r.hardErrors, 1);
	assert.ok(r.block.includes("- commit a1b2c3d not found in the named repos"));
	// reduced-noise: a miss ⇒ all VALID repos listed (EXT only)
	// — whole-line checks: `- ${W}` / `- ${DEV}` are substrings of the EXT line
	const blockLines = r.block.split("\n");
	assert.ok(blockLines.includes(`- ${EXT}`));
	assert.ok(!blockLines.includes(`- ${W}`) && !blockLines.includes(`- ${DEV}`));
	assert.deepEqual(r.positives.commitsFound, []);
});

test("circuit breaker: a runner-level failure on a file check is a hard error (and the check degrades, no throw)", async () => {
	const facts = [fact("file", "src/x.ts")];
	const script = new Map<string, RunResult>();
	script.set(c.status(W), ok(""));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	script.set(c.probe([W + "/src/x.ts", DEV + "/src/x.ts", EXT + "/src/x.ts"]), toolErr("blocked by hook"));
	const r = await runPrechecks(facts, discovery, scripted(script), clock);
	assert.equal(r.hardErrors, 1);
	assert.ok(r.block.includes("- file src/x.ts could not cheaply be found — checked: workspace root, known git repos"));
});

/* ── clock fallback + flat-line types ────────────────────────────────────── */

test("clock: not injected → the two date commands are run and both formats rendered", async () => {
	const script = new Map<string, RunResult>();
	script.set(c.date, ok("Thu Jan 1 00:00:00 UTC 2026\n2026-01-01 00:00:00"));
	script.set(c.status(W), ok(""));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	const r = await runPrechecks([], discovery, scripted(script));
	assert.ok(r.block.startsWith("Clock: Thu Jan 1 00:00:00 UTC 2026 · 2026-01-01 00:00:00"));
});

test("remaining claim types: one flat self-explanatory line each, date consistency only when a commit date matches", async () => {
	const facts = [
		fact("gate", "GATE: PASS"),
		fact("exit-code", "0"),
		fact("size", "10.3 KB"),
		fact("sam-id", "67d628bd2a7a"),
		fact("session-id", "01a12345"),
		fact("unit-ref", "u8"),
		fact("line-approx", "~1200"),
		fact("bare-line", ":1135"),
		fact("date", "2026-11-18"),
	];
	const script = new Map<string, RunResult>();
	script.set(c.status(W), ok(""));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	const r = await runPrechecks(facts, discovery, scripted(script), clock);
	const lines = r.block.split("\n");
	assert.ok(lines.includes("- gate GATE: PASS — no cheap result (no named log)"));
	assert.ok(lines.includes("- exit-code 0 — no cheap result (no cheaply reproducible run)"));
	assert.ok(lines.includes("- size 10.3 KB — no cheap result (no file association in the stub)"));
	assert.ok(lines.includes("- sam-id 67d628bd2a7a — no cheap result (SAM ledger — sam_retrieve, not shell)"));
	assert.ok(lines.includes("- session-id 01a12345 — no cheap result (pi session file, not a repo)"));
	assert.ok(lines.includes("- unit-ref u8 — no cheap result (SAM ledger, not shell)"));
	assert.ok(lines.includes("- line-approx ~1200 — no cheap result (approximate ref — window, not exact)"));
	assert.ok(lines.includes("- bare-line :1135 — no cheap result (implicit file ref — resolver needed)"));
	// no commit found → the date line takes the plain wording
	assert.ok(lines.includes("- date 2026-11-18 — no cheap result (not independently checked)"));
	// no commit claims → no repos header
	assert.ok(!lines.includes("Git repos checked:"));
});

// 2026-11-19 (leading-slash fix): an absolute claim is tested as the literal
// path first; on a miss it falls back to the de-slashified relative reading.
// One entry per claim either way (absolute wins when both could hit).
test("files: absolute claims — literal path first, relative fallback, one entry per claim", async () => {
	const facts = [
		fact("file", W + "/src/precheck-run.ts"), // absolute: the literal path hits
		fact("file", "/pi-agent/README.md"), // absolute miss → the de-slashified relative hits at the root
		fact("file", "/definitely/missing.ts"), // both miss → one no-result line
	];
	const script = new Map<string, RunResult>();
	script.set(c.status(W), ok(""));
	script.set(c.status(EXT), ok(""));
	script.set(c.status(DEV), ok(""));
	// 1) absolute hit: the literal ls answers
	script.set(c.ls(W + "/src/precheck-run.ts"), ok("precheck-run.ts"));
	// 2) absolute miss (ls: expected negative), then the root probe hits once
	script.set(c.ls("/pi-agent/README.md"), err("ls: cannot access '/pi-agent/README.md': No such file or directory", 2));
	script.set(c.probe([W + "/pi-agent/README.md", DEV + "/pi-agent/README.md", EXT + "/pi-agent/README.md"]), ok("HIT /workspace/pi-agent/README.md"));
	// 3) absolute miss, probe misses everywhere (all-miss exits 0 by design)
	script.set(c.ls("/definitely/missing.ts"), err("ls: cannot access '/definitely/missing.ts': No such file or directory", 2));
	script.set(c.probe([W + "/definitely/missing.ts", DEV + "/definitely/missing.ts", EXT + "/definitely/missing.ts"]), ok(""));

	const r = await runPrechecks(facts, discovery, scripted(script), clock);
	// one entry per claim, the claim shown as written, the hit resolved
	assert.ok(r.block.includes(`- file ${W}/src/precheck-run.ts exists at ${W}/src/precheck-run.ts`));
	assert.ok(r.block.includes("- file /pi-agent/README.md exists at " + W + "/pi-agent/README.md"));
	assert.ok(r.block.includes("- file /definitely/missing.ts could not cheaply be found — checked: workspace root, known git repos"));
	// positives carry only actual hits
	assert.deepEqual(r.positives.filesFound, [
		{ claim: W + "/src/precheck-run.ts", paths: [W + "/src/precheck-run.ts"] },
		{ claim: "/pi-agent/README.md", paths: [W + "/pi-agent/README.md"] },
	]);
	// the ls negatives are expected, not hard errors (the breaker must not trip)
	assert.equal(r.hardErrors, 0);
});

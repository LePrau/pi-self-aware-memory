/**
 * Stub pre-check — the close-time orchestration (src/precheck-run.ts).
 *
 * Pins the seams around the tested pipeline: the `prechecks` dial reader
 * (onoff, default ON — house semantics: only "off" is special), the
 * in-memory circuit-breaker state (sticky trip with reason, test seam),
 * the PlainEntry→RawEntry adapter (message/compaction carry signal, the
 * rest pass through inert), and the full parse→discover→execute run against
 * a scripted runner (the executor's own suite pins the display spec byte for
 * byte; here the wiring is asserted structurally + by key lines).
 *
 * Run: node --test test/precheck-run.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	prechecksEnabled,
	precheckBreakerDisabled,
	precheckBreakerReason,
	tripPrecheckBreaker,
	_resetPrecheckBreakerForTests,
	plainToRawEntries,
	runClosePrechecks,
} from "../src/precheck-run.ts";
import type { Runner, RunResult } from "../src/precheck-executor.ts";
import type { PlainEntry } from "../src/projection.ts";

/* ── fixtures ───────────────────────────────────────────────────────────── */

const W = "/workspace";
const REPO = "/workspace/somerepo";

const clockLines = "Wed Nov 18 17:26:29 UTC 2026\n2026-11-18 17:26:29";

/** The executor's exact command strings (mirroring withExit + q() quoting —
 *  the same mirror test/precheck-executor.test.ts uses). */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const c = {
	date: `date -u; date -u '+%Y-%m-%d %H:%M:%S' 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
	status: (dir: string) => `git -C ${q(dir)} status --porcelain 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
	log: (dir: string, h: string) => `git -C ${q(dir)} log -1 --stat --format='%ad%x09%s' --date=short ${q(h)} 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
	probe: (candidates: string[]) =>
		candidates.map((p) => `[ -f ${q(p)} ] && printf 'HIT %s\\n' ${q(p)}`).join(" ; ") + ` ; true 2>&1; printf '\\nEXIT:%s\\n' "$?"`,
};

const ok = (body: string): RunResult => ({ stdout: body + "\nEXIT:0\n", isError: false });
const err = (body: string, code: number): RunResult => ({ stdout: body + `\nEXIT:${code}\n`, isError: false });
const toolErr = (msg: string): RunResult => ({ stdout: msg, isError: true });

function scripted(script: Map<string, RunResult>): Runner {
	return async (command) => {
		const hit = script.get(command);
		if (!hit) throw new Error("UNSCRIPTED COMMAND: " + command);
		return hit;
	};
}

const bash = (command: string): PlainEntry => ({
	id: `e${bash.seq = (bash.seq ?? 0) + 1}`,
	kind: "message",
	message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
});
const write = (path: string): PlainEntry => ({
	id: `e${write.seq = (write.seq ?? 0) + 1}`,
	kind: "message",
	message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path } }] },
});

/* ── the dial ───────────────────────────────────────────────────────────── */

test("prechecksEnabled: default ON; only explicit off disables (house onoff semantics)", () => {
	assert.equal(prechecksEnabled({}), true);
	assert.equal(prechecksEnabled({ SAM_PRECHECKS: "on" }), true);
	assert.equal(prechecksEnabled({ SAM_PRECHECKS: "off" }), false);
	assert.equal(prechecksEnabled({ SAM_PRECHECKS: "garbage" }), true);
});

/* ── the circuit breaker ────────────────────────────────────────────────── */

test("breaker: fresh state enabled; the trip is sticky with a reason; the seam resets", () => {
	_resetPrecheckBreakerForTests();
	assert.equal(precheckBreakerDisabled(), false);
	assert.equal(precheckBreakerReason(), "");
	tripPrecheckBreaker("all 3 pre-check bash calls hard-errored");
	assert.equal(precheckBreakerDisabled(), true);
	assert.equal(precheckBreakerReason(), "all 3 pre-check bash calls hard-errored");
	_resetPrecheckBreakerForTests();
	assert.equal(precheckBreakerDisabled(), false);
	assert.equal(precheckBreakerReason(), "");
});

/* ── the PlainEntry → RawEntry adapter ──────────────────────────────────── */

test("plainToRawEntries: message/compaction carry signal, the rest pass through inert", () => {
	const toolCallBlock = { type: "toolCall", name: "bash", arguments: { command: "cd /w && git status" } };
	const entries: PlainEntry[] = [
		{ id: "e1", kind: "message", message: { role: "assistant", content: [toolCallBlock] } },
		{ id: "e2", kind: "compaction", summary: "old", firstKeptEntryId: "e1" },
		{ id: "e3", kind: "custom", customType: "sam" },
	];
	const raw = plainToRawEntries(entries);
	assert.deepEqual(raw[0], { id: "e1", type: "message", message: { role: "assistant", content: [toolCallBlock] } });
	assert.deepEqual(raw[1], { id: "e2", type: "compaction", summary: "old" });
	assert.deepEqual(raw[2], { id: "e3", type: "custom" });
});

/* ── the pipeline: parse → discover → execute ───────────────────────────── */

test("runClosePrechecks: one commit found in the discovered repo, one relative file via the probe, no hard errors", async () => {
	_resetPrecheckBreakerForTests();
	const entries: PlainEntry[] = [
		bash(`cd ${REPO} && git log -1`),
		write(`${REPO}/src/a.ts`),
	];
	const script = new Map<string, RunResult>([
		[c.date, ok(clockLines)],
		[c.status(REPO), ok("")],
		[c.status(W), err("fatal: not a git repository\n", 128)],
		[c.log(REPO, "a1b2c3d"), ok("2026-11-18\tlanded\n src/a.ts | 1 +")],
		[c.probe([`${W}/src/a.ts`, `${REPO}/src/a.ts`]), ok(`HIT ${REPO}/src/a.ts`)],
	]);
	const result = await runClosePrechecks({
		stub: "Commit a1b2c3d landed in the repo and file src/a.ts was written.",
		entries,
		runner: scripted(script),
		cwd: W,
	});
	// the run: 2 validity statuses + 1 clock + 1 commit log + 1 file probe
	assert.equal(result.commands, 5);
	assert.equal(result.hardErrors, 0);
	// positives (the summary-carry data — hits only, first-hit order)
	assert.deepEqual(result.positives.reposUsed, [REPO]);
	assert.deepEqual(result.positives.commitsFound, [{ hash: "a1b2c3d", repo: REPO }]);
	assert.deepEqual(result.positives.filesFound, [{ claim: "src/a.ts", paths: [`${REPO}/src/a.ts`] }]);
	// the block carries the settled display lines (byte spec pinned by the
	// executor suite — the key lines here)
	assert.ok(result.block.includes("a1b2c3d"));
	assert.ok(result.block.includes("Git repos checked:"));
	assert.ok(result.block.includes(`- file src/a.ts exists at ${REPO}/src/a.ts`));
});

test("runClosePrechecks: an all-hard-error run tallies hardErrors === commands (the breaker-trip condition)", async () => {
	_resetPrecheckBreakerForTests();
	const entries: PlainEntry[] = [bash(`cd ${REPO} && git log -1`)];
	const runner: Runner = async () => toolErr("blocked: permission denied");
	const result = await runClosePrechecks({
		stub: "Commit a1b2c3d landed.",
		entries,
		runner,
		cwd: W,
	});
	assert.ok(result.commands > 0);
	assert.equal(result.hardErrors, result.commands);
	assert.equal(result.positives.reposUsed.length, 0);
	assert.equal(result.positives.commitsFound.length, 0);
});

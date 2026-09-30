/**
 * P3 tests: cache-ledger.ts — the slim host-cache-ledger port (port list
 * item 2): observation-only bookkeeping, rebuild-cause classification
 * (continuity / idle-expiry / foreign), the foreign-streak warn, and the
 * commit-timing mark rides on REPORTED usage only (never inferred from
 * timing — plan §3.5).
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	FOREIGN_REBUILD_WARN_COUNT,
	REBUILD_MIN_TOKENS,
	createHostCacheLedger,
} from "../src/cache-ledger.ts";
import type { PlainUsage } from "../src/projection.ts";

const T0 = 1_700_000_000_000;
const usage = (input: number, cacheRead: number, cacheWrite: number): PlainUsage =>
	({ input, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite }) as PlainUsage;

test("observation: only reported usage is booked; aborted requests (no usage) are skipped", () => {
	const ledger = createHostCacheLedger();
	assert.equal(ledger.observe(undefined, T0), null);
	assert.equal(ledger.observe(null as never, T0), null);
	const e = ledger.observe(usage(0, 0, 0), T0);
	assert.equal(e, null, "a zero-prompt usage reports nothing");
	const ok = ledger.observe(usage(1000, 9000, 0), T0 + 1000);
	assert.ok(ok);
	assert.equal(ok.prompt, 10000);
	assert.equal(ok.uncached, 1000);
	assert.equal(ledger.summary().requests, 1);
});

test("rebuild classification: continuity — a SAM commit in the interval attributes the rebuild to us", () => {
	const ledger = createHostCacheLedger({ rebuildMinTokens: 1000 });
	ledger.observe(usage(10000, 0, 0), T0); // cold start
	ledger.noteCommit("fold", T0 + 1000);
	const entry = ledger.observe(usage(12000, 0, 0), T0 + 2000);
	assert.equal(entry?.rebuild, true);
	assert.equal(entry?.cause, "continuity");
	assert.equal(entry?.commit, "fold", "the fold's own rebuild cost — batched commits share one of these");
	assert.deepEqual(ledger.summary().rebuilds, { continuity: 1, "idle-expiry": 0, foreign: 0 });
});

test("rebuild classification: idle-expiry — gap beyond the lifetime without a commit", () => {
	const ledger = createHostCacheLedger({ rebuildMinTokens: 1000, lifetimeMs: 1000 });
	ledger.observe(usage(10000, 0, 0), T0);
	const entry = ledger.observe(usage(12000, 0, 0), T0 + 5000, undefined);
	assert.equal(entry?.rebuild, true);
	assert.equal(entry?.cause, "idle-expiry", "gap 5000 > lifetime 1000 and no SAM commit");
});

test("rebuild classification: foreign — a rebuild with no commit and a short gap is someone/something else", () => {
	const ledger = createHostCacheLedger({ rebuildMinTokens: 1000, lifetimeMs: 60000 });
	ledger.observe(usage(10000, 0, 0), T0);
	const entry = ledger.observe(usage(12000, 0, 0), T0 + 1000);
	assert.equal(entry?.rebuild, true);
	assert.equal(entry?.cause, "foreign");
});

test("foreign streak: the warn lands exactly on the FOREIGN_REBUILD_WARN_COUNT-th foreign rebuild", () => {
	assert.equal(FOREIGN_REBUILD_WARN_COUNT, 3, "their count, ported (warn-worthy pattern)");
	const ledger = createHostCacheLedger({ rebuildMinTokens: 1000, lifetimeMs: 60000 });
	ledger.observe(usage(10000, 0, 0), T0);
	const r1 = ledger.observe(usage(12000, 0, 0), T0 + 1000);
	const r2 = ledger.observe(usage(12000, 0, 0), T0 + 2000);
	const r3 = ledger.observe(usage(12000, 0, 0), T0 + 3000);
	assert.equal(r1?.warn, undefined);
	assert.equal(r2?.warn, undefined);
	assert.equal(r3?.warn, true, "warning on the 3rd foreign rebuild");
	assert.equal(ledger.summary().foreignStreak, 3);
	// a non-foreign rebuild resets the streak
	ledger.observe(usage(500, 15000, 0), T0 + 4000);
	ledger.noteCommit("undo", T0 + 4500);
	ledger.observe(usage(12000, 0, 0), T0 + 5000); // continuity
	const r4 = ledger.observe(usage(12000, 0, 0), T0 + 6000);
	assert.equal(r4?.cause, "foreign");
	assert.equal(r4?.warn, undefined, "streak restarted (2 of 3)");
});

test("commitTiming: unknown before two observations; cold when a recent rebuild already happened; warm when the prefix is still hot", () => {
	const ledger = createHostCacheLedger({ rebuildMinTokens: 1000, lifetimeMs: 10000 });
	assert.equal(ledger.commitTiming(T0 + 100), "unknown", "before the second observed request");
	ledger.observe(usage(10000, 0, 0), T0);
	assert.equal(ledger.commitTiming(T0 + 100), "unknown", "still before two");
	// a rebuild happened just before our commit → we ride it (cold)
	ledger.observe(usage(12000, 0, 0), T0 + 5000);
	assert.equal(ledger.commitTiming(T0 + 5500), "cold");
	// prefix hot (cacheRead) and no recent rebuild → we pay the next rebuild (warm)
	const warm = createHostCacheLedger({ rebuildMinTokens: 10_000_000, lifetimeMs: 10000 });
	warm.observe(usage(500, 15000, 0), T0);
	warm.observe(usage(500, 15000, 0), T0 + 5000);
	assert.equal(warm.commitTiming(T0 + 5200), "warm");
});

test("reset: a new session forgets", () => {
	const ledger = createHostCacheLedger();
	ledger.observe(usage(1000, 20000, 0), T0);
	ledger.reset();
	assert.equal(ledger.summary().requests, 0);
	assert.equal(ledger.commitTiming(T0 + 100), "unknown");
});

test("constants: REBUILD_MIN_TOKENS ported (16384) — the ledger is rebuilt from REPORTED usage only", () => {
	assert.equal(REBUILD_MIN_TOKENS, 16384, "their ported constant (Anthropic-scale, labelled; P4 tunes)");
});

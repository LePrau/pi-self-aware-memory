/**
 * Unit tests: the API-scale correction (v0.0.34) — the 2026-11-13 bar bug.
 *
 * Measured root cause (session 2026-11-10T09-01-33…jsonl, pi v1.5.0 mirror
 * f9a263655): pi's getContextUsage() is API-hybrid (T = the last assistant's
 * usage.totalTokens + chars/4 trailing — packages/coding-agent/src/core/
 * compaction/compaction.ts: estimateProjectedContextTokens / calculateContextTokens),
 * while SAM's sysPrompt/summary/audited fields are pure chars/4. Subtracting
 * unscaled estimates from the API-based T dumped the whole API premium
 * (~1.18–1.30× for tool-heavy content) into the derived remainder — after
 * every close_unit at context ≥ ~30k the bar rendered 3–7 extra grey/yellow
 * cells right after the last dot (measured per close: u106 5.5, u107 6.9,
 * u108 7.1, u110 3.1, u114 5.2 remainder cells where the true post-close
 * remainder was ≤ 1).
 *
 * The fix: at each refresh (close / retire / fold / goal / install) scale
 * the chars/4 fields by the measured ratio T / fullContextEstimate (scaleSamStatusLine)
 * — T and the estimate describe the same content snapshot then — and keep
 * the scaled fields stable as T grows between refreshes (new context is
 * remainder, never re-attribution). The unknown→known transition (first T
 * after a fold, scaleApplied still 1) scales from scratch exactly once.
 *
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	apiScale,
	scaleSamStatusLine,
	samTuiSegments,
	type SamTuiSegmentsInput,
} from "../src/statusbar.ts";

/** The measured u108 close state (2026-11-13T21:11:20Z, this session's file):
 *  T = 113,386 (API total), fullEst = 89,993 (sys 5,168 + summary 4,941 +
 *  projected raw 79,884), W/R/keep = 131,072 / 16,384 / 20,000. */
const u108: SamTuiSegmentsInput = {
	tokens: 113_386,
	window: 131_072,
	reserve: 16_384,
	keepRecent: 20_000,
	sysPromptTokens: 5_168,
	goalTokens: 0,
	summaryTokens: 4_941,
	auditedTokens: 79_884,
	fullContextEstimate: 89_993,
	auditDepth: "medium",
};

function run(input: SamTuiSegmentsInput): { prompt: number; audited: number; outside: number; retention: number } {
	const bar = samTuiSegments(input);
	const count = (kind: string) => bar.segments.filter((s) => s.kind === kind).reduce((a, s) => a + s.text.length, 0);
	return {
		prompt: count("prompt"),
		audited: count("audited"),
		outside: count("outside"),
		retention: count("retention"),
	};
}

/** What SamTuiStatus.statusLine() renders from a barCache entry: the cached
 *  fields verbatim (already scaled at refresh) + the live in-flight tail. */
function renderFromCache(cache: { tokens: number | null; sysPromptTokens: number; goalTokens: number; summaryTokens: number; auditedTokens: number }): ReturnType<typeof run> {
	return run({
		tokens: cache.tokens,
		window: 131_072,
		reserve: 16_384,
		keepRecent: 20_000,
		sysPromptTokens: cache.sysPromptTokens,
		goalTokens: cache.goalTokens,
		summaryTokens: cache.summaryTokens,
		auditedTokens: cache.auditedTokens,
		auditDepth: "medium",
	});
}

test("apiScale: the measured ratio (u108: 113,386 / 89,993 ≈ 1.26)", () => {
	assert.ok(Math.abs(apiScale(u108) - 113_386 / 89_993) < 1e-9);
});

test("apiScale: no scaling when tokens is null (unknown state) or the estimate is degenerate", () => {
	assert.equal(apiScale({ tokens: null, fullContextEstimate: 89_993 }), 1);
	assert.equal(apiScale({ tokens: 10_000, fullContextEstimate: 100 }), 1);
	assert.equal(apiScale({ tokens: 10_000 }), 1);
});

test("scaleSamStatusLine: scales the fields, consumes fullContextEstimate, records the factor", () => {
	const scaled = scaleSamStatusLine(u108);
	const s = 113_386 / 89_993;
	assert.ok(Math.abs(scaled.sysPromptTokens - 5_168 * s) < 1e-9);
	assert.ok(Math.abs(scaled.summaryTokens - 4_941 * s) < 1e-9);
	assert.ok(Math.abs(scaled.auditedTokens - 79_884 * s) < 1e-9);
	assert.equal(scaled.fullContextEstimate, undefined);
	assert.equal(scaled.scaleApplied, s);
	// Unknown state: nothing scaled, factor 1, the estimate is KEPT (the
	// unknown→known transition may still scale from scratch).
	const unknown = scaleSamStatusLine({ ...u108, tokens: null });
	assert.equal(unknown.scaleApplied, 1);
	assert.equal(unknown.fullContextEstimate, 89_993);
	assert.equal(unknown.auditedTokens, 79_884);
});

test("close state, refresh-scale: no fake remainder (was 7 grey cells pre-fix)", () => {
	// Pre-fix (no fullContextEstimate): x = T − O − A = 23,393 → 7 remainder
	// cells (1 ▒ + 6 ░). Post-fix: refresh-scale lifts O and A to the API
	// scale, x ≈ 0 (the true post-close remainder at refresh — the verdict
	// has not landed yet) → at most one remainder cell.
	const cached = scaleSamStatusLine(u108);
	const rendered = renderFromCache({
		tokens: cached.tokens,
		sysPromptTokens: cached.sysPromptTokens,
		goalTokens: cached.goalTokens,
		summaryTokens: cached.summaryTokens,
		auditedTokens: cached.auditedTokens,
	});
	assert.equal(rendered.audited, 31, JSON.stringify(rendered)); // 79,884 × 1.26 → 30.75 cells
	assert.equal(rendered.prompt, 4, JSON.stringify(rendered)); // (5,168 + 4,941) × 1.26 → 3.89 cells
	assert.ok(rendered.outside + rendered.retention <= 1, JSON.stringify(rendered)); // ≤1, not 7
	// No outside (yellow): A_abs already exceeds T − keep (the closed span
	// overrules the retention window — Paul's spec).
	assert.equal(rendered.outside, 0, JSON.stringify(rendered));
});

test("bumpAnchor known→known: the scaled fields stay fixed, new content is remainder", () => {
	// The close_unit verdict + the next turn (~5k API tokens) land in the next
	// assistant's usage. bumpAnchor updates ONLY tokens (the cache ruling) —
	// the remainder must grow by that delta, not be re-attributed to O/A.
	// x = 5,000 → rem = round(5,000×40/131,072) = 2 cells; the first sits at
	// index 35 = the threshold position (o+dot = 35), so D6's | REPLACES it —
	// 1 retention cell is visible.
	const cached = scaleSamStatusLine(u108);
	const after = renderFromCache({
		tokens: 118_386, // +5,000 API tokens since the close refresh
		sysPromptTokens: cached.sysPromptTokens,
		goalTokens: cached.goalTokens,
		summaryTokens: cached.summaryTokens,
		auditedTokens: cached.auditedTokens,
	});
	assert.equal(after.audited, 31, JSON.stringify(after)); // dots do not move
	assert.equal(after.retention, 1, JSON.stringify(after)); // 2 computed, 1 under the |
	assert.equal(after.outside, 0, JSON.stringify(after)); // still inside the retention window
});

test("bumpAnchor unknown→known: scale from scratch exactly once, no double scale", () => {
	// After a fold, refresh() ran with T null (scaleApplied 1, fields still
	// chars/4, fullContextEstimate kept). The first T arrives via bumpAnchor:
	// SamTuiStatus scales from scratch (the first post-fold assistant's T
	// describes the fold snapshot + whatever landed between — accepted:
	// remainder re-anchors at that first T; a later refresh re-syncs exactly).
	// The transition must scale exactly once: the result equals scaling the
	// RAW fields with the fresh T — and a second scaleSamStatusLine must be a
	// no-op (fullContextEstimate was consumed).
	const atFold = scaleSamStatusLine({ ...u108, tokens: null });
	const bumped = scaleSamStatusLine({ ...atFold, tokens: 113_386 }); // the transition branch
	const s = 113_386 / 89_993;
	assert.ok(Math.abs(bumped.sysPromptTokens - 5_168 * s) < 1e-9);
	assert.ok(Math.abs(bumped.auditedTokens - 79_884 * s) < 1e-9);
	assert.equal(bumped.scaleApplied, s);
	assert.equal(bumped.fullContextEstimate, undefined); // consumed — no double scale
	const again = scaleSamStatusLine(bumped); // idempotence: T now equals the scaled sum
	assert.equal(again.scaleApplied, 1);
	assert.ok(Math.abs(again.auditedTokens - bumped.auditedTokens) < 1e-9);
	const rendered = renderFromCache({
		tokens: bumped.tokens,
		sysPromptTokens: bumped.sysPromptTokens,
		goalTokens: bumped.goalTokens,
		summaryTokens: bumped.summaryTokens,
		auditedTokens: bumped.auditedTokens,
	});
	assert.equal(rendered.audited, 31, JSON.stringify(rendered));
	assert.ok(rendered.outside + rendered.retention <= 1, JSON.stringify(rendered));
	assert.equal(rendered.outside, 0, JSON.stringify(rendered));
});

test("pre-fix behaviour is unchanged without fullContextEstimate (backward compat)", () => {
	const runs = run({ ...u108, fullContextEstimate: undefined });
	// The old, buggy geometry: 24 dots + 1 outside + 6 retention = 7 remainder cells.
	assert.equal(runs.audited, 24, JSON.stringify(runs));
	assert.equal(runs.outside + runs.retention, 7, JSON.stringify(runs));
});

test("genuinely unsummarized content still renders as remainder (fix-up sanity)", () => {
	// No close at all: audited 0, a big open span → the remainder is real and
	// must still render. T − keep = 93,386 > A_abs (≈ scaled O) → part of it
	// is OUTSIDE the retention window (yellow ▒), the rest grey ░.
	const open = scaleSamStatusLine({
		...u108,
		auditedTokens: 0,
		fullContextEstimate: 113_000, // ≈ T → scale ≈ 1 (honest ratio)
	});
	const rendered = renderFromCache({
		tokens: open.tokens,
		sysPromptTokens: open.sysPromptTokens,
		goalTokens: open.goalTokens,
		summaryTokens: open.summaryTokens,
		auditedTokens: open.auditedTokens,
	});
	assert.ok(rendered.outside + rendered.retention > 0, JSON.stringify(rendered));
	assert.ok(rendered.outside > 0, JSON.stringify(rendered)); // the outside split still works
});

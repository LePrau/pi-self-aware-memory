/**
 * Unit tests: the SAM TUI status line (v0.0.19, Paul 2026-10-23) — a live
 * colored context bar BELOW pi's native context bar, a footer
 * extension-status entry (`ctx.ui.setStatus("sam", …)`), prefixed
 * "Context ".
 *
 * Plan + decisions:
 *   2026-10-23-sam-status-below-native-bar.md
 *   (built on 2026-10-19-sam-tui-status-line.md,
 *             2026-10-19-sam-tui-inflight-estimate.md)
 *
 * Pins: the dial; the install gates (dial + mode + ui surface); the exact
 * ANSI line (256-color SGR runs, NBSP fills, plain prefix); the
 * red/yellow crossed split (Paul's 2026-10-19 ruling 2); the unknown state
 * (ruling 3); the fix-up 2 in-flight tracker (deltas / cumulative tool
 * partials / bumpAnchor); refresh/shutdown semantics. Truncation of the
 * shared status line is pi's footer's job (ANSI-aware truncateToWidth —
 * measured), so there is no self-truncation pin here.
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SAM_STATUS_KEY, SAM_STATUS_PREFIX, SamTuiStatus, samStatusLineEnabled, type SamTuiStatusDeps } from "../src/tui-status.ts";
import type { SamStatusLineInput } from "../src/statusbar.ts";
import { resetSamSettingsForTest, setInSession } from "../src/settings.ts"; // v0.0.21: the in-session dial layer

/** The 256-color SGR (the module's exact emission format). */
const S = (n: number, t: string): string => `\x1b[38;5;${n}m${t}\x1b[39m`;
/** The NBSP fill run (survives the footer's ASCII-space collapse). */
const N = (n: number): string => "\u00a0".repeat(n);

/** A ctx the status line only touches for mode + ui (the deps carry the
 *  data). */
function fakeCtx(mode: "tui" | "rpc" = "tui"): { ctx: any; calls: Array<{ key: string; text: string | undefined }> } {
	const calls: Array<{ key: string; text: string | undefined }> = [];
	const ctx: any = {
		mode,
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				calls.push({ key, text });
			},
		},
	};
	return { ctx, calls };
}

/** A mutable bar — the tracker / bumpAnchor pins mutate it between
 *  emissions. */
function makeBar(over: Partial<SamStatusLineInput> = {}): SamStatusLineInput {
	return {
		tokens: 10_000,
		window: 20_000,
		reserve: 2_000,
		sysPromptTokens: 2_000,
		goalTokens: 250,
		summaryTokens: 0,
		auditedTokens: 3_000,
		auditDepth: "medium",
		...over,
	};
}

function depsFor(bar: SamStatusLineInput, keepRecent = 5_000): SamTuiStatusDeps {
	return {
		bar: () => bar,
		keepRecent: () => keepRecent,
		anchor: () => ({ tokens: bar.tokens, auditDepth: bar.auditDepth }),
	};
}

test("dial: unset/on/garbage default ON, off is OFF", () => {
	assert.equal(samStatusLineEnabled({}), true);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "on" }), true);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "off" }), false);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "Off" }), true); // exact match only
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "" }), true);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "1" }), true);
});

test("constants: the status key is 'sam', the prefix is the literal 'Context '", () => {
	assert.equal(SAM_STATUS_KEY, "sam");
	assert.equal(SAM_STATUS_PREFIX, "Context ");
});

test("install: a single setStatus under the 'sam' key in tui mode", () => {
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(calls.length, 1, JSON.stringify(calls));
	assert.equal(calls[0].key, SAM_STATUS_KEY);
	assert.ok(typeof calls[0].text === "string" && calls[0].text.startsWith(SAM_STATUS_PREFIX), JSON.stringify(calls[0]));
});

test("install: no-op in rpc mode (the bar stays TUI-only)", () => {
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("rpc");
	status.install(ctx);
	assert.equal(calls.length, 0, JSON.stringify(calls));
	status.refresh(ctx); // never installed ⇒ no-op, no throw
	status.shutdown(ctx);
	assert.equal(calls.length, 0, JSON.stringify(calls));
});

test("install: no-op when the dial is off", () => {
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	process.env.SAM_STATUS_LINE = "off";
	try {
		status.install(ctx);
		assert.equal(calls.length, 0, JSON.stringify(calls));
	} finally {
		delete process.env.SAM_STATUS_LINE;
	}
});

test("install: no-op when the ui has no setStatus (test fakes / older pi)", () => {
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	delete ctx.ui.setStatus;
	status.install(ctx);
	status.refresh(ctx); // never installed ⇒ no-op, no throw
	assert.equal(calls.length, 0, JSON.stringify(calls));
});

test("line: known state, not crossed — O=5, .=6, retention 10 (░), | at 36 (D2 colors)", () => {
	// O = 2250 → 5; . = 3000 → 6; x = 4750, keep = 5000 ≥ x ⇒ all remainder
	// retention (░ dim); rem = 10.
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(
		calls[0].text,
		"Context " +
			S(188, "[") +
			S(109, "█████") +
			S(143, "······") +
			S(241, "░".repeat(10)) +
			N(15) +
			S(222, "│") +
			N(3) +
			S(188, "]") +
			S(241, " audit: medium"),
	);
});

test("line: crossed — the outside run flips 226 → 167 (red), retention stays grey", () => {
	// tokens = 19000 > 18000 (W−R): outside = 8750 → 18 chars, retention =
	// 5000 → 10 chars (7 before the | at 36, 2 after); rem = 28.
	const bar = makeBar({ tokens: 19_000 });
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(
		calls[0].text,
		"Context " +
			S(188, "[") +
			S(109, "█████") +
			S(143, "······") +
			S(167, "▒".repeat(18)) +
			S(241, "░".repeat(7)) +
			S(222, "│") +
			S(241, "░░") +
			N(1) +
			S(188, "]") +
			S(241, " audit: medium"),
	);
});

test("line: unknown state — O + ' ??? ' (dim) + the | still placed (Paul ruling 3)", () => {
	// O = 2250 → 5; separator at 5, ??? at 6–8; | at 36.
	const bar = makeBar({ tokens: null });
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(
		calls[0].text,
		"Context " +
			S(188, "[") +
			S(109, "█████") +
			N(1) +
			S(241, "???") +
			N(27) +
			S(222, "│") +
			N(3) +
			S(188, "]") +
			S(241, " audit: medium"),
	);
});

test("in-flight: a per-token delta counts into the known total", () => {
	// onDelta(8000 chars) ⇒ 2000 tokens ⇒ T = 12000: x = 12000−5250 = 6750,
	// keep = 5000 ⇒ retStart = max(5250, 7000) = 7000: outside = 1750 →
	// 4 chars (▒ yellow), retention = 5000 → 10 chars (░); rem = 14.
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	status.onDelta(8000);
	assert.equal(calls.length, 2, JSON.stringify(calls.length));
	assert.equal(
		calls[1].text,
		"Context " +
			S(188, "[") +
			S(109, "█████") +
			S(143, "······") +
			S(226, "▒▒▒▒") +
			S(241, "░".repeat(10)) +
			N(11) +
			S(222, "│") +
			N(3) +
			S(188, "]") +
			S(241, " audit: medium"),
	);
});

test("in-flight: tool partials count only CUMULATIVE growth (no double count)", () => {
	// one tool streaming 400 → 1200 → 2800 chars, then ending at 2800:
	// 2800/4 = 700 tokens ⇒ T = 10700: x = 10700−5250 = 5450, keep = 5000
	// ⇒ retStart = max(5250, 5700) = 5700: outside = 450 → 1 char (▒),
	// retention = 5000 → 10 chars (░); rem = 11.
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	status.onToolPartial("t1", 400);
	status.onToolPartial("t1", 1200);
	status.onToolPartial("t1", 2800);
	status.onToolEnd("t1", 2800);
	assert.equal(calls.length, 5, "install + 3 partials + 1 end");
	assert.equal(
		calls[4].text,
		"Context " +
			S(188, "[") +
			S(109, "█████") +
			S(143, "······") +
			S(226, "▒") +
			S(241, "░".repeat(10)) +
			N(14) +
			S(222, "│") +
			N(3) +
			S(188, "]") +
			S(241, " audit: medium"),
	);
});

test("in-flight: the unknown state gets its own retention run (ruling 2)", () => {
	// tokens null; onDelta(12000 chars) ⇒ 3000 tokens ⇒ 6 retention chars;
	// separator at 11, ??? at 12–14; | at 36.
	const bar = makeBar({ tokens: null });
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	status.onDelta(12000);
	assert.equal(
		calls[1].text,
		"Context " +
			S(188, "[") +
			S(109, "█████") +
			S(241, "░".repeat(6)) +
			N(1) +
			S(241, "???") +
			N(21) +
			S(222, "│") +
			N(3) +
			S(188, "]") +
			S(241, " audit: medium"),
	);
});

test("in-flight: sub-scale in-flight gets the min-1 char (ruling 3)", () => {
	// tokens null; onDelta(100 chars) ⇒ 25 tokens ⇒ round(0.05) = 0 ⇒ min-1
	// ⇒ exactly one retention char before the separator + ???.
	const bar = makeBar({ tokens: null });
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	status.onDelta(100);
	const line = calls[1].text as string;
	assert.match(line, /\x1b\[38;5;241m░\x1b\[39m\u00a0\x1b\[38;5;241m\?\?\?\x1b\[39m/, line);
});

test("bumpAnchor: re-reads tokens + depth and resets the in-flight tail", () => {
	// starts unknown with 4000 chars in flight; the anchor then moves to
	// 20000 tokens at depth light: O = 5 (2250), . = 6 (3000); T = 20000 ⇒
	// x = 20000−5250 = 14750, keep = 5000 ⇒ retStart = max(5250, 15000) =
	// 15000: outside = 9750 → 20, retention = 5000 → 10; overflow (41 > 40)
	// shrinks outside 20 → 19; the | at 36 replaces a retention char; the
	// in-flight run disappears (tail reset) and the suffix reads
	// ' audit: light'.
	const bar = makeBar({ tokens: null });
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	status.onDelta(4000); // 1000 tokens ⇒ round(1000/500) = 2 ⇒ a 2-char retention run
	assert.match(calls[1].text as string, /\x1b\[38;5;241m░+\x1b\[39m\u00a0\x1b\[38;5;241m\?\?\?/, "in-flight run before the ???");
	bar.tokens = 20_000;
	bar.auditDepth = "light";
	status.bumpAnchor(ctx);
	assert.equal(calls.length, 3, JSON.stringify(calls.map((c) => c.text)));
	assert.equal(
		calls[2].text,
		"Context " +
			S(188, "[") +
			S(109, "█████") +
			S(143, "······") +
			S(167, "▒".repeat(19)) +
			S(241, "░".repeat(6)) +
			S(222, "│") +
			S(241, "░░░") +
			S(188, "]") +
			S(241, " audit: light"),
	);
});

test("refresh: re-emits, RESETS the in-flight tail, no-ops after shutdown", () => {
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(calls.length, 1, "install emits once");
	const baseline = calls[0].text as string;
	status.onDelta(8000);
	assert.equal(calls.length, 2, "onDelta re-emits");
	assert.notEqual(calls[1].text, baseline, "the tail moved the line");
	status.refresh(ctx); // a coarse site ⇒ tail reset + re-emit
	assert.equal(calls.length, 3, JSON.stringify(calls.length));
	assert.equal(calls[2].text, baseline, "the in-flight tail is cleared at the coarse site");
	status.shutdown(ctx);
	assert.equal(calls.length, 4);
	status.refresh(ctx); // shut down ⇒ no re-emit, no throw
	assert.equal(calls.length, 4);
});

test("refresh: dial off mid-session clears the line + uninstalls (v0.0.21)", () => {
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	delete process.env.SAM_STATUS_LINE;
	resetSamSettingsForTest();
	status.install(ctx);
	assert.equal(calls.length, 1, "install emits once");
	setInSession("statusLine", false); // menu confirm without save
	status.refresh(ctx);
	assert.equal(calls.length, 2, "the refresh re-checks the dial");
	assert.equal(calls[1].text, undefined, "the line is cleared");
	status.refresh(ctx); // uninstalled ⇒ no-op
	assert.equal(calls.length, 2);
	setInSession("statusLine", undefined);
	resetSamSettingsForTest();
});

test("shutdown: clears the status under the sam key (text undefined)", () => {
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(calls.length, 1);
	status.shutdown(ctx);
	assert.equal(calls.length, 2, JSON.stringify(calls));
	assert.equal(calls[1].key, SAM_STATUS_KEY);
	assert.equal(calls[1].text, undefined);
});

test("shutdown: no-op in non-tui modes", () => {
	const bar = makeBar();
	const status = new SamTuiStatus(depsFor(bar));
	const { ctx, calls } = fakeCtx("rpc");
	status.shutdown(ctx);
	assert.equal(calls.length, 0, JSON.stringify(calls));
});

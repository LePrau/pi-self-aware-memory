/**
 * Unit tests: the SAM TUI status line component (v0.0.16, Paul 2026-10-19;
 * fix-up 2: in-flight tail + segment re-semantics, same version).
 *
 * Plan + decisions:
 *   pi-agent/context-management/pi-self-aware-memory-dev/2026-10-19-sam-tui-status-line.md
 *   pi-agent/context-management/pi-self-aware-memory-dev/2026-10-19-sam-tui-inflight-estimate.md
 *
 * Pins: the dial, the install gates (dial + mode), the theme-color map (D2),
 * the crossed red/yellow split (Paul ruling 2), the unknown state (ruling 3),
 * width truncation (never splits a run), the fix-up 2 in-flight tracker
 * (deltas / cumulative tool partials / bumpAnchor), refresh/dispose/shutdown
 * semantics.
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SAM_WIDGET_KEY, SamTuiStatus, samStatusLineEnabled, type SamTuiStatusDeps } from "../src/tui-status.ts";
import type { SamStatusLineInput } from "../src/statusbar.ts";

/** A theme that marks its colors — the test reads the color names back. */
const theme = {
	fg: (color: string, text: string): string => `⟨${color}⟩${text}`,
};

/** A ctx the component only touches for mode + ui (+ the deps do the data). */
function fakeCtx(mode: "tui" | "rpc" = "tui"): { ctx: any; calls: Array<{ key: string; content: unknown; options?: unknown }> } {
	const calls: Array<{ key: string; content: unknown; options?: unknown }> = [];
	const ctx: any = {
		mode,
		ui: {
			setWidget: (key: string, content: unknown, options?: unknown) => {
				calls.push({ key, content, options });
				if (typeof content === "function") content(fakeTui, theme); // pi calls the factory (measured)
			},
		},
	};
	return { ctx, calls };
}

const fakeTui = { requestRender(): void {} };

/** A mutable bar — the tracker/bumpAnchor pins mutate it between renders. */
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

type Component = { render(width: number): string[]; invalidate(): void; dispose(): void };

/** Install + capture the installed component; returns the status too.
 *  The tui is passed straight through — the component's factory closure
 *  captures it (this.tui = tui), so a counting tui sees every bump. */
function installedFor(bar: SamStatusLineInput, keepRecent = 5_000, tui: { requestRender(): void } = fakeTui): { status: SamTuiStatus; comp: Component; ctx: any } {
	let comp: Component | null = null;
	const deps: SamTuiStatusDeps = {
		bar: () => bar,
		keepRecent: () => keepRecent,
		anchor: () => ({ tokens: bar.tokens, auditDepth: bar.auditDepth }),
	};
	const status = new SamTuiStatus(deps);
	const { ctx } = fakeCtx("tui");
	const origSet = ctx.ui.setWidget;
	ctx.ui.setWidget = (key: string, content: unknown, options?: unknown) => {
		origSet(key, content, options);
		if (typeof content === "function") comp = content(tui, theme) as Component;
	};
	status.install(ctx);
	assert.ok(comp !== null, "the factory must have produced a component");
	return { status, comp: comp as Component, ctx };
}

test("dial: unset/on/garbage default ON, off is OFF", () => {
	assert.equal(samStatusLineEnabled({}), true);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "on" }), true);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "junk" }), true);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "off" }), false);
});

test("install: widget under the 'sam' key, belowEditor, in tui mode", () => {
	const bar = makeBar();
	const { status } = { status: new SamTuiStatus({ bar: () => bar, keepRecent: () => 5_000, anchor: () => ({ tokens: bar.tokens, auditDepth: bar.auditDepth }) }) };
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(calls.length, 1, JSON.stringify(calls));
	assert.equal(calls[0].key, SAM_WIDGET_KEY);
	assert.deepEqual(calls[0].options, { placement: "belowEditor" });
});

test("install: no-op in rpc mode (component factories are ignored there)", () => {
	const bar = makeBar();
	const status = new SamTuiStatus({ bar: () => bar, keepRecent: () => 5_000, anchor: () => ({ tokens: bar.tokens, auditDepth: bar.auditDepth }) });
	const { ctx, calls } = fakeCtx("rpc");
	status.install(ctx);
	assert.equal(calls.length, 0, JSON.stringify(calls));
	// and a refresh afterwards is a no-op (never installed)
	status.refresh(ctx);
	assert.equal(calls.length, 0);
});

test("install: no-op when the dial is off", () => {
	const prev = process.env.SAM_STATUS_LINE;
	process.env.SAM_STATUS_LINE = "off";
	try {
		const bar = makeBar();
		const status = new SamTuiStatus({ bar: () => bar, keepRecent: () => 5_000, anchor: () => ({ tokens: bar.tokens, auditDepth: bar.auditDepth }) });
		const { ctx, calls } = fakeCtx("tui");
		status.install(ctx);
		assert.equal(calls.length, 0, JSON.stringify(calls));
	} finally {
		if (prev === undefined) delete process.env.SAM_STATUS_LINE;
		else process.env.SAM_STATUS_LINE = prev;
	}
});

test("line: D2 color map, known not-crossed (O=5, .=6, retention 10 ░, | at 36)", () => {
	const { comp } = installedFor(makeBar());
	const [line] = comp.render(80);
	assert.equal(
		line,
		"⟨text⟩[" +
			"⟨accent⟩" + "█████" +
			"⟨success⟩" + "······" +
			"⟨dim⟩" + "░".repeat(10) +
			" ".repeat(15) +
			"⟨mdHeading⟩│" +
			" ".repeat(3) +
			"⟨text⟩]" +
			"⟨dim⟩ audit: medium",
		line,
	);
});

test("line: crossed — outside run red (error), retention grey (dim ░), | inside the tail", () => {
	const { comp } = installedFor(makeBar({ tokens: 19_000 }));
	const [line] = comp.render(80);
	assert.equal(
		line,
		"⟨text⟩[" +
			"⟨accent⟩" + "█████" +
			"⟨success⟩" + "······" +
			"⟨error⟩" + "▒".repeat(18) +
			"⟨dim⟩" + "░".repeat(7) +
			"⟨mdHeading⟩│" +
			"⟨dim⟩" + "░░" +
			" " +
			"⟨text⟩]" +
			"⟨dim⟩ audit: medium",
		line,
	);
});

test("line: unknown state — O + ' ??? ' grey, | still placed (Paul ruling 3)", () => {
	const { comp } = installedFor(makeBar({ tokens: null }));
	const [line] = comp.render(80);
	assert.equal(
		line,
		"⟨text⟩[" +
			"⟨accent⟩" + "█████" +
			" " +
			"⟨dim⟩???" +
			" ".repeat(27) +
			"⟨mdHeading⟩│" +
			" ".repeat(3) +
			"⟨text⟩]" +
			"⟨dim⟩ audit: medium",
		line,
	);
});

/* ── v0.0.16 fix-up 2: the in-flight tracker (Paul's cache ruling) ── */

test("in-flight: per-token deltas count into the known total", () => {
	// onDelta(8000 chars) ⇒ 2000 tokens ⇒ T = 12000: x = 12000−5250 = 6750,
	// keep = 5000 ⇒ retStart = max(5250, 7000) = 7000: outside = 1750 →
	// round(3.63) = 4 chars (▒), retention = 5000 → 10 chars (░); rem = 14.
	const { status, comp } = installedFor(makeBar());
	status.onDelta(8000);
	const [line] = comp.render(80);
	assert.equal(
		line,
		"⟨text⟩[" +
			"⟨accent⟩" + "█████" +
			"⟨success⟩" + "······" +
			"⟨warning⟩" + "▒▒▒▒" +
			"⟨dim⟩" + "░".repeat(10) +
			" ".repeat(11) +
			"⟨mdHeading⟩│" +
			" ".repeat(3) +
			"⟨text⟩]" +
		"⟨dim⟩ audit: medium",
		line,
	);
});

test("in-flight: tool partials count CUMULATIVE growth only (no double count)", () => {
	// 400, then 1200 (+800 growth), then 2800 (+1600 growth), then end at
	// 2800 (no growth): total 2800 chars = 700 tokens ⇒ T = 10700:
	// x = 5450, keep = 5000 ⇒ retStart = max(5250, 5700) = 5700: outside =
	// 450 → round(0.91) = 1 → min-1 char (▒), retention = 5000 → 10 (░).
	// (A per-event delta misread would total 4400 chars ⇒ outside = 850 → 2
	// chars — this line discriminates.)
	const { status, comp } = installedFor(makeBar());
	status.onToolPartial("t1", 400);
	status.onToolPartial("t1", 1200);
	status.onToolPartial("t1", 2800);
	status.onToolEnd("t1", 2800);
	const [line] = comp.render(80);
	assert.equal(
		line,
		"⟨text⟩[" +
			"⟨accent⟩" + "█████" +
			"⟨success⟩" + "······" +
			"⟨warning⟩▒" +
			"⟨dim⟩" + "░".repeat(10) +
			" ".repeat(14) +
			"⟨mdHeading⟩│" +
			" ".repeat(3) +
			"⟨text⟩]" +
			"⟨dim⟩ audit: medium",
		line,
	);
});

test("in-flight: in the unknown state it gets its own run (ruling 2: min-1 block)", () => {
	// tokens null; onDelta(12000 chars) ⇒ 3000 tokens ⇒ round(6) = 6 retention
	// chars; separator at 11, ??? at 12–14; | at 36.
	const { status, comp } = installedFor(makeBar({ tokens: null }));
	status.onDelta(12000);
	const [line] = comp.render(80);
	assert.equal(
		line,
		"⟨text⟩[" +
			"⟨accent⟩" + "█████" +
			"⟨dim⟩" + "░".repeat(6) +
			" " +
			"⟨dim⟩???" +
			" ".repeat(21) +
			"⟨mdHeading⟩│" +
			" ".repeat(3) +
			"⟨text⟩]" +
			"⟨dim⟩ audit: medium",
		line,
	);
});

test("in-flight: sub-scale in-flight gets the min-1 char (ruling 3)", () => {
	// 100 chars ⇒ 25 tokens ⇒ round(0.5) = 1 (the min-1 floor is trivially met).
	const { status, comp } = installedFor(makeBar({ tokens: null }));
	status.onDelta(100);
	const line = comp.render(80)[0];
	assert.match(line, /⟨dim⟩░ /, line); // one ░ before the ' ???' separator
});

test("bumpAnchor: re-reads tokens + depth and resets the in-flight tail", () => {
	// start unknown with 4000 chars in flight; the anchor then moves to
	// 20000 tokens at depth light: O = 5 (2250), . = 6 (3000); T = 20000 ⇒
	// x = 14750, keep = 5000 ⇒ retStart = max(5250, 15000) = 15000:
	// outside = 9750 → 20, retention = 5000 → 10; overflow (41 > 40)
	// shrinks outside 20→19; the | at 36 replaces a retention char; the
	// suffix now reads 'audit: light' and the in-flight run is gone
	// (the tail reset — pre-bump it rendered '???', now it is a known bar).
	const bar = makeBar({ tokens: null });
	const { status, comp, ctx } = installedFor(bar);
	status.onDelta(4000);
	assert.match(comp.render(80)[0], /⟨dim⟩░+ .*⟨dim⟩\?\?\?/, "in-flight run before the ??? first");
	bar.tokens = 20_000;
	bar.auditDepth = "light";
	status.bumpAnchor(ctx);
	const [line] = comp.render(80);
	assert.equal(
		line,
		"⟨text⟩[" +
			"⟨accent⟩" + "█████" +
			"⟨success⟩" + "······" +
			"⟨error⟩" + "▒".repeat(19) +
			"⟨dim⟩" + "░".repeat(6) +
			"⟨mdHeading⟩│" +
			"⟨dim⟩" + "░░░" +
			"⟨text⟩]" +
			"⟨dim⟩ audit: light",
		line,
	);
});

test("refresh: bumps the render, RESETS the in-flight tail, and is a no-op after pi disposes the widget", () => {
	let renders = 0;
	const bar = makeBar();
	const tui = { requestRender(): void { renders++; } };
	const { status, comp, ctx } = installedFor(bar, 5_000, tui);
	assert.equal(renders, 0, "install primes the cache directly — no bump (pi re-renders after setWidget)");
	const baseline = comp.render(80)[0];
	status.onDelta(8000); // per-token event: the tail grows + bumps
	assert.equal(renders, 1, "onDelta bumps the render");
	assert.notEqual(comp.render(80)[0], baseline, "the tail moved the line");
	status.refresh(ctx); // coarse site ⇒ tail resets + bump
	assert.equal(renders, 2, "refresh bumps the render");
	assert.equal(comp.render(80)[0], baseline, "the in-flight tail is cleared at the coarse site");
	comp.dispose(); // pi clears the widget (session switch)
	status.refresh(ctx); // disposed ⇒ no bump, no throw
	assert.equal(renders, 2);
});

test("truncation: a narrow width cuts a run, never splits the line mid-run", () => {
	const { comp } = installedFor(makeBar());
	const [line] = comp.render(10);
	// 10 visible chars: [ + 5 prompt + 4 of the audited run (truncated at 6→4)
	assert.equal(line, "⟨text⟩[" + "⟨accent⟩" + "█████" + "⟨success⟩" + "····", line);
});

test("truncation: zero/negative width renders the empty line", () => {
	const { comp } = installedFor(makeBar());
	assert.deepEqual(comp.render(0), [""]);
	assert.deepEqual(comp.render(-5), [""]);
});

test("shutdown: clears the widget under the sam key", () => {
	const bar = makeBar();
	const status = new SamTuiStatus({ bar: () => bar, keepRecent: () => 5_000, anchor: () => ({ tokens: bar.tokens, auditDepth: bar.auditDepth }) });
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(calls.length, 1);
	status.shutdown(ctx);
	assert.equal(calls.length, 2, JSON.stringify(calls));
	assert.equal(calls[1].key, SAM_WIDGET_KEY);
	assert.equal(calls[1].content, undefined);
});

test("shutdown: no-op in non-tui modes", () => {
	const bar = makeBar();
	const status = new SamTuiStatus({ bar: () => bar, keepRecent: () => 5_000, anchor: () => ({ tokens: bar.tokens, auditDepth: bar.auditDepth }) });
	const { ctx, calls } = fakeCtx("rpc");
	status.shutdown(ctx);
	assert.equal(calls.length, 0);
});

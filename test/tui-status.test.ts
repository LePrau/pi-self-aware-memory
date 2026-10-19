/**
 * Unit tests: the SAM TUI status line component (v0.0.16, Paul 2026-10-19).
 *
 * Plan + decisions:
 *   pi-agent/context-management/pi-self-aware-memory-dev/2026-10-19-sam-tui-status-line.md
 *
 * Pins: the dial, the install gates (dial + mode), the theme-color map (D2),
 * the crossed red/yellow split (Paul ruling 2), the unknown state (ruling 3),
 * width truncation (never splits a run), refresh/dispose/shutdown semantics.
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

function makeStatus(over: Partial<SamStatusLineInput> = {}, keepRecent = 5_000): { status: SamTuiStatus; bar: SamStatusLineInput } {
	const bar: SamStatusLineInput = {
		tokens: 10_000,
		window: 20_000,
		reserve: 2_000,
		sysPromptTokens: 2_000,
		goalTokens: 250,
		stackTokens: 3_000,
		auditDepth: "medium",
		...over,
	};
	const deps: SamTuiStatusDeps = {
		bar: () => bar,
		keepRecent: () => keepRecent,
	};
	return { status: new SamTuiStatus(deps), bar };
}

test("dial: unset/on/garbage default ON, off is OFF", () => {
	assert.equal(samStatusLineEnabled({}), true);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "on" }), true);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "junk" }), true);
	assert.equal(samStatusLineEnabled({ SAM_STATUS_LINE: "off" }), false);
});

test("install: widget under the 'sam' key, belowEditor, in tui mode", () => {
	const { status } = makeStatus();
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(calls.length, 1, JSON.stringify(calls));
	assert.equal(calls[0].key, SAM_WIDGET_KEY);
	assert.deepEqual(calls[0].options, { placement: "belowEditor" });
});

test("install: no-op in rpc mode (component factories are ignored there)", () => {
	const { status } = makeStatus();
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
		const { status } = makeStatus();
		const { ctx, calls } = fakeCtx("tui");
		status.install(ctx);
		assert.equal(calls.length, 0, JSON.stringify(calls));
	} finally {
		if (prev === undefined) delete process.env.SAM_STATUS_LINE;
		else process.env.SAM_STATUS_LINE = prev;
	}
});

/** The installed component is captured by pi's factory call — expose it here: */
function installedComponent(): { render(width: number): string[]; invalidate(): void; dispose(): void } {
	let component: { render(width: number): string[]; invalidate(): void; dispose(): void } | null = null;
	const { status } = makeStatus();
	const { ctx } = fakeCtx("tui");
	const origSet = ctx.ui.setWidget;
	ctx.ui.setWidget = (key: string, content: unknown, options?: unknown) => {
		origSet(key, content, options);
		if (typeof content === "function") component = content(fakeTui, theme);
	};
	status.install(ctx);
	assert.ok(component !== null, "the factory must have produced a component");
	return component as { render(width: number): string[]; invalidate(): void; dispose(): void };
}

test("line: D2 color map, known not-crossed (O=5, .=6, retention 10, | at 36)", () => {
	const comp = installedComponent();
	const [line] = comp.render(80);
	assert.equal(
		line,
		"⟨text⟩[" +
			"⟨accent⟩" + "█████" +
			"⟨success⟩" + "░░░░░░" +
			"⟨dim⟩" + "▒".repeat(10) +
			" ".repeat(15) +
			"⟨mdHeading⟩│" +
			" ".repeat(3) +
			"⟨text⟩]" +
			"⟨dim⟩ audit: medium",
		line,
	);
});

test("line: crossed — outside run red (error), retention grey (dim), | inside the tail", () => {
	const comp = installedComponentFor({ tokens: 19_000 });
	const [line] = comp.render(80);
	assert.equal(
		line,
		"⟨text⟩[" +
			"⟨accent⟩" + "█████" +
			"⟨success⟩" + "░░░░░░" +
			"⟨error⟩" + "▒".repeat(18) +
			"⟨dim⟩" + "▒".repeat(7) +
			"⟨mdHeading⟩│" +
			"⟨dim⟩" + "▒▒" +
			" " +
			"⟨text⟩]" +
			"⟨dim⟩ audit: medium",
		line,
	);
});

function installedComponentFor(over: Partial<SamStatusLineInput>): { render(width: number): string[]; invalidate(): void; dispose(): void } {
	let component: { render(width: number): string[]; invalidate(): void; dispose(): void } | null = null;
	const { status } = makeStatus(over);
	const { ctx } = fakeCtx("tui");
	const origSet = ctx.ui.setWidget;
	ctx.ui.setWidget = (key: string, content: unknown, options?: unknown) => {
		origSet(key, content, options);
		if (typeof content === "function") component = content(fakeTui, theme);
	};
	status.install(ctx);
	assert.ok(component !== null, "the factory must have produced a component");
	return component as { render(width: number): string[]; invalidate(): void; dispose(): void };
}

test("line: unknown state — O + ' ??? ' grey, | still placed (Paul ruling 3)", () => {
	const comp = installedComponentFor({ tokens: null });
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

test("truncation: a narrow width cuts a run, never splits the line mid-run", () => {
	const comp = installedComponent();
	const [line] = comp.render(10);
	// 10 visible chars: [ + 5 prompt + 4 of the audited run (truncated at 6→4)
	assert.equal(line, "⟨text⟩[" + "⟨accent⟩" + "█████" + "⟨success⟩" + "░░░░", line);
});

test("truncation: zero/negative width renders the empty line", () => {
	const comp = installedComponent();
	assert.deepEqual(comp.render(0), [""]);
	assert.deepEqual(comp.render(-5), [""]);
});

test("refresh: bumps the render; a no-op after pi disposes the widget", () => {
	let renders = 0;
	const tui = { requestRender(): void { renders++ } };
	const { status } = makeStatus();
	const { ctx } = fakeCtx("tui");
	let comp: { dispose(): void } | null = null;
	const origSet = ctx.ui.setWidget;
	ctx.ui.setWidget = (key: string, content: unknown, options?: unknown) => {
		origSet(key, content, options);
		if (typeof content === "function") comp = content(tui, theme) as { dispose(): void };
	};
	status.install(ctx);
	assert.equal(renders, 0, "install itself must not bump (pi re-renders after setWidget)");
	status.refresh(ctx);
	assert.equal(renders, 1, "refresh bumps the render");
	comp?.dispose(); // pi clears the widget (session switch)
	status.refresh(ctx); // disposed ⇒ no bump, no throw
	assert.equal(renders, 1);
});

test("shutdown: clears the widget under the sam key", () => {
	const { status } = makeStatus();
	const { ctx, calls } = fakeCtx("tui");
	status.install(ctx);
	assert.equal(calls.length, 1);
	status.shutdown(ctx);
	assert.equal(calls.length, 2, JSON.stringify(calls));
	assert.equal(calls[1].key, SAM_WIDGET_KEY);
	assert.equal(calls[1].content, undefined);
});

test("shutdown: no-op in non-tui modes", () => {
	const { status } = makeStatus();
	const { ctx, calls } = fakeCtx("rpc");
	status.shutdown(ctx);
	assert.equal(calls.length, 0);
});

/**
 * SAM TUI status line (v0.0.16, Paul 2026-10-19): a live colored context bar
 * below the input line — a pi `setWidget` component (placement `belowEditor`),
 * sitting between the editor and pi's own status lines.
 *
 *   [███░░░▒▒▒▒▒│                  ] audit: medium
 *
 * Colors (decision D2 — theme names, semantic palette): █ accent (teal),
 * ░ success (green), ▒ warning/error (yellow, red when past the compaction
 * line) / dim (grey retention tail), │ mdHeading (≈ orange), [ ] text
 * (near-white), suffix dim. The pure geometry lives in statusbar.ts
 * (samTuiSegments); the /sam bar keeps its v0.0.15 glyphs.
 *
 * Live at render (D3): render(width) runs on every TUI render; tokens are
 * read live from the last ctx; the O + stack caches are invalidated exactly
 * at the sites that change them (close / retire / unretire / fold / goal) —
 * no timer (pi re-renders on every state change; a 1 Hz interval only added
 * dispose/leak surface).
 *
 * Plan + decisions D1–D9 (with alternatives):
 *   pi-agent/context-management/pi-self-aware-memory-dev/2026-10-19-sam-tui-status-line.md
 *
 * Dial: SAM_STATUS_LINE on|off (default on). TUI mode only — in RPC mode pi
 * ignores component factories (docs/rpc-extension-ui.md: setWidget string
 * arrays are fire-and-forget, factories ignored), so the widget is simply
 * not installed there (documented limitation; the /sam bar is unaffected).
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { samTuiSegments, type SamStatusLineInput, type SamTuiSegment } from "./statusbar.ts";

/** The widget key (pi clears extension widgets per key on session switch). */
export const SAM_WIDGET_KEY = "sam";

/**
 * The dial: exact values "on"/"off"; unset or garbage defaults to ON (the
 * house pattern — a status line is the default surface, opt-out is explicit).
 */
export function samStatusLineEnabled(env: { SAM_STATUS_LINE?: string }): boolean {
	return env.SAM_STATUS_LINE === undefined || env.SAM_STATUS_LINE !== "off";
}

/**
 * The bar inputs, re-derived from a ctx. The SAME derivation /sam status uses
 * (decision D6 — one source of truth, extracted from the statusText glue).
 */
export interface SamTuiStatusDeps {
	bar: (ctx: ExtensionContext) => SamStatusLineInput;
	/** The governor's keepRecentTokens (the retention tail). */
	keepRecent: (ctx: ExtensionContext) => number | undefined;
}

/**
 * The widget's state. One instance per pi process (one process drives one
 * session at a time). install/refresh/shutdown take the current ctx — the
 * ctx object is a stable facade over the session, so a captured ctx keeps
 * serving getContextUsage across events.
 */
export class SamTuiStatus {
	private deps: SamTuiStatusDeps;
	private lastCtx: ExtensionContext | null = null;
	private barCache: SamStatusLineInput | null = null;
	private keepCache: number | undefined;
	private tui: { requestRender(): void } | null = null;
	private installed = false;

	constructor(deps: SamTuiStatusDeps) {
		this.deps = deps;
	}

	/**
	 * Install the widget (session_start). No-op when the dial is off or the
	 * mode is not tui (component factories are ignored there). Idempotent:
	 * a second install replaces the widget (pi disposes the old component).
	 */
	install(ctx: ExtensionContext): void {
		if (!samStatusLineEnabled(process.env)) return;
		if (ctx.mode !== "tui") return;
		if (typeof ctx.ui?.setWidget !== "function") return; // test fakes / older pi
		try {
			this.lastCtx = ctx;
			// Prime the caches directly (a refresh() here would no-op — installed
			// is only set after the widget exists; pi re-renders after setWidget
			// anyway, so no bump is needed).
			this.barCache = this.deps.bar(ctx);
			this.keepCache = this.deps.keepRecent(ctx);
			ctx.ui.setWidget(
			SAM_WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number): string[] => this.renderLine(width, theme),
					// pi-tui's Component contract requires invalidate (the widget
					// renders on every requestRender — invalidation is a no-op).
					invalidate: () => {},
					dispose: () => {
						this.installed = false;
					},
				};
			},
			{ placement: "belowEditor" },
			);
			this.installed = true;
		} catch {
			// Fail-open by design (SAM invariant: a status line must never break a
			// session start) — the bar simply does not appear; nothing to unwind.
		}
	}

	/**
	 * Invalidate the O + stack caches and bump the render. Called at exactly
	 * the sites that change them: close_unit / retire_units / unretire
	 * (finally — every return path), session_compact, adjust_goal, and
	 * session_start (via install).
	 */
	refresh(ctx: ExtensionContext): void {
		if (!this.installed) return;
		try {
			this.lastCtx = ctx;
			this.barCache = this.deps.bar(ctx);
			this.keepCache = this.deps.keepRecent(ctx);
			if (this.tui) this.tui.requestRender();
		} catch {
			// Fail-open: a stale bar beats a broken close/retire path.
		}
	}

	/** Clear the widget (session_shutdown — D8; total: absent key is a no-op). */
	shutdown(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (typeof ctx.ui?.setWidget !== "function") return;
		try {
			ctx.ui.setWidget(SAM_WIDGET_KEY, undefined);
		} catch {
			// Fail-open: pi's resetExtensionUI also clears on session switch.
		}
		this.installed = false;
		this.tui = null;
	}

	/** The one line, truncated to the visible width (never splits a run). */
	private renderLine(width: number, theme: Theme): string[] {
		const ctx = this.lastCtx;
		if (ctx === null) return [];
		const barInput = this.barCache ?? this.deps.bar(ctx);
		const bar = samTuiSegments({
			tokens: barInput.tokens,
			window: barInput.window,
			reserve: barInput.reserve,
			keepRecent: this.keepCache ?? this.deps.keepRecent(ctx), // live fallback before the first refresh
			sysPromptTokens: barInput.sysPromptTokens,
			goalTokens: barInput.goalTokens,
			stackTokens: barInput.stackTokens,
			auditDepth: barInput.auditDepth,
		});
		const w = Math.max(0, Math.floor(width));
		const parts: string[] = [];
		let used = 0;
		for (const s of bar.segments) {
			if (used + s.text.length > w) {
				const take = Math.max(0, w - used);
				if (take > 0) parts.push(colorize(s, take, bar.crossed, theme));
				break;
			}
			parts.push(colorize(s, s.text.length, bar.crossed, theme));
			used += s.text.length;
		}
		return [parts.join("")];
	}
}

/**
 * The kind → theme-color map (decision D2). "outside" is warning (yellow)
 * normally and error (red) once the context crossed the compaction line —
 * the two states of the same outside-retention region, so red and yellow
 * never coexist on the line (Paul ruling 2).
 */
function colorize(s: SamTuiSegment, take: number, crossed: boolean, theme: Theme): string {
	const text = s.text.slice(0, take);
	switch (s.kind) {
		case "prompt":
			return theme.fg("accent", text);
		case "audited":
			return theme.fg("success", text);
		case "outside":
			return theme.fg(crossed ? "error" : "warning", text);
		case "retention":
		case "unknown":
		case "suffix":
			return theme.fg("dim", text);
		case "threshold":
			return theme.fg("mdHeading", text);
		case "bracket":
			return theme.fg("text", text);
		case "fill":
			return text;
	}
}

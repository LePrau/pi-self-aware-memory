/**
 * SAM TUI status line (v0.0.19, Paul 2026-10-23): a live colored context bar
 * BELOW pi's native context bar — a pi footer extension-status entry
 * (`ctx.ui.setStatus("sam", …)`). Measured against the 0.87.1 mirror: the
 * footer renders [pwd line, stats line (the CH%/window context bar), the
 * extension-status line] — the extension-status line is the only extension
 * surface below pi's native context bar, and pi re-renders on every
 * setStatus.
 *
 *   Context [███···▒▒▒▒▒│                  ] audit: medium
 *
 * The geometry is identical to the v0.0.16 widget (the pure samTuiSegments
 * in statusbar.ts); only the transport changed: the setStatus path has no
 * theme object, so colors are hand-rolled 256-color SGR (pi's exact 256-mode
 * emission format, theme.ts:202-233) with the indices pi's own
 * hexTo256/rgbTo256 derives for the dark-theme palette (decision D2).
 * Fills are NBSP — the footer's sanitizeStatusText collapses ASCII-space
 * runs (which would squash the bar fills), NBSP survives it (decision D5).
 * The plain "Context " prefix (D3) identifies SAM's share of the shared
 * status line (other extensions' statuses sit on the same line,
 * space-joined, key-sorted).
 *
 * Live at render (D6): no timer, no captured tui — install / refresh /
 * bumpAnchor and the in-flight events (fix-up 2: per-token + tool-stream
 * char counters) each re-emit the line; the caches are invalidated exactly
 * at the sites that change them (close / retire / unretire / fold / goal),
 * and the in-flight counters reset there.
 *
 * Plan + decisions D1–D8 (with alternatives): 2026-10-23-sam-status-below-native-bar.md
 * (built on 2026-10-19-sam-tui-status-line.md,
 *             2026-10-19-sam-tui-inflight-estimate.md)
 *
 * Dial: SAM_STATUS_LINE on|off (default on). TUI mode only — a no-op in
 * RPC/print (documented limitation; the /sam bar is unaffected). Truncation
 * of the (possibly multi-extension) status line is pi's footer's job —
 * ANSI-aware (measured: truncateToWidth carries pending escape sequences).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { samTuiAnsiLine, samTuiSegments, type SamStatusLineInput } from "./statusbar.ts";
import { samSectionEnv } from "./settings.ts"; // v0.0.20: the settings.json dial layer (cycle is call-time-only)

/** The status key (pi clears extension statuses on session switch). */
export const SAM_STATUS_KEY = "sam";

/** The literal prefix identifying the SAM bar in the shared status line. */
export const SAM_STATUS_PREFIX = "Context ";

/**
 * The dial: exact values "on"/"off"; unset or garbage defaults to ON (the
 * house pattern — a status line is the default surface, opt-out is explicit).
 */
export function samStatusLineEnabled(env: { SAM_STATUS_LINE?: string }): boolean {
	// v0.0.20: the settings.json dial joins — env (if set) wins temporarily;
	// the house discipline (only "off" is special) is unchanged.
	const raw = env.SAM_STATUS_LINE ?? samSectionEnv()["SAM_STATUS_LINE"];
	return raw === undefined || raw !== "off";
}

/**
 * The bar inputs, re-derived from a ctx. The SAME derivation /sam status uses
 * (decision D6 — one source of truth, extracted from the statusText glue).
 */
export interface SamTuiStatusDeps {
	bar: (ctx: ExtensionContext) => SamStatusLineInput;
	/** The governor's keepRecentTokens (the retention tail). */
	keepRecent: (ctx: ExtensionContext) => number | undefined;
	/** The anchor re-read for message_end bumps (fix-up 2): current context
	 *  tokens + the audit depth — the cheap subset of contextBarInput. */
	anchor: (ctx: ExtensionContext) => { tokens: number | null; auditDepth: string };
}

/**
 * The status line's state. One instance per pi process (one process drives
 * one session at a time). install/refresh/shutdown take the current ctx —
 * the ctx object is a stable facade over the session.
 */
export class SamTuiStatus {
	private deps: SamTuiStatusDeps;
	private lastCtx: ExtensionContext | null = null;
	private barCache: SamStatusLineInput | null = null;
	private keepCache: number | undefined;
	private installed = false;
	/** Fix-up 2: in-flight char counters — text/thinking/toolcall deltas plus
	 *  the cumulative tool-output deltas (per toolCallId). Converted to tokens
	 *  (chars/4) only at emission. */
	private deltaChars = 0;
	private toolPartialChars = new Map<string, number>();

	constructor(deps: SamTuiStatusDeps) {
		this.deps = deps;
	}

	/** The in-flight tail in tokens (chars/4, rounded up). */
	private inflightTokens(): number {
		return Math.ceil(this.deltaChars / 4);
	}

	private resetInflight(): void {
		this.deltaChars = 0;
		this.toolPartialChars.clear();
	}

	/** The current status line: `Context ` + the colored bar + the suffix. */
	private statusLine(): string {
		const ctx = this.lastCtx;
		if (ctx === null) return "";
		const barInput = this.barCache ?? this.deps.bar(ctx);
		const bar = samTuiSegments({
			tokens: barInput.tokens,
			window: barInput.window,
			reserve: barInput.reserve,
			keepRecent: this.keepCache ?? this.deps.keepRecent(ctx), // live fallback before the first refresh
			sysPromptTokens: barInput.sysPromptTokens,
			goalTokens: barInput.goalTokens,
			summaryTokens: barInput.summaryTokens,
			auditedTokens: barInput.auditedTokens,
			inflightTokens: this.inflightTokens(), // fix-up 2: the live tail (0 between bumps)
			auditDepth: barInput.auditDepth,
		});
		return samTuiAnsiLine(SAM_STATUS_PREFIX, bar);
	}

	/** Emit the line (fail-open by design: a stale/absent line must never
	 *  break a session). */
	private emit(): void {
		const ctx = this.lastCtx;
		if (ctx === null || !this.installed) return;
		if (typeof ctx.ui?.setStatus !== "function") return;
		try {
			ctx.ui.setStatus(SAM_STATUS_KEY, this.statusLine());
		} catch {
			// Fail-open: the bar simply does not appear.
		}
	}

	/** A streaming assistant delta (text / thinking / toolcall) — chars only,
	 *  no ctx read (fix-up 2). */
	onDelta(chars: number): void {
		if (!this.installed) return;
		if (chars > 0) this.deltaChars += chars;
		this.emit();
	}

	/** A tool's CUMULATIVE partial output — only the growth counts (fix-up 2). */
	onToolPartial(toolCallId: string, chars: number): void {
		if (!this.installed) return;
		const prev = this.toolPartialChars.get(toolCallId) ?? 0;
		if (chars > prev) this.deltaChars += chars - prev;
		this.toolPartialChars.set(toolCallId, chars);
		this.emit();
	}

	/** The tool's final output — final correction, then drop the entry. */
	onToolEnd(toolCallId: string, chars: number): void {
		if (!this.installed) return;
		const prev = this.toolPartialChars.get(toolCallId) ?? 0;
		if (chars > prev) this.deltaChars += chars - prev;
		this.toolPartialChars.delete(toolCallId);
		this.emit();
	}

	/**
	 * The message_end bump (fix-up 2): the session just gained a finalized
	 * message — re-read ONLY the anchor (tokens + audit depth), reset the
	 * in-flight counters (their chars are now in the projection), and emit.
	 * NOT a full contextBarInput recompute (Paul's cache ruling).
	 */
	bumpAnchor(ctx: ExtensionContext): void {
		if (!this.installed) return;
		try {
			this.lastCtx = ctx;
			const a = this.deps.anchor(ctx);
			if (this.barCache) this.barCache = { ...this.barCache, tokens: a.tokens, auditDepth: a.auditDepth };
			this.resetInflight();
			ctx.ui.setStatus(SAM_STATUS_KEY, this.statusLine());
		} catch {
			// Fail-open: a stale line beats a broken message path.
		}
	}

	/**
	 * Install the status line (session_start). No-op when the dial is off or
	 * the mode is not tui (or the pi build exposes no setStatus — test fakes
	 * / older pi). Idempotent: a second install re-emits (pi's statuses are
	 * a key map).
	 */
	install(ctx: ExtensionContext): void {
		if (!samStatusLineEnabled(process.env)) return;
		if (ctx.mode !== "tui") return;
		if (typeof ctx.ui?.setStatus !== "function") return; // test fakes / older pi
		try {
			this.lastCtx = ctx;
			this.resetInflight(); // a new session starts with an empty tail
			// Prime the caches directly (a refresh() here would no-op —
			// installed is only set after the first emission).
			this.barCache = this.deps.bar(ctx);
			this.keepCache = this.deps.keepRecent(ctx);
			ctx.ui.setStatus(SAM_STATUS_KEY, this.statusLine());
			this.installed = true;
		} catch {
			// Fail-open by design (SAM invariant: a status line must never break a
			// session start) — the bar simply does not appear; nothing to unwind.
		}
	}

	/**
	 * Invalidate the O + audited caches and the in-flight counters, and emit.
	 * Called at exactly the sites that change them: close_unit /
	 * retire_units / unretire (finally — every return path), session_compact,
	 * adjust_goal, and session_start (via install). A close/retire/fold
	 * re-anchors the bar, so the in-flight tail (already absorbed into the
	 * projection by then) resets.
	 */
	refresh(ctx: ExtensionContext): void {
		if (!this.installed) return;
		try {
			this.lastCtx = ctx;
			this.barCache = this.deps.bar(ctx);
			this.keepCache = this.deps.keepRecent(ctx);
			this.resetInflight();
			ctx.ui.setStatus(SAM_STATUS_KEY, this.statusLine());
		} catch {
			// Fail-open: a stale line beats a broken close/retire path.
		}
	}

	/**
	 * Clear the status line (session_shutdown — D6; the absent key is a
	 * no-op). Belt and braces on pi's resetExtensionUI (extension statuses
	 * are cleared on every session switch too); the explicit teardown is the
	 * same-session path.
	 */
	shutdown(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (typeof ctx.ui?.setStatus !== "function") return;
		try {
			ctx.ui.setStatus(SAM_STATUS_KEY, undefined);
		} catch {
			// Fail-open: pi's resetExtensionUI also clears on session switch.
		}
		this.installed = false;
		this.lastCtx = null;
	}
}

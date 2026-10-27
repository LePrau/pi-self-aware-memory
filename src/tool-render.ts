/**
 * SAM tool-row timing and rendering (2026-10-27, WISHLIST "show elapsed
 * time on close and audit — just like for write and bash tool calls").
 *
 * pi's built-in rows (read/write/bash) get their timing from the CORE: the
 * agent loop measures durationMs for every tool call and persists it into
 * the session entry; the core render-utils timer renders "Elapsed Xs"
 * (live, 1 s tick) and "Took Xs" (final — the recorded duration wins). SAM's
 * close tools had no custom renderer, so they fell into the core fallback,
 * which shows NO timer at all. This module gives the close family its own
 * renderers in that same visual language (the codemode extension is the
 * precedent: an extension drawing a bash-style timer line).
 *
 * Self-contained — the timer helpers are NOT exported by pi's main entry in
 * any gated version (measured 0.87.1/1.3.0/1.4.0), so they are mirrored here
 * instead of imported:
 *  - formatSamToolDuration mirrors the core's formatToolDuration verbatim
 *    ("4.2s" / "1m 30s" / "2h 3m 4s").
 *  - the FINAL line prefers the RECORDED durationMs when the pi version
 *    exposes it on the render context (measured: 1.3.0/1.4.0 — monotonic,
 *    survives reloads, so a re-drawn row still shows the true duration;
 *    0.87.1: the field does not exist), with the renderer's own clock as
 *    the live fallback (0.87.1: live rows only — the same behaviour pi's
 *    own rows have there).
 *  - the pi-tui components come from @earendil-works/pi-tui (the extension
 *    import path the jiti loader aliases to the running pi's own copy —
 *    measured in all three gated versions); Theme and keyHint come from
 *    pi's main entry (verified exports in 0.87.1 and 1.3.0).
 *
 * The pure parts (formatSamToolDuration, samTimerText, samTextOutput,
 * samStubArgsPreview) are unit-tested in test/tool-render.test.ts; the
 * pi-tui components appear only in the renderer wrappers.
 */
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";

/** Core's FALLBACK_PREVIEW_LINES / COLLAPSED_ARGS_CHARS / timer tick (measured). */
const FALLBACK_PREVIEW_LINES = 10;
const TIMER_INTERVAL_MS = 1000;

/** Same durations as the core's formatToolDuration (render-utils.ts, verbatim). */
export function formatSamToolDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

export interface SamTimerState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

/**
 * The row's timing line. Mirrors the core's toolTimerText (render-utils.ts,
 * 1.3.0) plus the capability probe: the RECORDED durationMs wins for the
 * final line when present; the renderer's own clock is the live source and
 * the 0.87.1 fallback. Mutates `state.endedAt` like the core does (the
 * state lives on the shared tool-row state, so call and result renders of
 * the SAME tool call share one clock).
 */
export function samTimerText(
	state: SamTimerState,
	now: number,
	isPartial: boolean,
	isError: boolean,
	durationMs?: number,
): string | undefined {
	if (!isPartial || isError) state.endedAt ??= now;
	const recorded = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
	if (!isPartial && recorded !== undefined) return `Took ${formatSamToolDuration(recorded)}`;
	if (state.startedAt === undefined) return undefined;
	return `${isPartial ? "Elapsed" : "Took"} ${formatSamToolDuration((state.endedAt ?? now) - state.startedAt)}`;
}

/** The text blocks of a tool result (SAM's close tools return text only —
 *  image handling is deliberately omitted, that is the core fallback's
 *  territory). */
export function samTextOutput(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n").replace(/\r/g, "");
}

/**
 * The argument preview for the close family's rows. The stub is a big
 * string — the core's generic preview JSON.stringifies it and would show
 * only its first 100 quoted chars; the collapsed row shows its size
 * (like the in-flight audit line), the expanded row the full text.
 */
export function samStubArgsPreview(args: unknown, tool: "close_unit" | "update_unit", expanded: boolean): string {
	const a = (args && typeof args === "object" ? args : {}) as { stub?: unknown; depth?: unknown; unitId?: unknown };
	const stub = typeof a.stub === "string" ? a.stub : "";
	if (!expanded) {
		const bits: string[] = [];
		if (tool === "update_unit" && typeof a.unitId === "number") bits.push(`unitId=${a.unitId}`);
		if (tool === "close_unit" && typeof a.depth === "string") bits.push(`depth=${a.depth}`);
		bits.push(`stub: ${stub.split("\n").length} lines, ${stub.length} chars`);
		return bits.join(" ");
	}
	const lines: string[] = [];
	if (tool === "update_unit" && typeof a.unitId === "number") lines.push(`  unitId: ${a.unitId}`);
	if (tool === "close_unit" && typeof a.depth === "string") lines.push(`  depth: ${a.depth}`);
	if (stub !== "") lines.push(`  stub: ${stub.replace(/\r/g, "").split("\n").join("\n      ")}`);
	return lines.join("\n");
}

/**
 * The render context as SAM's renderers see it — a structural supertype of
 * pi's ToolRenderContext in every gated version (0.87.1/1.3.0/1.4.0,
 * measured): state defaults to `any`, so `Record<string, unknown>` is
 * satisfied; `durationMs` is declared OPTIONAL because 0.87.1 has no such
 * field (capability-probed at use, never required).
 */
export interface SamToolRenderContext {
	args: unknown;
	state: Record<string, unknown>;
	executionStarted: boolean;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
	invalidate: () => void;
	lastComponent: Component | undefined;
	durationMs?: number;
}

function timerOf(context: SamToolRenderContext): SamTimerState {
	const existing = context.state.timer;
	if (existing && typeof existing === "object") return existing as SamTimerState;
	const fresh: SamTimerState = {};
	context.state.timer = fresh;
	return fresh;
}

function startTick(context: SamToolRenderContext, timer: SamTimerState): void {
	if (timer.interval !== undefined || timer.startedAt === undefined) return;
	timer.interval = setInterval(() => {
		context.invalidate();
	}, TIMER_INTERVAL_MS);
}

function stopTick(timer: SamTimerState): void {
	if (timer.interval !== undefined) {
		clearInterval(timer.interval);
		timer.interval = undefined;
	}
}

/** 1.3.0+/1.4.0 only (measured): the recorded execution duration — the
 *  final line prefers it over the renderer clock. */
function recordedDurationMs(context: SamToolRenderContext): number | undefined {
	const d = context.durationMs;
	return typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : undefined;
}

function addTimerLine(box: Container, theme: Theme, context: SamToolRenderContext, timer: SamTimerState): void {
	const text = samTimerText(timer, Date.now(), context.isPartial, context.isError, recordedDurationMs(context));
	if (context.isPartial && !context.isError) startTick(context, timer);
	else stopTick(timer);
	if (text === undefined) return;
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("muted", text), 0, 0));
}

export interface SamTimedRenderersOptions {
	/** The tool name for the title line (the core shows toolTitle bold). */
	title: string;
	previewArgs: (args: unknown, expanded: boolean) => string;
}

export interface SamTimedRenderers {
	renderCall: (args: unknown, theme: Theme, context: SamToolRenderContext) => Component;
	renderResult: (
		result: { content: unknown },
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		context: SamToolRenderContext,
	) => Component;
}

/**
 * The close family's own tool rows: a bash-style live "Elapsed Xs" while
 * the close + audit run, and a final "Took Xs" (the recorded durationMs
 * where the pi version provides it). Visual only — no audit/closing
 * behaviour changes.
 */
export function samTimedRenderers(opts: SamTimedRenderersOptions): SamTimedRenderers {
	function renderCall(args: unknown, theme: Theme, context: SamToolRenderContext): Component {
		const timer = timerOf(context);
		if (context.executionStarted && timer.startedAt === undefined) timer.startedAt = Date.now();
		if (context.executionStarted) startTick(context, timer);
		const box = new Container();
		const header = theme.fg("toolTitle", theme.bold(opts.title));
		const preview = opts.previewArgs(args, context.expanded);
		if (preview !== "") {
			const head = context.expanded ? `${header}\n${theme.fg("muted", preview)}` : `${header} ${theme.fg("muted", preview)}`;
			box.addChild(new Text(head, 0, 0));
		} else {
			box.addChild(new Text(header, 0, 0));
		}
		addTimerLine(box, theme, context, timer);
		return box;
	}

	function renderResult(result: { content: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: SamToolRenderContext): Component {
		const timer = timerOf(context);
		const output = samTextOutput(result.content);
		const box = new Container();
		if (output !== "") {
			const lines = output.split("\n");
			const displayLines = options.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
			const remaining = lines.length - displayLines.length;
			let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
			if (remaining > 0) {
				text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			}
			box.addChild(new Text(text, 0, 0));
		}
		addTimerLine(box, theme, context, timer);
		return box;
	}

	return { renderCall, renderResult };
}

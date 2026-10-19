/**
 * SAM status line (v0.0.15, Paul 2026-10-19): the context bar for `/sam status`.
 *
 *   SAM [OOO....xxxx                    | ] audit: medium
 *
 *   O = prompt+summary — the measured system prompt + the rendered stored-goal block
 *   . = context already closed/audited — the rendered settlement stack
 *   x = context not yet closed (unaudited) — everything else (raw conversation,
 *       retention tail, nudges, in-flight work)
 *   | = pi's compaction threshold (window − reserve)
 *   empty bar = empty context
 *
 * Plan + decisions D1–D10 (with alternatives):
 *   pi-agent/context-management/pi-self-aware-memory-dev/2026-10-19-sam-status-line.md
 *
 * Estimates are fine (Paul) — chars→tokens is /4 everywhere; the system prompt is
 * MEASURED (ctx.getSystemPrompt, decision D3), the goal block and the settlement
 * stack are rendered with the same pure helpers the takeover uses.
 *
 * Pure: no ctx, no env, no state — renderSamStatus (output.ts) and the v0.0.16
 * TUI widget (src/tui-status.ts) both call this.
 */

/** The bar length in characters (decision D2). */
export const STATUS_BAR_LENGTH = 40;

export interface SamStatusLineInput {
	/** Current context tokens — null right after start or ANY fold. */
	tokens: number | null;
	/** The window (W) — undefined before the first usage. */
	window?: number;
	/** The deployed reserve (R) — the compaction line is window − reserve. */
	reserve?: number;
	/** Measured system-prompt tokens (chars/4). */
	sysPromptTokens: number;
	/** Rendered stored-goal-block tokens (chars/4); 0 when no goal is stored. */
	goalTokens: number;
	/** Rendered settlement-stack tokens (chars/4). */
	stackTokens: number;
	/** The audit depth that would be chosen now (the nudge level line value). */
	auditDepth: string;
}

/**
 * Decision D8: each nonzero segment gets max(1, round(tokens × length / window))
 * chars. When the segments exceed the bar, shrink x first, then `.`, then O —
 * O and `.` are measured, x is the derived remainder, so the measured segments
 * keep their visible footprint (x absorbs overflow, the common near-full case).
 */
export function statusBarChars(
	oTokens: number,
	dotTokens: number,
	xTokens: number,
	window: number,
	length: number = STATUS_BAR_LENGTH,
): { o: number; dot: number; x: number } {
	const scale = (t: number): number => (t <= 0 ? 0 : Math.max(1, Math.round((t * length) / window)));
	let o = scale(oTokens);
	let dot = scale(dotTokens);
	let x = scale(xTokens);
	let overflow = o + dot + x - length;
	if (overflow > 0) {
		const fromX = Math.min(x, overflow);
		x -= fromX;
		overflow -= fromX;
		if (overflow > 0) {
			const fromDot = Math.min(dot, overflow);
			dot -= fromDot;
			overflow -= fromDot;
			if (overflow > 0) o -= overflow; // the remainder necessarily fits in O (sum invariant)
		}
	}
	return { o, dot, x };
}

/**
 * Decision D6: the `|` sits at round((window − reserve) × length / window),
 * clamped to the last bar position; it REPLACES the char at that position, so a
 * context past the compaction line shows the `|` inside the fill.
 */
function linePosition(window: number, reserve: number, length: number = STATUS_BAR_LENGTH): number {
	const pos = Math.round(((window - reserve) * length) / window);
	return Math.min(length - 1, Math.max(0, pos));
}

/**
 * The status line. Decision D7: without tokens (null — right after start or any
 * fold) or without a window/reserve, no bar — the honest note instead (a bar
 * without x would read as an empty context).
 */
export function renderSamStatusLine(input: SamStatusLineInput): string {
	const tail = ` audit: ${input.auditDepth}`;
	if (input.tokens === null || input.window === undefined || !(input.window > 0) || input.reserve === undefined) {
		return `SAM (context tokens unknown)${tail}`;
	}
	const oTokens = input.sysPromptTokens + input.goalTokens;
	const xTokens = Math.max(0, input.tokens - oTokens - input.stackTokens);
	const { o, dot, x } = statusBarChars(oTokens, input.stackTokens, xTokens, input.window);
	const bar: string[] = new Array(STATUS_BAR_LENGTH).fill(" ");
	for (let i = 0; i < o; i++) bar[i] = "O";
	for (let i = 0; i < dot; i++) bar[o + i] = ".";
	for (let i = 0; i < x; i++) bar[o + dot + i] = "x";
	bar[linePosition(input.window, input.reserve)] = "|";
	return `SAM [${bar.join("")}]${tail}`;
}

/* ── v0.0.16 TUI bar (plan: pi-self-aware-memory-dev/2026-10-19-sam-tui-status-line.md) ──
 *
 *   [███░░░▒▒▒▒▒│                  ] audit: medium
 *
 *   █ prompt+summary (accent/teal)   ░ audited/closed stack (success/green)
 *   ▒ remainder: warning yellow outside pi's retention window, error red once
 *     the context is past the compaction line W−R (the two states of the same
 *     region — red–yellow–grey can never coexist, Paul ruling 2), dim grey for
 *     the retention tail (the last keepRecentTokens pi keeps raw through a fold)
 *   │ the compaction line W−R (mdHeading, ≈ orange)
 *   [ ] brackets (text/white)        suffix (dim)
 *   tokens unknown ⇒ [███ ???        │   ] — the derived O stays (known), the
 *     remainder is " ??? " in dim grey, the | is placed whenever W and R are
 *     known (Paul ruling 3).
 */

/** One color run of the TUI bar (the renderer maps kind → theme color). */
export type SamTuiSegmentKind =
	| "prompt"
	| "audited"
	| "outside"
	| "retention"
	| "threshold"
	| "unknown"
	| "bracket"
	| "suffix"
	| "fill";

export interface SamTuiSegment {
	kind: SamTuiSegmentKind;
	text: string;
}

export interface SamTuiSegmentsInput {
	/** Current context tokens — null right after start or ANY fold. */
	tokens: number | null;
	/** The window (W) — undefined before the first usage. */
	window?: number;
	/** The deployed reserve (R) — the compaction line is window − reserve. */
	reserve?: number;
	/** pi's deployed keepRecentTokens — the retention tail size (the grey split). */
	keepRecent?: number;
	/** Measured system-prompt tokens (chars/4). */
	sysPromptTokens: number;
	/** Rendered stored-goal-block tokens (chars/4); 0 when no goal is stored. */
	goalTokens: number;
	/** Rendered settlement-stack tokens (chars/4). */
	stackTokens: number;
	/** The audit depth that would be chosen now. */
	auditDepth: string;
}

export interface SamTuiBar {
	/** Ordered color runs: bracket, bar runs, bracket, suffix. */
	segments: SamTuiSegment[];
	/** true when tokens > window − reserve (the outside run renders red, not yellow). */
	crossed: boolean;
}

const TUI_GLYPH: Record<BarChar, string> = {
	prompt: "█",
	audited: "░",
	outside: "▒",
	retention: "▒",
	threshold: "│",
	unknown: "?",
	fill: " ",
};

/** A bar-position kind (never bracket/suffix — those are added by the renderer frame). */
type BarChar = Exclude<SamTuiSegmentKind, "bracket" | "suffix">;

/**
 * The TUI bar as ordered color runs. Decision D7: each nonzero segment gets
 * max(1, round(tokens × L / W)) chars (the v0.0.15 D8 min-1 rule); the
 * remainder is split outside-retention/retention by token share (min-1 each
 * when both are nonzero, outside wins a 1-char budget); overflow shrinks
 * outside-retention → retention → audited → prompt (the measured segments keep
 * their footprint last). The | REPLACES the char at its position (D6) —
 * context past the compaction line shows the | inside the fill.
 */
export function samTuiSegments(input: SamTuiSegmentsInput): SamTuiBar {
	const L = STATUS_BAR_LENGTH;
	const oTokens = input.sysPromptTokens + input.goalTokens;
	const hasBar = input.window !== undefined && input.window > 0 && input.reserve !== undefined && input.reserve >= 0;
	const scale = (t: number): number => (t <= 0 ? 0 : Math.max(1, Math.round((t * L) / (input.window as number))));
	const chars: BarChar[] = new Array(L).fill("fill");
	let crossed = false;

	if (input.tokens === null || !hasBar) {
		// The unknown state (D4): the derived O (still known) + " ??? " in dim +
		// space fill; the | is placed whenever W and R are known even with null
		// tokens. Without a window there is no scale — no O, no | (total: a
		// bare " ??? " bar). The marker is squeezed only after the fill (Paul's
		// degenerate rule): one separator space, then up to three '?'.
		const o = hasBar ? Math.min(L, scale(oTokens)) : 0;
		for (let i = 0; i < o; i++) chars[i] = "prompt";
		const q = Math.max(0, Math.min(3, L - o - 1));
		for (let i = 0; i < q; i++) chars[o + 1 + i] = "unknown";
		if (hasBar && input.window !== undefined && input.reserve !== undefined) {
			chars[linePosition(input.window, input.reserve, L)] = "threshold";
		}
	} else {
		const W = input.window as number;
		const R = input.reserve as number;
		const A = oTokens + input.stackTokens; // the remainder starts here (token space)
		const T = input.tokens as number;
		const x = Math.max(0, T - A); // remainder tokens (raw conversation + tail)
		const keep = input.keepRecent !== undefined && input.keepRecent > 0 ? input.keepRecent : 0;
		const retStart = Math.max(A, T - keep); // the retention tail = the last keep tokens
		const outTokens = retStart - A; // ≥ 0 — outside the retention window
		const retTokens = T - retStart; // ≥ 0 — the retention tail
		crossed = T > W - R;

		let o = scale(oTokens);
		let dot = scale(input.stackTokens);
		const rem = x > 0 ? Math.max(1, Math.round((x * L) / W)) : 0;
		let out: number;
		let ret: number;
		if (outTokens > 0 && retTokens > 0) {
			out = rem <= 1 ? 1 : Math.max(1, Math.min(rem - 1, Math.round((outTokens * rem) / x)));
			ret = rem - out;
		} else if (outTokens > 0) {
			out = rem;
			ret = 0;
		} else {
			out = 0;
			ret = rem;
		}
		let overflow = o + dot + out + ret - L;
		if (overflow > 0) {
			const fromOut = Math.min(out, overflow);
			out -= fromOut;
			overflow -= fromOut;
			if (overflow > 0) {
				const fromRet = Math.min(ret, overflow);
				ret -= fromRet;
				overflow -= fromRet;
			}
			if (overflow > 0) {
				const fromDot = Math.min(dot, overflow);
				dot -= fromDot;
				overflow -= fromDot;
			}
			if (overflow > 0) o = Math.max(0, o - overflow); // the remainder fits in O (sum invariant)
		}
		for (let i = 0; i < o; i++) chars[i] = "prompt";
		for (let i = 0; i < dot; i++) chars[o + i] = "audited";
		for (let i = 0; i < out; i++) chars[o + dot + i] = "outside";
		for (let i = 0; i < ret; i++) chars[o + dot + out + i] = "retention";
		chars[linePosition(W, R, L)] = "threshold";
	}

	const segments: SamTuiSegment[] = [{ kind: "bracket", text: "[" }];
	for (const k of chars) {
		const last = segments[segments.length - 1];
		if (last.kind === k) last.text += TUI_GLYPH[k];
		else segments.push({ kind: k, text: TUI_GLYPH[k] });
	}
	segments.push({ kind: "bracket", text: "]" });
	segments.push({ kind: "suffix", text: ` audit: ${input.auditDepth}` });
	return { segments, crossed };
}

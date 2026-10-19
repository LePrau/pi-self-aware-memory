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
 * Pure: no ctx, no env, no state — renderSamStatus (output.ts) calls this.
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

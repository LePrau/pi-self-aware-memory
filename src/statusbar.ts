/**
 * SAM status line (v0.0.15, Paul 2026-10-19): the context bar for `/sam status`.
 *
 *   SAM [OOO....xxxx                    | ] audit: medium
 *
 *   O = the "before first turn after fold" prompt — the measured system prompt +
 *       the stored goal block (pre-fold) or the latest takeover summary (post-fold —
 *       the summary CONTAINS the goal block, so no double count)
 *   . = context of closed (audited) units still in the current context — RAW tokens
 *       (interpretation B): pre-fold, the closed spans; post-fold, the carried-over
 *       remainder of a close that sat inside pi's retention window
 *   x = context after the last close_unit (not yet audited/summarized) — everything
 *       else (raw conversation, retention tail, in-flight work)
 *   | = pi's compaction threshold (window − reserve)
 *   empty bar = empty context
 *
 * Plan + decisions D1–D10 (with alternatives): 2026-10-19-sam-status-line.md
 *
 * Estimates are fine (Paul) — chars→tokens is /4 everywhere; the system prompt is
 * MEASURED (ctx.getSystemPrompt, decision D3); the goal block and the takeover
 * summary are rendered/length-estimated with the same pure helpers the takeover
 * uses; the audited (dot) span is estimated with the pi-mirrored ruler
 * (estimate.ts, cross-tested in test/pi-semantics.test.ts).
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
	/** Rendered stored-goal-block tokens (chars/4); 0 when no goal is stored.
	 *  The O part PRE-FOLD; post-fold the takeover summary replaces it. */
	goalTokens: number;
	/** Latest takeover-summary tokens (summary chars/4); 0 before any fold.
	 *  The O part POST-FOLD (it contains the goal block — no double count). */
	summaryTokens: number;
	/** RAW tokens of closed (audited) units still in the current context
	 *  (interpretation B — the close boundary is the last settlement ledger
	 *  entry; estimated with the pi-mirrored ruler). */
	auditedTokens: number;
	/** In-flight chars→tokens not yet in any session entry (the current turn's
	 *  streaming text + tool output). 0 / omitted for the /sam bar. */
	inflightTokens?: number;
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
	const oTokens = input.sysPromptTokens + (input.summaryTokens > 0 ? input.summaryTokens : input.goalTokens);
	const xTokens = Math.max(0, input.tokens + (input.inflightTokens ?? 0) - oTokens - input.auditedTokens);
	const { o, dot, x } = statusBarChars(oTokens, input.auditedTokens, xTokens, input.window);
	const bar: string[] = new Array(STATUS_BAR_LENGTH).fill(" ");
	for (let i = 0; i < o; i++) bar[i] = "O";
	for (let i = 0; i < dot; i++) bar[o + i] = ".";
	for (let i = 0; i < x; i++) bar[o + dot + i] = "x";
	bar[linePosition(input.window, input.reserve)] = "|";
	return `SAM [${bar.join("")}]${tail}`;
}

/* ── v0.0.16 TUI bar (plan: 2026-10-19-sam-tui-status-line.md) ──
 *
 *   [███···░░░░░│                  ] audit: medium
 *
 *   █ prompt (accent/teal)           · audited/closed context (success/muted
 *     yellow-green — ruling 4, v3: ░ proved optically confusable with ▒)
 *   ▒ remainder: warning yellow outside pi's retention window, error red once
 *     the context is past the compaction line W−R (the two states of the same
 *     region — red–yellow–grey can never coexist, Paul ruling 2)
 *   ░ retention tail (dim grey — the last keepRecentTokens pi keeps raw
 *     through a fold; fix-up 2: ░ replaced ▒ so the two remainder states are
 *     optically distinct)
 *   │ the compaction line W−R (mdHeading, ≈ orange)
 *   [ ] brackets (text/white)        suffix (dim)
 *   tokens unknown ⇒ [███░░░ ???     │   ] — the derived O stays (known), the
 *     in-flight run gets a block as soon as it is >0 (fix-up 2), then
 *     " ??? " in dim grey; the | is placed whenever W and R are known (Paul
 *     ruling 3).
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
	/** Rendered stored-goal-block tokens (chars/4); 0 when no goal is stored
	 *  (the O part pre-fold; post-fold the takeover summary replaces it). */
	goalTokens: number;
	/** Latest takeover-summary tokens (chars/4); 0 before any fold. */
	summaryTokens: number;
	/** RAW tokens of closed (audited) units still in the current context. */
	auditedTokens: number;
	/** In-flight tokens not yet in any session entry (the streaming tail);
	 *  unknown-state bars render them as their own run (fix-up 2). */
	inflightTokens?: number;
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
	audited: "·",
	outside: "▒",
	retention: "░", // fix-up 2: light block (▒ stays for outside-retention)
	threshold: "│",
	unknown: "?",
	fill: " ",
};

/** A bar-position kind (never bracket/suffix — those are added by the renderer frame). */
type BarChar = Exclude<SamTuiSegmentKind, "bracket" | "suffix">;

/**
 * The TUI bar as ordered color runs. Decision D7 + fix-up 2 (Paul): each
 * nonzero segment gets max(1, round(tokens × L / W)) chars (the min-1 rule —
 * every segment type gets ≥1 full block once it has >0 tokens; tiny parts may
 * be exaggerated); the remainder is split outside-retention/retention by
 * token share (min-1 each when both are nonzero, outside wins a 1-char
 * budget); overflow shrinks outside-retention → retention → audited → prompt
 * (the measured segments keep their footprint last). The | REPLACES the char
 * at its position (D6) — context past the compaction line shows the | inside
 * the fill.
 *
 * O = sysPrompt + takeover-summary (post-fold) or goal block (pre-fold);
 * dots = RAW tokens of closed units still in the current context
 * (interpretation A is gone — interpretation B); x = everything after the last
 * close_unit (derived); in-flight tokens count into the total (known state) or
 * get their own run (unknown state — "as soon as a new type is more than 0
 * tokens, it starts with a full block").
 */
export function samTuiSegments(input: SamTuiSegmentsInput): SamTuiBar {
	const L = STATUS_BAR_LENGTH;
	const summary = input.summaryTokens > 0 ? input.summaryTokens : input.goalTokens;
	const oTokens = input.sysPromptTokens + summary;
	const inflight = input.inflightTokens ?? 0;
	const hasBar = input.window !== undefined && input.window > 0 && input.reserve !== undefined && input.reserve >= 0;
	const scale = (t: number): number => (t <= 0 ? 0 : Math.max(1, Math.round((t * L) / (input.window as number))));
	const chars: BarChar[] = new Array(L).fill("fill");
	let crossed = false;

	if (input.tokens === null || !hasBar) {
		// The unknown state (D4 + fix-up 2): the derived O (still known) + the
		// in-flight run (min-1 once >0) + " ??? " in dim + space fill; the | is
		// placed whenever W and R are known even with null tokens. Without a
		// window there is no scale — no O, no in-flight, no | (total: a bare
		// " ??? " bar). The marker is squeezed only after the runs (Paul's
		// degenerate rule): one separator space, then up to three '?'.
		const o = hasBar ? Math.min(L - 2, scale(oTokens)) : 0;
		const infl =
			hasBar && inflight > 0 && o < L - 2
				? Math.min(L - o - 2, Math.max(1, Math.round((inflight * L) / (input.window as number))))
				: 0;
		for (let i = 0; i < o; i++) chars[i] = "prompt";
		for (let i = 0; i < infl; i++) chars[o + i] = "retention";
		const q = Math.max(0, Math.min(3, L - o - infl - 1));
		for (let i = 0; i < q; i++) chars[o + infl + 1 + i] = "unknown";
		if (hasBar) {
			chars[linePosition(input.window as number, input.reserve as number, L)] = "threshold";
		}
	} else {
		const W = input.window as number;
		const R = input.reserve as number;
		const T = (input.tokens as number) + inflight; // the in-flight tail counts toward the total
		const A = oTokens + input.auditedTokens; // the remainder starts here (token space)
		const x = Math.max(0, T - A); // remainder tokens — everything after the last close_unit
		const keep = input.keepRecent !== undefined && input.keepRecent > 0 ? input.keepRecent : 0;
		const retStart = Math.max(A, T - keep); // the retention tail = the last keep tokens
		const outTokens = retStart - A; // ≥ 0 — outside the retention window
		const retTokens = T - retStart; // ≥ 0 — the retention tail
		crossed = T > W - R;

		let o = scale(oTokens);
		let dot = scale(input.auditedTokens);
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

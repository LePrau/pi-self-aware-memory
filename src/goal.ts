/**
 * D11 (2026-10-02, DECIDED by Paul; the 2026-10-02 second-batch implementation)
 * — goal persistence: the stored goal is the one class of content a fold must
 * never lose (measured run `sam-small-unit-03`: the task prompt folded out,
 * 5 of 6 task constraints ABSENT post-fold — banked in the dev repo).
 *
 * Surface (close dial / v4 — the v3 control arms stay byte-stable):
 * - `adjust_goal` — the model sets/updates the stored goal (mutable,
 *   LATEST-WINS, mirroring the settlements' latest-per-unit rule) as soon as
 *   the goal is clear: the first user input and at every change (steering,
 *   answer rounds). Soft expectation (Paul, 2026-10-02: "soft is what we
 *   want") — no close_unit refusal; the deterministic fallback below is the
 *   safety net.
 * - `read_goal` — the model re-reads the current goal VERBATIM at any point
 *   (Paul, 2026-10-02: "the model should be able to retrieve the verbatim
 *   goal it has set, so it can make sure nothing important gets lost") —
 *   before overwriting it (replace semantics) to modify accordingly.
 * - Takeover (compaction) — the goal RIDES EVERY FOLD: head of the takeover
 *   summary, before the settlement blocks, before the session content
 *   (Paul's "inserted before session content after compaction"); on a new
 *   fold the MOST RECENT version is taken (replace; the old goal block is
 *   stripped from the carried previous summary — we own the pinned shape,
 *   so the strip is deterministic and never touches pi-native prose).
 * - Earler versions remain in the session ledger as TOMBSTONES (the journal
 *   is append-only — "if the structure allows" it does, Paul) — `read_goal`
 *   enumerates them.
 * - FALLBACK (deterministic) — ONLY when a close happened (a settlement is
 *   on the branch) and no goal was set (Paul's scope): the extension captures
 *   the goal-defining user input (the last real — non `[sam-`-prefixed — user
 *   message on the branch) + ONE agent turn (n = 1, Paul) verbatim, labelled
 *   takeover-derived, and commits it as a goal record (durable, append-only,
 *   like the D9 hatch). A goal-only branch takes over on the goal alone;
 *   a branch with neither goal nor settlements goes to pi's native
 *   summarization untouched (control-arm semantics preserved).
 *
 * Provenance: design note in the dev repo
 * (`2026-10-02-v4-batch-d11-goal-format-anomaly-d10.md`); pins ship with the
 * strings (house rule); measured spec inputs: the run-03 post-fold verbatim
 * extraction (goal gap) + pi 0.87.1 compaction source (the takeover hook
 * shape, previousSummary carry).
 */

import { AUDIT_INSTRUCTION_PREFIX, UNDO_ACK_PREFIX, AUTO_STUB_PREFIX } from "./protocol.ts";

/* ── the goal record (append-only ledger entry, `v: 1`, kind "goal") ────── */

export const GOAL_RECORD_KIND = "goal" as const;

export type GoalBasis = "adjust-goal" | "takeover-fallback";

export interface SamGoalRecord {
	v: 1;
	kind: "goal";
	/** the goal text, verbatim (adjust-goal: model-authored; fallback: user input + 1 agent turn) */
	text: string;
	ts: number;
	basis: GoalBasis;
	/** fallback only: the entry ids the capture came from (provenance, F1) */
	userEntryId?: string;
	turnEntryIds?: string[];
}

/** Loose entry view (PlainEntry `kind` AND raw `type` both match — total). */
export interface GoalEntry {
	id?: string;
	kind?: string;
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown } | undefined;
}

function goalTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as unknown[])
			.map((b) => (b && typeof b === "object" && "text" in (b as object) ? String((b as { text?: unknown }).text ?? "") : ""))
			.join("");
	}
	return "";
}

/** Type guard for a goal record payload (ledger-parse level). */
export function isGoalRecord(data: unknown): data is SamGoalRecord {
	if (!data || typeof data !== "object") return false;
	const r = data as Record<string, unknown>;
	if (r.v !== 1 || r.kind !== "goal") return false;
	if (typeof r.text !== "string" || r.text.trim() === "") return false;
	if (typeof r.ts !== "number") return false;
	if (r.basis !== "adjust-goal" && r.basis !== "takeover-fallback") return false;
	if (r.userEntryId !== undefined && typeof r.userEntryId !== "string") return false;
	if (r.turnEntryIds !== undefined && (!Array.isArray(r.turnEntryIds) || !r.turnEntryIds.every((x) => typeof x === "string"))) return false;
	return true;
}

/** All goal records on a branch, in branch order (oldest first). */
export function goalRecords(entries: readonly GoalEntry[]): SamGoalRecord[] {
	const out: SamGoalRecord[] = [];
	for (const e of entries) {
		if (e.kind !== "custom" && e.type !== "custom") continue;
		if (e.customType !== "sam") continue;
		if (isGoalRecord(e.data)) out.push(e.data);
	}
	return out;
}

/** The LATEST goal (latest-wins — the newest record in branch order). */
export function latestGoal(entries: readonly GoalEntry[]): SamGoalRecord | undefined {
	const all = goalRecords(entries);
	return all.length > 0 ? all[all.length - 1] : undefined;
}

/* ── the deterministic fallback capture (user input + n agent turns) ────── */

interface RealUserHit {
	index: number;
	id?: string;
	text: string;
}

/**
 * The LAST real (non-SAM-injected) user message on the branch — the
 * goal-defining input (the task prompt, or the latest steering/answer).
 * `[sam-`-prefixed injections (nudges, audit instructions, undo acks, stub
 * requests) are extension noise, never user input (the F4 convention).
 */
export function lastRealUserMessage(entries: readonly GoalEntry[]): RealUserHit | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.message?.role !== "user") continue;
		const t = goalTextOf(e.message.content).trim();
		if (t === "") continue;
		if (t.startsWith("[sam-")) continue;
		if (t.startsWith(AUDIT_INSTRUCTION_PREFIX) || t.startsWith(UNDO_ACK_PREFIX) || t.startsWith(AUTO_STUB_PREFIX)) continue;
		return { index: i, id: e.id, text: t };
	}
	return undefined;
}

/**
 * The first n assistant TEXT turns after index (the agent turns — Paul's
 * "n agent turns verbatim"; n = 1 decided). Thinking blocks are excluded:
 * internal deliberation is not goal content, and the text is what states
 * the model's understanding. Tool-call-only assistant entries produce empty
 * text and are skipped (they are not a turn of substance).
 */
export function agentTurnsAfter(entries: readonly GoalEntry[], afterIndex: number, n: number): { id?: string; text: string }[] {
	const out: { id?: string; text: string }[] = [];
	for (let i = afterIndex + 1; i < entries.length && out.length < n; i++) {
		const e = entries[i];
		if (e.message?.role !== "assistant") continue;
		const t = goalTextOf(e.message.content).trim();
		if (t === "") continue;
		out.push({ id: e.id, text: t });
	}
	return out;
}

/** The fallback goal (D11, pure): latest real user input + n agent turns verbatim. */
export function fallbackGoal(
	entries: readonly GoalEntry[],
	n: number,
	now: number,
): { record: SamGoalRecord; userText: string; turns: { id?: string; text: string }[] } | undefined {
	const user = lastRealUserMessage(entries);
	if (user === undefined) return undefined;
	const turns = agentTurnsAfter(entries, user.index, n);
	const parts: string[] = [];
	parts.push(`GOAL FALLBACK — captured verbatim because adjust_goal was not called (latest real user input + ${n} agent turn(s)):`);
	parts.push(`USER INPUT: ${user.text}`);
	turns.forEach((t, i) => {
		parts.push(`AGENT TURN ${i + 1}: ${t.text}`);
	});
	return {
		record: {
			v: 1,
			kind: "goal",
			text: parts.join("\n"),
			ts: now,
			basis: "takeover-fallback",
			userEntryId: user.id,
			turnEntryIds: turns.map((t) => t.id).filter((x): x is string => x !== undefined),
		},
		userText: user.text,
		turns,
	};
}

/* ── summary rendering (pinned wording; the takeover consumes these) ────── */

/** Pinned: the goal block's closing marker line (the strip anchor). */
export const GOAL_BLOCK_MARKER = "[end of goal]";

/** Pinned: the adjust-goal block header (ts stamped at capture). */
export function goalBlockHeader(ts: number): string {
	return `Goal (stored ${new Date(ts).toISOString()} via adjust_goal — latest version, replaces earlier ones):`;
}

/** Pinned: the fallback block header (the capture itself is labelled in the text). */
export const GOAL_FALLBACK_HEADER =
	"Goal (takeover fallback — adjust_goal was never called after the goal-defining input; capture below is verbatim session content):";

/** Soft wrap at width (cosmetic display only — no content change): hard newlines
 *  preserved, lines broken at spaces, unbreakable words hard-chunked (deterministic). */
export function softWrap(text: string, width = 96): string {
	if (width <= 0) return text;
	const out: string[] = [];
	for (const hard of text.split("\n")) {
		if (hard.trim() === "") {
			out.push(""); // a blank line inside the text stays a blank line
			continue;
		}
		let cur = "";
		for (const w of hard.split(" ")) {
			if (w === "") continue; // collapse runs of spaces
			const candidate = cur === "" ? w : cur + " " + w;
			if (candidate.length <= width) {
				cur = candidate;
				continue;
			}
			if (cur !== "") out.push(cur);
			if (w.length > width) {
				for (let i = 0; i < w.length; i += width) out.push(w.slice(i, i + width));
				cur = "";
			} else {
				cur = w;
			}
		}
		if (cur !== "") out.push(cur);
	}
	return out.join("\n");
}

/**
 * Renders the goal block as it appears at the HEAD of the takeover summary.
 * adjust-goal: header + the stored text (soft-wrapped) + marker.
 * fallback: fallback header + the capture text (already labelled per-turn).
 */
export function goalBlock(record: SamGoalRecord): string {
	const header = record.basis === "takeover-fallback" ? GOAL_FALLBACK_HEADER : goalBlockHeader(record.ts);
	const body = softWrap(record.text);
	return `${header}\n${body}\n${GOAL_BLOCK_MARKER}`;
}

/** The first lines that identify OUR goal block (deterministic strip detection). */
const GOAL_HEADER_PREFIXES = [
	"Goal (stored ", // adjust-goal (goalBlockHeader always starts with this)
	"Goal (takeover fallback —", // fallback (GOAL_FALLBACK_HEADER)
];

/**
 * Strips a goal block this extension authored (pinned shape) from the head
 * of a carried previous summary, so a new fold re-emits ONLY the latest
 * version (replace semantics — Paul). Deterministic: it fires only on our
 * own pinned headers and removes through the first marker line (+ one
 * following blank line). Any other summary (pi-native prose, third-party
 * extensions) is returned UNTOUCHED — the strip can never corrupt content
 * it did not author (fail-safe).
 */
export function stripGoalBlock(summary: string): string {
	const t = summary;
	if (t === "") return t;
	const isOurs = GOAL_HEADER_PREFIXES.some((p) => t.startsWith(p));
	if (!isOurs) return t;
	const lines = t.split("\n");
	const marker = lines.indexOf(GOAL_BLOCK_MARKER, 1);
	if (marker === -1) return t; // malformed (never ours) — leave untouched
	const cut = marker + 1;
	// one following blank line (we join blocks with a blank line)
	if (cut < lines.length && lines[cut].trim() === "") return lines.slice(cut + 1).join("\n");
	return lines.slice(cut).join("\n");
}

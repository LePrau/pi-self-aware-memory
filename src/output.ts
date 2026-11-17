/**
 * Pure output helpers for the /sam surface.
 *
 * Everything here is a plain function of its inputs — no pi API, no I/O —
 * so the test suite can pin the exact text a user sees. The entry point
 * (extensions/self-aware-memory/index.ts) decides the *channel* (UI
 * notification vs. console) from ctx.mode/ctx.hasUI; this module only
 * decides the *words*.
 */
import { EXTENSION_NAME, SAM_VERSION } from "./identity.ts";
import type { SamLedger, SamUnit } from "./ledger.ts";
import { buildReportBoard } from "./report-ui.ts"; // v0.0.38: the static report renders the same pure board as the TUI
import { renderSamStatusLine, scaleSamStatusLine, type SamStatusLineInput } from "./statusbar.ts";
import type { SamCounts, SamState } from "./state.ts";

/** pi's own pressure ruler (ctx.getContextUsage()); shape copied verbatim. */
export interface SamUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** The session's current model, as pi exposes it (provider/id pair). */
export interface SamModelInfo {
	provider: string;
	id: string;
}

/** D11 (2026-10-02): the goal surface view for the status line. */
export interface SamGoalView {
	/** the current (latest) goal — undefined when none stored */
	text?: string;
	basis?: "adjust-goal" | "takeover-fallback";
	ts?: number;
	/** earlier versions kept in the ledger (tombstones) */
	earlier: number;
}

export interface SamStatusInput {
	state: SamState;
	/** Undefined before the first LLM response of the session. */
	usage?: SamUsage;
	/** Undefined when no model is selected. */
	model?: SamModelInfo;
	/** D11: the stored goal (latest-wins; earlier versions = tombstones). */
	goal?: SamGoalView;
	/** v0.0.15 (Paul, 2026-10-19): the context bar — when present, the bar line
	 *  renders directly after the `context:` line. */
	contextBar?: SamStatusLineInput;
}

function contextLine(usage: SamUsage | undefined): string {
	if (usage === undefined) return "context: unknown (no usage yet)";
	if (usage.tokens === null)
		return `context: ? / ${fmt(usage.contextWindow)} (tokens unknown — right after start or compaction)`;
	const pct = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
	return `context: ${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} (${pct})`;
}

/** Deterministic grouping; node's full-icu build makes "en-US" stable. */
function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function countsLine(counts: SamCounts): string {
	return (
		`units: folded ${counts.folded} · refused ${counts.refused}` +
		` · undone ${counts.undone} · resolved ${counts.resolved}` +
		` · in flight ${counts.inFlight}`
	);
}

/** The P3 governor extras (optional — the surface stays honest when absent). */
export interface SamGovernorView {
	zone?: string | null;
	window?: number;
	reserve?: number;
	keepRecent?: number;
	foreignFolder?: { present: boolean; basis: string };
	rebuilds?: { continuity: number; "idle-expiry": number; foreign: number };
}

/**
 * Render the /sam status block, one line per array element.
 *
 * Honesty rule (P0, kept): the block says plainly what the current phase
 * can and cannot do.
 */
export function renderSamStatus(
	input: SamStatusInput,
	counts: SamCounts,
	governor?: SamGovernorView,
): string[] {
	const { state, usage, model } = input;
	const modelLine = model ? `model: ${model.provider}/${model.id}` : "model: none";
	const inFlight = state.pendingUndo !== null ? " · undo in flight" : "";
	const lines = [
		`── sam ── ${EXTENSION_NAME} ${SAM_VERSION} ──`,
		modelLine,
		contextLine(usage),
	];
	// v0.0.34: lift the chars/4 fields to the API token scale of `tokens` (the
	// bar geometry assumes both live on the same scale).
	if (input.contextBar !== undefined) lines.push(renderSamStatusLine(scaleSamStatusLine(input.contextBar))); // v0.0.15: the context bar, right after the context line
	lines.push(`${countsLine(counts)}${inFlight}`);
	if (input.goal !== undefined) {
		const g = input.goal;
		const goalText = g.text;
		if (goalText !== undefined) {
			const basis = g.basis === "takeover-fallback" ? "takeover fallback (adjust_goal never called)" : "adjust_goal";
			lines.push(
				`goal: stored (${goalText.length} chars, ${basis}, ${g.ts !== undefined ? new Date(g.ts).toISOString() : "?"})` +
				(g.earlier > 0 ? ` · ${g.earlier} earlier version(s) in the ledger (tombstones — read_goal)` : "") +
				" · rides every compaction first",
			);
		} else {
			lines.push(`goal: none stored — set it with adjust_goal as soon as the goal is clear (D11)`);
		}
	}
	if (governor?.zone && governor.window) {
		lines.push(
			`governor: zone ${governor.zone} (window ${fmt(governor.window)}, reserve ${fmt(governor.reserve ?? 0)}, keep ${fmt(governor.keepRecent ?? 0)})`,
		);
	}
	if (governor?.foreignFolder?.present) {
		lines.push(`coexistence: ${governor.foreignFolder.basis} — folds refused while active (D2)`);
	}
	if (governor?.rebuilds) {
		const { continuity, "idle-expiry": idle, foreign } = governor.rebuilds;
		if (continuity + idle + foreign > 0) lines.push(`cache: ${continuity + idle + foreign} rebuild(s) (${continuity} ours · ${idle} idle · ${foreign} foreign)`);
	}
	lines.push(
		"commands: /sam · /sam report · /sam undo · /sam fold <n> · /sam resolve <n>",
	);
	return lines;
}

/**
 * Render /sam report (the non-TUI fallback of the v0.0.38 report UI), one
 * line per array element.
 *
 * The report is the user-facing face of the ledger: every unit with its
 * state, verdict, and (for folds) the pre-fold token estimate pi's own ruler
 * gave — plus the stub's first line, the retired units (latest-wins), the
 * orphaned units (unaudited, with their retrieval id), and the current goal
 * at the bottom. The interactive TUI (report-ui.ts) renders the same board;
 * this text form carries the same facts flat.
 *
 * orphanRows: the orphan records with a minted unitId that are NOT ledger
 * units (they only consume unit-id space — ledger.ts: rebuildLedger does not
 * upsert them), oldest first.
 */
export function renderSamReport(
	ledger: SamLedger,
	orphanRows: readonly { unitId: number; retrievalId: string; stubLine?: string; ts?: number }[] = [],
	/** v0.0.41: the TIME column (unitId → the close record's `ts`) */
	closeTs?: ReadonlyMap<number, number>,
): string[] {
	const board = buildReportBoard({
		units: ledger.units,
		orphanRows: orphanRows.map((o) => ({ unitId: o.unitId, retrievalId: o.retrievalId, stubLine: o.stubLine, ts: o.ts })),
		retirements: ledger.retirements,
		goal: ledger.goals.length > 0 ? ledger.goals[ledger.goals.length - 1] : undefined,
		closeTs,
	});
	if (board.rows.length === 0 && board.droppedRows.length === 0) return ["no units yet (close_unit closes one)"];
	const lines: string[] = [board.header];
	for (const r of board.rows) {
		if (r.kind === "retirement") {
			// v0.0.40: a retirement unit at its creation spot (or the single
			// "dropped (…)" row for carrier-less drops) — the subtree itself
			// is the TUI's territory; the static text names its children.
			const kids = r.unitId !== undefined
				? board.subtrees.find((s) => s.unitId === r.unitId)?.rows ?? []
				: board.droppedRows;
			lines.push(`${r.label}${r.unitId !== undefined ? ` (supersedes)` : ""}${r.time !== undefined ? ` · ${r.time}` : ""}: ${r.verdict} — ${kids.length > 0 ? kids.map((k) => k.label).join(", ") : "(nothing left — all un-retired)"} (subtree: /sam report in the TUI)`);
			continue;
		}
		if (r.kind === "goal") {
			lines.push(`current goal${r.time !== undefined ? ` · ${r.time}` : ""}: ${r.verdict} (full text: /sam goal)`);
			continue;
		}
		const unit = r.unitId !== undefined ? ledger.units.find((u) => u.unitId === r.unitId) : undefined;
		if (unit === undefined) {
			// orphan row (the id exists only in the orphan records)
			lines.push(`unit ${r.unitId}: orphaned (unaudited)${r.time !== undefined ? ` · ${r.time}` : ""} · retrieval ${r.retrievalId} — ${r.stubLine ?? "raw span banked"}`);
			continue;
		}
		lines.push(`unit ${unit.unitId}: ${unit.state}${unitLineDetail(unit)}${r.time !== undefined ? ` · ${r.time}` : ""}${r.stubLine !== undefined ? ` — ${r.stubLine}` : ""}`);
	}
	return lines;
}

function unitLineDetail(unit: SamUnit): string {
	const verdict = unit.verdict !== undefined ? ` · ${unit.verdict.class}` : "";
	if (unit.state === "folded") {
		const before = unit.beforeTokens !== undefined && unit.beforeTokens !== null ? ` · pre-fold ${fmt(unit.beforeTokens)} tokens (pi estimate)` : "";
		const corr = unit.corrections ? ` · corrections: ${unit.corrections}` : "";
		const sweep = unit.sweep ? ` · ${unit.sweep} sweep` : "";
		const timing = unit.commitTiming ? ` · cache ${unit.commitTiming}` : "";
		return `${verdict}${before}${corr}${sweep}${timing}`;
	}
	if (unit.state === "refused") {
		const corr = unit.corrections ? ` · ${unit.corrections}` : "";
		const gate = unit.gateReasons && unit.gateReasons.length > 0 ? ` · gates: ${unit.gateReasons[0]}…` : "";
		const reason = unit.reason ?? (unit.verdict !== undefined ? `verdict ${unit.verdict.class}` : "no fold");
		return ` · ${reason}${corr}${gate}`;
	}
	if (unit.state === "undone") return ` · restored to original view${verdict}`;
	if (unit.state === "resolved") return ` · tombstone — ${unit.resolvedBasis ?? "resolved"}${verdict}`;
	return ` · awaiting audit${verdict}`;
}

/**
 * Where /sam output goes, per run mode.
 *
 * - dialog-capable UI (tui, rpc): a notification, exactly like the
 *   built-in commands report themselves;
 * - print mode: stderr — stdout carries the assistant's text and must stay
 *   clean;
 * - json mode: nowhere. stdout is the JSON event stream and a stray plain
 *   line would break consumers; the status is then available in the
 *   session file ledger (custom `sam` entries).
 */
export type SamChannel = "ui" | "stderr" | "none";

export function samOutputChannel(hasUI: boolean, mode: "tui" | "rpc" | "json" | "print"): SamChannel {
	if (hasUI) return "ui";
	if (mode === "json") return "none";
	return "stderr";
}

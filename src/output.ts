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
	probeUrl?: string | null;
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
	const inFlight =
		state.audit !== null ? " · audit in flight" : state.pendingUndo !== null ? " · undo in flight" : "";
	const lines = [
		`── sam ── ${EXTENSION_NAME} ${SAM_VERSION} ──`,
		`mode: ${state.mode}   [${phaseNote(state.mode)}]`,
		modelLine,
		contextLine(usage),
		`${countsLine(counts)}${inFlight}`,
	];
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
	if (governor?.probeUrl) {
		lines.push(`probe: ${governor.probeUrl} (deferral-only, positive; ?autoload=false mandatory)`);
	} else {
		lines.push(`probe: off (default)`);
	}
	lines.push(
		"commands: /sam · /sam mode <display|manual|assisted|auto> · /sam report · /sam undo · /sam fold <n> · /sam resolve <n>",
	);
	return lines;
}

/** What the current phase can and cannot do, stated in the status itself. */
function phaseNote(mode: string): string {
	if (mode === "display") return "audits units, never folds";
	if (mode === "manual") return "verified units fold at close_unit; /sam fold overrides a CORRECTIONS unit";
	if (mode === "assisted") return "folds at close + sweeps audited units at high pressure (keep-window and gate-restricted)";
	if (mode === "auto") return "assisted + unmarked-block stubs when pressure stays high (escape hatch)";
	return `mode '${mode}'`;
}

/**
 * Render /sam report, one line per array element.
 *
 * The report is the user-facing face of the ledger: every unit, its state,
 * verdict, and (for folds) the pre-fold token estimate pi's own ruler gave.
 */
export function renderSamReport(ledger: SamLedger): string[] {
	const lines: string[] = [];
	if (ledger.units.length === 0) {
		lines.push("no units yet (close_unit closes one)");
		return lines;
	}
	for (const unit of ledger.units) {
		lines.push(`unit ${unit.unitId}: ${unit.state}${unitLineDetail(unit)}`);
	}
	return lines;
}

function unitLineDetail(unit: SamUnit): string {
	if (unit.state === "folded") {
		const before = unit.beforeTokens !== undefined && unit.beforeTokens !== null ? ` · pre-fold ${fmt(unit.beforeTokens)} tokens (pi estimate)` : "";
		const corr = unit.corrections ? ` · corrections: ${unit.corrections}` : "";
		const sweep = unit.sweep ? ` · ${unit.sweep} sweep` : "";
		const timing = unit.commitTiming ? ` · cache ${unit.commitTiming}` : "";
		return `${corr}${before}${sweep}${timing}`;
	}
	if (unit.state === "refused") {
		const corr = unit.corrections ? ` · ${unit.corrections}` : "";
		const gate = unit.gateReasons && unit.gateReasons.length > 0 ? ` · gates: ${unit.gateReasons[0]}…` : "";
		return ` (${unit.reason ?? unit.verdict?.class ?? "no fold"}${corr}${gate})`;
	}
	if (unit.state === "undone") return " (restored to original view)";
	if (unit.state === "resolved") return ` (tombstone — ${unit.resolvedBasis ?? "resolved"})`;
	return " (awaiting audit)";
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

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

export interface SamStatusInput {
	state: SamState;
	/** Undefined before the first LLM response of the session. */
	usage?: SamUsage;
	/** Undefined when no model is selected. */
	model?: SamModelInfo;
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
		` · undone ${counts.undone} · in flight ${counts.inFlight}`
	);
}

/**
 * Render the /sam status block, one line per array element.
 *
 * Honesty rule (P0, kept): the block says plainly what the current phase
 * can and cannot do.
 */
export function renderSamStatus(input: SamStatusInput, counts: SamCounts): string[] {
	const { state, usage, model } = input;
	const modelLine = model ? `model: ${model.provider}/${model.id}` : "model: none";
	const inFlight =
		state.audit !== null ? " · audit in flight" : state.pendingUndo !== null ? " · undo in flight" : "";
	return [
		`── sam ── ${EXTENSION_NAME} ${SAM_VERSION} ──`,
		`mode: ${state.mode}   [${phaseNote(state.mode)}]`,
		modelLine,
		contextLine(usage),
		`${countsLine(counts)}${inFlight}`,
		"commands: /sam · /sam mode <display|manual> · /sam report · /sam undo   (assisted/auto + /sam fold: not yet — P3)",
	];
}

/** What the current phase can and cannot do, stated in the status itself. */
function phaseNote(mode: string): string {
	if (mode === "display") return "P2 — display mode: units are audited, never folded";
	if (mode === "manual") return "P2 — manual mode: verified units fold at close_unit";
	return `P2 — mode '${mode}' is not yet implemented (P3); acting as manual`;
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
		return `${corr}${before}`;
	}
	if (unit.state === "refused") {
		const corr = unit.corrections ? ` · ${unit.corrections}` : "";
		return ` (${unit.reason ?? unit.verdict?.class ?? "no fold"}${corr})`;
	}
	if (unit.state === "undone") return " (restored to original view)";
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

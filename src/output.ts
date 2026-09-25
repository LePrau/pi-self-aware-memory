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
import type { SamState } from "./state.ts";

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
  const pct = usage.percent !== null ? `${usage.percent.toFixed(1)} %` : "? %";
  return `context: ${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} (${pct})`;
}

/** Deterministic grouping; node's full-icu build makes "en-US" stable. */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Render the /sam status block, one line per array element.
 *
 * P0 honesty rule: the block says plainly that the scaffold folds nothing,
 * and which subcommands are still stubs. That line is replaced phase by
 * phase — never silently.
 */
export function renderSamStatus(input: SamStatusInput): string[] {
  const { state, usage, model } = input;
  const modelLine = model ? `model: ${model.provider}/${model.id}` : "model: none";
  const counts =
    `units: open ${state.openUnits} · closed ${state.closedUnits}` +
    ` · folds ${state.folds} · audits ${state.audits}` +
    (state.inFlight > 0 ? " · audit in flight" : "");
  return [
    `── sam ── ${EXTENSION_NAME} ${SAM_VERSION} ──`,
    `mode: ${state.mode}   [${phaseNote()}]`,
    modelLine,
    contextLine(usage),
    counts,
    "commands: /sam · /sam mode <m>   (fold · report · undo: not yet — P2)",
  ];
}

/** What the current phase can and cannot do, stated in the status itself. */
function phaseNote(): string {
  return "P0 scaffold — loads and reports only, folds nothing in any mode";
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
 *   session file once P2 adds the ledger.
 */
export type SamChannel = "ui" | "stderr" | "none";

export function samOutputChannel(hasUI: boolean, mode: "tui" | "rpc" | "json" | "print"): SamChannel {
  if (hasUI) return "ui";
  if (mode === "json") return "none";
  return "stderr";
}

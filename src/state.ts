/**
 * In-memory session state for the extension.
 *
 * P0 (scaffold): only `mode` can change, via `/sam mode`. Everything else
 * stays at its zero value — nothing is marked, closed, audited or folded
 * yet. From P2 on this state is rebuilt from the extension's own ledger
 * entries (append-only custom entries in the session file) on load, so a
 * resume reproduces exactly what the previous process knew.
 *
 * Deliberately process-local: one pi process drives one session at a time.
 */

/** Operating modes (plan §2). D5 default for a fresh install: `manual`. */
export const SAM_MODES = ["display", "manual", "assisted", "auto"] as const;
export type SamMode = (typeof SAM_MODES)[number];
export const DEFAULT_SAM_MODE: SamMode = "manual";

export interface SamState {
  /** Current mode; selects when (never whether) the governor may act. */
  mode: SamMode;
  /** Units the agent has opened and not yet closed. */
  openUnits: number;
  /** Units closed since session start (stub written, awaiting audit). */
  closedUnits: number;
  /** Folds committed via pi's append-only context edits. */
  folds: number;
  /** Audit turns completed (in-series, same warm prefix). */
  audits: number;
  /** Audit turns in flight; hard rule F7 keeps this at 0 or 1. */
  inFlight: number;
}

export function createSamState(): SamState {
  return {
    mode: DEFAULT_SAM_MODE,
    openUnits: 0,
    closedUnits: 0,
    folds: 0,
    audits: 0,
    inFlight: 0,
  };
}

export function isSamMode(value: string): value is SamMode {
  return (SAM_MODES as readonly string[]).includes(value);
}

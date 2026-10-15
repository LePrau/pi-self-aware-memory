/**
 * Identity constants for the extension.
 *
 * The version here must match `package.json` (checked by the test suite);
 * status lines carry it so a user can tell which build answered `/sam`.
 */
export const EXTENSION_NAME = "pi-self-aware-memory";
export const SAM_VERSION = "0.0.6"; // v0.0.6 (2026-10-15): summary-sizing fix — the carried previous summary's old settlement layers are ALWAYS stripped (the retire-gate is gone — kills the measured O(N²) accumulation, session 01a13a33) + carried-orphan cap (SAM_ORPHAN_KEEP, default 2; the current fold's own orphan is never capped ⇒ ≤ keep + 1)

/** One-line build description for status/announce output. */
export function describeBuild(): string {
  return (
    `${EXTENSION_NAME} ${SAM_VERSION}` +
    (typeof process !== "undefined" ? ` (node ${process.version})` : "")
  );
}

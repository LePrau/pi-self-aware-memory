/**
 * Identity constants for the extension.
 *
 * The version here must match `package.json` (checked by the test suite);
 * status lines carry it so a user can tell which build answered `/sam`.
 */
export const EXTENSION_NAME = "pi-self-aware-memory";
export const SAM_VERSION = "0.0.10"; // v0.0.10 (2026-10-17): the medium audit tier — a depth between light and full for the routine close (auto: light at/above W−2R, MEDIUM below, full explicit-only), the PLAUSIBLE verdict ("not the same as verified, but holds up after a quick check"; acceptable at medium and full; a per-fact `plausible:` marker in the sections), the close_unit `depth` argument (upgrade-only lever), and the depth-bound line-1 acceptance matrix (light unchanged; medium adds PLAUSIBLE + NOT-YET-VERIFIED; full adds PLAUSIBLE)

/** One-line build description for status/announce output. */
export function describeBuild(): string {
  return (
    `${EXTENSION_NAME} ${SAM_VERSION}` +
    (typeof process !== "undefined" ? ` (node ${process.version})` : "")
  );
}

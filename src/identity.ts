/**
 * Identity constants for the extension.
 *
 * The version here must match `package.json` (checked by the test suite);
 * status lines carry it so a user can tell which build answered `/sam`.
 */
export const EXTENSION_NAME = "pi-self-aware-memory";
export const SAM_VERSION = "0.0.7"; // v0.0.7 (2026-10-16): context-pressure safenet (decision point 1) — the post-fold pressure nudge (act-now, consumes the retire offer), the armed auto-retire committed at the next fold (dedicated `autoRetire` ledger kind + synthesized AUTO-RETIRE settlement + matryoshka absorption), orphans minted a unitId at fold time (retirable/unretirable/sam_retrieve-able), and the deployed compaction values (reserveTokens/keepRecentTokens) read into the pressure line

/** One-line build description for status/announce output. */
export function describeBuild(): string {
  return (
    `${EXTENSION_NAME} ${SAM_VERSION}` +
    (typeof process !== "undefined" ? ` (node ${process.version})` : "")
  );
}

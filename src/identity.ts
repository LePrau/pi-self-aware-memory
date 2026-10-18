/**
 * Identity constants for the extension.
 *
 * The version here must match `package.json` (checked by the test suite);
 * status lines carry it so a user can tell which build answered `/sam`.
 */
export const EXTENSION_NAME = "pi-self-aware-memory";
export const SAM_VERSION = "0.0.13"; // v0.0.13 (2026-10-18): RETIRE-CENSUS + SAFENET PARITY FIX — the post-fold retirement offer and the armed auto-retire now count EXACTLY what the next summary would push: the census renders dropped units as GONE (pre-fix it counted their full blocks — measured 2026-10-18: 30 records / ~115k claimed vs ~9.5k actually rendered, and the 'largest' were units retired 12 hours earlier), superseded units as the one-line forward link, and live units with their 'supersedes' metadata; the auto-retire select's stop condition seeds `retiredIds` with the already-retired units (pre-fix the empty set counted their chars, so 'stop once under target' could never be reached and the loop over-retired every candidate). The takeover render (branchaudit) was already correct — the fix makes the two other sites mirror it (same render semantics, call-site-only coupling). Built on v0.0.12 (2026-10-18): native-fold auto-ack

/** One-line build description for status/announce output. */
export function describeBuild(): string {
  return (
    `${EXTENSION_NAME} ${SAM_VERSION}` +
    (typeof process !== "undefined" ? ` (node ${process.version})` : "")
  );
}

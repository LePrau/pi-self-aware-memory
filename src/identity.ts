/**
 * Identity constants for the extension.
 *
 * The version here must match `package.json` (checked by the test suite);
 * status lines carry it so a user can tell which build answered `/sam`.
 */
export const EXTENSION_NAME = "pi-self-aware-memory";
export const SAM_VERSION = "0.0.9"; // v0.0.9 (2026-10-17): legacy-code-eviction wave A — the followUp + steer audit-delivery arms are out (the close's audit is delivered synchronously inside close_unit, the only delivery since 2026-10-05), the user-facing branch surface (/sam audit, /sam settle, the branch delivery mode) is out (the audit child now runs as the internal sam-prepare-audit command), the provider-busyness probe is extracted to the dev repo (probe/provider-probe-base.ts), and the SAM_AUDIT_DELIVERY + SAM_PROVIDER_PROBE_URL dials are out (13 → 11 operator dials)

/** One-line build description for status/announce output. */
export function describeBuild(): string {
  return (
    `${EXTENSION_NAME} ${SAM_VERSION}` +
    (typeof process !== "undefined" ? ` (node ${process.version})` : "")
  );
}

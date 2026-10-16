/**
 * Identity constants for the extension.
 *
 * The version here must match `package.json` (checked by the test suite);
 * status lines carry it so a user can tell which build answered `/sam`.
 */
export const EXTENSION_NAME = "pi-self-aware-memory";
export const SAM_VERSION = "0.0.8"; // v0.0.8 (2026-10-16): governor-mode removal — `manual` is the only behaviour (the display/assisted/auto modes, their sweep/backoff machinery and the `/sam mode` command are gone; the 2026-10-16 legacy-code-eviction wave) — plus the `SAM_COMPACTED_SPAN=refuse` opt-out removed (the compaction-owned tombstone is the only compacted-span policy). Old `kind:"mode"` records and the `mode` fields on old close/fold/noFold records still parse (fossils)

/** One-line build description for status/announce output. */
export function describeBuild(): string {
  return (
    `${EXTENSION_NAME} ${SAM_VERSION}` +
    (typeof process !== "undefined" ? ` (node ${process.version})` : "")
  );
}

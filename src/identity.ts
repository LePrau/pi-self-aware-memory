/**
 * Identity constants for the extension.
 *
 * The version here must match `package.json` (checked by the test suite);
 * status lines carry it so a user can tell which build answered `/sam`.
 */
export const EXTENSION_NAME = "pi-self-aware-memory";
export const SAM_VERSION = "0.0.1";

/** One-line build description for status/announce output. */
export function describeBuild(): string {
  return (
    `${EXTENSION_NAME} ${SAM_VERSION}` +
    (typeof process !== "undefined" ? ` (node ${process.version})` : "")
  );
}

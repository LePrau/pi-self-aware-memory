/**
 * Identity constants for the extension.
 *
 * The version here must match `package.json` (checked by the test suite);
 * status lines carry it so a user can tell which build answered `/sam`.
 */
export const EXTENSION_NAME = "pi-self-aware-memory";
export const SAM_VERSION = "0.0.12"; // v0.0.12 (2026-10-18): native-fold auto-ack — pi's own threshold/overflow compactions now inform the model: the sam-fold-ack is sent triggerTurn (measured pi 0.87.1: while streaming ⇒ steer + pi's own hasQueuedMessages() continuation ⇒ the new LLM call STARTS with the ack, no user post needed; not streaming ⇒ one short ack turn — the rare pre-send case, option 1); native fold FAILURES auto-ack too (the model must not assume the context shrank); the user's /compact keeps deliverAs:"nextTurn" (Paul's ruling: never auto-start inference while the user is about to type). Built on v0.0.11 (2026-10-18): the full audit's NOT-YET-VERIFIED + the audit-child deadline nudge

/** One-line build description for status/announce output. */
export function describeBuild(): string {
  return (
    `${EXTENSION_NAME} ${SAM_VERSION}` +
    (typeof process !== "undefined" ? ` (node ${process.version})` : "")
  );
}

# Changelog

## Unreleased — P2 (minimal end-to-end loop)

Version stays 0.0.1 (tag v0.1.0 at P5 per plan).

- `close_unit` tool: closes the current work unit with a stub (1-4 sentences,
  observed facts, not task claims). One close per turn (second call refused);
  cross-turn duplicate closes refused idempotently.
- In-series auditor: after a close, pi receives one queued `[sam-audit]` user
  message (`deliverAs: "followUp"`) plus `continue: true` — a genuine in-series
  turn where the same model on the same warm prefix replies exactly
  `VERIFIED` or `CORRECTIONS: <list>`. Only VERIFIED folds; CORRECTIONS /
  UNAUDITABLE produce a `noFold` ledger record and the raw span stays in view.
- Folder: fold commits pi `context_edit` drafts at the settle that captured the
  verdict (first span entry → `[Unit <n> ✓] <stub>` string; later span entries →
  null/omit). The audit exchange stays in the projection; the session file keeps
  every original byte.
- Ledger: append-only `sam` custom entries (`close`, `fold`, `noFold`, `undo`,
  `mode`; `beforeTokens` from pi's own estimate at commit). Rebuilt from the
  session file at every `session_start` (resume/reload/new/fork/startup);
  in-flight state (pending verdicts, pending re-audits) restored; malformed
  records counted and announced, never thrown.
- `/sam` surface: status (bare `/sam`), `mode <display|manual>` (assisted/auto
  named "not yet — P3"), `report` (per-unit table), `undo` (restores the last
  folded unit by riding one short controlled ack turn, same in-series
  discipline as the audit). `fold` stays a "not yet" stub.
- Pure modules in `src/` (protocol, verdict, units, folder, projection,
  estimate, ledger, state, output); only `extensions/self-aware-memory/index.ts`
  touches the pi API. Zero runtime dependencies (plain JSON schema for the tool
  parameters).
- Test suite: `node --test` (92 tests; the `pi-semantics` cross-check against pi
  v0.87.1's real `SessionManager` + `estimateProjectedContextTokens` runs when
  `SAM_PI_DIR` is set, skips otherwise).

## 0.0.1 — 2026-09-25 (scaffold)

- Initial scaffold as a pi package: `package.json` with the `pi` manifest,
  `extensions/self-aware-memory/index.ts` entry, `src/` (identity, state, output),
  zero runtime dependencies.
- `/sam` status surface and one-line announce at session start; `mode` subcommand
  (in-memory, session-local); `fold`/`report`/`undo` registered as honest "not yet" stubs.
- No session mutation in any code path: no tools, no entries, no context edits, no
  messages; fail-open status handlers.
- `node --test` suite (state, output, factory wiring against a fake ExtensionAPI).
- Typecheck harness (`typecheck/run-typecheck.sh`) with version floor, `PI_EXPECT` pin
  and `CONTROL=1` seeded-error discipline.

# Changelog

## Unreleased — P3 (governor and safety; implemented 2026-09-30)

Version stays 0.0.1 (tag v0.1.0 at P5 per plan). P3 verdict: **pass** — suite 167/167 (6
documented env-gated skips), typecheck CLEAN vs pi 0.87.1, walk 6/6 arms green, s5
replay-eval green (evidence: dev repo `2026-09-30-p3-design.md` + §P3 verdict in the plan).

- **Gates before any draft exists** (`src/gates.ts`): every fold candidate is validated
  in-band *before* a single `context_edit` draft — target existence + editability,
  tool↔result pairing, span overlap with already-folded (non-editable) content, net
  saving ≥ 10 %, fold ceiling, window fit, and (auto folds only) the keep-window threat
  predicate. Refusals carry a machine- and model-readable reason. This is the structural
  countermeasure to the measured s5 silent whole-batch discards (pi 0.87.1 discards a
  corrupted draft batch with stderr only; the model never knew).
- **Commit proofs** (`src/commitproof.ts`): span fingerprint staged at close,
  re-validated at commit (append-only growth tolerated, structural drift invalidates,
  missing proof fails closed) + a session-start **orphan audit** (`lostFolds`) that
  tombstones any close whose fold never landed (new terminal `resolved` unit state,
  surfaced in `/sam` status and `report`). By construction the fold record rides the
  same atomic batch as its drafts, so "issued" and "committed" can no longer diverge
  silently (2026-09-30 carried finding #3).
- **Empty-stub refusal** (`src/extraction.ts`): `close_unit` with an empty stub over
  demonstrable work (tool results / non-trivial assistant text; transient diagnostics
  excluded, command-failure signals honoured) is refused at close — before any ledger
  mutation, before any audit — with the reason in the tool result ("call close_unit
  again with a real stub").
- **Governor** (`src/governor.ts`): pressure zones under pi's own `getContextUsage()`
  (F3 single ruler) with hysteresis band; mode semantics — `display` (never folds),
  `manual` (folds on close; default), `assisted` (+ settle-time sweep of closed units
  in the action zone, keep-window-gated), `auto` (+ proof-gated unmarked-span folds);
  R5 backoff (8-settle cooldown after non-terminal refusals); model-signature
  recompute at settle (pi 0.87.1 has no model-change event — measured).
- **D2 coexistence guard** (port of the om-guard `omPresence` *pattern*): while
  another folding folder is active per settings (`extensions` array authoritative;
  leftover block ignored; `enabled:false` = absent; present-but-unreadable ⇒
  conservative "assume present"; **missing settings file = readable ⇒ no foreign
  folder** — new measurement, prevents bricking fresh installs), SAM refuses to fold —
  including via `/sam fold`; audits and measurements continue and the session is never
  at risk.
- **Probe (default OFF)**: provider-busyness probe is opt-in; when on, async 8 s,
  positive-only, `?autoload=false` mandatory (the qube router is `--models-max 1`),
  a busy read defers at most once per close and a missed probe blocks nothing.
- **Cache-ledger port** (`src/cache-ledger.ts`, slim): session-local rebuild ledger
  from reported usage only (continuity / idle-expiry / foreign; 3-warning;
  `observe` mutates nothing); qube-KV constants deliberately NOT adopted yet (P4 tuning).
- **`/sam` surface**: `fold <n>` (manual fold; D2-refused while active), `resolve <n>`
  (explicit tombstone of a stuck unit), `report` (per-unit line detail + tombstones),
  `mode` now accepts all four modes (assisted/auto are real), `undo` (last folded unit).
- **New pure modules**: `gates.ts`, `extraction.ts`, `commitproof.ts`, `cache-ledger.ts`,
  `governor.ts`; `folder.ts` / `state.ts` / `ledger.ts` / `output.ts` / `protocol.ts`
  extended (folder runs the gates *before* it can draft). Still zero runtime deps.
- **Tests**: 167 passing (the P2-era 92 rewritten/extended across 7 new/changed test
  files; `extension.test.ts` fully re-wired to the P3 glue incl. a fail-open arm —
  a throwing extension leaves the session unchanged). Walk (dev repo) gained two arms:
  `empty-stub` (6/6) and `foreign-thrower` (7/7 — a real foreign extension corrupts
  its own draft; pi discards the batch; the session is proven byte-consistent and
  SAM recovers on resume) — the four P2 arms regression-proven against the P3 glue.
- **Replay-eval** (dev repo `harness/replay-eval/`, banked): the s5 banked session's
  10 issued folds under P3 policy = 1 commit + 9 honest in-band refusals,
  final state identical to the file (P2-era outcome: 1 commit + 9 silent discards).

## Unreleased — P2 (minimal end-to-end loop; implemented 2026-09-29)

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

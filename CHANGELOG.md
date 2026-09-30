# Changelog

## Unreleased — P4 extension arms C/D measured; steer profile + P5 branch-audit design (2026-09-30 night)

No behaviour change to the shipped code. Two live-measurement results land in the
dev-repo record (`measurements/live-ab-cd-2026-09-30/arms-cd-report.md`):

- **Control (arm C, SAM off):** on this model the task's raw memory survives
  compaction WITHOUT SAM (5/5 checklist, 2 reps, incl. two 57k native
  compactions); SAM's measured value here is the structure (close/audit/
  verdict/ledger/terminal), not memory. Side finding: an exact-shape line
  must be phrased imperatively to be emitted (v1 soft "write exactly this
  line" was not emitted + confabulated; v2 imperative phrasing emitted it,
  claim-checks 6/6). Spec lesson recorded in `harness/live-ab/spec/task_c.json`
  (v2, per-rep spec sha keeps C22/C23 distinguishable).
- **Steer (arm D, `SAM_AUDIT_DELIVERY=steer`):** mechanics green 2/2
  (in-turn dispatch, single instruction, verdict answered in-turn), but the
  in-turn injection makes the model end its turn after answering — the
  standing prompt's remainder for that turn is skipped 2/2 (systematic,
  self-narrated). Consequence on the H1 shape: no compaction fires, the span
  terminal goes untested, checklist marker question fails. **Steer stays the
  opt-in dial with this caveat** (README `SAM_AUDIT_DELIVERY` row); followUp
  remains the default. D battery closed at rep 25+26 (protocol); rep 27
  unspent.

Follow-up design (Paul's proposal, pending his review): **P5 branch-audit** —
audit on a side branch of the session tree (pi `fork`/`switch_session` + tree
semantics verified in pi source), verdict banked in the extension structure,
audit reasoning never enters the main context, main line continues from the
anchor; design doc + verified tool chain: dev repo `2026-09-30-p5-branch-audit.md`.

## Unreleased — P4 H1 gate + promotion: compacted-span default = `tombstone` (2026-09-30 evening)

Version stays 0.0.1 (tag v0.1.0 at P5 per plan). H1 live A/B (qwen38-gsq-rco-kv,
48k window + xhigh, N=3/arm, dry-run first) **6/6 PASS** — arm A (then-default
`refuse`) vs arm B (`tombstone`): per rep the only difference = the ledger
terminal (A = `noFold reason=ceiling` → `refused`; B = `noFold` sibling +
`resolve basis=compaction-owned` → `resolved`); verdict `VERIFIED` in all seven
runs, claim-check 6/6, checklist 5/5, **zero `context_edit`s in both arms**, all
reps R3-covered. **Promoted (Paul, 2026-09-30 evening):**
`state.governor.compactedSpanPolicy` default is now `tombstone`; the exact value
`SAM_COMPACTED_SPAN=refuse` is the explicit opt-out to the legacy terminal
(fail-safe, exact-value-only — unknown values are ignored); the announce lists
the opt-out when active. Evidence + speeds/folds/refusals analysis: dev repo
`measurements/H1-live-ab-2026-09-30/` (report.md/json + analysis.md) and
`run-outputs/p4-live-ab-2026-09-30-arm{A,B}-rep{15..21}-*` (banked, F1).

## Unreleased — P4 R3 (compaction-owned spans: the tombstone-vs-refuse policy; implemented 2026-09-30)

Version stays 0.0.1 (tag v0.1.0 at P5 per plan). R3 verdict: **pass (opt-in)** —
**promoted to the default 2026-09-30 evening (entry above)**
— suite 196 tests (0 fail), typecheck CLEAN (strict, pi 0.87.1 typings), walk
7/7 arms (unchanged), R4 regression **byte-identical** (the pure gate chain is
touched by nothing), R3 replay 7/7 checks on the banked live file
(evidence: dev repo `2026-09-30-p4-r3-compacted-span-policy.md` + §P4 in the
plan).

**The measured case (live exposure 2026-09-30, banked):** the closed unit's
span was already inside a native compaction's summarized prefix
(geometry: span indices 5..35, `firstKeptEntryId` at 97, compaction at 107 —
all measured in the file). The unit's view-token mass is carried by the
summary, not by the raw entries. The ceiling gate then refused with
`span 46914 tokens > fold ceiling 32768 tokens` — **arguably the wrong
statement for this geometry**: a fold of that span would save ZERO view
tokens (the view already shows the summary) and only rewrite preserved
ground-truth bytes.

- **Compaction coverage** (`src/gates.ts`,
  `spanCompactionCoverage(branch, spanEntryIds)`): pure branch-order
  predicate, no estimation — a span is covered when the NEWEST compaction
  (pi keeps only the newest checkpoint in projection) is newer than the span
  and the span ends before that compaction's `firstKeptEntryId`. Deliberately
  **not a gate**: it feeds the terminal POLICY, so the P3 gate chain and R4's
  determinism baseline stay byte-stable.
- **The compaction-owned terminal** (`src/folder.ts`,
  `tombstoneCompactedSpan`, pure and harness-replayable): when coverage holds
  and the policy is active — in BOTH gate outcomes — the fold is never issued
  (zero context_edits; even a gate-passing span must not rewrite preserved
  bytes), and the unit terminals as `resolved` with basis `compaction-owned`.
  The gate arithmetic stays on record as a **noFold sibling** when the gate
  rejected (evidence, not the terminal — the live case). `SamResolveRecord`
gained optional evidence fields (span anchors, entry ids, stub, verdict,
  gate reasons) so a stand-alone tombstone (the gate-passing case) is
  self-documenting; `parseSamRecord` validates them; the rebuild registers
  the resolve as a unit terminal (refused→resolved promotion on replay, F1).
- **Dial (exact-value-only, fail-safe both ways):** `SAM_COMPACTED_SPAN` →
  `state.governor.compactedSpanPolicy`. **DEFAULT `tombstone` since the
  2026-09-30 promotion (entry above)**; the exact value `refuse` opts back out
  to the original default: the gate's noFold stands, the unit is `refused`
  — **exactly the live bank's own terminal** (R4's shape, pinned at the glue
  level by test). The announce lists the active opt-out when set.
- **Terminal safety (measured, not asserted):** `resolved` is terminal by
every existing rule — the sweep candidates are `refused` only
  (`governor.sweepCandidates`), `/sam resolve` rejects resolved units, and no
  retry path re-pends them; the ledger (stub + all 30 span entry ids on the
  live file) documents the unit under either policy (asserted byte-for-byte
  on the banked file).
- **Tests**: +6 `gates.test.ts` (coverage geometry, incl. the live bank's
  measured shape and the newest-compaction-wins rule), +2 `ledger.test.ts`
  (`[noFold, resolve]` and stand-alone `[resolve]` rebuilt terminals), +3
  `extension.test.ts` (default-refuse keeps the ceiling noFold — the R4 shape
  at the glue level; tombstone keeps the ceiling arithmetic as evidence with
  zero edits; a gate-passing compacted span is still never folded).

**Open decision (user's call):** whether `tombstone` should become the
default. The evidence favors it (strictly more honest terminal, zero safety
cost, R4 baseline unaffected — R4 replays the pure gates, which are
unchanged); it is shipped OFF because it changes the live terminal on the
default path, which is a policy change, not a mechanism.

## Unreleased — P4 R2 (self-contained audit instruction; implemented 2026-09-30)

Version stays 0.0.1 (tag v0.1.0 at P5 per plan). R2 verdict: **pass** — suite
185/185, typecheck CLEAN (strict, pi 0.87.1 typings), walk 7/7 arms (54/54
checks, 2 new real-data checks on the banked instruction bytes), R4
regression 17/17 (evidence: dev repo
`2026-09-30-p4-r2-self-contained-instruction.md` + §P4 in the plan).

**The measured gap it closes (live exposure 2026-09-30, banked):** after native
compaction at 89.6%, the audit instruction's referents ("in the conversation
above", "the unit's entries") were gone from view — a mandate with no reachable
object of audit. The model answered `VERIFIED` and the ceiling then refused as
the last line (harmless in that run; the defect is structural).

- **Self-contained audit instruction** (`src/protocol.ts`,
  `auditInstruction(unitId, payload?)`): the audit now carries **the stub
  verbatim**, the **close-time floor** (system-extracted facts: files touched,
  errors, retries, non-triviality — code-computed, not claimed), the
  unchanged ground-truth mandate (entries override the stub when in view), and
  an **honest pointer to the session file** — F1 keeps every original byte
  there, so the raw span remains reachable even when the model's view is a
  compaction summary. Zero-valued floors render honestly (`files: (none
  observed) · errors: 0 …` — no fabricated richness); a unit with no recorded
  floor gets no facts line (nothing inline-quoted that isn't there).
- **Glue**: `auditPayload(unitId)` reads stub + `evidence` from the ledger unit
  record (the data that was persisted — nothing re-derived at send time); both
  delivery modes (steer at close, followUp at settle — R1) carry **byte-
  identical** payloads (pinned by test).
- **Shape-compatibility pinned**: still `[sam-audit] Unit N …` first (rebuild
  finder, `isSamInjected`, walk guards all still match); reply protocol and
  exact-reply discipline unchanged. **Old-form sessions still parse** — the
  banked live file replays byte-identical under R4 (17/17); the bank is ground
  truth and is never rewritten.
- **Tests**: +3 protocol arms (self-contained shape, payload-less validity,
  honest zero-values); both send-site assertions in `extension.test.ts` now pin
  the exact instruction text incl. payload. Walk gains 2 real-data checks (the
  banked file proves the model received a decidable instruction — fold arm:
  zero-floors rendered; steer-audit arm: the floor names the span's files).
- **What R2 does not prove** (label: claimed-vs-measured): that a *real* model
  audits better from it once the span is compacted — the mock proves the
  instruction carries what is needed; verdict-quality under real compaction
  stays with the qube A/B (option 2). R3's "audit cost is a file read" option
  now has its pointer half supplied; the ceiling-on-compacted-spans *policy*
  remains open.

## Unreleased — P4 R1 (steer-audit delivery; implemented 2026-09-30)

Version stays 0.0.1 (tag v0.1.0 at P5 per plan). R1 verdict: **pass** — suite
182/182 (incl. the F3 cross-check vs real pi 0.87.1), typecheck CLEAN (strict,
tsc 7.0.2, pi 0.87.1 typings), walk 7/7 arms (51/51 checks) including the new
`steer-audit` arm, R4 determinism regression 17/17 (evidence: dev repo
`2026-09-30-p4-r1-steer-audit.md` + §P4 in the plan).

- **Steer-audit delivery (opt-in; default unchanged)**: new env dial
  `SAM_AUDIT_DELIVERY` — `steer` routes the close's audit through pi 0.87.1
  `sendUserMessage(text, {deliverAs: "steer"})` at close time, so the verdict is
  answered **in the running turn, on the still-warm prefix** (pi semantics
  verified in `agent-session.js`: steering flushes after the current tool calls,
  before the next LLM call; no active run ⇒ followUp-equivalent, which the settle
  branch absorbs). The close then settles **the moment the turn ends**: capture +
  commit in the close's own settle (one cache rebuild — the s5 principle). The
  default (`"followUp"`) is byte-for-byte the P2/P3 behavior; only the exact value
  `steer` activates the mode (fail-safe).
- **Capture semantics generalized** (`src/ledger.ts`): the audit reply is the LAST
  assistant in the audit window whose text parses as a valid verdict (VERIFIED /
  CORRECTIONS), else the LAST assistant (the P2 rule, kept for unreadable replies).
  Required by the steer shape — after an in-turn VERIFIED the model typically
  returns to task, and "last assistant wins" would have captured the work
  continuation as the verdict. The P2-era `l2` pin (two VERIFIED replies, usage
  from the last) still passes.
- **Glue** (`extensions/self-aware-memory/index.ts`): `close_unit` success path
  sends the steer (F1 try/catch — a delivery failure never breaks the close);
  settle step 4: steered unit + reply in branch ⇒ commit now (decision logic
  extracted into `commitWaiting`, shared with step 3 — no duplicated gate
  handling); steered + no reply ⇒ F1 fall-through to the followUp audit (probe
  deferral skipped on that path, or it would strand the in-turn exchange); the
  load announce shows `audit delivery: steer` when active. New state fields
  `auditDelivery` + `steeredAudits`.
- **What does NOT change (the point of carry #7)**: audit instruction text,
  gate chain, ceiling, ledger record shapes, D2, R5, probe. Measured, not just
  asserted — the walk `steer-audit` arm: control (small span) folds in the
  close's own settle (`closeTR → [sam-audit] → VERIFIED`, no followUp turn);
  ceiling (span **37,398 tok > 32,768**) lands `noFold reason=ceiling` WITH
  `verdict: VERIFIED` recorded on the refusal and the raw span still in view
  (F5: native compaction owns it). The audit was answered in the file first —
  grounded — and the gate still refused. Delivery timing and fold timing are
  orthogonal.
- **Tests**: +9 (3 ledger capture arms, 6 glue delivery arms incl. display/
  CORRECTIONS/fallback/fail-safe); full suite 182/182. `pi-semantics` note:
  `SAM_PI_DIR` is the **node_modules dir** holding `@earendil-works/pi-coding-agent`.

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

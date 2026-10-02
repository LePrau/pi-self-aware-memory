# pi-self-aware-memory

**Compaction you can audit.** The agent folds its own *closed work units* into verified
stubs, continuously, while the reasoning is still warm — and the raw transcript stays in the
session file, byte for byte.

pi's built-in auto-compaction arrives late and cold: it fires near the context wall and
re-prefills a whole new summary prompt that shares nothing with the session's already-cached
context. On small windows (32k–128k) it can fire often while freeing almost nothing. This
extension replaces the single cold, generic summary with continuous, agent-authored,
audited folds:

1. the agent marks a unit open and closed, and writes its own stub at close;
2. the model gets one appended audit instruction and answers `VERIFIED` or
   `CORRECTIONS` — delivered **in-series after the close turn** (default
   `followUp`), **into the running turn** (`steer`, retained opt-in), or on a
   **side branch** (`branch`, P5 v3 — runner-orchestrated; the main line never
   sees the audit), or **synchronously inside the close call on a side session**
   (`close` — the session waits like on any slow tool; the main line again never
   sees the audit, and **no fold happens at close**: the span stays in view
   until compaction takeover or explicit `/sam fold`);
3. only then is the raw span projected out with pi's **append-only** context edits — the
   session file keeps every original byte, so every fold is reversible and offline-auditable.
   (In `branch` mode the audit reply's digest becomes the settlement line, which rides the
   next compaction's summary — **which is lossy by design** (measured, v3 baseline 2026-10-01):
   the audited facts of the closed unit ride the settlement line guaranteed, but *session-level*
   must-survive lines outside the unit (e.g. MARKERs reported after the close) survive only if
   the summary or the kept entries carry them — a known baseline assumption, not a guarantee —
   and the raw content stays retrievable by id: `sam_retrieve` / `/sam retrieve <id>`.)

> **The audit quality is the audited model's quality.** A model that cannot audit its own
> work reliably should not run this extension at all — the verdicts are the model's, and a
> weak auditor produces confident `VERIFIED` lines anyway (the gates, the ledger and the
> append-only file keep every fold *retrievable and reversible*, which is the protection;
> they do not make a bad verdict good).

## Status: 0.0.1-dev (P4 R1 complete + P5 v3 surface built — governed close→fold loop; audit delivery `followUp` (default) / `steer` (retained) / `branch` (P5, runner-orchestrated) / `close` (synchronous close-time audit, experimental, default off); `sam_retrieve`; compaction takeover)

This pre-release version implements the full **P2 loop** (close → in-series audit →
fold → undo/report, append-only `sam` ledger) **plus the P3 governor and safety layer**:

- **Gates before any draft exists** — target editability, tool-pair integrity, span
  overlap with already-folded (non-editable) content, savings/ceiling/keep-window —
  so a fold either commits whole or is refused *in-band* with a reason the model can
  act on (no silent batch discards).
- **Commit proofs** staged at close and re-validated at commit (append-only growth
  tolerated, structural drift invalidates) plus an honest orphan audit at session
  start (lost folds become terminal `resolved` tombstones, surfaced in `/sam`).
- **Empty-stub refusal** — a `close_unit` with an empty stub over demonstrable work is
  refused before any ledger mutation, with the reason in the tool result.
- **Governor** — pressure zones under pi's own context estimate with hysteresis,
  mode semantics (`display` / `manual` / `assisted` / `auto`), R5 backoff, and the
  **D2 coexistence guard**: while another folding folder is active (per settings,
  unreadable ⇒ conservative "assume present"), SAM refuses to fold (audits and
  measurements continue; the session is never at risk).
- **Provider-busyness probe: OFF by default** (zero network; `?autoload=false`
  mandatory if ever enabled).
- **Fail-open everywhere** — an extension error surfaces as a stderr line and leaves
  the session unchanged (proven in the walk harness with a real failing extension).

It is not a release: the P5 live evaluation is banked (2026-10-01, dev-repo CHANGELOG: rep-3 18/18; E27 17/18 with the loss-by-design baseline ruling); behaviour is pinned to **pi 0.87.1** semantics. The P5 `branch` flow is **runner-orchestrated** (measured 2026-10-01: print-mode pi does not pump command-initiated extension model turns) — every SAM command is model-free, and the fork's audit turn is the runner's own prompt against the fork session.

## Requirements

- pi ≥ 0.87 (built and tested against 0.87.1)
- Node ≥ 22.6 for local development (extension files load via pi's type-stripping loader;
  no build step)

## Install

```bash
# from a local checkout
pi install ./path/to/pi-self-aware-memory

# or try it for one invocation without touching settings
pi -e ./path/to/pi-self-aware-memory
```

## Usage

| command | what it does (in this version) |
|---|---|
| `/sam` | status: mode, model, context pressure, zone, D2/probe state, unit/fold counters |
| `/sam mode <m>` | switch mode for the current session (`display`/`manual`/`assisted`/`auto`; persisted settings come later) |
| `/sam fold <n>` | fold a specific unit now (refused while D2 coexistence guard is active) |
| `/sam report` | per-unit ledger table with line detail and tombstones |
| `/sam undo` | restore the last folded unit (rides one short controlled ack turn) |
| `/sam resolve <n>` | explicitly resolve a stuck/orphaned unit (tombstone) |
| `/sam audit <n>` | **branch mode (P5)** — prepare the side-branch audit for unit n: forks the session at the leaf and emits a JSON handoff `{unitId, forkFile, forkSessionId, instruction}` on the operator channel. **Model-free**; the runner then prompts the fork session with the emitted instruction |
| `/sam settle <n> [forkFile]` | **branch mode (P5)** — stage the fork's audit reply + run the synchronous settle (settlement record + terminal, the unchanged close-time machinery). **Model-free** (one short ack turn) |
| `/sam retrieve <id>` | serve the original content of a settlement/retrieval id (`sam_retrieve` tool for the model; bounded resolver, session file + tombstone bank) |

**Modes** (select *when* the governor may act — the fold mechanics are identical):

| mode | behaviour |
|---|---|
| `display` | measure and report only, never fold |
| `manual` | fold only on explicit close (default) |
| `assisted` | fold on close, plus a settle-time sweep of closed units under pressure (keep-window-gated) |
| `auto` | also fold unmarked work blocks when pressure nears the wall (proof-gated; P4 live-evaluated) |

**Operator dials** (env per pi process; all fail-safe — an unrecognized value means
"default":)

| env | default | effect when active |
|---|---|---|
| `SAM_AUDIT_DELIVERY` value | `followUp` (P2/P3 behavior) | which delivery the close's audit takes — `followUp` (default: the audit instruction lands as the next user turn after the close), `steer`, `branch`, `close`. Unknown values = the default. See the three `steer`/`branch`/`close` rows below |
| `SAM_AUDIT_DELIVERY=steer` (retained opt-in toggle, **default off** — decision O2, 2026-10-01: this is a *kept* dial, not deprecated) | — | the close's audit is delivered **into the running turn** (pi `deliverAs: "steer"`) and the close settles the moment the verdict is answered — one cache rebuild instead of two. Refusal semantics, gates and ledger records are unchanged; the audit instruction text is identical in both modes (`steer` announces itself: `audit delivery: steer`). **Measured caveat (2026-09-30, qwen38-gsq-rco-kv + 48k window + xhigh, 2/2 live reps, banked dev-repo `measurements/live-ab-cd-2026-09-30/arms-cd-report.md` §D):** on this model the in-turn injection makes the model answer the audit and END THE TURN — work the standing prompt ordered for the rest of that turn (e.g. continuation phases) is skipped 2/2 (each self-narrated); on task shapes where the close is mid-turn, the hazard is systematic → use `followUp` (default) or `branch` |
| `SAM_AUDIT_DELIVERY=branch` (P5 v3, **opt-in**) | — | the close's audit runs on a **side branch** of the session tree (pi `fork`): `/sam audit <n>` prepares (fork at the leaf + JSON handoff on the operator channel), the **runner** prompts the fork session with the emitted instruction (one model turn on the fork), `/sam settle <n> <forkFile>` stages the reply + commits the settlement record + terminal on the main line, and the settlement line (retrievalId first, O1) rides the next compaction's summary via the takeover. The MAIN line never holds `[sam-audit]`; original content stays retrievable (`sam_retrieve`). Runner-orchestrated by design (measured: print-mode pi does not pump command-initiated extension turns); **every SAM command is model-free** (a pinned test invariant). `followUp` remains the default for interactive use |
| `SAM_AUDIT_DELIVERY=close` (synchronous close-time audit, **default off** — the audit-timing experiment: the same audit, run inside the `close_unit` call instead of at the turn boundary) | — | the close's audit runs **synchronously inside the tool call**: a dedicated child process (a fork of the current session state, prepared with the same model-free `/sam audit <n>` command) performs the audit on a **side session file**, the verdict is validated from that file, and `close_unit` returns one line — `Unit N closed — audit VERIFIED (<retrievalId>)` (or `… CORRECTIONS: …` / `… NOT-YET-VERIFIED: …` (light, in-band) / `… UNVERIFIED (audit-failed: …)` (the D9 hatch) with the exact upgrade action). The close record commits **before** the audit, so every audit failure keeps the close effective and **settles it** (D9: a total failure commits an `UNVERIFIED (audit-failed)` settlement — the summary survives channel A, claims "verify before acting"), re-auditable (re-close with the same stub, or `/sam reaudit N`, upgrades the weak settlement). The main line never carries the audit exchange; **no fold at close** (deliberate: the closed span stays in view until native compaction takes over or `/sam fold` is issued — **D9 (2026-10-02): the settlement + resolve terminal commit AT VERDICT, inside `close_unit`** (`pi.appendEntry`, the close-record crash-safe pattern) — the `agent_before_settle` drain (step 2.5) keeps as the idempotent backstop only; the run-02 incident (a pending-settle let the native fold preempt the settle and fold the span lossy) is the spec input). Several closes per turn are normal (each close starts the next unit; spans are close-to-close) |
| `SAM_AUDIT_TIMEOUT_MS` (with `close`) | 480000 (8 min; capped at 24 h) | the audit child's hard budget — on timeout the close settles as **UNVERIFIED (audit-failed)** (D9 hatch: the close stays effective, the summary survives channel A with its claims "verify before acting"; upgrade via same-stub re-close / `/sam reaudit`) |
| `SAM_PI_CLI` (with `close`) | `argv[1]` of the running pi process (fail-safe) | explicit pi CLI entry for the children the `close` dial spawns — override for unusual embeds |
| `SAM_AUDIT_DEPTH` (with `close`) | `auto` — `auto` = zone-based (D8, 2026-10-02): zone `watch`/`action` (≥ W−2R) ⇒ `light`; below ⇒ `full`. `full` / `light` = fixed overrides | **D8 light-audit rung:** `light` = ONE model turn, **zero tool calls**, checks delivery only ("are the filenames/statements the close claims present?") — line-1 verdict `NOT-YET-VERIFIED: …`; claims not marked open ride "verify before acting". Rationale (measured, run-02 + P4 pair): the near-fold full audit is the KV-pressure failure mode (registered 32,768 audit FAIL vs 49,152 18/18) — and the light child is disposable (fresh fork, one turn, no tools), so at/above the band it may borrow the R reserve (~16,384) without cost to the main line. `full` stays VERIFIED / CORRECTIONS only (a `NOT-YET-VERIFIED` reply there is a contract violation ⇒ the D9 hatch). NOT a fold-avoidance mechanism (synthesis, vetoable — decision record v4-plan §7) |
| `SAM_NUDGE` (with `close`) | **on (DEFAULT — Paul, 2026-10-02**; opt-out `SAM_NUDGE=off`; D7 final spec 2026-10-02 + same-day design correction: NO TIME IN ANY TRIGGER + the `reasoning` ACTIVITY rulers; text PROVISIONAL — "the prompt question is not completely resolved yet" (Paul); his wording is final) | the **mid-session nudge**: a light, state-based ask that reaches the model before its next LLM call (mid-turn `deliverAs: "steer"`, or one short turn when idle — one measured `sendUserMessage` call covers both). **NO TIME in any trigger** (Paul, 2026-10-02: "time is not a good measure for llm work" — the per-stretch flags are the anti-spam, not cooldowns). Context ruler: `gap = ctx − baseline` (baseline = the last successful `close_unit`, then session start / the post-compaction view); nudges may only fire once `gap ≥ 20,000` (`NUDGE_GAP_TOKENS` = pi v0.87.1’s measured `keepRecentTokens` default — the raw kept tail of every compaction; **a constant, no override — by decision 2026-10-02** — plus the KV-headroom rationale: the ~32k-kv audit fail vs. the 49,152 18/18 bank pair — the earlier capability-floor reading is RETRACTED, house rule). Classes: **`gap`** — early checkpoint (≤1 per stretch); **`band`** — the pressure band (`watch`/`action` = ≥ W−2R, one reserve below the native line W−R) with `gap ≥ 20k`: the urgency escalation, allowed even when the earlier nudge went unanswered (Paul verbatim), consumes the stretch’s `gap` flag; in-band with `gap < 20k` stays SILENT (the unclosed tail fits the kept window ⇒ nothing at risk). **`reasoning`** — Paul’s ACTIVITY rulers (2026-10-02; **not total context, not zone, not time**): fires when `toolCallsSinceReset ≥ 15` ("tool count seems fine as a start" — Paul) **AND** `thinkingSinceReset ≥ 5000` (Paul: "I suggest taking 5k, that grants 2 or 3 medium reasoning turns, or a big one" — the budget is INCREMENTAL over the stretch; settled ref run: 24 blocks ≥ 2.5k chars, 14 ≥ 5k, max 13,589 ≈ 4.5k thinking tokens) ("a lot of tool calls, especially after large tool calls and reasoning thereafter" — the subtle style is Paul’s: "maybe we can already close some findings"); at that point the long tool output is exactly what a close makes evictable once the findings are made and audited. Activity-ladder RESET points (the meter of unmaterialized work): a successful `close_unit` (stretch reset — also re-stamps the gap baseline), a `write`/`edit` tool call (materialization — Paul: "a writing tool call should probably reset the reasoning-counter", extended to both rulers — **confirmed 2026-10-02, Paul: "1 is the right choice and what I meant"**), and ANY nudge offer (soft checkpoint — re-crossing the floors = more unmaterialized work; what makes long research turns yield MORE than one checkpoint per context window, Paul’s stated goal — **confirmed 2026-10-02**). Guards (pinned): never while a close-audit is in flight, never in an audit side-session — **D9 (2026-10-02): those two are the only suppressors** (a pending settle no longer suppresses — the run-02 spec input: the old guard sat silent ~36 minutes at 88–90 % with NO ledger entry; the run’s three largest thinking blocks are what the removal re-arms). A WOULD-HAVE-fired decision caught by a guard is RECORDED — `sam-nudge` entry with `suppressed: true` + the guard + the would-be trigger, plus an operator emit (F1). Never on the v3 dials; spawned audit children run with `SAM_NUDGE=off` forced; a missing ctx ruler suspends `gap`/`band` (never fabricate a ruler) — the activity class stands independent. Text: `gap`/`band` carry the current context share; `band` adds the imminent-fold warning (Paul, 2026-10-02). Provenance (F1): the text starts with `[sam-nudge]` (visible to the model AND in the session file — self-partition vs. nudge-assisted stays distinguishable in the readout) and each nudge appends a `sam-nudge` custom entry (not sent to the LLM) with the class, the activity counters and the gap at the fire |
| `SAM_NUDGE_REASONING_CHARS` (nudge enabled) | 5000 | the THINKING floor of the `reasoning` ACTIVITY rulers (the "reasoning thereafter" side; Paul, 2026-10-02: "I suggest taking 5k, that grants 2 or 3 medium reasoning turns, or a big one" — the budget is INCREMENTAL over the stretch; measured settled ref run (main-242): 24 thinking blocks ≥ 2.5k chars, 14 ≥ 5k, max 13,589 chars; `usage.reasoning` is 0 on kvllama, so content chars are the ruler) |
| `SAM_NUDGE_REASONING_CALLS` (nudge enabled) | 15 | the TOOL-CALL floor of the `reasoning` ACTIVITY rulers ("a lot of tool calls have passed" — Paul, 2026-10-02). Default measured from the run-02 bank: both stretches are 22 / 20 calls (tool results = 70.5 % of message chars; reads alone 51.2 %) |
| `SAM_COMPACTED_SPAN=refuse` | `tombstone` (P4 R3 **DEFAULT**, promoted 2026-09-30 evening after the H1 live A/B 6/6 — the arms are functionally identical, the ledger terminal is the only difference) | a span that a native compaction already summarized out of the view is **never folded** (zero view-token gain; it would only rewrite preserved ground-truth bytes) and terminals as `resolved` with basis `compaction-owned`; the gate arithmetic stays on record as a `noFold` sibling when the gate rejected (the live 2026-09-30 case: the ceiling refusal). The exact value `refuse` (the pre-promotion default) opts back out to the legacy terminal (the gate's own noFold, e.g. the ceiling, unit `refused`). The announce lists the active opt-out: `compacted spans: refuse (P4 R3 opt-out; default is tombstone)` |
| `SAM_PROVIDER_PROBE_URL=<url>` | unset (no network) | pre-close provider-busyness read (positive-only, 8 s bound, `?autoload=false` mandatory on the qube router) — a busy read defers a close at most once |

## Development

```bash
node --test test/*.test.ts   # zero-dependency suite (267 tests incl. the P5 v3 branch-audit pins and the synchronous close-audit handler matrix; the pi-semantics F3 cross-check takes SAM_PI_DIR = the node_modules dir holding the pi package)
PI_TYPES_DIR=<dir>/node_modules sh typecheck/run-typecheck.sh   # tsc --noEmit vs. pi typings
# add CONTROL=1 to prove the checker can fail before trusting a clean run
```

`PI_TYPES_DIR` must point at a `node_modules` directory containing
`@earendil-works/pi-coding-agent`; the banner prints the exact pi version the check ran
against. A check against one version proves nothing about another.

## License

MIT — see [LICENSE](LICENSE).

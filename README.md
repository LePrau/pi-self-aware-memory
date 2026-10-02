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
| `SAM_AUDIT_DELIVERY` value | `followUp` | where the close's audit is delivered — the four rows below choose the mode; unknown values = `followUp` |
| `SAM_AUDIT_DELIVERY=followUp` (default) | — | the audit instruction lands as the next user turn after the close; the close settles when the verdict is answered |
| `SAM_AUDIT_DELIVERY=steer` | off | the audit lands **into the running turn**; the close settles the moment the verdict lands. Some models end the turn right after answering — the rest of that turn's work can be skipped, so prefer `followUp` when the close is mid-work |
| `SAM_AUDIT_DELIVERY=branch` | off | the audit runs on a **side branch** of the session tree, runner-orchestrated (`/sam audit <n>` emits the instruction, the runner prompts the fork, `/sam settle <n> <forkFile>` commits the settlement); the main line never holds the audit exchange |
| `SAM_AUDIT_DELIVERY=close` | off | the audit runs **synchronously inside `close_unit`** on a dedicated side session that never folds; `close_unit` returns one verdict line — `Unit N closed — audit VERIFIED (…)`, `… CORRECTIONS: …`, `… NOT-YET-VERIFIED: …` (light), or `… UNVERIFIED (audit-failed: …)`. The close record commits **before** the audit, so a failed audit keeps the close, settles it as the weak line, and stays upgradeable (re-close or `/sam reaudit N`). No fold at close — the span stays in view until compaction or `/sam fold`. The goal (`adjust_goal`) rides the head of every fold's summary; several closes per turn are normal (each close opens the next unit) |
| `SAM_AUDIT_TIMEOUT_MS` (with `close`) | 480000 (8 min) | the audit child's hard budget — on timeout the close stands and settles `UNVERIFIED (audit-failed)` (upgrade via re-close or `/sam reaudit N`) |
| `SAM_PI_CLI` (with `close`) | `argv[1]` of the running pi process | explicit pi CLI entry for the children the `close` dial spawns |
| `SAM_AUDIT_DEPTH` (with `close`) | `auto` | the audit's depth: `auto` = `light` while the context is in the pressure band (≥ W−2R), `full` below; `light` / `full` are fixed overrides. `light` = one model turn, zero tool calls, checks that the close's claims are present → verdict `NOT-YET-VERIFIED: …` (claims ride "verify before acting"). `full` = `VERIFIED` / `CORRECTIONS` only — a `NOT-YET-VERIFIED` there settles `UNVERIFIED (audit-failed)` |
| `SAM_NUDGE` (with `close`) | on | a light mid-session ask to checkpoint, delivered to the model right before its next call (mid-turn, or one short turn when idle) when work accrues without a close: context gap since the last close, the pressure band, or enough tool calls + thinking since the last reset (the two threshold dials below). One nudge per class per stretch; a successful close, any `write`/`edit` call, or the nudge itself resets the counters. Never while an audit is in flight or in an audit side-session (a suppressed nudge is recorded in the ledger). Opt-out: `SAM_NUDGE=off` |
| `SAM_NUDGE_REASONING_CHARS` (nudge enabled) | 5000 | the thinking floor of the activity nudge — thinking chars accumulated since the last reset |
| `SAM_NUDGE_REASONING_CALLS` (nudge enabled) | 15 | the tool-call floor of the activity nudge — tool calls since the last reset |
| `SAM_COMPACTED_SPAN` | `tombstone` | how a span that a native compaction already summarized out of view is treated: `tombstone` (default) terminals it `resolved` (compaction-owned, not re-folded); `refuse` terminals it as a `noFold` refusal instead |
| `SAM_PROVIDER_PROBE_URL=<url>` | unset (no network) | a pre-close provider-busyness check (positive-only, 8 s bound) — a busy read defers the close at most once |


## Inspiration

We also took inspiration from other pi extensions working the same problem space
(base project: [earendil-works/pi](https://github.com/earendil-works/pi)):

- **observational memory** — [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory):
  continuously captures useful session memory while you work — concrete
  *observations* of what happened or was established, reflected and pruned by
  worker agents, carried across sessions.
- **smart compaction** ("Pi Continuity") — [alpertarhan/pi-smart-compact](https://github.com/alpertarhan/pi-smart-compact):
  context hygiene and session continuity for long-running pi sessions —
  recoverable cleanup, checkpoints, memory, and verified compaction around pi's
  own session lifecycle.
- **blackhole** — [k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole):
  deterministic (non-LLM) structural compaction — replacing the LLM-based
  `/compact` with an algorithmic structural summary — bundled with session-aware
  observational memory (bundles a fork of `pi-observational-memory` plus
  [sting8k/pi-vcc](https://github.com/sting8k/pi-vcc)).

Where those extensions project context or run observers as side processes, SAM keeps the
fold on pi's own append-only session file with a per-unit audit **before** anything is
projected out (close → audit → fold, the raw span always retrievable by id).

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

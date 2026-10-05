# pi-self-aware-memory

**Compaction on-the-fly with audits.** The agent folds its own *closed work units* into verified
stubs, continuously, while the reasoning is still warm — and the raw transcript stays in the
session file, byte for byte.

> **Version pin:** SAM has only been built and tested against **pi 0.87.1** — behaviour is
> pinned to that version's semantics. Support for pi 1.0.x will take a while; do not expect
> it to work unchanged on newer pi releases.

pi's built-in auto-compaction arrives late and cold: it fires near the context wall and
re-prefills a whole new summary prompt that shares nothing with the session's already-cached
context. On small windows (32k–128k) it can fire often while freeing almost nothing. This
extension replaces the single cold, generic summary with continuous, agent-authored,
audited folds:

1. the agent marks a unit open and closed, and writes its own stub at close;
2. the model gets one appended audit instruction and answers `VERIFIED` or
   `CORRECTIONS` — delivery mode per the Operator dials below (default `close`:
   synchronously inside the close call);
3. only then is the raw span projected out with pi's **append-only** context edits — the
   session file keeps every original byte, so every fold is reversible and offline-auditable.
   (In `branch` mode the audit reply's digest becomes the settlement line, which rides the
   next compaction's summary; the raw content stays retrievable by id: `sam_retrieve` /
   `/sam retrieve <id>`.)

> **The audit quality is the audited model's quality.** A model that cannot audit its own
> work reliably should not run this extension at all — the verdicts are the model's, and a
> weak auditor produces confident `VERIFIED` lines anyway (the gates, the ledger and the
> append-only file keep every fold *retrievable and reversible*, which is the protection;
> they do not make a bad verdict good).

## Status: 0.0.2-dev — governed close→fold loop, compaction takeover, `sam_retrieve` (audit delivery: default `close` since 2026-10-05)

Not a release: behaviour is pinned to **pi 0.87.1** semantics; the P5 `branch` flow is
**runner-orchestrated** (every SAM command is model-free). Evaluation history:
[CHANGELOG.md](CHANGELOG.md).

This pre-release version implements the full **P2 loop** (close → audit → fold →
undo/report, append-only `sam` ledger) **plus the P3 governor and safety layer**:

- **Gates before any draft exists** — target editability, tool-pair integrity, span overlap, savings/ceiling/keep-window: a fold commits whole or is refused *in-band* with an actionable reason.
- **Commit proofs** staged at close, re-validated at commit (append-only growth tolerated, structural drift invalidates); lost folds become terminal `resolved` tombstones at session start, surfaced in `/sam`.
- **Empty-stub refusal** — a `close_unit` with an empty stub over demonstrable work is refused before any ledger mutation.
- **Governor** — pressure zones under pi's own context estimate with hysteresis, mode semantics (`display` / `manual` / `assisted` / `auto`), R5 backoff, and the **D2 coexistence guard** (SAM refuses to fold while another folding folder is active).
- **Provider-busyness probe: OFF by default** (zero network).
- **Fail-open everywhere** — an extension error surfaces as a stderr line and leaves the session unchanged.

## Requirements

- pi **0.87.1** (built and tested; newer pi versions untested — see the version pin above)
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
| `/sam audit <n>` | **branch mode (P5)** — prepare the side-branch audit for unit n (forks at the leaf, emits the handoff; model-free — the runner then prompts the fork) |
| `/sam settle <n> [forkFile]` | **branch mode (P5)** — stage the fork's audit reply and run the settle (model-free, one short ack turn) |
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
| `SAM_AUDIT_DELIVERY=<mode>` | `close` (default; unset/unknown values fail-safe to `close`) | where the close's audit is delivered. Modes: `close` (default) — synchronously inside `close_unit` on a dedicated side session; `close_unit` returns one verdict line (shapes: CHANGELOG), the close commits before the audit, and a failed audit stays upgradeable (re-close or `/sam reaudit N`); no fold at close — the span stays in view until compaction or `/sam fold`; the goal tools (`adjust_goal`/`read_goal`) register on this surface. `followUp` — **DEPRECATED 2026-10-05** (bricks the main session; explicit opt-in only), in-series audit as the next user turn. `steer` — audit into the running turn; the close settles on the verdict. `branch` — runner-orchestrated side-branch audit (`/sam audit <n>` → runner prompts the fork → `/sam settle <n> <forkFile>`); the main line never holds the audit exchange |
| `SAM_AUDIT_TIMEOUT_MS` (with `close`) | 480000 (8 min) | the audit child's hard budget — on timeout the close stands and settles `UNVERIFIED (audit-failed)` |
| `SAM_PI_CLI` (with `close`) | `argv[1]` of the running pi process | explicit pi CLI entry for the children the `close` dial spawns |
| `SAM_AUDIT_DEPTH` (with `close`) | `auto` | `auto` = `light` while the context is in the pressure band (≥ W−2R), `full` below; `light`/`full` are fixed overrides. `light` = one turn, zero tool calls → `NOT-YET-VERIFIED` (claims ride "verify before acting"); `full` = `VERIFIED`/`CORRECTIONS` only |
| `SAM_NUDGE` (with `close`) | on | a light mid-session ask to checkpoint when work accrues without a close, plus one goal ask (store/refresh via `adjust_goal`) per new outside user input; one nudge per class per stretch. Opt-out: `SAM_NUDGE=off` (the family switch); thresholds: the two dials below |
| `SAM_NUDGE_REASONING_CHARS` (nudge enabled) | 5000 | the thinking floor of the activity nudge — thinking chars accumulated since the last reset |
| `SAM_NUDGE_REASONING_CALLS` (nudge enabled) | 15 | the tool-call floor of the activity nudge — tool calls since the last reset |
| `SAM_COMPACTED_SPAN` | `tombstone` | how a span that a native compaction already summarized out of view is treated: `tombstone` (default) terminals it `resolved` (compaction-owned, not re-folded); `refuse` terminals it as a `noFold` refusal instead |
| `SAM_PROVIDER_PROBE_URL=<url>` | unset (no network) | a pre-close provider-busyness check (positive-only, 8 s bound) — a busy read defers the close at most once |


## Inspiration

Related pi extensions in the same problem space (base project:
[earendil-works/pi](https://github.com/earendil-works/pi)):

- **observational memory** — [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory): continuously captured session memory, carried across sessions
- **smart compaction** — [alpertarhan/pi-smart-compact](https://github.com/alpertarhan/pi-smart-compact): context hygiene and recoverable compaction around pi's own session lifecycle
- **blackhole** — [k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole): deterministic (non-LLM) structural compaction

## Development

```bash
node --test test/*.test.ts   # zero-dependency suite (the pi-semantics F3 cross-check takes SAM_PI_DIR = the node_modules dir holding the pi package)
PI_TYPES_DIR=<dir>/node_modules sh typecheck/run-typecheck.sh   # tsc --noEmit vs. pi typings
# add CONTROL=1 to prove the checker can fail before trusting a clean run
```

`PI_TYPES_DIR` must point at a `node_modules` directory containing
`@earendil-works/pi-coding-agent`; the banner prints the exact pi version the check ran
against. A check against one version proves nothing about another.

## License

MIT — see [LICENSE](LICENSE).

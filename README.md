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
2. the same model, on the same warm prompt prefix, gets one appended audit instruction and
   answers `VERIFIED` or `CORRECTIONS`;
3. only then is the raw span projected out with pi's **append-only** context edits — the
   session file keeps every original byte, so every fold is reversible and offline-auditable.

## Status: 0.0.1-dev (P3 complete — governed, auditable close→fold loop)

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

It is not a release: the live A/B evaluation (P4) and the `v0.1.0` tag (P5) are
pending; behaviour is pinned to **pi 0.87.1** semantics.

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

**Modes** (select *when* the governor may act — the fold mechanics are identical):

| mode | behaviour |
|---|---|
| `display` | measure and report only, never fold |
| `manual` | fold only on explicit close (default) |
| `assisted` | fold on close, plus a settle-time sweep of closed units under pressure (keep-window-gated) |
| `auto` | also fold unmarked work blocks when pressure nears the wall (proof-gated; P4 live-evaluated) |

## Development

```bash
node --test test/                    # zero-dependency suite (167 tests; 6 env-gated skips need SAM_PI_DIR)
PI_TYPES_DIR=<dir>/node_modules sh typecheck/run-typecheck.sh   # tsc --noEmit vs. pi typings
# add CONTROL=1 to prove the checker can fail before trusting a clean run
```

`PI_TYPES_DIR` must point at a `node_modules` directory containing
`@earendil-works/pi-coding-agent`; the banner prints the exact pi version the check ran
against. A check against one version proves nothing about another.

## License

MIT — see [LICENSE](LICENSE).

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

## Status: P0 scaffold (0.0.x, pre-release)

This version is deliberately behaviourless. It **loads, announces once at session start, and
serves the `/sam` status surface**. It registers no tool, appends no session entries, drafts
no context edits and sends no messages — nothing in this version can mutate a session. The
audit/fold machinery, `/sam fold|report|undo`, the mode governor and the measurement program
land in later 0.x releases.

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
| `/sam` | status: mode, model, context pressure, unit/fold counters |
| `/sam mode <m>` | switch mode for the current session (persisted settings come later) |
| `/sam fold` · `/sam report` · `/sam undo` | planned; answer "not yet" until their phase lands |

**Modes** (select *when* the governor may act — this version acts in none):

| mode | behaviour |
|---|---|
| `display` | measure and report only, never fold |
| `manual` | fold only on explicit close (default) |
| `assisted` | fold on close, plus a settle-time sweep under pressure |
| `auto` | also fold unmarked spans when pressure nears the wall |

## Development

```bash
node --test test/                    # zero-dependency suite
PI_TYPES_DIR=<dir>/node_modules sh typecheck/run-typecheck.sh   # tsc --noEmit vs. pi typings
# add CONTROL=1 to prove the checker can fail before trusting a clean run
```

`PI_TYPES_DIR` must point at a `node_modules` directory containing
`@earendil-works/pi-coding-agent`; the banner prints the exact pi version the check ran
against. A check against one version proves nothing about another.

## License

MIT — see [LICENSE](LICENSE).

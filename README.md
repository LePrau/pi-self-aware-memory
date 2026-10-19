# pi-self-aware-memory

**Compaction on-the-fly with audits.** The agent folds its own *closed work units* into verified
stubs, continuously, while the reasoning is still warm - without invalidating the precious kv-cache
and meanwhile keeping the raw transcript available for later reference.

> **Version pin:** SAM has only been built and tested against **pi 0.87.1** — behaviour is
> pinned to that version's semantics. Support for pi 1.0.x will take a while; do not expect
> it to work unchanged on newer pi releases.

pi's built-in auto-compaction has two major drawbacks: it is slow, and it can lose crucial details.

Occuring at the end of the available context, it creates a whole new summary prompt
with a similar length, throwing away the existing kv-cache and needing a long prefill-time.
That is why it is slow.

And often, compaction happens in the middle of a task, where the model does not exactly
know what might be needed further ahead. It writes a summary to the best of its ability, but with
bad timing, and only superficial information, without a way of getting the original back.
That is why its quality suffers.

With SAM I try to fix both issues, targeted at single-user-single-model environments.
As I just learned, a similar approach minus the kv-cache side has just been released by a group from Meta,
and they call it "CLM", context language models. 
So yes, SAM is basically a CLM-extension, envisioned before I heard of the paper or knew this term existed.

How does SAM target the issues?
It replaces the single cold, generic summary with continuous, agent-authored, audited folds.
After each user input, it is asked to update the current goal to the best of its understanding.
This self-derived goal will stay at the top of the context.
The model decides (with suggestion-prompts) when to summarize part of its work, verifies its summary,
and can later dive back into the detailed transcript whenever needed.
That summary gets used as compacted replacement for that part of the session at the next fold.
So many small summaries in-between replace one long summary at the end, with a similar timespan
The actual /compact becomes instant by just using the already generated summaries.

Workflow (roughly) in steps:
1. the extension implements tools for closing units (by summarizing the results), auditing and folding
2. at certain times, the extension injects steering prompts suggesting to close a unit, or to adjust the goal
3. the model decides when a unit is considered "done", or when the goal needs an update
4. when chosing to close a unit, the model calls close_unit, summarizes the last part of its work, emphasizes 
   important findings.
5. then it gets one appended audit instruction and answers with a one-line verdict — `VERIFIED`,
   `CORRECTIONS` or a depth-bound weaker rung (`PLAUSIBLE`, `NOT-YET-VERIFIED`) - per default in a synchronous
   background session.
6. afterwards, the session "resets" back to before the audit process, but the model has already audited its own summary
7. only then is the raw span projected out with pi's **append-only** context edits — the session file keeps every original byte,
   so every fold is reversible and offline-auditable.
   (In `branch` mode the audit reply's digest becomes the settlement line, which rides the
   next compaction's summary; the raw content stays retrievable by id: `sam_retrieve` /
   `/sam retrieve <id>`.)

> **The audit quality is the audited model's quality.** A model that cannot audit its own
> work reliably should not run this extension at all — the verdicts are the model's, and a
> weak auditor produces confident `VERIFIED` lines anyway (the gates, the ledger and the
> append-only file keep every fold *retrievable and reversible*, which is the protection;
> they do not make a bad verdict good).

## Status: 0.0.14-dev

Not a release: behaviour is pinned to **pi 0.87.1** semantics; the close-time synchronous
audit is the only audit delivery. Evaluation history: [CHANGELOG.md](CHANGELOG.md).

This pre-release version implements the full **close → audit → settle** loop (append-only
`sam` ledger) **plus the governor and safety layer**:

- **Gates before any draft exists** — target editability, tool-pair integrity, span overlap, savings/ceiling/keep-window: a fold commits whole or is refused *in-band* with an actionable reason.
- **Commit proofs** staged at close, re-validated at commit (append-only growth tolerated, structural drift invalidates); lost folds become terminal `resolved` tombstones at session start, surfaced in `/sam`.
- **Empty-stub refusal** — a `close_unit` with an empty stub over demonstrable work is refused before any ledger mutation.
- **Governor** — pressure zones under pi's own context estimate with hysteresis, and the **D2 coexistence guard** (SAM refuses to fold while another folding folder is active). The governor folds only on an explicit close (`manual` — the only behaviour).
- **Compacted spans** — a span that native compaction already summarized out of view is terminal `resolved` (compaction-owned, never re-folded, zero context edits) — the only policy.
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

The model tools: `close_unit` (close a work unit + its audit), `retire_units` / `unretire`
(retirement of settled units), `adjust_goal` / `read_goal` (the stored goal), `fold_now`
(the model-initiated fold, armed by `SAM_FOLD`) and `sam_retrieve` (retrieval of banked
originals).

| command | what it does |
|---|---|
| `/sam` | status: model, context pressure, zone, D2 state, unit/fold counters |
| `/sam depth [auto\|light\|medium\|full]` | in-session audit-depth switch (no arg: show the current decision; overrides the `SAM_AUDIT_DEPTH` dial for this session) |
| `/sam goal` | show the stored goal (latest-wins) |
| `/sam report` | per-unit ledger table with line detail and tombstones |
| `/sam undo` | restore the last folded unit (rides one short controlled ack turn) |
| `/sam fold <n>` | fold a specific unit now (also overrides a `CORRECTIONS` verdict; refused for folded or tombstoned units, or units without a verifiable verdict) |
| `/sam resolve <n>` | explicitly resolve a stuck/orphaned unit (tombstone) |
| `/sam reaudit <n>` | re-run the close's own audit for a closed-unsettled unit (synchronous child sessions; `VERIFIED` / `CORRECTIONS` settlements are final, `PLAUSIBLE` / `NOT-YET-VERIFIED` / `UNVERIFIED` are upgrade targets) |
| `/sam retrieve <id> ["exact text"]` | serve the original content of a settlement/retrieval id (same resolver as the `sam_retrieve` tool; optional exact-text anchor for a small window) |

**Fold acknowledgement** — every fold kind gets a `sam-fold-ack`: the model's `fold_now`
(its turn ends; the next turn starts with the compacted context + the ack), pi's own
threshold/overflow compactions (acknowledged immediately — the model's next turn starts
with the ack, no user post needed), and the user's `/compact` (queued, delivered at the
next user input).

**Operator dials** (env per pi process; all fail-safe — an unrecognized value means
"default":)

| env | default | effect when active |
|---|---|---|
| `SAM_AUDIT_DEPTH` | `auto` | the close's audit depth. `auto` = `light` while the context is in the pressure band (≥ W−2R), `medium` below (the routine close); `full` is explicit-only. `light` = one turn, zero tool calls → `NOT-YET-VERIFIED` / `VERIFIED` / `CORRECTIONS` (claims ride "verify before acting"); `medium` = a quick contradiction check, may also land `PLAUSIBLE` or `NOT-YET-VERIFIED`; `full` = a thorough check → `VERIFIED` / `PLAUSIBLE` / `CORRECTIONS` / `NOT-YET-VERIFIED`. The in-session `/sam depth` switch overrides the dial; a `close_unit` `depth` argument upgrades the depth (upgrade-only); a carry-over close (unit retirement) is always `light` |
| `SAM_AUDIT_TIMEOUT_MS` | 480000 (8 min) | the audit child's hard budget — on timeout the close stands and settles `UNVERIFIED (audit-failed)` (the stub stays upgradeable — re-close with `depth: 'full'` or `/sam reaudit <n>`) |
| `SAM_PI_CLI` | `argv[1]` of the running pi process | explicit pi CLI entry for the audit children |
| `SAM_NUDGE` | on | a light mid-session ask to checkpoint when work accrues without a close, plus one goal ask (store/refresh via `adjust_goal`) per new outside user input; one nudge per class per stretch. Opt-out: `SAM_NUDGE=off` (the family switch); thresholds: the two dials below |
| `SAM_NUDGE_REASONING_CHARS` (nudge enabled) | 5000 | the thinking floor of the activity nudge — thinking chars accumulated since the last reset |
| `SAM_NUDGE_REASONING_CALLS` (nudge enabled) | 15 | the tool-call floor of the activity nudge — tool calls since the last reset |
| `SAM_FOLD` | on | the model-initiated fold: registers the `fold_now` tool — the model folds the session itself at a clean unit boundary (its turn ends; the next prompt starts with the compacted context + a `sam-fold-ack` message). Opt-out: `SAM_FOLD=off` (pi's native threshold fold still applies — the dial only arms the tool + the nudge fold hint) |
| `SAM_RETIRE_CHARS` | 40000 | the retirement-offer census threshold, in RENDERED settlement-stack chars: when the latest-stack census reaches it, the close sends the soft retire offer. Also caps the auto-retire target (system retirement retires oldest-first until the remaining stack is under `min(this threshold, the token-aware headroom target)` — the 40k rule is the config value, the token-aware term is what guarantees one retirement clears the line for multiple subsequent folds; floor 16000) |
| `SAM_PRESSURE_HEADROOM` | 20000 | the context-pressure safenet's headroom in TOKENS: after every fold, when the re-estimated post-fold context is within this many tokens of pi's auto-fold line (W−R, W the window, R the deployed reserveTokens — read from the live settings), the model gets the act-now pressure nudge (queued before the next LLM call), the auto-retire arms (committed at the next fold unless the model retired in between), and the soft retire offer for the span is consumed |
| `SAM_ORPHAN_KEEP` | 2 | the carried-orphan cap — how many orphaned spans (unclosed work at a fold) the takeover summary carries; older ones stay banked and are retrievable by id |

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

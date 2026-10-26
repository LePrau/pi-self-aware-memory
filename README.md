# pi-self-aware-memory

**Compaction on-the-fly with audits.** The agent folds its own *closed work units* into verified
stubs, continuously, while the reasoning is still warm - without invalidating the precious kv-cache
and meanwhile keeping the raw transcript available for later reference.

> **Version pin:** SAM has been built and tested against **pi 0.87.1 and pi 1.3.0** —
> behaviour is pinned to those versions' semantics. The 0.87.1 → 1.3.0 extension-API diff
> was assessed and SAM runs unmodified on both; pi versions in between are
> not tested.

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

## Status: 0.0.22

The latest release follows up on the v0.0.20/0.0.21 **real settings** with
live feedback: each of the 12 dials carries a **short plain-language
description** (shown on the highlighted `/sam settings` menu row and in the
selector titles), switching the audit depth is **instantly visible on the
context bar** (` audit: <depth>` suffix), and the **save key now applies in-
session AND persists** (pi /settings parity — "clear" releases both layers, a
default value still clears the settings key). Fixed as well: the settings
display of `audit depth` honours the in-session `/sam depth` ledger entry,
so the row, the selector's ✓, and the value the save key persists can never
stale against the bar. The 12 operator dials are configurable in SAM's own
`/sam settings` menu and stored in the `"self-aware-memory"` section of pi's
global settings.json (see below). The first public release was 0.0.18; behaviour is
built and tested against **pi 0.87.1 and pi 1.3.0** semantics; the close-time
synchronous audit is the only audit delivery. Evaluation history:
[CHANGELOG.md](CHANGELOG.md).

This version implements the full **close → audit → settle** loop (append-only
`sam` ledger) **plus the governor and safety layer**:

- **Gates before any draft exists** — target editability, tool-pair integrity, span overlap, savings/ceiling/keep-window: a fold commits whole or is refused *in-band* with an actionable reason.
- **Commit proofs** staged at close, re-validated at commit (append-only growth tolerated, structural drift invalidates); lost folds become terminal `resolved` tombstones at session start, surfaced in `/sam`.
- **Empty-stub refusal** — a `close_unit` with an empty stub over demonstrable work is refused before any ledger mutation.
- **Governor** — pressure zones under pi's own context estimate with hysteresis, and the **D2 coexistence guard** (SAM refuses to fold while another folding folder is active). The governor folds only on an explicit close (`manual` — the only behaviour).
- **Compacted spans** — a span that native compaction already summarized out of view is terminal `resolved` (compaction-owned, never re-folded, zero context edits) — the only policy.
- **Fail-open everywhere** — an extension error surfaces as a stderr line and leaves the session unchanged.

## Requirements

- pi **0.87.1 or 1.3.0** (both built and tested — see the version pin above)
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
| `/sam depth [auto\|light\|medium\|full]` | in-session audit-depth switch (no arg: the TUI opens a depth selector — ✓ on the effective depth, confirm = the in-session switch, the save key = switch + persist; non-TUI shows the current decision; overrides the `SAM_AUDIT_DEPTH` dial for this session; the live bar's ` audit: <depth>` suffix updates at once) |
| `/sam settings [<dial> [<value>]]` | the settings menu: persist the operator dials into the `"self-aware-memory"` section of pi's settings.json — TUI: a menu with per-dial editors (each row carries a short plain-language description of what the dial changes; choice/on-off: confirm applies in-session, the save key = apply + persist; numbers (no save key): confirm = apply + persist, empty releases both; cancel closes); `<dial> <value>`: apply in-session + persist one dial (scriptable, every mode; `clear` releases it); a value equal to the default clears the persisted key |
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

**Settings** (v0.0.20) — every operator dial below can be set **permanently**
instead of via env: SAM stores them in the `"self-aware-memory"` section of pi's
global `settings.json` (the agent dir — `~/.pi/agent`, the env override
`PI_CODING_AGENT_DIR` honoured), read once at session start and written only by
SAM (the same lockfile + atomic-rename discipline pi uses for its own settings
file). Configure them with **`/sam settings`** — TUI: a menu whose rows show
each dial's current value and where it comes from, edited with ↑/↓ (choices /
on-off) or the editor (numbers — the timeouts in seconds). For choices and
on-off, confirm applies in-session and **Ctrl+S** applies + persists — the
save gesture mirrors pi's own configurable `app.thinking.save` keybinding, and
the hint line shows whatever pi itself would show. The number dials have no
save key, and there is usually no reason to change them for a single session,
so their editor's **confirm applies in-session AND persists**, and empty input
**releases both layers** (v0.0.23); or the scriptable form `/sam settings
<dial> <value>` from any mode. Precedence:
**in-session > env (if set) > settings.json > default** — an env dial still wins
for its process until it is unset. The order holds at the decision sites too
(v0.0.21): a menu confirm without the save key changes behaviour for the rest
of the session, and the `statusLine` dial reacts immediately in the TUI —
confirming it off hides the live bar at once, confirming it on brings it back.
From v0.0.22: **the save key applies in-session AND persists** (pi /
settings parity), every dial carries a **one-line plain description**
(highlighted menu row + selector titles), and bar-relevant changes (audit
depth, status line) show on the **live bar at once** — and the `audit depth`
row / selector ✓ / persisted value honour the in-session `/sam depth` ledger
entry (an "auto" entry = release), so the display never stales against the
bar. From v0.0.23: the number dials (the audit timeouts, the retire-offer
threshold, the pressure headroom, the orphan spans kept, the nudge reasoning
floors) **confirm = apply + persist** in the editor (no save key there) and
empty input releases both layers. A dial set to its **default clears the
persisted key** (uniform clear-on-default); a corrupt settings file is refused —
SAM never rewrites it, and every dial falls back to env/default. The ms dials
are stored as ms, displayed in seconds. The settings module is self-contained,
so a future 1.3.0-only feature can gate on capability inside the module and
simply not load while the other features ride 0.87.1 (v1 needed no version
branch — every surface it uses was measured present in both pinned versions).

**Operator dials** (env per pi process; all fail-safe — an unrecognized value means
"default":)

| env | default | effect when active |
|---|---|---|
| `SAM_AUDIT_DEPTH` | `auto` | the close's audit depth. `auto` = `light` while the context is in the pressure band (≥ W−2R), `medium` below (the routine close); `full` is explicit-only. `light` = one turn, zero tool calls → `NOT-YET-VERIFIED` / `VERIFIED` / `CORRECTIONS` (claims ride "verify before acting"); `medium` = a quick contradiction check, may also land `PLAUSIBLE` or `NOT-YET-VERIFIED`; `full` = a thorough check → `VERIFIED` / `PLAUSIBLE` / `CORRECTIONS` / `NOT-YET-VERIFIED`. The in-session `/sam depth` switch overrides the dial; a `close_unit` `depth` argument upgrades the depth (upgrade-only); a carry-over close (unit retirement) is always `light` |
| `SAM_AUDIT_TIMEOUT_MS` | 480000 (8 min) | the audit child's hard budget — on timeout the close stands and settles `UNVERIFIED (audit-failed)` (the stub stays upgradeable — re-close with `depth: 'full'` or `/sam reaudit <n>`) |
| `SAM_FORK_MODE` | `sam` | the branch-audit fork mode (v0.0.24): `sam` (default) = the child session file is written reduced (the compaction-aware active path only — the small file) when the leaf path has a compaction, else pi's `ctx.fork` as before; `native` = ALWAYS pi's full `ctx.fork` (exactly the pre-v0.0.24 behaviour — for extensions that need the full session in the fork; knowingly bigger file, the model context is identical in both modes) |
| `SAM_SUMMARY_MODE` | `fork` | who writes the close summary (v0.0.25): `fork` (default) = `close_unit` takes no stub — a summary child on a fork summarizes the closed span from context and commits it via `update_unit` (the parent extracts the args and drives the audit); `main` = today's behaviour exactly (the model writes the stub in-session — the control arm). Passing a stub under `fork` (or no stub under `main`) is refused with an explanatory error |
| `SAM_PI_CLI` | `argv[1]` of the running pi process | explicit pi CLI entry for the audit children |
| `SAM_NUDGE` | on | a light mid-session ask to checkpoint when work accrues without a close, plus one goal ask (store/refresh via `adjust_goal`) per new outside user input; one nudge per class per stretch. Opt-out: `SAM_NUDGE=off` (the family switch); thresholds: the two dials below |
| `SAM_NUDGE_REASONING_CHARS` (nudge enabled) | 5000 | the thinking floor of the activity nudge — thinking chars accumulated since the last reset |
| `SAM_NUDGE_REASONING_CALLS` (nudge enabled) | 15 | the tool-call floor of the activity nudge — tool calls since the last reset |
| `SAM_FOLD` | on | the model-initiated fold: registers the `fold_now` tool — the model folds the session itself at a clean unit boundary (its turn ends; the next prompt starts with the compacted context + a `sam-fold-ack` message). Opt-out: `SAM_FOLD=off` (pi's native threshold fold still applies — the dial only arms the tool + the nudge fold hint) |
| `SAM_RETIRE_CHARS` | 40000 | the retirement-offer census threshold, in RENDERED settlement-stack chars: when the latest-stack census reaches it, the close sends the soft retire offer. Also caps the auto-retire target (system retirement retires oldest-first until the remaining stack is under `min(this threshold, the token-aware headroom target)` — the 40k rule is the config value, the token-aware term is what guarantees one retirement clears the line for multiple subsequent folds; floor 16000) |
| `SAM_PRESSURE_HEADROOM` | 20000 | the context-pressure safenet's headroom in TOKENS: after every fold, when the re-estimated post-fold context is within this many tokens of pi's auto-fold line (W−R, W the window, R the deployed reserveTokens — read from the live settings), the model gets the act-now pressure nudge (queued before the next LLM call), the auto-retire arms (committed at the next fold unless the model retired in between), and the soft retire offer for the span is consumed |
| `SAM_ORPHAN_KEEP` | 2 | the carried-orphan cap — how many orphaned spans (unclosed work at a fold) the takeover summary carries; older ones stay banked and are retrievable by id |
| `SAM_STATUS_LINE` | on | the live TUI context bar BELOW pi's native context bar (v0.0.19; v0.0.16 was the widget line below the input line): a footer status entry `Context [bar] audit: <depth>` — █ prompt/summary (teal), · closed/audited context (green), ▒ remainder (yellow = outside retention, red = past the compaction line), ░ pi's retention tail (grey), │ pi's compaction threshold (amber), [ ] brackets (near-white), dim ` audit: <depth>` suffix; when tokens are unknown it shows O + ` ??? ` with the | still placed (fills are NBSP — the footer's space-collapsing would squash an ASCII-space fill). Fixed 256-color palette (the dark-theme indices pi's own 256 fallback derives — no light-theme adaptation); TUI mode only (a no-op in RPC/print); opt-out: `SAM_STATUS_LINE=off` — v0.0.21: the dial also reacts mid-session (in-session or via `/sam settings`) and shows/hides the live bar at once; `/sam` keeps the on-demand bar |

## Inspiration

Related pi extensions in the same problem space (base project:
[earendil-works/pi](https://github.com/earendil-works/pi)):

- **observational memory** — [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory): continuously captured session memory, carried across sessions
- **smart compaction** — [alpertarhan/pi-smart-compact](https://github.com/alpertarhan/pi-smart-compact): context hygiene and recoverable compaction around pi's own session lifecycle
- **blackhole** — [k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole): deterministic (non-LLM) structural compaction

## Development

```bash
node --test test/*.test.ts   # zero-dependency suite (the pi-semantics F3 cross-check takes SAM_PI_DIR = the node_modules dir holding the pi package; the settings tests take SAM_SETTINGS_PATH = a temp settings file)
PI_TYPES_DIR=<dir>/node_modules sh typecheck/run-typecheck.sh   # tsc --noEmit vs. pi typings
# add CONTROL=1 to prove the checker can fail before trusting a clean run
```

`PI_TYPES_DIR` must point at a `node_modules` directory containing
`@earendil-works/pi-coding-agent`; the banner prints the exact pi version the check ran
against. A check against one version proves nothing about another.

## License

MIT — see [LICENSE](LICENSE).

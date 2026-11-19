# pi-self-aware-memory

**Compaction on-the-fly with audits.** The agent folds its own *closed work units* into verified
stubs, continuously, while the reasoning is still warm - without invalidating the precious kv-cache
and meanwhile keeping the raw transcript available for later reference.

Ideal for single-threaded agent work with local models like Qwen 3.8 Flash Next on as little 12GB VRAM.

> **Version pin:** SAM requires at least **pi 0.87.1**
> It has been built and tested against most major versions between **pi 0.87.1 and 1.5.2**
> Certain QoL features are only supported from specific versions onwards, but the
> main functionality is ensured for any version starting at 0.87.1
> **Future versions:** SAM rides stable extension-API surfaces and is fail-open
> (an extension error surfaces as a stderr line and leaves the session unchanged)
> So a newer pi without breaking changes is expected to keep working, even if not explicitly mentioned in this readme
>  — SAM does not brick a session by being installed.

## Install

```bash
# with pi install
pi install git:LePrau/pi-self-aware-memory

# from a local checkout
pi install ./path/to/pi-self-aware-memory

# or try it for one invocation without touching settings
pi -e ./path/to/pi-self-aware-memory
```
>[!Warning]
Make sure you run **only one extension** that changes **compaction summary**!
If more than one extension manage compactions, it won't produce good results, because  they are chained:
The second extension will create a summary of the summary from the first extension. 
This is far worse than pi-native compaction.

## Why does this exist

pi's built-in auto-compaction has two major drawbacks: it is slow, and it can lose crucial details.
Especially on systems that can only run one single model at a time, where other fact-collecting
extensions do not not reliably work, this can make an agent unusable.

Occurring at the end of the available context, it creates a whole new summary prompt
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
4. when choosing to close a unit, the model calls close_unit, summarizes the last part of its work, emphasizes 
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
> they do not make a bad verdict good). Be aware, even light audits depend on the model.

## Features

- **Live context bar** — a footer bar below pi's native context bar: prompt/summary, closed/audited context, the remainder, pi's retention tail and the compaction threshold; the threshold and the retention render green when the last close is inside the retention window (the safe-fold state).
- **Settings** — all operator dials are stored in pi's `settings.json` and configurable in the `/sam settings` TUI menu (a plain-language description per dial, mouse-wheel scrollable like the report, hosted at the bottom of the screen); in-session changes apply at once, env vars remain per-process overrides.
- **Reduced audit child file** — when using sam-fork mode, after a compaction the audit child receives only the active path of the session (slimmer file, identical model context).
- **Summary child** (opt-in close mode) — the close summary is written by a summary child on a fork instead of in-session.
- **pi-style tool rows for close and audit** — live elapsed time, final duration, and the audit child's fresh tool-call count.
- **Fold suggestion** — the model is steered to fold at clean unit boundaries (a fold hint on the pressure nudges, a low-pressure fold offer after a settled close).
- **Stub pre-check** — deterministic cheap checks at close time: the commits and files the stub names are verified against the session-discovered git repos and files (read-only, run through pi's normal bash tool path), the result block rides the audit prompt and the settlement summary; failures degrade gracefully (no-result lines), a session-wide hard-error circuit breaker disables the pre-checks with a notice. Dial: `prechecks` (on / off, default on).
- **Immediate fold acknowledgement** — every fold (the model's, pi's native compaction, your `/compact`) is acknowledged to the model in the same turn. Even without good summary, models that are aware of a fold are more concious about their prior context.
- **Orphan records** — unclosed work at a fold is banked as a retrievable record, only what the fold actually lost (a safe fold banks nothing).
- **`/sam report`** — a human-traversable TUI of the whole ledger: every closed unit with its verdict and stub, the openable full detail (markdown-rendered), the retirement subtrees as navigable levels, old orphan spans collapsed into "older orphans (n)" tree rows (only the last `SAM_ORPHAN_KEEP` orphans stay visible — ENTER pushes a run as a level), and the current goal at the bottom. The mouse wheel scrolls the list and the detail (a right-edge scrollbar appears when the content overflows the window).

SAM implements the full **close → audit → settle** loop (append-only
`sam` ledger) **plus the governor and safety layer**:

- **Gates** — editability, tool-pair integrity, span overlap, savings/ceiling/keep-window are checked before any draft: a fold commits whole or is refused *in-band* with an actionable reason.
- **Commit proofs** — staged at close, re-validated at commit (append-only growth tolerated, structural drift invalidates); lost folds become terminal `resolved` tombstones at session start, surfaced in `/sam`.
- **Empty-stub refusal** — an empty stub over demonstrable work is refused before any ledger mutation.
- **Governor** — pressure zones under pi's own context estimate with hysteresis; folds only on an explicit close (`manual` — the only behaviour); the **D2 coexistence guard** refuses to fold while another folding folder is active.
- **Compacted spans** — a span native compaction already summarized out of view is terminal `resolved` (compaction-owned, never re-folded, zero context edits).
- **Fail-open everywhere** — an extension error surfaces as a stderr line and leaves the session unchanged.

The first public release was 0.0.18; behaviour is built and tested against
**pi 0.87.1, 1.3.0, 1.4.0, 1.5.0, 1.5.1 and 1.5.2** semantics; the close-time synchronous audit is the
only audit delivery. Evaluation history:
[CHANGELOG.md](CHANGELOG.md).

## Requirements

- pi **0.87.1, 1.3.0, 1.4.0, 1.5.0, 1.5.1 or 1.5.2** (all built and tested — see the version pin above)
- Node ≥ 22.6 for local development (extension files load via pi's type-stripping loader;
  no build step)
## Known issues
 - **Windows users,** if you're running pi without WSL2, you might have problems with the audit fork:
   If you see errors in close_unit() calls, set `fork mode`  to `native`. This will increase file size for forks, but should fix problems with fork-creation.
 - any change to the system prompt, or changing settings or models within a session will make audits slow until the next compaction.
   This is because context will change for audit children, reasoning blocks will only appear if the same model is used, and settings might impact tool definitions which are included in the system prompt. All this sabotages the whole "re-use the kv cache" machinery.
 - session files accumulate with every close_unit, and especially in native mode this can compound to hundreds of Mb after some time.
   And there is no cleanup mechanism inside of SAM - yet.
 - audit times and summary quality largely depend on the model - SAM has proven very useful with Q3 quants of Q27B on 16GB and Q2 quants of QFN on 12GB
 - audit timeouts for close_unit() audits depend on real time, not on token usage or how long the model actually worked. long tool calls in the audit, or a randomly cold kv cache can easily take away several minutes. SAM still delivers a usable summary (the raw stub always survives).
## Usage

The model tools: `close_unit` (close a work unit + its audit), `retire_units` / `unretire`
(retirement of settled units), `adjust_goal` / `read_goal` (the stored goal), `fold_now`
(the model-initiated fold, armed by `SAM_FOLD`) and `sam_retrieve` (retrieval of banked
originals).

| command                                  | what it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sam`                                   | status: model, context pressure, zone, D2 state, unit/fold counters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/sam depth [auto\|light\|medium\|full]` | in-session audit-depth switch (no arg: the TUI opens a depth selector — ✓ on the effective depth, confirm = the in-session switch, the save key = switch + persist; non-TUI shows the current decision; overrides the `SAM_AUDIT_DEPTH` dial for this session; the live bar's ` audit: <depth>` suffix updates at once)                                                                                                                                                                                                                                    |
| `/sam settings [<dial> [<value>]]`       | the settings menu: persist the operator dials into the `"self-aware-memory"` section of pi's settings.json — TUI: a menu with per-dial editors (each row carries a short plain-language description of what the dial changes; choice/on-off: confirm applies in-session, the save key = apply + persist; numbers (no save key): confirm = apply + persist, empty releases both; cancel closes); `<dial> <value>`: apply in-session + persist one dial (scriptable, every mode; `clear` releases it); a value equal to the default clears the persisted key |
| `/sam goal`                              | show the stored goal (latest-wins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/sam report`                            | per-unit ledger table with date, audit verdict and detailed entry data - browse through all the summarized work units your model created. Understand what it decided to store, what it verified, where it struggled.                                                                                                                                                                                                                                                                                                                                       |
| `/sam undo`                              | restore the last folded unit (rides one short controlled ack turn)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/sam retrieve <id> ["exact text"]`      | serve the original content of a settlement/retrieval id (same resolver as the `sam_retrieve` tool; optional exact-text anchor for a small window)                                                                                                                                                                                                                                                                                                                                                                                                          |

**Fold acknowledgement** — every fold kind gets a `sam-fold-ack`: the model's `fold_now`
(its turn ends; the next turn starts with the compacted context + the ack), pi's own
threshold/overflow compactions (acknowledged immediately — the model's next turn starts
with the ack, no user post needed), and the user's `/compact` (queued, delivered at the
next user input).

## Settings

SAM allows you to tweak many settings according to your workload, pi
configuration and agent capability. The defaults are tweaked for 120k
context, an agent with long reasoning (up to 10k token per turn) and a slow
token generation in the ballpark of 10–30 t/s.

Three and a half ways of changing settings:

- **the TUI command `/sam settings`** — the straightforward one: most
  settings have a reasonable explanation; just hitting enter changes the
  value for the current session (just like choosing models or thinking
  does!), pressing Ctrl+S saves and applies.
- **editing your settings.json manually** — the half way: the TUI grants the
  same, there are no hidden dials, but sometimes editing the JSON is just
  faster (also: the agent can do that one for you).
- **environment variables**, either for certain start scripts or on the fly
  — allows you to override a specific setting just for one session, or from
  a start script if you intend to use the extension with another agent.

The available settings (the `settings.json` keys of the `"self-aware-memory"` section),
every dial is fail-safe, an unrecognized value means "default":
```
  "self-aware-memory": {
    "calmAuditDepth": "light",
    "retireChars": 20000,
    "nudge": true
  },
```

| setting                | default        | description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auditDepth`           | `auto`         | how thoroughly each closed unit is checked — values: `auto` (pressure-driven: `light` in the pressure band, `calmAuditDepth` below it), `light` (one turn, no tool calls → `NOT-YET-VERIFIED` / `VERIFIED` / `CORRECTIONS`), `medium` (quick contradiction check, may also land `PLAUSIBLE`), `full` (thorough). The in-session `/sam depth` switch overrides the dial, a `close_unit` `depth` argument upgrades it (upgrade-only), a carry-over close (unit retirement) is always `light`. env var override: `SAM_AUDIT_DEPTH` |
| `calmAuditDepth`       | `medium`       | the depth `auto` uses while the context is far below the compaction line — values: `light`, `medium`, `full`. env var override: `SAM_AUDIT_CALM_DEPTH`                                                                                                                                                                                                                                                                                                                                                                          |
| `forkMode`             | `sam`          | the branch audit's child session file — values: `sam` (reduced when the leaf path has a compaction: only the compaction-aware active path, the small file; else pi's full fork), `native` (always pi's full fork — for extensions that need the full session in the fork; the model context is identical in both modes). env var override: `SAM_FORK_MODE`                                                                                                                                                                      |
| `summaryMode`          | `main`         | who writes the close summary — values: `main` (the model writes the stub in-session), `fork` (opt-in, discouraged for now: the summary child on a fork summarizes the closed span and commits it via `update_unit`; passing a stub under `fork` — or no stub under `main` — is refused with an explanatory error). env var override: `SAM_SUMMARY_MODE`                                                                                                                                                                         |
| `auditTimeoutMs`       | 480000 (8 min) | the base audit budget (seconds in the TUI, stored as ms) — on timeout the close stands and settles `UNVERIFIED (audit-failed)` (the stub stays upgradeable). env var override: `SAM_AUDIT_TIMEOUT_MS`                                                                                                                                                                                                                                                                                                                           |
| `auditTimeoutMediumMs` | the shared one | how long a medium audit may run — falls back to `auditTimeoutMs`. env var override: `SAM_AUDIT_TIMEOUT_MEDIUM_MS`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `auditTimeoutFullMs`   | the shared one | how long a full audit may run — falls back to `auditTimeoutMs`. env var override: `SAM_AUDIT_TIMEOUT_FULL_MS`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `nudge`                | on             | a light mid-session ask to checkpoint when work accrues without a close, plus one goal ask (store/refresh via `adjust_goal`) per new outside user input; one nudge per class per stretch. Values: on / off. env var override: `SAM_NUDGE`                                                                                                                                                                                                                                                                                       |
| `nudgeReasoningChars`  | 5000           | the thinking floor of the activity nudge — thinking chars accumulated since the last reset. env var override: `SAM_NUDGE_REASONING_CHARS`                                                                                                                                                                                                                                                                                                                                                                                       |
| `nudgeReasoningCalls`  | 15             | the tool-call floor of the activity nudge — tool calls since the last reset. env var override: `SAM_NUDGE_REASONING_CALLS`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `retireChars`          | 40000          | the retirement-offer census threshold, in rendered settlement-stack chars: when the latest-stack census reaches it, the close sends the soft retire offer; it also caps the auto-retire target (oldest-first until the remaining stack is under `min(this threshold, the token-aware headroom target)`; floor 16000). env var override: `SAM_RETIRE_CHARS`                                                                                                                                                                      |
| `prechecks`            | on             | deterministic cheap checks at close time (read-only `git status` / `git log` / `ls` / `sed`, run through the session's own bash tool): the commits and files the stub names are checked against the session-discovered git repos and the edit/write/read file index; the result block rides the audit prompt (flat entries, no model reasoning) and the positive findings ride the settlement summary. Expected "not found" outcomes degrade to a no-result line — a run where every call hard-errors disables the pre-checks for that session (in-memory, with a notice). Values: on / off. env var override: `SAM_PRECHECKS` |
| `pressureHeadroom`     | 20000          | the context-pressure safenet's headroom in tokens: after every fold, when the re-estimated post-fold context is within this many tokens of pi's auto-fold line (W−R, W the window, R the deployed reserveTokens — read from the live settings), the model gets the act-now pressure nudge (queued before the next LLM call), the auto-retire arms (committed at the next fold unless the model retired in between), and the soft retire offer for the span is consumed. env var override: `SAM_PRESSURE_HEADROOM`               |
| `orphanKeep`           | 2              | the carried-orphan cap — how many orphaned spans (unclosed work at a fold) the takeover summary carries; older ones stay banked and are retrievable by id. env var override: `SAM_ORPHAN_KEEP`                                                                                                                                                                                                                                                                                                                                  |
| `statusLine`           | on             | the live TUI context bar below pi's native context bar — the footer entry `Context [bar] audit: <depth>`: █ prompt/summary, · closed/audited context, ▒ remainder (yellow = outside retention, red = past the compaction line), ░ pi's retention tail, │ pi's compaction threshold; when tokens are unknown it shows O + ` ??? `. Fixed 256-color palette, TUI mode only (a no-op in RPC/print); reacts to in-session changes at once, `/sam` keeps the on-demand bar. Values: on / off. env var override: `SAM_STATUS_LINE`    |

`SAM_PI_CLI` is an env-only knob (no dial, no settings.json key): the explicit
pi CLI entry for the audit children — defaults to the `argv[1]` of the
running pi process.

## Inspiration

Related pi extensions in the same problem space (base project: [earendil-works/pi](https://github.com/earendil-works/pi)):

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

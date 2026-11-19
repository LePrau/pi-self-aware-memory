# Changelog

Short, objective changelog — 1–3 bullets per release: what was done.
Root causes, design decisions, and details: `git log` in this repo and the README.

## v0.0.49 — 2026-11-19

- feature: /sam report — old orphan runs collapse into "older orphans (n)" tree rows (ENTER pushes the run as a level); the last SAM_ORPHAN_KEEP orphan rows stay visible in the main list
- feature: /sam report — the detail opens with the full banked entry (the 12,000-char cap is off for the report; the `sam_retrieve` tool keeps it)
- feature: /sam report — mouse-wheel scrolling (list and detail) with a pi-chat-style right-edge scrollbar when the content overflows; the report is hosted as a fullscreen overlay so the wheel reaches it

## v0.0.48 — 2026-11-19

- bugfix: pre-check file claims resolve absolute paths correctly (literal absolute test first, de-slashified relative fallback)

## v0.0.47 — 2026-11-19

- feature: stub pre-checks — deterministic close-time commit/file verification (dial `prechecks`, default on, circuit breaker per session); results ride the audit prompt and the post-compaction summary
- change: strong settlements carry the STUB before the section blocks in the summary (reasoning-order layout)

## v0.0.46 — 2026-11-17

- bugfix: Windows SAM-fork audit/stub children no longer fail with "No API key found" — the child inherits the parent's model via `--model` (flag absent when no model is set)

## v0.0.45 — 2026-11-17

- bugfix: the fork file's basename is platform-safe on Windows (path separators no longer break native-fork child discovery); POSIX behaviour unchanged

## v0.0.44 — 2026-11-17

- change: the calm-zone audit depth accepts `light` (dial `calmAuditDepth`), so auto dispatches light in the calm zone

## v0.0.43 — 2026-11-17

- feature: /sam report v2 — the detail view renders with pi's Markdown component (feature-detected, version-tolerant)

## v0.0.42 — 2026-11-17

- feature: /sam report v2 — ENTER on a retirement tree row pushes the subtree as a navigable level; natural detail scroll (no phantom space)
- change: retirement units get two rows (entry + tree); auto-retire carriers get rows

## v0.0.41 — 2026-11-17

- feature: /sam report v2 polish — fixed columns, time column, class colors; retirement rows open a detail view

## v0.0.40 — 2026-11-16

- feature: /sam report v2 — windowed unit list with bottom cursor (PgUp/PgDown) and retirement subtrees; retired units leave the main tree

## v0.0.39 — 2026-11-16

- bugfix: safe folds no longer mint artifact orphans — span-gap entries (close tool result + preamble) are excluded from the orphan zone

## v0.0.38 — 2026-11-16

- feature: /sam report — human-traversable ledger (TUI list, lazy full summary, retirement + orphan rows, static text fallback)

## v0.0.37 — 2026-11-16

- change: the model learns of a fold the moment it happened — the fold-ack channel is steer-when-continuing (idle ⇒ append, open turn ⇒ steer, settling run ⇒ append)

## v0.0.36 — 2026-11-15

- change: orphaned units cover only what a fold actually lost — safe folds mint no orphan; straddling folds orphan only the lost part

## v0.0.35 — 2026-11-15

- feature: the context bar turns green on safe folds (threshold + retention run when the last close sits within keep before the fold line)

## v0.0.34 — 2026-11-13

- bugfix: the context bar's scale corrected to the API token scale (the chars/4 fields overstated context — no fake remainder after close_unit)

## v0.0.33 — 2026-11-11

- change: the deferred nudge channel is explicit — each firing decides append vs steer
- feature: the fold offer only fires when the span is compressible (≥ 20k tokens since the last compaction)
- bugfix: custom_message projection fix

## v0.0.32 — 2026-11-10

- change: fold_now-only messages take the deferred nudge channel (they never start a SAM turn)

## v0.0.31 — 2026-11-10

- change: fold hint reworded; low-pressure fold offer
- bugfix: close-in-flight guard — no new close while an audit is running

## v0.0.30 — 2026-11-06

- bugfix: the audit child's tool-call count is fresh-only (the parent's own history no longer counts)

## v0.0.29 — 2026-11-06

- change: settled-model gate — no SAM output after the model settled (nudges and notices append to the next user turn, never a SAM round)

## v0.0.28 — 2026-10-27

- feature: elapsed time on close and audit — pi-style tool rows for close_unit/update_unit, the audit child's tool-call count, the live in-flight audit line

## v0.0.27 — 2026-10-26

- change: the summary-mode default flips back to `main` (the fork mechanism is kept, fork discouraged for now)

## v0.0.26 — 2026-10-26

- feature: stale-session tool heal — the SAM version is marked in the session and every process self-heals the tool set at session_start
- bugfix: fork-mode close fails fast with the `stub-update-unavailable` reason when the heal is unavailable; session-tree navigation re-heals

## v0.0.25 — 2026-10-25

- feature: the summary child — `SAM_SUMMARY_MODE main|fork` dial, stub-less close committed via `update_unit` from the stub fork
- bugfix: four branch-session fixes (child runner stderr cap, first-close guard, instructed unit id, F1 span)

## v0.0.24 — 2026-10-24

- change: the branch audit's child session file is reduced (compaction-aware fork path, `ctx.fork` fallback)

## v0.0.23 — 2026-10-23

- change: the settings editor: confirm = apply in-session + persist; leaving the editor empty releases both

## v0.0.22 — 2026-10-23

- change: every settings dial carries a plain-language description
- change: the bar tracks a depth switch at once; save = apply + persist (pi /settings parity)

## v0.0.21 — 2026-10-23

- change: in-session settings bind at all dial decision sites; the status-line dial shows/hides the live TUI bar instantly

## v0.0.20 — 2026-10-23

- feature: real settings — 12 dials stored in settings.json via `/sam settings` (in-session > env > settings > default; clearing a dial removes it)

## v0.0.19 — 2026-10-23

- change: the SAM context bar moves below pi's native context bar ("Context " prefix, footer extension-status entry)

## v0.0.18 — 2026-10-20

- bugfix: filler-tolerant branch-audit reply parsing (narrative-first replies no longer fail acceptance)

## v0.0.17 — 2026-10-20

- feature: pi 1.3.0 compatibility
- feature: `read_goal` gains an optional version id; the orphan zone's CALLS argument cap raised

## v0.0.16 — 2026-10-19

- feature: SAM TUI status line — a live line below the input line (prompt/audited/retention segments, compaction threshold, audit depth; dial `SAM_STATUS_LINE`)
- change: in-flight token estimate — the bar moves during a turn (streamed tokens + tool partials)
- bugfix: the audited segment counts closed spans retained in the post-fold retention tail; audited glyph ░ → ·

## v0.0.15 — 2026-10-19

- feature: `/sam status` gains a context bar (system prompt vs audited/unaudited context, compaction threshold)

## v0.0.14 — 2026-10-18

- feature: the medium audit stops early (effective budget into the prompt; `PLAUSIBLE` is a complete answer)
- feature: per-depth audit timeouts and the calm-zone depth dial (`SAM_AUDIT_CALM_DEPTH`)
- change: the `close_unit` `depth` argument becomes a full override (light|medium|full); failed audits bank up to 4 KB of child diagnostic detail

## v0.0.13 — 2026-10-18

- bugfix: retire-census + safenet parity — the retirement machinery counts what the summary actually renders (auto-retire no longer re-selects already-retired units)

## v0.0.12 — 2026-10-18

- feature: native-fold auto-ack — pi's own threshold/overflow compactions (and their failures) inform the model; the user's /compact stays queued

## v0.0.11 — 2026-10-18

- change: the full audit accepts `NOT-YET-VERIFIED` as the honest weakest rung (process failures still take the D9 hatch)
- feature: the audit child gets one deadline nudge at 50 % of its budget

## v0.0.10 — 2026-10-17

- feature: the medium audit tier — a depth between light and full for the routine close, the `PLAUSIBLE` verdict, the `close_unit` `depth` upgrade lever
- change: auto-depth mapping — light at/above the watch line, medium below, full explicit-only

## v0.0.9 — 2026-10-17

- removal: legacy-code-eviction wave A — the followUp/steer audit-delivery arms go (the synchronous close is the only delivery), the user-facing /sam audit/settle surface goes, the provider-busyness probe is extracted to the dev repo

## v0.0.8 — 2026-10-16

- removal: the governor modes (display/assisted/auto) — `manual` is the only behaviour
- removal: the `SAM_COMPACTED_SPAN=refuse` opt-out (compaction-owned spans always resolve)

## v0.0.7 — 2026-10-16

- feature: the context-pressure safenet — the post-fold pressure nudge arms an auto-retire, committed at the next fold before the summary renders
- feature: orphans are minted a unit id at fold time — retirable, unretirable, retrievable

## v0.0.6 — 2026-10-15

- bugfix: summary-sizing — old settlement layers are always stripped from the carried summary (fixes the O(N²) growth) + carried-orphan cap (`SAM_ORPHAN_KEEP`, default 2)

## v0.0.5 — 2026-10-14

- feature: fold-resume — a model-initiated fold restarts the turn (the ack goes triggerTurn from the tool's onComplete)

## v0.0.4 — 2026-10-14

- feature: model-initiated fold — the `fold_now` tool + the sam-fold-ack channel for every fold kind (dial `SAM_FOLD`, default on)
- bugfix: two goal-nudge fixes

## v0.0.3 — 2026-10-06

- feature: retire soft + upgrade — `retire_units`/`unretire` (soft retirement with carry-over into a new unit)
- feature: audit ergonomics — `/sam depth` in-session switch, economy rules in the full audit, the running audit line names its mode
- change: the close ack and the in-flight line carry the stub size in lines and chars

## v0.0.2 — 2026-10-05

- feature: `/sam goal` — show the stored goal
- feature: TUI argument completion for /sam subcommands; the compaction summaries gain headings + bullets
- change: the close-unit UX — stub size in the ack, live in-flight audit line

## v0.0.1 — 2026-09-25

- scaffold: pi package, `/sam status`, node --test suite

## Unreleased (early development, before versioning — 2026-09-29 → 2026-10-05)

- 2026-09-29 · minimal end-to-end loop — `close_unit`, the in-series auditor, the append-only ledger, the folder, `/sam status`/`mode`
- 2026-09-30 · fold gates + commit proofs, empty-stub refusal, the governor + safety, `/sam fold`/`resolve`/`undo`
- 2026-09-30 · steer-audit delivery, the self-contained audit instruction, the compaction-owned span policy (tombstone)
- 2026-10-01 · the branch-audit surface (v3), the synchronous close-time audit
- 2026-10-02 · goal persistence (`adjust_goal`/`read_goal`), the never-fold audit child, the settlement-block reformat, the settle-dispatch anomaly fix
- 2026-10-03 · the goal-clarification nudge
- 2026-10-04 · the close-time goal nudge, nudge texts with an explicit close commitment, the model-switch ladder fix, LAST MODEL TEXT restricted to assistant text
- 2026-10-05 · the audit-delivery default flipped `followUp` → `close`

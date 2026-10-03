# Changelog

## Unreleased — goal-clarification nudge (D11b; 2026-10-03)

**Design note: dev-repo `2026-10-03-v4-goal-clarification-nudge.md`.** Trigger: the measured gap at `2e1b2f0` (no active goal nudge — only static tool-description text + the fold-time fallback; across all 19 battery rep banks the model never once called `adjust_goal`, every goal record `basis: "takeover-fallback"`). Paul's decision 2026-10-03: land it FIRST (choice B), then the operator arm O is its first live proof.

**What ships:** one soft offer PER OUTSIDE USER-INPUT EVENT asking the model to store/refresh the goal (`adjust_goal`), fired at the model's FIRST assistant message after the input ("after user input and the first agent turn … before the second round" — Paul), delivered in the D7 steering channel (`[sam-nudge]` marker + `deliverAs: "steer"`). Two pinned texts (Paul's 2026-10-03 wording, surgical fixes only — `src/goal-nudge.ts` `GOAL_NUDGE_TEXTS`): the **sessionstart** ask (the session's first outside input, only when no goal is stored yet) and the **userinput** reminder (every other outside input — "If the new input changes the shape of our current goal, you may update it via adjust_goal."). Classification (Paul verbatim: "outside input, mostly from users (or an outside agent) … should trigger; tool calls, and automatically generated steers from within the TUI session itself should never trigger that" — measured pi 0.87.1: `input` event sources `interactive`/`rpc`/`extension`; `sendUserMessage` ⇒ `source: "extension"`): external (interactive, rpc) arms; extension-delivered, `[sam-`-prefixed (F4 convention) and blank text never (the marker rule closes the self-trigger loop). Once per event (a re-input before the fire replaces the pending one — latest event wins); a successful `adjust_goal` tool result clears the pending offer; a fire-time re-check drops it if the goal got stored meanwhile; suppressed (recorded, the D9 `sam-nudge` ledger shape, `trigger: "goal"` + variant) while a close-audit is in flight or the line is an audit fork. Gates: the v4 `close` dial + the `SAM_NUDGE` family gate (one switch for D7 + this — `childEnv` forces it off in spawn children, so the one-turn/zero-tool-call audit contract is untouched), no new dial, no time, no context ruler. Scope guard: D7, the D11 goal machinery (tools, latest-wins, fallback, takeover gate), the `close_unit` contract and audit dispatch are all UNCHANGED — the nudge family grows one event-based class, nothing else moves. New pins: `test/goal-nudge.test.ts` (21 tests — the two texts byte-pinned, classification total+exact, the state machine, the ledger shapes, the gate parity, state integration) + the `extension.test.ts` registration-surface pin (the new `input` subscription). First live proof: the operator arm O rep (owed, STOP/GO per rep).

**Local state (green, 2026-10-03):** suite **374 tests / 368 pass / 0 fail / 6 pinned skip** (baseline 353/347/0/6 + the 21 new pins; Node v24 type-stripping); **typecheck CLEAN** (tsgo 7.0.2, strict + `erasableSyntaxOnly`, pi **0.87.1** typings, seeded control verified first; the workspace `node_modules` tsgo binary carries no exec bit on this mount — the gate ran it from a /tmp copy with its lib siblings, state-clean).

## Unreleased — D11 goal persistence + D10 never-fold audit child + settlement-block reformat + settle-dispatch anomaly fix (2026-10-02 batch)

**Design note: dev-repo `2026-10-02-v4-batch-d11-goal-d10-neverfold-anomaly.md`.** Spec input: the measured run `sam-small-unit-03` findings (goal gap, child fold, the [201]–[204] re-settle wave) + Paul's 2026-10-02 rulings (the 6-point adjudication, note §7).

**D11 — goal persistence (close-dial surface; the v3 control arms keep their tool set and status block byte-stable):**

- **`adjust_goal`** — set/update the stored goal (mutable, **latest-wins** — mirrors settlements' latest-per-unit rule; the close dial surfaces it, the followUp/steer/branch arms do not): the goal text is stored **verbatim** (no model paraphrase — zero model calls, unchanged), as an append-only `sam` ledger record (`kind: "goal"`); soft expectation only (Paul: "soft is what we want") — `close_unit` never refuses, the deterministic fallback is the safety net; empty goal ⇒ refused (nothing stored); audit-fork self-guard (a disposable child can never read or mutate the main session's goal).
- **`read_goal`** (Paul's ruling 1: "it is important to get it back, so it can modify accordingly"): the current goal **verbatim** (labelled `adjust_goal` / `TAKEOVER FALLBACK` by basis) + the earlier versions enumerated from the append-only ledger (tombstones) + the change path. No goal ⇒ an actionable "none stored" line.
- **Takeover gate becomes STATE-LEVEL (the D12 candidate absorbed):** the takeover fires on **a goal on the branch OR any settlement on the branch** (was: a settlement in the span) — fixes the fold-2 corner (all settlements on the kept side) and the goal-only case; control arm preserved (neither ⇒ pi-native summarization, arm-C shape unchanged).
- **The goal rides the HEAD of every takeover summary** (Paul: "the goal gets inserted before session content after compaction") — before the carried previous summary, before the settlement blocks; the old goal block is stripped from the carried summary by **pinned-header + marker detection only** (a summary SAM did not author is never touched — fail-safe); prior goal records remain in the ledger (visible via `read_goal` — modify, don't accumulate, ruling 5).
- **Deterministic fallback (Paul's "we take over the user input and n agent turns verbatim as goal"):** at the fold, ONLY when a settlement is present and no goal record is (a close happened, the model never called `adjust_goal`): capture the latest real user input + **n = 1** agent turn (ruling 3; thinking blocks excluded; tool-call-only turns skipped) verbatim, labelled takeover-derived, and **commit it as a goal record** (durable; the next fold rides the stored goal); commit failure is fail-open (the summary still carries the goal block — the takeover never blocks a compaction).
- **Pins (wording = pins, house rule):** the goal block header (`Goal (stored <iso> via adjust_goal — latest version, replaces earlier ones):` / the fallback header), the `[end of goal]` marker, the `GOAL FALLBACK` capture label, the one-liners, the `DELIVERY`/`STUB`/`REASON`/`FILES` block labels, the takeover pointer — all shipped with their test pins; `/sam status` gains the goal line (close-dial surface); the compaction entry's `details` slot carries the goal meta (the entry stands alone as provenance, F1).
- **Not in scope (not assumed):** the goal is NOT in the audit child's instruction (Paul's spec silent — and the fork self-guard refuses the goal tools in an audit fork anyway).

**D10 — the never-fold audit child (close dial, the audit child ONLY — the prepare child stays control):** the audit child is spawned with its **own agent dir** (`sam-audit-agentdir/<label>` under the session dir, removed after exit): `settings.json` as a real file = the parent's global settings with **`compaction.enabled = false` forced** (`auditChildCompactionSettings` — pure, total, never throws; every other key preserved), everything else **symlinked** (`models.json`, `auth.json`, `sessions`, `themes`, `tools`, `bin`, `prompts` — identical sharing to today's shared-dir child). Mechanism (pi 0.87.1, source-measured): `PI_CODING_AGENT_DIR` (dist/config.js `getAgentDir`) + settings-resolve order (global then project override) + no CLI compaction flag (measured) ⇒ env override. Consequence pinned: with `enabled = false` BOTH compaction paths die (threshold + overflow-recovery) — a non-foldable child that overflows dies without a reply, so the failure class is the D9 hatch `UNVERIFIED-AUDIT-FAILED` (bold-claim-us-with-caution: the stub settles, claims ride "verify before acting"); NOT-YET-VERIFIED is contractually impossible without a reply. Fail-open: if the child dir cannot be built the audit runs with the shared dir (logged loud); the takeover + D9 hatch remain the rescue (measured safe in run-03). The `PI_CODING_AGENT_DIR` + `sam-audit-agentdir` + settings-merge behaviour are pinned in `test/closeaudit.test.ts` (D10 pins).

**Settlement-block reformat (the takeover summary, all dials that take over):** unit-numbered blocks (`[uN] <12-hex> — <VERDICT>`), every section labelled + verbatim (FACTS / DECISIONS / DISPROVED / EXPLORED-DISCARDED / EVIDENCE), **EVIDENCE stays ONE labelled line** (verbatim-measured counter-example: a `"; "` INSIDE a quoted evidence item — bullet-splitting corrupts content), the weak blocks gain **STUB** (D9-hatch parity: `NOT-YET-VERIFIED` blocks now carry the model's own stub; `DELIVERY` holds the delivery note; the hatch keeps STUB/FILES/REASON + `claims UNVERIFIED`), the goal block first (D11), the pointer last. The flat `settlementLine` for STRONG verdicts stays byte-stable (the v3 line pin holds); the weak line **gains the stub** (pinned — a user-visible change, shipped with its pins + the design note).

**Settle-dispatch anomaly fix (the run-03 [201]–[204] wave — weak items re-committed over an existing weak settlement, `supersedes === own id`):** (a) the staged item is **dequeued on a successful verdict-commit** (the D9 commit never did — the drain then saw the stale weak item); (b) a **WEAK staged item never commits over an existing settlement** (strong-idempotence OR weak-over-weak — the guard tightened in BOTH commit paths: the drain AND the verdict-commit); a STRONG item over a weak settlement still upgrades (the legitimate D5/D9 upgrade lever, ARM-3 unchanged). Arm: `test/d8d9-arms.test.ts` ARM-2c (weak verdict-commit at close + settle boundary ⇒ exactly one settlement, no duplicate resolve, never `supersedes === own id`).

**Ledger validator residual (caught by this batch, `src/ledger.ts`):** the `settlement` / `resolve` record cases whitelisted only `VERIFIED | CORRECTIONS | UNAUDITABLE` — the D8 light (`NOT-YET-VERIFIED`) and D9 hatch (`UNVERIFIED-AUDIT-FAILED`) verdicts were counted **malformed and dropped on rebuild**. Now the full verdict class is accepted; `goals` added to the rebuild projection (`/sam status` and the goal arms depend on it).

**Local state (all green, 2026-10-02):** suite **330 tests / 324 pass / 0 fail** (Node v24 type-stripping; the v3 control arms — two-tool surface on the followUp dial, the status block, the one-close-per-turn refusal, the strong-line byte pin — intact); **typecheck CLEAN** (tsgo 7.0.2, strict + `erasableSyntaxOnly`, pi **0.87.1** typings — the `erasableSyntaxOnly` pin means the shipped code load-identical to what pi strips and runs). Arms owed before the next live rep (v4-plan §9, rule unchanged): suite + typecheck re-confirmed at the gate on the committed tree + **the F1 approval line for run-03 (Paul's accept/amend) into the run-03 FINAL manifest** — then the S13 battery (per-rep STOP/GO + approval line, F1).

## Unreleased — synchronous close-time audit (dial `close`), v4 core local build (2026-10-01)

**Shape (design note: dev-repo `v4-plan.md` §1–§4):** the close's audit runs **synchronously
inside the `close_unit` call** — a dedicated child process prepares a fork of the current
session state (the same model-free `/sam audit <n>` command), an audit child performs one
model turn on the **fork file**, the verdict is validated **from that file** (pure,
file-based), and the tool returns ONE line: `Unit N closed — audit VERIFIED
(<retrievalId>)` / `… CORRECTIONS: …` / `… NOT-YET-VERIFIED: …` (D8 light) /
`… UNVERIFIED (audit-failed: …)` (D9 hatch) + the exact upgrade action (the
D8/D9 block below supersedes this paragraph's one-line and settle-boundary wording,
2026-10-02). The close record commits **before** the audit: every audit failure keeps the
close effective and re-auditable (re-close with the same stub, or `/sam audit N`). Several
closes per turn are normal (each close starts the next unit; spans are close-to-close; a
close over a span with no new work since the previous close is refused with an actionable
line). **No fold at close** (deliberate): the closed span stays in view until native
compaction takes over or `/sam fold` is issued; the settlement + resolve terminal commit
**at verdict time** (D9, 2026-10-02 — see the block below), the settle boundary keeping
only as the idempotent backstop. The main line never carries the
audit exchange (an audit-fork self-guard refuses `close_unit` inside an audit
side-session). `close_unit` declares `executionMode: "sequential"` (child processes are
single-flight by design).

**New/changed surface (v3 dials byte-stable — the control arm is untouched):** dial
`SAM_AUDIT_DELIVERY=close` (default stays `followUp`; unknown values = default);
`SAM_AUDIT_TIMEOUT_MS` (default 8 min, capped 24 h); `SAM_PI_CLI` (default `argv[1]`
fail-safe); new copy `CLOSE_UNIT_NO_NEW_WORK` (replaces the one-close-per-turn refusal
**on this dial only**; the v3 dials keep their refusal byte-stable); deferred-reason
vocabulary += `pipeline-crashed` plus an honest per-phase split measured by tests
(a crash at the audit step reports `audit-spawn-failed`, never a prepare failure);
`cacheLedger.noteCommit` union += `close-audit`; `GuardFactKind` += `close-audit`;
resolve basis `close-audit` accepted in the ledger (a unit so settled terminates
`resolved`, not `pendingReaudit`).

**Local state (all green, 2026-10-01):** suite **267 tests / 261 pass / 0 fail / 6
env-skips** (the v3 regression bar intact + the new close-audit handler matrix 11/11 with
an injectable child runner — the suite never spawns a process) ; typecheck CLEAN (tsgo
7.0.2, pi 0.87.1 typings, CONTROL=1 discipline proven against a seeded error). **Capability
proof on real pi 0.87.1 (live, operator-authorized 2026-10-01, mock-free):** the mid-turn
double-liveness fork — main process live inside a singular tool call, a second live pi
process forking AT that tool call, the main line resuming cleanly (fork cut from the
shared leaf, zero conversational tail, unbroken id chains, no model-visible
contamination): banks (dev repo) `run-outputs/probe-midturn-fork-2026-10-01-r1` (red-as-is —
over-strict assertion, shape discovery kept as evidence) + `-r2` (PASS, all hard
assertions green). **Remaining (not yet done):** the deterministic walk arms (multi-fork
+ fail paths) and the full local gate — and only then, per rep with the operator's GO in
the manifest, any live v4 run (F1).

**D7 FINAL — nudge spec settled + landed (2026-10-02, Paul's spec + confirmations; wording still PROVISIONAL — his):** the nudge now runs on ONE measured ruler — `gap = ctx − baseline` (baseline = the last successful `close_unit`, then session start / the post-compaction view), with a FLOOR of **20,000 tokens = pi v0.87.1's measured `compaction.keepRecentTokens` default** (the raw kept tail of every compaction, takeover AND native — source pi v0.87.1 `compaction.ts` cut-point walk + settings-default; measured in the settled run's compaction #4: `tokensBefore` 115,754, `firstKeptEntryId` at position 88,117 ⇒ 27.6k kept). NO override, NO dial (Paul 2026-10-02) — the floor is the retain window of the "last close farther than the retain window" rule AND the KV-headroom rationale (Paul's root cause, 2026-10-02: "the auditor failed because it tried to audit when kv was close to 32k context and failed because there was simply not much kv left" — the banked pair found in `run-outputs/` (P4 armA @ registered 32,768 window — audit stage FAIL, `report.md`: "audit instruction drained — no [sam-audit] user message", "verdict=undefined"; P5 armE @ 49,152 — 18/18 flawless) is that failure MODE; the earlier drafts' model-capability-floor reading is RETRACTED, house rule). Two classes share the floor (one of each per stretch; a close OR a settlement-less compaction re-arms both, baseline re-stamped at the next observed ctx): **`gap`** — `gap ≥ 20k` (any zone), ≤1 per stretch, global cooldown (SUPERSEDED by the same-day correction below: NO time in any trigger — the per-stretch flag is the anti-spam) — the early-checkpoint ask (audit on a small, still-fast context); **`band`** — zone `watch`/`action` (≥ W−2R, one full reserve below the native line W−R) AND `gap ≥ 20k`, ≤1 per stretch, **NOT cooldown-gated** ("a second urgency nudge is allowed even if the earlier nudge still did not get a close_unit as answer" — Paul, verbatim), and it CONSUMES the stretch's `gap` flag (urgency supersedes — spam guard); in-band with the gap under the floor stays SILENT (the 96k/105k case: a 9k unclosed tail fits the retained window ⇒ nothing at risk — channels A (settlement lines, distance-independent — takeover source-verified) + B (raw kept tail); a DEFERRED audit falls out to the native path, where the stub survives only via B/C). `reasoning` class unchanged (SUPERSEDED by the same-day correction below: it gets its OWN activity rulers — tool calls + thinking). `NudgeRuntime` re-derivation: `firedGap`/`firedBand` + `baselineTokens`/`pendingBaselineReset` (close/compaction re-stamp, ruler-missing stays pending — F3). Text: BOTH `gap` and `band` carry the current context share (Paul 2026-10-02: "include current context in the nudge, EXCEPT for the urgency call, which should contain the warning that a fold is imminent" — `band` keeps "climbing toward pi's compaction line"); `gap` = the early-checkpoint framing; PROVISIONAL, vetoable (reword = pin rewrite). Wiring: `session_before_compact` is now a stretch boundary for ANY compaction (takeover idempotent — the close already re-armed) + close re-arm via the toolResult path (both pinned). KNOWN SIMPLIFICATION (labelled): resumed sessions start the baseline at 0 (gap = current ctx) — conservative direction (nudges more, never less), flagged in the design note. **Local state (re-measured on this tree 2026-10-02):** nudge pins **38/38**; suite **309 tests / 303 pass / 0 fail / 6 env-skips** (old bar 297/291 + 38 new − 26 old); typecheck **CLEAN** (tsgo 7.0.2 @ pi 0.87.1 typings, `PI_TYPES_DIR=/workspace/pi-binary/0.87.1/node_modules`; CONTROL=1 falsified first — seeded TS2322 reported). The live dry-run proof (a real steer reaching the model, a `close_unit` answering it — covering BOTH classes + the 96k/105k silence case) remains OWED before any battery rep (D1 lesson).

**D8 LIGHT-AUDIT + D9 SETTLE-AT-VERDICT (decided 2026-10-02 by Paul, from the `sam-small-units-02` incident) + nudge dial DEFAULT ON:**

* **D8 (light audit — the band-zone third rung):** dial `SAM_AUDIT_DEPTH = auto | full | light` (default `auto`: zone `watch`/`action` ⇒ `light`, else `full`; pinned, pure core `closeaudit.ts`). `light` = ONE model turn, **zero tool calls**, delivery check only ("are the filenames/statements the close claims present?"), line-1 verdict `NOT-YET-VERIFIED: <note>` (new verdict class — a delivery check, not a verification: it verifies the model delivered what it reported, nothing more; non-open claims it reports ride `NOT-YET-VERIFIED` → "verify before acting"). The `full` contract stays VERIFIED / CORRECTIONS only (a `NOT-YET-VERIFIED` reply at full depth is a contract violation ⇒ hatch). Rationale (measured, run-02): the near-fold audit KV pressure — the 115,610-token ctx fold (21.4 tok/s derived, below the bank's 25–28.5) landed 30 min after a 2 m 46 s synchronous audit at ~64.5k ctx; Paul: the child is disposable, one turn, no tools, may borrow the R reserve (~16,384). NOT a fold-avoidance mechanism (synthesis, vetoable — decision record v4-plan §7).
* **D9 (settle at verdict — the core):** settlement + resolve terminal commit **at verdict time, inside the close pipeline** (`commitCloseAuditItem`, `pi.appendEntry` — the close-record crash-safe pattern; the close never leaves unsettled). The `agent_before_settle` drain (step 2.5) keeps as the **idempotent backstop** (strong ⇒ skip as in v4; weak ⇒ UPGRADE — the strong record appends, naming the weak one in `supersedes`; one settlement per unit — the v4 default — is byte-identical to the old path, F1). **Failure hatch:** EVERY audit failure (spawn/timeout/handoff/crash/span-unresolved/pipeline-crash) commits an `UNVERIFIED (audit-failed)` settlement — the stub + evidence files survive channel A verbatim (the close record is the source), the claims carry "verify before acting" (Paul: "the summary of the model is then to be treated as unverified and claims that have to be verified before being acted upon"). Weak settlements (light / audit-failed) are **upgrade targets**: `classifyReClose` re-audit path + `/sam reaudit` proceed (strong refuses), takeover is **latest-per-unit** (append-only journal; `supersedes` pointer). Nudge hard guard keys to **audit-in-flight / audit-fork ONLY** — `pendingCloses` no longer suppresses (the run-02 spec input: from 23:03:39 to the 23:39:51 fold the guard sat silent ~36 min with NO ledger entry and NO operator line at 88–90%; 9 eligible nudge decisions, including the run's three largest thinking blocks, are what its removal re-arms). A would-have-fired decision caught by a guard is now **recorded** (`sam-nudge` entry with `suppressed` + operator emit — F1). Supersedes (cited at the code site, house rule): the v3-era "s5 lesson" + the P2 same-settle rule.
* **D7 dial flip (Paul, 2026-10-02, verbatim: "nudge mode should be on by default"):** `SAM_NUDGE` **DEFAULT ON**; the only opt-out is explicit `SAM_NUDGE=off`. Inert on the v3 dials (the nudge activates only under the `close` audit-delivery dial — control arms untouched). Spawned audit children still get `SAM_NUDGE=off` forced (`childEnv`).
* **Reasoning-class live read (run-02, measured from `main-89.jsonl`):** 13 assistant messages with thinking ≥ 2 500 chars across the 32 assistant messages; the `reasoning` nudge fired exactly ONCE (22:52:29, 2 633 chars, 7 085 ctx = 5.4% of W, zone calm). The other 12: 3 inside the 5-min global cooldown; 1 (22:58:12, 7 141 chars) consumed by the same-message `gap`-class fire (gap precedes reasoning in the decision order — by design); **9 (23:09–23:49, including the run's three LARGEST blocks — 30 154, 18 422, 8 402 chars, all at 79–90% ctx) suppressed by the old settle-pending hard guard** — the D9 incident, now removed (these decisions are re-armed; at 23:09 and 23:31, in-band, they would have fired under the current rules). Open question for the operator (vetoable proposal, text is the operator's): whether to zone-scope the `reasoning` class — **A** (fires only in `watch`/`action`, consumes the stretch's gap flag, not cooldown-gated; calm stays silent — the one live fire at 5.4% is the noise it removes; run-02 would have nudged at 23:09 + 23:31, before the fold), **B** (calm checkpoint kept + in-band threshold halved 2500→1250 + not cooldown-gated), **C** (as-is). — **SUPERSEDED the same day (Paul, 2026-10-02; the A/B/C question is CLOSED — his spec below replaces it).**
* **D7-CORRECTION (decided + LANDED 2026-10-02, same day — Paul: "we will never use actual time passed for our triggers if the events they trigger are not time-related… time is not a good measure for llm work"):** the 5-minute cooldowns are DELETED from every trigger (the per-stretch flags remain — activity boundary, not time; `NudgeRuntime` now carries **no time fields at all — pinned**); the `reasoning` class gets its OWN rulers (**not total context, not zone, not time**): `toolCallsSinceReset ≥ 15` **AND** `thinkingSinceReset ≥ 5000` (dials `SAM_NUDGE_REASONING_CALLS` / `SAM_NUDGE_REASONING_CHARS`; thinking floor 5k per Paul 2026-10-02: "I suggest taking 5k, that grants 2 or 3 medium reasoning turns, or a big one" — the budget is INCREMENTAL: the settled ref run (main-242) shows 24 thinking blocks ≥ 2.5k chars, 14 ≥ 5k, max 13,589 chars; tool-call floor 15 — "tool count seems fine as a start" (Paul); grounded in run-02: stretches 22/20 calls, tool results = 70.5 % of message chars, reads 51.2 %) — "a reasoning nudge should happen after a significant amount of tool calls, especially after large tool calls and reasoning thereafter" (Paul). RESET points of the activity ladder: a successful `close_unit` (stretch reset), a `write`/`edit` tool call (Paul: "a writing tool call should probably reset the reasoning-counter" — extended to BOTH rulers — **confirmed by Paul 2026-10-02: "1 is the right choice and what I meant. only one would be ... strange."**), and ANY nudge offer (soft checkpoint: re-crossing the floors = more unmaterialized work — **confirmed by Paul 2026-10-02**; it is what serves Paul's goal, verbatim: "my goal is that long research and reasoning turns result in more frequent checkpoints, so that even the huge 'find any discrepancies' prompt has a chance of more than one close in one context sized window"). `close_unit`/`write`/`edit` are reset points, NOT counted; every other tool call (incl. failed) increments; each assistant thinking block adds to the budget. `gap` class: the cooldown gate is gone, the per-stretch flag stays. The `reasoning` text is the shortened form Paul set 2026-10-02 — the beginning + his question verbatim ("maybe we can already close some findings?") + the raw-reads note ("A close would let the raw tool reads drop out of compaction"); the earlier long version is RETRACTED. PROVISIONAL: "the prompt question is not completely resolved yet" (Paul); pinned in `test/nudge.test.ts`. **Local state (this tree, same day):** test/nudge.test.ts` pins **40/40** (incl. the NO-TIME shape pin, the AND-gate, the reset-point and the offer-re-arms pins); `test/d8d9-arms.test.ts` **6/6**; suite **317 tests / 311 pass / 0 fail / 6 env-skips**; typecheck **CLEAN** (tsgo 7.0.2 @ pi 0.87.1 typings); extension repo stays UNCOMMITTED per the standing rule; README + v4-plan D7 row updated to the correction.
* **Remaining before any battery rep (the 4 owed arms + gate) — LANDED + GATED 2026-10-02:** (1) **decisive** — close mid-turn ⇒ turn never settles ⇒ compaction mid-turn ⇒ `fromHook` takeover carrying the settlement line (the run-02 shape, no settle boundary in between); (2) light-audit arm — band-zone close ⇒ one-turn/zero-tool-call audit ⇒ `NOT-YET-VERIFIED` line ⇒ takeover carries it (+ the full-depth contract-violation ⇒ hatch sub-arm); (3) hatch arm — planted audit timeout ⇒ `UNVERIFIED (audit-failed)` settlement commits ⇒ takeover carries it (+ the weak→strong upgrade append with `supersedes`, latest-per-unit at takeover); (4) nudge-guard arm — post-verdict in-band nudge fires (guard = audit-in-flight only) + the suppression-logging pin. ALL GREEN in `test/d8d9-arms.test.ts` (**6/6**) on this tree; suite **317 tests / 311 pass / 0 fail / 6 env-skips**; typecheck **CLEAN** (tsgo 7.0.2 @ pi 0.87.1 typings) — and only then, per rep with the operator's GO in the manifest, any live run (F1; D6 battery numbering is the operator's call).

**D7 — mid-session nudge (code-prepared 2026-10-01 eve; dial `SAM_NUDGE`, then DEFAULT OFF — superseded by the DEFAULT ON above):**
measured motivation — TWO live close-dial runs both show the model working through the
whole collection/patch phase and closing at the END or not at all: the settled reference
run (first-draft wording; 11 fixes = one end-of-task close, 3 pi-base compactions inside
the measured loss window `b10975|b11058|…` / DS213j) and `sam-small-units` (S6 wording;
operator-stopped at 82% context, mid-collection, no self-close). Static prompt wording
does not change the work ordering. D7 automates the operator steer: a LIGHT, state-based
ask ("if the current checkable deliverable is done and checked, close it now with
close_unit — otherwise just continue") delivered just before the model's next LLM call
(measured pi 0.87.1: ONE `sendUserMessage(text, {deliverAs:"steer"})` covers both states
— mid-turn steer-queue delivery, or one short turn when idle; a user message, visible in
the session file). Triggers (pure core `src/nudge.ts`): (1) `context` — governor zone in
the pressure band (`watch`/`action` = ≥ W−2R, one full reserve below the native line
W−R), ≤1 per pressure episode, close re-arms, lazy episode start covers the resumed
session; (2) `reasoning` — thinking blocks ≥ `SAM_NUDGE_REASONING_CHARS` (default 2500;
measured bank distribution 51–5143 chars; `usage.reasoning` is 0 on kvllama, so content
chars are the ruler). Guards (each pinned): `close`-dial only (v3 dials stay the
byte-stable control arms), never mid-audit, never in an audit side-session, `childEnv`
forces `SAM_NUDGE=off` onto the spawned prepare/audit children (they inherit
`process.env` by construction). Provenance (F1): the text starts with `[sam-nudge]`
(distinct self-partition from nudge-assisted in the readout) + a `sam-nudge` custom
entry per nudge (not sent to the LLM) + an operator `emit()` note. **Text = PROVISIONAL;
operator wording is final — house rule: reword = rewrite the `test/nudge.test.ts` pins
(26/26 green).** Local state: suite **297 / 291 pass / 0 fail / 6 env-skips**; typecheck
CLEAN (tsgo 7.0.2, pi 0.87.1 typings, CONTROL=1). **S7 close-unit wording (Paul,
2026-10-01 eve — LANDED, as-drafted + 3 disclosed mechanical typo fixes ("stores"→"store",
"to"→"two", one dangling colon→period — all revertible by the wording owner)):**
`CLOSE_UNIT_TOOL_V4.description` now = a unit is (a) one checkable deliverable OR (b) a
**substantial finding or question after multiple tool calls + reasoning turns** (a
discovery, a user decision, a claim, a new finding needing verification) — making a
collection phase closable BY DEFINITION (the measured gap of both live runs); unverified
derived findings ride **"mark them as intermediate and open"** (the
assumed-interface-mismatch example, Paul's live case, is in the text); the stub survival
promise is stated ("key facts and datapoints of closed units will survive a compaction");
the "do not batch" clause is OUT of the description (kept in guideline 1). Pins: protocol
rewritten for S7 (S6 clauses still pinned + 7 new S7 clause pins + supersession pins);
suite 297/291/0/6 + typecheck CLEAN re-measured on this tree. **S7.1 (same day —
Paul's explicit delegation: fix minor grammar/semantic slips, the DIRECTION — the new
category for derived, open questions/assumptions/leads — is invariant; ALL CHANGES
DISCLOSED, VETOABLE):** the example lists now attach to THEIR category (either/or
skeleton kept; dangling lists → appositives); the third epistemic status is NAMED
(assumptions, leads, suspected conflicts) with a sharpened stub contract: "mark them as
intermediate and open, NEVER as settled — and name the claim, the basis you observed, and
what would verify it"; **the audit instruction carries the matching clause (a properly
marked claim is audited for the MARKING — clearly open, named basis, verify pointer — not
for whether the assumption holds; else CORRECTIONS misfires and trains the model NOT to
mark)**; guideline 2 gains the escape clause ("except for claims marked intermediate and
open: name the claim, the basis you observed, and what would verify it"); "Your stated"
off the survival promise (it is the system's promise); the example names what EXACTLY
seems to contradict (the checkable core of a lead); the nudge's `context` text aligns to
category (b) ("a checkable deliverable, or a substantial finding or question worth
keeping (mark assumptions and leads as open, with their basis) — unmarked context may be
lost at compaction"). Pins: protocol + nudge re-pinned (S7 clause pins refined/added,
4 audit-clause pins new, the guideline escape pinned); suite 297/291/0/6 + typecheck
CLEAN (tsgo 7.0.2 @ pi 0.87.1, CONTROL=1), both re-measured on this tree. **Owed before any battery rep (the D1
lesson — unit green ≠ process proof):** the live dry run of a real steer/turn delivery
and a `close_unit` answering it, gated per F1.

## Unreleased — P5 v3 branch-audit surface built (measured pivot 2026-10-01)

**Decisions absorbed (Paul, 2026-10-01 — O1–O4 resolved):** O1 `retrievalId` FIRST in the
settlement line; **O2 `steer` is a RETAINED toggle, default off — correction of the
2026-09-30 "deprecated (superseded by branch)" wording below: dial kept, `followUp`
stays the default, `branch` is the new opt-in**; O3 `sam_retrieve` + `/sam retrieve`
confirmed (tool + command + bounded resolver, pins in `test/`); O4 numbering — first
live run is the one-shot **E27**.

**The v3 pivot (measured, evidence banked `run-outputs/p2-walk-2026-10-01-walk-branch-audit-rehearsal{,2,3}` + design §13):** the v2 in-process flow (the `/sam audit` handler runs the model turn on the fork in-command) **does not work under pi print mode** — pi's one-shot loop does not pump command-initiated extension model turns (measured: instruction appended to the fork file, zero model calls). Consequence: the branch audit is **runner-orchestrated** — `/sam audit <n>` = prepare only (fork at leaf + JSON handoff on the operator channel, **model-free**); the runner prompts the fork session with the emitted instruction (one model turn on the fork); `/sam settle <n> <forkFile>` = stage + synchronous settle (settlement record + the unchanged close-time terminal; **model-free**, one short ack turn); `/sam retrieve <id>` / `sam_retrieve` (O3); the compaction **takeover** carries the settlement line (verbatim in the summary + `details.sam` map + tombstones banked). New measured pi-0.87.1 facts in design §13 (stale-ctx guard after `fork`/`switchSession` — `withSession` callbacks only; boundary entries commit only via an appended-message turn; `/compact` in print mode is a plain model prompt — compaction entry points are the auto-threshold or the RPC `compact` command; project settings are trust-gated in print mode — `compaction.keepRecentTokens` must be set in the global `~/.pi/agent/settings.json`; `prepareCompaction` refuses when nothing sits outside the keep-recent window; pi 0.87.1 persists the takeover flag as `fromHook`).

**Local state (all green, 2026-10-01):** typecheck CLEAN (tsgo 7.0.2, pi 0.87.1 typings, CONTROL=1 proven); suite **225 tests / 219 pass / 0 fail / 6 env-skips** (incl. the branch-audit pins — incl. the settlementLine omission pin + registration-surface pin: 2 tools / 4 listeners); walk **branch-audit 10/10** + **live-e-shape 12/12** (the rep-2/3 runner shapes pinned) + full walk regression **all arms green**; R3/R4 replays **PASS** (deterministic, 5 fresh replays each). Live arms A–D unchanged (banked 2026-09-30).

**Live v3 (2026-10-01, qwen38-gsq-rco-kv, window 49152, xhigh — banked dev-repo `run-outputs/`):** the P5 one-shot is done, with its v3 baseline: **rep-3 = first fully green live run, 18/18** (verdict VERIFIED, all five ground-truth values in the 960-char settlement line, both MARKERs, terminal B-shape, R3, `fromHook` takeover, checklist 5/5; `p5-live-ab-2026-10-01-armE-rep3-qwen38-gsq-rco-kv`) and **E27 = first battery rep, 17/18 banked-as-failed per the ruling** (verdict VERIFIED, checklist 5/5, wall 824s; the single FAIL = the vehicle-specific MARKERs-in-settlement-line assertion — the auditor correctly excluded post-close (unit-2-scope) MARKERs from unit-1 EVIDENCE per the instruction's "e.g." wording; the markers survived via pi's takeover summary (measured) — `p5-live-ab-2026-10-01-armE-rep27-qwen38-gsq-rco-kv`). Rehearsals rep-0/1/2 = three root-caused harness/extension bugs consumed + fixed + pinned (banks `p5-live-ab-2026-10-01-armE-rep{0,1,2}-*`: RPC UI-event capture; `findLastAuditTurn` first-assistant trap; pi 0.87.1 `ctx.fork` session rebind → same-file settle refuse — the live arm E is now per-stage-process shaped, walk v3k). **Paul's ruling (2026-10-01), recorded in P5 §12: v3 = baseline; audit-after-compaction loss is an assumed, now-tightened limitation; no protocol/assertion change; E27's FAIL = documented baseline variance, not a defect to chase.**

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

**Decisions absorbed (Paul, same night; design v2 — O2 of 2026-10-01 CORRECTED the
status of `steer`: it is a RETAINED toggle, default off, not deprecated):** at the
time, `steer` was planned to be superseded by `branch` (values become `followUp`
(default) + `branch`, exact-value fail-safe unchanged); the settlement record is
retrieval-tagged —
`<hash> VERIFIED: fact 1, fact 2, decision 3, disproved 4, explored-and-
discarded 5` — the digest is extracted from the audit reply (zero added
inference) and, via the `session_before_compact` channel, rides the compaction
entry (summary line kept + `details` tombstone map); SAM gains a **retrieval
tool** (`sam_retrieve` + `/sam retrieve <id>`) for the original content of
compacted/audited parts (session file keeps compacted raw entries — verified —
plus SAM's tombstone bank for file-rewritten shapes); conventions align with
pi-smart-compact's `smart_context` retrieval-ID pattern (prior art mirror
`ce34692`). Build remains pending Paul's final read (open items O1–O4 in the
design doc).

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

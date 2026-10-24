# Changelog

## v0.0.24: the branch audit's child session file is reduced (2026-10-24)

**The trigger (Paul, 2026-10-24):** option B for the WISHLIST
fork-child-session-size item — "the audit should happen outside the main
session … get audit in a clean process, don't pollute main sessions context
with the audit". The measured problem: pi's `createBranchedSession` copies
the **full root→leaf history** into every fork — 73 forks = 781.6 MB from one
21.35 MB 3-day session, 1.31 GB of fork files total on Barricade (the bloat is
disk-only: the audit model's context is compaction-aware, but the child file
still carries the whole append-only parent log).

**What changed:** the prepare child (step 4 of the close pipeline) now writes
the child session file itself — a **reduced** file: the pi-fork entry list
(labels filtered, parentId re-chained, the compaction's `firstKeptEntryId`
remapped through the label replacements) **truncated at the last compaction's
`firstKeptEntryId`** — exactly the compaction-aware active path, nothing
more. The model context is **proven identical**: the gate's pi-semantics
equivalence test runs pi's own `buildSessionContext` on both the full path
and the reduced entries and deep-compares the projected messages — green on
pi 0.87.1, 1.3.0 AND 1.4.0, so a future pi semantic change fails the gate
before ship. Scope rules (decisions D1–D8, dev repo
`notes/2026-10-24-reduced-fork-child.md`): the handoff JSON shape is
**unchanged** (`unitId`, `forkFile`, `forkSessionId`, `forkSessionStem`,
`instruction` — the audit child, validation and retrieval code are untouched);
**no compaction on the leaf path ⇒ pi's `ctx.fork` as before** (zero behaviour
change where there is no saving); **any failure of the reduced path ⇒
`ctx.fork` fallback** (F1: the close is never broken by the side branch); the
pure module `src/reducedfork.ts` ports the two small pi code sections it must
agree with (no runtime pi import — house style; the equivalence test carries
version stability). The child file's header copies `cwd`/`version` from the
main session's header, sets `parentSession` to the main file, and uses pi's
`<iso-no-colons>_<id>.jsonl` naming (a fresh `crypto.randomUUID()` id).

**Measured (live probe, dev repo `probe/reducedfork-probe.mjs`, pi 1.4.0 AND
0.87.1 — ALL PASS):** a compacted 63.2 KB / 71-line fixture ⇒ reduced child
12.5 KB / 16 lines (ratio 0.197), correct header (parentSession, cwd,
version 3, fresh id), linear re-chained body from a null parent, the
compaction kept, the pre-`firstKept` region dropped; the no-compaction fixture
⇒ the `ctx.fork` fallback with a full-path fork (one header swap);
`mock /state consumed: 0` — the prepare child remains model-free (zero
provider calls). New tests: `test/reducedfork.test.ts` (9 pure cases) +
`test/reducedfork-pi.test.ts` (5 equivalence cases × 3 pi versions).
Gate: **9/9 test combos + typecheck clean vs all three pi typings**.

**Rollout:** implemented on extension branch `sam-forked-audits` (main
untouched, per Paul's branching instruction — merge to main is his call);
this is v0.0.24 on that branch.

## v0.0.23: the number dials save with you — editor confirm = apply + persist, empty releases both (2026-10-23)

**The trigger (Paul, 2026-10-23):** "audit timeout (all 3), retire-offer
threshold, pressure headroom, orphan spans kept, nudge reasoning floor (both)
should set the permanent setting together with the session value. the
number-inputs have no way of ctrl+s and there would usually be no reason to
change any of these settings just for a single session."

**What changed:** the eight registry dials of kind `int` (the audit timeouts —
shared, medium, full — the retire-offer threshold, the pressure headroom, the
orphan spans kept, the two nudge reasoning floors) are edited in the TUI
settings menu through pi's editor, which has **no save key**. Their **confirm
now applies in-session AND persists to settings.json** (persist-first: on a
persist failure nothing is applied — the same discipline as every other persist
path), and **empty input releases both layers** (the session value and the
saved key — the same gesture as the value form's "clear"). The editor prompt
says so. Choice/on-off dials keep their split behaviour (confirm = in-session,
save key = apply + persist); the non-TUI value form is unchanged (it already
applied + persisted).

## v0.0.22: settings behave like pi's — plain-language dial notes, the bar tracks a depth switch at once, save = apply + persist (2026-10-23)

**The trigger (Paul, 2026-10-23 — after confirming the v0.0.21 bar/menu behaviour worked):**
(A) the `/sam settings` menu shows only the dial NAME for each row — it needs a
short plain-language description per setting ("not too long, not too much
jargon, just what each setting changes"); (B) switching the audit depth must be
instantly visible on the context bar (` audit: <depth>` suffix) — the bar only
refreshed at the close/retire/fold/goal/compact sites; (C) the save key in the
settings menu should not only save to settings.json but also APPLY the value
in-session — "pi settings behaves the same".

**What changed:**

- **A — every dial carries a one-line plain description.** A required
  `description` field in the registry (12 dials, each a short jargon-free
  phrase). The TUI settings menu renders it on the HIGHLIGHTED row (a note line
  under the rows, follows the cursor); the `/sam depth` selector and the per-
  dial selectors compose it into their title; the non-TUI single-dial form
  shows it under the value.
- **B — the bar's ` audit: <depth>` suffix tracks a depth switch at once.**
  The v0.0.21 statusLine-only apply was generalized to `applySamSettingsInTui`
  (dial on ⇒ install re-emits the bar, off ⇒ refresh clears it) and is now
  called after every settings change that can affect the bar: the `/sam depth`
  arg form, the `/sam depth` TUI selector (confirm and save), the `/sam
  settings <dial> <value>` form, and the per-dial editors (all three branches).
- **C — pi /settings parity: save = apply + persist.** Every persist path now
  also applies the value in-session (menu save key, per-dial editor save key,
  value form; "clear" releases both layers; a default value still clears the
  settings key). The `/sam depth` selector already applied via the ledger
  entry, so its persist path stays persist-only.
- **BONUS — the audit-depth display can no longer go stale.** The settings row,
  the selector's ✓, and the value the menu's save key persists now honour the
  in-session `/sam depth` LEDGER entry (`latestAuditDepth`, latest-wins; an
  "auto" entry = release) — the same precedence `decideCloseAuditDepth`
  applies at the decision sites. Before, after `/sam depth medium` the menu
  row and the selector still showed the settings-layer value, and the menu's
  Ctrl+S would have persisted that stale value.

## v0.0.21: the settings dials bind where they matter — in-session changes take effect, the status line reacts instantly (2026-10-23)

**The trigger (Paul, 2026-10-23 — two questions on the just-shipped v0.0.20):**
(1) "should context status line be instantly hidden when I set the setting to
'no'?" — as shipped, **no**: the statusLine dial was read only at session start,
so a mid-session off left the bar visible until the next session. (2) "is it
the context bar that show what is prompt, what is audited and whats still
open?" — **yes** (the bar's segments: █ prompt/summary, · closed/audited,
▒ remainder — where the still-open work sits, ░ pi's retention tail,
│ the compaction threshold, dim `audit: <depth>` suffix).

Answering (1) exposed a real gap in (and the fix lands in) the settings
feature:

- **The in-session layer now binds at the decision sites.** Rule 1 (in-session
  > env > settings.json > default) was implemented only in `dialStatus` — the
  menu/selector **display**. An in-session-only edit (confirm in the menu
  without the save key) showed the new value but changed nothing; all ten
  dial helper sites read `env ?? settings` and never consulted the in-session
  map. All sites now read through `samEffectiveRaw` (in-session first, then
  env, then settings.json — parse discipline unchanged: garbage still ⇒
  default).
- **The status-line dial takes effect immediately in the TUI.** Changing the
  `statusLine` dial via `/sam settings` (the menu's in-session confirm or the
  persisted value form) now shows/hides the live bar at once: `refresh()`
  re-checks the dial (off ⇒ clear the line + uninstall — a later on re-arms
  via install), and the settings command applies the dial right after the
  change. The other dials stay read-at-decision — only this one has a live
  surface to show/hide.

## v0.0.20: real settings — the 12 dials, stored in settings.json, configured via `/sam settings` (2026-10-23)

**The request (Paul, 2026-10-23 — top item of WISHLIST.md, now done):**
"add real settings (stored in settings.json) instead of env vars. make them
configurable either via /settings, or with /sam settings if thats less invasive."
pi's `/settings` menu is hardcoded in both pinned versions (no extension API for
menu entries — measured), so SAM has its own `/sam settings`.

**Decisions (Paul, 2026-10-23 — Q1–Q4 in the plan note):**

- **Q1 — the save gesture mirrors pi's configured key:** the menu's save key is
  `app.thinking.save` resolved through pi's own `KeybindingsManager` (the user's
  `keybindings.json`, default Ctrl+S) — the hint line shows whatever pi itself
  would show.
- **Q2 — the v1 dial list:** audit depth, calm depth, the four audit timeouts,
  retire chars, pressure headroom, orphan keep, nudge on/off + the two
  reasoning floors, status line on/off — 12 dials, exactly the existing env
  knobs (no new dials).
- **Q3 — global settings only** (`~/.pi/agent/settings.json`; the env
  `PI_CODING_AGENT_DIR` override is honoured; no per-project settings in v1).
- **Q4 — uniform clear-on-default:** persisting a dial to its default removes
  the key (and an emptied section removes the section).

**What changed:**

- **New module `src/settings.ts`** — the dial registry (key, env key, kind
  onoff/enum/int, the ms flag, the default, the section), the one-shot file
  read at session start (fail-open: absent ⇒ empty section, corrupt JSON ⇒
  defaults and the file is NEVER rewritten), the env-like layer every dial
  helper consults, the precedence **in-session > env (if set; garbage ⇒
  default) > settings > default** (the helper parse discipline is unchanged —
  a non-parsing env value still means default, and an env dial wins while set),
  `persistSamSetting` (pi's own `FileSettingsStorage` discipline: lockfile
  10×20 ms + atomic same-dir rename, other top-level settings keys preserved),
  `dialStatus` (value + source + the `shared` note when a per-depth timeout
  falls back to the shared dial), and the parse/format helpers (ms dials are
  stored as ms, displayed and entered in seconds).
- **All ten dial helper sites wired** — one line each
  (`env[KEY] ?? samSectionEnv()[KEY]`), parse discipline unchanged: closeaudit
  (depth, calm depth, shared + per-depth timeouts), nudge (on/off + the two
  reasoning floors via `envInt`), governor (pressure headroom), retire (retire
  chars), branchaudit (orphan keep), tui-status (status line on/off).
- **New `src/settings-ui.ts`** — the two TUI components, structured against pi's
  `Component`/`KeybindingsManager` interfaces (no pi-tui import — the 0.87.1
  capture does not ship that package): the settings menu (rows `label value
  [source]`; confirm = edit, the save key = persist the current value, cancel =
  close) and the enum selector (✓ on the current value, ↑/↓ + confirm, the save
  key = persist + select).
- **`/sam settings`** (every mode): no arg = the menu (TUI) or a static table
  (the settings file path + the source per dial); `/sam settings <dial>
  <value>` = persist one dial — the scriptable form (`clear` releases it).
- **`/sam depth` no-arg, TUI** = the depth selector (✓ on the effective depth —
  in-session > env > settings > default; confirm = the in-session ledger entry
  exactly as today, the save key = same + persist `auditDepth`); non-TUI keeps
  the status line.
- **`tui-completions`** — the `settings` subcommand + the 12 dial completions
  (mirrors the registry; the tests assert the sync).
- **Tests** — `test/settings.test.ts` (13: load/validate incl. the onoff
  presentation, precedence incl. env-garbage ⇒ default, persist + other keys
  preserved + no temp/lock residue, clear-on-default + section removal,
  corrupt-file refuse with the file byte-identical, the contents seam
  read-only, the `PI_CODING_AGENT_DIR` fallback, the helper wiring at all ten
  sites, the parse/format helpers, the completions sync).
- **Version pin note** — every surface used (`ctx.ui.custom`,
  `KeybindingsManager.matches`/`getKeys`, `keybindings.json`, `ctx.ui.editor`)
  was measured present in **both** 0.87.1 and 1.3.0, so v1 needed no version
  branch; the settings module is self-contained, so a future 1.3.0-only feature
  can gate on capability **inside** the module and simply not load while the
  other features ride 0.87.1 (e.g. pi's `getSettings()` accessor, measured new in
  1.3.0 — SAM reads the file itself, which works on both).

**Not changed:** the env dials keep their full meaning (an env dial wins for its
process while set), the ledger/audit/fold machinery, the context bar and its
surfaces, the close/audit/retire behaviours.

## v0.0.19: the SAM context bar moves below pi's native context bar (2026-10-23)

**The request (Paul, 2026-10-23 — top item of WISHLIST.md, now done):**
"move the SAM context bar below the pi native context bar, add 'Context ' in
front". The v0.0.16 bar sat between the input line and pi's footer (the
`belowEditor` widget — measured 0.87.1 dock order: pending → status →
widgetsAbove → editor → widgetsBelow → footer); the wish is for it to sit
below pi's own context line (the `CH…% / …k (auto)` stats line).

**What changed:**

- **New surface: `ctx.ui.setStatus("sam", line)`.** Measured against the
  0.87.1 mirror: the footer renders [pwd line, stats line (the native
  context bar), the extension-status line] — the extension-status line is
  the ONLY extension surface below the native context bar. pi re-renders on
  every `setStatus` (interactive-mode.ts:2203), `text = undefined` deletes
  the key, and `resetExtensionUI` (session switch) clears all extension
  statuses — the same lifecycle guarantees the widget had. The `setFooter`
  alternative was rejected: it replaces pi's built-in footer entirely and
  the stats line (usage totals, context percent) cannot be reconstructed
  from the footer data provider (no session access in the factory).
- **`src/tui-status.ts` rewritten around the status line.** The v0.0.16
  component (factory / `renderLine(width)` / `colorize(theme)` / captured
  tui) is gone; `SamTuiStatus` now builds `samTuiSegments` + the new pure
  renderer and calls `ctx.ui.setStatus(SAM_STATUS_KEY, line)` at install /
  refresh / bumpAnchor / the in-flight events / shutdown. The PUBLIC API is
  identical (`install` / `refresh` / `bumpAnchor` / `onDelta` /
  `onToolPartial` / `onToolEnd` / `shutdown`, the `SamTuiStatusDeps`
  closures, the `SAM_STATUS_LINE` dial), so `index.ts` needs no wiring
  change — comment annotations only. `SAM_WIDGET_KEY` → `SAM_STATUS_KEY`
  (same value `"sam"` — now a status key).
- **`src/statusbar.ts` gains the pure ANSI renderer**
  (`samTuiAnsiLine(prefix, bar)`): hand-rolled 256-color SGR — pi's exact
  256-mode emission format (`\x1b[38;5;Nm … \x1b[39m`, theme.ts:202-233)
  with the indices pi's own `rgbTo256` derives for the dark-theme palette
  (accent `#8abeb7` → 109, success `#b5bd68` → 143, warning `#ffff00` → 226,
  error `#cc6666` → 167, dim `#666666` → 241, mdHeading `#f0c674` → 222,
  text `#d4d4d4` → 188). Fills are NBSP (U+00A0): the footer's
  `sanitizeStatusText` collapses ASCII-space runs (which would squash the
  bar fills and drift the `|`), NBSP survives it and is width 1 in pi's
  width math (`get-east-asian-width` 1.6.0, measured). The `Context ` prefix
  is plain (no SGR) — it identifies SAM's share of the shared status line
  (other extensions' statuses sit on the same line, space-joined,
  key-sorted).
- **Tests:** `test/tui-status.test.ts` rewritten (the fake pi `ui` captures
  `setStatus` calls; exact ANSI line pins incl. NBSP fills; the old
  self-truncation pin is gone — truncation of the shared line is pi's
  footer's job, ANSI-aware `truncateToWidth`, measured); `test/statusbar.test.ts`
  gains the pure-renderer pins (SGR runs, prefix, NBSP, red/yellow split,
  glyph inventory). The `/sam` bar's pins move to the `Context [` prefix
  (Paul 2026-10-23: the on-demand bar was still `SAM [...]` — the bar shape
  is otherwise the v0.0.15 one, and the token-unknown note line keeps its
  `SAM (context tokens unknown)` form).

**Not changed:** the bar GEOMETRY (`samTuiSegments` untouched — 40 chars, the
min-1 rule, the outside/retention split, the overflow shrink order,
the `|`-replaces-its-position, the unknown state, the fix-up 2 in-flight
tail), the `/sam` on-demand bar's shape (only its bracketed prefix moves
`SAM [` → `Context [`), the dial (`SAM_STATUS_LINE` on|off,
default on, TUI-only), the refresh/invalidation sites (close / retire /
unretire / fold / goal / message_end anchor), the session_shutdown teardown.

**Open (for Paul):** the fixed 256-color palette has no light-theme
adaptation (the `setStatus` path exposes no theme object — the indices are
what pi's own 256 fallback would emit for the dark palette); on a very
narrow terminal pi truncates the JOINED status line (its behavior, first
from the right — the ` audit:` suffix drops first); RPC/print stays
no-op.

**Gates (2026-10-23):** full suite on `SAM_PI_DIR` 0.87.1 AND 1.3.0 ×
`SAM_NUDGE` unset/on/off (6 combos); typecheck CLEAN vs both typings sets
(tsgo 7.0.2, CONTROL=1).

## v0.0.18: filler-tolerant branch-audit reply parsing (2026-10-20)

**The request (Paul, 2026-10-20):** the 2026-10-19 narrative-first
audit-failure battery (dev doc
`2026-10-19-narrative-first-audit-failures.md`)
— on the 8-minute budget the 4B auditors sometimes narrate their check BEFORE
the contract verdict, and the strict line-1 parser then rejected replies that
DID contain the contract verdict intact ("I am the light auditor for u33…
NOT-YET-VERIFIED: files: 11/11 present; statements: delivered"). Direction:
"do NOT relax the instruction wording, but allow for a more lenient
interpretation… allow for filler-lines between the parts… still no contract
change in the description… double-verdicts are not good, we expect verdict
first, and details after, and each part of the contract as one-line as before".

**What changed:**

- **`parseBranchAuditReply` (src/branchaudit.ts) gains the filler rescue.**
  When line 1 is not a model verdict, the first LATER line that parses as one
  (VERIFIED / CORRECTIONS: / NOT-YET-VERIFIED: / PLAUSIBLE:) anchors the parse
  — first-wins ("verdict first, details after"); a second model-verdict line
  is bad filler (unexplained, never a re-anchor). Sections then assemble from
  the anchor with the UNCHANGED tolerant semantics (a known header opens a
  section; content spans to the next header/EOF; a filler line while a section
  is open joins that section; a filler line with no section open is just
  unexplained). A rescued reply settles `parsedClean = false` (the prose is
  unaccounted); a reply with no verdict line at all stays UNAUDITABLE exactly
  as before (the D9 hatch). The line-1 anchor path is byte-identical.
- **Tests (test/branchaudit.test.ts, 7 new):** the u33 shape (prose + NYV last
  line → NOT-YET-VERIFIED), the u1 shape (prose + "Verdict:" lead-in +
  VERIFIED + sections), Paul's filler-between-sections example (CORRECTIONS
  verdict + interleaved prose → CORRECTIONS, sections populated, valid),
  double-verdict first-wins, CORRECTIONS-with-preamble, no-verdict-stays-
  UNAUDITABLE (the u24/u101 battery shapes), and buildSettlementRecord over a
  rescued reply.

**Not changed:** the audit INSTRUCTION text (the line-1 contract stays pinned),
the deadline-nudge text, the depth-gate acceptance sets, `findLastAuditTurn`,
the settlement record/line shapes, any live behaviour. The depth gate and the
`reply-unparseable` defer are untouched — they now simply read the rescued
verdict class. The battery's examples 1 (u101), 3 (u71) and 5 (u24) REMAIN
legitimate audit failures: they contain no verdict line at all (auditor
identity failure / model switch mid-audit / missing tool) — the D9 hatch's
job. Examples 2 (u33) and 4 (u1) are now rescued.

**Gates (measured 2026-10-20):** 553/553 tests in all six combos
(`SAM_PI_DIR` 0.87.1 and 1.3.0 × `SAM_NUDGE` unset/on/off; 0 fail / 0 skipped),
typecheck CLEAN against both typings sets (CONTROL=1, tsgo 7.0.2).

## v0.0.17: pi 1.3.0 compatibility + read_goal version retrieval + longer CALLS args (2026-10-20)

**The request (Paul, 2026-10-20):** after the pi 1.3.0 compatibility research (the host pi
was upgraded to 1.3.0; the gates — capture, 542/542 tests ×3 SAM_NUDGE shapes, typecheck —
all passed), three changes landed: (1) "the model can not retrieve old goals at the moment
— if it adjusts the goal, and wants to double check against a previous goal, it can not —
implement a way to get the old goals by their id (read_goal <optional id> maybe?)"; (2)
"40+80 (if longer than 120), else full (if <= 120) sounds fair" — the orphan-zone CALLS
argument cap, raised because the measured head-60 cut "is cut off right at the decisive
part" of workspace-relative bash commands; (3) "update the readme to 'tested with 0.87.1
and 1.3.0'" + the version bump.

**What changed:**

- **`read_goal` gains an optional `id` (version number).** Version 1 = the first goal on
  the branch, latest = current — the same numbering `adjust_goal`'s ack already prints
  ("Goal stored (version N…)"), now also shown as `#N` in the no-id version list. `read_goal
  { id: 1 }` returns that earlier goal VERBATIM, labelled tombstone ("the current goal is
  version N") with the restore path (adjust_goal with its full text). Out-of-range and
  non-numeric ids are refused in-band with the valid range. A numeric string is accepted
  (the model copies the number it saw). The old version list kept its metadata (time + how
  + chars) and gains the `#N` id plus a one-line usage hint.
- **Orphan-zone CALLS argument cap (src/branchaudit.ts).** Was `ORPHAN_ARG_HEAD = 60`
  (head-only). Now: `≤ 120` chars stay whole; longer args keep head 40 + ` […] ` + tail 80
  (`ORPHAN_ARG_FULL_MAX` / `ORPHAN_ARG_HEAD` / `ORPHAN_ARG_TAIL`) — same seam style as the
  lastText cap. For a bash command the decisive parts are the prefix (cd / env) and the
  executed command, not the middle; the measured failure mode was
  `bash(cd /workspace/pi-agent/extensions/pi-self-aware-memory && SA…)` — the old 60 cut
  right after the `&&`.
- **pi 1.3.0 support declared.** README version pin now "built and tested against pi
  0.87.1 and pi 1.3.0" (Status → 0.0.17, Requirements → "0.87.1 or 1.3.0"). Basis: the
  0.87.1→1.3.0 extension-API diff (every SAM-used surface type-checks unchanged; the
  measured behaviour deltas are the 1.2.0 busy-window throw at run-start — SAM's two bare
  `sendUserMessage` sites are guarded and fail gracefully — and the
  `before_agent_start`-on-triggerTurn firing SAM does not subscribe) + live gates: the
  pi-binary 1.3.0 capture (pkg/core/cli all 1.3.0), 542/542 tests in all three
  `SAM_NUDGE` shapes against both runtimes (the 6 pi-semantics cross-checks ran, not
  skipped), typecheck clean vs both typings sets (tsgo 7.0.2). Report:
  `v0.87.1-to-1.3.0.md`.

**Not changed (assessed, left for a later step):** the two bare `pi.sendUserMessage(text)`
calls (the 1.2.0 busy-window race — guarded by `isIdle()`, caught, fold/undo stay pending;
a `{deliverAs:"followUp"}` pass is the cheap hardening, idle-identical), the
`waitForNestedTurn` docstring (still v0.87.1-dated), and the `peerDep "*"` (kept — both
versions supported). The pi 1.3.0 live smoke (fold/close/ack on the upgraded host) remains
user-driven.

## v0.0.16: SAM TUI status line — a live line below the input line in the TUI (2026-10-19)

**The request (Paul, 2026-10-19):** a clarification of the v0.0.15 status line — it was
meant as a **LIVE TUI element below the input line**, like pi's own status lines — not
`/sam` command output: "appended to an existing one, or as a new one". Two rulings:
(1) implement now, with the segment + color spec — full block █ light-blue/teal =
prompt/summary, light block ░ green = audited/closed, middle block ▒ remainder: grey =
within the retention window, yellow = outside retention, red = outside retention AND past
pi's compaction threshold (**red and yellow are mutually exclusive** — only yellow–grey or
red–grey, never red–yellow–grey), │ orange = the compaction threshold, [ ] white;
pi's own context-% colors were measured at >70% yellow / >90% red (the error/warning theme
colors). (2) tokens unknown ⇒ `O` (derived, known) + ` ??? ` in grey + the `|` still
placed: `[OOO ??? | ]`. Plan first, then implement — plan + decisions D1–D9 (with
alternatives) in
`2026-10-19-sam-tui-status-line.md`.

**What changed:**

- **The surface.** A dedicated NEW line via
  `ctx.ui.setWidget("sam", factory, {placement: "belowEditor"})` — measured in pi 0.87.1:
  the TUI mount order `document → pending → status → widgetsAbove → editor → widgetsBelow
  → footer` puts the widget between the input line and pi's footer lines. `setStatus`
  (append to the existing line) was rejected — it shares the line with other extensions'
  statuses and their sanitize/truncate interplay; `setFooter` (replace-all) rejected as
  fragile. TUI mode only — a no-op in RPC/print (measured: component factories are ignored
  there).
- **Segments + colors (D2).** Semantic theme colors (pi 0.87.1's measured dark.json
  palette has no raw blue/orange): █ prompt/summary = `accent` (teal), ░ closed/audited =
  `success` (green), ▒ remainder = `dim` (grey) while inside pi's `keepRecent` retention
  tail, `error` (red) outside retention, │ threshold `W−R` = `mdHeading` (the closest
  palette orange), [ ] brackets + the ` audit: <depth>` suffix = `text`/`dim`. Per
  Paul's ruling 2, once tokens cross `W−R` the remainder run crosses the `|` — red before
  it, grey after (red and yellow never coexist).
- **The geometry.** New pure `samTuiSegments` in `src/statusbar.ts` (the v0.0.15 `/sam`
  bar is unchanged and shares the module): O/audited measured, the remainder derived;
  the remainder splits at the `W−R` crossing into outside-retention and retention (the
  last `min(keepRecent, tokens)`), with a min-1 split (a 1-char budget goes to outside);
  overflow shrinks outside → retention → audited → prompt; the `|` REPLACES the char at
  `round((W−R)×40/W)`; unknown tokens (null — right after start or ANY fold) ⇒ O +
  ` ??? ` + the `|` still placed `[OOO ??? | ]` (ruling 3), while `/sam` keeps the
  v0.0.15 note line.
- **Live at render (D3).** No timer — measured: pi re-renders on every `setWidget` and
  the widget renders on every `requestRender`; SAM refreshes the bar exactly where it
  changes: `close_unit` / `retire_units` / `unretire` (finally — every return path),
  `adjust_goal`, `session_compact` (every fold path), and install at `session_start`.
- **Dial + teardown (D5/D8).** `SAM_STATUS_LINE` on|off, default on. Explicit
  `setWidget("sam", undefined)` on a NEW `session_shutdown` handler — belt and braces on
  pi's `resetExtensionUI` (widgets are cleared on every session switch, measured).
- **Fail-open everywhere.** install/refresh/shutdown swallow their own errors: a status
  line must never break session start, close, or retire (caught in tests: a throwing
  install reset the session state through the `session_start` catch).

**Tests + gate:** 21 new pins — `test/statusbar.test.ts` (+9: known / crossed /
retention-only / unknown / unknown-without-window / overflow-shrink / min-1 split /
1-char-outside-wins / empty-known), new `test/tui-status.test.ts` (12: the dial, install
gates incl. RPC + dial-off, the D2 color map, the crossed red/grey split, the unknown
line, truncation ×2, refresh+dispose, shutdown ×2 — a fake theme renders `⟨color⟩`
marks), and the `test/extension.test.ts` registration pin updated (the listeners now
include `session_shutdown`). Suite: **524 tests / 518 pass / 0 fail / 6 pre-existing
skipped, identical in all three SAM_NUDGE shapes** (unset/on/off) via
`node --test test/*.test.ts`; typecheck CLEAN against pi 0.87.1 typings (TS 7.0.2,
`PI_EXPECT '^0.87.'`, control-seed discipline).

**Fix-up (2026-10-19, post live observation, ruling 4):** the audited glyph `░` →
`·` (middle dot). The live line showed `░` (25% shade in the muted yellow-green
`#b5bd68`) optically confusable with `▒` (50% shade in grey) — a compound effect
of close dot-matrix densities plus close perceived color weight; the centered dot
is clearly distinguishable (Paul's pick from the offered `▁` / `▂` / `·`). One glyph
constant (`TUI_GLYPH.audited` in `statusbar.ts`) + nine test pin lines across eight
tests (6 lines in `statusbar.test.ts`, 3 in `tui-status.test.ts` — per the u91
audit correction) + the plan doc; same version string 0.0.16.

## v0.0.15: SAM status line — /sam status gains a context bar visualizing the system prompt against audited and unaudited context (2026-10-19)

**The request (Paul, 2026-10-19):** a status line of the shape
`SAM [OOO....xxxx  | ] audit: <current depth>  <prefill|gen>: <tps 12.3> tps` —
`O` = prompt+summary, `.` = context already closed/audited, `x` = context not yet
closed (unaudited), empty = empty context, `|` = pi's compaction threshold; bar
length the extension's choice, estimates fine; the tps part **only if available from
within pi** (no probing). Plan first, then implement — plan + decisions D1–D10 (with
alternatives) in `2026-10-19-sam-status-line.md`.

**What changed:**

- **The bar.** New pure module `src/statusbar.ts`: a 40-character bar (D2) rendered
  directly after the `context:` line in `/sam status` — `SAM [OOO....xxxx | ] audit: <depth>`.
  `O` = the measured system prompt (`ctx.getSystemPrompt()`, chars/4 — measured, not
  estimated) + the rendered stored-goal block; `.` = the rendered settlement stack
  (`retireCensus` semantics — live blocks, superseded one-liners, supersedes metadata —
  NOT raw record counts, the v0.0.13 census fix); `x` = the derived remainder
  (`max(0, tokens − O − .)`: raw conversation, retention tail, nudges, in-flight work).
  Nonzero segments get `max(1, round(tokens × 40 / window))` chars; when the segments
  exceed the bar, `x` shrinks first, then `.`, then `O` (measured segments keep their
  visible footprint, `x` absorbs overflow).
- **The `|`.** Placed at `round((window − reserve) × 40 / window)` — pi's compaction
  threshold — and it *replaces* the char at that position: a context past the line
  shows the `|` inside the fill, not floating behind it.
- **Honest fallbacks.** Tokens unknown (null — right after start or ANY fold) or no
  window/reserve ⇒ no bar (a bar without `x` would read as an empty context); instead
  the note line `SAM (context tokens unknown) audit: <depth>`.
- **The audit depth.** `audit: <depth>` is the level the currently-active configuration
  would pick right now (`decideCloseAuditDepth(ctx, "")` — zone base + calm setting +
  `/sam depth` command; the same derivation the v0.0.14 nudge level line uses).
- **The tps section is omitted by design (D1).** Measured: pi 0.87.1 exposes no
  tps/throughput/duration anywhere in the extension surface — `ContextUsage` is
  `{tokens, contextWindow, percent}`, turn/message events carry token usage only, and
  the only `throughput` symbol is model-config's `preferred_min_throughput` (a
  provider-selection preference, not a live measurement). Paul wanted it only if
  pi-internal; self-measured turn tps is exactly the excluded probing, and would be
  misleading anyway (turn wall time mixes tool execution and inference latency).

**Tests:** 10 new pins — `test/statusbar.test.ts` (new: exact bar strings, min-1
  sub-scale, empty context, overflow shrink order x→`.`→O, `|` replacement, note-line
  fallbacks ×4), `test/output.test.ts` (+2: bar line placement + note line),
`test/extension.test.ts` (+1 glue: `/sam` no-args end-to-end with the measured
  system prompt and usage). Gate: 503/503/0 in all three SAM_NUDGE shapes (493
  baseline + 10), typecheck CLEAN against pi typings 0.87.1 (TS 7.0.2, CONTROL seed
  proven).

## v0.0.14: audit-time + auto-depth + overrides — the medium audit learns its budget and stops early, the calm zone becomes a setting, medium/full get separate budgets, the close_unit depth arg becomes a full override, and failed audits bank up to 4 KB of child diagnostic detail (2026-10-18)

**The problem (measured 2026-10-18 from this session's own audit forks):** the medium
and full audits shared one 8-minute budget, and the medium instruction gave the child
no time awareness and no stopping rule. In the live forks, the 480 s SIGKILL landed at
the moment of maximum audit value — the full fork was killed exactly as it found a real
correction (the unit's "19 connections" count error — the file has 20 paths), and the
medium fork was killed right after completing its verification. Per-turn inference
latency on the inference server (28 s…~3 min per turn) is the bottleneck, so the fix is
about budget discipline, not depth.

**What changed** (Paul's 2026-10-18 six requests + the diagnostic ruling):

- **Stop-early medium prompt.** `mediumAuditInstruction` now takes the effective budget
  (ms) and tells the child: it has a wall-clock budget of about N minutes and each
  reasoning turn can take a minute or more, so it should put all planned checks into a
  single parallel tool-call batch (at most two batches total), and once its checks suffice
  for a contradiction judgment, deliver the verdict — do not chase completeness. PLAUSIBLE
  is re-framed as *a complete answer, not a failure*: name any possible conflict observed
  and let the main session double-check it (the main session re-verifies flagged conflicts
  — the audit does not have to). Legacy/payload-less calls (no budget) are unchanged.
- **Calm-zone setting.** New dial `SAM_AUDIT_CALM_DEPTH` (`medium` | `full`, default
  `medium`, anything else ⇒ `medium`) sets the auto audit level *below* the pressure band;
  the band rung itself stays light (watch/action unaffected). `/sam status` names the
  effective calm-zone level and the dial behind it.
- **Per-depth budgets.** New dials `SAM_AUDIT_TIMEOUT_MEDIUM_MS` and
  `SAM_AUDIT_TIMEOUT_FULL_MS`, each falling back to the shared `SAM_AUDIT_TIMEOUT_MS`
  (480 s default, 8 min hard cap `SAM_AUDIT_TIMEOUT_MAX_MS`); light keeps the shared
  budget. The pipeline kills on the effective budget, and — new — stamps that effective
  budget into the audit child's env as `SAM_AUDIT_TIMEOUT_MS`, so the child's v0.0.11
  deadline-nudge timer fires at exactly half of the budget that will kill it. The
  timeout message names the effective budget.
- **Visual hint for explicit overrides.** When the model set an explicit `depth` on
  `close_unit`, every close result line gains ` (depth override: <depth>)` right after the
  unit number — the model can see which override it applied.
- **Full override.** The `close_unit` `depth` argument is no longer upgrade-only: any of
  `light` | `medium` | `full` is accepted (unknown values are ignored), and it is allowed
  even when a `/sam depth` session setting exists. Precedence: zone-base (+ calm setting)
  ⇒ `/sam depth` command ⇒ tool-override ⇒ retire-carry marker (the retire-carry marker
  still wins — it is the ledger's fact, not the model's preference). `depthSource` becomes
  `tool-override` (the ledger union keeps the historical `tool-upgrade` for old records).
  The tool description now frames the override as **rare** — normally omit it; pass depth
  only when the configured audit would be a waste of budget (e.g. a simple
  committed-and-reported close) or to re-audit a failed close at a cheaper rung. Retry
  affordances: a medium NYV now offers the full upgrade *and* a light downgrade; a full
  NYV offers any rung; an UNVERIFIED (audit-failed) close can be re-closed at any rung
  including light (settle cheaply); PLAUSIBLE still offers the full upgrade.
- **Nudge level line.** The close nudges (band/gap/reasoning variants) now state the level
  the currently-active configuration would pick: "If you do not explicitly require any
  other depth, a `<depth>` audit will be called." The value is the decision that would be
  made right now (zone + dials + `/sam depth` command, no tool arg); with no active level
  fact the nudge texts are byte-identical to pre-v0.0.14 (pinned).
- **D9 diagnostic detail (Paul: "bank the error in more detail in the future. cap it at
  4kb though, so it does not explode for whatever reason").** The audit-failed
  settlement's REASON now carries the child's actual output — labelled (`stdout: …` /
  `stderr: …`), whitespace-normalized, capped at **4096 chars total with the tail kept**
  (`AUDIT_DIAGNOSTIC_CAP_CHARS`) — on the four child-failure reasons:
  `prepare-exit-failed`, `handoff-missing`, `audit-exit-failed`, and `audit-timeout`
  (whose detail carries the child's truncated final turn — exactly the diagnostic the
  v0.0.13-era forks were missing: the u64 fork was killed mid-correction with no
  trace of it in the settlement line). The detail rides the settlement record (⇒
  post-compaction summary) and the model-facing close line; both streams empty ⇒
  `(child output: no output)`.

**Gate (measured 2026-10-18):** suite **493/493/0/0** in all three `SAM_NUDGE` shapes
(unset/on/off, `SAM_PI_DIR` set) — the 483 v0.0.13 baseline + 10 new pins (pure:
calm-setting parse, auto-depth under the band, per-depth budgets incl. fallbacks and
cap, the override hint rendering, the budget sentence in the medium instruction, the
nudge level line ×3 variants, `childDiagnosticDetail` labelling/normalisation/cap;
glue: tool-override precedence up-and-down + marker-still-wins, and the diagnostic
detail on the four failure lines) + pin updates on the result-line retry texts and the
tool description pins. Typecheck **CLEAN** against pi 0.87.1 typings (TS 7.0.2 native;
CONTROL seeded before the clean run).

**Open (Paul):** the earlier deadline nudge (~120 s instead of 240 s) was discussed but
**not** approved — not implemented.

## v0.0.13: retire-census + safenet parity fix — the retirement machinery counts what the summary actually renders (2026-10-18)

**The bug (measured 2026-10-18, this session's own fold):** after a model
fold, the settlement stack actually rendered 3 live units + 3 orphans
(~9.5k chars), yet the retirement offer claimed **30 records / ~115k chars**
and named as "largest" units that had already been retired 12 hours earlier.
The takeover render (branchaudit's middle-stack loop) had been correct all
along — but the two decision sites that feed on the stack ignored the
retirement ledger:

- **`retireCensus`** (src/retire.ts) counted every latest settlement record
  regardless of retirement: dropped units still in `records` / `chars` /
  `largest`, superseded units at full block size instead of their one-line
  forward link, and the superseding unit's `supersedes:` metadata line
  missing from its size. The offer then fired on characters that would
  never be pushed.
- **`autoRetireSelect`** (src/retire.ts) seeded its `retiredIds` set EMPTY,
  so `remaining` — the numerator of the "stop once under target" condition
  — included the already-retired units' characters. The stop could be
  reached late or never, and the loop over-retired every candidate instead
  of stopping under the target.

**The fix** — both sites now mirror the takeover render (same semantics,
call-site-only coupling; no new dial, no new state):

- `retireCensus` takes the ledger and renders each record the way the next
  summary will: dropped ⇒ not counted; superseded ⇒ the one-line forward
  link; live ⇒ the full block **+** the `supersedes:` metadata when the unit
  superseded old units. `records` now means "rendered records". The render
  callback gains the optional superseded-ids argument (`(r, sup?) =>
  string`); the call site passes `settlementBlock(r, sup)`.
- `autoRetireSelect` seeds `retiredIds` from `retiredStates(entries)`, so
  `remaining` starts at the actually-rendered stack size.

**New pins** (test/retire.test.ts, +2 tests → 483 total):

- the census counts exactly the rendered stack — dropped gone, superseded at
  pointer-line length, `supersedes` metadata on the live block, byte-exact
  `chars` assertion against `retiredSupersededLine` + `settlementBlock`;
- the select excludes pre-existing retirements from `remaining` —
  discriminator pin: 25k target over a 40k rendered stack with 20k
  pre-dropped ⇒ `[3, 4]` (the pre-fix empty seed would have returned
  `[3, 4, 5]`), plus the under-target-from-the-start minimum-two-picks
  shape.

**Gate:** 483/483/0/0 in all three SAM_NUDGE shapes (unset/on/off);
typecheck CLEAN (TS 7.0.2 native, pi 0.87.1 typings, CONTROL=1 seeded).

## v0.0.12: native-fold auto-ack — pi's own compactions now inform the model (Paul 2026-10-18, option 1)

pi's native threshold/overflow compactions were acked with `deliverAs:
"nextTurn"` — the sam-fold-ack was only injected when the user next posted,
so in the common case the model resumed after a native fold **not knowing a
fold had happened** (measured, pi 0.87.1: `nextTurn` messages sit in
`_pendingNextTurnMessages` and are injected only at user submission,
agent-session.js:1302).

**The change** (one branch of the `session_compact` listener, plus the
failure listener):

- **Native folds** (`reason "threshold" | "overflow"`) are now acked with
  `triggerTurn`. Measured, pi 0.87.1: while the run is active (the common
  mid-run catch, agent-session.js:1135) `triggerTurn` degrades to a steer —
  and `agent.steer()` is synchronous (agent-session.js:1494), so pi's own
  `hasQueuedMessages()` continuation (agent-session.js:2245) fires a new LLM
  call that **starts** with the sam-fold-ack: the model learns of the fold
  without a user post. Not streaming (the rare pre-send catch of an aborted
  over-threshold run, agent-session.js:1278) ⇒ one short ack turn before the
  just-posted message — the accepted cost (option 1: no A/B state tracking,
  since no streaming state is exposed to extensions).
- **Native fold failures** are auto-acked too (`triggerTurn`): mid-run the
  steer rides the same continuation, so the model learns the fold **failed**
  and the context did **not** shrink.
- **The user's `/compact`** (reason `"manual"`, no in-flight flag) keeps
  `deliverAs: "nextTurn"` (Paul's ruling): the agent was interrupted / is
  waiting for input; auto-submitting would start inference without giving the
  user a chance to type — the message simply appears after the next user
  input.
- Model-initiated `fold_now` (deferred → tool `onComplete` → `triggerTurn`)
  unchanged.

**Gate:** suite 481/481/0/0 in all three `SAM_NUDGE` shapes (unset/on/off);
typecheck CLEAN (TS 7.0.2, pi 0.87.1 typings, control-seeded).

## v0.0.11: the full audit's NOT-YET-VERIFIED + the audit-child deadline nudge (Paul 2026-10-17, implemented 2026-10-18)

Two follow-ups to the medium tier — the open point left by the v0.0.10 entry
(resolved by Paul) plus one new mechanism (Paul's idea, feasibility verified
against the pi 0.87.1 source). Design note in the dev repo:
`2026-10-18-full-nyv-and-deadline-nudge.md`.

- **Full's `NOT-YET-VERIFIED` (the v0.0.10 open point, resolved: acceptable escape).**
  A completed full audit that could verify nothing at all now settles honestly
  `NOT-YET-VERIFIED: <short reason>` — the weakest rung, re-auditable — instead
  of being a contract violation ⇒ UNAUDITABLE ⇒ the D9 hatch. The D9 hatch is
  reserved for audit-PROCESS failures (timeout, missing, truncated or
  unparseable reply). The line-1 acceptance matrix is now:
  - light = `NOT-YET-VERIFIED` / `VERIFIED` / `CORRECTIONS` (unchanged);
  - medium = `VERIFIED` / `PLAUSIBLE` / `CORRECTIONS` / `NOT-YET-VERIFIED` (unchanged);
  - full = `VERIFIED` / `PLAUSIBLE` / `CORRECTIONS` / `NOT-YET-VERIFIED` (gains the escape).

  The full audit's instruction carries the same one-sentence escape as the
  medium tier ("If you could not check anything at all, reply NOT-YET-VERIFIED:
  <short reason>."). The NYV one-liner is now DEPTH-AWARE in its retry
  affordance: light offers both upgrades, medium the full upgrade, full a plain
  re-audit (its depth is the ceiling — R7's upgrade-only lever has nothing above
  it). `ARM-2b` inverted accordingly (full-depth NYV settles NOT-YET-VERIFIED,
  not the hatch).

- **The audit-child deadline nudge.** The parent stamps the SPAWN time
  (`SAM_AUDIT_STARTED_AT_MS`) into the audit child's env (the prepare child
  never gets it — it must never receive a nudge); the child-side SAM arms ONE
  one-shot timer at 50 % of the shared budget (4 min at the default 8 min — it
  scales with `SAM_AUDIT_TIMEOUT_MS`, still one dial, R4) and steers the pinned
  verdict reminder in (`deliverAs: "steer"`). Measured pi 0.87.1: the print-run
  loop continues with a further turn whenever a message is queued, so the nudge
  reaches the model mid-audit. `findLastAuditTurn` treats the
  `[sam-audit-deadline]` user message as TRANSPARENT (the reply of record is the
  last non-empty assistant turn after the LAST nudge — the nudge's re-emit
  clause keeps a late nudge's answer a clean verdict block). Deliberately
  UNGATED by `SAM_NUDGE`: D7 keeps the pressure/goal nudges off in the child;
  the deadline reminder is the audit's own deadline — a separate mechanism, no
  new dial (the operator-dial count stays at 11). Total best-effort: the
  runner's SIGKILL timeout remains the backstop.

**Gate (measured 2026-10-18):** typecheck clean (TS 7.0.2 vs pi 0.87.1,
src+extensions); suite **481 pass / 0 fail / 0 skipped** in all three
`SAM_NUDGE` shapes (unset/on/off, `SAM_PI_DIR` set — the 475-test v0.0.10
baseline + 6 new pins: 3 `findLastAuditTurn` transparency + 3 arming behaviour,
pins in `test/branchaudit.test.ts` and `test/audit-deadline.test.ts`).

## v0.0.10: the medium audit tier — a depth between light and full for the routine close, the `PLAUSIBLE` verdict, and the `close_unit` `depth` upgrade lever (Paul 2026-10-17)

**Ruling (Paul, 2026-10-17, after wave A shipped as v0.0.9):** a new audit depth between `light` and `full`. Seven rulings (R1–R7; design note in the dev repo, `2026-10-17-medium-audit-tier.md`):

- **R1 — `PLAUSIBLE` is its own verdict, not a cheaper `VERIFIED`**: "not the same as verified, but holds up after a quick check." The medium audit's aim is **contradiction detection**, not a cheaper verified — an obvious contradiction observed directly still gets `CORRECTIONS`.
- **R2 — depth does not change the nature of a verification**: a full audit MAY ALSO produce `PLAUSIBLE` (the verdict describes what was established; the depth sets the budget and the expectations).
- **R3 — cheaply-groundable claims ARE verified even in a medium audit** (file size X, line Y, a grep value); long-run / interpretive claims need the full audit's thorough check ⇒ at best `PLAUSIBLE` elsewhere.
- **R4 — one timeout dial for all depths** (`SAM_AUDIT_TIMEOUT_MS` unchanged; no separate medium dial — the operator-dial count stays at 11).
- **R5 — no hard tool-call cap**: the medium budget is qualitative (tool calls only to confirm/refute named claims; no redo of the unit's work).
- **R6 — auto mapping (inverts the old full default)**: auto = light at/above the watch line W−2R, **MEDIUM below (the routine close), full explicit-only**. The fail-safe direction is never a silent LIGHT; an unreadable ruler / unavailable tokens (zone `calm`) lands on the below-band default medium — auto never dispatches full.
- **R7 — the `close_unit` `depth` argument is an upgrade-only lever** (`depth: "medium"|"full"`; applied only when strictly stronger than the decided depth, `depthSource: "tool-upgrade"`).

- **Mechanics — the MEDIUM audit:** bounded tool budget — read a file the stub names, grep for a value, a bounded check (well under a minute), **only to confirm or refute a specific named claim**; **no redo of the unit's work** (no re-running tests, builds, sweeps or research); a tool output recorded in the unit's entries is the **evidence of record**; batching small checks is fine. The unit verdict is the weakest rung across the stub's claims: `VERIFIED` iff every claim is cheaply confirmed or recorded evidence; `PLAUSIBLE` iff ≥ 1 claim stands at best plausible; `CORRECTIONS` on any observed contradiction; `NOT-YET-VERIFIED` as the total-failure escape.
- **Sections:** the same 5-section block as full (FACTS / DECISIONS / DISPROVED / EXPLORED-DISCARDED / EVIDENCE), with per-fact markers — plain line = verified, `plausible: <fact>` (new), `unverified: <fact>` (existing per-fact escape, does not downgrade the verdict line).
- **Line-1 acceptance matrix (depth-bound, pinned):** light = `NOT-YET-VERIFIED` / `VERIFIED` / `CORRECTIONS` (unchanged — the zero-tool delivery check makes no contradiction judgment, no PLAUSIBLE); medium = `PLAUSIBLE` / `VERIFIED` / `CORRECTIONS` / `NOT-YET-VERIFIED`; full = `VERIFIED` / `PLAUSIBLE` / `CORRECTIONS` (changed: a thorough audit with unresolvable claims now honestly replies PLAUSIBLE instead of VERIFIED with hidden unverified markers). Full's `NOT-YET-VERIFIED` stays a contract violation ⇒ UNAUDITABLE ⇒ the D9 hatch (open point: is a total-failure NYV from a full audit a violation or an acceptable escape?).
- **Depth precedence (single derivation, `decideCloseAuditDepth`):** zone auto (R6) < env dial `SAM_AUDIT_DEPTH` (`auto|full|medium|light`) < the `close_unit` `depth` argument (upgrade-only) < the `/sam depth` command < the retire-carry marker (light). The decision (zone + exact tokens + depth + source) is still derived once per close and recorded on the close record (decision-in-ledger, 2026-10-03).
- **Surface:** `close_unit` gains the optional `depth` parameter; the `/sam depth` command now takes `auto|full|medium|light` (TUI completions updated); the `close_unit` result text's upgrade wording names the depth (`depth: 'medium' (quick check) or 'full' (thorough)` for NOT-YET-VERIFIED; `depth: 'full'` for audit-failed and PLAUSIBLE). The re-audit guard: a settled STRONG unit is final; WEAK and MEDIUM are upgrade targets (the message names PLAUSIBLE).
- **Plumbing:** `src/verdict.ts` (`VerdictClass` + `PLAUSIBLE`), `src/ledger.ts` (`SamAuditDepth` + medium; `DEPTH_VALUES = auto|full|medium|light`), `src/closeaudit.ts` (the 3-rung `SettlementStrength`: NYV/UNAUDITABLE = 1 < PLAUSIBLE = 2 = MEDIUM < VERIFIED/CORRECTIONS = 3 = STRONG; `settlementRung` / `strengthRung` / `canSupersede` — settlement strength is monotonic, no downgrades, no re-sets; `classifyReClose`), `src/protocol.ts` (the PLAUSIBLE paragraph in the base instruction; the shared section block gains the `plausible:` marker; **new `mediumAuditInstruction`**; `branchAuditInstruction` line-1 contract now includes PLAUSIBLE), `extensions/self-aware-memory/index.ts` (3-way instruction selection + 3-way acceptance set + per-depth contract string in the reply-unparseable hatch; PLAUSIBLE staged-item passthrough), `src/tui-completions.ts`.
- **Version:** 0.0.9 → 0.0.10 (package.json + identity.ts + README Status — the README Status line was still at 0.0.8-dev; wave A's entry claimed it updated, this entry corrects the drift; the identity-vs-package.json pin in the suite carries it).
- **Gate (measured 2026-10-17):** full suite **475 tests / 475 pass / 0 fail / 0 skipped in ALL THREE `SAM_NUDGE` shapes** (unset / on / off), run with `SAM_PI_DIR=/workspace/pi-binary/0.87.1/node_modules` per `test/pi-semantics.test.ts`'s header (without it the 6 pi-semantics cross-checks self-skip — the 475/469/0/6 shape, not a regression); baseline 469 (v0.0.9) + 6 new medium-tier pins (closeaudit ×3, verdict ×1, branchaudit ×2); **typecheck CLEAN** vs pi 0.87.1 typings (TS 7.0.2, CONTROL seeded).
- **Open for Paul:** full's `NOT-YET-VERIFIED` (violation or acceptable escape — minor); carried from wave A: the fate of `/sam reaudit`, the command→internal-method refactor extent, wave B's stale CHANGELOG "Unreleased" headers.

## Unreleased — v0.0.9: legacy-code-eviction wave A — the audit delivery collapses to the synchronous close, the user-facing branch surface goes, the probe is extracted (Paul 2026-10-17)

**Ruling (Paul, 2026-10-17, wave A GO from the 9-candidate legacy-code-eviction analysis, dev repo):** remove the `followUp` and `steer` audit-delivery arms (candidates 1+2), the user-facing branch surface (candidate 3), and the provider-busyness probe (candidate 5, revised ruling: **extract** the probe base code to the dev repo for later reuse, **remove** it from the extension), rewrite the delivery-branching test scaffolding to build the close-mode state directly (candidate 8), and collapse the dials (candidate 9, partial). The shared close-pipeline substrate stays (the model-facing audit path still rides the close's synchronous side session):

- **Removed — `followUp` + `steer` delivery arms (`index.ts`, `state.ts`, `src/governor.ts`):** the `auditDelivery` governor field + its `SAM_AUDIT_DELIVERY` env read, the `state.audit`/`auditInFlight` followUp bookkeeping, the `steeredAudits` map, the settle-loop followUp/steer branches, and the `steerBranchInto` test helper. The close's audit is now delivered **one way**: synchronously inside `close_unit` on a dedicated side session (the `close` behaviour that was the default since 2026-10-05 becomes the only behaviour; a failed audit stays upgradeable — re-close with the same stub, or re-audit via the existing model-side re-close path). `close_unit` returns one verdict line (shapes unchanged: CHANGELOG), commits before the audit, and no fold happens at close — the span stays in view until compaction or `/sam fold <n>`.
- **Removed — the user-facing branch surface (`index.ts`):** the `/sam audit <n>` and `/sam settle <n> [forkFile]` commands, the TUI `audit` subcommand + its completions, and the `branch` delivery mode. The close pipeline's prepare child now runs as the **internal entry `sam-prepare-audit`** — a thin wrapper over the internal `prepareBranchAudit(ctx, unitId?)` (model-free fork + handoff). It is a *visible normal command* by design (Paul's abstraction rule, 2026-10-17: every /sam command is a thin wrapper over an internal method — the model path is `sam-prepare-audit`, the human path is gone); KV-safe because pi's system prompt carries no command enumeration.
- **Removed + extracted — the provider-busyness probe (candidate 5):** `probeBusyness`, `buildProbeUrl`, `parseBusyStatus`, `busynessGate`, `PROBE_DEFERRALS_PER_CLOSE`, the governor fields `probeUrl`/`closeDeferrals`/`closeDeferralsLeft`, the `SAM_PROVIDER_PROBE_URL` env read, the `/sam status` probe line, the optional `probe?` field on the `noFold` ledger record (optional, never consumed by rebuild — dropping it is ledger-safe), and the 2 probe tests. The base code now lives **de-contextualised in the dev repo**: `provider-probe-base.ts` (self-contained module + contract notes + a 4-step re-integration sketch). It was OFF by default, never turned on in any live battery, and its only call-site (the settle-loop deferral) went with the followUp/steer arms.
- **Test rewrite (candidate 8):** the delivery-branching test scaffolding (the `steerBranchInto` fixture builder and its followUp/steer test batteries) is gone; `extension.test.ts` now builds the close-mode state directly from ledger entries (branch-built pendingCommits: close + toolResult + audit instruction + reply, committed at load) and pins the removed dials as no-ops (setting the old envs changes nothing — still 7 tools, single delivery path).
- **Dial collapse (candidate 9, partial):** `SAM_AUDIT_DELIVERY` and `SAM_PROVIDER_PROBE_URL` are out — 13 → 11 operator dials. Unknown/no-op envs are tolerated (the fail-safe reading is unchanged: an unrecognized value means "default", and a removed dial's env now simply does nothing).
- **The surface:** 7 tools — `close_unit`, `retire_units`, `unretire`, `adjust_goal`, `read_goal`, `fold_now`, `sam_retrieve` (the goal tools register on the close surface) — plus the `/sam` command (status/report/undo/fold/resolve/retrieve) and the internal `sam-prepare-audit`.
- **Version:** 0.0.8 → 0.0.9 (package.json + identity.ts + README Status; the identity-vs-package.json pin in the suite carries it).
- **Gate (measured 2026-10-17):** full suite **469 tests / 469 pass / 0 fail / 0 skipped in ALL THREE `SAM_NUDGE` shapes** (the 471-test baseline minus the 2 probe tests; note the old baseline's 6 pre-existing skips no longer occur — 0 skipped measured in every shape); **typecheck CLEAN** vs pi 0.87.1 typings (TS 7.0.2, CONTROL seeded).
- **Kept (shared close-pipeline substrate, not dead code):** `branchAuditInstruction`/`lightAuditInstruction`, `findLastAuditTurn`, `parseBranchAuditReply`, `buildSettlementRecord`, `retrievalIdOf`, `takeoverDetails` (kind `branchAuditSettlements`), the 31 shared-helper pins in `branchaudit.test.ts`, and the D7 nudge channel.
- **Open for Paul:** the fate of `/sam reaudit` (the `close_unit` result text still names it as the upgrade path for a failed audit — the model-side re-close path already exists, so the question is whether the *command* stays, goes, or becomes an internal seam like `sam-prepare-audit`); and how far the command→internal-method refactor extends beyond audit.

## Unreleased — v0.0.8: governor-mode removal (`manual` is the only behaviour) + the `SAM_COMPACTED_SPAN=refuse` opt-out removed (Paul 2026-10-16)

**Ruling (Paul, 2026-10-16, from the legacy-code-eviction analysis):** `manual` is the only governor mode ever battery-run — the `display`/`assisted`/`auto` machinery (sweep loop, R5 backoff memory, auto span-selection, the `/sam mode` command) is removed and `manual` becomes the sole behaviour; and "we never refuse any more" — the `SAM_COMPACTED_SPAN=refuse` opt-out is removed, so the compaction-owned tombstone is the only compacted-span policy. (The 9-candidate removal analysis is the standing record for the remaining candidates; see the dev-repo note of this wave.)

- **Removed — governor modes (`src/governor.ts`, `src/state.ts`, `extensions/.../index.ts`):** the `SAM_MODES`/`isSamMode`/`DEFAULT_SAM_MODE` exports, `state.mode`, the governor's `modeHistory`/`rejectMemory`/`autoTriedSpans`/`autoDeferralsLeft` fields and their producers (`userDeescalationActive`, `recordSweepReject`, `sweepEligible`, `sweepCandidates`, `AutoSpan`, `selectAutoSpan`), the commitWaiting display gate + its `recordSweepReject` call, the settle-time sweep loop (assisted/auto), the auto escape-hatch block, the `g.rejectMemory.clear()` on model change, the `/sam mode` command handler + its TUI completions, the status block's `mode:` line, and the load-line "mode X". Every record write now carries the literal `mode: "manual"`. `SamMode` is kept as the four-value historical type (pre-removal records carry the four values).
- **Removed — compacted-span opt-out (`index.ts`):** the `SAM_COMPACTED_SPAN` env read + the refuse status flag. A span that native compaction already summarized out of view now ALWAYS terminals `resolved` (compaction-owned, zero context edits). The dial is one of the 14 → 13 operator dials.
- **Ledger compatibility (`src/ledger.ts`):** the `SamLedger.mode` field is removed; `rebuildLedger` still PARSES old `kind:"mode"` records and ignores them (the malformed count is unchanged); the `mode` fields on close/fold/noFold records are kept as documented fossils — dropping them would fail `isRecord` validation on every pre-2026-10-16 session rebuild (the discarded alternative, ruled out on that ground).
- **Version:** 0.0.7 → 0.0.8 (package.json + identity.ts + README Status; the identity-vs-package.json pin in the suite carries it).
- **Gate (measured 2026-10-16):** full suite **486 tests / 480 pass / 0 fail / 6 pre-existing skips in ALL THREE `SAM_NUDGE` shapes** (the 504/498 baseline minus 18 mode/sweep/refuse pins; three ledger pins repurposed as fossil-parse pins); **typecheck CLEAN** vs pi 0.87.1 typings (TS 7.0.2, CONTROL seeded).
- **Not touched (separate decisions in the eviction plan):** the `followUp` delivery arm (candidate 1) and the remaining candidates.

## Unreleased — v0.0.7: context-pressure safenet — post-fold pressure nudge + armed auto-retire (Paul 2026-10-16, decision point 1)

**Background (analysis: `2026-10-16-context-pressure-safenet-analysis.md`):** a session that closes units without folding keeps growing the settlement stack until pi's native compaction line — the model has no signal that the next fold is near, and after the fold the old stack (now above the line) rides the new summary with no pressure to retire it. Paul's five decisions (2026-10-16): **Q1** the 40k-shrinkage count rule is a CONFIG VALUE WITH DEFAULT; **Q2** per-fold auto-retire is OK, NO cool-down, and ONE auto-retire must in theory make room for MULTIPLE subsequent folds (sizing must guarantee headroom); **Q3** orphans are minted at FOLD TIME so the model can retire them immediately; **Q4** the pressure nudge CONSUMES the retire offer for that span — it is an "act now!" emergency order, the offer stays the soft suggestion; **Q5** the deployed pi values (reserveTokens/keepRecentTokens) are read into the code — no magic numbers where pi already has one.

- **Part a — the pressure nudge (`index.ts` session_compact, `governor.ts`):** after EVERY fold (user `/compact`, native, and the model's `fold_now` at its onComplete — the exact `estimatedTokensAfter` there) the post-fold context is re-estimated (pi's own `getContextUsage` reports tokens:null right after ANY fold — measured, `agent-session.ts`) through the same formula pi's estimator uses (`estimateProjectedTokens` over the branch projection). When the estimate sits within `headroom` of pi's auto-fold line W−R (line = W − R − `SAM_PRESSURE_HEADROOM`, default 20000), the model gets the **act-now nudge** (`[sam-pressure] ACT NOW …`, `sendUserMessage` deliverAs steer — the D7 channel, AFTER the fold ack so the model learns the fold happened first), the auto-retire ARMS, and the soft retire offer for the span is CONSUMED (Q4). F3: a null/non-finite/negative estimate never nudges.
- **Part b — the auto-retire (`retire.ts` + the takeover hook, `index.ts`):** the armed state is committed at the NEXT fold, INSIDE the takeover hook BEFORE the summary renders — so the new summary already reflects it. Candidate = every settled unit (oldest first, the newest protected, already-retired skipped); selection = oldest-first until the remaining rendered stack is under `target = min(SAM_RETIRE_CHARS, (W−R−headroom−keepRecent−GOAL_RESERVE 2000) × 4 chars/token)` floored at 16000 (Q1+Q2: at 64k the token-aware term ≈32k clears the line, at 128k+ the 40k default binds); ALWAYS at least one. A manual `retire_units`/`unretire` in between SUPERSEDES the order (the model acted ⇒ disarm; Q2: no cool-down — the next pressure nudge re-arms). The durable write: a dedicated `autoRetire` LEDGER KIND (`kind:"autoRetire"` — `AutoRetireAction{v,kind,ts,foldId,unitId,retrievalId,units,items[{unitId,retrievalId,verdictClass}],absorbed?,reason?}`) + one SYNTHESIZED settlement (verdict `"AUTO-RETIRE"` — a new `LedgerVerdictClass`, committed, never parsed; `auditFile:""` ⇒ `sam_retrieve` serves the line). Matryoshka: `absorbed` carries the IMMEDIATE previous auto-retire (constant-size chain — the absorbed unit's own block was already dropped from the summary at its fold).
- **The render (`protocol.ts`, `branchaudit.ts`):** the retired units are GONE from the settlement stack (via `retiredStates` — the union now covers autoRetire entries); the LATEST auto-retire entry renders as `## AUTO-RETIRE — u2, u3 · #<id>` (per-item `uN (verdict) · original: sam_retrieve <id>` lines + `- absorbed:` + `- reason:`), placed after the stack, before ORPHANED; carried `## AUTO-RETIRE` blocks are stripped (keep 0 — duplication; the absorbed line preserves the ids). `branchSettlementRecords` skips verdict `"AUTO-RETIRE"` (it is not a close audit).
- **Orphans are retireable now (Q3) (`branchaudit.ts` + the takeover hook):** the orphan record gains an OPTIONAL `unitId` (minted at fold time from `state.ledger.nextUnitId` — the id-space bump is the `recordCloseInMemory` pattern, synthetic units consume the same space, no gap, no reuse). A minted orphan shows as `## ORPHANED AT FOLD · u<N> · <id>` and is targetable by `retire_units`/`unretire`, retrievable as `sam_retrieve 'unit N'` (the orphan path in `retrieveContent` resolves the minted `unitId` exactly like a close unit's — the banked raw span is the answer; the AUTO-RETIRE unit resolves through its synthesized settlement record, which shares the `unitId`). Retired orphan units' carried blocks are dropped BEFORE the orphan cap (`orphanRetiredIds` — the raw span stays banked). The stale "orphans are not retireable" comments are updated.
- **Deployed values (Q5) (`governor.ts`, `closeaudit.ts`, `index.ts`):** `ladderFor` gains a third arg `DeployedCompactionTokens` (positive finite values override the built-in defaults) and `recomputeGovernor` reads them SYNC via the pure `parseCompactionTokens` over the live settings (`SAM_SETTINGS_JSON` env seam first, then `settings.json` in the agent dir; absent/malformed ⇒ the built-ins). The pressure line and the auto-retire target both use the DEPLOYED reserveTokens/keepRecentTokens — no magic numbers where pi already has one.
- **Ledger (`ledger.ts`):** `SamRecord` union gains `AutoRetireAction`; `isRecord` validates it (items.length === units.length, absorbed shape, the settlement verdict union gains `"AUTO-RETIRE"`); `SamOrphanRecord` gains the optional `unitId`; rebuild appends autoRetire to `ledger.retirements` and settlement/orphan records bump `maxUnitId` (crash-proof: a killed session rebuilds the armed/auto-retire state from its own entries). `retiredStates` handles autoRetire (units ⇒ dropped).
- **Version:** 0.0.6 → 0.0.7 (package.json + identity.ts + README Status; the identity-vs-package.json pin in the suite carries it). New dials documented: `SAM_RETIRE_CHARS` (the offer threshold, now also the auto-retire target cap) and `SAM_PRESSURE_HEADROOM` (20000).
- **Gate (measured 2026-10-16):** full suite **504 tests / 498 pass / 0 fail / 6 pre-existing skips in ALL THREE `SAM_NUDGE` shapes** (480 baseline + 24 new pins — 6 in `retire.test.ts` incl. the GLUE end-to-end (nudge → offer consumed → u1 system-retired at fold 2), 4 in `governor.test.ts` (deployed values, line, nudge-due), 3 in `closeaudit.test.ts` (`parseCompactionTokens`), 3 in `protocol.test.ts` (the act-now text pin, the AUTO-RETIRE block, the settlement line), 4 in `branchaudit.test.ts` (takeover block + orphan unitId + strips), 4 in `ledger.test.ts` (record parse + rebuild)); **typecheck CLEAN** vs pi 0.87.1 typings (TS 7.0.2).
- **Owed:** live verification — a long session crossing the pressure line should show the act-now nudge after a fold and (if unobeyed) the AUTO-RETIRE block at the next fold; the audit channel failed 4× this session (environmental, handoff-missing) so several dev units settled UNVERIFIED per the D9 hatch.

## Unreleased — v0.0.6: summary-sizing fix — old settlement layers ALWAYS stripped + carried-orphan cap (2026-10-15)

**Background (measured on session 01a13a33, findings file `2026-10-15-sam-01a13a33-bug-analysis.md`):** the takeover summary grew **O(N²)** — 4,461 → 191,152 chars over 10 folds — because every fold re-rendered ALL settled units and the carried previous summary kept every earlier layer: `stripOldSettlementStacks` (the v5 RETIRE fix, 2026-10-06) only ran when ≥ 1 retirements existed (none did), and the carried ORPHANED blocks accumulated unbounded (13 blocks ≈ 30k chars at the last fold; orphans carry no unitId ⇒ NOT targetable by `retire_units`). The retire census (latest 11 records, 31,718 chars) never reached the 40k offer threshold against the 191,152 actually pushed — the offer stayed MOOT.

- **D1 — the retire-gate is gone (`src/branchaudit.ts`):** `takeoverSummary` now strips the carried previous summary's old settlement layers **always** — `retirements` is still consumed for the fresh render (dropped → gone, superseded → one line, superseding unit gains its `supersedes` line), but the strip no longer requires `retirements.length > 0`. The old layers are pure duplication of the fresh all-unit render (v5 RETIRE doc) — nothing is lost. This kills the measured O(N²): the carried summary can no longer accumulate one full stack per fold. One pin flipped: the old house-rule test ("with NONE the pre-retire path stays byte-identical") now asserts the old layer is GONE even with zero retirements.
- **D2 — carried-orphan cap (`src/branchaudit.ts`):** new pure `stripOldOrphanBlocks(text, keep)` + `orphanKeepCount(env)` + `ORPHAN_HEADING_PREFIX` (the heading is now rendered via the exported prefix; `orphanBlock`'s output is byte-identical). Applied to prev after the layer strip: only the LAST `keep` carried orphan blocks survive (chronological — oldest at top), and all stale carried pointer lines are dropped (each old summary's tail marker — the fresh render re-appends the pointer, and it pinned a retrieval map the carried text no longer renders). The CURRENT fold's own orphan block is appended AFTER the cap ⇒ a summary carries ≤ keep + 1 blocks. keep = `SAM_ORPHAN_KEEP`, default `ORPHAN_KEEP_DEFAULT = 2` (same envInt discipline as the other dials: non-finite / negative ⇒ default). Dropped blocks' raw spans stay banked (`sam_retrieve <hash>`).
- **D3 — census UNCHANGED:** with D1 the pushed stack IS the latest-stack render, so `retireCensus` (latest-per-unit records) now measures what actually rides the next summary; orphans (not retireable) must not count toward the retire threshold — the 40k `RETIRE_THRESHOLD_CHARS_DEFAULT` keeps its meaning.
- **Version:** 0.0.5 → 0.0.6 (package.json + identity.ts + README Status; the identity-vs-package.json pin in the suite carries it).
- **Gate (measured 2026-10-15):** full suite **480 tests / 474 pass / 0 fail / 6 pre-existing skips in ALL THREE `SAM_NUDGE` shapes** (475 baseline + 5 new pins); **typecheck CLEAN** vs pi 0.87.1 typings (TS 7.0.2, CONTROL=1 seeded). New pins in `test/orphan-anchor.test.ts`: `stripOldOrphanBlocks` (total at/below cap + stale-pointer drop, oldest-dropped/keep-2 with one-blank separators, keep=0/negative drops all from the first heading to EOF), `orphanKeepCount` dial discipline, and the `takeoverSummary` integration (≤ keep + 1 total, the fresh orphan never capped, keep=1/0 variants, no-fresh-orphan case).
- **Owed:** live verification — the next folds of a long-running session should show a flat (not growing) summary size (the first such session is owed; 01a13a33 itself ran on 0.0.5).

## Unreleased — v0.0.5: fold-resume — a model-initiated fold restarts the turn (2026-10-14)

**Background:** the first live `fold_now` (2026-10-14) worked (107,193 → 49,716
tokens, clean context) but left the session idle: the model-initiated
`sam-fold-ack` was queued `deliverAs: "nextTurn"` and reached the model only at
the next **user** input. Paul's decision (2026-10-14, "implement the oncomplete
trigger autonomously"): **Option 1** — keep the abort-then-fold mechanics; the
model-initiated ack is sent with `triggerTurn: true` right after compaction
completes, starting a new LLM turn. The state the resume carries is the
takeover summary (goal + settlement lines) + pi's retention tail — the message
itself carries no state.

- **The change (index.ts):** the tool's `onComplete` sends the model-initiated
  ack with `{ triggerTurn: true }` (the turn is already dead — F1: `compact()`
  aborts it — so `sendCustomMessage` takes the not-streaming branch →
  `_runAgentPrompt`, a new turn; pi's `_deferredSettledActions` handles the
  settle race, and the streaming fallback would resume via `agent.followUp`).
  `session_compact_failed`: a genuine **model-initiated** failure (the
  `foldInFlight` flag read before it is cleared) sends the failure ack with
  `triggerTurn: true` (the model lost its turn and nothing was compacted —
  retry or continue); an **aborted** fold stays operator-line only; user/native
  failures are unchanged (`deliverAs: "nextTurn"`).
- **Texts (fold.ts):** the model-origin `foldAckText` gains the continuation
  line ("Your turn was compacted — resume the work from the settlement lines
  above (stop if the task is done)."; user/native acks unchanged); `foldFailText`
  becomes an actionable resume ("…Your turn was aborted — resume the work:
  retry fold_now at a clean boundary, or continue from where you left off.");
  `FOLD_NOW_TRIGGERED_TEXT` + the tool description + the emit lines: "queued
  for the next turn" → "restarts your turn".
- **Scope:** model-initiated folds only — user `/compact` + pi's native folds
  unchanged (ack queued for the next turn, as before). No new dial (`SAM_FOLD`
  unchanged, default ON).
- **Version:** 0.0.4 → 0.0.5 (package.json + identity.ts + README Status; the
  identity-vs-package.json pin in the suite carries it).
- **Alternatives considered:** Option 2 (defer the fold to turn-end + resume)
  — rejected: a scheduling race with new user input for a cosmetic gain (the
  mid-turn abort error line is not a problem); a resume-message redesign —
  rejected (Paul: the current ack content is basically fine).

## Unreleased — v0.0.4: model-initiated fold (`fold_now`) + the two goal-nudge bug fixes (2026-10-14)

**Design note: dev-repo `2026-10-14-eval-model-initiated-fold-after-close-unit.md` (the fold evaluation — verdict **feasible, ~95% existing machinery, zero pi changes**; this section is its implementation) + `CURRENT_TASK.md` 2026-10-14 (the two bug fixes, root-caused in pi v0.87.1 source, with the alternatives considered).** Paul's GO 2026-10-14: "implement the fold mechanism as version 0.0.4" + both bugfixes (Bug B re-opened after an earlier decline).

**The fold (unit 4):** pi 0.87.1 exposes `ctx.compact()` (the manual path — the user's `/compact` is exactly this call, agent-session.ts ~2685; `ExtensionToolContext` extends `ExtensionContext`, types.ts:383), so the model-initiated fold is one tool + one ack channel, no pi changes:

- **`fold_now` tool** (no parameters, `executionMode: "sequential"`) — refuses on the F4 audit-fork guard (the guard family's one-liner; a child must never fold) and on F3 single-flight (a fold already in progress); otherwise it calls `ctx.compact()` **fire-and-forget** and returns a transcript acknowledgement. **F1 (measured, pinned commit): `compact()` aborts the calling turn first** — the model never reads the tool result; the real result rides the ack. The tool's own `onComplete`/`onError` are the backstops (pi emits `session_compact` BEFORE the ctx-level `onComplete` resolves — measured ~2774 vs ~2800 — so the model-initiated ack is DEFERRED into `state.foldAckPending` and consumed exactly once by `onComplete`, which carries the exact `CompactionResult.estimatedTokensAfter`; native/user folds are acked immediately from the entry's exact `tokensBefore` + the honest retention-tail phrase).
- **`sam-fold-ack` channel** — a CUSTOM MESSAGE via `pi.sendMessage` (`deliverAs: "nextTurn"`, `display: true`): a `CustomMessageEntry` participates in the LLM context (session-manager.ts:1332) — in contrast to `appendEntry`'s ledger records, which never reach the model. Every fold kind gets one: the model's `fold_now` ("your fold_now call"), the user's `/compact` ("the /compact command"), pi's native threshold/overflow folds ("pi's automatic fold"); the takeover gate (reason-independent) decides whether SAM's summary or pi's own summary stands, and the text names it. The failure ack (`session_compact_failed`) tells the model the fold FAILED with no state change (it must not assume the context shrank); an ABORTED fold sends no model message (operator line only). The raw span stays banked (tombstone / `sam_retrieve`) — the ack says so.
- **The nudge fold hint** — the D7 `band`/`gap` texts gain a `fold_now` pointer when `SAM_FOLD` is ON, the zone is under pressure (watch/action), and the last close is SETTLED (everything up to it is summarized in the settlement lines — a fold now is the clean case). The `reasoning` nudge never carries it (not context-pressure). No new dial for the hint: it rides `SAM_FOLD` + the existing `SAM_NUDGE` switch.
- **`SAM_FOLD` dial, DEFAULT ON** (alternative documented in CURRENT_TASK.md: default-OFF behind a dial — rejected; the house practice is new behaviour behind a dial with the DEFAULT active, like `SAM_NUDGE`; the native threshold fold applies either way — the dial only arms the tool + the hint). `close_unit{fold:true}` sugar: DEFERRED (the model can close then fold; no parameter surface needed now).

**Goal-nudge Bug A (unit 2) — the offer fired on input that never landed:** root cause measured in pi v0.87.1 `agent-session.ts`: `prompt()` fires the `input` event via `_runInputHandlers` BEFORE the session append (~1908); a mid-turn steer is only `_queueSteer`ed (~1927) and lands when consumed — so a queued steer that the user edits away leaves no session entry but has already armed the pending goal-nudge offer, which then fires at the first `message_end` against a goal that never changed. Fix: the fire-time **landing check** in `attemptGoalOffer` — the offer may fire only if the branch's last REAL user message (`lastRealUserMessage`, goal.ts) is newer than the `lastCoveredRealUser` watermark stamped on every consumption (fire/suppress/invalidate; the successful `adjust_goal` path stamps too). No new real input ⇒ the offer is invalidated (pending cleared, `sam-nudge` ledger trace `invalidated: true` + reason, an operator emit) — the goal-nudge only happens if there was an actual user input. Alternatives documented: session-driven arming, arm-time snapshot, TUI-side fix.

**Goal-nudge Bug B (unit 3) — the nudge after a successful `adjust_goal`:** root cause: the `userinput` variant is unconditional per the 2026-10-04 decision, and `clearGoalPending` clears the sessionstart variant only. Fix: the **one-shot waiver** — a successful `adjust_goal` (toolResult `isError: false`) clears the NEXT userinput offer silently at fire time (moot: no ledger entry, no emit — like the sessionstart-moot path); subsequent offers fire normally. Semantics note for Paul: the first input after an `adjust_goal` gets no goal offer; all later ones do. Alternatives documented: absolute suppression, ordering rules, cooldown, dial.

**What ships:** `src/fold.ts` (NEW — dial, tool surface + refusal texts, `foldAckText`/`foldFailText`, the `sam-fold-ack` type/marker); `src/nudge.ts` (`FOLD_NUDGE_HINT` + the `foldHint` fact); `src/goal-nudge.ts` (Bug A: `lastCoveredRealUser` watermark + `goalNudgeLanding` + `stampGoalCovered` + the `invalidated` ledger trace; Bug B: `waivedNextUserinput` + `waiveNextUserinput`); `src/state.ts` (`foldInFlight` + `foldAckPending` on the fold runtime); `src/identity.ts` + `package.json` (**0.0.4** — the 0.0.3 bump had left `SAM_VERSION` at 0.0.2, caught and fixed now; a new pin matches identity against package.json so the drift class is closed); `index.ts` (the `fold_now` tool + the two listeners + the nudge-hint glue + the `adjust_goal` path); pins: `test/fold.test.ts` (NEW, 21), `test/close-audit.test.ts` (8 wiring + the harness's `sendMessage`/`compact` captures), `test/extension.test.ts` (surface 7 tools, the two new listener events, the identity pin), `test/goal-nudge.test.ts` (landing + waiver), `test/nudge.test.ts` (the hint texts).

**Gate (measured 2026-10-14):** full suite **473 tests / 467 pass / 0 fail / 6 pre-existing skips in ALL THREE `SAM_NUDGE` shapes** (444 baseline + 29 new pins); **typecheck CLEAN** vs pi 0.87.1 typings (TS 7.0.2, CONTROL seeded). One live check still owed (F2, the next real session — qube inference exclusivity: real model calls always synchronous, never backgrounded): an aborted turn's remnants must not leak into the next turn's start.

## Unreleased — Audit-delivery default flipped `followUp` → `close` (2026-10-05 — per the version policy then, the **version stayed 0.0.1** at the time; the subsequent 0.0.2–0.0.7 waves are the sections above)

**Ruling (Paul, 2026-10-05, verbatim):** "followUp is deprecated, it bricks the main session - delivery=close should be the default now. everything else checks out." → the audit-delivery **default** is now `close` (the v4 synchronous close-time audit — the same path the battery has pinned explicitly since 2026-10-01, and the one validated live in arm O rep-3: close→audit→settle chain, D9 audit-failed hatch, zero `followUp` sends on that run). `followUp` is RETAINED, explicitly **DEPRECATED** (code path kept; the v3 control arms keep their byte-stable 2-tool surface on it); `steer`/`branch` unchanged; unknown/unset → `close` (fail-safe to the default).

**What ships (measured gate green below):**
- `src/state.ts` — the factory default is `close`, and the mapping is now ONE exported source of truth: `auditDeliveryFromEnv(env)` (exact values `steer`/`branch`/`close`; `followUp` = deprecated explicit opt-in; anything else → `close`).
- `index.ts` — **latent wiring defect surfaced + fixed by the flip (measured in the rep-3 trace, root-caused this session):** the D11 goal tools (`adjust_goal`/`read_goal`) registered only when `state.auditDelivery === "close"` AT FACTORY TIME — but the env mapping runs at `session_start`, which fires AFTER the factory, so the surface always tracked the module default, never the operator's dial (rep-3: the goal OFFER fired with the goal tools ABSENT on the followUp-default 2-tool surface). The registration gate now resolves from the env via the single source (`close`-or-default ⇒ goal tools; the deprecated `followUp`/`steer`/`branch` dials keep their byte-stable 2-tool surface). The F1 fallback state keeps the operator's dial too.
- `test/extension.test.ts` — the suite is the glue for the followUp flow, so it now pins `SAM_AUDIT_DELIVERY=followUp` at file level (documented seam; the 3 in-series flow tests still pin it per-test); the unknown-value fail-safe test re-pinned to the NEW default (no in-series followUp send under it); TWO new pins: the factory default (`createSamState ⇒ "close"`) and the **DEFAULT tool surface** (unset ⇒ `close_unit` + `adjust_goal` + `read_goal` + `sam_retrieve`; the followUp-surface 2-tool set stays pinned as the deprecated byte-stable arm).
- README/flags — the `/sam` status now names the deprecated `followUp` choice explicitly (and the `close` flag is marked DEFAULT since 2026-10-05); the steers "DEFAULT" wording corrected; the dials table reflects the flip.

**Gate (measured 2026-10-05):** Node test-runner suite **370 pass / 0 fail / 6 skip** (376 collected); typecheck **CLEAN** vs pi 0.87.1 (tsgo 7.0.2, CONTROL seeded); per-dial registration surface VERIFIED live (unset/close ⇒ 4 tools incl. the goal pair; followUp/steer/branch ⇒ the byte-stable 2-tool set; unknown value ⇒ `close` fail-safe). Batteries unaffected (they pin `close` explicitly — now identical to the default; the deprecated `followUp` pin stays available for the byte-stable control runs, where it was always the explicit choice).

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
contamination): banks (dev repo) `probe-midturn-fork-2026-10-01-r1` (red-as-is —
over-strict assertion, shape discovery kept as evidence) + `-r2` (PASS, all hard
assertions green). **Remaining (not yet done):** the deterministic walk arms (multi-fork
+ fail paths) and the full local gate — and only then, per rep with the operator's GO in
the manifest, any live v4 run (F1).

**D7 FINAL — nudge spec settled + landed (2026-10-02, Paul's spec + confirmations; wording still PROVISIONAL — his):** the nudge now runs on ONE measured ruler — `gap = ctx − baseline` (baseline = the last successful `close_unit`, then session start / the post-compaction view), with a FLOOR of **20,000 tokens = pi v0.87.1's measured `compaction.keepRecentTokens` default** (the raw kept tail of every compaction, takeover AND native — source pi v0.87.1 `compaction.ts` cut-point walk + settings-default; measured in the settled run's compaction #4: `tokensBefore` 115,754, `firstKeptEntryId` at position 88,117 ⇒ 27.6k kept). NO override, NO dial (Paul 2026-10-02) — the floor is the retain window of the "last close farther than the retain window" rule AND the KV-headroom rationale (Paul's root cause, 2026-10-02: "the auditor failed because it tried to audit when kv was close to 32k context and failed because there was simply not much kv left" — the banked pair (P4 armA @ registered 32,768 window — audit stage FAIL, `report.md`: "audit instruction drained — no [sam-audit] user message", "verdict=undefined"; P5 armE @ 49,152 — 18/18 flawless) is that failure MODE; the earlier drafts' model-capability-floor reading is RETRACTED, house rule). Two classes share the floor (one of each per stretch; a close OR a settlement-less compaction re-arms both, baseline re-stamped at the next observed ctx): **`gap`** — `gap ≥ 20k` (any zone), ≤1 per stretch, global cooldown (SUPERSEDED by the same-day correction below: NO time in any trigger — the per-stretch flag is the anti-spam) — the early-checkpoint ask (audit on a small, still-fast context); **`band`** — zone `watch`/`action` (≥ W−2R, one full reserve below the native line W−R) AND `gap ≥ 20k`, ≤1 per stretch, **NOT cooldown-gated** ("a second urgency nudge is allowed even if the earlier nudge still did not get a close_unit as answer" — Paul, verbatim), and it CONSUMES the stretch's `gap` flag (urgency supersedes — spam guard); in-band with the gap under the floor stays SILENT (the 96k/105k case: a 9k unclosed tail fits the retained window ⇒ nothing at risk — channels A (settlement lines, distance-independent — takeover source-verified) + B (raw kept tail); a DEFERRED audit falls out to the native path, where the stub survives only via B/C). `reasoning` class unchanged (SUPERSEDED by the same-day correction below: it gets its OWN activity rulers — tool calls + thinking). `NudgeRuntime` re-derivation: `firedGap`/`firedBand` + `baselineTokens`/`pendingBaselineReset` (close/compaction re-stamp, ruler-missing stays pending — F3). Text: BOTH `gap` and `band` carry the current context share (Paul 2026-10-02: "include current context in the nudge, EXCEPT for the urgency call, which should contain the warning that a fold is imminent" — `band` keeps "climbing toward pi's compaction line"); `gap` = the early-checkpoint framing; PROVISIONAL, vetoable (reword = pin rewrite). Wiring: `session_before_compact` is now a stretch boundary for ANY compaction (takeover idempotent — the close already re-armed) + close re-arm via the toolResult path (both pinned). KNOWN SIMPLIFICATION (labelled): resumed sessions start the baseline at 0 (gap = current ctx) — conservative direction (nudges more, never less), flagged in the design note. **Local state (re-measured on this tree 2026-10-02):** nudge pins **38/38**; suite **309 tests / 303 pass / 0 fail / 6 env-skips** (old bar 297/291 + 38 new − 26 old); typecheck **CLEAN** (tsgo 7.0.2 @ pi 0.87.1 typings, `PI_TYPES_DIR=/workspace/pi-binary/0.87.1/node_modules`; CONTROL=1 falsified first — seeded TS2322 reported). The live dry-run proof (a real steer reaching the model, a `close_unit` answering it — covering BOTH classes + the 96k/105k silence case) remains OWED before any battery rep (D1 lesson).

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

**The v3 pivot (measured, evidence banked `p2-walk-2026-10-01-walk-branch-audit-rehearsal{,2,3}` + design §13):** the v2 in-process flow (the `/sam audit` handler runs the model turn on the fork in-command) **does not work under pi print mode** — pi's one-shot loop does not pump command-initiated extension model turns (measured: instruction appended to the fork file, zero model calls). Consequence: the branch audit is **runner-orchestrated** — `/sam audit <n>` = prepare only (fork at leaf + JSON handoff on the operator channel, **model-free**); the runner prompts the fork session with the emitted instruction (one model turn on the fork); `/sam settle <n> <forkFile>` = stage + synchronous settle (settlement record + the unchanged close-time terminal; **model-free**, one short ack turn); `/sam retrieve <id>` / `sam_retrieve` (O3); the compaction **takeover** carries the settlement line (verbatim in the summary + `details.sam` map + tombstones banked). New measured pi-0.87.1 facts in design §13 (stale-ctx guard after `fork`/`switchSession` — `withSession` callbacks only; boundary entries commit only via an appended-message turn; `/compact` in print mode is a plain model prompt — compaction entry points are the auto-threshold or the RPC `compact` command; project settings are trust-gated in print mode — `compaction.keepRecentTokens` must be set in the global `~/.pi/agent/settings.json`; `prepareCompaction` refuses when nothing sits outside the keep-recent window; pi 0.87.1 persists the takeover flag as `fromHook`).

**Local state (all green, 2026-10-01):** typecheck CLEAN (tsgo 7.0.2, pi 0.87.1 typings, CONTROL=1 proven); suite **225 tests / 219 pass / 0 fail / 6 env-skips** (incl. the branch-audit pins — incl. the settlementLine omission pin + registration-surface pin: 2 tools / 4 listeners); walk **branch-audit 10/10** + **live-e-shape 12/12** (the rep-2/3 runner shapes pinned) + full walk regression **all arms green**; R3/R4 replays **PASS** (deterministic, 5 fresh replays each). Live arms A–D unchanged (banked 2026-09-30).

**Live v3 (2026-10-01, qwen38-gsq-rco-kv, window 49152, xhigh — banked in the dev repo `run-outputs`):** the P5 one-shot is done, with its v3 baseline: **rep-3 = first fully green live run, 18/18** (verdict VERIFIED, all five ground-truth values in the 960-char settlement line, both MARKERs, terminal B-shape, R3, `fromHook` takeover, checklist 5/5; `p5-live-ab-2026-10-01-armE-rep3-qwen38-gsq-rco-kv`) and **E27 = first battery rep, 17/18 banked-as-failed per the ruling** (verdict VERIFIED, checklist 5/5, wall 824s; the single FAIL = the vehicle-specific MARKERs-in-settlement-line assertion — the auditor correctly excluded post-close (unit-2-scope) MARKERs from unit-1 EVIDENCE per the instruction's "e.g." wording; the markers survived via pi's takeover summary (measured) — `p5-live-ab-2026-10-01-armE-rep27-qwen38-gsq-rco-kv`). Rehearsals rep-0/1/2 = three root-caused harness/extension bugs consumed + fixed + pinned (banks `p5-live-ab-2026-10-01-armE-rep{0,1,2}-*`: RPC UI-event capture; `findLastAuditTurn` first-assistant trap; pi 0.87.1 `ctx.fork` session rebind → same-file settle refuse — the live arm E is now per-stage-process shaped, walk v3k). **Paul's ruling (2026-10-01), recorded in P5 §12: v3 = baseline; audit-after-compaction loss is an assumed, now-tightened limitation; no protocol/assertion change; E27's FAIL = documented baseline variance, not a defect to chase.**

## Unreleased — P4 extension arms C/D measured; steer profile + P5 branch-audit design (2026-09-30 night)

No behaviour change to the shipped code. Two live-measurement results land in the
dev-repo record (`arms-cd-report.md`):

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
(report.md/json + analysis.md) and
`p4-live-ab-2026-09-30-arm{A,B}-rep{15..21}-*` (banked, F1).

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
- **Replay-eval** (dev repo, banked): the s5 banked session's
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

/* ── TUI argument completion (0.0.2 wave, Paul 2026-10-05) ─────────────────
   His observation: the /sam description line is "too long" (doesn't fit the
   TUI's display line), and he wants UI-settings autocomplete — "show valid
   options while typing … either by registering the proper options or with
   /sam:<command>".
   MEASURED (pi mirror v0.87.1): the first path is native — RegisteredCommand
   carries `getArgumentCompletions?(prefix) => AutocompleteItem[] | null`
   (core/extensions/types.ts:1330) and pi's own /model and /thinking use that
   very hook (modes/interactive/interactive-mode.ts:689/715) — so NO colon
   syntax is needed; we register the options the pi-way.
   AutocompleteItem = { value, label, description? }
   (packages/tui/src/autocomplete.ts:229) → plain object literals; no static
   import required (we run inside the pi host).
   Pure total function (for the pins); the TUI's VISUAL rendering is pi's —
   Paul verifies the command side on the Qube TUI (the VM cannot display it). */

import { SAM_MODES } from "./state.ts";

/** pi-tui's AutocompleteItem — mirrored as a plain type (no host import).
 *  `value` is the text inserted on selection (the /model precedent). */
export interface SamCompletionItem {
	value: string;
	label: string;
	description?: string;
}

/** The subcommands — single source for the completion list. */
export const SAM_COMPLETION_SUBCOMMANDS: readonly SamCompletionItem[] = [
	{ value: "goal", label: "goal", description: "show the stored goal (current)" },
	{ value: "report", label: "report", description: "ledger + status readout" },
	{ value: "mode", label: "mode", description: "set display mode: display|manual|assisted|auto" },
	{ value: "depth", label: "depth", description: "audit depth: auto|full|light (overrides the env dial in this session)" },
	{ value: "fold", label: "fold", description: "fold unit <n> (audit the span)" },
	{ value: "resolve", label: "resolve", description: "resolve unit <n>" },
	{ value: "audit", label: "audit", description: "run the audit for unit <n>" },
	{ value: "settle", label: "settle", description: "settle unit <n> (stage capture + settle)" },
	{ value: "reaudit", label: "reaudit", description: "re-audit unit <n> (same stub)" },
	{ value: "undo", label: "undo", description: "undo the last close" },
	{ value: "retrieve", label: "retrieve", description: 'sam_retrieve <id> ["exact-text"]' },
];

/** `mode <m>` — values carry the "mode " prefix (full argument inserted). */
export const SAM_MODE_COMPLETIONS: readonly SamCompletionItem[] = SAM_MODES.map((m) => ({
	value: `mode ${m}`,
	label: String(m),
	description: "display mode",
}));

/** `depth <d>` — the in-session audit-depth switch (2026-10-06, Paul). */
export const SAM_DEPTH_COMPLETIONS: readonly SamCompletionItem[] = ("auto full light").split(" ").map((d) => ({
	value: `depth ${d}`,
	label: String(d),
	description: "audit depth",
}));

/** The registration description — short enough for the TUI line (was ~190
 *  chars; now < 120). The subcommand detail moved to the completions. */
export const SAM_COMMAND_DESCRIPTION =
	"pi-self-aware-memory — status; goal · report · mode|depth <m> · fold|resolve|audit|reaudit <n> · undo · retrieve <id>";

const UNIT_COMMANDS: ReadonlySet<string> = new Set(["fold", "resolve", "audit", "reaudit"]);

/**
 * Completion candidates for the typed `prefix` (the text after "/sam ").
 * Semantics (pure, total — for the pins):
 *  - "" (just typed "/sam ") ⇒ the subcommand list;
 *  - one word ⇒ the subcommands matching its start (pi's fuzzy engine does
 *    the display-side filtering, the /model precedent; a start that matches
 *    nothing ⇒ null — no false candidates);
 *  - "mode" (± a typed tail) ⇒ the four display modes (value "mode <m>");
 *  - fold | resolve | audit | reaudit (± a typed tail) ⇒ the LIVE ledger unit
 *    ids (value "<command> <n>"); unknown ids ⇒ null;
 *  - any other multi-word prefix ⇒ null (free text, as before).
 */
export function samCompletionsFor(prefix: string, unitIds: readonly number[] = []): SamCompletionItem[] | null {
	const p = prefix.trim();
	const head = p === "" ? "" : p.split(/\s+/)[0];
	const tail = p.slice(head.length).trim() !== "";
	if (UNIT_COMMANDS.has(head)) {
		if (unitIds.length === 0) return null;
		return unitIds.map((n) => ({ value: `${head} ${n}`, label: String(n), description: `unit ${n}` }));
	}
	if (head === "mode") return SAM_MODE_COMPLETIONS;
	if (head === "depth") return SAM_DEPTH_COMPLETIONS;
	if (!tail) {
		if (head === "") return [...SAM_COMPLETION_SUBCOMMANDS];
		const filtered = SAM_COMPLETION_SUBCOMMANDS.filter((s) => s.value.startsWith(head));
		return filtered.length > 0 ? filtered : null;
	}
	return null;
}

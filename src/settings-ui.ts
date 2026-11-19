/**
 * SAM settings UI (v0.0.20, 2026-10-23) — the interactive components behind
 * `/sam depth` (no arg) and `/sam settings`, shown through `ctx.ui.custom`
 * as a full-width, BOTTOM-ANCHORED OVERLAY (v0.0.49+ — the same hosting as
 * `/sam report`: anchor bottom-left, matching pi's own settings placement in
 * the bottom editor slot; the mouse wheel reaches the components via pi's
 * overlay mouse dispatch, handleMouse).
 *
 * Deliberately NO `@earendil-works/pi-tui` import: the extension runtime
 * resolves that package through pi's virtual-module alias, but the pinned
 * 0.87.1 capture does not ship the package (only 1.3.0 does — measured), so
 * this file is typed against the minimal structural surface the custom
 * factory actually provides: Component = render(width) / handleInput? /
 * handleMouse? / invalidate, and KeybindingsManager = matches(data, keyId) /
 * getKeys(keyId).
 * The 1.3.0 typecheck therefore checks us against the real interfaces
 * structurally; the 0.87.1 typecheck passes because pi-coding-agent's own
 * d.ts references are lib-skipped there.
 */

/** The structural view of pi's KeybindingsManager (both pinned versions). */
export interface SamKeybindings {
	matches(data: string, keybinding: string): boolean;
	getKeys(keybinding: string): readonly string[];
}

/** The key ids used by both components (measured present in both versions —
 * the app.* ids are user-rebindable via <agentDir>/keybindings.json, which is
 * exactly the point: the save gesture follows the user's configured key). */
export const SAM_UI_KEYS = {
	up: "tui.select.up",
	down: "tui.select.down",
	confirm: "tui.select.confirm",
	cancel: "tui.select.cancel",
	save: "app.thinking.save",
	// v0.0.40 (report windowing): pi's select page keys — they EXIST in
	// pi's keybinding registry (tui.select.pageUp/pageDown, default
	// "pageUp"/"pageDown" — measured 2026-11-16 in keybindings.d.ts:36-37),
	// user-rebindable like the rest; no new registration needed.
	pageUp: "tui.select.pageUp",
	pageDown: "tui.select.pageDown",
} as const;

/** Format a key id for the footer hints — replicates pi-internal
 * keybinding-hints keyDisplayText (split on "+", capitalize the parts). */
export function formatKeyHint(keybindings: SamKeybindings, keyId: string): string {
	const keys = keybindings.getKeys(keyId);
	if (keys.length === 0) return keyId;
	return keys
		.map((k) =>
			k
				.split("+")
				.map((p) => (p.length > 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
				.join("+"),
		)
		.join(", ");
}

export type SamEnumSelectorResult =
	| { kind: "cancel" }
	| { kind: "select"; value: string }
	| { kind: "persist"; value: string };

/**
 * The generic enum selector — rows with a ✓ on the current effective value,
 * footer hints, confirm = select (in-session), the save key (pi's configured
 * app.thinking.save — default Ctrl+S) = select + persist to settings.json,
 * cancel = close. Used by `/sam depth` (no arg) and by enum dials from
 * `/sam settings`.
 */
export class SamEnumSelector {
	private keybindings: SamKeybindings;
	private values: readonly string[];
	private currentValue: string;
	private title: string;
	private onDone: (result: SamEnumSelectorResult) => void;
	private cursor: number;
	private closed = false;

	constructor(
		keybindings: SamKeybindings,
		values: readonly string[],
		currentValue: string,
		title: string,
		onDone: (result: SamEnumSelectorResult) => void,
	) {
		this.keybindings = keybindings;
		this.values = values;
		this.currentValue = currentValue;
		this.title = title;
		this.onDone = onDone;
		const idx = values.indexOf(currentValue);
		this.cursor = idx >= 0 ? idx : 0;
	}

	render(width: number): string[] {
		void width; // the lines are short; pi clips long lines in the overlay
		const lines: string[] = [`  ${this.title}`, ""];
		for (let i = 0; i < this.values.length; i++) {
			const v = this.values[i];
			lines.push(`    ${i === this.cursor ? ">" : " "}${v === this.currentValue ? "✓ " : "  "}${v}`);
		}
		lines.push("");
		lines.push(
			`  ${formatKeyHint(this.keybindings, SAM_UI_KEYS.confirm)} to select · ` +
				`${formatKeyHint(this.keybindings, SAM_UI_KEYS.save)} to select + save to settings · ` +
				`${formatKeyHint(this.keybindings, SAM_UI_KEYS.cancel)} to cancel`,
		);
		return lines;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (kb.matches(data, SAM_UI_KEYS.up)) {
			this.cursor = (this.cursor + this.values.length - 1) % this.values.length;
		} else if (kb.matches(data, SAM_UI_KEYS.down)) {
			this.cursor = (this.cursor + 1) % this.values.length;
		} else if (kb.matches(data, SAM_UI_KEYS.cancel)) {
			this.closed = true;
			this.onDone({ kind: "cancel" });
		} else if (kb.matches(data, SAM_UI_KEYS.save)) {
			this.closed = true;
			this.onDone({ kind: "persist", value: this.values[this.cursor] });
		} else if (kb.matches(data, SAM_UI_KEYS.confirm)) {
			this.closed = true;
			this.onDone({ kind: "select", value: this.values[this.cursor] });
		}
	}

	/** The mouse wheel (v0.0.49+ — the component is now hosted as a
	 * bottom-anchored overlay, so pi's alt-screen mouse dispatch reaches us
	 * — the same hosting as `/sam report`). The wheel moves the cursor,
	 * clamped at the ends (the arrow keys keep their wrap); `{handled: true}`
	 * consumes the event, non-wheel passes through. */
	handleMouse(event: { type: string; wheelDelta?: number }): { handled: true } | undefined {
		if (this.closed || event.type !== "wheel") return undefined;
		const delta = event.wheelDelta ?? 0; // pi types wheelDelta as optional
		if (!Number.isFinite(delta) || delta === 0) return undefined;
		this.cursor = Math.max(0, Math.min(this.values.length - 1, this.cursor + delta));
		return { handled: true };
	}

	invalidate(): void {
		/* stateless render — nothing cached */
	}
}

export interface SamSettingsMenuRow {
	key: string;
	label: string;
	valueText: string;
	sourceText: string;
	/** The one-line plain-language note (v0.0.22) — shown for the highlighted row. */
	description: string;
}

export type SamSettingsMenuResult =
	| { kind: "cancel" }
	| { kind: "edit"; key: string }
	| { kind: "persist"; key: string };

/**
 * The `/sam settings` menu — one row per dial: label, effective value
 * (ms dials shown in seconds), and the source layer, plus a one-line
 * plain-language note for the highlighted row (v0.0.22). Navigate with
 * up/down; confirm = open the value editor for the selected dial
 * (in-session); the save key (pi's configured app.thinking.save) = apply
 * in-session AND persist to settings.json (pi's /settings behaviour —
 * clears the key when the value is the default); cancel = close.
 */
export class SamSettingsMenu {
	private keybindings: SamKeybindings;
	private rows: readonly SamSettingsMenuRow[];
	private onDone: (result: SamSettingsMenuResult) => void;
	/** v0.0.49+: the live terminal height (windowing the dial list on small
	 * terminals — the same getRows wiring as the report); absent in the
	 * tests and on any surface without a terminal ⇒ no windowing */
	private getRows?: () => number;
	private cursor = 0;
	private closed = false;

	constructor(
		keybindings: SamKeybindings,
		rows: readonly SamSettingsMenuRow[],
		onDone: (result: SamSettingsMenuResult) => void,
		/** v0.0.49+: the live terminal height (optional — see the field) */
		getRows?: () => number,
	) {
		this.keybindings = keybindings;
		this.rows = rows;
		this.onDone = onDone;
		this.getRows = getRows;
	}

	render(width: number): string[] {
		void width;
		const lines: string[] = ["  SAM settings — self-aware-memory section of pi's settings.json", ""];
		// v0.0.49+: window the dial list to the terminal when it does not
		// fit — the frame is the 6 fixed lines around the rows (header +
		// blank + blank + description + blank + hint), and the window centres
		// on the cursor (the report's list-level calculation), so the
		// highlighted row is always visible.
		const vis = this.getRows !== undefined ? Math.max(this.getRows() - 6, 1) : this.rows.length;
		const start =
			this.rows.length <= vis
				? 0
				: Math.min(Math.max(this.cursor - Math.floor(vis / 2), 0), this.rows.length - vis);
		const end = Math.min(this.rows.length, start + vis);
		for (let i = start; i < end; i++) {
			const r = this.rows[i];
			lines.push(`    ${i === this.cursor ? ">" : " "}${r.label}: ${r.valueText}  [${r.sourceText}]`);
		}
		lines.push("");
		lines.push(`  — ${this.rows[this.cursor].description}`);
		lines.push("");
		lines.push(
			`  ${formatKeyHint(this.keybindings, SAM_UI_KEYS.confirm)} to edit · ` +
				`${formatKeyHint(this.keybindings, SAM_UI_KEYS.save)} to save to settings · ` +
				`${formatKeyHint(this.keybindings, SAM_UI_KEYS.cancel)} to close`,
		);
		return lines;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (kb.matches(data, SAM_UI_KEYS.up)) {
			this.cursor = (this.cursor + this.rows.length - 1) % this.rows.length;
		} else if (kb.matches(data, SAM_UI_KEYS.down)) {
			this.cursor = (this.cursor + 1) % this.rows.length;
		} else if (kb.matches(data, SAM_UI_KEYS.cancel)) {
			this.closed = true;
			this.onDone({ kind: "cancel" });
		} else if (kb.matches(data, SAM_UI_KEYS.save)) {
			const key = this.rows[this.cursor].key;
			this.closed = true;
			this.onDone({ kind: "persist", key });
		} else if (kb.matches(data, SAM_UI_KEYS.confirm)) {
			const key = this.rows[this.cursor].key;
			this.closed = true;
			this.onDone({ kind: "edit", key });
		}
	}

	/** The mouse wheel (v0.0.49+ — the menu is now hosted as a bottom-anchored
	 * overlay, so pi's alt-screen mouse dispatch reaches us — the same
	 * hosting as `/sam report`). The wheel moves the cursor, clamped at the
	 * ends (the arrow keys keep their wrap); `{handled: true}` consumes the
	 * event, non-wheel passes through. */
	handleMouse(event: { type: string; wheelDelta?: number }): { handled: true } | undefined {
		if (this.closed || event.type !== "wheel") return undefined;
		const delta = event.wheelDelta ?? 0; // pi types wheelDelta as optional
		if (!Number.isFinite(delta) || delta === 0) return undefined;
		this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
		return { handled: true };
	}

	invalidate(): void {
		/* stateless render — nothing cached */
	}
}

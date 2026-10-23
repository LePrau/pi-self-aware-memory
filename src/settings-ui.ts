/**
 * SAM settings UI (v0.0.20, 2026-10-23) — the interactive components behind
 * `/sam depth` (no arg) and `/sam settings`, shown through `ctx.ui.custom`
 * (the editor-swap path — the same surface pi's own /thinking selector uses;
 * pi's interactive-mode.ts custom() swaps the editor, setFocuses the
 * component, and restores the editor on done()).
 *
 * Deliberately NO `@earendil-works/pi-tui` import: the extension runtime
 * resolves that package through pi's virtual-module alias, but the pinned
 * 0.87.1 capture does not ship the package (only 1.3.0 does — measured), so
 * this file is typed against the minimal structural surface the custom
 * factory actually provides: Component = render(width) / handleInput? /
 * invalidate, and KeybindingsManager = matches(data, keyId) / getKeys(keyId).
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

	invalidate(): void {
		/* stateless render — nothing cached */
	}
}

export interface SamSettingsMenuRow {
	key: string;
	label: string;
	valueText: string;
	sourceText: string;
}

export type SamSettingsMenuResult =
	| { kind: "cancel" }
	| { kind: "edit"; key: string }
	| { kind: "persist"; key: string };

/**
 * The `/sam settings` menu — one row per dial: label, effective value
 * (ms dials shown in seconds), and the source layer. Navigate with up/down;
 * confirm = open the value editor for the selected dial (in-session); the
 * save key (pi's configured app.thinking.save) = persist the current
 * in-session value to settings.json (clears the key when it is the default);
 * cancel = close.
 */
export class SamSettingsMenu {
	private keybindings: SamKeybindings;
	private rows: readonly SamSettingsMenuRow[];
	private onDone: (result: SamSettingsMenuResult) => void;
	private cursor = 0;
	private closed = false;

	constructor(
		keybindings: SamKeybindings,
		rows: readonly SamSettingsMenuRow[],
		onDone: (result: SamSettingsMenuResult) => void,
	) {
		this.keybindings = keybindings;
		this.rows = rows;
		this.onDone = onDone;
	}

	render(width: number): string[] {
		void width;
		const lines: string[] = ["  SAM settings — self-aware-memory section of pi's settings.json", ""];
		for (let i = 0; i < this.rows.length; i++) {
			const r = this.rows[i];
			lines.push(`    ${i === this.cursor ? ">" : " "}${r.label}: ${r.valueText}  [${r.sourceText}]`);
		}
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

	invalidate(): void {
		/* stateless render — nothing cached */
	}
}

/**
 * SAM settings (v0.0.20, 2026-10-23 — Paul's wishlist: "add real settings
 * (stored in settings.json) instead of env vars").
 *
 * Storage: the "self-aware-memory" section of pi's GLOBAL settings.json —
 * <agentDir>/settings.json, where agentDir = env PI_CODING_AGENT_DIR else
 * ~/.pi/agent (pi's own getAgentDir resolution, measured on 0.87.1 + 1.3.0).
 * Project scope (.pi/settings.json) is deliberately not read (Paul, 2026-10-23:
 * global only).
 *
 * Precedence, per dial (Paul, 2026-10-23):
 *   in-session (the audit-depth ledger; this module's runtime map for the
 *   rest) > env (if set — the legacy dial wins temporarily) > settings.json
 *   (if the key is present) > built-in default.
 * Persisting a value equal to the built-in default clears the settings key
 * (uniform rule, Paul Q4). A corrupt settings.json is refused, never
 * overwritten (pi's own write discipline).
 *
 * Self-contained: NO pi imports at the module top level. The settings path
 * resolves, in order: the test seam SAM_SETTINGS_PATH (a real file — read AND
 * write, also an operator hook), pi's getAgentDir via dynamic import (pi's
 * extension runtime aliases @earendil-works/pi-coding-agent to itself —
 * virtual-modules — so the import always resolves inside pi and fails
 * harmlessly outside it), env PI_CODING_AGENT_DIR, then ~/.pi/agent.
 * SAM_SETTINGS_JSON (contents seam) is honoured read-only, the same
 * convention as the existing readSettings() in index.ts — no writes.
 *
 * Presentation to the existing dial helpers: the section as an env-like
 * Record<string, string> (stringified, validated at load; bad entries
 * dropped) so each helper keeps its exact parse/clamp discipline and gains
 * one `??` fallback. The `default` registry fields are LAZY arrows — the
 * source module stays the single owner of each constant, and the lazy access
 * keeps the closeaudit/nudge import cycle safe (no binding is read at module
 * evaluation).
 */
import { constants, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SAM_AUDIT_TIMEOUT_DEFAULT_MS } from "./closeaudit.ts";
// Circular-import safety: the modules below import settings.ts (their dial
// helpers call samSectionEnv). Every cross-module default read in this file
// is therefore LAZY (a `default: () => …` arrow), so nothing reads a
// possibly-uninitialized binding at module evaluation. Env keys are kept as
// stable contract literals for the same reason (NUDGE_ENV = "SAM_NUDGE").
import { DEFAULT_REASONING_CALLS, DEFAULT_REASONING_CHARS } from "./nudge.ts";
import { ORPHAN_KEEP_DEFAULT } from "./branchaudit.ts";
import { RETIRE_THRESHOLD_CHARS_DEFAULT } from "./retire.ts";
import { PRESSURE_HEADROOM_TOKENS } from "./governor.ts";

/** The top-level section key in settings.json (Paul, 2026-10-23: rule 5). */
export const SAM_SETTINGS_SECTION = "self-aware-memory";

export type SamDialKind = "enum" | "int" | "onoff";

export interface SamDialDef {
	/** settings.json key (inside the section). */
	key: string;
	/** the legacy env dial this setting replaces/joins. */
	envKey: string;
	kind: SamDialKind;
	/**
	 * The built-in default — LAZY on purpose: the owning module is the single
	 * source, and nothing may read this at module evaluation (import-cycle
	 * safety with closeaudit/nudge).
	 */
	default: () => string | number | boolean;
	/** valid values for kind "enum". */
	enumValues?: readonly string[];
	/** minimum accepted integer (kind "int"; orphan keep allows 0). */
	min?: number;
	menuLabel: string;
	/**
	 * The one-line, plain-language note shown in the settings menu for this
	 * dial (v0.0.22, Paul: "just what each setting changes" — short,
	 * no jargon). Required for every dial.
	 */
	description: string;
	/** stored value is milliseconds — the menu displays seconds. */
	ms?: boolean;
	/** kind "int" only: the value falls back to the shared timeout dial. */
	timeoutFallback?: boolean;
}

/**
 * The v1 dial list (Paul, 2026-10-23, Q2). Excluded on purpose:
 * SAM_NUDGE_COOLDOWN_MS (superseded 2026-10-02 — time is out of the picture)
 * and SAM_AUDIT_TIMEOUT_MAX_MS (an internal clamp constant, not a dial).
 */
export const SAM_DIALS: readonly SamDialDef[] = [
	{ key: "auditDepth", envKey: "SAM_AUDIT_DEPTH", kind: "enum", default: () => "auto", enumValues: ["auto", "light", "medium", "full"], menuLabel: "audit depth", description: "how thoroughly each closed unit is checked" },
	{ key: "calmAuditDepth", envKey: "SAM_AUDIT_CALM_DEPTH", kind: "enum", default: () => "medium", enumValues: ["medium", "full"], menuLabel: "calm-zone audit depth", description: "the depth auto uses while far below the compaction line" },
	{ key: "forkMode", envKey: "SAM_FORK_MODE", kind: "enum", default: () => "sam", enumValues: ["sam", "native"], menuLabel: "branch-audit fork mode", description: "the branch audit's child file — sam: reduced after compaction, native: pi's full fork" },
	{ key: "auditTimeoutMs", envKey: "SAM_AUDIT_TIMEOUT_MS", kind: "int", default: () => SAM_AUDIT_TIMEOUT_DEFAULT_MS, min: 1, ms: true, menuLabel: "audit timeout (shared)", description: "how long an audit may run (the base budget)" },
	{ key: "auditTimeoutMediumMs", envKey: "SAM_AUDIT_TIMEOUT_MEDIUM_MS", kind: "int", default: () => SAM_AUDIT_TIMEOUT_DEFAULT_MS, min: 1, ms: true, timeoutFallback: true, menuLabel: "audit timeout (medium)", description: "how long a medium audit may run (falls back to the shared one)" },
	{ key: "auditTimeoutFullMs", envKey: "SAM_AUDIT_TIMEOUT_FULL_MS", kind: "int", default: () => SAM_AUDIT_TIMEOUT_DEFAULT_MS, min: 1, ms: true, timeoutFallback: true, menuLabel: "audit timeout (full)", description: "how long a full audit may run (falls back to the shared one)" },
	{ key: "retireChars", envKey: "SAM_RETIRE_CHARS", kind: "int", default: () => RETIRE_THRESHOLD_CHARS_DEFAULT, min: 1, menuLabel: "retire-offer threshold (chars)", description: "when you get the offer to retire old closed units" },
	{ key: "pressureHeadroom", envKey: "SAM_PRESSURE_HEADROOM", kind: "int", default: () => PRESSURE_HEADROOM_TOKENS, min: 1, menuLabel: "pressure headroom (tokens)", description: "how close to pi's compaction line counts as under pressure" },
	{ key: "orphanKeep", envKey: "SAM_ORPHAN_KEEP", kind: "int", default: () => ORPHAN_KEEP_DEFAULT, min: 0, menuLabel: "orphan spans kept per fold", description: "how many unfinished work spans the summary keeps at a fold" },
	{ key: "nudge", envKey: "SAM_NUDGE", kind: "onoff", default: () => true, menuLabel: "nudge on context pressure", description: "the mid-session ask to checkpoint work before pressure builds" },
	{ key: "nudgeReasoningChars", envKey: "SAM_NUDGE_REASONING_CHARS", kind: "int", default: () => DEFAULT_REASONING_CHARS, min: 1, menuLabel: "nudge reasoning floor (chars)", description: "how much thinking since the last checkpoint triggers the nudge" },
	{ key: "nudgeReasoningCalls", envKey: "SAM_NUDGE_REASONING_CALLS", kind: "int", default: () => DEFAULT_REASONING_CALLS, min: 1, menuLabel: "nudge reasoning floor (tool calls)", description: "how many tool calls since the last checkpoint trigger the nudge" },
	{ key: "statusLine", envKey: "SAM_STATUS_LINE", kind: "onoff", default: () => true, menuLabel: "context status line", description: "the live context bar under pi's status line" },
];

export type SamDialKey = (typeof SAM_DIALS)[number]["key"];

export type SamDialValue = string | number | boolean;

export type SamSettingsSource = "json-seam" | "file" | "absent" | "unavailable";

interface SamSettingsState {
	/** the section, validated + stringified, keyed by envKey (the helper view). */
	sectionEnv: Record<string, string>;
	source: SamSettingsSource;
	/** the settings.json path for writes — null under the contents seam / unresolved. */
	path: string | null;
	/** in-session runtime overrides (latest-wins; the depth dial lives in the ledger). */
	inSession: Record<string, SamDialValue>;
}

const FRESH_STATE: SamSettingsState = { sectionEnv: {}, source: "unavailable", path: null, inSession: {} };

let state: SamSettingsState = { ...FRESH_STATE, sectionEnv: {}, inSession: {} };

export function dialDef(key: string): SamDialDef | undefined {
	return SAM_DIALS.find((d) => d.key === key);
}

/* ── loading ────────────────────────────────────────────────────────────── */

function stripBom(raw: string): string {
	return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** Validate one raw section value against its dial; undefined = dropped. */
function validateDialValue(def: SamDialDef, raw: unknown): SamDialValue | undefined {
	if (def.kind === "enum") {
		return typeof raw === "string" && (def.enumValues ?? []).includes(raw) ? raw : undefined;
	}
	if (def.kind === "int") {
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < (def.min ?? 1)) return undefined;
		return raw;
	}
	// onoff — booleans in the file; "on"/"off" strings accepted for hand edits
	if (typeof raw === "boolean") return raw;
	if (raw === "on") return true;
	if (raw === "off") return false;
	return undefined;
}

function loadSectionFrom(obj: unknown): void {
	const sectionEnv: Record<string, string> = {};
	let dropped = 0;
	if (obj && typeof obj === "object" && !Array.isArray(obj)) {
		const section = (obj as Record<string, unknown>)[SAM_SETTINGS_SECTION];
		if (section && typeof section === "object" && !Array.isArray(section)) {
			for (const def of SAM_DIALS) {
				const raw = (section as Record<string, unknown>)[def.key];
				if (raw === undefined) continue;
				const v = validateDialValue(def, raw);
				if (v === undefined) {
					dropped++;
					continue;
				}
				// onoff dials present as "on"/"off" — the helper discipline there
				// is "only off is special", so "false" would read as ON.
				sectionEnv[def.envKey] = def.kind === "onoff" ? (v ? "on" : "off") : String(v);
			}
		}
	}
	state.sectionEnv = sectionEnv;
	if (dropped > 0) {
		console.error(`sam: settings: dropped ${dropped} invalid value(s) in the "${SAM_SETTINGS_SECTION}" section (see the dial registry in src/settings.ts)`);
	}
}

async function resolveSettingsPath(): Promise<string | null> {
	const seam = process.env["SAM_SETTINGS_PATH"];
	if (typeof seam === "string" && seam.trim() !== "") return seam.trim();
	// pi's own resolution — guaranteed in the pi runtime by the extension
	// virtual-module alias (@earendil-works/pi-coding-agent → pi itself);
	// fails harmlessly in unit tests / plain node.
	try {
		const mod = (await import(/* @vite-ignore */ "@earendil-works/pi-coding-agent")) as { getAgentDir?: () => string };
		if (typeof mod.getAgentDir === "function") return join(mod.getAgentDir(), "settings.json");
	} catch {
		/* not running inside pi — fall through */
	}
	const agentDir = process.env["PI_CODING_AGENT_DIR"];
	if (typeof agentDir === "string" && agentDir.trim() !== "") return join(agentDir.trim(), "settings.json");
	return join(homedir(), ".pi", "agent", "settings.json");
}

/**
 * Load the settings section once per process. Safe to await at session start
 * (fail-open: any failure leaves an empty section — every dial falls back to
 * the env/default behaviour of v0.0.19).
 */
export async function initSamSettings(): Promise<void> {
	const seam = process.env["SAM_SETTINGS_JSON"];
	if (typeof seam === "string" && seam.trim() !== "") {
		// contents seam — read-only, no writes (the readSettings convention)
		try {
			loadSectionFrom(JSON.parse(seam));
			state = { ...state, source: "json-seam", path: null, sectionEnv: state.sectionEnv };
		} catch {
			state = { ...FRESH_STATE, sectionEnv: {}, inSession: {} };
			console.error("sam: settings override (SAM_SETTINGS_JSON) is not valid JSON — settings disabled for this session");
		}
		return;
	}
	const path = await resolveSettingsPath();
	state.path = path;
	if (!path) {
		state.source = "unavailable";
		state.sectionEnv = {};
		return;
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			state.source = "absent";
			state.sectionEnv = {};
			return;
		}
		state.source = "unavailable";
		state.sectionEnv = {};
		console.error(`sam: settings unreadable at ${path}: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	let obj: unknown;
	try {
		obj = JSON.parse(stripBom(raw));
	} catch {
		state.source = "unavailable";
		state.sectionEnv = {};
		console.error(`sam: settings at ${path} is corrupt JSON — left untouched, all dials on their defaults`);
		return;
	}
	loadSectionFrom(obj);
	state.source = "file";
}

/** Test hook — restore the pristine state (node --test files are separate
 * processes; this is for re-init hygiene inside one file). */
export function resetSamSettingsForTest(): void {
	state = { ...FRESH_STATE, sectionEnv: {}, inSession: {} };
}

/* ── reads ──────────────────────────────────────────────────────────────── */

/** The env-like view the dial helpers add as a `??` fallback. */
export function samSectionEnv(): Record<string, string> {
	return state.sectionEnv;
}

/** The in-session layer in the env-string form (onoff ⇒ "on"/"off"). */
function inSessionEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const def of SAM_DIALS) {
		const v = state.inSession[def.key];
		if (v === undefined) continue;
		out[def.envKey] = def.kind === "onoff" ? (v ? "on" : "off") : String(v);
	}
	return out;
}

/**
 * The effective raw dial value at a decision site (v0.0.21) — rule 1 of the
 * plan note: in-session > env (if set) > settings.json (unset ⇒ undefined ⇒
 * the site's own default discipline). The sites keep their parse discipline
 * unchanged; this only joins the in-session layer that dialStatus already
 * honoured for display.
 */
export function samEffectiveRaw(envKey: string, env: Record<string, string | undefined>): string | undefined {
	return inSessionEnv()[envKey] ?? env[envKey] ?? state.sectionEnv[envKey];
}

export function samSettingsInfo(): { source: SamSettingsSource; path: string | null } {
	return { source: state.source, path: state.path };
}

/** Parse one string value with the dial's exact discipline; undefined =
 * the value is invalid/absent at this layer (fall through). */
function parseDialString(def: SamDialDef, raw: string): SamDialValue | undefined {
	if (def.kind === "enum") {
		return (def.enumValues ?? []).includes(raw) ? raw : undefined;
	}
	if (def.kind === "int") {
		const n = Number(raw);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n < (def.min ?? 1)) return undefined;
		return Math.floor(n);
	}
	// onoff — the house discipline: only "off" is special (nudge/status-line)
	return raw === "off" ? false : true;
}

export type SamDialStatusSource = "in-session" | "env" | "settings" | "default";

export interface SamDialStatus {
	value: SamDialValue;
	source: SamDialStatusSource;
	/** e.g. "shared" — the value fell back to the shared timeout dial. */
	note?: string;
}

/**
 * The effective value + source for the menu (and the non-TUI table). Mirrors
 * the helper precedence exactly: in-session runtime map > env (if set —
 * garbage ⇒ default, as in the helpers) > settings > default.
 */
export function dialStatus(key: string, env: Record<string, string | undefined>): SamDialStatus {
	const def = dialDef(key);
	if (!def) throw new Error(`sam: settings: unknown dial '${key}'`);
	if (state.inSession[key] !== undefined) return { value: state.inSession[key], source: "in-session" };
	const envRaw = env[def.envKey];
	if (envRaw !== undefined) {
		const v = parseDialString(def, envRaw);
		return v === undefined ? { value: def.default(), source: "env" } : { value: v, source: "env" };
	}
	const secRaw = state.sectionEnv[def.envKey];
	if (secRaw !== undefined) {
		const v = parseDialString(def, secRaw);
		return v === undefined ? { value: def.default(), source: "settings" } : { value: v, source: "settings" };
	}
	// per-depth timeouts: absent at every layer ⇒ the shared dial's resolution
	if (def.timeoutFallback) {
		const shared = dialStatus("auditTimeoutMs", env);
		return { value: shared.value, source: shared.source, note: "shared" };
	}
	return { value: def.default(), source: "default" };
}

/* ── in-session overrides (the runtime map; depth rides the ledger) ─────── */

/** Validate one value against its dial; undefined = invalid. */
function validateDialFor(key: string, value: SamDialValue): boolean {
	const def = dialDef(key);
	if (!def) return false;
	if (def.kind === "enum") return typeof value === "string" && (def.enumValues ?? []).includes(value);
	if (def.kind === "int") return typeof value === "number" && Number.isInteger(value) && value >= (def.min ?? 1);
	return typeof value === "boolean";
}

/** Store an in-session override; undefined clears it. */
export function setInSession(key: string, value: SamDialValue | undefined): { ok: boolean; error?: string } {
	const def = dialDef(key);
	if (!def) return { ok: false, error: `unknown settings dial '${key}'` };
	if (value === undefined) {
		delete state.inSession[key];
		return { ok: true };
	}
	if (!validateDialFor(key, value)) return { ok: false, error: `invalid value for '${key}'` };
	state.inSession[key] = value;
	return { ok: true };
}

/* ── persistence (settings.json) ────────────────────────────────────────── */

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function refreshFromDisk(path: string): void {
	try {
		const raw = readFileSync(path, "utf8");
		loadSectionFrom(JSON.parse(stripBom(raw)));
		state.source = "file";
	} catch {
		/* the write just happened — a re-read failure is non-fatal */
	}
}

/**
 * Persist one dial to the settings file (or clear it — value undefined or
 * equal to the built-in default, the uniform rule). Read-modify-write under
 * a lock file (<path>.lock, proper-lockfile style: 10 × 20 ms), atomic
 * temp+rename in the same directory; other top-level keys are preserved; a
 * corrupt file is refused, never overwritten.
 */
export function persistSamSetting(key: string, value: SamDialValue | undefined): { ok: boolean; error?: string } {
	const def = dialDef(key);
	if (!def) return { ok: false, error: `unknown settings dial '${key}'` };
	if (value !== undefined && !validateDialFor(key, value)) {
		return { ok: false, error: `invalid value for '${key}'` };
	}
	const path = state.path;
	if (!path) {
		return { ok: false, error: "no writable settings file (settings loaded via the contents seam or the path is unresolved) — the in-session value is kept" };
	}
	const lockPath = `${path}.lock`;
	let locked = false;
	for (let i = 0; i < 10; i++) {
		try {
			openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
			locked = true;
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				sleepSync(20);
				continue;
			}
			return { ok: false, error: `settings lock failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	if (!locked) return { ok: false, error: "settings lock busy (10 × 20 ms) — try again" };
	try {
		let obj: Record<string, unknown>;
		try {
			const raw = readFileSync(path, "utf8");
			obj = JSON.parse(stripBom(raw)) as Record<string, unknown>;
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("top-level JSON is not an object");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				obj = {};
			} else {
				return { ok: false, error: `settings file unreadable/corrupt — NOT overwritten: ${err instanceof Error ? err.message : String(err)}` };
			}
		}
		const sectionRaw = obj[SAM_SETTINGS_SECTION];
		const section: Record<string, unknown> =
			sectionRaw && typeof sectionRaw === "object" && !Array.isArray(sectionRaw) ? { ...(sectionRaw as Record<string, unknown>) } : {};
		if (value === undefined || value === def.default()) {
			delete section[def.key]; // uniform clear-on-default (Paul, 2026-10-23)
		} else {
			section[def.key] = value;
		}
		if (Object.keys(section).length === 0) delete obj[SAM_SETTINGS_SECTION];
		else obj[SAM_SETTINGS_SECTION] = section;
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
		renameSync(tmp, path);
	} finally {
		try {
			unlinkSync(lockPath);
		} catch {
			/* best-effort release */
		}
	}
	refreshFromDisk(path);
	return { ok: true };
}

/* ── menu presentation ──────────────────────────────────────────────────── */

/** Format a dial value for display — ms dials show seconds (rule 7). */
export function formatDialValue(def: SamDialDef, value: SamDialValue): string {
	if (def.kind === "onoff") return value ? "on" : "off";
	if (def.ms && typeof value === "number") return `${Math.round(value / 1000)} s`;
	return String(value);
}

/**
 * Parse a user-supplied value for a dial (the `/sam settings <dial> <value>`
 * value form, the TUI editor input, tests). ms dials take SECONDS — the
 * display unit — and are stored as ms; "clear"/empty releases the key.
 * Returns `{ value }` (value undefined = release) or `{ error }`.
 */
export function parseSamDialText(def: SamDialDef, text: string): { value: SamDialValue | undefined } | { error: string } {
	const t = text.trim();
	if (t === "" || t === "clear") return { value: undefined };
	if (def.kind === "onoff") {
		if (t === "on" || t === "true" || t === "1") return { value: true };
		if (t === "off" || t === "false" || t === "0") return { value: false };
		return { error: "expected on/off" };
	}
	if (def.kind === "enum") {
		const vals = def.enumValues ?? [];
		if (vals.includes(t)) return { value: t };
		return { error: `expected one of: ${vals.join(" | ")}` };
	}
	const n = Number(t);
	if (!Number.isFinite(n)) return { error: "expected a number" };
	if (def.ms) {
		if (n <= 0) return { error: "expected seconds > 0" };
		return { value: Math.round(n * 1000) };
	}
	if (!Number.isInteger(n) || n < (def.min ?? 0)) return { error: `expected an integer >= ${def.min ?? 0}` };
	return { value: n };
}

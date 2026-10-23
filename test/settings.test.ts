/**
 * Unit tests: SAM settings (v0.0.20, 2026-10-23 — Paul's wish, the WISHLIST
 * settings item). Plan + decisions Q1–Q4:
 *   2026-10-23-sam-settings-feature.md
 *
 * Coverage (the 2026-10-23 test plan):
 *  - load/validate (invalid entries dropped; onoff presented as on/off)
 *  - precedence: in-session > env (if set; garbage ⇒ default) > settings > default
 *  - persist: other top-level keys preserved, no temp-file residue
 *  - clear-on-default (a default value removes the key; an empty section
 *    removes the section; undefined releases the key)
 *  - corrupt file ⇒ defaults, file byte-identical, persist refuses
 *  - the contents seam (SAM_SETTINGS_JSON) is read-only
 *  - the PI_CODING_AGENT_DIR agent-dir fallback
 *  - parseSamDialText (seconds-for-ms entry, clear, rejects)
 *  - the dial helper sites pick up the settings layer
 *  - tui-completions: the settings dial list mirrors the registry
 * Run: node --test "test/*.test.ts"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	initSamSettings,
	resetSamSettingsForTest,
	samSectionEnv,
	samSettingsInfo,
	dialStatus,
	dialDef,
	setInSession,
	persistSamSetting,
	formatDialValue,
	parseSamDialText,
	SAM_DIALS,
} from "../src/settings.ts";
import { auditDepthOf, calmAuditDepthOf, auditTimeoutMs } from "../src/closeaudit.ts";
import { nudgeEnabled, envInt } from "../src/nudge.ts";
import { orphanKeepCount } from "../src/branchaudit.ts";
import { retireThresholdChars } from "../src/retire.ts";
import { pressureHeadroomTokens } from "../src/governor.ts";
import { samStatusLineEnabled } from "../src/tui-status.ts";
import { SAM_SETTINGS_COMPLETIONS } from "../src/tui-completions.ts";

const TMP = mkdtempSync("/tmp/sam-settings-test-");
test.after(() => {
	rmSync(TMP, { recursive: true, force: true });
});

function settingsFile(name: string, obj: unknown): string {
	const p = join(TMP, name);
	writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
	return p;
}

async function initAt(path: string): Promise<void> {
	resetSamSettingsForTest();
	delete process.env.SAM_SETTINGS_JSON;
	process.env.SAM_SETTINGS_PATH = path;
	await initSamSettings();
}

test("load: valid section entries become the env-like layer; invalid ones dropped", async () => {
	const p = settingsFile("load.json", {
		theme: "dark",
		"self-aware-memory": {
			auditDepth: "full",
			nudge: false,
			orphanKeep: 3,
			statusLine: "on",
			auditTimeoutMs: 123456,
			retireChars: "bogus",
			nope: 1, // unknown key — ignored
		},
	});
	await initAt(p);
	assert.equal(samSettingsInfo().source, "file");
	assert.equal(samSettingsInfo().path, p);
	const env = samSectionEnv();
	assert.equal(env.SAM_AUDIT_DEPTH, "full");
	assert.equal(env.SAM_NUDGE, "off"); // a stored `false` reads as OFF
	assert.equal(env.SAM_ORPHAN_KEEP, "3");
	assert.equal(env.SAM_STATUS_LINE, "on");
	assert.equal(env.SAM_AUDIT_TIMEOUT_MS, "123456");
	assert.equal(env.SAM_RETIRE_CHARS, undefined); // "bogus" dropped
	assert.equal(Object.keys(env).length, 5);
});

test("absent file: empty section, source absent, every dial on its default", async () => {
	await initAt(join(TMP, "does-not-exist.json"));
	assert.equal(samSettingsInfo().source, "absent");
	assert.deepEqual(samSectionEnv(), {});
	const st = dialStatus("auditDepth", {});
	assert.equal(st.value, "auto");
	assert.equal(st.source, "default");
});

test("corrupt file: defaults apply, the file stays byte-identical, persist refuses", async () => {
	const p = join(TMP, "corrupt.json");
	writeFileSync(p, "{ not json ");
	await initAt(p);
	assert.equal(samSettingsInfo().source, "unavailable");
	assert.deepEqual(samSectionEnv(), {});
	const before = readFileSync(p, "utf8");
	const r = persistSamSetting("orphanKeep", 4);
	assert.equal(r.ok, false);
	assert.ok(r.error?.includes("NOT overwritten"), `unexpected error: ${r.error}`);
	assert.equal(readFileSync(p, "utf8"), before);
});

test("precedence: in-session > env (if set) > settings > default; env garbage ⇒ default (source env)", async () => {
	await initAt(settingsFile("prec.json", { "self-aware-memory": { auditDepth: "full" } }));
	assert.deepEqual(dialStatus("auditDepth", {}), { value: "full", source: "settings" });
	const envWin = dialStatus("auditDepth", { SAM_AUDIT_DEPTH: "medium" });
	assert.equal(envWin.value, "medium");
	assert.equal(envWin.source, "env");
	const garbage = dialStatus("auditDepth", { SAM_AUDIT_DEPTH: "xx" });
	assert.equal(garbage.value, "auto"); // the helper parse discipline
	assert.equal(garbage.source, "env");
	setInSession("auditDepth", "light");
	const inSess = dialStatus("auditDepth", { SAM_AUDIT_DEPTH: "medium" });
	assert.equal(inSess.value, "light");
	assert.equal(inSess.source, "in-session");
	setInSession("auditDepth", undefined);
	assert.equal(dialStatus("auditDepth", {}).source, "settings"); // back to the layer below
});

test("per-depth timeout falls back to the shared dial with the 'shared' note", async () => {
	await initAt(settingsFile("to.json", { "self-aware-memory": { auditTimeoutMs: 900000 } }));
	const shared = dialStatus("auditTimeoutFullMs", {});
	assert.equal(shared.value, 900000);
	assert.equal(shared.note, "shared");
	const own = dialStatus("auditTimeoutFullMs", { SAM_AUDIT_TIMEOUT_FULL_MS: "420000" });
	assert.equal(own.value, 420000);
	assert.equal(own.source, "env");
});

test("persist: writes the section, preserves other top-level keys, no temp residue", async () => {
	const p = settingsFile("persist.json", {
		theme: "dark",
		model: { provider: "x" },
		"self-aware-memory": { auditDepth: "full" },
	});
	await initAt(p);
	const r = persistSamSetting("orphanKeep", 5);
	assert.equal(r.ok, true);
	const obj = JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
	assert.equal(obj.theme, "dark");
	assert.equal(obj.model.provider, "x");
	assert.equal(obj["self-aware-memory"].auditDepth, "full");
	assert.equal(obj["self-aware-memory"].orphanKeep, 5);
	assert.equal(existsSync(`${p}.${process.pid}.tmp`), false);
	assert.equal(existsSync(`${p}.lock`), false); // the lock is released
});

test("clear-on-default: a default value removes the key; an empty section removes the section", async () => {
	const p = settingsFile("clear.json", { "self-aware-memory": { auditDepth: "full", orphanKeep: 5 } });
	await initAt(p);
	assert.equal(persistSamSetting("auditDepth", "auto").ok, true); // "auto" = the default
	let obj = JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
	assert.equal(obj["self-aware-memory"].auditDepth, undefined);
	assert.equal(obj["self-aware-memory"].orphanKeep, 5);
	assert.equal(persistSamSetting("orphanKeep", 2).ok, true); // 2 = the default
	obj = JSON.parse(readFileSync(p, "utf8"));
	assert.equal(obj["self-aware-memory"], undefined); // the section is gone
	assert.equal(persistSamSetting("auditDepth", undefined).ok, true); // releasing the key is always fine
	obj = JSON.parse(readFileSync(p, "utf8"));
	assert.equal(obj["self-aware-memory"], undefined);
});

test("contents seam (SAM_SETTINGS_JSON): read-only — persist refuses, the in-session value is kept", async () => {
	resetSamSettingsForTest();
	delete process.env.SAM_SETTINGS_PATH;
	process.env.SAM_SETTINGS_JSON = JSON.stringify({ "self-aware-memory": { orphanKeep: 7 } });
	await initSamSettings();
	assert.equal(samSettingsInfo().source, "json-seam");
	assert.equal(samSettingsInfo().path, null);
	assert.equal(dialStatus("orphanKeep", {}).value, 7);
	assert.equal(dialStatus("orphanKeep", {}).source, "settings");
	const r = persistSamSetting("orphanKeep", 9);
	assert.equal(r.ok, false);
	assert.ok(r.error?.includes("no writable settings file"), `unexpected error: ${r.error}`);
	setInSession("orphanKeep", 8);
	assert.equal(dialStatus("orphanKeep", {}).value, 8); // in-session still rides on top
	setInSession("orphanKeep", undefined);
	delete process.env.SAM_SETTINGS_JSON;
});

test("PI_CODING_AGENT_DIR: the agent-dir fallback resolves <dir>/settings.json", async () => {
	resetSamSettingsForTest();
	delete process.env.SAM_SETTINGS_PATH;
	delete process.env.SAM_SETTINGS_JSON;
	const dir = mkdtempSync(join(TMP, "agentdir-"));
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ "self-aware-memory": { statusLine: "off" } }, null, 2)}\n`);
	process.env.PI_CODING_AGENT_DIR = dir;
	await initSamSettings();
	assert.equal(samSettingsInfo().source, "file");
	assert.equal(samSettingsInfo().path, join(dir, "settings.json"));
	assert.equal(dialStatus("statusLine", {}).value, false);
	delete process.env.PI_CODING_AGENT_DIR;
});

test("parseSamDialText: onoff/enum/int, seconds-for-ms, clear, rejects", () => {
	const onoff = dialDef("nudge")!;
	assert.deepEqual(parseSamDialText(onoff, "off"), { value: false });
	assert.deepEqual(parseSamDialText(onoff, "on"), { value: true });
	assert.ok("error" in parseSamDialText(onoff, "maybe"));
	const enumD = dialDef("auditDepth")!;
	assert.deepEqual(parseSamDialText(enumD, "full"), { value: "full" });
	assert.ok("error" in parseSamDialText(enumD, "deep"));
	const msD = dialDef("auditTimeoutMs")!;
	assert.deepEqual(parseSamDialText(msD, "120"), { value: 120000 }); // seconds in, ms out
	assert.ok("error" in parseSamDialText(msD, "0"));
	assert.deepEqual(parseSamDialText(msD, "clear"), { value: undefined });
	const intD = dialDef("orphanKeep")!;
	assert.deepEqual(parseSamDialText(intD, "4"), { value: 4 });
	assert.ok("error" in parseSamDialText(intD, "-1")); // below min (0)
	assert.ok("error" in parseSamDialText(intD, "1.5")); // not an integer
});

test("the dial helper sites pick up the settings layer (env still wins temporarily)", async () => {
	await initAt(
		settingsFile("wiring.json", {
			"self-aware-memory": {
				auditDepth: "full",
				calmAuditDepth: "full",
				auditTimeoutMs: 360000,
				nudge: false,
				orphanKeep: 3,
				retireChars: 55555,
				pressureHeadroom: 12345,
				statusLine: "off",
				nudgeReasoningChars: 4321,
			},
		}),
	);
	assert.equal(auditDepthOf({}), "full");
	assert.equal(auditDepthOf({ SAM_AUDIT_DEPTH: "light" }), "light"); // env still wins
	assert.equal(calmAuditDepthOf({}), "full");
	assert.equal(auditTimeoutMs({}), 360000);
	assert.equal(nudgeEnabled({}), false);
	assert.equal(nudgeEnabled({ SAM_NUDGE: "on" }), true);
	assert.equal(orphanKeepCount({}), 3);
	assert.equal(retireThresholdChars({}), 55555);
	assert.equal(pressureHeadroomTokens({}), 12345);
	assert.equal(samStatusLineEnabled({}), false);
	assert.equal(envInt({}, "SAM_NUDGE_REASONING_CHARS", 1000), 4321);
});

test("the in-session layer wins at the decision sites (v0.0.21: in-session > env > settings > default)", async () => {
	await initAt(
		settingsFile("insess.json", {
			"self-aware-memory": { auditDepth: "full", nudge: false, statusLine: "on" },
		}),
	);
	assert.equal(auditDepthOf({}), "full"); // settings layer
	setInSession("auditDepth", "light");
	assert.equal(auditDepthOf({}), "light"); // in-session beats settings
	assert.equal(auditDepthOf({ SAM_AUDIT_DEPTH: "full" }), "light"); // in-session beats env
	setInSession("nudge", true);
	assert.equal(nudgeEnabled({}), true); // in-session beats settings-off
	assert.equal(nudgeEnabled({ SAM_NUDGE: "off" }), true); // in-session beats env-off
	setInSession("statusLine", false);
	assert.equal(samStatusLineEnabled({}), false); // in-session beats settings-on
	setInSession("auditDepth", undefined);
	assert.equal(auditDepthOf({}), "full"); // released back to the layer below
	setInSession("nudge", undefined);
	assert.equal(nudgeEnabled({}), false);
	setInSession("statusLine", undefined);
	assert.equal(samStatusLineEnabled({}), true);
});

test("formatDialValue: ms dials show seconds, onoff shows on/off", () => {
	assert.equal(formatDialValue(dialDef("auditTimeoutMs")!, 900000), "900 s");
	assert.equal(formatDialValue(dialDef("nudge")!, false), "off");
	assert.equal(formatDialValue(dialDef("orphanKeep")!, 3), "3");
});

test("tui-completions: the settings dial list mirrors the registry", () => {
	const keys = SAM_DIALS.map((d) => d.key);
	assert.deepEqual([...SAM_SETTINGS_COMPLETIONS.map((c) => c.label)].sort(), [...keys].sort());
	for (const c of SAM_SETTINGS_COMPLETIONS) assert.equal(c.value, `settings ${c.label}`);
});

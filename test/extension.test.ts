/**
 * Tests: the pi glue (extensions/self-aware-memory/index.ts) driven by a
 * fake ExtensionAPI + fake ExtensionContext, following the P0 convention.
 * The fake session manager returns pi-shaped session entries; the glue must
 * convert, dispatch, and commit exactly what the pure modules decide.
 *
 * The followUp/steer in-series delivery arms are REMOVED (2026-10-16, Wave A
 * — the SAM_AUDIT_DELIVERY dial is gone; close is the only mode). This suite
 * therefore pins the CLOSE-mode glue: close_unit runs the synchronous
 * close-audit pipeline in-turn (here it fail-opens — the fake ctx has no
 * session file — so the D9 hatch commits UNVERIFIED (audit-failed) and the
 * close stays effective); restored pendingCommits settle at agent_before_settle;
 * the coexistence guard (D2) refuses folds while a foreign folder is active;
 * the empty-stub close gate; `/sam fold <n>` (CORRECTIONS override),
 * `/sam resolve <n>`, `/sam goal`; the session-start commit-proof tombstone
 * (the s5 discard made loud); the registered message_end listener (cache
 * observation); R3 compacted-span tombstones (branch-built verdicts).
 * (The assisted-sweep pins went 2026-10-16 with the mode removal; the
 * end-to-end close-audit matrix with an injectable child runner lives in
 * test/close-audit.test.ts.)
 *
 * Settings seam: `SAM_SETTINGS_JSON` (the glue's production default reads
 * pi's real settings.json via its host package, which does not resolve in
 * the test VM — without the seam the D2 rule takes its documented
 * conservative path: assume a foreign folder, refuse folds).
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env["SAM_SETTINGS_JSON"] = JSON.stringify({ extensions: ["pi-self-aware-memory"] });

import * as fs from "node:fs";

import factory from "../extensions/self-aware-memory/index.ts";
import { auditInstruction, undoAck } from "../src/protocol.ts";
import { EXTENSION_NAME, SAM_VERSION } from "../src/identity.ts";

/* ── fakes ───────────────────────────────────────────────────────────────── */

interface PiEntry {
	id: string;
	type: "message" | "custom" | "context_edit" | "compaction";
	message?: {
		role: string;
		content: unknown;
		timestamp?: number;
		stopReason?: string;
		usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		toolCallId?: string;
		name?: string;
		isError?: boolean;
	};
	customType?: string;
	data?: unknown;
	targetId?: string;
	replacement?: { content: string } | null;
	/** P4 R3 fakes: pi's compaction entry shape (summary + firstKeptEntryId). */
	summary?: string;
	firstKeptEntryId?: string;
}

interface ToolResult { content: { type: string; text: string }[]; details?: unknown }
interface FakeToolDef {
	name: string;
	execute: (toolCallId: string, params: { stub: string }, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
}
interface FakeCommandDef {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

interface FakePi {
	commands: Map<string, FakeCommandDef>;
	tools: Map<string, FakeToolDef>;
	listeners: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
	appended: { customType: string; data?: unknown }[];
	sent: { text: string; options?: { deliverAs?: string } }[];
	notifyCalls: { text: string; type?: string }[];
	branch: PiEntry[];
	getBranchThrows?: boolean;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	isIdle: boolean;
	idlePromise?: Promise<void>;
	ui: boolean;
	mode: "tui" | "rpc" | "json" | "print";
}

function makeFakePi(branch: PiEntry[] = [], over: Partial<FakePi> = {}): FakePi {
	return {
		commands: new Map(),
		tools: new Map(),
		listeners: new Map(),
		appended: [],
		sent: [],
		notifyCalls: [],
		branch,
		isIdle: true,
		ui: true,
		mode: "tui",
		...over,
	};
}

function makeFakeCtx(f: FakePi): Record<string, unknown> {
	return {
		ui: { notify: (text: string, type?: string) => f.notifyCalls.push({ text, type }) },
		mode: f.mode,
		hasUI: f.ui,
		cwd: "/tmp",
		sessionManager: {
			getBranch: () => {
				if (f.getBranchThrows) throw new Error("boom: branch unreadable");
				return f.branch;
			},
			getEntry: (id: string) => f.branch.find((e) => e.id === id) ?? null,
		},
		model: { provider: "openai-completions", id: "test-model" },
		isIdle: () => f.isIdle,
		waitForIdle: () => f.idlePromise ?? Promise.resolve(),
		getContextUsage: () => f.contextUsage,
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => f.sent.push({ text, options }),
	};
}

function makeApi(f: FakePi) {
	return {
		registerCommand: (name: string, def: FakeCommandDef) => f.commands.set(name, def),
		registerTool: (def: FakeToolDef) => f.tools.set(def.name, def),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = f.listeners.get(event) ?? [];
			list.push(handler);
			f.listeners.set(event, list);
		},
		appendEntry: (customType: string, data?: unknown) => {
			f.appended.push({ customType, data });
			f.branch.push({ id: nextId(), type: "custom", customType, data });
		},
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => {
			f.sent.push({ text, options });
			f.isIdle = false;
		},
	};
}

let seq = 0;
const nextId = () => `e${++seq}`;
function msg(role: string, content: unknown, extra: Record<string, unknown> = {}): PiEntry {
	return { id: nextId(), type: "message", message: { role, content, timestamp: Date.now(), ...extra } };
}
function sam(data: unknown): PiEntry {
	return { id: nextId(), type: "custom", customType: "sam", data };
}

/** factory + session_start on the fake (resets the module state from the branch). */
async function load(pi: FakePi, ctx: Record<string, unknown>): Promise<void> {
	factory(makeApi(pi) as never);
	const starts = pi.listeners.get("session_start") ?? [];
	assert.equal(starts.length, 1, "exactly one session_start listener");
	await starts[0]({ reason: "startup" }, ctx);
}

async function command(pi: FakePi, ctx: Record<string, unknown>, args: string): Promise<void> {
	const c = pi.commands.get("sam");
	assert.ok(c, "the /sam command must be registered");
	await c.handler(args, ctx);
}

async function closeUnit(pi: FakePi, ctx: Record<string, unknown>, stub: string, toolCallId = "tc1") {
	const tool = pi.tools.get("close_unit");
	assert.ok(tool, "the close_unit tool must be registered");
	const result = await tool.execute(toolCallId, { stub }, new AbortController().signal, undefined, ctx);
	pi.branch.push(
		msg("toolResult", (result.content[0] as { text: string }).text, { toolCallId, toolName: "close_unit", isError: false }),
	);
	return result;
}

function settle(pi: FakePi, ctx: Record<string, unknown>): unknown {
	const settles = pi.listeners.get("agent_before_settle") ?? [];
	assert.equal(settles.length, 1, "exactly one agent_before_settle listener");
	return settles[0]({ turn: 1 }, ctx);
}

function withSettings(json: string): () => void {
	const prev = process.env["SAM_SETTINGS_JSON"];
	process.env["SAM_SETTINGS_JSON"] = json;
	return () => {
		if (prev === undefined) delete process.env["SAM_SETTINGS_JSON"];
		else process.env["SAM_SETTINGS_JSON"] = prev;
	};
}

function withEnv(name: string, value: string): () => void {
	const prev = process.env[name];
	process.env[name] = value;
	return () => {
		if (prev === undefined) delete process.env[name];
		else process.env[name] = prev;
	};
}

/* ── identity (the header contract: identity.ts must match package.json) ── */

test("identity: SAM_VERSION matches package.json (the 0.0.3 bump left identity.ts at 0.0.2 — caught 2026-10-14; this pin closes the drift class)", () => {
	const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
	assert.equal(SAM_VERSION, pkg.version, "identity.ts SAM_VERSION must match package.json version");
});

/* ── registration surface ─────────────────────────────────────────────────── */

test("registers /sam + sam-prepare-audit (the internal prepare-child entry, 2026-10-16), close_unit + sam_retrieve (P5) + the goal/retire/fold tools, session_start, agent_before_settle, message_end, session_before_compact (P5), input (D11b) — nothing else", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	assert.equal(pi.commands.size, 2);
	assert.ok(pi.commands.has("sam"));
	assert.ok(pi.commands.has("sam-prepare-audit"), "the internal prepare-child entry (the user-facing /sam audit is REMOVED 2026-10-16 — Paul: the user does not trigger audits)");
	assert.equal(pi.tools.size, 7); // THE SINGLE SURFACE since 2026-10-16 (the SAM_AUDIT_DELIVERY dial is REMOVED — the byte-stable v3 2-tool followUp surface is gone with it)
	assert.ok(pi.tools.has("close_unit"));
	assert.ok(pi.tools.has("sam_retrieve"));
	assert.ok(pi.tools.has("adjust_goal"));
	assert.ok(pi.tools.has("read_goal"));
	assert.ok(pi.tools.has("retire_units"));
	assert.ok(pi.tools.has("unretire"));
	assert.ok(pi.tools.has("fold_now"));
	assert.deepEqual(
		[...pi.listeners.keys()].sort(),
		["agent_before_settle", "input", "message_end", "session_before_compact", "session_compact", "session_compact_failed", "session_start"], // +P5 takeover hook + D11b goal-offer arm (the input event) + v0.0.4 FOLD ack listeners (the sam-fold-ack channel)
	);
});

test("the REMOVED SAM_AUDIT_DELIVERY dial is a no-op: a legacy value (followUp) still yields the 7-tool close surface (the env is tolerated, never read)", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "followUp");
	try {
		const pi = makeFakePi();
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		assert.equal(pi.tools.size, 7);
		assert.ok(pi.tools.has("close_unit"));
		assert.ok(pi.tools.has("adjust_goal"));
		assert.ok(pi.tools.has("read_goal"));
		assert.ok(pi.tools.has("sam_retrieve"));
		assert.ok(pi.tools.has("retire_units"));
		assert.ok(pi.tools.has("unretire"));
		assert.ok(pi.tools.has("fold_now"));
	} finally {
		restore();
	}
});

test("session start announces build + mode + counts, once, in the ui", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	assert.equal(pi.notifyCalls.length, 1);
	const text = pi.notifyCalls[0].text;
	assert.match(text, new RegExp(`${EXTENSION_NAME} ${SAM_VERSION} loaded`));
	assert.match(text, /folded 0/);
	assert.equal(pi.notifyCalls[0].type, "info");
});

test("session start with a malformed ledger entry: announced, still clean", async () => {
	const u = msg("user", "do X");
	const a = msg("assistant", "working");
	const pi = makeFakePi([
		sam("garbage"),
		u,
		a,
		sam({ v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "tc", ts: 1, mode: "manual" }),
		msg("toolResult", "ok", { toolCallId: "tc", toolName: "close_unit", isError: false }),
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const text = pi.notifyCalls[0].text;
	assert.match(text, /1 malformed ledger record\(s\) skipped/);
	assert.match(text, /in flight 1/);
});

test("session start fail-open: a failing branch getter resets state and reports the error", async () => {
	const pi = makeFakePi([], { getBranchThrows: true });
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const err = pi.notifyCalls.find((c) => c.type === "error");
	assert.ok(err, "the error must surface");
	assert.match(err!.text, /load error/);
});

/* ── P3: session-start commit proof (the s5 discard, made loud) ───────────── */

test("session start: a folded unit whose stub edit is missing gets a foldLost tombstone (the s5 case)", async () => {
	const u = msg("user", "task " + "x".repeat(60));
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "did work", toolCallId: "t", ts: 1, mode: "manual" }),
		sam({
			v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id,
			stub: "did work", verdict: "VERIFIED", beforeTokens: 500, ts: 2, mode: "manual",
		}),
		// the fold batch (stub edit + null edits) never landed — pi discarded it:
		msg("user", "later task"),
		msg("assistant", "working on the later task"),
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const tombstones = pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "foldLost");
	assert.equal(tombstones.length, 1, "exactly one foldLost tombstone on this load");
	assert.equal((tombstones[0].data as { unitId: number }).unitId, 1);
	// the announce tells the truth: the unit is RESOLVED (tombstoned), not folded
	assert.match(pi.notifyCalls[0].text, /folded 0/);
	assert.match(pi.notifyCalls[0].text, /resolved 1/);
});

test("session start: a landed fold is NOT tombstoned (the proof holds)", async () => {
	const u = msg("user", "task " + "x".repeat(60));
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "did work", toolCallId: "t", ts: 1, mode: "manual" }),
		sam({
			v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id,
			stub: "did work", verdict: "VERIFIED", beforeTokens: 500, ts: 2, mode: "manual",
		}),
		{ id: nextId(), type: "context_edit", targetId: u.id, replacement: { content: "[Unit 1 ✓] did work" } },
		msg("user", "later task"),
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	assert.equal(pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "foldLost").length, 0);
});

/* ── P3: D2 coexistence ───────────────────────────────────────────────────── */

test("D2: a folding folder in the settings announces a warning and refuses folds", async () => {
	const restore = withSettings(JSON.stringify({ extensions: ["observational-memory/om-compact.ts", "pi-self-aware-memory"] }));
	try {
		const u = msg("user", "task " + "x".repeat(60));
		const pi = makeFakePi([
			u,
			sam({ v: 1, kind: "close", unitId: 1, stub: "did it", toolCallId: "t", ts: 1, mode: "manual" }),
			msg("toolResult", "ok", { toolCallId: "t", toolName: "close_unit", isError: false }),
			msg("user", auditInstruction(1)),
			msg("assistant", "VERIFIED"),
		], { contextUsage: { tokens: 5000, contextWindow: 32768, percent: 15 } });
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		const warn = pi.notifyCalls.find((c) => c.type === "error");
		assert.ok(warn, "the D2 posture must be visible at load");
		assert.match(warn!.text, /foreign folding folder/);
		assert.match(warn!.text, /D2/);
		// the restored verdict (pendingCommits at load) wants a fold; D2 refuses (noFold coexistence):
		const out = await (settle(pi, ctx) as Promise<{ entries: PiEntry[] }>); // the (refused) commit
		const entries = (out as { entries: PiEntry[] }).entries;
		const rec = entries.find((e) => e.type === "custom") as PiEntry;
		const data = rec.data as { kind: string; reason: string };
		assert.equal(data.kind, "noFold");
		assert.match(data.reason, /^coexistence/);
		assert.equal(entries.filter((e) => e.type === "context_edit").length, 0, "no context edits ship while D2 holds");
	} finally {
		restore();
	}
});

/* ── P3: empty-stub close gate ────────────────────────────────────────────── */

test("close_unit: an EMPTY stub over demonstrable work is refused with an actionable reason (anti-self-sealing)", async () => {
	const pi = makeFakePi([
		msg("user", "read the config"),
		msg("assistant", "reading…"),
		msg("toolResult", "file content: 12 lines", { toolCallId: "c1", toolName: "read", isError: false }),
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const result = await closeUnit(pi, ctx, "   ");
	const text = (result.content[0] as { text: string }).text;
	assert.match(text, /close_unit refused/);
	assert.match(text, /empty stub over demonstrable work/);
	assert.match(text, /Call close_unit again with a real stub/);
	assert.equal(pi.appended.length, 0, "no close record — the model gets one actionable refusal, not a silent noFold");
});

/* ── close_unit tool (P2 surface, P3-gated) ───────────────────────────────── */

test("close_unit: success appends the close record and reports the unit id (the close-audit pipeline runs in-turn — here it fail-opens: the fake ctx has no session file, so the D9 hatch commits UNVERIFIED (audit-failed) and the close stays effective)", async () => {
	const pi = makeFakePi([msg("user", "write data.txt")]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const result = await closeUnit(pi, ctx, "wrote data.txt");
	const text = result.content[0].text as string;
	assert.match(text, /^Unit 1 closed/);
	assert.match(text, /audit UNVERIFIED \(audit-failed: no session file visible — nothing forked; prepare-spawn-failed\)/);
	// close record + the weak settlement + the resolve terminal (the D9 hatch),
	// plus the D7 goal nudge record when the nudge family is on (SAM_NUDGE=off
	// shape: no nudge record — the count adapts):
	const nudgeSent = pi.sent.some((s) => s.text.includes("[sam-nudge]"));
	assert.equal(pi.appended.length, 3 + (nudgeSent ? 1 : 0));
	assert.equal(pi.appended[0].customType, "sam");
	const data = pi.appended[0].data as { kind: string; unitId: number; stub: string; evidence?: unknown };
	assert.equal(data.kind, "close");
	assert.equal(data.unitId, 1);
	assert.equal(data.stub, "wrote data.txt");
	assert.equal(data.evidence !== undefined, true, "P3: the close record carries the deterministic unit floor");
	const samAppends = pi.appended.filter((a) => a.customType === "sam");
	assert.deepEqual(samAppends.map((a) => (a.data as { kind?: string }).kind), ["close", "settlement", "resolve"]);
	const set = samAppends[1].data as { kind: string; verdict: string };
	assert.equal(set.kind, "settlement");
	assert.equal(set.verdict, "UNVERIFIED-AUDIT-FAILED");
	assert.equal(samAppends[2].data.kind, "resolve");
});

test("close_unit: no real user message → rejected, nothing appended", async () => {
	const pi = makeFakePi([msg("user", "[sam-audit] Unit 9 ..."), msg("assistant", "VERIFIED")]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const result = await closeUnit(pi, ctx, "stub");
	assert.match(result.content[0].text as string, /Nothing to close/);
	assert.equal(pi.appended.length, 0);
});

test("close_unit: last real user message already folded → already-closed, nothing appended", async () => {
	const u = msg("user", "task");
	const tr = msg("toolResult", "ok", { toolCallId: "tc1", toolName: "close_unit", isError: false });
	const pi = makeFakePi([
		u,
		tr,
		sam({ v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id, tr.id], spanFirstId: u.id, spanLastId: tr.id, stub: "s", verdict: "VERIFIED", ts: 2, mode: "manual" }),
		{ id: nextId(), type: "context_edit", targetId: u.id, replacement: { content: "[Unit 1 ✓] s" } },
		{ id: nextId(), type: "context_edit", targetId: tr.id, replacement: null },
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const result = await closeUnit(pi, ctx, "another stub", "tc2");
	assert.match(result.content[0].text as string, /already closed/i);
	assert.equal(pi.appended.length, 0);
});

test("close_unit: internal failure is a fail-open error result, nothing appended", async () => {
	const pi = makeFakePi([msg("user", "task")], { getBranchThrows: true });
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx); // load also threw internally and recovered
	const result = await closeUnit(pi, ctx, "stub");
	assert.match(result.content[0].text as string, /close_unit failed/);
	assert.equal(pi.appended.length, 0);
});

/* ── settlement dispatch ──────────────────────────────────────────────────── */

test("close_unit: the close-audit pipeline runs in-turn (v4 close mode — the only mode since 2026-10-16): here it fail-opens (the fake ctx has no session file) ⇒ the D9 hatch commits UNVERIFIED (audit-failed), the close stays effective, and NOTHING is queued in-series (the main line never carries audit text)", async () => {
	const u = msg("user", "write data.txt");
	const a = msg("assistant", "working");
	const pi = makeFakePi([u, a]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const result = await closeUnit(pi, ctx, "wrote data.txt");
	const text = result.content[0].text as string;
	assert.match(text, /^Unit 1 closed/);
	assert.match(text, /audit UNVERIFIED \(audit-failed: no session file visible — nothing forked; prepare-spawn-failed\)/);
	// the main line never carries AUDIT text (v4 core invariant) — the only send
	// that may exist is the D7 goal nudge (the retained nudge channel, deliverAs
	// steer; absent in the SAM_NUDGE=off shape):
	assert.equal(pi.sent.filter((s) => s.text.includes("[sam-audit]")).length, 0, "no in-series audit send");
	const nudgeSent = pi.sent.some((s) => s.text.includes("[sam-nudge]"));
	assert.equal(pi.sent.length, nudgeSent ? 1 : 0, "at most the D7 goal nudge — never an audit send");
	// the D9 hatch: the weak settlement + the resolve terminal ride with the close record
	const kinds = pi.appended.filter((a) => a.customType === "sam").map((a) => (a.data as { kind?: string }).kind);
	assert.deepEqual(kinds, ["close", "settlement", "resolve"]);
	const set = pi.appended.filter((a) => a.customType === "sam")[1].data as { kind: string; verdict: string };
	assert.equal(set.kind, "settlement");
	assert.equal(set.verdict, "UNVERIFIED-AUDIT-FAILED");
	// and the settle has nothing pending: the unit is (weakly) settled, nothing folds
	assert.equal(await (settle(pi, ctx) as Promise<unknown>), undefined);
	assert.equal(pi.branch.filter((e) => e.type === "context_edit").length, 0, "nothing is folded");
	// (the in-series followUp queue + the steer arms are REMOVED — the synchronous
	//  close-audit matrix with an injectable child runner lives in test/close-audit.test.ts)
});
test("settle: a CORRECTIONS verdict restored from the ledger (pendingCommits) → noFold record, no context edits", async () => {
	const u = msg("user", "task " + "x".repeat(60));
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "did it (claims 3 lines)", toolCallId: "t", ts: 1, mode: "manual" }),
		msg("toolResult", "ok", { toolCallId: "t", toolName: "close_unit", isError: false }),
		msg("user", auditInstruction(1)),
		msg("assistant", "CORRECTIONS: the file has 5 lines, not 3"),
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const out = await (settle(pi, ctx) as Promise<{ entries: PiEntry[] }>);
	const entries = out.entries;
	assert.equal(entries.length, 1);
	assert.equal(entries[0].type, "custom");
	const data = entries[0].data as { kind: string; verdict: string; reason: string; corrections: string };
	assert.equal(data.kind, "noFold");
	assert.equal(data.verdict, "CORRECTIONS");
	assert.equal(data.reason, "verdict CORRECTIONS");
	assert.equal(data.corrections, "the file has 5 lines, not 3");
});

/* ── P3: /sam fold <n> (override) ─────────────────────────────────────────── */

test("/sam fold <n>: a CORRECTIONS unit folds with the override flag (user intent, gates still bind)", async () => {
	const u = msg("user", "wrote the config file with all three sections " + "x".repeat(120));
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "wrote the config sections", toolCallId: "t", ts: 1, mode: "manual" }),
		sam({
			v: 1, kind: "noFold", unitId: 1,
			entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id,
			stub: "wrote the config sections",
			verdict: "CORRECTIONS", corrections: "there are four sections, not three",
			reason: "verdict CORRECTIONS", ts: 2, mode: "manual",
		}),
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	pi.sent.length = 0;
	await command(pi, ctx, "fold 1");
	assert.equal(pi.sent.length, 1, "the fold rides one short ack turn (the boundary needs a settle, P2 undo discipline)");
	assert.match(pi.sent[0].text, /\[sam-internal\] fold of unit 1 \(user override\)/);
	const out = await (settle(pi, ctx) as Promise<{ entries: PiEntry[] }>);
	const entries = out.entries;
	const edits = entries.filter((e) => e.type === "context_edit");
	assert.equal(edits.length, 1);
	assert.match((edits[0].replacement as { content: string }).content, /\[Unit 1 ✓\] wrote the config sections \[CORRECTIONS: there are four sections, not three\]/);
	const rec = entries.find((e) => e.type === "custom") as PiEntry;
	const data = rec.data as { kind: string; override?: boolean; corrections?: string };
	assert.equal(data.kind, "fold");
	assert.equal(data.override, true, "the override is recorded (the user knowingly overrode the audit)");
	assert.equal(data.corrections, "there are four sections, not three");
});

test("/sam fold <n>: unknown id and missing id are honest errors, nothing queued", async () => {
	const pi = makeFakePi([msg("user", "task")]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "fold");
	assert.match(pi.notifyCalls[pi.notifyCalls.length - 1].text, /usage — \/sam fold <unit-id>/);
	await command(pi, ctx, "fold 7");
	assert.match(pi.notifyCalls[pi.notifyCalls.length - 1].text, /no unit 7/);
	assert.equal(pi.sent.length, 0, "nothing went to the session");
});

/* ── P3: /sam resolve <n> ─────────────────────────────────────────────────── */

test("/sam resolve <n>: positive resolution evidence, recorded durably", async () => {
	const u = msg("user", "task " + "x".repeat(60));
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "t", ts: 1, mode: "display" }),
		sam({ v: 1, kind: "noFold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "s", verdict: "VERIFIED", reason: "display mode", ts: 2, mode: "display" }),
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "resolve 1");
	assert.equal(pi.appended.length, 1);
	const data = pi.appended[0].data as { kind: string; unitId: number; basis: string };
	assert.equal(data.kind, "resolve");
	assert.equal(data.unitId, 1);
	assert.equal(data.basis, "user-resolved");
	assert.match(pi.notifyCalls[pi.notifyCalls.length - 1].text, /unit 1 resolved/);
});

/* ── P2 flows kept (undo, statuses, fail-open) ───────────────────────────── */

test("settle: no pending work → undefined", async () => {
	const pi = makeFakePi([msg("user", "hello")]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	assert.equal(await (settle(pi, ctx) as Promise<unknown>), undefined);
});

test("settle fail-open: a failing branch getter returns undefined (session continues)", async () => {
	const pi = makeFakePi([msg("user", "hello")], { getBranchThrows: true });
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	await closeUnit(pi, ctx, "stub");
	assert.equal(await (settle(pi, ctx) as Promise<unknown>), undefined);
});

test("/sam with no args renders the status block", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "");
	assert.equal(pi.notifyCalls.length, 1);
	const lines = pi.notifyCalls[0].text.split("\n");
	assert.match(lines[0], new RegExp(`── sam ── ${EXTENSION_NAME} ${SAM_VERSION} ──`));
	assert.match(lines[1], /^model: /);
});

test("/sam no args: the context bar line right after the context line (v0.0.15)", async () => {
	const pi = makeFakePi([msg("user", "hi")], { contextUsage: { tokens: 8000, contextWindow: 20000, percent: 40 } });
	const ctx = makeFakeCtx(pi);
	(ctx as Record<string, unknown>).getSystemPrompt = () => "x".repeat(4000); // 1000 tokens ⇒ 2 bar chars
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "");
	assert.equal(pi.notifyCalls.length, 1);
	const lines = pi.notifyCalls[0].text.split("\n");
	const ctxLine = lines.findIndex((l) => l.startsWith("context: "));
	assert.ok(ctxLine >= 0);
	// O = 2 ("OO"), no goal/stack, x = (8000−1000)/500 = 14 chars at indices 2..15; the | at
	// round((20000−16384)×40/20000) = 7 REPLACES the x at index 7 (D6) ⇒ 13 visible x's;
	// tokens 8000 ≥ W−R ⇒ action zone ⇒ light (2026-10-17 tier: watch/action are light, full is
	// no longer auto-reached)
	assert.equal(lines[ctxLine + 1], "SAM [" + "OO" + "xxxxx" + "|" + "xxxxxxxx" + " ".repeat(24) + "] audit: light");
});

test("/sam report renders the ledger", async () => {
	const u = msg("user", "task " + "x".repeat(40));
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "did it", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "did it", verdict: "VERIFIED", beforeTokens: 100, ts: 2, mode: "manual" }),
		{ id: nextId(), type: "context_edit", targetId: u.id, replacement: { content: "[Unit 1 ✓] did it" } },
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "report");
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /unit 1: folded · pre-fold 100 tokens \(pi estimate\)/);
});

test("/sam unknown subcommand: error naming it", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "teleport");
	assert.equal(pi.notifyCalls.length, 1);
	assert.equal(pi.notifyCalls[0].type, "error");
	assert.match(pi.notifyCalls[0].text, /unknown subcommand 'teleport'/);
});

test("/sam undo with nothing folded: says so", async () => {
	const pi = makeFakePi([msg("user", "hello")]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "undo");
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /nothing to undo/);
	assert.equal(pi.sent.length, 0);
});

test("/sam undo: queues the ack turn, awaits it, and the settle commits the undo drafts + record", async () => {
	const u = msg("user", "task");
	const a = msg("assistant", "working");
	const tr = msg("toolResult", "ok", { toolCallId: "tc1", toolName: "close_unit", isError: false });
	const pi = makeFakePi([
		u, a, tr,
		sam({ v: 1, kind: "close", unitId: 1, stub: "did it", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id, a.id, tr.id], spanFirstId: u.id, spanLastId: tr.id, stub: "did it", verdict: "VERIFIED", beforeTokens: 999, ts: 2, mode: "manual" }),
		{ id: nextId(), type: "context_edit", targetId: u.id, replacement: { content: "[Unit 1 ✓] did it" } },
		{ id: nextId(), type: "context_edit", targetId: a.id, replacement: null },
		{ id: nextId(), type: "context_edit", targetId: tr.id, replacement: null },
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	pi.sent.length = 0;
	const commandPromise = command(pi, ctx, "undo");
	assert.equal(pi.sent.length, 1, "the ack turn was started before the wait");
	assert.equal(pi.sent[0].text, undoAck(1));
	assert.equal(pi.isIdle, false, "the nested run is active while the command waits");
	await commandPromise;
	pi.notifyCalls.length = 0;
	const out = await (settle(pi, ctx) as Promise<{ entries: PiEntry[] }>);
	const entries = out.entries;
	const edits = entries.filter((e) => e.type === "context_edit");
	assert.equal(edits.length, 3, "all span entries restored");
	for (const e of edits) assert.ok(e.replacement !== null, "undo restores the original content");
	const undoRec = entries.find((e) => e.type === "custom") as PiEntry;
	assert.equal((undoRec.data as { kind: string; unitId: number }).kind, "undo");
	assert.deepEqual((undoRec.data as { targets: string[] }).targets, [u.id, a.id, tr.id]);
});

test("/sam undo: second undo in flight is rejected", async () => {
	const u = msg("user", "task");
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "s", verdict: "VERIFIED", ts: 2, mode: "manual" }),
		{ id: nextId(), type: "context_edit", targetId: u.id, replacement: { content: "[Unit 1 ✓] s" } },
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const commandPromiseA = command(pi, ctx, "undo");
	await commandPromiseA;
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "undo");
	assert.equal(pi.notifyCalls.length, 1);
	assert.equal(pi.notifyCalls[0].type, "error");
	assert.match(pi.notifyCalls[0].text, /already in flight/);
});

test("command handler fail-open: a throwing branch getter reports, never throws", async () => {
	const u = msg("user", "task " + "x".repeat(40));
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "s", verdict: "VERIFIED", ts: 2, mode: "manual" }),
		{ id: nextId(), type: "context_edit", targetId: u.id, replacement: { content: "[Unit 1 ✓] s" } },
	]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.getBranchThrows = true;
	pi.notifyCalls.length = 0;
	await assert.doesNotReject(() => command(pi, ctx, "undo"));
	assert.ok(pi.notifyCalls.find((c) => c.type === "error"), "the error must surface");
});

/* ── message_end observation (cache ledger) ──────────────────────────────── */

test("message_end: assistant usages are observed; the observed rebuild is visible in the status (cache ledger input)", async () => {
	const pi = makeFakePi([msg("user", "task")]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const ends = pi.listeners.get("message_end") ?? [];
	assert.equal(ends.length, 1, "exactly one message_end listener");
	// two requests with uncached prompt mass above the rebuild threshold:
	ends[0]({ message: { role: "assistant", usage: { totalTokens: 25000, input: 20000, cacheRead: 0, cacheWrite: 5000 } } }, ctx);
	ends[0]({ message: { role: "assistant", usage: { totalTokens: 25000, input: 20000, cacheRead: 0, cacheWrite: 5000 } } }, ctx);
	ends[0]({ message: { role: "user", content: "hello" } }, ctx); // non-assistant: ignored
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "");
	const status = pi.notifyCalls[pi.notifyCalls.length - 1].text;
	assert.match(status, /cache: 1 rebuild\(s\) \(0 ours · 0 idle · 1 foreign\)/, "the observed rebuild is counted and rendered (P4 reads this for commit timing)");
});


/* ── P4 R3: compacted spans — the compaction-owned terminal (DEFAULT since the 2026-09-30 H1 promotion; `refuse` = explicit opt-out) ────── */

/**
 * The 2026-09-30 live bank's geometry (measured, session 01a0f294),
 * branch-built for the close-mode suite: close + toolResult + the audit turn +
 * the compaction covering the span, with firstKeptEntryId pointed at the audit
 * reply (which lands AFTER the compaction, the live bank's order). The verdict
 * is on the branch at load, so the ledger restores it as pendingCommits —
 * settle must tombstone it (compaction-owned), never fold it.
 */
async function compactedFixture(spanText: string, stub: string, over: Partial<FakePi> = {}) {
	const u = msg("user", spanText);
	const a = msg("assistant", "working");
	const reply = msg("assistant", "VERIFIED");
	const pi = makeFakePi(
		[
			u,
			a,
			sam({ v: 1, kind: "close", unitId: 1, stub, toolCallId: "tc1", ts: 1, mode: "manual" }),
			msg("toolResult", "ok", { toolCallId: "tc1", toolName: "close_unit", isError: false }),
			msg("user", auditInstruction(1)),
			{ id: "cmp0", type: "compaction", summary: "compacted prefix", firstKeptEntryId: reply.id },
			reply,
		],
		over.contextUsage
			? over
			: { ...over, contextUsage: { tokens: 40_000, contextWindow: 131_072, percent: 30 } },
	);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	return { pi, ctx };
}

function settledEntries(out: unknown): { type?: string; data?: { kind?: string; reason?: string; basis?: string } }[] {
	assert.ok(out && typeof out === "object" && "entries" in (out as object), "the audit settle must commit");
	return (out as { entries: unknown[] }).entries as { type?: string; data?: { kind?: string; reason?: string; basis?: string } }[];
}

test("R3 default (tombstone since the 2026-09-30 H1 promotion): unset dial ⇒ compaction-owned resolved, ceiling arithmetic kept, ZERO edits", async () => {
	const restore = withEnv("SAM_COMPACTED_SPAN", ""); // unset ⇒ default tombstone (promoted 2026-09-30, H1 6/6; before that the pin below's shape was the default)
	try {
		const { pi, ctx } = await compactedFixture("marathon task " + "w".repeat(140_000), "did the marathon work");
		const entries = settledEntries(await settle(pi, ctx));
		assert.equal(entries.filter((e) => e.type === "context_edit").length, 0, "no fold — a compacted span is never folded (default policy)");
		const kinds = entries.map((e) => e.data?.kind).filter((k) => k !== undefined);
		assert.deepEqual(kinds, ["noFold", "resolve"], "the ceiling arithmetic lands as evidence, the tombstone terminals");
		const resolve = entries.find((e) => e.data?.kind === "resolve")?.data;
		assert.equal(resolve?.basis, "compaction-owned");
	} finally {
		restore();
	}
});

test("R3 tombstone (= the only policy since 2026-10-16, the SAM_COMPACTED_SPAN dial removed): same span ⇒ resolved (compaction-owned), ceiling arithmetic kept as evidence, ZERO edits", async () => {
	const restore = withEnv("SAM_COMPACTED_SPAN", "tombstone");
	try {
		const { pi, ctx } = await compactedFixture("marathon task " + "w".repeat(140_000), "did the marathon work");
		const entries = settledEntries(await settle(pi, ctx));
		assert.equal(entries.filter((e) => e.type === "context_edit").length, 0, "context_edits zero — folding a compacted span would only rewrite preserved bytes");
		const kinds = entries.map((e) => e.data?.kind).filter((k) => k !== undefined);
		assert.deepEqual(kinds, ["noFold", "resolve"], "evidence (the ceiling arithmetic) lands first, the tombstone terminals");
		const noFold = entries.find((e) => e.data?.kind === "noFold");
		assert.equal(noFold?.data?.reason, "ceiling", "the gate's arithmetic is preserved on record");
		const resolve = entries.find((e) => e.data?.kind === "resolve")?.data;
		assert.equal(resolve?.basis, "compaction-owned");
		// the R3 invariants on the record itself: stub + entry ids preserved
		const data = resolve as unknown as { stub?: string; entryIds?: string[] };
		assert.equal(data.stub, "did the marathon work");
		assert.ok(Array.isArray(data.entryIds) && data.entryIds.length >= 2, "the span entry ids ride with the tombstone");
	} finally {
		restore();
	}
});

test("R3 tombstone, gate-passing span: still NEVER folded (zero edits) — the policy precedes the fold", async () => {
	const restore = withEnv("SAM_COMPACTED_SPAN", "tombstone");
	try {
		// a small span that would pass every gate (fake window unknown ⇒
		// fail-open) — the only variable is the compaction coverage.
		const { pi, ctx } = await compactedFixture("small task ".repeat(60), "small stub");
		const entries = settledEntries(await settle(pi, ctx));
		assert.equal(entries.filter((e) => e.type === "context_edit").length, 0, "ZERO context_edits — a compacted span is never folded, even when the gates pass");
		const kinds = entries.map((e) => e.data?.kind).filter((k) => k !== undefined);
		assert.deepEqual(kinds, ["resolve"], "gate passed ⇒ no noFold sibling; the tombstone alone terminals the unit");
		assert.equal(entries.find((e) => e.data?.kind === "resolve")?.data?.basis, "compaction-owned");
	} finally {
		restore();
	}
});

/* 0.0.2 FINAL feature (Paul, 2026-10-05: "a way for the user to see the current
 * goal, maybe with /sam goal"): the command pins — same latestGoal resolver as
 * the goal-nudge waiver, so "stored" here and "retired" there can never drift. */
test("/sam goal: a stored goal is shown — text verbatim (multi-line kept), stored timestamp + basis", async () => {
	const u = msg("user", "hi");
	const goalAnchor = { id: "g1", type: "custom", customType: "sam", data: { v: 1, kind: "goal", text: "The standing objective.\nInclude the second line.", ts: 1791200000000, basis: "adjust-goal" } };
	const pi = makeFakePi([u, goalAnchor]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	await pi.commands.get("sam")!.handler("goal", ctx);
	const out = pi.notifyCalls.at(-1)!.text;
	assert.ok(out.includes("The standing objective."), "the goal text, verbatim (first line)");
	assert.ok(out.includes("Include the second line."), "a multi-line goal stays multi-line");
	assert.ok(out.includes("basis adjust-goal"), "the basis is shown");
	assert.ok(out.includes(new Date(1791200000000).toISOString()), "the stored timestamp is shown");
});

test("/sam goal: no goal on the branch ⇒ helpful empty state (no throw, names the way to get one)", async () => {
	const pi = makeFakePi([msg("user", "hi")]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	await pi.commands.get("sam")!.handler("goal", ctx);
	const out = pi.notifyCalls.at(-1)!.text;
	assert.match(out, /no goal stored on this branch/);
	assert.ok(out.includes("adjust_goal"), "points at adjust_goal");
});

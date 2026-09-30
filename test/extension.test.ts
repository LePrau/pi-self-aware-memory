/**
 * P2+P3 tests: the pi glue (extensions/self-aware-memory/index.ts) driven
 * by a fake ExtensionAPI + fake ExtensionContext, following the P0
 * convention. The fake session manager returns pi-shaped session entries;
 * the glue must convert, dispatch, and commit exactly what the pure
 * modules decide.
 *
 * P3 surface pinned here: the coexistence guard (D2) refuses folds while a
 * foreign folder is active; the empty-stub close gate; `/sam fold <n>`
 * (CORRECTIONS override) and `/sam resolve <n>`; the session-start
 * commit-proof tombstone (the s5 discard made loud); the assisted sweep at
 * an `action`-zone settle (and its calm-zone negative); the registered
 * message_end listener (cache observation).
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

import factory from "../extensions/self-aware-memory/index.ts";
import { auditInstruction, undoAck } from "../src/protocol.ts";
import { EXTENSION_NAME, SAM_VERSION } from "../src/identity.ts";

/* ── fakes ───────────────────────────────────────────────────────────────── */

interface PiEntry {
	id: string;
	type: "message" | "custom" | "context_edit";
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

/* ── registration surface ─────────────────────────────────────────────────── */

test("registers /sam, close_unit, session_start, agent_before_settle and message_end — nothing else", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	assert.equal(pi.commands.size, 1);
	assert.ok(pi.commands.has("sam"));
	assert.equal(pi.tools.size, 1);
	assert.ok(pi.tools.has("close_unit"));
	assert.deepEqual(
		[...pi.listeners.keys()].sort(),
		["agent_before_settle", "message_end", "session_start"],
	);
});

test("session start announces build + mode + counts, once, in the ui", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	assert.equal(pi.notifyCalls.length, 1);
	const text = pi.notifyCalls[0].text;
	assert.match(text, new RegExp(`${EXTENSION_NAME} ${SAM_VERSION} loaded`));
	assert.match(text, /mode manual/);
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
		const pi = makeFakePi([u], { contextUsage: { tokens: 5000, contextWindow: 32768, percent: 15 } });
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		const warn = pi.notifyCalls.find((c) => c.type === "error");
		assert.ok(warn, "the D2 posture must be visible at load");
		assert.match(warn!.text, /foreign folding folder/);
		assert.match(warn!.text, /D2/);
		// a manual close in this posture folds nothing (D2 refuses folds; the audit may still run):
		await closeUnit(pi, ctx, "did it");
		settle(pi, ctx); // queues the audit
		pi.branch.push(msg("user", auditInstruction(1)));
		pi.branch.push(msg("assistant", "VERIFIED"));
		const out = await (settle(pi, ctx) as Promise<{ entries: PiEntry[] }>); // capture + the (refused) commit
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

test("close_unit: success appends the close record and reports the unit id", async () => {
	const pi = makeFakePi([msg("user", "write data.txt")]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const result = await closeUnit(pi, ctx, "wrote data.txt");
	assert.match(result.content[0].text as string, /^Unit 1 closed/);
	assert.equal(pi.appended.length, 1);
	assert.equal(pi.appended[0].customType, "sam");
	const data = pi.appended[0].data as { kind: string; unitId: number; stub: string; evidence?: unknown };
	assert.equal(data.kind, "close");
	assert.equal(data.unitId, 1);
	assert.equal(data.stub, "wrote data.txt");
	assert.equal(data.evidence !== undefined, true, "P3: the close record carries the deterministic unit floor");
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

test("settle after a close queues the in-series audit (followUp message + continue)", async () => {
	const u = msg("user", "write data.txt");
	const a = msg("assistant", "working");
	const pi = makeFakePi([u, a]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	await closeUnit(pi, ctx, "wrote data.txt");
	const out = await settle(pi, ctx);
	assert.deepEqual(out, { continue: true });
	assert.equal(pi.sent.length, 1);
	assert.equal(pi.sent[0].text, auditInstruction(1));
	assert.equal(pi.sent[0].options?.deliverAs, "followUp");
});

test("settle at the audit reply captures AND commits the fold in the same settle", async () => {
	const u = msg("user", "write data.txt");
	const a = msg("assistant", "working");
	const pi = makeFakePi([u, a]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	await closeUnit(pi, ctx, "wrote data.txt");
	await settle(pi, ctx); // queues the audit
	pi.branch.push(msg("user", auditInstruction(1)));
	pi.branch.push(msg("assistant", "VERIFIED", { stopReason: "stop", usage: { totalTokens: 1234, input: 1100, output: 134 } }));
	const out = await settle(pi, ctx);
	assert.ok(out && typeof out === "object" && "entries" in out, "the verdict settle must commit the fold");
	const entries = (out as { entries: unknown[] }).entries;
	const edits = entries.filter((e) => (e as { type: string }).type === "context_edit");
	const custom = entries.filter((e) => (e as { type: string }).type === "custom");
	assert.equal(edits.length, 3, "span = user + assistant + close toolResult");
	assert.equal(custom.length, 1);
	const foldRec = custom[0] as { customType: string; data: { kind: string; unitId: number; beforeTokens: number | null; usage?: { totalTokens: number } } };
	assert.equal(foldRec.customType, "sam");
	assert.equal(foldRec.data.kind, "fold");
	assert.equal(foldRec.data.unitId, 1);
	assert.equal(foldRec.data.usage?.totalTokens, 1234, "the verdict message's usage is recorded");
});

test("settle commits the fold in manual mode: stub edit first, nulls after, ledger record last", async () => {
	const u = msg("user", "write data.txt");
	const a = msg("assistant", "working");
	const pi = makeFakePi([u, a], { contextUsage: { tokens: 4242, contextWindow: 32768, percent: 12.9 } });
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	await closeUnit(pi, ctx, "wrote data.txt");
	const trEntry = pi.branch[pi.branch.length - 1];
	await settle(pi, ctx);
	pi.branch.push(msg("user", auditInstruction(1)));
	pi.branch.push(msg("assistant", "VERIFIED"));
	const out2 = await settle(pi, ctx);
	const entries = (out2 as { entries: PiEntry[] }).entries;
	const edits = entries.filter((e) => e.type === "context_edit");
	assert.equal(edits.length, 3);
	assert.deepEqual(edits[0], { type: "context_edit", targetId: u.id, replacement: { content: "[Unit 1 ✓] wrote data.txt" } });
	assert.deepEqual(edits[1], { type: "context_edit", targetId: a.id, replacement: null });
	assert.deepEqual(edits[2], { type: "context_edit", targetId: trEntry.id, replacement: null });
	const fold = entries.find((e) => e.type === "custom") as PiEntry;
	assert.equal(fold.customType, "sam");
	assert.equal((fold.data as { kind: string }).kind, "fold");
	assert.equal((fold.data as { beforeTokens: number }).beforeTokens, 4242);
});

test("settle: CORRECTIONS verdict → noFold record, no context edits", async () => {
	const u = msg("user", "task " + "x".repeat(60));
	const pi = makeFakePi([u]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	await closeUnit(pi, ctx, "did it (claims 3 lines)");
	await settle(pi, ctx);
	pi.branch.push(msg("user", auditInstruction(1)));
	pi.branch.push(msg("assistant", "CORRECTIONS: the file has 5 lines, not 3"));
	const out = await settle(pi, ctx);
	const entries = (out as { entries: PiEntry[] }).entries;
	assert.equal(entries.length, 1);
	assert.equal(entries[0].type, "custom");
	const data = entries[0].data as { kind: string; verdict: string; reason: string; corrections: string };
	assert.equal(data.kind, "noFold");
	assert.equal(data.verdict, "CORRECTIONS");
	assert.equal(data.reason, "verdict CORRECTIONS");
	assert.equal(data.corrections, "the file has 5 lines, not 3");
});

test("settle: VERIFIED in display mode → noFold (display mode), no context edits", async () => {
	const u = msg("user", "task " + "x".repeat(60));
	const pi = makeFakePi([u, sam({ v: 1, kind: "mode", mode: "display", ts: 0 })]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	await closeUnit(pi, ctx, "did it " + "x".repeat(60));
	await settle(pi, ctx);
	pi.branch.push(msg("user", auditInstruction(1)));
	pi.branch.push(msg("assistant", "VERIFIED"));
	const out = await settle(pi, ctx);
	const entries = (out as { entries: PiEntry[] }).entries;
	assert.equal(entries.length, 1);
	const data = entries[0].data as { kind: string; reason: string };
	assert.equal(data.kind, "noFold");
	assert.equal(data.reason, "display mode");
});

/* ── P3: assisted sweep ───────────────────────────────────────────────────── */

function displayEraUnit(pi: FakePi): { u: PiEntry } {
	const u = msg("user", "task: wire the deployment pipeline " + "x".repeat(30));
	pi.branch.push(u);
	pi.branch.push(msg("assistant", "pipeline stages 1-4 wired, tests green " + "x".repeat(30)));
	pi.branch.push(
		sam({ v: 1, kind: "close", unitId: 1, stub: "pipeline wired, tests green", toolCallId: "t", ts: 1, mode: "display" }),
	);
	pi.branch.push(
		sam({
			v: 1, kind: "noFold", unitId: 1,
			entryIds: [pi.branch[0].id, pi.branch[1].id],
			spanFirstId: pi.branch[0].id, spanLastId: pi.branch[1].id,
			stub: "pipeline wired, tests green",
			verdict: "VERIFIED", reason: "display mode", ts: 2, mode: "display",
		}),
	);
	pi.branch.push(sam({ v: 1, kind: "mode", mode: "assisted", ts: 3 }));
	return { u };
}

test("P3 sweep: an action-zone settle folds ONE display-era VERIFIED unit (assisted mode)", async () => {
	const pi = makeFakePi([], { contextUsage: { tokens: 114690, contextWindow: 131072, percent: 87.5 } });
	displayEraUnit(pi);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const res = await (settle(pi, ctx) as Promise<{ entries: PiEntry[] }>);
	assert.ok(res && "entries" in res, "the sweep commits at the settle");
	const entries = res.entries;
	const edits = entries.filter((e) => e.type === "context_edit");
	assert.equal(edits.length, 2, "the display-era unit's span (two messages) is folded");
	const rec = entries.find((e) => e.type === "custom") as PiEntry;
	const data = rec.data as { kind: string; unitId: number; sweep?: string; beforeTokens: number };
	assert.equal(data.kind, "fold");
	assert.equal(data.unitId, 1);
	assert.equal(data.sweep, "assisted", "the record carries the sweep origin");
	assert.equal(data.beforeTokens, 114690);
	assert.equal((edits[0].replacement as { content: string })?.content, "[Unit 1 ✓] pipeline wired, tests green");
});

test("P3 sweep: the SAME unit in a calm zone does NOT fold (bounded, zone-gated)", async () => {
	const pi = makeFakePi([], { contextUsage: { tokens: 90000, contextWindow: 131072, percent: 68.7 } });
	displayEraUnit(pi);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const out = await (settle(pi, ctx) as Promise<unknown>);
	assert.equal(out, undefined, "calm zone: no sweep, no entries");
	const foldRecords = pi.branch.filter((e) => e.type === "custom" && (e.data as { kind?: string })?.kind === "fold");
	assert.equal(foldRecords.length, 0);
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
	assert.match(lines[1], /^mode: manual/);
	assert.equal(lines.some((l) => l.startsWith("probe: off (default)")), true, "P3: the probe posture (off by default) is stated");
});

test("/sam mode display: switches, records, confirms", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "mode display");
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /mode is now 'display'/);
	assert.equal(pi.appended.length, 1);
	assert.equal((pi.appended[0].data as { kind: string; mode: string }).mode, "display");
});

test("/sam mode assisted: P3 accepts it (implemented — sweep-enabled)", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "mode assisted");
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /mode is now 'assisted'/);
	assert.equal((pi.appended[0].data as { mode: string }).mode, "assisted");
});

test("/sam mode auto: P3 accepts it (implemented — sweep + unmarked-block stub request)", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "mode auto");
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /mode is now 'auto'/);
});

test("/sam mode bogus: unknown mode error", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "mode bogus");
	assert.equal(pi.notifyCalls.length, 1);
	assert.equal(pi.notifyCalls[0].type, "error");
	assert.match(pi.notifyCalls[0].text, /unknown mode 'bogus'/);
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

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
// Delivery seam (2026-10-05 — Paul: "followUp is deprecated, it bricks the
// main session — delivery=close should be the default now"): THIS SUITE glues
// the followUp flow, so it pins the retained deprecated path at file level.
// The new DEFAULT (close) is pinned by the factory-default + unknown-value
// fail-safe tests below and covered end-to-end by the close-audit suites
// (which pin `close` explicitly).
process.env["SAM_AUDIT_DELIVERY"] = "followUp";

import factory from "../extensions/self-aware-memory/index.ts";
import { auditInstruction, undoAck } from "../src/protocol.ts";
import { EXTENSION_NAME, SAM_VERSION } from "../src/identity.ts";
import { rebuildLedger } from "../src/ledger.ts";
import { createSamState } from "../src/state.ts";

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

/**
 * Model what real pi leaves in the session file at settle time for a steered
 * close: the close custom record (appendEntry at execute, BEFORE the
 * close_unit toolResult pi appends after execute), then the steered audit
 * exchange (delivered in-turn, before the settle fires).
 */
function steerBranchInto(pi: FakePi, reply: PiEntry, ...after: PiEntry[]): void {
	// the close record is the last appended sam entry from closeUnit(); pi
	// appends it during execute, i.e. BEFORE the toolResult the fake closeUnit
	// pushes — reorder so the branch matches pi's real on-disk order.
	const rec = [...pi.appended].reverse().find((a) => a.customType === "sam")?.data;
	assert.ok(rec, "the close record must have been appended");
	const tr = pi.branch[pi.branch.length - 1];
	assert.equal(tr.type, "message", "the last branch entry must be the close toolResult");
	pi.branch.pop();
	pi.branch.push({ id: "closerec", type: "custom", customType: "sam", data: rec });
	pi.branch.push(tr);
	pi.branch.push(msg("user", auditInstruction(1)));
	pi.branch.push(reply);
	after.forEach((e) => pi.branch.push(e));
}

/* ── registration surface ─────────────────────────────────────────────────── */

test("registers /sam, close_unit + sam_retrieve (P5), session_start, agent_before_settle, message_end, session_before_compact (P5), input (D11b) — nothing else", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	assert.equal(pi.commands.size, 1);
	assert.ok(pi.commands.has("sam"));
	assert.equal(pi.tools.size, 2); // THE FOLLOWUP SURFACE (this suite's pinned deprecated dial — the D11 close-dial surface stays byte-stable per control arm); the close-DEFAULT surface is the 4-tool set below
	assert.ok(pi.tools.has("close_unit"));
	assert.ok(pi.tools.has("sam_retrieve"));
	assert.deepEqual(
		[...pi.listeners.keys()].sort(),
		["agent_before_settle", "input", "message_end", "session_before_compact", "session_start"], // +P5 takeover hook + D11b goal-offer arm (the input event)
	);
});

test("DEFAULT surface (2026-10-05 — the flip): unset SAM_AUDIT_DELIVERY ⇒ close-dial tool surface (the D11 goal tools adjust_goal + read_goal RIDE the close default; the followUp surface above stays the 2-tool deprecated byte-stable set). Also covers the rep-3 gap: the goal offer fired with the goal tools ABSENT — on the close default the offer and its tool now ship together", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "");
	try {
		const pi = makeFakePi();
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		assert.equal(pi.tools.size, 4);
		assert.ok(pi.tools.has("close_unit"));
		assert.ok(pi.tools.has("adjust_goal"), "the goal offer's tool rides the close default");
		assert.ok(pi.tools.has("read_goal"));
		assert.ok(pi.tools.has("sam_retrieve"));
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

test("settle after a close queues the in-series audit (explicit followUp opt-in — the DEPRECATED path retained 2026-10-05; the DEFAULT is now close)", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "followUp");
	try {
		const u = msg("user", "write data.txt");
		const a = msg("assistant", "working");
		const pi = makeFakePi([u, a]);
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		await closeUnit(pi, ctx, "wrote data.txt");
		const out = await settle(pi, ctx);
		assert.deepEqual(out, { continue: true });
		assert.equal(pi.sent.length, 1);
		// P4 R2: the send carries the self-contained payload (stub verbatim + the
		// recorded floor) — exactly what the shared builder produces for this unit.
		const expected = auditInstruction(1, { stub: "wrote data.txt", evidence: { files: [], errors: 0, retries: 0, nonTrivial: false } });
		assert.equal(pi.sent[0].text, expected);
		assert.ok(pi.sent[0].text.includes("wrote data.txt"), "the stub is inline in the instruction");
		assert.equal(pi.sent[0].options?.deliverAs, "followUp");
	} finally {
		restore();
	}
});

test("settle at the audit reply captures AND commits the fold in the same settle (explicit followUp opt-in — deprecated path)", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "followUp");
	try {
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
	} finally {
		restore();
	}
});

test("settle commits the fold in manual mode: stub edit first, nulls after, ledger record last (explicit followUp opt-in — deprecated path)", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "followUp");
	try {
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
	} finally {
		restore();
	}
});

/* ── P4 R1: steer delivery (plan carry #7; the DEFAULT is close since 2026-10-05 — these tests pin STEER, the retained toggle) ───────── */

test("steer: close sends the audit IN-TURN (deliverAs steer) instead of the followUp", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "steer");
	try {
		const u = msg("user", "write data.txt");
		const a = msg("assistant", "working");
		const pi = makeFakePi([u, a]);
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		await closeUnit(pi, ctx, "wrote data.txt");
		assert.equal(pi.sent.length, 1, "the steer send happens at close, in-turn");
		const expected = auditInstruction(1, { stub: "wrote data.txt", evidence: { files: [], errors: 0, retries: 0, nonTrivial: false } });
		assert.equal(pi.sent[0].text, expected, "steer and followUp carries are byte-identical (delivery is the only variable)");
		assert.equal(pi.sent[0].options?.deliverAs, "steer");
	} finally {
		restore();
	}
});

test("steer: VERIFIED in-turn + return-to-task continuation → fold commits in the close's own settle, no fallback audit", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "steer");
	try {
		const u = msg("user", "write data.txt");
		const a = msg("assistant", "working");
		const pi = makeFakePi([u, a], { contextUsage: { tokens: 4242, contextWindow: 131072, percent: 3.2 } });
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		await closeUnit(pi, ctx, "wrote data.txt");
		// pi 0.87.1's settle sees the steered exchange already in the branch:
		steerBranchInto(
			pi,
			{
				id: "reply", type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "VERIFIED" },
						{ type: "toolCall", toolCallId: "b1", name: "bash", arguments: { command: "echo marathon-continues" } },
					],
					stopReason: "toolUse",
					usage: { totalTokens: 777, input: 700, output: 77 },
				},
			},
			msg("toolResult", "marathon-continues", { toolCallId: "b1", toolName: "bash", isError: false }),
			msg("assistant", "Done — the marathon continues."), // return to task after the verdict
		);
		const out = await settle(pi, ctx);
		assert.ok(out && typeof out === "object" && "entries" in out, "the close settle must commit the fold");
		assert.ok(!((out as { continue?: boolean }).continue), "no continue — the turn already ended with the audit answered");
		const entries = (out as { entries: PiEntry[] }).entries;
		const edits = entries.filter((e) => e.type === "context_edit");
		const custom = entries.filter((e) => e.type === "custom");
		assert.equal(edits.length, 3, "span = user + assistant + close toolResult (the continuation is NOT folded)");
		assert.equal(custom.length, 1);
		const foldRec = custom[0].data as { kind: string; unitId: number; verdict: string; usage?: { totalTokens?: number } };
		assert.equal(foldRec.kind, "fold");
		assert.equal(foldRec.unitId, 1);
		assert.equal(foldRec.verdict, "VERIFIED");
		assert.equal(foldRec.usage?.totalTokens, 777, "the in-turn verdict's usage is recorded");
		// the followUp fallback must NOT have been sent (only the original steer)
		assert.equal(pi.sent.length, 1);
		assert.equal(pi.sent[0].options?.deliverAs, "steer");
	} finally {
		restore();
	}
});

test("steer: CORRECTIONS in-turn → noFold (verdict CORRECTIONS) in the close's own settle", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "steer");
	try {
		const u = msg("user", "task " + "x".repeat(60));
		const pi = makeFakePi([u]);
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		await closeUnit(pi, ctx, "did it (claims 3 lines)");
		steerBranchInto(pi, msg("assistant", "CORRECTIONS: the file has 5 lines, not 3"));
		const out = await settle(pi, ctx);
		const entries = (out as { entries: PiEntry[] }).entries;
		assert.equal(entries.length, 1); // the noFold record only — no context edits
		const data = entries[0].data as { kind: string; verdict: string; reason: string };
		assert.equal(data.kind, "noFold");
		assert.equal(data.verdict, "CORRECTIONS");
		assert.equal(data.reason, "verdict CORRECTIONS");
		assert.equal(pi.sent.length, 1); // no fallback audit either
	} finally {
		restore();
	}
});

test("steer: display mode → noFold (display mode), same-settle, audits stay measurements", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "steer");
	try {
		const u = msg("user", "write data.txt");
		const a = msg("assistant", "working");
		const pi = makeFakePi([u, a]);
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		await command(pi, ctx, "mode display");
		await closeUnit(pi, ctx, "wrote data.txt");
		steerBranchInto(pi, msg("assistant", "VERIFIED"));
		const out = await settle(pi, ctx);
		const entries = (out as { entries: PiEntry[] }).entries;
		assert.equal(entries.length, 1);
		const data = entries[0].data as { kind: string; reason: string };
		assert.equal(data.kind, "noFold");
		assert.equal(data.reason, "display mode");
	} finally {
		restore();
	}
});

test("steer: no in-turn reply → F1 fallback queues the followUp audit (close survives)", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "steer");
	try {
		const u = msg("user", "write data.txt");
		const a = msg("assistant", "working");
		const pi = makeFakePi([u, a]);
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		await closeUnit(pi, ctx, "wrote data.txt");
		// the steered audit landed but the model never answered it in-turn
		pi.branch.push(msg("user", auditInstruction(1)));
		const out = await settle(pi, ctx);
		assert.deepEqual(out, { continue: true }, "the fallback audit rides the normal followUp flow");
		assert.equal(pi.sent.length, 2, "steer send + followUp fallback");
		assert.equal(pi.sent[1].options?.deliverAs, "followUp");
		// the next settle (reply now present) commits normally
	pi.branch.push(msg("assistant", "VERIFIED"));
		const out2 = await settle(pi, ctx);
		assert.ok(out2 && "entries" in out2);
		const entries = (out2 as { entries: PiEntry[] }).entries;
		assert.ok(entries.some((e) => e.type === "custom" && (e.data as { kind?: string }).kind === "fold"), "the fallback path still folds on VERIFIED");
	} finally {
		restore();
	}
});

test("an UNKNOWN SAM_AUDIT_DELIVERY value fails-safe to the DEFAULT (close, since 2026-10-05): never steer, and NO in-series followUp send (the followUp path is the explicit deprecated opt-in only)", async () => {
	const restore = withEnv("SAM_AUDIT_DELIVERY", "steer-ish");
	try {
		const u = msg("user", "write data.txt");
		const a = msg("assistant", "working");
		const goalAnchor = { id: "goal-anchor", type: "custom", customType: "sam", data: { v: 1, kind: "goal", text: "the standing goal", ts: 1, basis: "adjust-goal" } }; // a stored goal ⇒ the 2026-10-04 close-time goal nudge retires — this test pins the dial's failsafe, not the goal offer
		const pi = makeFakePi([u, a, goalAnchor]);
		const ctx = makeFakeCtx(pi);
		await load(pi, ctx);
		await closeUnit(pi, ctx, "wrote data.txt");
		assert.equal(pi.sent.length, 0, "no steer send for an unrecognized value (and no in-series followUp audit — the DEFAULT is now close, which audits inside close_unit)");
		await settle(pi, ctx);
		assert.equal(pi.sent.length, 0, "settle under the close default queues no in-series followUp send (that is the deprecated explicit path only)");
	} finally {
		restore();
	}
});

/* 2026-10-05 (Paul: "followUp is deprecated, it bricks the main session —
 * delivery=close should be the default now"): the factory DEFAULT is pinned
 * directly — the env mapping above (followUp/steer/branch as exact-value
 * opt-ins, fail-safe to the default) builds on this. */
test("audit-delivery DEFAULT (2026-10-05): createSamState ⇒ 'close' (followUp is now the explicit deprecated opt-in only)", () => {
	assert.equal(createSamState(rebuildLedger([])).auditDelivery, "close", "DEFAULT since 2026-10-05 — the P2/P3 followUp flow is retained only as the explicit env opt-in SAM_AUDIT_DELIVERY=followUp");
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


/* ── P4 R3: compacted spans — the compaction-owned terminal (DEFAULT since the 2026-09-30 H1 promotion; `refuse` = explicit opt-out) ────── */

/**
 * Close + (settle #1: the audit is queued, the default followUp shape) + a
 * compaction covering the span + the audit answered AFTER compaction — the
 * 2026-09-30 live bank's geometry (measured, session 01a0f294): span entries
 * earlier, the compaction after them with firstKeptEntryId pointed at the
 * audit reply.
 */
async function compactedFixture(spanText: string, stub: string, over: Partial<FakePi> = {}) {
	const u = msg("user", spanText);
	const a = msg("assistant", "working");
	const pi = makeFakePi(
		[u, a],
		over.contextUsage
			? over
			: { ...over, contextUsage: { tokens: 40_000, contextWindow: 131_072, percent: 30 } },
	);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	await closeUnit(pi, ctx, stub);
	// settle #1: the close settles — the audit is queued (followUp, default).
	await settle(pi, ctx);
	// the audit turn lands AFTER the compaction (the live bank's order):
	pi.branch.push(msg("user", auditInstruction(1)));
	const reply = msg("assistant", "VERIFIED");
	pi.branch.push(reply);
	pi.branch.splice(pi.branch.length - 1, 0, {
		id: "cmp0",
		type: "compaction",
		summary: "compacted prefix",
		firstKeptEntryId: reply.id,
	});
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

test("R3 opt-out (SAM_COMPACTED_SPAN=refuse, exact value): the legacy default terminal is restored (the R4 shape at the glue level)", async () => {
	const restore = withEnv("SAM_COMPACTED_SPAN", "refuse");
	try {
		const { pi, ctx } = await compactedFixture("marathon task " + "w".repeat(140_000), "did the marathon work");
		const entries = settledEntries(await settle(pi, ctx));
		assert.equal(entries.filter((e) => e.type === "context_edit").length, 0, "no fold — the ceiling refuses (refuse policy)");
		const rec = entries.find((e) => e.data?.kind === "noFold");
		assert.ok(rec, "the terminal is the gate's noFold");
		assert.equal(rec.data?.reason, "ceiling");
		assert.equal(entries.some((e) => e.data?.kind === "resolve"), false, "opt-out: no tombstone — the gate's refusal stands (unit refused)");
	} finally {
		restore();
	}
});

test("R3 tombstone (explicit dial, = the default since the 2026-09-30 promotion): same span ⇒ resolved (compaction-owned), ceiling arithmetic kept as evidence, ZERO edits", async () => {
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

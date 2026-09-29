/**
 * P2 tests: the pi glue (extensions/self-aware-memory/index.ts) driven by a
 * fake ExtensionAPI + fake ExtensionContext, following the P0 convention.
 * The fake session manager returns pi-shaped session entries; the glue must
 * convert, dispatch, and commit exactly what the pure modules decide.
 *
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import factory from "../extensions/self-aware-memory/index.ts";
import { auditInstruction, closeUnitResultText, undoAck } from "../src/protocol.ts";
import { rebuildLedger } from "../src/ledger.ts";
import { countUnits } from "../src/state.ts";
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
	const f: FakePi = {
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
	return f;
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
		registerCommand: (name: string, def: FakeCommandDef) => {
			f.commands.set(name, def);
		},
		registerTool: (def: FakeToolDef) => {
			f.tools.set(def.name, def);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = f.listeners.get(event) ?? [];
			list.push(handler);
			f.listeners.set(event, list);
		},
		// pi appends the custom entry to the session (it becomes part of the branch).
		appendEntry: (customType: string, data?: unknown) => {
			f.appended.push({ customType, data });
			f.branch.push({ id: nextId(), type: "custom", customType, data });
		},
		// pi.sendUserMessage starts a nested agent run: it is fire-and-forget
		// (v0.87.1) and the run becomes active before the caller's next tick.
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
function load(pi: FakePi, ctx: Record<string, unknown>): void {
	factory(makeApi(pi) as never);
	const starts = pi.listeners.get("session_start") ?? [];
	assert.equal(starts.length, 1, "exactly one session_start listener");
	starts[0]({ reason: "startup" }, ctx);
}

async function command(pi: FakePi, ctx: Record<string, unknown>, args: string): Promise<void> {
	const sam = pi.commands.get("sam");
	assert.ok(sam, "the /sam command must be registered");
	await sam.handler(args, ctx);
}

async function closeUnit(pi: FakePi, ctx: Record<string, unknown>, stub: string, toolCallId = "tc1") {
	const tool = pi.tools.get("close_unit");
	assert.ok(tool, "the close_unit tool must be registered");
	const result = await tool.execute(toolCallId, { stub }, new AbortController().signal, undefined, ctx);
	// pi appends the toolResult entry to the session after execute:
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

/* ── registration surface ─────────────────────────────────────────────────── */

test("registers /sam, close_unit, session_start and agent_before_settle — nothing else", () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	assert.equal(pi.commands.size, 1);
	assert.ok(pi.commands.has("sam"));
	assert.equal(pi.tools.size, 1);
	assert.ok(pi.tools.has("close_unit"));
	assert.deepEqual(
		[...pi.listeners.keys()].sort(),
		["agent_before_settle", "session_start"],
	);
});

test("session start announces build + mode + counts, once, in the ui", () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	assert.equal(pi.notifyCalls.length, 1);
	const text = pi.notifyCalls[0].text;
	assert.match(text, new RegExp(`${EXTENSION_NAME} ${SAM_VERSION} loaded`));
	assert.match(text, /mode manual/);
	assert.match(text, /folded 0/);
	assert.equal(pi.notifyCalls[0].type, "info");
});

test("session start with a malformed ledger entry: announced, still clean", () => {
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
	load(pi, ctx);
	const text = pi.notifyCalls[0].text;
	assert.match(text, /1 malformed ledger record\(s\) skipped/);
	assert.match(text, /in flight 1/); // the unresolved close is picked up as pending re-audit
});

test("session start fail-open: a failing branch getter resets state and reports the error", () => {
	const pi = makeFakePi([], { getBranchThrows: true });
	const ctx = makeFakeCtx(pi);
	assert.doesNotThrow(() => load(pi, ctx));
	const err = pi.notifyCalls.find((c) => c.type === "error");
	assert.ok(err, "the error must surface");
	assert.match(err!.text, /load error/);
});

/* ── close_unit tool ──────────────────────────────────────────────────────── */

test("close_unit: success appends the close record and reports the unit id", async () => {
	const pi = makeFakePi([msg("user", "write data.txt")]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	const result = await closeUnit(pi, ctx, "wrote data.txt");
	assert.match(result.content[0].text as string, /^Unit 1 closed/);
	assert.equal(pi.appended.length, 1);
	assert.equal(pi.appended[0].customType, "sam");
	const data = pi.appended[0].data as { kind: string; unitId: number; stub: string };
	assert.equal(data.kind, "close");
	assert.equal(data.unitId, 1);
	assert.equal(data.stub, "wrote data.txt");
});

test("close_unit: no real user message → rejected, nothing appended", async () => {
	const pi = makeFakePi([msg("user", "[sam-audit] Unit 9 ..."), msg("assistant", "VERIFIED")]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
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
	]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	const result = await closeUnit(pi, ctx, "another stub", "tc2");
	assert.match(result.content[0].text as string, /already closed/i);
	assert.equal(pi.appended.length, 0);
});

test("close_unit: internal failure is a fail-open error result, nothing appended", async () => {
	const pi = makeFakePi([msg("user", "task")], { getBranchThrows: true });
	const ctx = makeFakeCtx(pi);
	load(pi, ctx); // load also threw internally and recovered
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
	load(pi, ctx);
	await closeUnit(pi, ctx, "wrote data.txt");
	const out = settle(pi, ctx);
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
	load(pi, ctx);
	await closeUnit(pi, ctx, "wrote data.txt");
	settle(pi, ctx); // queues the audit
	// the audit exchange lands in the branch:
	pi.branch.push(msg("user", auditInstruction(1)));
	pi.branch.push(msg("assistant", "VERIFIED", { stopReason: "stop", usage: { totalTokens: 1234, input: 1100, output: 134 } }));
	// capture + commit happen in this one settle (pi settles here, and in
	// print mode the process exits — a deferred commit would strand the verdict):
	const out = settle(pi, ctx);
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
	load(pi, ctx);
	await closeUnit(pi, ctx, "wrote data.txt");
	const trEntry = pi.branch[pi.branch.length - 1]; // the close toolResult appended by pi
	settle(pi, ctx); // queues the audit
	pi.branch.push(msg("user", auditInstruction(1)));
	pi.branch.push(msg("assistant", "VERIFIED"));
	const out2 = settle(pi, ctx); // capture the verdict AND commit the fold
	const entries = (out2 as { entries: PiEntry[] }).entries;
	const edits = entries.filter((e) => e.type === "context_edit");
	assert.equal(edits.length, 3, "user + assistant + toolResult targeted (the close record is custom, never targeted)");
	assert.deepEqual(edits[0], { type: "context_edit", targetId: u.id, replacement: { content: "[Unit 1 ✓] wrote data.txt" } });
	assert.deepEqual(edits[1], { type: "context_edit", targetId: a.id, replacement: null });
	assert.deepEqual(edits[2], { type: "context_edit", targetId: trEntry.id, replacement: null });
	const fold = entries.find((e) => e.type === "custom") as PiEntry;
	assert.equal(fold.customType, "sam");
	assert.equal((fold.data as { kind: string }).kind, "fold");
	assert.equal((fold.data as { beforeTokens: number }).beforeTokens, 4242);
});

test("settle: CORRECTIONS verdict → noFold record, no context edits", async () => {
	const u = msg("user", "task");
	const pi = makeFakePi([u]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	await closeUnit(pi, ctx, "did it");
	settle(pi, ctx); // queues the audit
	pi.branch.push(msg("user", auditInstruction(1)));
	pi.branch.push(msg("assistant", "CORRECTIONS: the file has 5 lines, not 3"));
	const out = settle(pi, ctx); // capture AND commit the noFold record
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
	const u = msg("user", "task");
	const pi = makeFakePi([u, sam({ v: 1, kind: "mode", mode: "display", ts: 0 })]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	await closeUnit(pi, ctx, "did it");
	settle(pi, ctx); // queues the audit
	pi.branch.push(msg("user", auditInstruction(1)));
	pi.branch.push(msg("assistant", "VERIFIED"));
	const out = settle(pi, ctx); // capture AND commit the noFold record
	const entries = (out as { entries: PiEntry[] }).entries;
	assert.equal(entries.length, 1);
	const data = entries[0].data as { kind: string; reason: string };
	assert.equal(data.kind, "noFold");
	assert.equal(data.reason, "display mode");
});

test("close_unit refuses a second close in the same turn (first close is effective)", async () => {
	const u = msg("user", "task");
	const pi = makeFakePi([u]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	const first = await closeUnit(pi, ctx, "first stub");
	assert.equal(first.isError, undefined);
	const second = await closeUnit(pi, ctx, "second stub");
	// refusal style matches the other close rejections: a normal result whose
	// text tells the model what is effective (no isError flag).
	assert.equal(second.isError, undefined);
	const text = (second.content[0] as { type: string; text: string }).text;
	assert.match(text, /already closed for this turn/);
	assert.equal((second.details as { rejected: string }).rejected, "pending");
	// exactly one close record in the ledger (the refused call wrote nothing):
	const closeRecords = pi.branch.filter((e) => e.type === "custom" && (e.data as { kind: string }).kind === "close");
	assert.equal(closeRecords.length, 1);
});

test("settle: no pending work → undefined", () => {
	const pi = makeFakePi([msg("user", "hello")]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	assert.equal(settle(pi, ctx), undefined);
});

test("settle fail-open: a failing branch getter returns undefined (session continues)", async () => {
	const pi = makeFakePi([msg("user", "hello")], { getBranchThrows: true });
	const ctx = makeFakeCtx(pi);
	load(pi, ctx); // load recovered inside its handler
	await closeUnit(pi, ctx, "stub"); // recovered inside the tool
	const out = settle(pi, ctx); // no pending work survives the failures
	assert.equal(out, undefined);
});

/* ── /sam surface ─────────────────────────────────────────────────────────── */

test("/sam with no args renders the status block", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "");
	assert.equal(pi.notifyCalls.length, 1);
	const lines = pi.notifyCalls[0].text.split("\n");
	assert.match(lines[0], new RegExp(`── sam ── ${EXTENSION_NAME} ${SAM_VERSION} ──`));
	assert.match(lines[1], /^mode: manual/);
});

test("/sam mode display: switches, records, confirms", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "mode display");
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /mode is now 'display'/);
	assert.equal(pi.appended.length, 1);
	assert.equal((pi.appended[0].data as { kind: string; mode: string }).kind, "mode");
	assert.equal((pi.appended[0].data as { mode: string }).mode, "display");
});

test("/sam mode assisted: named P3 rejection, mode unchanged", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "mode assisted");
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /not yet implemented \(P3\)/);
	assert.equal(pi.appended.length, 0);
	// status still says manual
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "");
	assert.match(pi.notifyCalls[0].text, /mode: manual/);
});

test("/sam mode bogus: unknown mode error", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "mode bogus");
	assert.equal(pi.notifyCalls.length, 1);
	assert.equal(pi.notifyCalls[0].type, "error");
	assert.match(pi.notifyCalls[0].text, /unknown mode 'bogus'/);
});

test("/sam report renders the ledger", async () => {
	const u = msg("user", "task");
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "did it", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "did it", verdict: "VERIFIED", beforeTokens: 100, ts: 2, mode: "manual" }),
	]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "report");
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /unit 1: folded · pre-fold 100 tokens \(pi estimate\)/);
});

test("/sam fold: honest P3 stub", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "fold");
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /not yet implemented \(P3\)/);
});

test("/sam unknown subcommand: error naming it", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "teleport");
	assert.equal(pi.notifyCalls.length, 1);
	assert.equal(pi.notifyCalls[0].type, "error");
	assert.match(pi.notifyCalls[0].text, /unknown subcommand 'teleport'/);
});

test("/sam undo with nothing folded: says so", async () => {
	const pi = makeFakePi([msg("user", "hello")]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
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
		u,
		a,
		tr,
		sam({ v: 1, kind: "close", unitId: 1, stub: "did it", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id, a.id, tr.id], spanFirstId: u.id, spanLastId: tr.id, stub: "did it", verdict: "VERIFIED", beforeTokens: 999, ts: 2, mode: "manual" }),
	]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	pi.notifyCalls.length = 0;
	pi.sent.length = 0;
	// The nested ack run goes idle only after its settle commits — model pi:
	// the command handler awaits the turn, so the command does not return
	// before the settle.
	let resolveIdle: () => void = () => {};
	pi.idlePromise = new Promise<void>((r) => {
		resolveIdle = r;
	});
	const commandPromise = command(pi, ctx, "undo");
	assert.equal(pi.sent.length, 1, "the ack turn was started before the wait");
	assert.equal(pi.sent[0].text, undoAck(1));
	assert.equal(pi.isIdle, false, "the nested run is active while the command waits");
	// the ack turn ends → settle commits the undo:
	const out = settle(pi, ctx);
	const entries = (out as { entries: PiEntry[] }).entries;
	const edits = entries.filter((e) => e.type === "context_edit");
	assert.equal(edits.length, 3, "all span entries restored");
	for (const e of edits) {
		assert.ok(e.replacement !== null, "undo restores the original content");
	}
	const undoRec = entries.find((e) => e.type === "custom") as PiEntry;
	assert.equal((undoRec.data as { kind: string; unitId: number }).kind, "undo");
	assert.deepEqual((undoRec.data as { targets: string[] }).targets, [u.id, a.id, tr.id]);
	resolveIdle(); // the run settles → the command may return
	await commandPromise;
	assert.equal(pi.notifyCalls.length, 1);
	assert.match(pi.notifyCalls[0].text, /undo of unit 1 in flight/);
});

test("/sam undo: second undo in flight is rejected", async () => {
	const u = msg("user", "task");
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "s", verdict: "VERIFIED", ts: 2, mode: "manual" }),
	]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx);
	await command(pi, ctx, "undo");
	pi.notifyCalls.length = 0;
	await command(pi, ctx, "undo");
	assert.equal(pi.notifyCalls.length, 1);
	assert.equal(pi.notifyCalls[0].type, "error");
	assert.match(pi.notifyCalls[0].text, /already in flight/);
});

test("command handler fail-open: a throwing branch getter reports, never throws", async () => {
	const u = msg("user", "task");
	const pi = makeFakePi([
		u,
		sam({ v: 1, kind: "close", unitId: 1, stub: "s", toolCallId: "tc1", ts: 1, mode: "manual" }),
		sam({ v: 1, kind: "fold", unitId: 1, entryIds: [u.id], spanFirstId: u.id, spanLastId: u.id, stub: "s", verdict: "VERIFIED", ts: 2, mode: "manual" }),
	]);
	const ctx = makeFakeCtx(pi);
	load(pi, ctx); // rebuild succeeds → unit 1 is folded in state
	pi.getBranchThrows = true; // the branch dies before the command reads it
	pi.notifyCalls.length = 0;
	await assert.doesNotReject(() => command(pi, ctx, "undo")); // undo reads the branch
	const err = pi.notifyCalls.find((c) => c.type === "error");
	assert.ok(err, "the error must surface");
});

/**
 * 2026-10-06 (Paul, audit-ergonomics): the in-session audit-depth switch
 * (`/sam depth auto|full|light`) — the pins. Two layers (the house discipline):
 *   A. the PURE core (ledger.ts): the record round-trip + latest-wins
 *      (latestAuditDepth) + the total validator.
 *   B. the GLUE (extension level): the precedence at the close decision —
 *      RETIRE-CARRY marker > /sam depth command > env SAM_AUDIT_DEPTH > zone
 *      auto — driven through the fake ExtensionAPI with the REAL close-audit
 *      child recipe (the suite never spawns a real process), on the close
 *      record (decision-in-ledger).
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["SAM_AUDIT_DELIVERY"] = "close";
process.env["SAM_SETTINGS_JSON"] = JSON.stringify({ extensions: ["pi-self-aware-memory"] });

import { latestAuditDepth, DEPTH_VALUES, parseSamRecord, type SamDepthRecord } from "../src/ledger.ts";
import type { PlainEntry } from "../src/projection.ts";
import { AUDIT_INSTRUCTION_PREFIX } from "../src/protocol.ts";
import factory, { __setCloseAuditRunner, type CloseAuditRunner } from "../extensions/self-aware-memory/index.ts";

/* ══ A. the pure core ════════════════════════════════════════════════════ */

test("depth record: the shape + the total validator + latest-wins (latestAuditDepth)", () => {
	assert.deepEqual([...DEPTH_VALUES], ["auto", "full", "light"], "the three exact values");
	const ok: SamDepthRecord = { v: 1, kind: "depth", depth: "light", ts: 1 };
	assert.equal(parseSamRecord(ok)?.kind, "depth", "a valid record parses");
	// malformed ⇒ undefined (the ledger never counts depth garbage)
	assert.equal(parseSamRecord({ v: 1, kind: "depth", depth: "bogus", ts: 1 }), undefined, "unknown depth ⇒ malformed");
	assert.equal(parseSamRecord({ v: 1, kind: "depth", ts: 1 }), undefined, "missing depth ⇒ malformed");
	assert.equal(parseSamRecord({ kind: "depth", depth: "light", ts: 1 }), undefined, "missing v ⇒ malformed");

	// latest-wins over the branch (the same resolution as mode/goal)
	const plain = (r: SamDepthRecord, i: number): PlainEntry => ({ id: `e${i}`, kind: "custom", customType: "sam", data: r } as PlainEntry);
	const autoFirst = plain({ v: 1, kind: "depth", depth: "light", ts: 1 }, 0);
	const toFull = plain({ v: 1, kind: "depth", depth: "full", ts: 2 }, 1);
	const backToAuto = plain({ v: 1, kind: "depth", depth: "auto", ts: 3 }, 2);
	assert.equal(latestAuditDepth([autoFirst]), "light");
	assert.equal(latestAuditDepth([autoFirst, toFull]), "full", "a later record wins");
	assert.equal(latestAuditDepth([autoFirst, toFull, backToAuto]), "auto", "explicit 'auto' releases back to the default (consumers treat it as unset)");
	assert.equal(latestAuditDepth([{ id: "x", kind: "message" } as PlainEntry]), undefined, "no records ⇒ unset");
});

/* ══ B. the GLUE ═════════════════════════════════════════════════════════ */

interface PiEntry {
	id: string;
	type: "message" | "custom" | "compaction" | "context_edit";
	message?: { role: string; content: unknown; timestamp?: number; toolCallId?: string; toolName?: string; isError?: boolean };
	customType?: string;
	data?: unknown;
}
interface ToolResult { content: { type: string; text: string }[]; details?: unknown }
interface FakeToolDef {
	name: string;
	description?: string;
	executionMode?: string;
	execute: (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
}
interface FakePi {
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	tools: Map<string, FakeToolDef>;
	listeners: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
	appended: { customType: string; data?: unknown }[];
	sent: { text: string; options?: { deliverAs?: string } }[];
	notifyCalls: { text: string; type?: string }[];
	branch: PiEntry[];
	contextUsage?: { tokens: number | null; contextWindow: number };
	idle: boolean;
}
function makeFakePi(branch: PiEntry[] = []): FakePi {
	return { commands: new Map(), tools: new Map(), listeners: new Map(), appended: [], sent: [], notifyCalls: [], branch, idle: true };
}
let seq = 0;
const nextId = () => `d${++seq}`;
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}): PiEntry => ({ id: nextId(), type: "message", message: { role, content, timestamp: Date.now(), ...extra } });
function makeApi(f: FakePi) {
	return {
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => f.commands.set(name, def),
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
			f.idle = false;
		},
	};
}
function makeFakeCtx(f: FakePi, sessionFile: string): Record<string, unknown> {
	return {
		ui: { notify: (text: string, type?: string) => f.notifyCalls.push({ text, type }) },
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		isIdle: () => f.idle,
		waitForIdle: async () => {
			f.idle = true;
		},
		sessionManager: {
			getBranch: () => f.branch,
			getEntry: (id: string) => f.branch.find((e) => e.id === id) ?? null,
			getSessionFile: () => sessionFile,
			getSessionDir: () => path.dirname(sessionFile),
			getLeafId: () => (f.branch.length > 0 ? f.branch[f.branch.length - 1].id : null),
		},
		model: { provider: "qube", id: "test-model" },
		getContextUsage: () => f.contextUsage,
	};
}
async function load(pi: FakePi, ctx: Record<string, unknown>): Promise<void> {
	factory(makeApi(pi) as never);
	const starts = pi.listeners.get("session_start") ?? [];
	assert.equal(starts.length, 1, "exactly one session_start listener");
	await starts[0]({ reason: "startup" }, ctx);
}

/* the REAL close-audit child recipe (copied from the retire suite):
   writeFork builds the fork file the pipeline's VALIDATE step reads. */
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sam-depth-test-"));
const MAIN_FILE = path.join(WORKDIR, "main.jsonl");
function writeFork(unitId: number, reply: string, name = `fork-u${unitId}.jsonl`): string {
	const f = path.join(WORKDIR, name);
	const lines = [
		{ type: "session", id: "forkroot", version: 3, timestamp: "2026-10-01T00:00:00.000Z", cwd: WORKDIR },
		{ id: "instr", parentId: "forkroot", type: "message", message: { role: "user", content: `${AUDIT_INSTRUCTION_PREFIX} Unit ${unitId} was just closed. Audit the stub below.` } },
		{ id: "reply", parentId: "instr", type: "message", message: { role: "assistant", content: reply } },
	];
	fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return f;
}
function makeRunner(forkFile: string): CloseAuditRunner {
	return {
		run: async (args, opts) => {
			if (opts.label.startsWith("close-audit-prepare")) {
				const unitId = (opts.label.match(/u(\d+)$/) ?? [])[1] ?? "1";
				const stdout =
					"boot\n" +
					JSON.stringify({
						"sam-branch-prepare": { unitId: Number(unitId), forkFile, forkSessionId: `fork-${unitId}`, instruction: "[sam-audit] Unit " + unitId + " ..." },
					}) +
					"\n";
				return { code: 0, stdout, stderr: "", timedOut: false };
			}
			return { code: 0, stdout: "", stderr: "", timedOut: false };
		},
	};
}
const setRunnerFor = (forkFile: string) => __setCloseAuditRunner(makeRunner(forkFile));

async function closeUnit(pi: FakePi, ctx: Record<string, unknown>, stub: string, toolCallId: string): Promise<ToolResult> {
	const tool = pi.tools.get("close_unit");
	assert.ok(tool, "the close_unit tool must be registered");
	const result = (await tool.execute(toolCallId, { stub }, new AbortController().signal, undefined, ctx)) as ToolResult;
	pi.branch.push({ id: nextId(), type: "message", message: { role: "toolResult", content: [{ type: "text", text: (result.content[0] as { text: string }).text }], timestamp: Date.now(), toolCallId, toolName: "close_unit", isError: false } });
	return result;
}
const samDepthRecords = (pi: FakePi) =>
	pi.appended.filter((a) => a.customType === "sam").map((a) => a.data as Record<string, unknown>).filter((d) => d.kind === "depth");
const closeRecords = (pi: FakePi) =>
	pi.appended.filter((a) => a.customType === "sam").map((a) => a.data as Record<string, unknown>).filter((d) => d.kind === "close");

const withEnv = (key: string, value: string | undefined): (() => void) => {
	const prev = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	return () => {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	};
};
// the /sam command surface (the fake pi's command map)
const sam = (pi: FakePi) => pi.commands.get("sam")!;

test("GLUE: /sam depth light + calm zone + env auto ⇒ the close is audited LIGHT and the close record says source 'command' (decision-in-ledger)", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "off");
	const restoreEnv = withEnv("SAM_AUDIT_DEPTH", undefined); // env auto
	try {
		const pi = makeFakePi([msg("user", "task one, done in full")]);
		pi.contextUsage = { tokens: 30_000, contextWindow: 131_072 }; // calm zone ⇒ the zone call is FULL
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		// the switch (no arg first ⇒ the status names the default; then set light)
		await sam(pi).handler("depth", ctx);
		assert.ok(pi.notifyCalls.some((c) => /audit depth: auto/.test(c.text)), "no arg ⇒ the status line (env auto: the zone decides)");
		await sam(pi).handler("depth light", ctx);
		assert.ok(pi.notifyCalls.some((c) => /audit depth is now 'light'/.test(c.text)), "the set-ack names the value");
		assert.equal(samDepthRecords(pi).length, 1, "exactly one depth record on the ledger");

		setRunnerFor(writeFork(1, "VERIFIED\nFACTS: task one done\nEVIDENCE: T-D1", "fork-d1.jsonl"));
		const r1 = await closeUnit(pi, ctx, "did task one", "tc-d1");
		assert.match(r1.content[0].text as string, /Unit 1 closed — audit VERIFIED/);
		const rec1 = closeRecords(pi).find((d) => d.unitId === 1);
		assert.ok(rec1, "u1's close record is on the ledger");
		assert.equal(rec1.depth, "light", "the command FORCED light despite the calm zone (the user said so — the zone call is FULL without it)");
		assert.equal(rec1.depthSource, "command", "the source is recorded: /sam depth (auditable from the file)");
	} finally {
		restoreNudge();
		restoreEnv();
		__setCloseAuditRunner(null);
	}
});

test("GLUE: precedence — the command beats the env dial; the RETIRE-CARRY marker beats BOTH (decision-in-ledger carries the winner)", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "off");
	const restoreEnv = withEnv("SAM_AUDIT_DEPTH", "full"); // env wants FULL
	try {
		const pi = makeFakePi([msg("user", "task two, done in full")]);
		pi.contextUsage = { tokens: 30_000, contextWindow: 131_072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		// (a) env full + command light ⇒ the COMMAND wins (explicit in-session intent > machine default)
		await sam(pi).handler("depth light", ctx);
		setRunnerFor(writeFork(1, "NOT-YET-VERIFIED: files: 1/1 present; statements: delivered", "fork-d2.jsonl"));
		await closeUnit(pi, ctx, "did task two", "tc-d2");
		const rec1 = closeRecords(pi).find((d) => d.unitId === 1);
		assert.equal(rec1?.depth, "light", "command light beats env full");
		assert.equal(rec1?.depthSource, "command", "source recorded: command");

		// (b) command full + RETIRE-CARRY marker ⇒ the MARKER wins (a carrier's close is ALWAYS light — Paul's 2026-10-06 defect #2)
		await sam(pi).handler("depth full", ctx);
		// toPlainEntries (index.ts:327) maps the branch's raw `type` to PlainEntry's `kind`
		// — the test mimics that mapping for the customs.
		const plain = pi.branch.filter((e) => e.type === "custom" && e.customType === "sam").map((e) => ({ id: e.id, kind: "custom", customType: e.customType, data: e.data })) as PlainEntry[];
		assert.equal(latestAuditDepth(plain), "full", "latest-wins: the switch now says full");
		pi.branch.push(msg("user", "carry the still-relevant parts of u1 forward"));
		setRunnerFor(writeFork(2, "NOT-YET-VERIFIED: files: 1/1 present; statements: delivered", "fork-d3.jsonl"));
		await closeUnit(pi, ctx, "RETIRE-CARRY u1\nthe curated carry-over of u1", "tc-d3");
		const rec2 = closeRecords(pi).find((d) => d.unitId === 2);
		assert.equal(rec2?.depth, "light", "the marker beats the command full (strongest source)");
		assert.equal(rec2?.depthSource, "retire-carry", "source recorded: the carrier marker");
		assert.equal(rec2?.depthForced, "retire-carry", "the existing forced-depth field carries the same fact");
	} finally {
		restoreNudge();
		restoreEnv();
		__setCloseAuditRunner(null);
	}
});

test("GLUE: the switch is total — a bad value is refused (no record, no silent default); 'auto' releases back to the default (a record, explicitly)", async () => {
	const restoreNudge = withEnv("SAM_NUDGE", "off");
	const restoreEnv = withEnv("SAM_AUDIT_DEPTH", undefined);
	try {
		const pi = makeFakePi([msg("user", "task three")]);
		pi.contextUsage = { tokens: 30_000, contextWindow: 131_072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		const before = samDepthRecords(pi).length;
		await sam(pi).handler("depth bogus", ctx);
		assert.ok(pi.notifyCalls.some((c) => c.type === "error" && /unknown depth 'bogus'/.test(c.text) && /auto \| full \| light/.test(c.text)), "the refusal names the bad value + the allowed set");
		assert.equal(samDepthRecords(pi).length, before, "a refusal appends NOTHING (fail-closed on the input)");

		await sam(pi).handler("depth auto", ctx);
		assert.equal(samDepthRecords(pi).length, before + 1, "'auto' is a legitimate, explicitly recorded release back to the default");
		const last = samDepthRecords(pi).at(-1);
		assert.equal(last?.depth, "auto");
	} finally {
		restoreNudge();
		restoreEnv();
		__setCloseAuditRunner(null);
	}
});

/**
 * v4 close-audit handler matrix (S4 gate, v4-plan §5): the close-audit
 * pipeline (the only delivery mode since 2026-10-16 — the SAM_AUDIT_DELIVERY
 * dial is REMOVED) driven through the fake ExtensionAPI + an INJECTABLE child
 * runner (the suite never spawns a real process — the live probe banks do
 * that; the followUp/steer glue tests went 2026-10-16 with Wave A).
 *
 * The fake child runner scripts the two children (prepare = model-free
 * `sam-prepare-audit <n>` with its handoff — the internal command that
 * replaced the user-facing `/sam audit` 2026-10-16; audit = one model turn
 * whose reply is
 * banked pre-run in a fake fork session file the pipeline reads from disk —
 * the validate step is real (pure, file-based) exactly as in production).
 *
 * Run: node --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["SAM_SETTINGS_JSON"] = JSON.stringify({ extensions: ["pi-self-aware-memory"] });
process.env["SAM_SUMMARY_MODE"] = "main"; // v0.0.25: this suite pins MAIN mode (the control arm — "exactly today's behaviour"); fork mode has its own tests + probe Runs D/E/F

import factory, { __setCloseAuditRunner, __setArmAuditCompaction, __closeAuditRunnerNow, type CloseAuditRunner } from "../extensions/self-aware-memory/index.ts";
import { AUDIT_INSTRUCTION_PREFIX, CLOSE_UNIT_NO_NEW_WORK_TEXT, CLOSE_UNIT_AUDIT_FORK_TEXT, summaryChildInstruction } from "../src/protocol.ts";
import { GOAL_NUDGE_TEXTS } from "../src/goal-nudge.ts";
import { FOLD_NOW_AUDIT_FORK_TEXT, FOLD_NOW_DISABLED_TEXT, FOLD_NOW_IN_FLIGHT_TEXT, FOLD_NOW_TRIGGERED_TEXT, foldAckText, foldFailText } from "../src/fold.ts"; // v0.0.4 FOLD

/* ── fakes (the extension.test.ts shape) ─────────────────────────────────── */

interface PiEntry {
	id: string;
	type: "message" | "custom" | "context_edit" | "compaction";
	message?: { role: string; content: unknown; timestamp?: number; toolCallId?: string; toolName?: string; isError?: boolean };
	customType?: string;
	data?: unknown;
}
interface ToolResult { content: { type: string; text: string }[]; details?: unknown }
interface FakeToolDef {
	name: string;
	description?: string;
	executionMode?: string;
	execute: (toolCallId: string, params: { stub: string }, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
}
interface FakePi {
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	tools: Map<string, FakeToolDef>;
	listeners: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
	appended: { customType: string; data?: unknown }[];
	sent: { text: string; options?: { deliverAs?: string } }[];
	// v0.0.4 FOLD: pi.sendMessage captures (the sam-fold-ack channel — a
	// CustomMessageEntry, in contrast to sendUserMessage's steers) and the
	// ctx.compact calls (options incl. onComplete/onError — the test fires
	// them by hand, the way pi's manual path would).
	sentMessages: { message: { customType: string; content: string; display?: boolean }; options?: { deliverAs?: string; triggerTurn?: boolean } }[];
	compactCalls: unknown[];
	notifyCalls: { text: string; type?: string }[];
	branch: PiEntry[];
	contextUsage?: { tokens: number | null; contextWindow: number };
	idle: boolean;
}
function makeFakePi(branch: PiEntry[] = []): FakePi {
	return { commands: new Map(), tools: new Map(), listeners: new Map(), appended: [], sent: [], sentMessages: [], compactCalls: [], notifyCalls: [], branch, idle: true };
}
let seq = 0;
const nextId = () => `c${++seq}`;
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}): PiEntry => ({ id: nextId(), type: "message", message: { role, content, timestamp: Date.now(), ...extra } });
const closeCallAssistant = (stub: string): PiEntry => {
	const call = { type: "toolCall", id: "willBeReplaced", name: "close_unit", arguments: { stub } };
	return { id: nextId(), type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "done" }, call], timestamp: Date.now() } as never };
};
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
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => { f.sent.push({ text, options }); f.idle = false; },
		// v0.0.4 FOLD: the sam-fold-ack channel (a CustomMessageEntry —
		// participates in the LLM context, unlike appendEntry).
		sendMessage: (message: { customType: string; content: string }, options?: { deliverAs?: string; triggerTurn?: boolean }) => {
			f.sentMessages.push({ message, options });
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
			getLeafId: () => f.branch.length > 0 ? f.branch[f.branch.length - 1].id : null,
		},
		model: { provider: "qube", id: "test-model" },
		getContextUsage: () => f.contextUsage,
		// v0.0.4 FOLD: the ctx.compact spy — records the options (the
		// test fires onComplete/onError by hand, the way pi's manual path
		// would; the real path aborts the turn first, F1).
		compact: (options?: unknown) => { f.compactCalls.push(options); },
	};
}
async function load(pi: FakePi, ctx: Record<string, unknown>): Promise<void> {
	factory(makeApi(pi) as never);
	const starts = pi.listeners.get("session_start") ?? [];
	assert.equal(starts.length, 1, "exactly one session_start listener");
	await starts[0]({ reason: "startup" }, ctx);
}
async function closeUnit(pi: FakePi, ctx: Record<string, unknown>, stub: string, toolCallId: string): Promise<ToolResult> {
	const tool = pi.tools.get("close_unit");
	assert.ok(tool, "the close_unit tool must be registered");
	const result = await tool.execute(toolCallId, { stub }, new AbortController().signal, undefined, ctx);
	pi.branch.push(msg("toolResult", (result.content[0] as { text: string }).text, { toolCallId, toolName: "close_unit", isError: false }));
	return result;
}
async function settle(pi: FakePi, ctx: Record<string, unknown>): Promise<unknown> {
	const settles = pi.listeners.get("agent_before_settle") ?? [];
	assert.equal(settles.length, 1, "exactly one agent_before_settle listener");
	return (settles[0] as (e: unknown, c: unknown) => unknown)({ turn: 1 }, ctx);
}

/* ── the scripted children ───────────────────────────────────────────────── */

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sam-close-audit-test-"));
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

interface ChildScript {
	prepare?: { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean };
	audit?: { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean };
	throw?: string;
	forkFile?: string;
	// v0.0.25 fork mode: the stub stage (the stub-prepare handoff + the stub child's run)
	stubPrepare?: { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean };
	stubChild?: { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean };
	stubForkFile?: string;
}
function makeRunner(script: ChildScript): { runner: CloseAuditRunner; calls: { label: string; args: string[]; env?: Record<string, string> }[] } {
	const calls: { label: string; args: string[]; env?: Record<string, string> }[] = [];
	const runner: CloseAuditRunner = {
		run: async (args, opts) => {
			calls.push({ label: opts.label, args: [...args], ...(opts.env !== undefined ? { env: { ...opts.env } } : {}) });
			if (script.throw) throw new Error(script.throw);
			if (opts.label.startsWith("stub-prepare")) {
				// v0.0.25: the stub stage's model-free prepare (fork at the leaf, no unit lookup)
				const s = script.stubPrepare ?? { code: 0 };
				const forkFile = script.stubForkFile ?? path.join(WORKDIR, "stubfork.jsonl");
				const unitId = (opts.label.match(/u(\d+)$/) ?? [])[1] ?? "1";
				const stdout = s.stdout !== undefined ? s.stdout : "boot\n" + JSON.stringify({
					"sam-branch-prepare": { unitId: Number(unitId), forkFile, forkSessionId: `stubfork-${unitId}`, instruction: `[sam-stub] Unit ${unitId} ...` },
				}) + "\n";
				return { code: s.code, stdout, stderr: s.stderr ?? "", timedOut: s.timedOut ?? false };
			}
			if (opts.label.startsWith("stub-child")) {
				const s = script.stubChild ?? { code: 0 };
				return { code: s.code, stdout: s.stdout ?? "", stderr: s.stderr ?? "", timedOut: s.timedOut ?? false };
			}
			if (opts.label.startsWith("close-audit-prepare")) {
				const s = script.prepare ?? { code: 0 };
				const forkFile = script.forkFile ?? path.join(WORKDIR, "fork.jsonl");
				const unitId = (opts.label.match(/u(\d+)$/) ?? [])[1] ?? "1";
				const stdout = s.stdout !== undefined ? s.stdout : "boot\n" + JSON.stringify({
					"sam-branch-prepare": { unitId: Number(unitId), forkFile, forkSessionId: `fork-${unitId}`, instruction: "[sam-audit] Unit " + unitId + " ..." },
				}) + "\n";
				return { code: s.code, stdout, stderr: s.stderr ?? "", timedOut: s.timedOut ?? false };
			}
			const s = script.audit ?? { code: 0 };
			return { code: s.code, stdout: s.stdout ?? "", stderr: s.stderr ?? "", timedOut: s.timedOut ?? false };
		},
	};
	return { runner, calls };
}

function samRecords(pi: FakePi) {
	return pi.appended.filter((a) => a.customType === "sam").map((a) => a.data as { kind: string; unitId?: number });
}
const settledEntries = (out: unknown): PiEntry[] => ((out as { entries?: PiEntry[] })?.entries ?? []);

/* D10-A (2026-10-13): the suite must never touch the real settings.json —
 * install a recording fake arm for this file (node --test runs each file in
 * its own process; the invariant asserted in the tests below is that every
 * arm is followed by its disarm). */
const armState = { arm: 0, disarm: 0 };
__setArmAuditCompaction(async () => {
	armState.arm += 1;
	return {
		disarm: () => {
			armState.disarm += 1;
		},
	};
});

/* ── the matrix ──────────────────────────────────────────────────────────── */

test("close dial: the audit runs synchronously inside close_unit; VERIFIED one-line result; the settlement + resolve commit AT VERDICT (D9) — nothing audit-flavored on the main line", async () => {
	seq = 0;
	const reply = "VERIFIED\nFACTS: data.txt was written with 42\nEVIDENCE: MARKER-1";
	writeFork(1, reply, "fork-u1.jsonl");
	const { runner, calls } = makeRunner({ forkFile: path.join(WORKDIR, "fork-u1.jsonl") });
	__setCloseAuditRunner(runner);
	try {
		const u = msg("user", "write data.txt with the number 42");
		const goalAnchor = { id: "goal-anchor", type: "custom", customType: "sam", data: { v: 1, kind: "goal", text: "the standing goal", ts: 1, basis: "adjust-goal" } }; // a stored goal ⇒ the 2026-10-04 close-time goal nudge retires — this test pins the audit channel, not the goal offer
		const pi = makeFakePi([u, goalAnchor]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit VERIFIED \([0-9a-f]{12}\) — stub: 1 line · 22 chars$/);
		assert.equal(pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close").length, 1, "the close record is committed file-durable");
		assert.equal(pi.sent.length, 0, "no in-series audit message on the main line");
		assert.equal(calls.length, 2, "prepare + audit child exactly");
		assert.ok(armState.arm >= 1, "D10-A: the arm ran before the audit child");
		assert.equal(armState.disarm, armState.arm, "D10-A: every arm was disarmed (compaction restored before the result)");
		assert.ok(calls[0].args.at(-1) === "/sam-prepare-audit 1", "prepare child runs the internal model-free command (the user-facing /sam audit was REMOVED 2026-10-16 — Paul: the user does not trigger audits)");
		assert.ok(calls[0].args.includes("--session") && calls[0].args.includes(MAIN_FILE), "the prepare child is pinned to the MAIN session file (D1 — without it the child sees a fresh empty session where unit 1 does not exist)");
		assert.ok(calls[1].args.includes("--session") && calls[1].args.includes(path.join(WORKDIR, "fork-u1.jsonl")), "audit child is pinned to the FORK FILE (path — the strongest pin; --session-id would silently create a new session on a miss)");
		const auditPrompt = calls[1].args[calls[1].args.indexOf("-p") + 1];
		assert.ok(auditPrompt.startsWith(AUDIT_INSTRUCTION_PREFIX + " Unit 1"), "the audit prompt is the v3 branch instruction");
		// the main line in view: user → close call → close toolResult (the one-line result) — zero [sam-]
		assert.ok(!pi.branch.some((e) => e.type === "message" && typeof (e.message?.content as string) === "string" && (e.message?.content as string).startsWith("[sam-")), "main line stays audit-free");

		// D9 (2026-10-02, settle-at-verdict): the settlement + resolve commit
		// AT VERDICT, inside close_unit (crash-safe pi.appendEntry) — not at
		// the close turn's settle boundary (the run-02 incident: that boundary
		// never came; the fold preempted the settle). Settle keeps only as the
		// idempotent backstop: it must commit NOTHING new here (strong ⇒ skip).
		const recs = samRecords(pi);
		const settlement = recs.find((r) => r.kind === "settlement");
		const resolve = recs.find((r) => r.kind === "resolve");
		assert.ok(settlement, "the settlement record commits at verdict time (inside close_unit)");
		assert.ok(resolve, "the resolve terminal commits with it");
		const sIdx = recs.findIndex((r) => r === settlement);
		const rIdx = recs.findIndex((r) => r === resolve);
		assert.ok(sIdx !== -1 && rIdx !== -1 && sIdx < rIdx, "settlement → resolve order (canonical)");
		const sdata = settlement as unknown as { unitId: number; retrievalId: string; verdict: string; line: string; auditFile: string };
		assert.equal(sdata.unitId, 1);
		assert.equal(sdata.verdict, "VERIFIED");
		assert.equal(sdata.line, `${sdata.retrievalId.slice(0, 12)} VERIFIED: data.txt was written with 42, evidence: MARKER-1`); // the v3 settlementLine format (no parens) 
		assert.equal((resolve as unknown as { basis: string }).basis, "close-audit");
		// D9 backstop: the settle boundary commits nothing new (the strong
		// settlement is already on the branch ⇒ idempotence-skip).
		const out = await settle(pi, ctx);
		const entries = settledEntries(out);
		assert.equal(entries.filter((e) => (e.data as { kind?: string })?.kind === "settlement").length, 0, "backstop: no duplicate settlement at settle");
		// no fold draft, no context edits at all (no fold at close — D1)
		assert.equal(entries.filter((e) => e.type === "context_edit").length, 0);
		// file-derived state: the unit is resolved (a fresh process reading the file agrees)
		const pi2 = makeFakePi(pi.branch.map((e) => ({ ...e })));
		const ctx2 = makeFakeCtx(pi2, MAIN_FILE);
		await load(pi2, ctx2);
		pi2.commands.get("sam")?.handler("status", ctx2);
		const status = pi2.notifyCalls.map((c) => c.text).join("\n");
		assert.match(status, /resolved 1/);
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close dial: CORRECTIONS ride the settlement line and the terminal (verdict CORRECTIONS); both commit at verdict (D9)", async () => {
	seq = 0;
	writeFork(1, "CORRECTIONS: the count is 7, not 42\nFACTS: data.txt was written\n", "fork-c.jsonl");
	const { runner } = makeRunner({ forkFile: path.join(WORKDIR, "fork-c.jsonl") });
	__setCloseAuditRunner(runner);
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit CORRECTIONS: the count is 7, not 42 \([0-9a-f]{12}\) — stub: 1 line · 22 chars$/);
		// D9: the settlement + resolve commit at verdict time (not at the settle boundary).
		const settlement = samRecords(pi).find((r) => r.kind === "settlement");
		assert.equal((settlement as unknown as { verdict?: string })?.verdict, "CORRECTIONS");
		assert.equal((settlement as unknown as { line?: string }).line, `${((settlement as unknown as { retrievalId?: string }).retrievalId ?? "").slice(0, 12)} CORRECTIONS: the count is 7, not 42, data.txt was written`);
		const resolve = samRecords(pi).find((r) => r.kind === "resolve");
		assert.equal((resolve as unknown as { verdict?: string })?.verdict, "CORRECTIONS", "the terminal carries the verdict (the fold would have been the override in v3 — v4 has no fold at close)");
		// D9 backstop: the settle commits nothing new (strong ⇒ idempotence-skip).
		const out = await settle(pi, ctx);
		assert.equal(settledEntries(out).filter((e) => (e.data as { kind?: string })?.kind === "settlement").length, 0);
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close dial: the audit child dies ⇒ the close settles UNVERIFIED (audit-failed) AT CLOSE (D9 hatch — the content survives channel A); the close stays committed; the unit stays upgradable", async () => {
	seq = 0;
	const { runner, calls } = makeRunner({ audit: { code: 2, stderr: "boom" } });
	__setCloseAuditRunner(runner);
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt", "tc1");
		const text = res.content[0].text as string;
		assert.match(text, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; audit-exit-failed\)\./);
		assert.match(text, /audit-exit-failed/);
		assert.match(text, /verify its claims before acting/);
		assert.match(text, /close_unit again with the same stub/);
		assert.equal(pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close").length, 1, "the close is committed even on audit failure");
		assert.equal(calls.length, 2, "prepare ran; audit ran and failed");
		assert.equal(armState.disarm, armState.arm, "D10-A: disarmed even when the audit child fails");
		// D9 hatch commit: the weak settlement rides the close record's own
		// stub + evidence (nothing re-derived) — channel A survives the fold.
		const settlement = samRecords(pi).find((r) => r.kind === "settlement");
		assert.ok(settlement, "the audit-failed settlement commits at close time (the content survives)");
		assert.equal((settlement as unknown as { verdict: string }).verdict, "UNVERIFIED-AUDIT-FAILED");
		assert.match((settlement as unknown as { line: string }).line, /UNVERIFIED-AUDIT-FAILED: wrote data\.txt/);
		assert.match((settlement as unknown as { line: string }).line, /claims UNVERIFIED: verify before acting/);
		// backstop: the failure path stages nothing ⇒ the settle commits nothing new.
		const out = await settle(pi, ctx);
		assert.equal(settledEntries(out).filter((e) => (e.data as { kind?: string })?.kind === "settlement").length, 0);
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close dial: the prepare child dies ⇒ UNVERIFIED (audit-failed: prepare-exit-failed) settles at close (D9 hatch); the close stays committed", async () => {
	seq = 0;
	const { runner } = makeRunner({ prepare: { code: 1, stderr: "cli failed" } });
	const armsBefore = armState.arm;
	__setCloseAuditRunner(runner);
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; prepare-exit-failed\)\./);
		assert.match(res.content[0].text as string, /child output: stdout: [^|]* \| stderr: cli failed/); // v0.0.14: the diagnostic detail rides the line (4 KB capped)
		assert.equal(pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close").length, 1);
		assert.equal(armState.arm, armsBefore, "D10-A: no arm when the prepare child dies (the audit step never runs)");
		// D9 hatch: the weak settlement committed with the stub from the close record.
		const settlement = samRecords(pi).find((r) => r.kind === "settlement");
		assert.ok(settlement, "the audit-failed settlement commits at close time");
		assert.equal((settlement as unknown as { verdict: string }).verdict, "UNVERIFIED-AUDIT-FAILED");
		assert.match((settlement as unknown as { line: string }).line, /UNVERIFIED-AUDIT-FAILED: wrote data\.txt/);
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close dial: NO handoff in the child output ⇒ UNVERIFIED (audit-failed: handoff-missing) settles at close (D9 hatch)", async () => {
	seq = 0;
	const { runner } = makeRunner({ prepare: { code: 0, stdout: "boot\nno handoff here\n" } });
	__setCloseAuditRunner(runner);
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; handoff-missing\)\./);
		assert.match(res.content[0].text as string, /child output: stdout: boot no handoff here/); // v0.0.14: the child's actual output is banked in the why
		assert.match(res.content[0].text as string, /verify its claims before acting/);
		const settlement = samRecords(pi).find((r) => r.kind === "settlement");
		assert.equal((settlement as unknown as { verdict?: string })?.verdict, "UNVERIFIED-AUDIT-FAILED", "the hatch committed the weak settlement");
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close dial D5+D9: audit-failed close then re-close over the SAME stub ⇒ UPGRADE the SAME unit — no second close record, the strong settlement appends with `supersedes` (the weak stays — append-only)", async () => {
	seq = 0;
	const goodReply = "VERIFIED\nFACTS: data.txt was written with 42";
	writeFork(1, goodReply, "fork-retry.jsonl");
	const calls: string[] = [];
	const flip: { failed: boolean } = { failed: true };
	const runner: CloseAuditRunner = {
		run: async (args, opts) => {
			calls.push(opts.label);
			if (opts.label.startsWith("close-audit-prepare")) {
				const unitId = (opts.label.match(/u(\d+)$/) ?? [])[1];
				const forkFile = path.join(WORKDIR, `fork-retry.jsonl`);
				return { code: 0, stdout: "boot\n" + JSON.stringify({ "sam-branch-prepare": { unitId: Number(unitId), forkFile, forkSessionId: `f-${unitId}`, instruction: "[sam-audit] Unit " + unitId + " ..." } }) + "\n", stderr: "", timedOut: false };
			}
			return flip.failed ? { code: 3, stdout: "", stderr: "audit died", timedOut: false } : { code: 0, stdout: "", stderr: "", timedOut: false };
		},
	};
	__setCloseAuditRunner(runner);
	try {
		const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		// attempt 1: audit child fails ⇒ the close settles WEAK (D9 hatch)
		const r1 = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc1");
		assert.match(r1.content[0].text as string, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; audit-exit-failed\)\./);
		assert.match(r1.content[0].text as string, /child output: stderr: audit died/); // v0.0.14: the diagnostic detail rides the line (4 KB capped)
		const weak = samRecords(pi).find((r) => r.kind === "settlement");
		assert.equal((weak as unknown as { verdict?: string })?.verdict, "UNVERIFIED-AUDIT-FAILED", "attempt 1 settled the weak (audit-failed) form");

		// attempt 2: the model re-closes over the SAME close (same stub — the D9
		// upgrade lever) — audit succeeds ⇒ the STRONG settlement appends, naming the weak one in `supersedes`
		flip.failed = false;
		const r2 = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc2");
		assert.match(r2.content[0].text as string, /^Unit 1 closed — audit VERIFIED/);
		assert.match(r2.content[0].text as string, /Unit 1 closed/, "still UNIT 1 — the retry did NOT mint unit 2");

		// file-derived: exactly ONE close record in the whole file (D5 — no duplicate)
		const closes = pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close");
		assert.equal(closes.length, 1, "exactly one close record — the upgrade re-audited the existing unit");
		assert.equal(closes[0].data.unitId, 1);

		// the settlement trail: WEAK then STRONG, the strong one naming the weak
		const settlements = samRecords(pi).filter((r) => r.kind === "settlement");
		assert.equal(settlements.length, 2, "the weak settlement stays (append-only); the strong one appends");
		assert.equal((settlements[0] as unknown as { verdict: string }).verdict, "UNVERIFIED-AUDIT-FAILED");
		assert.equal((settlements[1] as unknown as { verdict: string }).verdict, "VERIFIED");
		assert.equal((settlements[1] as unknown as { supersedes?: string }).supersedes, (settlements[0] as unknown as { retrievalId: string }).retrievalId, "the strong settlement names the weak one it replaces");
		// backstop: a STRONG settlement is now on the branch ⇒ the settle commits nothing new
		const out = await settle(pi, ctx);
		assert.equal(settledEntries(out).filter((e) => (e.data as { kind?: string })?.kind === "settlement").length, 0);
		assert.equal(calls.filter((l) => l.startsWith("close-audit-prepare")).length, 2, "two prepare children (one per attempt)");
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close dial: a DIFFERENT stub over an unsettled close with no new work ⇒ actionable refusal (the v4 replacement for CLOSE_UNIT_PENDING)", async () => {
	seq = 0;
	const { runner } = makeRunner({ audit: { code: 2 } });
	__setCloseAuditRunner(runner);
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		await closeUnit(pi, ctx, "wrote data.txt", "tc1"); // first close (audit fails ⇒ weak-settled — D9 hatch)
		const r2 = await closeUnit(pi, ctx, "did something else entirely", "tc2");
		assert.equal(r2.content[0].text as string, CLOSE_UNIT_NO_NEW_WORK_TEXT);
		assert.equal(pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close").length, 1, "no second close record");
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close dial: inside an audit side-session, close_unit refuses (the audit-fork guard)", async () => {
	seq = 0;
	const { runner } = makeRunner({});
	__setCloseAuditRunner(runner);
	try {
		const u = msg("user", "write data.txt");
		const pi = makeFakePi([u]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		// model the fork shape: the close record + its toolResult + the [sam-audit] instruction on the line
		// the real close record shape (protocol: v, kind, unitId, stub, toolCallId — the
		// fork-identity guard keys on the real record, toolCallId included)
		const rec = { v: 1, kind: "close", unitId: 1, stub: "wrote data.txt", toolCallId: "tcA", ts: 0 };
		pi.appended.push({ customType: "sam", data: rec });
		pi.branch.push({ id: nextId(), type: "custom", customType: "sam", data: rec });
		pi.branch.push(msg("toolResult", "Unit 1 closed — audit VERIFIED (abcd1234ef56)", { toolCallId: "tcx", toolName: "close_unit" }));
		pi.branch.push(msg("user", `${AUDIT_INSTRUCTION_PREFIX} Unit 1 was just closed…`));
		const res = await closeUnit(pi, ctx, "whatever", "tc3");
		assert.equal(res.content[0].text as string, CLOSE_UNIT_AUDIT_FORK_TEXT);
		// the seeded (pre-existing) fork record stays; NO new close record was committed
		const newCloses = pi.appended.filter((a) => { const d = a.data as { kind?: string; toolCallId?: string }; return d?.kind === "close" && d.toolCallId === "tc3"; });
		assert.equal(newCloses.length, 0, "nothing new committed inside the audit fork");
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close dial: a crashed pipeline is reported honestly at the AUDIT step (the close stays committed; the failure is a spawn failure, not a handoff)", async () => {
	seq = 0;
	const runner: CloseAuditRunner = {
		run: async (_args, opts) => {
			if (opts.label.startsWith("close-audit-prepare")) {
				return { code: 0, stdout: "boot\n" + JSON.stringify({ "sam-branch-prepare": { unitId: 1, forkFile: path.join(WORKDIR, "fx.jsonl"), forkSessionId: "fx", instruction: AUDIT_INSTRUCTION_PREFIX + " Unit 1 ..." } }) + "\n", stderr: "", timedOut: false };
			}
			throw new Error("audit child crashed");
		},
	};
	__setCloseAuditRunner(runner);
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; audit-spawn-failed\)\./);
		assert.match(res.content[0].text as string, /audit child crashed/);
		// D9: the hatch commit is honest about the AUDIT step (spawn failure, not handoff)
		const settlement = samRecords(pi).find((r) => r.kind === "settlement");
		assert.equal((settlement as unknown as { verdict?: string })?.verdict, "UNVERIFIED-AUDIT-FAILED");
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close dial: the audit child times out ⇒ UNVERIFIED (audit-failed: audit-timeout) settles at close (D9 hatch), the close stays committed", async () => {
	seq = 0;
	const { runner } = makeRunner({ audit: { code: null, timedOut: true } });
	__setCloseAuditRunner(runner);
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; audit-timeout\)\./);
		assert.match(res.content[0].text as string, /\(child output: no output\)/); // v0.0.14: the timeout message now carries the (empty here) child output detail
		assert.equal(pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close").length, 1);
		assert.equal(armState.disarm, armState.arm, "D10-A: disarmed on the timeout path too (the runner resolved after the SIGKILL)");
		const settlement = samRecords(pi).find((r) => r.kind === "settlement");
		assert.equal((settlement as unknown as { verdict?: string })?.verdict, "UNVERIFIED-AUDIT-FAILED", "the timeout settled the weak form (the content survives)");
	} finally {
		__setCloseAuditRunner(null);
	}
});

/* 2026-10-04 (F-12 class, banked rep-12 u4, BOTH attempts measured verbatim:
   last assistant turn = one thinking fragment, stopReason "length",
   usage.output 1, no text). The missing-reply CLASS split: the child EXITS 0
   (no pipe/spawn defect), but its last audit turn was a thinking-only turn
   cut at stopReason "length" — the per-request output budget ran out (a budget
   limit, NOT a transport/pipe defect). The class rides the one-liner AND the
   settlement REASON so the operator (and the battery) read WHY the audit
   failed. Same no-reply shape with a non-truncated last turn ⇒ the
   transport-class reason stays `reply-missing`. Wording = pins. */

test("close dial (F-12 class): child exits 0 but its last turn is a length-cut thinking-only turn ⇒ audit-reply-truncated(length) on the one-liner AND the settlement REASON; the same no-reply shape with last turn 'stop' keeps reply-missing (the split is the measured stopReason and nothing else)", async () => {
	seq = 0;
	// the banked F-12 u4 shape (measured: instruction + a working turn + the
	// final thinking-only truncated turn; the thinking fragment "Now" is the
	// verbatim attempt-1 content — attempt 2 banked "F")
	const writeForkTruncated = (lastStopReason: string | undefined, name: string): string => {
		const f = path.join(WORKDIR, name);
		const lastMsg: Record<string, unknown> = { role: "assistant", content: [{ type: "thinking", thinking: "Now" }], usage: { input: 27577, output: 1, cacheRead: 40078, cacheWrite: 0, totalTokens: 67656 } };
		if (lastStopReason !== undefined) lastMsg["stopReason"] = lastStopReason;
		const lines = [
			{ type: "session", id: "forkroot", version: 3, timestamp: "2026-10-04T00:00:00.000Z", cwd: WORKDIR },
			{ id: "instr", parentId: "forkroot", type: "message", message: { role: "user", content: `${AUDIT_INSTRUCTION_PREFIX} Unit 1 was just closed. Audit the stub below.` } },
			{ id: "step", parentId: "instr", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "check the raw span" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "raw.jsonl" } }] } },
			{ id: "res", parentId: "step", type: "message", message: { role: "toolResult", content: "raw span bytes" } },
			{ id: "final", type: "message", message: lastMsg },
		];
		fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		return f;
	};

	// class A (the F-12 verbatim shape): last turn stopReason "length"
	{
		const fork = writeForkTruncated("length", "f12a.jsonl");
		const { runner } = makeRunner({ forkFile: fork }); // prepare + audit both exit 0
		__setCloseAuditRunner(runner);
		const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc-f12a");
		const text = res.content[0].text as string;
		assert.match(text, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; audit-reply-truncated\(length\)\)\./, "the one-liner names the budget class (NOT reply-missing) — the operator reads WHY: budget limit, not a pipe defect");
		assert.match(text, /budget limit, not a transport\/pipe defect/);
		assert.match(text, /close_unit again with the same stub/, "the D5 upgrade lever stays named (a re-close re-audits the unit)");
		const settlement = samRecords(pi).find((r) => r.kind === "settlement");
		assert.equal((settlement as unknown as { verdict: string }).verdict, "UNVERIFIED-AUDIT-FAILED", "the close still settles the weak form (D9 hatch semantics unchanged)");
		assert.match((settlement as unknown as { line: string }).line, /audit failed \(audit-failed: audit-reply-truncated\(length\) —/, "the settlement REASON carries the class (the takeover-block readout)");
	}
	// class B (control): the SAME no-reply shape, last turn "stop" ⇒ the transport class
	{
		const fork = writeForkTruncated("stop", "f12b.jsonl");
		const { runner } = makeRunner({ forkFile: fork });
		__setCloseAuditRunner(runner);
		const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc-f12b");
		const text = res.content[0].text as string;
		assert.match(text, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; reply-missing\)\./, "a non-truncated last turn stays the transport/pipe class — the split is exactly the measured stopReason");
	}
	__setCloseAuditRunner(null);
});

test("close dial: the tool is sequential (serialization) and the v4 description is selected under the close dial", async () => {
	seq = 0;
	const pi = makeFakePi([msg("user", "hi")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	const tool = pi.tools.get("close_unit");
	assert.ok(tool);
	assert.equal(tool.executionMode, "sequential");
	assert.ok(tool.description, "the v4 copy describes the side-session audit");
	assert.match(tool.description, /Closing a unit starts the next one/);
});

test("close dial operator lever (D9): /sam reaudit <n> re-runs the audit of a WEAK-settled unit (the upgrade lever) — no ack turn; the strong settlement appends with `supersedes`; then refusal when STRONG-settled", async () => {
	seq = 0;
	writeFork(1, "VERIFIED\nFACTS: data.txt was written with 42", "fork-reaudit.jsonl");
	const okPrepare = () => ({ code: 0, stdout: "boot\n" + JSON.stringify({ "sam-branch-prepare": { unitId: 1, forkFile: path.join(WORKDIR, "fork-reaudit.jsonl"), forkSessionId: "fr1", instruction: AUDIT_INSTRUCTION_PREFIX + " Unit 1 ..." } }) + "\n", stderr: "", timedOut: false });
	__setCloseAuditRunner({
		run: async (_a, opts) => {
			if (opts.label.startsWith("close-audit-prepare")) return okPrepare();
			return { code: 5, stdout: "", stderr: "audit died", timedOut: false };
		},
	});
	try {
		const goalAnchor = { id: "goal-anchor", type: "custom", customType: "sam", data: { v: 1, kind: "goal", text: "the standing goal", ts: 1, basis: "adjust-goal" } }; // a stored goal ⇒ the 2026-10-04 close-time goal nudge retires — this test pins the reaudit lever, not the goal offer
		const pi = makeFakePi([msg("user", "write data.txt with the number 42"), goalAnchor]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		// the close happens, the audit fails ⇒ the close settles WEAK (D9 hatch)
		const r1 = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc1");
		assert.match(r1.content[0].text as string, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; audit-exit-failed\)\./);
		// the operator lever: re-audit unit 1 — the stub comes from the COMMITTED
		// record; a WEAK settlement is an upgrade target (D9); the audit succeeds now
		__setCloseAuditRunner({
			run: async (_a, opts) => {
				if (opts.label.startsWith("close-audit-prepare")) return okPrepare();
				return { code: 0, stdout: "", stderr: "", timedOut: false };
			},
		});
		const sam = pi.commands.get("sam");
		assert.ok(sam, "the /sam command is registered");
		await sam.handler("reaudit 1", ctx);
		// D9: the settlement commits AT VERDICT (inside the re-audit) — no ack
		// turn (the v3e ack→settle pattern is superseded for the close dial).
		assert.equal(pi.sent.length, 0, "no ack user message (settle-at-verdict)");
		const settlements = samRecords(pi).filter((r) => r.kind === "settlement");
		assert.equal(settlements.length, 2, "the weak settlement stays (append-only) + the strong one from the re-audit");
		assert.equal((settlements[1] as unknown as { unitId: number }).unitId, 1, "re-audited the SAME unit");
		assert.equal((settlements[1] as unknown as { verdict: string }).verdict, "VERIFIED", "the re-audit upgraded to a full verdict");
		assert.equal((settlements[1] as unknown as { supersedes?: string }).supersedes, (settlements[0] as unknown as { retrievalId: string }).retrievalId, "the strong settlement names the weak one it replaces");
		const resolve = samRecords(pi).find((r) => r.kind === "resolve");
		assert.equal((resolve as unknown as { basis: string }).basis, "close-audit");
		const closes = pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close");
		assert.equal(closes.length, 1, "the re-audit did not duplicate the close record");
		// now STRONG-settled: the lever refuses (idempotence — strong is final)
		await sam.handler("reaudit 1", ctx);
		assert.match(pi.notifyCalls.map((c) => c.text).join("\n"), /already settled/);
	} finally {
		__setCloseAuditRunner(null);
	}
});

/**
 * D11 (2026-10-02): the close-dial surface gains the goal tools — the v3
 * (followUp) control arm keeps its two-tool surface (extension.test.ts,
 * byte-stable).
 */
test("close dial: adjust_goal + read_goal are registered (D11 goal persistence — the v3 arm keeps two tools)", async () => {
	const pi = makeFakePi();
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	assert.equal(pi.tools.size, 8, "close dial surface: close_unit, update_unit (v0.0.25), sam_retrieve, adjust_goal, read_goal, retire_units, unretire, fold_now (the v5 pair + v0.0.4 fold ride the close dial)");
	for (const t of ["close_unit", "update_unit", "sam_retrieve", "adjust_goal", "read_goal", "retire_units", "unretire", "fold_now"]) assert.ok(pi.tools.has(t), "tool " + t + " registered");
	const adjust = pi.tools.get("adjust_goal");
	assert.ok(adjust);
	assert.match(adjust.description ?? "", /goal/i);
	const read = pi.tools.get("read_goal");
	assert.ok(read);
	assert.match(read.description ?? "", /goal/i);
});

/* v0.0.17 (2026-10-20, Paul): read_goal's OPTIONAL id — earlier goal versions
 *  are retrievable verbatim by version number (1 = oldest on the branch; the
 *  adjust_goal ack names them). */

async function adjustGoal(pi: ReturnType<typeof makeFakePi>, ctx: Record<string, unknown>, text: string, toolCallId: string): Promise<ToolResult> {
	const tool = pi.tools.get("adjust_goal");
	assert.ok(tool, "the adjust_goal tool must be registered");
	const result = await tool.execute(toolCallId, { goal: text }, new AbortController().signal, undefined, ctx);
	pi.branch.push(msg("toolResult", (result.content[0] as { text: string }).text, { toolCallId, toolName: "adjust_goal", isError: false }));
	return result;
}

async function readGoal(pi: ReturnType<typeof makeFakePi>, ctx: Record<string, unknown>, params: Record<string, unknown> = {}, toolCallId = "tc-readgoal"): Promise<ToolResult> {
	const tool = pi.tools.get("read_goal");
	assert.ok(tool, "the read_goal tool must be registered");
	return tool.execute(toolCallId, params, new AbortController().signal, undefined, ctx);
}

test("read_goal (v0.0.17): no id ⇒ current goal verbatim + version list with #numbers; the adjust_goal ack names the version", async () => {
	const pi = makeFakePi([msg("user", "do the thing")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	const r1 = await adjustGoal(pi, ctx, "goal one: the original objective", "tc-g1");
	assert.match(r1.content[0].text as string, /Goal stored \(version 1/, "the first goal is version 1");
	const r2 = await adjustGoal(pi, ctx, "goal two: the revised objective", "tc-g2");
	assert.match(r2.content[0].text as string, /Goal stored \(version 2/, "the second goal is version 2");
	const res = await readGoal(pi, ctx);
	const text = res.content[0].text as string;
	assert.match(text, /^GOAL \(current — version 2, stored /, "the current goal is labelled with its version");
	assert.ok(text.includes("goal two: the revised objective"), "the current goal rides verbatim");
	assert.match(text, /· #1 .* \(adjust_goal, 32 chars\)/, "the earlier version is listed with its #number");
	assert.match(text, /read_goal with \{ id: N \}/, "the hint names the id parameter");
	assert.equal((res.details as { versions?: number }).versions, 2, "details carry the version count");
});

test("read_goal (v0.0.17): id 1 ⇒ the OLDEST goal verbatim (tombstone view); id = latest ⇒ the current goal", async () => {
	const pi = makeFakePi([msg("user", "do the thing")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	await adjustGoal(pi, ctx, "goal one: the original objective", "tc-g1");
	await adjustGoal(pi, ctx, "goal two: the revised objective", "tc-g2");
	const old = await readGoal(pi, ctx, { id: 1 });
	const oldText = old.content[0].text as string;
	assert.match(oldText, /^GOAL version 1 of 2 \(earlier — the current goal is version 2\)/, "the tombstone view is labelled");
	assert.ok(oldText.includes("goal one: the original objective"), "the older goal is retrievable VERBATIM (the 2026-10-20 shortcoming)");
	assert.ok(oldText.includes("ledger tombstone"), "the tombstone status is stated");
	assert.equal((old.details as { version?: number }).version, 1, "details carry the read version");
	const cur = await readGoal(pi, ctx, { id: 2 });
	const curText = cur.content[0].text as string;
	assert.match(curText, /^GOAL version 2 of 2 \(current\)/, "the latest version is labelled current");
	assert.ok(curText.includes("goal two: the revised objective"), "the current goal verbatim");
});

test("read_goal (v0.0.17): a numeric STRING id is accepted (the model copies the number it saw); unknown / malformed ids are refused with the valid range", async () => {
	const pi = makeFakePi([msg("user", "do the thing")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	await adjustGoal(pi, ctx, "goal one: the original objective", "tc-g1");
	const s = await readGoal(pi, ctx, { id: "1" });
	assert.ok((s.content[0].text as string).includes("goal one: the original objective"), "the string id resolves");
	const unknown = await readGoal(pi, ctx, { id: 9 });
	assert.equal((unknown.details as { rejected?: string }).rejected, "unknown-version", "out of range is refused");
	assert.match(unknown.content[0].text as string, /unknown goal version 9 .* 1 version\(s\), numbered 1 \(oldest\) to 1 \(current\)/, "the refusal names the valid range");
	const bad = await readGoal(pi, ctx, { id: "abc" });
	assert.equal((bad.details as { rejected?: string }).rejected, "bad-id", "a non-numeric id is refused");
});

/* ── close-time goal nudge (v4, 2026-10-04 — Paul: "every time on close, until
   the model at least called adjust_goal once") ──────────────────────────── */

test("close-time goal nudge: accepted close (new unit) + NO goal record on the branch ⇒ the close offer is delivered (steer) with its ledger trace; the close itself is unaffected", async () => {
	seq = 0;
	const prevNudge = process.env["SAM_NUDGE"];
	process.env["SAM_NUDGE"] = "on"; // pin the family gate — `nudgeEnabled` reads the LIVE env at fire time (the audit-child env runs SAM_NUDGE=off; an ambient `off` must not flip this pin)
	try {
		writeFork(1, "VERIFIED\nFACTS: data.txt was written with 42\nEVIDENCE: M", "fork-g1.jsonl");
		const { runner } = makeRunner({ forkFile: path.join(WORKDIR, "fork-g1.jsonl") });
		__setCloseAuditRunner(runner);
		try {
			const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
			const ctx = makeFakeCtx(pi, MAIN_FILE);
			await load(pi, ctx);
			const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc-goal1");
			assert.match(res.content[0].text as string, /^Unit 1 closed — audit VERIFIED \([0-9a-f]{12}\) — stub: 1 line · 22 chars$/, "the close result is unchanged by the offer");
			assert.ok(
				pi.sent.some((s) => s.text === GOAL_NUDGE_TEXTS.close && s.options?.deliverAs === "steer"),
				"the close-time offer is delivered as a steer (the D7 channel — queued, lands before the next LLM call)",
			);
			const trace = pi.appended.find((a) => a.customType === "sam-nudge" && (a.data as { variant?: string }).variant === "close");
			assert.ok(trace, "the fired trace lands on the sam-nudge ledger (the readout grades trigger + variant)");
			assert.equal((trace as { data?: { trigger?: string } }).data?.trigger, "goal");
		} finally {
			__setCloseAuditRunner(null);
		}
	} finally {
		if (prevNudge === undefined) delete process.env["SAM_NUDGE"]; else process.env["SAM_NUDGE"] = prevNudge;
	}
});

test("close-time goal nudge: a goal record on the branch (the model called adjust_goal) retires the offer — the close stays offer-clean and the trace stays absent", async () => {
	seq = 0;
	writeFork(1, "VERIFIED\nFACTS: data.txt was written with 42\nEVIDENCE: M", "fork-g2.jsonl");
	const { runner } = makeRunner({ forkFile: path.join(WORKDIR, "fork-g2.jsonl") });
	__setCloseAuditRunner(runner);
	try {
		const goal: PiEntry = {
			id: "goal-1",
			type: "custom",
			customType: "sam",
			data: { v: 1, kind: "goal", text: "sweep the docs for staleness", ts: 1, basis: "adjust-goal" },
		};
		const pi = makeFakePi([msg("user", "write data.txt with the number 42"), goal]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc-goal2");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit VERIFIED/);
		assert.equal(pi.sent.length, 0, "no offer: the goal anchor exists (the anchor = a stored adjust_goal, file-derived)");
		assert.equal(pi.appended.filter((a) => a.customType === "sam-nudge").length, 0, "neither a fired nor a suppressed goal-nudge trace");
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("close-depth freshness (sam-05, 2026-10-05; re-rung 2026-10-17): a model switch with no intervening settle ⇒ the depth decision runs on the CURRENT window — 21k of 131k ⇒ calm ⇒ MEDIUM (the stale 33k ruler would have mis-zoned action ⇒ LIGHT — the 'only light audits' shape of the defect)", async () => {
	seq = 0;
	writeFork(1, "VERIFIED\nFACTS: data.txt was written with 42\nEVIDENCE: M", "fork-ms.jsonl");
	const { runner } = makeRunner({ forkFile: path.join(WORKDIR, "fork-ms.jsonl") });
	__setCloseAuditRunner(runner);
	try {
		const goalAnchor = { id: "goal-anchor", type: "custom", customType: "sam", data: { v: 1, kind: "goal", text: "the standing goal", ts: 1, basis: "adjust-goal" } }; // a stored goal ⇒ the close-time goal nudge retires — this test pins DEPTH FRESHNESS, not the goal offer
		const pi = makeFakePi([msg("user", "write data.txt with the number 42"), goalAnchor]);
		pi.contextUsage = { tokens: 1_500, contextWindow: 33_000 }; // session starts on the small model (sam-05: the ~33k default)
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		(ctx as { model: unknown }).model = { provider: "qube", id: "qwen-131k", contextWindow: 131_072 }; // the switch (no extension event in pi 0.87.1)
		pi.contextUsage = { tokens: 21_000, contextWindow: 131_072 };
		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc-ms");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit VERIFIED/);
		const rec = pi.appended.find((a) => (a.data as { kind?: string })?.kind === "close") as { data: { depth?: string; depthZone?: string; ctxTokens?: number } } | undefined;
		assert.ok(rec, "the close record is durable");
		assert.equal(rec?.data.ctxTokens, 21_000, "the decision's ctx measurement is the live one");
		assert.equal(rec?.data.depthZone, "calm", "the zone ran on the CURRENT 131k ruler (not the 33k-derived action)");
		assert.equal(rec?.data.depth, "medium", "auto mode: calm (below band) ⇒ medium depth (2026-10-17; the stale ruler would have mis-dispatched LIGHT)");
	} finally {
		__setCloseAuditRunner(null);
	}
});

/* ── cleanup ─────────────────────────────────────────────────────────────── */

/* ── Bug A (Paul 2026-10-14): the goal-nudge landing check ─────────────
   The arm point (`input` event) fires BEFORE the session append (pi v0.87.1
   `prompt()`), so a queued steer the user edits away arms the offer without
   ever landing. The offer must be INVALIDATED (with its trace) — and only a
   NEW real user message may arm a live offer again. The pure core's pins
   are in goal-nudge.test.ts; this section pins the glue placement. */

function goalNudgesOn(pi: FakePi) {
	return pi.appended.filter((a) => a.customType === "sam-nudge" && (a.data as { trigger?: string }).trigger === "goal") as {
		customType: string;
		data: { trigger?: string; variant?: string; invalidated?: boolean; invalidateReason?: string };
	}[];
}
function sentGoalOffers(pi: FakePi) {
	return pi.sent.filter((s) => s.text.startsWith("[sam-nudge] ") && s.options?.deliverAs === "steer");
}
async function fireGoalInput(pi: FakePi, ctx: Record<string, unknown>, text: string): Promise<void> {
	const inputs = pi.listeners.get("input") ?? [];
	assert.equal(inputs.length, 1, "exactly one input listener");
	await inputs[0]({ text, source: "interactive" }, ctx);
}
async function fireAssistantEnd(pi: FakePi, ctx: Record<string, unknown>): Promise<void> {
	const ends = pi.listeners.get("message_end") ?? [];
	assert.equal(ends.length, 1, "exactly one message_end listener");
	await ends[0]({ message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() } }, ctx);
}

test("Bug A: an armed offer whose input never landed (a queued steer edited away) is INVALIDATED — no offer, a ledger trace, and a real input afterwards still arms a live offer", async () => {
	seq = 0;
	const prevNudge = process.env["SAM_NUDGE"];
	process.env["SAM_NUDGE"] = "on"; // pin the family gate (the ambient env must not flip this pin)
	try {
		const goalAnchor = { id: "goal-anchor", type: "custom", customType: "sam", data: { v: 1, kind: "goal", text: "the standing goal", ts: 1, basis: "adjust-goal" } }; // a stored goal ⇒ the armed variant is the B (userinput) reminder
		const pi = makeFakePi([goalAnchor as never]); // the branch carries NO real user message (the queued steer never landed)
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		await fireGoalInput(pi, ctx, "find the discrepancies in the flotilla"); // armed — but the user has now edited the queued steer away
		await fireAssistantEnd(pi, ctx); // the first assistant message after the arm — the fire point
		assert.equal(sentGoalOffers(pi).length, 0, "no goal offer is delivered for a never-landed input");
		const ledgers = goalNudgesOn(pi);
		assert.equal(ledgers.length, 1, "the invalidation leaves its ledger trace (F1 — the former invisible drop is auditable)");
		assert.equal(ledgers[0].data.variant, "userinput");
		assert.equal(ledgers[0].data.invalidated, true);
		assert.equal(ledgers[0].data.invalidateReason, "no-real-user-input");
		// recovery: a real user input lands, a fresh event arms, the offer fires
		pi.branch.push(msg("user", "now check the bridge sensors"));
		await fireGoalInput(pi, ctx, "now check the bridge sensors");
		await fireAssistantEnd(pi, ctx);
		assert.equal(sentGoalOffers(pi).length, 1, "a NEW landed input arms a live offer again");
		assert.equal(sentGoalOffers(pi)[0].text, GOAL_NUDGE_TEXTS.userinput);
		const fired = goalNudgesOn(pi).find((l) => l.data.invalidated !== true);
		assert.ok(fired, "the fired offer traces like the others (no invalidated flag)");
	} finally {
		if (prevNudge === undefined) delete process.env["SAM_NUDGE"]; else process.env["SAM_NUDGE"] = prevNudge;
	}
});

test("Bug A: the covered watermark blocks a re-offer against the SAME (older) landed input — a later discarded steer is invalidated (no-new-user-input), not re-fired", async () => {
	seq = 0;
	const prevNudge = process.env["SAM_NUDGE"];
	process.env["SAM_NUDGE"] = "on";
	try {
		const goalAnchor = { id: "goal-anchor", type: "custom", customType: "sam", data: { v: 1, kind: "goal", text: "the standing goal", ts: 1, basis: "adjust-goal" } };
		const firstInput = msg("user", "sweep the docs for staleness"); // a real input that LANDED
		const pi = makeFakePi([firstInput, goalAnchor as never]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		await fireGoalInput(pi, ctx, "sweep the docs for staleness");
		await fireAssistantEnd(pi, ctx); // the first offer fires (the input landed) — and covers it (watermark)
		assert.equal(sentGoalOffers(pi).length, 1, "the first landed input arms a live offer");
		// a second, mid-turn steer is queued — then edited away before it lands
		await fireGoalInput(pi, ctx, "also check the mirror list"); // re-arms (latest event wins) — no new user entry lands
		await fireAssistantEnd(pi, ctx); // same branch tail: the last real input is STILL the first one
		assert.equal(sentGoalOffers(pi).length, 1, "NO second offer: the watermark says the last real input is already covered");
		const ledgers = goalNudgesOn(pi);
		assert.equal(ledgers.length, 2, "fired trace + invalidated trace");
		assert.equal(ledgers[1].data.invalidated, true);
		assert.equal(ledgers[1].data.invalidateReason, "no-new-user-input");
	} finally {
		if (prevNudge === undefined) delete process.env["SAM_NUDGE"]; else process.env["SAM_NUDGE"] = prevNudge;
	}
});

/* ── Bug B (Paul 2026-10-14): the one-shot waiver after a successful
   adjust_goal (the nudge must not re-ask about a goal the model just wrote)
   ─────────────────────────────────────────────────────────────────────────── */

async function fireAdjustGoalResult(pi: FakePi, ctx: Record<string, unknown>, isError: boolean): Promise<void> {
	const ends = pi.listeners.get("message_end") ?? [];
	assert.equal(ends.length, 1, "exactly one message_end listener");
	await ends[0](
		{
			message: {
				role: "toolResult",
				toolName: "adjust_goal",
				toolCallId: isError ? "tc-waive-fail" : "tc-waive",
				isError,
				content: [{ type: "text", text: isError ? "goal rejected" : "goal stored" }],
				timestamp: Date.now(),
			},
		},
		ctx,
	);
}

test("Bug B: a successful adjust_goal waives exactly the NEXT userinput offer (silent — no ledger entry); the offer after that fires normally", async () => {
	seq = 0;
	const prevNudge = process.env["SAM_NUDGE"];
	process.env["SAM_NUDGE"] = "on";
	try {
		const goalAnchor = { id: "goal-anchor", type: "custom", customType: "sam", data: { v: 1, kind: "goal", text: "the standing goal", ts: 1, basis: "adjust-goal" } };
		const pi = makeFakePi([goalAnchor as never]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		await fireGoalInput(pi, ctx, "sweep the docs for staleness"); // arms the userinput offer
		await fireAdjustGoalResult(pi, ctx, false); // the model's own adjust_goal succeeds — the waiver site
		// the next real input lands and arms — its offer must be waived
		pi.branch.push(msg("user", "check the bridge sensors"));
		await fireGoalInput(pi, ctx, "check the bridge sensors");
		await fireAssistantEnd(pi, ctx);
		assert.equal(sentGoalOffers(pi).length, 0, "the offer right after the model's own adjust_goal is waived (moot — Paul's bug report)");
		assert.equal(goalNudgesOn(pi).length, 0, "silent: no fired, no invalidated, no suppressed trace (the goal record is the provenance)");
		// the offer after that fires normally (the unconditional update-check is preserved)
		pi.branch.push(msg("user", "also audit the mirror list"));
		await fireGoalInput(pi, ctx, "also audit the mirror list");
		await fireAssistantEnd(pi, ctx);
		assert.equal(sentGoalOffers(pi).length, 1, "subsequent userinput offers fire normally");
		assert.equal(sentGoalOffers(pi)[0].text, GOAL_NUDGE_TEXTS.userinput);
	} finally {
		if (prevNudge === undefined) delete process.env["SAM_NUDGE"]; else process.env["SAM_NUDGE"] = prevNudge;
	}
});

test("Bug B: a FAILED adjust_goal waives nothing (the model may retry — the update check stays unconditional)", async () => {
	seq = 0;
	const prevNudge = process.env["SAM_NUDGE"];
	process.env["SAM_NUDGE"] = "on";
	try {
		const goalAnchor = { id: "goal-anchor", type: "custom", customType: "sam", data: { v: 1, kind: "goal", text: "the standing goal", ts: 1, basis: "adjust-goal" } };
		const pi = makeFakePi([goalAnchor as never]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		await fireGoalInput(pi, ctx, "sweep the docs for staleness");
		await fireAdjustGoalResult(pi, ctx, true); // the adjust_goal FAILED — no waiver
		pi.branch.push(msg("user", "check the bridge sensors"));
		await fireGoalInput(pi, ctx, "check the bridge sensors");
		await fireAssistantEnd(pi, ctx);
		assert.equal(sentGoalOffers(pi).length, 1, "a failed adjust_goal does not silence the next offer");
	} finally {
		if (prevNudge === undefined) delete process.env["SAM_NUDGE"]; else process.env["SAM_NUDGE"] = prevNudge;
	}
});

/* ── v0.0.4 FOLD (Paul 2026-10-14): the model-initiated fold — the glue pins
   (the pure core is pinned in test/fold.test.ts; the registration surface in
   test/extension.test.ts) ─────────────────────────────────────────────────── */

const foldSignal = () => new AbortController().signal;
async function foldNow(pi: FakePi, ctx: Record<string, unknown>, toolCallId: string): Promise<ToolResult> {
	const tool = pi.tools.get("fold_now");
	assert.ok(tool, "the fold_now tool must be registered (close dial)");
	return tool.execute(toolCallId, {}, foldSignal(), undefined, ctx);
}
function fireSessionCompact(pi: FakePi, ctx: Record<string, unknown>, reason: "manual" | "threshold" | "overflow", tokensBefore: number, fromExtension: boolean): void {
	const sc = pi.listeners.get("session_compact") ?? [];
	assert.equal(sc.length, 1, "exactly one session_compact listener (the fold ack)");
	sc[0]({ type: "session_compact", compactionEntry: { type: "compaction", id: "cmp1", tokensBefore, summary: "takeover summary", firstKeptEntryId: "keep-1", fromHook: fromExtension }, fromExtension, reason, willRetry: false }, ctx);
}

function foldAckSent(pi: FakePi): FakePi["sentMessages"] {
	return pi.sentMessages.filter((m) => m.message.customType === "sam-fold-ack");
}

test("fold_now: registered under the close dial with the empty parameter schema + sequential mode", async () => {
	seq = 0;
	const pi = makeFakePi([msg("user", "do work"), msg("assistant", "done")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	const tool = pi.tools.get("fold_now");
	assert.ok(tool, "fold_now ships with the close dial (SAM_FOLD defaults ON)");
	assert.equal(tool.executionMode, "sequential", "F3: never two compactions at once");
	// the surface: name + the contract in the description (the turn ends; the ack rides the next prompt)
	assert.match(tool.description ?? "", /ENDS YOUR CURRENT TURN/);
	assert.match(tool.description ?? "", /sam-fold-ack/);
});

test("fold_now: triggers ctx.compact (fire-and-forget), returns the triggered text, and refuses a second call while in flight (F3)", async () => {
	seq = 0;
	const pi = makeFakePi([msg("user", "do work"), msg("assistant", "done")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	const r1 = await foldNow(pi, ctx, "tc-f1");
	assert.equal(r1.content[0].text as string, FOLD_NOW_TRIGGERED_TEXT);
	assert.equal(pi.compactCalls.length, 1, "ctx.compact called exactly once");
	const opts = pi.compactCalls[0] as { onComplete?: unknown; onError?: unknown };
	assert.equal(typeof opts.onComplete, "function", "the ack channel: onComplete carries the exact CompactionResult");
	assert.equal(typeof opts.onError, "function", "the failure backstop");
	// F3: a second call while the fold is in flight is a plain refusal (no second compact())
	const r2 = await foldNow(pi, ctx, "tc-f2");
	assert.equal(r2.content[0].text as string, FOLD_NOW_IN_FLIGHT_TEXT);
	assert.equal(pi.compactCalls.length, 1, "the refusal does NOT trigger a second compaction");
});

test("fold_now full flow: trigger → session_compact DEFERS the ack (pi emits the event before onComplete) → onComplete sends EXACTLY ONE sam-fold-ack with the exact numbers → the flag clears (a fresh fold is allowed)", async () => {
	seq = 0;
	const pi = makeFakePi([msg("user", "do work"), msg("assistant", "done")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	await foldNow(pi, ctx, "tc-f1");
	// pi's manual path runs: the session_compact event (takeover engaged — fromExtension true)
	fireSessionCompact(pi, ctx, "manual", 90000, true);
	assert.equal(foldAckSent(pi).length, 0, "the model-initiated ack is DEFERRED (pi emits the event before the ctx-level onComplete resolves — measured at the pinned commit)");
	// the ctx-level onComplete fires with the exact CompactionResult
	const opts = pi.compactCalls[0] as { onComplete: (r: unknown) => void };
	opts.onComplete({ summary: "takeover summary", firstKeptEntryId: "keep-1", tokensBefore: 90000, estimatedTokensAfter: 21000, details: {} });
	const acks = foldAckSent(pi);
	assert.equal(acks.length, 1, "exactly one ack (the deferred one — no double-send)");
	assert.equal(acks[0].message.customType, "sam-fold-ack");
	assert.equal(
		acks[0].message.content,
		foldAckText({ origin: "model", tokensBefore: 90000, estimatedTokensAfter: 21000, fromExtension: true }),
	);
	assert.deepEqual(acks[0].options, { triggerTurn: true }, "v0.0.5: the model-initiated ack RESTARTS the turn (the turn is already dead — F1)");
	assert.equal(acks[0].message.display, true, "the ack is TUI-visible (display: true) AND context-participating");
	// the single-flight flag cleared: a fresh fold is allowed again
	const r3 = await foldNow(pi, ctx, "tc-f3");
	assert.equal(r3.content[0].text as string, FOLD_NOW_TRIGGERED_TEXT);
	assert.equal(pi.compactCalls.length, 2);
});

test("fold ack: pi's native fold (threshold OR overflow) ⇒ the IMMEDIATE sam-fold-ack (tokensBefore exact from the entry; the honest retention-tail phrase — no CompactionResult exists for native folds), auto-acked with triggerTurn (v0.0.12: while streaming ⇒ steer + pi's own hasQueuedMessages() continuation ⇒ the model sees the ack without a user post; not streaming ⇒ one short ack turn — option 1)", async () => {
	seq = 0;
	const pi = makeFakePi([msg("user", "do work"), msg("assistant", "done")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	fireSessionCompact(pi, ctx, "threshold", 114700, true);
	let acks = foldAckSent(pi);
	assert.equal(acks.length, 1, "the native fold gets its ack immediately (the listener — no tool involved)");
	assert.equal(acks[0].message.content, foldAckText({ origin: "native", tokensBefore: 114700, estimatedTokensAfter: null, fromExtension: true }));
	assert.deepEqual(acks[0].options, { triggerTurn: true }, "v0.0.12: the native ack is AUTO-ACKED (not queued for a user post)");
	// the overflow reason takes the same native branch
	fireSessionCompact(pi, ctx, "overflow", 114700, true);
	acks = foldAckSent(pi);
	assert.equal(acks.length, 2);
	assert.equal(acks[1].message.content, foldAckText({ origin: "native", tokensBefore: 114700, estimatedTokensAfter: null, fromExtension: true }));
	assert.deepEqual(acks[1].options, { triggerTurn: true }, "v0.0.12: overflow folds auto-ack too (same native branch)");
});

test("fold ack: the user's /compact (reason manual, no in-flight flag) ⇒ the IMMEDIATE ack, origin 'user'", async () => {
	seq = 0;
	const pi = makeFakePi([msg("user", "do work"), msg("assistant", "done")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	fireSessionCompact(pi, ctx, "manual", 120000, true);
	const acks = foldAckSent(pi);
	assert.equal(acks.length, 1);
	assert.equal(acks[0].message.content, foldAckText({ origin: "user", tokensBefore: 120000, estimatedTokensAfter: null, fromExtension: true }));
});

test("fold failure: session_compact_failed (genuine failure) ⇒ the model sees the failure ack (it might otherwise assume the context shrank) + the flag clears (a retry is possible); an ABORTED fold ⇒ operator line only, no message", async () => {
	seq = 0;
	const pi = makeFakePi([msg("user", "do work"), msg("assistant", "done")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	await foldNow(pi, ctx, "tc-f1");
	const failed = pi.listeners.get("session_compact_failed") ?? [];
	assert.equal(failed.length, 1, "exactly one session_compact_failed listener");
	// genuine failure: pi's own error text rides the ack verbatim
	failed[0]({ type: "session_compact_failed", reason: "manual", errorMessage: "Nothing to compact (session too small)", aborted: false, willRetry: false, fromExtension: false }, ctx);
	const acks = foldAckSent(pi);
	assert.equal(acks.length, 1);
	assert.equal(acks[0].message.content, foldFailText("Nothing to compact (session too small)"));
	assert.deepEqual(acks[0].options, { triggerTurn: true }, "v0.0.5: a genuine MODEL-INITIATED failure restarts the turn (the model can retry fold_now or continue)");
	// the flag cleared: a retry is possible
	const r2 = await foldNow(pi, ctx, "tc-f2");
	assert.equal(r2.content[0].text as string, FOLD_NOW_TRIGGERED_TEXT);
	// aborted (the user cancelled mid-fold): no model-visible message, flag still clears
	await foldNow(pi, ctx, "tc-f3");
	const before = foldAckSent(pi).length;
	failed[0]({ type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, fromExtension: false }, ctx);
	assert.equal(foldAckSent(pi).length, before, "an aborted fold sends no model message");
	const r4 = await foldNow(pi, ctx, "tc-f4");
	assert.equal(r4.content[0].text as string, FOLD_NOW_TRIGGERED_TEXT, "the abort cleared the flag too");
});

test("fold failure: a USER failure (reason manual, no in-flight flag) stays queued for the next turn (the user may be typing); a NATIVE failure is auto-acked with triggerTurn (v0.0.12: the model must not assume the context shrank)", async () => {
	seq = 0;
	const pi = makeFakePi([msg("user", "do work"), msg("assistant", "done")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	const failed = pi.listeners.get("session_compact_failed") ?? [];
	// user failure: stays queued (the user is about to type — no auto inference)
	failed[0]({ type: "session_compact_failed", reason: "manual", errorMessage: "compaction failed", aborted: false, willRetry: false, fromExtension: false }, ctx);
	let acks = foldAckSent(pi);
	assert.equal(acks.length, 1);
	assert.equal(acks[0].message.content, foldFailText("compaction failed"));
	assert.deepEqual(acks[0].options, { deliverAs: "nextTurn" }, "the user failure stays queued for the next turn");
	// native failure: auto-acked (same rationale as the native success ack)
	failed[0]({ type: "session_compact_failed", reason: "threshold", errorMessage: "compaction failed", aborted: false, willRetry: false, fromExtension: false }, ctx);
	acks = foldAckSent(pi);
	assert.equal(acks.length, 2);
	assert.equal(acks[1].message.content, foldFailText("compaction failed"));
	assert.deepEqual(acks[1].options, { triggerTurn: true }, "v0.0.12: the native failure is AUTO-ACKED (the model learns the fold failed and the context did not shrink)");
});

test("fold_now: dial OFF (SAM_FOLD=off) ⇒ the dial-off refusal, nothing triggered (the native threshold fold still applies)", async () => {
	seq = 0;
	const prev = process.env["SAM_FOLD"];
	process.env["SAM_FOLD"] = "off";
	try {
		const pi = makeFakePi([msg("user", "do work"), msg("assistant", "done")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const r = await foldNow(pi, ctx, "tc-f1");
		assert.equal(r.content[0].text as string, FOLD_NOW_DISABLED_TEXT);
		assert.equal(pi.compactCalls.length, 0, "the dial-off refusal never triggers a compaction");
	} finally {
		if (prev === undefined) delete process.env["SAM_FOLD"]; else process.env["SAM_FOLD"] = prev;
	}
});

test("fold_now: inside a SAM side-branch (the F4 guard family) ⇒ the audit-fork refusal, nothing triggered", async () => {
	seq = 0;
	const pi = makeFakePi([msg("user", "write data.txt")]);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);
	// model the fork shape (the close-audit guard's fixture): the close record + toolResult + the [sam-audit] instruction on the line
	const rec = { v: 1, kind: "close", unitId: 1, stub: "wrote data.txt", toolCallId: "tcA", ts: 0 };
	pi.appended.push({ customType: "sam", data: rec });
	pi.branch.push({ id: nextId(), type: "custom", customType: "sam", data: rec });
	pi.branch.push(msg("toolResult", "Unit 1 closed — audit VERIFIED (abcd1234ef56)", { toolCallId: "tcx", toolName: "close_unit" }));
	pi.branch.push(msg("user", `${AUDIT_INSTRUCTION_PREFIX} Unit 1 was just closed…`));
	const r = await foldNow(pi, ctx, "tc-f1");
	assert.equal(r.content[0].text as string, FOLD_NOW_AUDIT_FORK_TEXT);
	assert.equal(pi.compactCalls.length, 0, "the fork must never fold (it would burn its one-shot turn)");
});

test.after(() => {
	try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

/* 2026-10-05 (Paul: live status on the tool line — "close_unit - auditing the
 * summary" while the audit runs; the pi-native onUpdate channel, bash-style):
 * the in-flight line names the stage AND the stub size (his write-tool ask,
 * the live flavour). The TUI's visual rendering is Paul's on the Qube TUI. */
test("close dial: while the audit runs, close_unit reports its in-flight status via the pi-native onUpdate channel (the stub line rides it)", async () => {
	const u = msg("user", "a task " + "x".repeat(60));
	const pi = makeFakePi([u]);
	const ctx = makeFakeCtx(pi);
	await load(pi, ctx);
	const tool = pi.tools.get("close_unit");
	assert.ok(tool, "the close_unit tool must be registered");
	const updates: { text: string }[] = [];
	const result = await tool.execute(
		"tc-live",
		{ stub: "did the thing\nchecked it twice" },
		new AbortController().signal,
		(update: { content?: { type: string; text: string }[] }) => {
			const first = update.content?.[0];
			if (first && "text" in first) updates.push({ text: first.text });
		},
		ctx,
	);
	assert.ok(
		updates.some((x) => /auditing the summary… \(medium audit · stub: 2 lines · 30 chars\)/.test(x.text)),
		`the in-flight line names the audit stage + the decided mode (2026-10-17: this calm-zone close is MEDIUM — below band) + the stub size (updates seen: ${JSON.stringify(updates)})`,
	);
	assert.match(result.content[0].text as string, /— stub: 2 lines · 30 chars$/, "the settled ack carries the same counts (plural + chars pinned)");
});

/* v0.0.25 (2026-10-26): the default runner's stderr cap. The prepare
 * handoff is ONE line on stderr (emit → console.error in the no-UI child)
 * and embeds the full instruction (the stub verbatim) — a long stub makes
 * that single line > 8 KB, and the old 8 KB cap sliced the line's head
 * (the "sam-branch-prepare" key) off, so parsePrepareHandoff found nothing
 * (handoff-missing — measured 4× in this branch's session: units 24/26/29/
 * 30, each diagnostic tail = the stub tail). The cap is a memory guard,
 * not a diagnostic: it now mirrors stdout's 200 KB (the banked diagnostic
 * stays capped at AUDIT_DIAGNOSTIC_CAP_CHARS = 4096). */
test("runner: the default runner keeps a >8 KB single-line stderr whole (the v0.0.25 prepare-handoff regression)", async () => {
	__setCloseAuditRunner(null);
	const runner = __closeAuditRunnerNow();
	const payload = "H".repeat(20_000);
	const res = await runner.run(["-e", `process.stderr.write(${JSON.stringify(payload)} + "\\n")`], { timeoutMs: 30_000 });
	assert.equal(res.code, 0, "the child exits cleanly");
	assert.equal(res.stderr.length, payload.length + 1, "the full 20 KB line survives (the old 8 KB cap sliced 12 KB off the head — the handoff-missing root cause)");
	assert.equal(res.stderr, payload + "\n");
});

/* ── v0.0.25 fork mode (the summary child) — the fork-path family ──────── */

/** The STUB CHILD's fork file: the appended instruction + the child's one turn (update_unit + the ack). */
function writeStubFork(unitId: number, stub: string, name = `stubfork-u${unitId}.jsonl`, opts: { noCall?: boolean; stopReason?: string } = {}): string {
	const f = path.join(WORKDIR, name);
	const rootId = `stubroot-${unitId}`;
	const lines: unknown[] = [
		{ type: "session", id: rootId, version: 3, timestamp: "2026-10-01T00:00:00.000Z", cwd: WORKDIR },
		{ id: "instr", parentId: rootId, type: "message", message: { role: "user", content: summaryChildInstruction(unitId) } },
	];
	if (opts.noCall) {
		lines.push({ id: "done", type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will write the summary." }], stopReason: opts.stopReason ?? "stop" } });
	} else {
		lines.push({ id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tu1", name: "update_unit", arguments: { stub } }], stopReason: "toolUse" } });
		lines.push({ id: "done", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Recorded" }], stopReason: opts.stopReason ?? "stop" } });
	}
	fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return f;
}

async function forkCloseUnit(pi: FakePi, ctx: Record<string, unknown>, params: Record<string, unknown>, toolCallId: string): Promise<ToolResult> {
	const tool = pi.tools.get("close_unit");
	assert.ok(tool, "the close_unit tool must be registered");
	const result = await tool.execute(toolCallId, params, new AbortController().signal, undefined, ctx);
	pi.branch.push(msg("toolResult", (result.content[0] as { text: string }).text, { toolCallId, toolName: "close_unit", isError: false }));
	return result;
}

const goalAnchorEntry = () => ({ id: `goal-${++seq}`, type: "custom" as const, customType: "sam" as const, data: { v: 1, kind: "goal", text: "the standing goal", ts: 1, basis: "adjust-goal" } });

function forkSetup(branch: PiEntry[]): { pi: FakePi; ctx: Record<string, unknown> } {
	const pi = makeFakePi(branch);
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	return { pi, ctx };
}

test("v0.0.25 fork mode: the happy path — no stub passed; the summary child writes it (F1: the close commits AFTER the stage, stubSource child); the weak placeholder precedes the audit; the real settlement supersedes; ONE D10-A arm/disarm pair (F5)", async () => {
	process.env["SAM_SUMMARY_MODE"] = "fork";
	seq = 0;
	try {
		const reply = "VERIFIED\nFACTS: data.txt written with 42\nEVIDENCE: MARKER-1";
		const auditFork = writeFork(1, reply, "fork-audit-u1-forkmode.jsonl");
		const childStub = "wrote data.txt with 42 (checked: the file content)";
		const stubFork = writeStubFork(1, childStub, "stubfork-u1-forkmode.jsonl");
		const { runner, calls } = makeRunner({ forkFile: auditFork, stubForkFile: stubFork });
		__setCloseAuditRunner(runner);
		const armBefore = armState.arm;
		const { pi, ctx } = forkSetup([msg("user", "write data.txt with the number 42"), goalAnchorEntry()]);
		await load(pi, ctx);

		const res = await forkCloseUnit(pi, ctx, {}, "tc1"); // no stub — the fork-mode contract
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit VERIFIED \([0-9a-f]{12}\) — stub: 1 line · 50 chars$/);
		assert.equal((res.details as { unitId: number; closed: boolean; audit: string }).unitId, 1);
		assert.equal((res.details as { audit: string }).audit, "settled");

		// the close record: the CHILD's stub, provenance "child", committed AFTER the stage (F1)
		const closeRec = pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close")[0].data as { unitId: number; stub: string; stubSource?: string };
		assert.equal(closeRec.unitId, 1);
		assert.equal(closeRec.stub, childStub, "the stub is the summary child's (extracted model-free from the fork file)");
		assert.equal(closeRec.stubSource, "child");

		// the settlement order: close → PLACEHOLDER (audit pending) → real settlement → resolve
		const recs = samRecords(pi);
		assert.ok(recs.some((r) => r.kind === "close") && recs.some((r) => r.kind === "settlement") && recs.some((r) => r.kind === "resolve"));
		const cIdx = recs.findIndex((r) => r.kind === "close");
		const settlements = recs.filter((r) => r.kind === "settlement") as unknown as { unitId: number; verdict: string; auditPending?: boolean; sections?: Record<string, string> }[];
		assert.equal(settlements.length, 2, "the placeholder + the real settlement");
		assert.ok(recs.indexOf(settlements[0]) > cIdx, "the placeholder commits AFTER the close record");
		assert.equal(settlements[0].verdict, "NOT-YET-VERIFIED", "the weak placeholder");
		assert.equal(settlements[0].auditPending, true, "F6: the pending flag (the takeover heading keys off it)");
		assert.ok(settlements[0].sections !== undefined && /summary child/.test(settlements[0].sections["NOT_YET_VERIFIED_PLACEHOLDER"] ?? ""), "the pending note names the summary child");
		assert.equal(settlements[1].verdict, "VERIFIED", "the real settlement supersedes the placeholder at verdict");

		// the child pipeline: stub-prepare → stub child → audit-prepare → audit child (4 runs)
		assert.equal(calls.length, 4, "the fork-mode close runs FOUR children (2 per stage)");
		assert.equal(calls[0].label, "stub-prepare-u1");
		assert.equal(calls[1].label, "stub-child-u1");
		assert.ok(calls[1].args.includes("--session") && calls[1].args.includes(stubFork), "the stub child is pinned to the STUB FORK file");
		const stubPrompt = calls[1].args[calls[1].args.indexOf("-p") + 1];
		assert.equal(stubPrompt, summaryChildInstruction(1), "the stub child's prompt is the child instruction (unit id baked in)");
		assert.ok(calls[1].env !== undefined && calls[1].env!["SAM_AUDIT_TIMEOUT_MS"] !== undefined, "the stub child shares the audit budget stamp (the deadline nudge matches the kill)");

		// F5: ONE arm/disarm pair spanning the stub child AND the audit child
		assert.equal(armState.arm, armBefore + 1, "exactly one arm for the whole fork-mode close");
		assert.equal(armState.disarm, armState.arm, "disarmed in the finally");

		// the main line stays child-free (no [sam-stub] / [sam-audit] user messages in the MAIN branch)
		assert.ok(!pi.branch.some((e) => e.type === "message" && typeof (e.message?.content as string) === "string" && ((e.message?.content as string).startsWith("[sam-stub]") || (e.message?.content as string).startsWith("[sam-audit]"))), "the child instructions never land on the main line");
	} finally {
		__setCloseAuditRunner(null);
		delete process.env["SAM_SUMMARY_MODE"];
	}
});

test("v0.0.25 fork mode: a PASSED stub is refused (stub-passed-fork-mode) — nothing recorded, no child spawned", async () => {
	process.env["SAM_SUMMARY_MODE"] = "fork";
	seq = 0;
	try {
		const { runner, calls } = makeRunner({});
		__setCloseAuditRunner(runner);
		const { pi, ctx } = forkSetup([msg("user", "write data.txt with 42"), goalAnchorEntry()]);
		await load(pi, ctx);

		const res = await forkCloseUnit(pi, ctx, { stub: "my own stub" }, "tc1");
		assert.match(res.content[0].text as string, /close_unit refused: in fork mode \(SAM_SUMMARY_MODE=fork\) the stub is written by the summary child/);
		assert.match(res.content[0].text as string, /switch summaryMode to main/);
		assert.equal((res.details as { rejected: string }).rejected, "stub-passed-fork-mode");
		assert.equal(samRecords(pi).length, 0, "nothing recorded (F4 shape)");
		assert.equal(calls.length, 0, "no child was spawned");
	} finally {
		__setCloseAuditRunner(null);
		delete process.env["SAM_SUMMARY_MODE"];
	}
});

test("v0.0.25 fork mode F4: every stub-stage failure REFUSES the close — nothing recorded, the retry is a fresh close_unit", async () => {
	seq = 0;
	const cases: { name: string; script: ChildScript; reason: string }[] = [
		{ name: "no reply (text-only)", script: { stubForkFile: writeStubFork(1, "never committed", "stubfork-noreply.jsonl", { noCall: true }) }, reason: "stub-reply-missing" },
		{ name: "truncated reply (stop reason length)", script: { stubForkFile: writeStubFork(1, "never committed", "stubfork-trunc.jsonl", { noCall: true, stopReason: "length" }) }, reason: "stub-reply-truncated(length)" },
		{ name: "prepare child exited 1", script: { stubPrepare: { code: 1, stderr: "boom" } }, reason: "stub-prepare-exit-failed" },
		{ name: "handoff missing", script: { stubPrepare: { code: 0, stdout: "boot\nno handoff here\n" } }, reason: "stub-handoff-missing" },
		{ name: "stub child timed out", script: { stubForkFile: writeStubFork(1, "x", "stubfork-timeout.jsonl"), stubChild: { timedOut: true } }, reason: "stub-timeout" },
		{ name: "spawn crashed", script: { throw: "spawn boom" }, reason: "stub-prepare-spawn-failed" },
	];
	for (const c of cases) {
		process.env["SAM_SUMMARY_MODE"] = "fork";
		seq = 0;
		const { runner, calls } = makeRunner(c.script);
		__setCloseAuditRunner(runner);
		try {
			const { pi, ctx } = forkSetup([msg("user", "write data.txt with 42"), goalAnchorEntry()]);
			await load(pi, ctx);
			const res = await forkCloseUnit(pi, ctx, {}, "tc1");
			assert.match(res.content[0].text as string, new RegExp(`close_unit refused \\(summary child failed: ${c.reason.replace(/[()]/g, (ch) => `\\${ch}`)}\\)`), `the refusal names the reason (${c.name})`);
			assert.match(res.content[0].text as string, /Nothing was recorded; call close_unit again to retry\./);
			assert.equal((res.details as { rejected: string }).rejected, c.reason);
			assert.equal(samRecords(pi).length, 0, `nothing recorded (${c.name}) — the close record is committed only AFTER the stage (F1)`);
			assert.ok(calls.length < 4, `the pipeline stopped early (${c.name})`);
		} finally {
			__setCloseAuditRunner(null);
		}
	}
	delete process.env["SAM_SUMMARY_MODE"];
});

test("v0.0.25 fork mode D5 (stubless arm): a re-close while the last close is weak RE-SUMMARIZES the same unit (latest-wins kind:\"stub\", the close record stays immutable, the same unit re-audits); a strong last close ⇒ a NEW unit", async () => {
	process.env["SAM_SUMMARY_MODE"] = "fork";
	try {
		// ── re-summary: unit 1 closed, weakly settled (audit failed), no resolve ──
		seq = 0;
		const reply = "VERIFIED\nFACTS: re-verified\nEVIDENCE: MARKER-2";
		const auditFork = writeFork(1, reply, "fork-audit-u1-resummary.jsonl");
		const newStub = "the re-summarized stub (latest wins)";
		const stubFork = writeStubFork(1, newStub, "stubfork-u1-resummary.jsonl");
		const { runner, calls } = makeRunner({ forkFile: auditFork, stubForkFile: stubFork });
		__setCloseAuditRunner(runner);
		const weakSettlement = { v: 1, kind: "settlement", unitId: 1, retrievalId: "weakweakweak12", verdict: "UNVERIFIED-AUDIT-FAILED", line: "weakweakweak12 UNVERIFIED-AUDIT-FAILED — claims UNVERIFIED: verify before acting", auditFile: "f", replyId: null, parsedClean: false, ts: 1, sections: { STUB: "old stub", REASON: "handoff-missing" } };
		const branch: PiEntry[] = [
			msg("user", "write data.txt with 42"),
			{ id: `close${++seq}`, type: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 1, stub: "old stub", toolCallId: "tc0", ts: 1, mode: "manual" } },
			msg("toolResult", "Unit 1 closed — audit UNVERIFIED (audit-failed)", { toolCallId: "tc0", toolName: "close_unit", isError: false }),
			{ id: `settled${++seq}`, type: "custom", customType: "sam", data: weakSettlement },
			goalAnchorEntry(),
		];
		const { pi, ctx } = forkSetup(branch);
		await load(pi, ctx);

		const res = await forkCloseUnit(pi, ctx, {}, "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit VERIFIED \([0-9a-f]{12}\)/, "the same unit (1) closes again");
		assert.equal((res.details as { unitId: number; reSummary: boolean; closed: boolean; audit: string }).unitId, 1, "the re-summary targets the SAME unit");
		assert.equal((res.details as { reSummary: boolean }).reSummary, true);

		const recs = samRecords(pi) as unknown as { kind: string; unitId?: number; stub?: string; basis?: string }[];
		assert.equal(recs.filter((r) => r.kind === "close").length, 0, "no NEW close record — the re-summary reuses the existing one (immutable; the kind:\"stub\" entry is latest-wins)");
		const stubRecs = recs.filter((r) => r.kind === "stub");
		assert.equal(stubRecs.length, 1, "one kind:\"stub\" ledger entry (latest-wins)");
		assert.equal(stubRecs[0].unitId, 1);
		assert.equal(stubRecs[0].stub, newStub);
		assert.equal(stubRecs[0].basis, "summary-child", "provenance: the summary child wrote it");
		assert.equal(recs.filter((r) => r.kind === "settlement").length, 1, "one NEW settlement this run (the old weak one stays on the branch)");
		assert.equal((recs.filter((r) => r.kind === "settlement")[0] as { verdict: string }).verdict, "VERIFIED");
		assert.ok(pi.branch.some((b) => b.type === "custom" && (b.data as { kind?: string; verdict?: string })?.kind === "settlement" && (b.data as { verdict?: string })?.verdict === "UNVERIFIED-AUDIT-FAILED"), "the old weak settlement is still on the branch");
		assert.equal(calls.length, 4, "the re-summary runs the full stub + audit pipeline again");

		// ── strong last close ⇒ a NEW unit ──
		seq = 0;
		const auditFork2 = writeFork(2, "VERIFIED\nFACTS: two\nEVIDENCE: M2", "fork-audit-u2-strong.jsonl");
		const stubFork2 = writeStubFork(2, "unit two's stub", "stubfork-u2-strong.jsonl");
		const r2 = makeRunner({ forkFile: auditFork2, stubForkFile: stubFork2 });
		__setCloseAuditRunner(r2.runner);
		const strongBranch: PiEntry[] = [
			msg("user", "write data.txt with 42"),
			{ id: `close${++seq}`, type: "custom", customType: "sam", data: { v: 1, kind: "close", unitId: 1, stub: "old stub", toolCallId: "tc0", ts: 1, mode: "manual" } },
			msg("toolResult", "Unit 1 closed — audit VERIFIED", { toolCallId: "tc0", toolName: "close_unit", isError: false }),
			{ id: `settled${++seq}`, type: "custom", customType: "sam", data: { v: 1, kind: "settlement", unitId: 1, retrievalId: "strongstrong12", verdict: "VERIFIED", line: "strongstrong12 VERIFIED: old stub", auditFile: "f", replyId: "r", parsedClean: true, ts: 1 } },
			{ id: `resolve${++seq}`, type: "custom", customType: "sam", data: { v: 1, kind: "resolve", unitId: 1, basis: "close-audit", ts: 1 } },
			goalAnchorEntry(),
		];
		const pi2 = makeFakePi(strongBranch);
		const ctx2 = makeFakeCtx(pi2, MAIN_FILE);
		await load(pi2, ctx2);
		const res2 = await forkCloseUnit(pi2, ctx2, {}, "tc2");
		assert.equal((res2.details as { unitId: number; reSummary?: boolean }).unitId, 2, "a STRONG last close ⇒ the next unit (2), no re-summary");
		assert.equal((res2.details as { reSummary?: boolean }).reSummary, undefined);
		const close2 = pi2.appended.filter((a) => (a.data as { kind?: string })?.kind === "close")[0].data as { unitId: number; stub: string; stubSource: string };
		assert.equal(close2.unitId, 2);
		assert.equal(close2.stub, "unit two's stub");
		assert.equal(close2.stubSource, "child");
	} finally {
		__setCloseAuditRunner(null);
		delete process.env["SAM_SUMMARY_MODE"];
	}
});

test("v0.0.25 main mode: a MISSING stub is refused (stub-missing) before anything runs; an EMPTY string still flows to the P3 empty-stub gate", async () => {
	process.env["SAM_SUMMARY_MODE"] = "main";
	seq = 0;
	try {
		const { runner, calls } = makeRunner({});
		__setCloseAuditRunner(runner);
		const { pi, ctx } = forkSetup([msg("user", "write data.txt with 42"), msg("toolResult", "wrote data.txt with 42", { toolCallId: "c1", toolName: "write_file" }), goalAnchorEntry()]);
		await load(pi, ctx);

		const res = await forkCloseUnit(pi, ctx, {}, "tc1"); // no stub key at all
		assert.match(res.content[0].text as string, /close_unit refused: the stub is missing — in main mode the stub is required/);
		assert.equal((res.details as { rejected: string }).rejected, "stub-missing");
		assert.equal(samRecords(pi).length, 0);
		assert.equal(calls.length, 0);

		// an empty string is NOT a missing stub — it is the P3 gate's case
		const res2 = await forkCloseUnit(pi, ctx, { stub: "" }, "tc2");
		assert.match(res2.content[0].text as string, /Call close_unit again with a real stub/);
		assert.equal(samRecords(pi).length, 0, "the P3 gate records nothing either");
	} finally {
		__setCloseAuditRunner(null);
		delete process.env["SAM_SUMMARY_MODE"];
	}
});

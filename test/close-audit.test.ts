/**
 * v4 close-audit handler matrix (S4 gate, v4-plan §5): the `close` dial driven
 * through the fake ExtensionAPI + an INJECTABLE child runner (the suite never
 * spawns a real process — the live probe banks do that; the v3 convention in
 * test/extension.test.ts, which stays the v3-dial regression file).
 *
 * The fake child runner scripts the two children (prepare = model-free
 * `/sam audit <n>` with its handoff; audit = one model turn whose reply is
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

process.env["SAM_AUDIT_DELIVERY"] = "close";
process.env["SAM_SETTINGS_JSON"] = JSON.stringify({ extensions: ["pi-self-aware-memory"] });

import factory, { __setCloseAuditRunner, type CloseAuditRunner } from "../extensions/self-aware-memory/index.ts";
import { AUDIT_INSTRUCTION_PREFIX, CLOSE_UNIT_NO_NEW_WORK_TEXT, CLOSE_UNIT_AUDIT_FORK_TEXT } from "../src/protocol.ts";

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
	notifyCalls: { text: string; type?: string }[];
	branch: PiEntry[];
	contextUsage?: { tokens: number | null; contextWindow: number };
	idle: boolean;
}
function makeFakePi(branch: PiEntry[] = []): FakePi {
	return { commands: new Map(), tools: new Map(), listeners: new Map(), appended: [], sent: [], notifyCalls: [], branch, idle: true };
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
}
function makeRunner(script: ChildScript): { runner: CloseAuditRunner; calls: { label: string; args: string[] }[] } {
	const calls: { label: string; args: string[] }[] = [];
	const runner: CloseAuditRunner = {
		run: async (args, opts) => {
			calls.push({ label: opts.label, args: [...args] });
			if (script.throw) throw new Error(script.throw);
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

/* ── the matrix ──────────────────────────────────────────────────────────── */

test("close dial: the audit runs synchronously inside close_unit; VERIFIED one-line result; the settlement + resolve commit AT VERDICT (D9) — nothing audit-flavored on the main line", async () => {
	seq = 0;
	const reply = "VERIFIED\nFACTS: data.txt was written with 42\nEVIDENCE: MARKER-1";
	writeFork(1, reply, "fork-u1.jsonl");
	const { runner, calls } = makeRunner({ forkFile: path.join(WORKDIR, "fork-u1.jsonl") });
	__setCloseAuditRunner(runner);
	try {
		const u = msg("user", "write data.txt with the number 42");
		const pi = makeFakePi([u]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit VERIFIED \([0-9a-f]{12}\)$/);
		assert.equal(pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close").length, 1, "the close record is committed file-durable");
		assert.equal(pi.sent.length, 0, "no in-series audit message on the main line");
		assert.equal(calls.length, 2, "prepare + audit child exactly");
		assert.ok(calls[0].args.at(-1) === "/sam audit 1", "prepare child runs the v3 model-free command");
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
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit CORRECTIONS: the count is 7, not 42 \([0-9a-f]{12}\)$/);
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
	__setCloseAuditRunner(runner);
	try {
		const pi = makeFakePi([msg("user", "write data.txt")]);
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);
		const res = await closeUnit(pi, ctx, "wrote data.txt", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; prepare-exit-failed\)\./);
		assert.equal(pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close").length, 1);
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
		assert.equal(pi.appended.filter((a) => (a.data as { kind?: string })?.kind === "close").length, 1);
		const settlement = samRecords(pi).find((r) => r.kind === "settlement");
		assert.equal((settlement as unknown as { verdict?: string })?.verdict, "UNVERIFIED-AUDIT-FAILED", "the timeout settled the weak form (the content survives)");
	} finally {
		__setCloseAuditRunner(null);
	}
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
		const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
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

/* ── cleanup ─────────────────────────────────────────────────────────────── */

test.after(() => {
	try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

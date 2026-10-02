/**
 * D8/D9 owed arms (v4-plan §9; the batch that must be green before any
 * battery rep — the run-sam-small-units-02 incident is the spec input:
 * close committed + audit complete + settle pending (the close's turn
 * never ended) → the native fold preempted the settle and folded the span
 * lossy, and the nudge guard (pendingCloses) sat silent ~36 min with no
 * trace). The arms re-demonstrate the invariants the incident broke, in
 * the fake harness (the suite never spawns a real process — the live
 * probes do that; v3 convention).
 *
 * ARM-1 (DECISIVE): close ⇒ settle at VERDICT (the settle boundary never
 * comes — the incident state) ⇒ compaction mid-flight ⇒ the takeover
 * summary carries the settlement line verbatim. This is the shape that
 * would have saved unit 1 in run-02.
 *
 * ARM-2: light-audit rung — `SAM_AUDIT_DEPTH=light` ⇒ the audit child gets
 * the LIGHT instruction (one turn, no tools, delivery-check-only); a
 * `NOT-YET-VERIFIED` reply is its contract and rides the settlement line +
 * the takeover. At `full` depth the same reply is a CONTRACT VIOLATION ⇒
 * the D9 hatch (UNVERIFIED (audit-failed)).
 *
 * ARM-3: the hatch — planted audit timeout ⇒ `UNVERIFIED (audit-failed)`
 * one-liner + the weak settlement commits AT CLOSE (stub + claims "verify
 * before acting") and the takeover (NO settle boundary in between) carries
 * it. The same-stub re-close then UPGRADES: the strong settlement appends
 * (naming the weak one in `supersedes`) and the LATEST wins at takeover —
 * the folded view keeps the strong line, not the weak one.
 *
 * ARM-4: the nudge guard (D9) — post-close, settle boundary never arrives,
 * zone in-band at ≥ W−2R + gap ≥ 20k ⇒ the `band` nudge FIRES (the old
 * pendingCloses guard is gone); under cooldown / below the floor it
 * stays silent (the 96k/105k shape), and a would-have-fired decision
 * caught by an audit guard is logged (suppressed ledger entry) at the
 * core level.
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
// The nudge is ON by default (Paul, 2026-10-02) — assert the default, not
// an explicit env, so ARM-4 pins the shipped default.
delete process.env["SAM_NUDGE"];

import factory, { __setCloseAuditRunner, type CloseAuditRunner } from "../extensions/self-aware-memory/index.ts";
import { AUDIT_INSTRUCTION_PREFIX } from "../src/protocol.ts";
import { NUDGE_LEDGER_CUSTOM_TYPE, decideNudge, createNudgeRuntime, nudgeLedgerEntry } from "../src/nudge.ts";

/* ── fakes (the close-audit.test.ts shape) ─────────────────────────────── */

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
const nextId = () => `a${++seq}`;
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
		waitForIdle: async () => { f.idle = true; },
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
async function closeUnit(pi: FakePi, ctx: Record<string, unknown>, stub: string, toolCallId: string): Promise<ToolResult> {
	const tool = pi.tools.get("close_unit");
	assert.ok(tool, "the close_unit tool must be registered");
	const result = await tool.execute(toolCallId, { stub }, new AbortController().signal, undefined, ctx);
	pi.branch.push(msg("toolResult", (result.content[0] as { text: string }).text, { toolCallId, toolName: "close_unit", isError: false }));
	return result;
}
async function messageEnd(pi: FakePi, ctx: Record<string, unknown>, content: unknown): Promise<void> {
	const ends = pi.listeners.get("message_end") ?? [];
	assert.equal(ends.length, 1, "exactly one message_end listener");
	const m = { role: "assistant", content, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
	pi.branch.push({ id: nextId(), type: "message", message: m });
	await ends[0]({ message: m }, ctx);
}
/** Fire the message_end for the close's toolResult message (the real event
 * stream after a successful tool call; re-arms the nudge stretch). */
async function toolResultEnd(pi: FakePi, ctx: Record<string, unknown>, toolCallId: string): Promise<void> {
	const ends = pi.listeners.get("message_end") ?? [];
	assert.equal(ends.length, 1);
	const m = { role: "toolResult", content: [{ type: "text", text: "Unit 1 closed — audit VERIFIED (x)" }], toolCallId, toolName: "close_unit", isError: false, timestamp: Date.now() };
	pi.branch.push({ id: nextId(), type: "message", message: m });
	await ends[0]({ message: m }, ctx);
}
/** D8/D9: fire the compaction takeover (session_before_compact) directly. */
async function compact(pi: FakePi, ctx: Record<string, unknown>, firstKeptEntryId: string): Promise<{ summary: string; firstKeptEntryId?: string; details?: unknown }> {
	const hooks = pi.listeners.get("session_before_compact") ?? [];
	assert.equal(hooks.length, 1, "exactly one session_before_compact listener");
	const out = (await hooks[0]({ preparation: { firstKeptEntryId, tokensBefore: 120000, previousSummary: undefined }, branchEntries: pi.branch as never }, ctx)) as
		| { compaction: { summary: string; firstKeptEntryId?: string; details?: unknown } }
		| undefined;
	assert.ok(out, "the branch carries a settlement ⇒ the takeover owns the summary");
	return out.compaction;
}
const samRecords = (pi: FakePi) => pi.appended.filter((a) => a.customType === "sam").map((a) => a.data as { kind: string; unitId?: number });
const nudgeRecords = (pi: FakePi) => pi.appended.filter((a) => a.customType === NUDGE_LEDGER_CUSTOM_TYPE).map((a) => a.data as Record<string, unknown>);

/* ── the scripted children + fork bank ──────────────────────────────────── */

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sam-d8d9-arms-"));
const MAIN_FILE = path.join(WORKDIR, "main.jsonl");
function writeFork(unitId: number, reply: string, name: string): string {
	const f = path.join(WORKDIR, name);
	const lines = [
		{ type: "session", id: "forkroot", version: 3, timestamp: "2026-10-02T00:00:00.000Z", cwd: WORKDIR },
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
function makeRunner(script: ChildScript): CloseAuditRunner {
	return {
		run: async (args, opts) => {
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
}

/* ── ARM-1 (DECISIVE): settle-at-verdict wins the race the fold won in
   run-02: the settle boundary never comes, the fold does — and the summary
   still carries the settlement line ──────────────────────────────────────── */

test("ARM-1 (decisive, the run-02 shape): close → NO settle boundary → compaction mid-flight → the takeover carries the settlement line verbatim", async () => {
	seq = 0;
	const reply = "VERIFIED\nFACTS: data.txt was written with 42\nEVIDENCE: MARKER-1";
	const fork = writeFork(1, reply, "arm1-fork.jsonl");
	__setCloseAuditRunner(makeRunner({ forkFile: fork }));
	try {
		const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
		pi.contextUsage = { tokens: 30000, contextWindow: 131072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit VERIFIED \([0-9a-f]{12}\)$/, "the one-liner is the v4 verified form");

		// D9: settlement + resolve committed AT VERDICT — the settle
		// boundary NEVER comes (the close's turn never ended — run-02).
		const settlement = samRecords(pi).find((r) => r.kind === "settlement") as { line: string; retrievalId: string };
		assert.ok(settlement, "the settlement is on the branch (verdict commit) — before any settle");
		assert.equal(samRecords(pi).filter((r) => r.kind === "settlement").length, 1, "exactly one settlement (no double commit)");

		// THE RACE: the compaction now (mid-flight; no settle in between).
		const taken = await compact(pi, ctx, pi.branch[1].id);
		assert.equal(taken.firstKeptEntryId, pi.branch[1].id, "pi's cut point rides through (channel B untouched)");
		assert.ok(taken.summary.includes(settlement.line), "the settlement line survives the fold VERBATIM (channel A) — the run-02 loss does not happen");
		assert.ok(Object.keys(taken.details ?? {}).length > 0, "the retrieval details slot is first-class");
	} finally {
		__setCloseAuditRunner(null);
	}
});

/* ── ARM-2: the light rung (D8) + the full-depth contract ───────────────── */

test("ARM-2a (light rung): SAM_AUDIT_DEPTH=light ⇒ LIGHT instruction (one turn, no tools); NOT-YET-VERIFIED is its contract and rides settlement + takeover", async () => {
	seq = 0;
	const reply = "NOT-YET-VERIFIED: files: 3/3 present; statements: delivered";
	const fork = writeFork(1, reply, "arm2a-fork.jsonl");
	const runner = makeRunner({ forkFile: fork });
	__setCloseAuditRunner(runner);
	const prompts: string[] = [];
	const wrapped: CloseAuditRunner = {
		run: async (args, opts) => {
			const p = args.indexOf("-p");
			if (p !== -1) prompts.push(args[p + 1]);
			return runner.run(args, opts);
		},
	};
	__setCloseAuditRunner(wrapped);
	try {
		process.env["SAM_AUDIT_DEPTH"] = "light";
		const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
		pi.contextUsage = { tokens: 30000, contextWindow: 131072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc1");
		const auditPrompt = prompts.find((p) => p.includes("Light AUDIT".toUpperCase()) || p.includes("LIGHT AUDIT")) ?? prompts.at(-1);
		assert.ok(auditPrompt, "an audit instruction reached the child");
		assert.ok(auditPrompt.includes("LIGHT AUDIT"), "the child got the LIGHT instruction (not the full audit)");
		assert.ok(auditPrompt.includes("NO tool calls"), "light contract: one turn, zero tool calls");

		assert.match(res.content[0].text as string, /^Unit 1 closed — audit NOT-YET-VERIFIED: files: 3\/3 present; statements: delivered \([0-9a-f]{12}\)\./);
		assert.match(res.content[0].text as string, /verify them before acting/);

		const settlement = samRecords(pi).find((r) => r.kind === "settlement") as unknown as { verdict: string; line: string };
		assert.equal(settlement.verdict, "NOT-YET-VERIFIED", "the settlement records the light verdict");
		assert.match(settlement.line, /NOT-YET-VERIFIED: files: 3\/3 present; statements: delivered — unmarked claims: verify before acting/);

		const taken = await compact(pi, ctx, pi.branch[1].id);
		assert.ok(taken.summary.includes(settlement.line), "the NOT-YET-VERIFIED line rides channel A into the summary");
	} finally {
		delete process.env["SAM_AUDIT_DEPTH"];
		__setCloseAuditRunner(null);
	}
});

test("ARM-2b (full-depth contract): NOT-YET-VERIFIED at full depth is a contract violation ⇒ the D9 hatch (UNVERIFIED (audit-failed))", async () => {
	seq = 0;
	const fork = writeFork(1, "NOT-YET-VERIFIED: files: 3/3 present; statements: delivered", "arm2b-fork.jsonl");
	__setCloseAuditRunner(makeRunner({ forkFile: fork }));
	try {
		process.env["SAM_AUDIT_DEPTH"] = "full";
		const pi = makeFakePi([msg("user", "write data.txt")]);
		pi.contextUsage = { tokens: 30000, contextWindow: 131072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		const res = await closeUnit(pi, ctx, "wrote data.txt", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; reply-unparseable\)\./);
		assert.match(res.content[0].text as string, /verify its claims before acting/);
		const settlement = samRecords(pi).find((r) => r.kind === "settlement") as unknown as { verdict: string };
		assert.equal(settlement?.verdict, "UNVERIFIED-AUDIT-FAILED", "the violation settled the weak form (the close never leaves unsettled)");
	} finally {
		delete process.env["SAM_AUDIT_DEPTH"];
		__setCloseAuditRunner(null);
	}
});

/* ── ARM-3: the hatch + the weak→strong upgrade (append-only, latest wins) ─ */

test("ARM-3 (hatch + upgrade): planted audit timeout ⇒ UNVERIFIED (audit-failed) commits AT CLOSE; the takeover (no settle) carries it; the same-stub re-close upgrades — latest wins at takeover", async () => {
	seq = 0;
	const goodReply = "VERIFIED\nFACTS: data.txt was written with 42\nEVIDENCE: MARKER-1";
	writeFork(1, goodReply, "arm3-fork.jsonl");
	const goodFork = path.join(WORKDIR, "arm3-fork.jsonl");

	// phase 1: the audit TIMES OUT ⇒ the hatch
	__setCloseAuditRunner(makeRunner({ audit: { code: null, timedOut: true } }));
	const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
	pi.contextUsage = { tokens: 30000, contextWindow: 131072 };
	const ctx = makeFakeCtx(pi, MAIN_FILE);
	await load(pi, ctx);

	const r1 = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc1");
	assert.match(r1.content[0].text as string, /^Unit 1 closed — audit UNVERIFIED \(audit-failed: .+; audit-timeout\)\./);
	const weak = samRecords(pi).find((r) => r.kind === "settlement") as unknown as { verdict: string; line: string; retrievalId: string };
	assert.equal(weak?.verdict, "UNVERIFIED-AUDIT-FAILED", "the hatch settlement committed at close time");
	assert.match(weak?.line as string, /UNVERIFIED-AUDIT-FAILED: wrote data\.txt with 42/); // the stub's content survives verbatim
	assert.match(weak?.line as string, /claims UNVERIFIED: verify before acting/);

	// phase 2: the fold comes — NO settle boundary in between (the run-02
	// state): the weak settlement still rides channel A
	const taken1 = await compact(pi, ctx, pi.branch[1].id);
	assert.ok((taken1.summary as string).includes(weak?.line as string), "the weak settlement survives the fold (content survival — Paul's contract)");

	// phase 3: the D5/D9 upgrade lever — same-stub re-close; the audit now succeeds
	__setCloseAuditRunner(makeRunner({ forkFile: goodFork }));
	const r2 = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc2");
	assert.match(r2.content[0].text as string, /^Unit 1 closed — audit VERIFIED \([0-9a-f]{12}\)$/, "still UNIT 1 — the upgrade did not mint unit 2");
	const settlements = (samRecords(pi).filter((r) => r.kind === "settlement") as { verdict: string; line: string; supersedes?: string; retrievalId: string }[]);
	assert.equal(settlements.length, 2, "append-only: the weak stays, the strong appends");
	assert.equal(settlements[0].verdict, "UNVERIFIED-AUDIT-FAILED");
	assert.equal(settlements[1].verdict, "VERIFIED");
	assert.equal(settlements[1].supersedes, settlements[0].retrievalId, "the strong settlement names the weak one it replaces");
	assert.equal(samRecords(pi).filter((r) => r.kind === "close").length, 1, "one close record (the upgrade reused the unit)");

	// phase 4: the next fold keeps the LATEST (strong) line — not the weak one
	const taken2 = await compact(pi, ctx, pi.branch[2].id);
	assert.ok((taken2.summary as string).includes(settlements[1].line), "the strong settlement line rides channel A");
	assert.ok(!(taken2.summary as string).includes("UNVERIFIED-AUDIT-FAILED"), "latest-per-unit: the weak line is superseded in the summary");
});

/* ── ARM-4: the nudge guard (D9) — the run-02 ~36-min blind window ───────── */

test("ARM-4 (nudge guard): post-close, settle boundary never arrived, zone in-band: the `band` nudge FIRES (the old pendingCloses guard is gone); below the floor / in cooldown it stays silent", async () => {
	seq = 0;
	const fork = writeFork(1, "VERIFIED\nFACTS: data.txt was written with 42", "arm4-fork.jsonl");
	__setCloseAuditRunner(makeRunner({ forkFile: fork }));
	try {
		const pi = makeFakePi([msg("user", "write data.txt with the number 42")]);
		pi.contextUsage = { tokens: 80000, contextWindow: 131072 };
		const ctx = makeFakeCtx(pi, MAIN_FILE);
		await load(pi, ctx);

		// The close (the run-02 state: settle boundary never arrives — under
		// the OLD guard, pendingCloses stayed non-empty and every nudge
		// decision after this was swallowed silently).
		const res = await closeUnit(pi, ctx, "wrote data.txt with 42", "tc1");
		assert.match(res.content[0].text as string, /^Unit 1 closed — audit VERIFIED/, "the close settled at verdict (so there is nothing pending to suppress)");
		assert.equal(pi.sent.length, 0, "no nudge before the close");

		// The close's toolResult message ends the turn segment — the real
		// event stream (it re-arms the nudge stretch; without it the stale
		// pre-close baseline would leak into this test).
		await toolResultEnd(pi, ctx, "tc1");

		// Fresh stretch (the close re-armed it): the first observation
		// re-stamps the baseline — gap 0 ⇒ below the floor ⇒ SILENT (the
		// 96k/105k shape: the unclosed tail fits the kept window).
		pi.contextUsage = { tokens: 100000, contextWindow: 131072 }; // watch zone (≥ W−2R = 98304)
		await messageEnd(pi, ctx, "continuing the work");
		assert.equal(pi.sent.length, 0, "below the 20k gap floor: no fire (the silence is the correct call)");
		assert.equal(nudgeRecords(pi).length, 0, "no nudge ledger entry for a non-fire");

		// The tail grows past the floor, still in-band (≥ W−2R): the `band`
		// urgency fires — THIS is the decision the run-02 guard swallowed
		// for ~36 minutes at 88–90%.
		pi.contextUsage = { tokens: 126000, contextWindow: 131072 }; // action zone (≥ W−R = 114688)
		await messageEnd(pi, ctx, "continuing the work");
		assert.equal(pi.sent.length, 1, "the band nudge fires post-close despite no settle boundary having arrived (D9 guard: pendingCloses no longer suppresses)");
		assert.ok((pi.sent[0].text as string).startsWith("[sam-nudge]"), "the nudge text carries the provenance marker");
		assert.match(pi.sent[0].text as string, /climbing toward pi's compaction line/, "band wording: the imminent-fold warning");
		assert.equal(nudgeRecords(pi).length, 1, "the fire left its ledger trace");
		const rec = nudgeRecords(pi)[0] as { trigger: string; zone: string; gapTokens: number };
		assert.equal(rec.trigger, "band");
		assert.equal(rec.zone, "action");
		assert.equal(rec.gapTokens, 26000, "gap = observed ctx − baseline (126000 − 100000)");
		assert.equal((rec as { suppressed?: boolean }).suppressed, undefined, "this entry is a fire, not a suppression");
	} finally {
		__setCloseAuditRunner(null);
	}
});

test("ARM-4b (suppression trace, core level): a would-have-fired decision caught by an audit guard leaves a `suppressed` ledger entry (F1 — the run-02 gap left none)", () => {
	/** D9: a suppressed decision's ledger shape (what the wiring records). */
	const base = {
		enabled: true,
		closeDial: true,
		zone: "action" as const,
		st: createNudgeRuntime(),
		contextTokens: 120000,
		gapFloorTokens: 20000,
		toolCallFloor: 15,
		thinkingFloor: 5000, // Paul's 2026-10-02 default (2–3 medium turns or one big turn)
	};
	const free = decideNudge({ ...base, auditInFlight: false, auditFork: false });
	assert.equal(free.fire, true, "without a guard, the in-band over-floor decision fires");
	const held = decideNudge({ ...base, auditInFlight: true, auditFork: false });
	assert.equal(held.fire, false);
	if (held.fire === false) assert.equal(held.why, "audit-in-flight");
	const heldFork = decideNudge({ ...base, auditInFlight: false, auditFork: true });
	assert.equal(heldFork.fire, false);
	if (heldFork.fire === false) assert.equal(heldFork.why, "audit-fork");

	// the suppressed decision's ledger shape (what the wiring records):
	const entry = nudgeLedgerEntry({
		trigger: "band",
		now: Date.now(),
		zone: "action",
		tokens: 120000,
		contextWindow: 131072,
		gapTokens: 40000,
		reasoningChars: 0,
		suppressed: true,
		suppressReason: "audit-in-flight",
		suppressDetail: "band-pressure (zone=action, gap=40000, floor=20000)",
	});
	assert.equal(entry.suppressed, true);
	assert.equal(entry.suppressReason, "audit-in-flight");
	assert.match(entry.suppressDetail as string, /band-pressure/);
	// and a fire entry carries NO suppression marker (the two stay
	// distinguishable in the readout — F1):
	const fire = nudgeLedgerEntry({ trigger: "band", now: Date.now(), zone: "action", tokens: 120000, contextWindow: 131072, gapTokens: 40000, reasoningChars: 0 });
	assert.equal(fire.suppressed, undefined);
});

/* ── cleanup ─────────────────────────────────────────────────────────────── */

test.after(() => {
	try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

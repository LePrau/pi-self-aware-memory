/**
 * Cross-check against real pi v0.87.1 (the semantic model, per P1):
 * the same synthetic scenarios run through BOTH our pure modules and pi's
 * own SessionManager + estimateProjectedContextTokens; projection text and
 * token estimates must match exactly.
 *
 * The pi import is optional: set SAM_PI_DIR to a node_modules directory
 * containing @earendil-works/pi-coding-agent (e.g. the pi-binary dir).
 * Without it, every test here is SKIPPED — the pure suite still runs.
 *
 * Run: SAM_PI_DIR=/workspace/pi-binary/0.87.1/node_modules node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildProjection, projectedText, type PlainEntry, type PlainMessage } from "../src/projection.ts";
import { estimateProjectedTokens } from "../src/estimate.ts";

const PI_DIR = process.env.SAM_PI_DIR;
const t = PI_DIR ? test : test.skip;

let SessionManager: any;
let estimateProjectedContextTokens: (projection: unknown, branch: unknown[]) => { tokens: number };
if (PI_DIR) {
	const mod = await import(pathToFileURL(join(PI_DIR, "@earendil-works/pi-coding-agent", "dist", "index.js")).href);
	SessionManager = mod.SessionManager;
	const compaction = await import(pathToFileURL(join(PI_DIR, "@earendil-works/pi-coding-agent", "dist", "core", "compaction", "index.js")).href);
	estimateProjectedContextTokens = compaction.estimateProjectedContextTokens;
}

/* ── pi-side helpers ─────────────────────────────────────────────────────── */

function piAssistant(text: string, withUsage = false) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: withUsage
			? { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
			: undefined,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function piUser(text: string) {
	return { role: "user", content: text, timestamp: Date.now() };
}

function piToolResult(text: string) {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "close_unit",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function piTextOf(m: { content?: unknown; summary?: string; command?: string; output?: string }): string {
	if (typeof m.summary === "string") return m.summary;
	if (typeof m.command === "string" || typeof m.output === "string") {
		return (m.command ?? "") + (m.output ?? "");
	}
	const c = m.content;
	if (typeof c === "string") return c;
	return c
		.flatMap((p: { type: string; text?: string }) => (p.type === "text" ? [p.text ?? ""] : []))
		.join("");
}

/* ── our-side mirror builders (same scenario, plain model) ───────────────── */

let n = 0;
const oid = () => `p${++n}`;
const ourUser = (text: string): PlainEntry => ({ id: oid(), kind: "message", message: { role: "user", content: text } });
const ourAssistant = (text: string, withUsage = false): PlainEntry => ({
	id: oid(),
	kind: "message",
	message: {
		role: "assistant",
		content: text,
		stopReason: "stop",
		usage: withUsage ? { totalTokens: 11, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } : undefined,
	},
});
const ourToolResult = (text: string): PlainEntry => ({
	id: oid(),
	kind: "message",
	message: { role: "toolResult", content: text, toolCallId: "call-1", toolName: "close_unit", isError: false },
});
const ourEdit = (targetId: string, replacement: { content: string } | null): PlainEntry => ({
	id: oid(),
	kind: "context_edit",
	targetId,
	replacement,
});
const ourCustom = (customType: string, data?: unknown): PlainEntry => ({ id: oid(), kind: "custom", customType, data });

/** Compare both projections: role sequence, per-message text, and pi's token estimate. */
function assertSame(piSession: any, ours: PlainEntry[]) {
	const piProj = piSession.buildSessionProjection();
	const oursProj = buildProjection(ours);
	assert.deepEqual(
		piProj.messages.map((m: PlainMessage) => m.role),
		oursProj.messages.map((m) => m.role),
		"role sequences must match",
	);
	assert.deepEqual(
		piProj.messages.map(piTextOf),
		oursProj.messages.map((m) => projectedText(m)),
		"projected texts must match",
	);
	const piEstimate = estimateProjectedContextTokens(piProj, piSession.getBranch());
	assert.equal(
		estimateProjectedTokens(oursProj, ours).tokens,
		piEstimate.tokens,
		`token estimates must match (pi=${piEstimate.tokens})`,
	);
}

t("omission: null edits drop entries from the projection, raw stays in the branch", () => {
	const session = SessionManager.inMemory();
	session.appendMessage(piUser("request"));
	const aId = session.appendMessage(piAssistant("partial", true));
	const rId = session.appendMessage(piToolResult("raw output"));
	session.appendContextEdit(aId, null);
	session.appendContextEdit(rId, null);

	const u = ourUser("request");
	const a = ourAssistant("partial", true);
	const r = ourToolResult("raw output");
	const ours: PlainEntry[] = [u, a, r, ourEdit(a.id, null), ourEdit(r.id, null)];
	assertSame(session, ours);

	// raw still in the branch (reversibility):
	const rawCount = session.getBranch().filter((e: { type: string }) => e.type === "message").length;
	assert.equal(rawCount, 3);
});

t("latest edit wins; string replacements project for assistant", () => {
	const session = SessionManager.inMemory();
	const aId = session.appendMessage(piAssistant("original"));
	session.appendContextEdit(aId, { content: "first" });
	session.appendContextEdit(aId, null);
	session.appendContextEdit(aId, { content: "restored" });

	const a = ourAssistant("original");
	const ours: PlainEntry[] = [
		a,
		ourEdit(a.id, { content: "first" }),
		ourEdit(a.id, null),
		ourEdit(a.id, { content: "restored" }),
	];
	assertSame(session, ours);
});

t("string replacement on toolResult normalizes to text blocks (text equivalent)", () => {
	const session = SessionManager.inMemory();
	session.appendMessage(piUser("run it"));
	const rId = session.appendMessage(piToolResult("old output"));
	session.appendContextEdit(rId, { content: "new output" });

	const u = ourUser("run it");
	const r = ourToolResult("old output");
	const ours: PlainEntry[] = [u, r, ourEdit(r.id, { content: "new output" })];
	assertSame(session, ours);
});

t("usage shortcut trusted without a later edit, invalidated by one", () => {
	const session = SessionManager.inMemory();
	session.appendMessage(piUser("do X"));
	const aId = session.appendMessage(piAssistant("partial", true));
	// trusted: 11 (usage) + 0 trailing
	const ours: PlainEntry[] = [ourUser("do X"), ourAssistant("partial", true)];
	assertSame(session, ours);
	assert.equal(estimateProjectedTokens(buildProjection(ours), ours).tokens, 11);

	// a later context_edit invalidates the shortcut → per-message sum
	session.appendContextEdit(aId, null);
	const ours2: PlainEntry[] = [...ours, ourEdit(ours[1].id, null)];
	assertSame(session, ours2);
});

t("the P2 fold shape: stub replaces the first entry, nulls after, ledger + audit trail outside the span", () => {
	const session = SessionManager.inMemory();
	const uId = session.appendMessage(piUser("write data.txt"));
	const aId = session.appendMessage(piAssistant("working"));
	const rId = session.appendMessage(piToolResult("Unit 1 closed"));
	session.appendCustomEntry("sam", { v: 1, kind: "close", unitId: 1, stub: "wrote data.txt", toolCallId: "call-1", ts: 1, mode: "manual" });
	session.appendMessage(piUser("[sam-audit] Unit 1: ..."));
	session.appendMessage(piAssistant("VERIFIED"));
	session.appendContextEdit(uId, { content: "[Unit 1 ✓] wrote data.txt" });
	session.appendContextEdit(aId, null);
	session.appendContextEdit(rId, null);
	session.appendCustomEntry("sam", {
		v: 1,
		kind: "fold",
		unitId: 1,
		entryIds: [uId, aId, rId],
		spanFirstId: uId,
		spanLastId: rId,
		stub: "wrote data.txt",
		verdict: "VERIFIED",
		ts: 2,
		mode: "manual",
	});

	const u = ourUser("write data.txt");
	const a = ourAssistant("working");
	const r = ourToolResult("Unit 1 closed");
	const closeRec = { v: 1, kind: "close", unitId: 1, stub: "wrote data.txt", toolCallId: "call-1", ts: 1, mode: "manual" };
	const auditUser = ourUser("[sam-audit] Unit 1: ...");
	const verdict = ourAssistant("VERIFIED");
	const ours: PlainEntry[] = [
		u,
		a,
		r,
		ourCustom("sam", closeRec),
		auditUser,
		verdict,
		ourEdit(u.id, { content: "[Unit 1 ✓] wrote data.txt" }),
		ourEdit(a.id, null),
		ourEdit(r.id, null),
		ourCustom("sam", { v: 1, kind: "fold", unitId: 1, entryIds: [], ts: 2, mode: "manual" }),
	];
	assertSame(session, ours);
	// the audit exchange (user + assistant) is still projected — the visible trail:
	const roles = buildProjection(ours).messages.map((m) => m.role);
	assert.deepEqual(roles, ["user", "user", "assistant"]);
});

t("compaction: checkpoint drops pre-firstKept entries; only the newest compaction contributes", () => {
	const session = SessionManager.inMemory();
	session.appendMessage(piUser("old work"));
	// firstKeptEntryId = null → defaults to the compaction's own id (nothing kept before it)
	session.appendCompaction("old summary", null, 0);
	const newWorkId = session.appendMessage(piUser("new work"));
	session.appendCompaction("new summary", newWorkId, 0);
	session.appendMessage(piUser("after"));

	const u1 = ourUser("old work");
	const c1: PlainEntry = { id: "c1", kind: "compaction", summary: "old summary", firstKeptEntryId: "c1" };
	const u2 = ourUser("new work");
	const c2: PlainEntry = { id: "c2", kind: "compaction", summary: "new summary", firstKeptEntryId: u2.id };
	const u3 = ourUser("after");
	const ours: PlainEntry[] = [u1, c1, u2, c2, u3];
	assertSame(session, ours);
	assert.deepEqual(
		buildProjection(ours).messages.map((m) => projectedText(m)),
		["new summary", "new work", "after"],
	);
});

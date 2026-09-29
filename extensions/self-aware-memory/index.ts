/**
 * pi-self-aware-memory — auditable, in-series context compaction.
 *
 * The agent marks work units open/closed and, at close, writes its own stub
 * while the reasoning is still warm; the same model on the same warm prefix
 * audits the stub in one appended in-series turn; only then is the raw span
 * projected out with pi's append-only context edits. The session file keeps
 * every original byte, so every fold is reversible and offline-auditable.
 *
 * ── P2 (this file) ───────────────────────────────────────────────────────
 * The minimal end-to-end loop: `close_unit` tool, in-series auditor, folder,
 * append-only ledger (`sam` custom entries), `/sam status · mode · report ·
 * undo`. Modes: display (audits, never folds) and manual (verified units fold
 * at close); assisted/auto and `/sam fold` are P3 ("not yet" — never
 * silently).
 *
 * This file is the pi glue: all product logic is pure and unit-tested in
 * ../../src (projection, estimate, units, folder, ledger, verdict, protocol).
 * The glue's only job is to map pi's session API onto the plain-entry model
 * and to dispatch pi's boundaries. Every handler is fail-open (F1): an
 * internal error degrades to one stderr line and the session continues.
 *
 * Pi v0.87.1 mechanics relied on (verified against the pinned tag):
 * - context_edit drafts commit only at turn_end/agent_before_settle
 *   boundaries (BoundaryResult.entries); latest edit wins per target;
 *   null replacement omits the entry from the projection, raw stays in file;
 * - a queued user message + continue:true makes the audit a genuine
 *   in-series turn (a bare continue on an assistant-ending transcript is
 *   rejected by pi);
 * - /sam undo rides the same discipline: the command queues a short ack turn
 *   and the undo drafts commit at that turn's settle (one short warm turn).
 *
 * Output channels (src/output.ts): UI notification where a UI exists,
 * stderr in print mode, silence in json mode (stdout is the event stream).
 */
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ContextEditEntryDraft,
	ContextEditableContent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBoundaryDraft,
	SessionEntry,
	SessionMessageEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { EXTENSION_NAME, SAM_VERSION, describeBuild } from "../../src/identity.ts";
import {
	AUDIT_INSTRUCTION_PREFIX,
	CLOSE_UNIT_ALREADY_CLOSED_TEXT,
	CLOSE_UNIT_PENDING_TEXT,
	CLOSE_UNIT_TOOL,
	P2_MODES,
	auditInstruction,
	closeUnitResultText,
	isSamInjected,
	undoAck,
} from "../../src/protocol.ts";
import {
	assistantText,
	parseVerdict,
	type Verdict,
} from "../../src/verdict.ts";
import {
	messageText,
	type PlainEntry,
	type PlainMessage,
	type PlainUsage,
} from "../../src/projection.ts";
import { getAssistantUsage } from "../../src/estimate.ts";
import { lastRealUserEntryIsFolded, resolveUnitSpan, type PendingClose } from "../../src/units.ts";
import { buildFoldDrafts, buildUndoDrafts, type ContextEditDraft, type OriginalMessage } from "../../src/folder.ts";
import {
	SAM_LEDGER_CUSTOM_TYPE,
	rebuildLedger,
	type SamCloseRecord,
	type SamFoldRecord,
	type SamModeRecord,
	type SamNoFoldRecord,
	type SamUndoRecord,
} from "../../src/ledger.ts";
import { countUnits, createSamState, foldedEntryIdSet, isSamMode, SAM_MODES, type SamState } from "../../src/state.ts";
import { renderSamReport, renderSamStatus, samOutputChannel } from "../../src/output.ts";

/** Process-local state; one pi process drives one session at a time.
 * Rebuilt from the ledger at every session_start. */
let state: SamState = createSamState(rebuildLedger([]));

/* ── pi → plain-entry adapter (the only place pi shapes are touched) ────── */

/**
 * pi's `AgentMessage` (v0.87.1) → plain message. Exhaustive over the union;
 * content is taken by reference (no deep copy) — that reference pass-through is
 * what makes undo's byte-exact restoration hold, and it is the documented
 * basis for the single ContextEditableContent cast at the pi boundary.
 */
function toPlainMessage(m: SessionMessageEntry["message"]): PlainMessage {
	switch (m.role) {
		case "assistant":
			return {
				role: "assistant",
				content: m.content as PlainMessage["content"],
				stopReason: m.stopReason,
				usage: m.usage
					? {
							totalTokens: m.usage.totalTokens,
							input: m.usage.input,
							output: m.usage.output,
							cacheRead: m.usage.cacheRead,
							cacheWrite: m.usage.cacheWrite,
						}
					: undefined,
			};
		case "toolResult":
			return {
				role: "toolResult",
				content: m.content as PlainMessage["content"],
				toolCallId: m.toolCallId,
				toolName: m.toolName,
				isError: m.isError,
			};
		case "system":
			return { role: "system", content: (m.content ?? "") as PlainMessage["content"] };
		case "user":
			return { role: "user", content: m.content as PlainMessage["content"] };
		case "compactionSummary":
			return { role: "compactionSummary", content: "", summary: m.summary };
		case "branchSummary":
			return { role: "branchSummary", content: "", summary: m.summary };
		case "bashExecution":
			return { role: "bashExecution", content: "", command: m.command, output: m.output };
		case "custom":
			return { role: "custom", content: m.content as PlainMessage["content"], customType: m.customType };
	}
}

function toPlainEntries(branch: readonly SessionEntry[]): PlainEntry[] {
	const out: PlainEntry[] = [];
	for (const entry of branch) {
		switch (entry.type) {
			case "message":
				out.push({ id: entry.id, kind: "message", message: toPlainMessage(entry.message) });
				break;
			case "context_edit":
				out.push({
					id: entry.id,
					kind: "context_edit",
					targetId: entry.targetId,
					replacement: entry.replacement === null ? null : { content: entry.replacement.content },
				});
				break;
			case "custom":
				out.push({ id: entry.id, kind: "custom", customType: entry.customType, data: entry.data });
				break;
			case "compaction":
				out.push({
					id: entry.id,
					kind: "compaction",
					summary: entry.summary,
					firstKeptEntryId: entry.firstKeptEntryId,
					// pi's SystemMessage can carry sections/toolsAdded; the plain model
					// keeps the merged content text only (documented scope of the mirror).
					systemMessage: entry.systemMessage
						? {
									role: "system",
									content: (typeof entry.systemMessage.content === "string"
										? entry.systemMessage.content
										: entry.systemMessage.content?.map((b) => ("text" in b ? b.text : "")).join("") ?? ""),
							  }
						: undefined,
				});
				break;
			default:
				// header/label/etc.: contributes nothing to the plain model.
				break;
		}
	}
	return out;
}

function currentBranch(ctx: ExtensionContext): PlainEntry[] {
	return toPlainEntries(ctx.sessionManager.getBranch());
}

/* ── output ─────────────────────────────────────────────────────────────── */

function emit(ctx: ExtensionContext, text: string, uiType: "info" | "error" = "info"): void {
	const channel = samOutputChannel(ctx.hasUI, ctx.mode);
	if (channel === "ui") ctx.ui.notify(text, uiType);
	else if (channel === "stderr") console.error(text);
	// "none" (json mode): no output — the JSON stream must stay parseable.
}

function modelInfo(ctx: ExtensionContext): { provider: string; id: string } | undefined {
	const m = ctx.model;
	return m ? { provider: m.provider, id: m.id } : undefined;
}

function statusText(ctx: ExtensionContext): string {
	return renderSamStatus(
		{ state, usage: ctx.getContextUsage(), model: modelInfo(ctx) },
		countUnits(state.ledger),
	).join("\n");
}

/* ── ledger helpers (in-memory bookkeeping after durable writes) ────────── */

function recordCloseInMemory(unitId: number, stub: string): void {
	state.ledger.units.push({ unitId, stub, state: "in-flight", mode: state.mode });
	state.ledger.nextUnitId = unitId + 1;
}

/**
 * ContextEditDraft[] → pi's SessionBoundaryDraft[]. The single documented
 * cast: replacement content provenance is either (a) a fold stub string or
 * (b) a span entry's original pi content, passed through by reference (the
 * adapter casts pi content to PlainContent without copying). PlainContent
 * cannot be expressed as pi's per-role ContextEditableContent union, so the
 * bridge lives exactly here, at the pi boundary.
 */
function toBoundaryEntries(drafts: ContextEditDraft[], record?: unknown): SessionBoundaryDraft[] {
	const out: SessionBoundaryDraft[] = drafts.map((d): ContextEditEntryDraft => ({
		type: "context_edit",
		targetId: d.targetId,
		replacement: d.replacement === null ? null : { content: d.replacement.content as ContextEditableContent },
	}));
	if (record !== undefined) out.push({ type: "custom", customType: SAM_LEDGER_CUSTOM_TYPE, data: record });
	return out;
}

/* ── settlement dispatch (the only place context edits are drafted) ─────── */

/**
 * One settle processes pending work to completion, in priority order:
 * 1. an in-flight undo → commit its restoration drafts;
 * 2. the audit turn that just ended → capture its verdict;
 * 3. pending verdicts (oldest first) → commit fold or noFold each;
 * 4. a pending close (this turn) or a restored re-audit → resolve the span,
 *    queue the single in-series audit, and continue the session.
 *
 * The verdict capture and its commit happen in the SAME settle: after the
 * capture there is no further boundary (pi settles, and in print mode the
 * process exits), so deferring the commit would strand the verdict in
 * memory — a silent loss. Restored pendingCommits (resume) commit at the
 * first settle after session_start the same way.
 */
function settleDispatch(pi: ExtensionAPI, ctx: ExtensionContext): BoundaryResult | undefined {
	const entries: SessionBoundaryDraft[] = [];
	let continueTurn = false;

	// 1) undo in flight → commit its drafts (restores the pre-fold view).
	if (state.pendingUndo !== null) {
		const undo = state.pendingUndo;
		state.pendingUndo = null;
		const targetIds = undo.targets.map((t) => t.id);
		const drafts = buildUndoDrafts(targetIds, undo.targets);
		const record: SamUndoRecord = { v: 1, kind: "undo", unitId: undo.unitId, targets: targetIds, ts: Date.now() };
		const unit = state.ledger.units.find((u) => u.unitId === undo.unitId);
		if (unit) unit.state = "undone";
		entries.push(...toBoundaryEntries(drafts, record));
	}

	// 2) the audit turn just ended → capture the verdict, then fall through
	//    to commit it below in this same settle.
	if (state.audit !== null) {
		const audit = state.audit;
		state.audit = null;
		const branch = currentBranch(ctx);
		let reply: PlainMessage | undefined;
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.kind === "message" && e.message.role === "assistant") {
				reply = e.message;
				break;
			}
		}
		const verdict: Verdict = parseVerdict(assistantText(reply?.content ?? ""));
		state.pendingCommits.push({
			unitId: audit.unitId,
			span: audit.span,
			verdict,
			usage: reply ? getAssistantUsage(reply) : undefined,
		});
	}

	// 3) commit pending verdicts, oldest first.
	while (state.pendingCommits.length > 0) {
		const waiting = state.pendingCommits.shift()!;
		const usage: PlainUsage | undefined = waiting.usage;
		if (waiting.verdict.class === "VERIFIED" && state.mode !== "display") {
			const drafts = buildFoldDrafts(waiting.span, waiting.verdict.corrections);
			const beforeTokens = ctx.getContextUsage()?.tokens ?? null;
			const record: SamFoldRecord = {
				v: 1,
				kind: "fold",
				unitId: waiting.unitId,
				entryIds: waiting.span.targetIds,
				spanFirstId: waiting.span.spanFirstId,
				spanLastId: waiting.span.spanLastId,
				stub: waiting.span.stub,
				verdict: "VERIFIED",
				corrections: waiting.verdict.corrections,
				beforeTokens,
				usage,
				ts: Date.now(),
				mode: state.mode,
			};
			const unit = state.ledger.units.find((u) => u.unitId === waiting.unitId);
			if (unit) {
				unit.state = "folded";
				unit.entryIds = waiting.span.targetIds;
				unit.verdict = waiting.verdict;
				unit.corrections = waiting.verdict.corrections;
				unit.beforeTokens = beforeTokens;
				unit.usage = usage;
			}
			entries.push(...toBoundaryEntries(drafts, record));
		} else {
			const reason = state.mode === "display" ? "display mode" : `verdict ${waiting.verdict.class}`;
			const record: SamNoFoldRecord = {
				v: 1,
				kind: "noFold",
				unitId: waiting.unitId,
				entryIds: waiting.span.targetIds,
				spanFirstId: waiting.span.spanFirstId,
				spanLastId: waiting.span.spanLastId,
				stub: waiting.span.stub,
				verdict: waiting.verdict.class,
				corrections: waiting.verdict.corrections,
				reason,
				ts: Date.now(),
				mode: state.mode,
			};
			const unit = state.ledger.units.find((u) => u.unitId === waiting.unitId);
			if (unit) {
				unit.state = "refused";
				unit.verdict = waiting.verdict;
				unit.corrections = waiting.verdict.corrections;
				unit.reason = reason;
			}
			entries.push(...toBoundaryEntries([], record));
		}
	}

	// 4) a close from this turn (in-memory, last effective) or a restored
	//    re-audit (FIFO, oldest first) → resolve the span, queue the single
	//    in-series audit, continue. At most one audit is ever queued per
	//    settle (F7); other restored re-audits wait for following settles.
	let nextClose: PendingClose | undefined;
	if (state.pendingCloses.length > 0) {
		nextClose = state.pendingCloses[state.pendingCloses.length - 1];
		state.pendingCloses = [];
	} else if (state.ledger.pendingReaudit.length > 0) {
		// Restored re-audits carry a span from the session_start rebuild; adapt
		// to a PendingClose and re-resolve against the current branch below
		// (the branch is authoritative; the rebuild's span is the fallback it
		// must agree with in practice).
		const r = state.ledger.pendingReaudit.shift()!;
		nextClose = { unitId: r.unitId, stub: r.span.stub, toolCallId: r.toolCallId };
	}
	if (nextClose !== undefined) {
		const branch = currentBranch(ctx);
		const folded = foldedEntryIdSet(state.ledger);
		const resolution = resolveUnitSpan(branch, [nextClose], folded);
		if (!resolution.ok) {
			// F1: log and let the session settle; nothing is folded, nothing lost.
			console.error(`sam: close could not be resolved (${resolution.error}) — no audit queued, raw entries stay in view`);
			return entries.length > 0 ? { entries } : undefined;
		}
		const span = resolution.span;
		state.audit = { unitId: span.unitId, span, stub: span.stub };
		// The queued user message makes this a genuine in-series turn.
		pi.sendUserMessage(auditInstruction(span.unitId), { deliverAs: "followUp" });
		continueTurn = true;
	}

	if (entries.length === 0) return continueTurn ? { continue: true } : undefined;
	if (continueTurn) return { entries, continue: true };
	return { entries };
}

/* ── factory ─────────────────────────────────────────────────────────────── */

export default function factory(pi: ExtensionAPI): void {
	// Announce once per session start, in every reason (startup/resume/reload/
	// new/fork), and rebuild the ledger from the session file.
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		try {
			const ledger = rebuildLedger(currentBranch(ctx));
			state = createSamState(ledger);
			if (ledger.auditInFlight) state.audit = { ...ledger.auditInFlight };
			const counts = countUnits(ledger);
			const flags: string[] = [];
			if (state.audit) flags.push("audit resuming");
			if (state.pendingCommits.length > 0) flags.push(`${state.pendingCommits.length} verdict(s) awaiting commit`);
			if (ledger.malformedRecords > 0) flags.push(`${ledger.malformedRecords} malformed ledger record(s) skipped`);
			const flagText = flags.length > 0 ? ` · ${flags.join(" · ")}` : "";
			emit(
				ctx,
				`${EXTENSION_NAME} ${SAM_VERSION} loaded — /sam for status · ${describeBuild()} · ` +
					`mode ${state.mode} · folded ${counts.folded} · refused ${counts.refused} · ` +
					`undone ${counts.undone} · in flight ${counts.inFlight}${flagText}`,
			);
		} catch (err) {
			// F1: a half-rebuilt state is worse than a clean one.
			state = createSamState(rebuildLedger([]));
			emit(ctx, `sam: load error (continuing with a clean state): ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	});

	// Usage tracking is implicit: the audit capture reads the verdict message's
	// usage from the branch at settle, so no per-message bookkeeping is needed.
	pi.on("agent_before_settle", (_event: AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined => {
		try {
			return settleDispatch(pi, ctx);
		} catch (err) {
			// F1: never hold the settle; the session continues unmodified.
			console.error(`sam: settle dispatch error (no entries drafted): ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	});

	// close_unit — the agent's own close mark (P2 tool).
	// Plain JSON-schema object as `parameters` (TSchema is structural).
	// Deliberately not a TypeBox instance: the public repo keeps zero
	// runtime dependencies, and pi v0.87.1 validates non-TypeBox schemas
	// through its JSON-schema path (pi-ai utils/validation.ts: TYPEBOX_KIND
	// check; JsonSchemaObject shape). pi's provider request serializes the
	// schema as JSON either way. `as const` keeps the literal types so
	// TypeBox's Static<> infers { stub: string } for execute's params.
	const CLOSE_UNIT_PARAMS = {
		type: "object",
		properties: {
			stub: { type: "string", description: CLOSE_UNIT_TOOL.parametersDescription },
		},
		required: ["stub"],
	} as const;

	// pi v0.87.1 registerTool takes the definition object only (the name
	// lives inside it); one tool per extension.
	pi.registerTool({
		name: CLOSE_UNIT_TOOL.name,
		label: CLOSE_UNIT_TOOL.label,
		description: CLOSE_UNIT_TOOL.description,
		promptSnippet: CLOSE_UNIT_TOOL.promptSnippet,
		promptGuidelines: [...CLOSE_UNIT_TOOL.promptGuidelines],
		parameters: CLOSE_UNIT_PARAMS,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const branch = currentBranch(ctx);
				const folded = foldedEntryIdSet(state.ledger);
				if (lastRealUserEntryIsFolded(branch, folded)) {
					return {
						content: [{ type: "text", text: CLOSE_UNIT_ALREADY_CLOSED_TEXT }],
						details: { unitId: null, rejected: "already-closed" },
					};
				}
				// One close per turn: the first close_unit is effective; a second
				// call is refused so the ledger stays 1:1 with turns. The work
				// after the effective close stays in view until the next unit.
				if (state.pendingCloses.length > 0) {
					return {
						content: [{ type: "text", text: CLOSE_UNIT_PENDING_TEXT }],
						details: { unitId: null, rejected: "pending" },
					};
				}
				const hasWork = branch.some(
					(e) => e.kind === "message" && e.message.role === "user" && !isSamInjected(messageText(e.message.content)),
				);
				if (!hasWork) {
					return {
						content: [{ type: "text", text: "Nothing to close: no work in the session yet." }],
						details: { unitId: null, rejected: "no-work" },
					};
				}
				const unitId = state.ledger.nextUnitId;
				const record: SamCloseRecord = {
					v: 1,
					kind: "close",
					unitId,
					stub: params.stub,
					toolCallId,
					ts: Date.now(),
					mode: state.mode,
				};
				pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
				recordCloseInMemory(unitId, params.stub);
				state.pendingCloses.push({ unitId, stub: params.stub, toolCallId });
				return { content: [{ type: "text", text: closeUnitResultText(unitId) }], details: { unitId } };
			} catch (err) {
				// F1: fail open — nothing recorded, the model keeps working.
				return {
					content: [
						{
							type: "text",
							text: `close_unit failed (nothing recorded): ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { unitId: null, rejected: "error" },
				};
			}
		},
	});

	pi.registerCommand("sam", {
		description:
			"pi-self-aware-memory: /sam · /sam mode <display|manual> · /sam report · /sam undo   (assisted/auto + fold: P3)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const arg = args.trim();
				if (arg === "") {
					emit(ctx, statusText(ctx));
					return;
				}
				const [head, ...rest] = arg.split(/\s+/);
				if (head === "mode") {
					const target = rest[0];
					if (target === undefined) {
						emit(ctx, statusText(ctx)); // bare "/sam mode" = show current status
						return;
					}
					if (!isSamMode(target)) {
						emit(ctx, `sam: unknown mode '${target}' — one of: ${SAM_MODES.join(" | ")}`, "error");
						return;
					}
					if (!P2_MODES.includes(target)) {
						emit(ctx, `sam: mode '${target}' is not yet implemented (P3) — staying '${state.mode}'`, "error");
						return;
					}
					state.mode = target;
					const record: SamModeRecord = { v: 1, kind: "mode", mode: target, ts: Date.now() };
					pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
					emit(ctx, `sam: mode is now '${state.mode}'`);
					return;
				}
				if (head === "report") {
					emit(ctx, renderSamReport(state.ledger).join("\n"));
					return;
				}
				if (head === "undo") {
					await undoHandler(pi, ctx);
					return;
				}
				if (head === "fold") {
					emit(ctx, "sam: '/sam fold' is not yet implemented (P3) — user override for CORRECTIONS units");
					return;
				}
				emit(ctx, `sam: unknown subcommand '${head}' — /sam · /sam mode <display|manual> · report · undo`, "error");
			} catch (err) {
				// F1 fail-open: the status surface must never take a session down.
				emit(ctx, `sam: internal error (no state changed): ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

/**
 * Wait for the nested turn that pi.sendUserMessage just started to become
 * active and run to completion.
 *
 * v0.87.1: ExtensionAPI.sendUserMessage is fire-and-forget (the wrapper does
 * not return the prompt's promise). In print mode the process disposes the
 * session as soon as the slash command returns; dispose() aborts the in-flight
 * agent run and drops the agent event listeners, so an un-awaited ack turn is
 * aborted mid-fetch and its ack user message + reply are never persisted (the
 * settle boundary still fires, so a pending undo would still commit — but the
 * transcript is missing the pair, and which stray entries survive depends on
 * microtask timing). Awaiting here makes the final state deterministic: the
 * ack pair is persisted, the settle commits, and only then does the command
 * return (print mode disposes after that). Measured on v0.87.1.
 */
async function waitForNestedTurn(ctx: ExtensionCommandContext): Promise<void> {
	const deadline = Date.now() + 30_000;
	// The nested run is not active synchronously after sendUserMessage (pi's
	// prompt() crosses awaits before _runAgentPrompt), so poll briefly.
	while (ctx.isIdle() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 5));
	}
	if (!ctx.isIdle()) {
		await ctx.waitForIdle();
	}
}

/** /sam undo — restore the last folded unit (design note §5). */
async function undoHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (state.pendingUndo !== null) {
		emit(ctx, "sam: an undo is already in flight", "error");
		return;
	}
	const folded = state.ledger.units.filter((u) => u.state === "folded");
	if (folded.length === 0) {
		emit(ctx, "sam: nothing to undo (no folded units)");
		return;
	}
	const unit = folded[folded.length - 1];
	const branch = currentBranch(ctx);
	const originals: OriginalMessage[] = [];
	for (const id of unit.entryIds ?? []) {
		const entry = branch.find((e) => e.id === id);
		if (entry?.kind !== "message") {
			emit(ctx, `sam: cannot undo unit ${unit.unitId}: span entry ${id} not found in the session`, "error");
			return;
		}
		originals.push({ id, content: entry.message.content });
	}
	state.pendingUndo = { unitId: unit.unitId, targets: originals };
	// The undo commit needs a boundary; pi has none while idle, so ride a
	// short in-series turn (the ack user message; the model replies, the settle
	// commits the drafts). One short warm provider turn — documented cost.
	//
	// While idle we must await the nested turn ourselves: sendUserMessage is
	// fire-and-forget, and in print mode the session is disposed (run aborted,
	// listeners dropped) as soon as this command returns — see
	// waitForNestedTurn. While streaming, the followUp rides the current run's
	// settle, which is already on its way; no extra wait needed.
	try {
		if (ctx.isIdle()) {
			pi.sendUserMessage(undoAck(unit.unitId));
			await waitForNestedTurn(ctx);
		} else {
			pi.sendUserMessage(undoAck(unit.unitId), { deliverAs: "followUp" });
		}
	} catch (err) {
		// F1 fail-open: the undo stays pending and commits at the next settle.
		console.error(`sam: undo ack turn failed (undo stays pending for the next settle): ${err instanceof Error ? err.message : String(err)}`);
	}
	emit(ctx, `sam: undo of unit ${unit.unitId} in flight — the original view is restored after one short turn`);
}

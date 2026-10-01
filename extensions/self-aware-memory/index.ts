/**
 * pi-self-aware-memory — auditable, in-series context compaction.
 *
 * The agent marks work units open/closed and, at close, writes its own stub
 * while the reasoning is still warm; the same model on the same warm prefix
 * audits the stub in one appended in-series turn; only then is the raw span
 * projected out with pi's append-only context edits. The session file keeps
 * every original byte, so every fold is reversible and offline-auditable.
 *
 * ── P3 (this file) ─────────────────────────────────────────────────────────
 * Governor and safety (plan §P3):
 * - every fold commit passes the gate chain (gates.ts) BEFORE any draft
 *   exists — the draft path is structurally unreachable on a failed gate
 *   (folder.prepareFoldCommit);
 * - the span PROOF (commitproof.ts) is staged at capture and revalidated at
 *   commit — append-only growth allowed, any change inside the span fails
 *   closed (stale-span noFold, ledger-ready);
 * - ISSUED vs COMMITTED: at session_start, every folded unit without its
 *   stub edit in the branch gets a `foldLost` tombstone (the measured s5
 *   failure — pi discards whole batches — can no longer ride silently);
 * - assisted mode: at an `action`-zone settle (pressure ladder + hysteresis,
 *   governor.ts), ONE audited-VERIFIED display-era unit folds per settle,
 *   keep-window-gated (plan §3.4), oldest first, R5 backoff on rejection;
 * - auto mode: the same, plus one unmarked closed-off block per settle gets
 *   an in-series stub request (the model closes it as a normal unit — the
 *   full close→audit→fold machinery carries it);
 * - `/sam fold <n>` overrides a CORRECTIONS verdict (override ledger flag),
 *   `/sam resolve <n>` is the positive-resolution evidence (guard facts R1);
 * - D2 coexistence: detect a foreign folding folder (settings + branch
 *   evidence) ⇒ warn once and refuse folds (conservative, om-guard
 *   omPresence pattern; audits continue — measurement is safe);
 * - provider-busyness probe (DEFAULT OFF): env SAM_PROVIDER_PROBE_URL,
 *   positive-only, `?autoload=false` mandatory, defers a close's audit at
 *   most once — a probe failure never blocks;
 * - cache-ledger (port 2): assistant usages observed at message_end;
 *   commits marked (continuity); fold records carry commitTiming.
 *
 * Modes: display (audits, never folds) · manual (verified units fold at
 * close_unit; /sam fold overrides) · assisted (folds at close + pressure
 * sweep) · auto (assisted + unmarked-block escape hatch). D5: fresh-install
 * default remains `manual`.
 *
 * This file is the pi glue: all product logic is pure and unit-tested in
 * ../../src (projection, estimate, units, folder, gates, commitproof,
 * extraction, cache-ledger, governor, ledger, verdict, protocol, state,
 * output). The glue's only job is to map pi's session API onto the
 * plain-entry model and dispatch pi's boundaries. Every handler is
 * fail-open (F1): an internal error degrades to one stderr line and the
 * session continues unmodified.
 *
 * Pi v0.87.1 mechanics relied on (verified against the pinned tag):
 * - context_edit drafts commit only at turn_end/agent_before_settle
 *   boundaries (BoundaryResult.entries); latest edit wins per target;
 *   null replacement omits the entry from the projection, raw stays in file;
 * - appendContextEdit throws on missing/off-branch/non-editable targets and
 *   the runner then discards the WHOLE accumulated draft batch (measured) —
 *   which is exactly what the gates + proofs prevent for our drafts;
 * - a queued user message + continue:true makes the audit a genuine
 *   in-series turn;
 * - print-mode dispose semantics: an async command handler blocks exit, so
 *   the undo/fold ack turns await deterministically (waitForNestedTurn).
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
	MessageEndEvent,
	SessionBeforeCompactEvent,
	SessionBoundaryDraft,
	SessionEntry,
	SessionMessageEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_NAME, SAM_VERSION, describeBuild } from "../../src/identity.ts";
import {
	AUDIT_INSTRUCTION_PREFIX,
	CLOSE_UNIT_ALREADY_CLOSED_TEXT,
	CLOSE_UNIT_PENDING_TEXT,
	CLOSE_UNIT_TOOL,
	auditInstruction,
	type SamAuditPayload,
	closeUnitResultText,
	emptyStubRefusalText,
	isSamInjected,
	undoAck,
	autoStubInstruction,
	UNDO_ACK_PREFIX,
	branchAuditInstruction,
	SAM_RETRIEVE_TOOL,
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
import {
	findLastAuditTurn,
	buildSettlementRecord,
	parseBranchAuditReply,
	readRawSessionFile,
	spanHasSettlement,
	takeoverSummary,
	takeoverDetails,
	tombstoneJsonl,
	settleEligible,
	type RawEntry,
	type SamSettlementRecord,
	type BranchAuditStaged,
} from "../../src/branchaudit.ts";
import { lastRealUserEntryIsFolded, resolveUnitSpan, type PendingClose } from "../../src/units.ts";
import { buildUndoDrafts, prepareFoldCommit, tombstoneCompactedSpan, type ContextEditDraft, type OriginalMessage } from "../../src/folder.ts";
import { defaultFoldCeiling, spanCompactionCoverage, spanTokenMass, validateDraftTargets } from "../../src/gates.ts";
import { foldCommitProof, revalidateSpan, type StagedSpanProof } from "../../src/commitproof.ts";
import { emptyStubGate, extractUnitFloor, type UnitFloor } from "../../src/extraction.ts";
import {
	busynessGate,
	buildProbeUrl,
	coexistenceGate,
	detectForeignFolder,
	foreignFolderEvidence,
	ladderFor,
	modelSignature,
	parseBusyStatus,
	pressureZone,
	resolveFactIfPositive,
	sweepCandidates,
	sweepEligible,
	recordSweepReject,
	selectAutoSpan,
	userDeescalationActive,
	PROBE_DEFERRALS_PER_CLOSE,
	type GovernedModel,
} from "../../src/governor.ts";
import {
	SAM_LEDGER_CUSTOM_TYPE,
	rebuildLedger,
	type SamCloseRecord,
	type SamFoldRecord,
	type SamModeRecord,
	type SamNoFoldRecord,
	type SamUndoRecord,
	type SamFoldLostRecord,
	type SamResolveRecord,
} from "../../src/ledger.ts";
import {
	countUnits,
	createSamState,
	foldedEntryIdSet,
	isSamMode,
	SAM_MODES,
	stageSpanProof,
	type SamPendingCommit,
	type SamState,
} from "../../src/state.ts";
import { renderSamReport, renderSamStatus, samOutputChannel, type SamGovernorView } from "../../src/output.ts";

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
				// header/label/model_change/etc.: contributes nothing to the plain model.
				break;
		}
	}
	return out;
}

/**
 * The self-contained audit payload (P4 R2): the stub plus the close-time
 * evidence (floor) read from the ledger's unit record — the SAME data that
 * was persisted, so both the steer and the followUp sends carry it, and
 * nothing is re-derived at send time.
 */
function auditPayload(unitId: number): SamAuditPayload {
	const u = state.ledger.units.find((x) => x.unitId === unitId);
	return { stub: u?.stub, evidence: u?.evidence };
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

function modelInfo(ctx: ExtensionContext): { provider: string; id: string; contextWindow?: number } | undefined {
	const m = ctx.model;
	if (!m) return undefined;
	return { provider: m.provider, id: m.id, contextWindow: (m as { contextWindow?: number }).contextWindow };
}

function governorView(ctx: ExtensionContext): SamGovernorView {
	const g = state.governor;
	const usage = ctx.getContextUsage();
	return {
		zone: g.ladder ? g.zone : null,
		window: g.ladder?.window,
		reserve: g.ladder?.reserve,
		keepRecent: g.ladder?.keepRecent,
		foreignFolder: g.foreignFolder,
		probeUrl: g.probeUrl,
		rebuilds: { ...g.cacheLedger.summary().rebuilds },
	};
}

function statusText(ctx: ExtensionContext): string {
	return renderSamStatus(
		{ state, usage: ctx.getContextUsage(), model: modelInfo(ctx) },
		countUnits(state.ledger),
		governorView(ctx),
	).join("\n");
}

/* ── ledger helpers (in-memory bookkeeping after durable writes) ────────── */

function recordCloseInMemory(unitId: number, stub: string, evidence?: UnitFloor): void {
	state.ledger.units.push({
		unitId,
		stub,
		state: "in-flight",
		mode: state.mode,
		evidence: evidence
			? { files: evidence.files.map((f) => `${f.path}[${f.ops.join(",")}]`), errors: evidence.errors.length, retries: evidence.retries, nonTrivial: evidence.nonTrivial }
			: undefined,
	});
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

/* ── P3 helpers ─────────────────────────────────────────────────────────── */

/** model_select recompute (P3): ladder re-derives on model identity change. */
function recomputeGovernor(ctx: ExtensionContext): void {
	const g = state.governor;
	const model: GovernedModel | undefined = modelInfo(ctx) as GovernedModel | undefined;
	const sig = modelSignature(model ?? null);
	const usageWindow = ctx.getContextUsage()?.contextWindow;
	if (sig !== g.lastModelSig) {
		g.lastModelSig = sig;
		g.ladder = ladderFor(usageWindow ?? model?.contextWindow, model ?? null);
		g.zone = "calm"; // hysteresis resets with the model
		g.rejectMemory.clear(); // R5: a model change re-arms non-terminal backoff
	}
	if (g.ladder) {
		g.zone = pressureZone(g.ladder, ctx.getContextUsage()?.tokens ?? null, g.zone);
	}
}

/**
 * Read settings for D2 detection. Two different failure shapes (the
 * distinction matters, measured on a fresh pi install):
 * - the settings location is ABSENT (ENOENT — a fresh install with no
 *   settings.json at all): readable, simply no folders listed ⇒ no foreign
 *   folder (present:false). Treating this as "present" would silently brick
 *   folds for every fresh-install user — absence of evidence is not
 *   evidence of a foreign folder when the evidence location is readable.
 * - the settings file exists but is UNREADABLE (permissions/corruption):
 *   the conservative path (present:true, refuse folds) — the om-guard
 *   omPresence pattern (../../om-guard/om-presence.ts).
 * Test seam: `SAM_SETTINGS_JSON` (a settings JSON string) is honored first —
 * keeps the glue runnable where pi's own package does not resolve in the
 * process (the test VM).
 */
async function readSettings(): Promise<Record<string, unknown> | null> {
	const override = process.env["SAM_SETTINGS_JSON"];
	if (typeof override === "string" && override.trim() !== "") {
		const parsed: unknown = JSON.parse(override); // malformed override = operator error: surface it (fail loud, not conservative)
		return normalizeSettings(parsed);
	}
	let path: string | null = null;
	try {
		const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
		path = join(getAgentDir(), "settings.json");
	} catch {
		path = null; // host package not resolvable (test VM) — no settings read at all
	}
	if (path === null) return null; // conservative path: assume a foreign folder (D2)
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return {}; // readable location, no settings file ⇒ no foreign folder listed
		return null; // exists but unreadable ⇒ conservative
	}
	try {
		return normalizeSettings(JSON.parse(raw));
	} catch {
		return null; // corrupt settings ⇒ conservative
	}
}

function normalizeSettings(parsed: unknown): Record<string, unknown> | null {
	if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
	return null;
}

/**
 * The fold-commit core (used by the close flow, /sam fold, and the sweep):
 * revalidate the staged proof, run the gate chain, and either return the
 * drafts + record or the noFold record. Pure of pi (branch handed in).
 */
function commitFoldDecision(
	span: { spanFirstId: string; spanLastId: string; entryIds: string[]; stub: string },
	unitId: number,
	branch: PlainEntry[],
	opts: {
		corrections?: string;
		applyKeepWindow: boolean;
		override?: boolean;
		sweep?: "assisted" | "auto";
		beforeTokens: number | null;
		contextWindow: number;
	},
): 
	| { kind: "fold"; drafts: ContextEditDraft[]; record: SamFoldRecord }
	| { kind: "noFold"; record: SamNoFoldRecord }
	| { kind: "resolveCompacted"; record: SamResolveRecord; noFold?: SamNoFoldRecord } {
	// D2 (conservative, om-guard pattern): while a foreign folding folder is
	// active, NO SAM fold ships (manual close, override, or sweep) — two
	// folders editing one span is the D2 risk. Audits continue (measurement
	// is safe); the refusal is terminal (R5: no auto-retry).
	if (state.governor.foreignFolder.present) {
		return {
			kind: "noFold",
			record: {
				v: 1,
				kind: "noFold",
				unitId,
				entryIds: span.entryIds,
				spanFirstId: span.spanFirstId,
				spanLastId: span.spanLastId,
				stub: span.stub,
				verdict: "VERIFIED",
				corrections: opts.corrections,
				reason: "coexistence",
				reasons: [`coexistence: ${state.governor.foreignFolder.basis} (D2 — remove the foreign folder or undo it first)`],
				ts: Date.now(),
				mode: state.mode,
			},
		};
	}
	const proof = state.spanProofs.get(unitId);
	const reval = revalidateSpan(proof, branch);
	if (!reval.ok) {
		const reason = `stale-span (${reval.reason})`;
		return {
			kind: "noFold",
			record: {
				v: 1,
				kind: "noFold",
				unitId,
				entryIds: span.entryIds,
				spanFirstId: span.spanFirstId,
				spanLastId: span.spanLastId,
				stub: span.stub,
				verdict: "VERIFIED",
				corrections: opts.corrections,
				reason,
				reasons: [reason],
				ts: Date.now(),
				mode: state.mode,
			},
		};
	}
	const prepared = prepareFoldCommit(
		{
			unitId,
			spanFirstId: span.spanFirstId,
			spanLastId: span.spanLastId,
			entryIds: span.entryIds,
			stub: span.stub,
			targetIds: span.entryIds,
		},
		{ branch, ledger: state.ledger, beforeTokens: opts.beforeTokens, contextWindow: opts.contextWindow },
		{ corrections: opts.corrections, applyKeepWindow: opts.applyKeepWindow },
	);
	// P4 R3 (DEFAULT "tombstone" since the 2026-09-30 H1 promotion; the "refuse"
	// opt-out keeps the status-quo path below): this span is
	// already carried by a compaction summary — it is OUT of the view. Folding
	// it would save ZERO view tokens and only rewrite preserved ground-truth
	// bytes, so the correct terminal is `resolved` (compaction-owned): the fold
	// is never issued (zero context_edits in both gate outcomes), the gate
	// arithmetic stays on record as evidence (a noFold SIBLING when the gate
	// rejected), and the honest terminal replaces the (arguably wrong) ceiling
	// refusal. Pure decision: folder.tombstoneCompactedSpan (harness-replayable,
	// R4 discipline); the glue only dispatches and records.
	if (state.governor.compactedSpanPolicy === "tombstone") {
		const coverage = spanCompactionCoverage(branch, span.entryIds);
		if (coverage.covered) {
			const d = tombstoneCompactedSpan(
				{ ok: prepared.ok, reasons: prepared.ok ? [] : prepared.reasons },
				{
					unitId,
					spanFirstId: span.spanFirstId,
					spanLastId: span.spanLastId,
					entryIds: span.entryIds,
					stub: span.stub,
					corrections: opts.corrections,
					mode: state.mode,
				},
			);
			return { kind: "resolveCompacted", record: d.record, noFold: d.noFold };
		}
	}
	if (!prepared.ok) {
		const head = prepared.reasons[0]?.split(":")[0] ?? "gate";
		return {
			kind: "noFold",
			record: {
				v: 1,
				kind: "noFold",
				unitId,
				entryIds: span.entryIds,
				spanFirstId: span.spanFirstId,
				spanLastId: span.spanLastId,
				stub: span.stub,
				verdict: "VERIFIED",
				corrections: opts.corrections,
				reason: head,
				reasons: prepared.reasons,
				ts: Date.now(),
				mode: state.mode,
			},
		};
	}
	const g = state.governor;
	const timing = g.cacheLedger.commitTiming(Date.now());
	const record: SamFoldRecord = {
		v: 1,
		kind: "fold",
		unitId,
		entryIds: span.entryIds,
		spanFirstId: span.spanFirstId,
		spanLastId: span.spanLastId,
		stub: span.stub,
		verdict: "VERIFIED",
		corrections: opts.corrections,
		override: opts.override || undefined,
		sweep: opts.sweep,
		commitTiming: timing,
		gate: {
			spanTok: prepared.gate.arithmetic.spanTokens,
			stubTok: prepared.gate.arithmetic.stubTokens,
			savedTok: prepared.gate.arithmetic.savedTokens,
			afterTok: prepared.gate.arithmetic.afterTokens,
			keepOut: prepared.gate.arithmetic.outsideKeepTokens,
		},
		beforeTokens: opts.beforeTokens,
		ts: Date.now(),
		mode: state.mode,
	};
	return { kind: "fold", drafts: prepared.drafts, record };
}

/**
 * Commit one pending verdict (the step-3 body, extracted for the P4 R1
 * steer branch — which commits a same-turn verdict at step 4): fold or
 * noFold, gate chain + proof revalidation, in-memory ledger, boundary
 * entries. Pure of pi (branch/usage handed in via ctx).
 */
function commitWaiting(
	waiting: SamPendingCommit,
	ctx: ExtensionContext,
	entries: SessionBoundaryDraft[],
): void {
	const g = state.governor;
	if (waiting.verdict.class === "VERIFIED" && state.mode !== "display") {
		const branch = currentBranch(ctx);
		const beforeTokens = ctx.getContextUsage()?.tokens ?? null;
		const contextWindow = modelInfo(ctx)?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
		const span = waiting.span;
		const decision = commitFoldDecision(
			{ spanFirstId: span.spanFirstId, spanLastId: span.spanLastId, entryIds: span.targetIds, stub: span.stub },
			waiting.unitId,
			branch,
			{
				corrections: waiting.verdict.corrections,
				applyKeepWindow: false,
				override: false,
				beforeTokens,
				contextWindow,
			},
		);
		if (decision.kind === "noFold") {
			recordSweepReject(g.rejectMemory, waiting.unitId, decision.record.reasons ?? [decision.record.reason], g.settleCount);
		}
		if (decision.kind === "fold" && waiting.usage) {
			decision.record.usage = waiting.usage;
		}
		applyDecision(decision, entries);
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

/** Apply a fold/noFold/resolveCompacted decision: ledger in-memory + boundary entries. */
function applyDecision(
	decision:
		| { kind: "fold"; drafts: ContextEditDraft[]; record: SamFoldRecord }
		| { kind: "noFold"; record: SamNoFoldRecord }
		| { kind: "resolveCompacted"; record: SamResolveRecord; noFold?: SamNoFoldRecord },
	entries: SessionBoundaryDraft[],
): void {
	if (decision.kind === "resolveCompacted") {
		// P4 R3: the compaction-owned terminal. Evidence lands first (the noFold
		// sibling when the gate rejected — the ceiling arithmetic stays on
		// record), then the tombstone: canonical order, and the rebuild's
		// resolve handler promotes refused→resolved on replay (F1, the ledger
		// is the ground truth). Terminal by every existing rule: the sweep
		// candidates are `refused` only (governor.sweepCandidates), /sam resolve
		// rejects resolved units, and no retry path re-pends them. ZERO context
		// edits by construction — the fold drafts are never issued — and no
		// cacheLedger noteCommit either (nothing was committed to the view).
		const r = decision.record;
		const unit = state.ledger.units.find((u) => u.unitId === r.unitId);
		if (unit) {
			unit.state = "resolved";
			unit.resolvedBasis = "compaction-owned";
			unit.verdict = { class: r.verdict ?? "VERIFIED", corrections: r.corrections };
			unit.corrections = r.corrections;
			if (r.entryIds !== undefined) unit.entryIds = r.entryIds;
			if (r.stub !== undefined) unit.stub = r.stub;
			if (r.spanFirstId !== undefined) unit.spanFirstId = r.spanFirstId;
			if (r.spanLastId !== undefined) unit.spanLastId = r.spanLastId;
			if (decision.noFold) {
				unit.reason = decision.noFold.reason;
				unit.gateReasons = decision.noFold.reasons;
			}
			unit.gateReasons ??= r.gateReasons;
		}
		if (decision.noFold !== undefined) entries.push(...toBoundaryEntries([], decision.noFold));
		entries.push(...toBoundaryEntries([], r));
		return;
	}
	if (decision.kind === "fold") {
		const unit = state.ledger.units.find((u) => u.unitId === decision.record.unitId);
		if (unit) {
			unit.state = "folded";
			unit.entryIds = decision.record.entryIds;
			unit.verdict = { class: "VERIFIED", corrections: decision.record.corrections };
			unit.corrections = decision.record.corrections;
			unit.beforeTokens = decision.record.beforeTokens;
			unit.sweep = decision.record.sweep;
			unit.commitTiming = decision.record.commitTiming;
		}
		entries.push(...toBoundaryEntries(decision.drafts, decision.record));
		state.governor.cacheLedger.noteCommit("fold", Date.now());
		// R1: an override-fold is positive resolution evidence.
		if (decision.record.override) {
			const next = resolveFactIfPositive(state.governor.guardFacts, decision.record.unitId, "disputed-stub", "override-fold", state.governor.settleCount);
			if (next) state.governor.guardFacts = next;
		}
	} else {
		const unit = state.ledger.units.find((u) => u.unitId === decision.record.unitId);
		if (unit) {
			unit.state = "refused";
			unit.verdict = { class: decision.record.verdict, corrections: decision.record.corrections };
			unit.corrections = decision.record.corrections;
			unit.reason = decision.record.reason;
			unit.gateReasons = decision.record.reasons;
		}
		entries.push(...toBoundaryEntries([], decision.record));
	}
}

/* ── settlement dispatch (the only place context edits are drafted) ─────── */

/**
 * One settle processes pending work to completion, in priority order:
 * 1. an in-flight undo → commit its restoration drafts (gated: targets must
 *    still exist and be editable — the branch may have drifted on resume);
 * 2. the audit turn that just ended → capture its verdict, stage the proof;
 * 3. pending verdicts (oldest first) → commit fold or noFold each
 *    (gate chain + proof revalidation, P3);
 * 3.5 P3 assisted/auto sweep — ONE audited-VERIFIED display-era unit,
 *    keep-window gated, when the zone is `action` (same batch: one cache
 *    rebuild for all commits this settle — the s5 lesson);
 * 4. a pending close (this turn) or a restored re-audit → resolve the span,
 *    stage the proof, apply the P3 close-time gates (empty-stub floor,
 *    busyness), queue the single in-series audit, and continue the session;
 * 5. P3 auto mode — one unmarked closed-off block gets the in-series stub
 *    request (the model's close_unit then rides step 4 next settle).
 *
 * The verdict capture and its commit happen in the SAME settle (P2 rule —
 * after the capture there is no further boundary).
 */
async function settleDispatch(pi: ExtensionAPI, ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
	const entries: SessionBoundaryDraft[] = [];
	let continueTurn = false;
	const g = state.governor;
	g.settleCount += 1;
	recomputeGovernor(ctx);

	// 1) undo in flight → commit its drafts (restores the pre-fold view).
	if (state.pendingUndo !== null) {
		const undo = state.pendingUndo;
		state.pendingUndo = null;
		const branch = currentBranch(ctx);
		const targetIds = undo.targets.map((t) => t.id);
		const problems = validateDraftTargets(targetIds.map((targetId) => ({ targetId })), branch);
		if (problems.length > 0) {
			// F1 + banked finding: the span drifted (resume/fork) — fail open,
			// the raw entries are untouched (undo never wrote).
			console.error(`sam: undo of unit ${undo.unitId} refused — ${problems.map((p) => p.detail).join("; ")}`);
		} else {
			const drafts = buildUndoDrafts(targetIds, undo.targets);
			const record: SamUndoRecord = { v: 1, kind: "undo", unitId: undo.unitId, targets: targetIds, ts: Date.now() };
			const unit = state.ledger.units.find((u) => u.unitId === undo.unitId);
			if (unit) unit.state = "undone";
			entries.push(...toBoundaryEntries(drafts, record));
			g.cacheLedger.noteCommit("undo", Date.now());
			// R1: undo is positive resolution evidence for a disputed stub.
			const next = resolveFactIfPositive(g.guardFacts, undo.unitId, "disputed-stub", "undo", g.settleCount);
			if (next) g.guardFacts = next;
		}
	}

	// 2) the audit turn just ended → capture the verdict, stage the proof.
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
		stageSpanProof(state, audit.unitId, audit.span, branch);
	} else if (state.branchAuditStaged !== null) {
		// P5: the branch audit completed on a FORKED session file (side branch)
		// and the main session is resuming — capture the verdict FROM THAT FILE,
		// append the retrieval-tagged settlement record, and commit the
		// terminal through the UNSCHANGED step-3 machinery (same gates, same
		// proof revalidation, same R3 span policy). The main line never saw
		// the audit instruction/reply (the battery asserts exactly that).
		const staged = state.branchAuditStaged;
		state.branchAuditStaged = null;
		const branch = currentBranch(ctx);
		const unit = state.ledger.units.find((u) => u.unitId === staged.unitId);
		if (unit === undefined) {
			console.error(`sam: branch audit for unknown unit ${staged.unitId} — not settled (the fork file stays banked)`);
			return { entries: [...entries] };
		}
		const pendingClose: PendingClose =
			state.pendingCloses[state.pendingCloses.length - 1] ?? { unitId: staged.unitId, stub: unit.stub, toolCallId: "branch" };
		const folded = foldedEntryIdSet(state.ledger, branch);
		const resolution = resolveUnitSpan(branch, [pendingClose], folded);
		if (!resolution.ok) {
			// F1: the span cannot be resolved on this line — no terminal, raw
			// entries stay in view; the fork file remains the audit evidence.
			console.error(`sam: branch audit unit ${staged.unitId} could not be resolved (${resolution.error}) — no settlement appended`);
			state.pendingCloses = [];
			return { entries: [...entries] };
		}
		const span = resolution.span;
		// The P3 close-time gate still binds (anti-self-sealing).
		const byId = new Map(branch.map((e) => [e.id, e]));
		const spanMessages: PlainMessage[] = [];
		for (const id of span.entryIds) {
			const e = byId.get(id);
			if (e?.kind === "message") spanMessages.push(e.message);
		}
		const floor = extractUnitFloor(spanMessages);
		const emptyGate = emptyStubGate(span.stub, floor);
		if (!emptyGate.ok) {
			const record: SamNoFoldRecord = {
				v: 1, kind: "noFold", unitId: span.unitId, entryIds: span.targetIds,
				spanFirstId: span.spanFirstId, spanLastId: span.spanLastId,
				stub: span.stub, verdict: "UNAUDITABLE", reason: "empty-stub",
				reasons: [emptyGate.reason ?? "empty stub over work"], ts: Date.now(), mode: state.mode,
			};
			unit.state = "refused";
			entries.push(...toBoundaryEntries([], record));
			state.pendingCloses = [];
			g.guardFacts.push({ unitId: span.unitId, kind: "gate-reject", basis: "empty-stub", sinceSettle: g.settleCount });
			return { entries: [...entries] };
		}
		if (unit.evidence === undefined) {
			unit.evidence = {
				files: floor.files.map((f) => `${f.path}[${f.ops.join(",")}]`),
				errors: floor.errors.length,
				retries: floor.retries,
				nonTrivial: floor.nonTrivial,
			};
		}
		// Capture from the audit file (the side branch) — total: unreadable
		// file or missing reply ⇒ UNAUDITABLE verdict (the fold is refused),
		// the settlement is NOT appended (no retrievalId without a reply).
		const auditRaw = readRawSessionFile(staged.auditFile);
		const turn = findLastAuditTurn(auditRaw);
		const replyOk = turn !== undefined && turn.replyId !== undefined;
		const replyText = replyOk ? (turn as { replyText: string }).replyText : staged.replyText;
		const replyId = replyOk ? (turn as { replyId: string }).replyId : staged.replyId;
		if (replyOk) {
			const record = buildSettlementRecord(staged.unitId, staged.auditFile, replyId, replyText);
			if (record !== undefined) entries.push(...toBoundaryEntries([], record));
		}
		const parse = parseBranchAuditReply(replyText);
		stageSpanProof(state, span.unitId, span, branch);
		state.pendingCommits.push({ unitId: span.unitId, span, verdict: parse.verdict, usage: undefined });
		state.pendingCloses = [];
	}

	// P3: explicit /sam fold <n> (override or plain) — user intent, commits
	// now (not keep-window gated), gates still bind.
	if (state.pendingFold !== null) {
		const fold = state.pendingFold;
		state.pendingFold = null;
		const branch = currentBranch(ctx);
		const beforeTokens = ctx.getContextUsage()?.tokens ?? null;
		const contextWindow = modelInfo(ctx)?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
		const unit = state.ledger.units.find((u) => u.unitId === fold.unitId);
		const span = {
			spanFirstId: fold.spanFirstId,
			spanLastId: fold.spanLastId,
			entryIds: fold.entryIds,
			stub: unit?.stub ?? "",
		};
		applyDecision(commitFoldDecision(span, fold.unitId, branch, {
			corrections: fold.corrections,
			applyKeepWindow: false,
			override: fold.override,
			beforeTokens,
			contextWindow,
		}), entries);
	}

	// 3) commit pending verdicts, oldest first (gated, P3).
	while (state.pendingCommits.length > 0) {
		commitWaiting(state.pendingCommits.shift()!, ctx, entries);
	}

	// 3.5 P3 assisted/auto sweep (D2 + zone + R3 + R5 gated).
	let sweepFolded = false;
	if (
		(state.mode === "assisted" || state.mode === "auto") &&
		!g.foreignFolder.present &&
		!userDeescalationActive(g.modeHistory.map(({ from, to }) => ({ from, to }))) &&
		g.zone === "action" &&
		g.ladder !== null
	) {
		for (const unitId of sweepCandidates(state.ledger)) {
			if (sweepFolded) break; // one per settle (bounded step)
			if (!sweepEligible(g.rejectMemory, unitId, g.settleCount)) continue;
			const unit = state.ledger.units.find((u) => u.unitId === unitId);
			if (!unit || !unit.entryIds || unit.entryIds.length === 0) continue;
			const branch = currentBranch(ctx);
			const proof = state.spanProofs.get(unitId) ?? (stageSpanProof(state, unitId, { spanFirstId: unit.entryIds[0], spanLastId: unit.entryIds[unit.entryIds.length - 1], entryIds: unit.entryIds }, branch), state.spanProofs.get(unitId));
			if (revalidateSpan(proof, branch).ok === false) {
				const record: SamNoFoldRecord = {
					v: 1, kind: "noFold", unitId, entryIds: unit.entryIds,
					spanFirstId: unit.entryIds[0], spanLastId: unit.entryIds[unit.entryIds.length - 1],
					stub: unit.stub, verdict: "VERIFIED", reason: "stale-span (missing-entries)",
					reasons: ["stale-span (missing-entries)"], ts: Date.now(), mode: state.mode,
				};
				applyDecision({ kind: "noFold", record }, entries);
				recordSweepReject(g.rejectMemory, unitId, record.reasons ?? [], g.settleCount);
				continue;
			}
			const beforeTokens = ctx.getContextUsage()?.tokens ?? null;
			const contextWindow = modelInfo(ctx)?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
			const decision = commitFoldDecision(
				{ spanFirstId: unit.entryIds[0], spanLastId: unit.entryIds[unit.entryIds.length - 1], entryIds: unit.entryIds, stub: unit.stub },
				unitId,
				branch,
				{ applyKeepWindow: true, beforeTokens, contextWindow, sweep: state.mode === "auto" ? "auto" : "assisted" },
			);
			if (decision.kind === "noFold") recordSweepReject(g.rejectMemory, unitId, decision.record.reasons ?? [decision.record.reason], g.settleCount);
			applyDecision(decision, entries);
			if (decision.kind === "fold") sweepFolded = true;
			else break; // no-fold this settle: the next candidate waits (its proof may differ)
		}
	}

	// 4) a close from this turn (in-memory, last effective) or a restored
	//    re-audit (FIFO, oldest first) → resolve the span, stage the proof,
	//    apply the P3 close-time gates, queue the single in-series audit.
	let nextClose: PendingClose | undefined;
	if (state.pendingCloses.length > 0) {
		nextClose = state.pendingCloses[state.pendingCloses.length - 1];
	} else if (state.ledger.pendingReaudit.length > 0) {
		const r = state.ledger.pendingReaudit.shift()!;
		nextClose = { unitId: r.unitId, stub: r.span.stub, toolCallId: r.toolCallId };
	}
	if (nextClose !== undefined) {
		const branch = currentBranch(ctx);
		const folded = foldedEntryIdSet(state.ledger, branch);
		const resolution = resolveUnitSpan(branch, [nextClose], folded);
		if (!resolution.ok) {
			// F1: log and let the session settle; nothing is folded, nothing lost.
			console.error(`sam: close could not be resolved (${resolution.error}) — no audit queued, raw entries stay in view`);
			// Consume the close (it cannot resolve on this branch) so it does
			// not re-fire forever; the ledger stays honest (close record, no
			// terminal — a /sam fold of that unit remains impossible; the raw
			// span is in view and the user's to manage).
			state.pendingCloses = [];
			return entries.length > 0 ? { entries } : undefined;
		}
		const span = resolution.span;

		// P3 close-time gate: empty stub over demonstrable work (anti-self-
		// sealing; the s5 9-of-10-empty-stub failure). An in-turn close was
		// already refused at execute; this catches restored closes.
		const unit = state.ledger.units.find((u) => u.unitId === span.unitId);
		const spanMessages: PlainMessage[] = [];
		const byId = new Map(branch.map((e) => [e.id, e]));
		for (const id of span.entryIds) {
			const e = byId.get(id);
			if (e?.kind === "message") spanMessages.push(e.message);
		}
		const floor = extractUnitFloor(spanMessages);
		const emptyGate = emptyStubGate(span.stub, floor);
		if (!emptyGate.ok) {
			const record: SamNoFoldRecord = {
				v: 1, kind: "noFold", unitId: span.unitId, entryIds: span.targetIds,
				spanFirstId: span.spanFirstId, spanLastId: span.spanLastId,
				stub: span.stub, verdict: "UNAUDITABLE", reason: "empty-stub",
				reasons: [emptyGate.reason ?? "empty stub over work"], ts: Date.now(), mode: state.mode,
			};
			if (unit) unit.state = "refused";
			applyDecision({ kind: "noFold", record }, entries);
			state.pendingCloses = [];
			g.guardFacts.push({ unitId: span.unitId, kind: "gate-reject", basis: "empty-stub", sinceSettle: g.settleCount });
			state.pendingCloses = [];
			return entries.length > 0 ? { entries } : undefined;
		}

		// P4 R1 steer branch: if this close's audit was steered INTO the turn
		// that just ended, its reply (if any) is already in the branch —
		// capture it now and commit in THIS settle (one cache rebuild; the
		// s5 principle). The capture rule (auditReplyIndex) attributes the
		// last parseable verdict in the audit window, so the model's return-
		// to-task after the verdict cannot displace it.
		const wasSteered = state.steeredAudits.includes(span.unitId);
		if (wasSteered) {
			state.steeredAudits = state.steeredAudits.filter((id) => id !== span.unitId);
			const w = rebuildLedger(branch).pendingCommits.find((x) => x.unitId === span.unitId);
			if (w !== undefined) {
				if (unit && unit.evidence === undefined) {
					unit.evidence = {
						files: floor.files.map((f) => `${f.path}[${f.ops.join(",")}]`),
						errors: floor.errors.length,
						retries: floor.retries,
						nonTrivial: floor.nonTrivial,
					};
				}
				stageSpanProof(state, span.unitId, span, branch);
				commitWaiting(w, ctx, entries);
				state.pendingCloses = [];
				// No continueTurn: the run already ended (settle fired inside it)
				// and the close is resolved either way.
				return { entries };
			}
			// F1 fall-through: the steered delivery produced no captured reply
			// (lost/ignored in-turn). The followUp audit below carries it; the
			// probe is skipped on this path — deferring would strand the
			// already-queued in-turn exchange instead of deferring an audit.
		}

		// P3 provider-busyness probe (DEFAULT off; positive-only; defer at
		// most once per close — a probe failure means nothing).
		if (g.probeUrl !== null && !wasSteered) {
			const alreadyDeferred = g.closeDeferrals.includes(span.unitId);
			if (!alreadyDeferred && g.closeDeferralsLeft > 0) {
				const status = await probeBusyness(g.probeUrl);
				const gate = busynessGate(status);
				if (gate === "defer") {
					g.closeDeferrals.push(span.unitId);
					g.closeDeferralsLeft -= 1;
					// Leave the close pending for the NEXT settle (re-queue):
					// the audit is deferred, not lost.
					return entries.length > 0 ? { entries } : undefined;
				}
			}
		}

		// P5 branch mode: the audit does NOT fire in-series. It runs on a
		// forked session file via `/sam audit <n>` (a turn-boundary operation);
		// the close stays pending until that audit completes (the step-2
		// branch path settles it) — the main line never sees the audit text.
		if (state.auditDelivery === "branch") {
			if (!g.branchHoldAnnounced) {
				g.branchHoldAnnounced = true;
				console.error(`sam: branch mode — unit ${span.unitId} awaits "/sam audit ${span.unitId}" (the branch audit does not fire on its own; the close stays pending, nothing is folded)`);
			}
			return entries.length > 0 ? { entries } : undefined;
		}

		// Normal flow: stage the proof, record the close floor, queue audit.
		state.audit = { unitId: span.unitId, span, stub: span.stub };
		stageSpanProof(state, span.unitId, span, branch);
		if (unit && unit.evidence === undefined) {
			unit.evidence = {
				files: floor.files.map((f) => `${f.path}[${f.ops.join(",")}]`),
				errors: floor.errors.length,
				retries: floor.retries,
				nonTrivial: floor.nonTrivial,
			};
		}
		pi.sendUserMessage(auditInstruction(span.unitId, auditPayload(span.unitId)), { deliverAs: "followUp" });
		continueTurn = true;
		state.pendingCloses = [];
	}

	// 5) P3 auto mode: the unmarked-block escape hatch (one stub request per
	//    settle, D2 + zone + de-escalation gated; the model's close_unit then
	//    rides step 4 at the following settle).
	if (
		state.mode === "auto" &&
		!sweepFolded &&
		!g.foreignFolder.present &&
		!userDeescalationActive(g.modeHistory.map(({ from, to }) => ({ from, to }))) &&
		g.zone === "action" &&
		g.autoDeferralsLeft > 0 &&
		state.pendingCloses.length === 0
	) {
		const branch = currentBranch(ctx);
		const folded = foldedEntryIdSet(state.ledger, branch);
		const tried = new Set<string>(g.autoTriedSpans);
		const span = selectAutoSpan(
			branch,
			isSamInjected,
			(content) => messageText((content ?? "") as Parameters<typeof messageText>[0]),
			{
			foldedEntryIds: folded,
			triedSpans: tried,
			spanTokens: (ids) => spanTokenMass({ entryIds: ids }, branch),
			ceilingTokens: defaultFoldCeiling(modelInfo(ctx)?.contextWindow),
			nonEditableIds: (ids) => ids.filter((id) => {
				const e = byIdOf(branch, id);
				if (e === undefined) return true;
				if (e.kind !== "message") return true; // non-message entries are never fold targets
				return e.message.role !== "user" && e.message.role !== "assistant" && e.message.role !== "toolResult";
			}),
			hasCloseUnit: (ids) =>
				ids.some((id) => {
					const e = byIdOf(branch, id);
					if (e?.kind !== "message") return false;
					if (e.message.role === "toolResult") return e.message.toolName === "close_unit";
					if (e.message.role !== "assistant" || typeof e.message.content === "string") return false;
					return e.message.content.some((b) => b.type === "toolCall" && (b as { name?: unknown }).name === "close_unit");
				}),
			hasWork: (ids) =>
				ids.some((id) => {
					const e = byIdOf(branch, id);
					if (e?.kind !== "message") return false;
					return e.message.role === "toolResult" || (e.message.role === "assistant" && messageText(e.message.content).length >= 40);
				}),
		});
		if (span !== undefined) {
			// One in-series stub request; the model's close_unit then rides
			// step 4 at the following settle (full close→audit→fold machinery).
			// The span is tombstoned now to bound retries (autoDeferralsLeft);
			// a real close of that block still folds normally (the tombstone
			// only gates the AUTO selection, not the close flow).
			if (!g.autoTriedSpans.includes(span.spanFirstId)) g.autoTriedSpans.push(span.spanFirstId);
			g.autoDeferralsLeft -= 1;
			pi.sendUserMessage(autoStubInstruction(span.spanFirstId, span.spanLastId), { deliverAs: "followUp" });
			continueTurn = true;
		}
	}

	if (entries.length === 0) return continueTurn ? { continue: true } : undefined;
	if (continueTurn) return { entries, continue: true };
	return { entries };
}

function byIdOf(branch: readonly PlainEntry[], id: string): PlainEntry | undefined {
	for (const entry of branch) if (entry.id === id) return entry;
	return undefined;
}

/* ── P5 branch-audit: the /sam audit dance + retrieve + settle backstop ── */

/**
 * The branch audit on a FORKED session file (P5; a turn-boundary operation —
 * pi core refuses session transitions while streaming). position "at" puts
 * the FULL unit context (incl. the last assistant line) on the fork; the
 * audit reply is read from the fork's file; the switch-back triggers the
 * session_start resume backstop, which stages the capture (file-derived —
 * no in-memory state needs to survive the rebind). F1: any failure carries
 * the unit on the in-series followUp audit (the R1 fall-through pattern);
 * the close itself is never broken.
 */
async function auditHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, arg: string | undefined): Promise<void> {
	if (state.audit !== null) {
		emit(ctx, "sam: an audit is already in flight (one at a time)", "error");
		return;
	}
	if (!ctx.isIdle()) {
		emit(ctx, "sam: wait for the current response to finish before the branch audit (session transitions are turn-boundary operations)", "error");
		return;
	}
	let unitId: number | undefined = arg !== undefined && arg.trim() !== "" ? parseInt(arg, 10) : undefined;
	if (unitId === undefined || Number.isNaN(unitId) || unitId < 1) {
		const pc = state.pendingCloses[state.pendingCloses.length - 1];
		if (pc !== undefined) unitId = pc.unitId;
		else {
			const units = state.ledger.units.filter((u) => u.state === "in-flight");
			unitId = units.length > 0 ? units[units.length - 1].unitId : undefined;
		}
	}
	if (unitId === undefined || Number.isNaN(unitId)) {
		emit(ctx, "sam: no open unit to audit — close one first (close_unit) or name the unit (e.g. /sam audit 1)", "error");
		return;
	}
	const unit = state.ledger.units.find((u) => u.unitId === unitId);
	if (unit === undefined) {
		emit(ctx, `sam: unknown unit ${unitId} (no close record)`, "error");
		return;
	}
	const sFile = ctx.sessionManager.getSessionFile();
	if (sFile === undefined) {
		emit(ctx, "sam: no session file to switch back to (cannot run the branch audit)", "error");
		return;
	}
	const leafId = ctx.sessionManager.getLeafId();
	if (leafId === null || leafId === undefined) {
		emit(ctx, "sam: no session entry to fork from (empty session?)", "error");
		return;
	}
	// P5 v3 (2026-10-01 pivot, design doc §13): the branch audit is RUNNER-
	// orchestrated and every SAM command stays model-free (a testable
	// invariant). Measured: pi print mode does not pump extension-initiated
	// model turns started inside a command (walk branch-audit rehearsals
	// 1–3, requests.log) — the forking model turn must be a normal runner
	// prompt on the fork session. This command therefore PREPARES the branch
	// only: (1) fork at leaf (audit input = through the close entry),
	// (2) emit the machine-readable handoff (unitId, forkFile, forkSessionId,
	// the exact instruction) — the runner prompts the fork with it, then
	// (3) `/sam settle <n> <forkFile>` stages + settles on the main line.
	const instruction = branchAuditInstruction(unitId, auditPayload(unitId));
	const sDir = sessionDirOf(ctx);
	let forkFile: string | undefined;
	try {
		const mainBase = (sFile as string).split("/").pop();
		const beforeSet = new Set(sDir === undefined ? [] : readdirSync(sDir).filter((f) => f.endsWith(".jsonl")));
		const res = await ctx.fork(leafId, { position: "at" });
		if (res.cancelled) {
			emit(ctx, "sam: the branch fork was cancelled (cannot prepare the side-branch audit) — the unit stays auditable in-series (the close is intact)", "error");
			return;
		}
		// the fork file = the new session file that appeared in the dir
		const now = sDir === undefined ? [] : readdirSync(sDir).filter((f) => f.endsWith(".jsonl"));
		forkFile = now.filter((f) => !beforeSet.has(f) && f !== mainBase).sort().at(-1);
		if (forkFile === undefined) {
			emit(ctx, "sam: fork created but no new session file is visible (cannot hand off) — the unit stays auditable in-series", "error");
			return;
		}
	} catch (err) {
		// F1: the close is never broken by the side branch — it stays pending
		// and the unit remains auditable in-series (the normal path).
		emit(ctx, `sam: branch preparation failed for unit ${unitId}: ${err instanceof Error ? err.message : String(err)} — unit stays auditable in-series (the close is intact)`, "error");
		return;
	}
	// pi names session files <timestamp>_<sessionId>.jsonl (measured main +
	// fork banks) — the addressable session id is the basename minus that
	// timestamp prefix; the basename stem is handed off too (belt + braces).
	const stem = (forkFile as string).replace(/\.jsonl$/, "");
	const forkSessionId = stem.includes("_") ? stem.split("_").slice(1).join("_") : stem;
	const handoff = {
		"sam-branch-prepare": {
			unitId,
			forkFile: sDir === undefined ? (forkFile as string) : join(sDir, forkFile as string),
			forkSessionId,
			forkSessionStem: stem,
			instruction,
		},
	};
	emit(ctx, `sam: branch prepared for unit ${unitId} — next: prompt the fork session (${forkFile}) with the instruction, then run: /sam settle ${unitId} ${forkFile}`);
	emit(ctx, JSON.stringify(handoff));
}

/** P5 v3: `/sam settle <unit> [auditFile]` — stage the side-branch capture
 * and settle synchronously (the same step-2/step-3 machinery the in-series
 * settle uses; no model involved — the verdict reply was made on the fork).
 * F1: every refusal keeps the close pending and says why. */
async function settleBranchHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, unitArg: string | undefined, fileArg: string | undefined): Promise<void> {
	let unitId: number | undefined = unitArg !== undefined && unitArg.trim() !== "" ? parseInt(unitArg, 10) : undefined;
	if (unitId === undefined || Number.isNaN(unitId) || unitId < 1) {
		const pc = state.pendingCloses[state.pendingCloses.length - 1];
		if (pc !== undefined) unitId = pc.unitId;
		else {
			const units = state.ledger.units.filter((u) => u.state === "in-flight");
			unitId = units.length > 0 ? units[units.length - 1].unitId : undefined;
		}
	}
	if (unitId === undefined || Number.isNaN(unitId)) {
		emit(ctx, "sam: no open unit to settle — close one first (close_unit) or name the unit (e.g. /sam settle 1 <forkFile>)", "error");
		return;
	}
	if (state.ledger.units.find((u) => u.unitId === unitId) === undefined) {
		emit(ctx, `sam: unknown unit ${unitId} (no close record)`, "error");
		return;
	}
	let auditFile = fileArg !== undefined && fileArg.trim() !== "" ? (fileArg.includes("/") ? fileArg : join(sessionDirOf(ctx) ?? "", fileArg)) : undefined;
	if (auditFile === undefined) {
		// discover: the newest side-branch session file carrying a clean
		// audit reply for this unit (deterministic: the runner normally
		// passes the file, this is the TUI convenience path)
		const sDir = sessionDirOf(ctx);
		const mainBase = (ctx.sessionManager.getSessionFile() ?? "").split("/").pop();
		const files = sDir === undefined ? [] : readdirSync(sDir).filter((f) => f.endsWith(".jsonl") && f !== mainBase);
		let best: { file: string; mtime: number } | undefined;
		for (const f of files) {
			const p = join(sDir as string, f);
			const turn = findLastAuditTurn(readRawSessionFile(p));
			if (turn !== undefined && turn.unitId === unitId && turn.replyId !== undefined) {
				const m = statSync(p).mtimeMs;
				if (best === undefined || m > best.mtime) best = { file: p, mtime: m };
			}
		}
		if (best !== undefined) auditFile = best.file;
	}
	if (auditFile === undefined) {
		emit(ctx, `sam: no audited side-branch file found for unit ${unitId} — prepare with: /sam audit ${unitId}, prompt the fork, then settle`, "error");
		return;
	}
	stageBranchAuditFromPreviousSession(auditFile, ctx);
	if (state.branchAuditStaged === null || state.branchAuditStaged.unitId !== unitId) {
		emit(ctx, `sam: settle of unit ${unitId} refused — the side-branch capture is not eligible (reason in the log); the close stays pending`, "error");
		return;
	}
	try {
		await settleDispatch(pi, ctx);
	} catch (err) {
		emit(ctx, `sam: settle dispatch failed for unit ${unitId}: ${err instanceof Error ? err.message : String(err)} (the close stays pending; nothing half-written)`, "error");
		return;
	}
	emit(ctx, `sam: unit ${unitId} settled from the side-branch audit (ledger: settlement + terminal in the session file)`);
}

/** The session dir (pi API: getSessionDir) — total: undefined if unknown. */
function sessionDirOf(ctx: ExtensionCommandContext): string | undefined {
	try {
		const d = ctx.sessionManager.getSessionDir();
		return d === undefined || d === null ? undefined : String(d);
	} catch {
		return undefined;
	}
}
/** P5 resume backstop — wired from session_start (reason resume/fork). */
function stageBranchAuditFromPreviousSession(auditFile: string, ctx: ExtensionContext): void {
	const turn = findLastAuditTurn(readRawSessionFile(auditFile));
	if (turn === undefined || turn.replyId === undefined) return; // nothing to settle
	const mainFile = ctx.sessionManager.getSessionFile() ?? "";
	const mainEntries = ctx.sessionManager.getEntries() as unknown as RawEntry[];
	const eligible = settleEligible(mainEntries, auditFile, mainFile, turn.unitId);
	if (!eligible.ok) {
		console.error(`sam: branch-settle backstop skipped unit ${turn.unitId} — ${eligible.reason}`);
		return;
	}
	state.branchAuditStaged = { unitId: turn.unitId, auditFile, replyId: turn.replyId, replyText: turn.replyText };
}

const RETRIEVE_BOUND_CHARS = 12_000;

function bounded(text: string, source: string): string {
	return text.length > RETRIEVE_BOUND_CHARS
		? `${text.slice(0, RETRIEVE_BOUND_CHARS)}\n…[bounded: first ${RETRIEVE_BOUND_CHARS} chars shown; the source is intact — ${source}]`
		: text;
}

/**
 * The retrieval body (P5; the `sam_retrieve` tool + `/sam retrieve` share it).
 * Sources, in order: the banked audit file (instruction + full reply with
 * reasoning — the Q1 re-check case), then the settlement record itself (the
 * audit file moved/missing), then the ledger close record for 'unit N'.
 * Total: unknown id ⇒ an actionable "not found", never an error.
 */
function retrieveContent(idRaw: string, section: string | undefined, ctx: ExtensionContext): { text: string; source: string } {
	const id = idRaw.trim();
	const sec = section?.trim().toUpperCase() ?? undefined;
	const branch = currentBranch(ctx);
	let record: SamSettlementRecord | undefined;
	for (const e of branch) {
		if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
		const data = e.data as Partial<SamSettlementRecord> | undefined;
		if (data === undefined || data.kind !== "settlement") continue;
		const uidMatch = /^unit\s+(\d+)$/i.exec(id);
		if (data.retrievalId === id || (uidMatch !== null && data.unitId === parseInt(uidMatch[1], 10))) {
			record = data as SamSettlementRecord;
			break;
		}
	}
	if (record !== undefined) {
		const fileEntries = readRawSessionFile(record.auditFile);
		const turn = findLastAuditTurn(fileEntries);
		if (turn !== undefined && turn.replyText.trim() !== "") {
			const parsed = parseBranchAuditReply(turn.replyText);
			if (sec !== undefined && parsed.sections[sec] !== undefined) {
				return {
					text: bounded(`[${record.retrievalId}] unit ${record.unitId} — ${sec}:\n${parsed.sections[sec]}`, "audit file (section view)"),
					source: `audit-file: ${record.auditFile}`,
				};
			}
			const instr = (() => {
				for (let i = fileEntries.length - 1; i >= 0; i--) {
					if (fileEntries[i].type !== "message") continue;
					const m = (fileEntries[i] as { message?: { role?: string; content?: unknown } }).message;
					if (m?.role !== "user") continue;
					const t = assistantText((m.content ?? "") as string | unknown[]);
					if (t.includes(AUDIT_INSTRUCTION_PREFIX)) return t;
				}
				return "(instruction not found in the banked file)";
			})();
			return {
				text: bounded(`[audit retrieval ${record.retrievalId} — unit ${record.unitId} · verdict ${record.verdict}]\nSETTLEMENT LINE (main session, verbatim):\n${record.line}\n\nAUDIT INSTRUCTION (banked side branch, verbatim):\n${instr}\n\nAUDIT REPLY (with reasoning — banked side branch, verbatim):\n${turn.replyText}`, "audit file (full)"),
				source: `audit-file: ${record.auditFile}`,
			};
		}
		return {
			text: bounded(`[${record.retrievalId}] unit ${record.unitId} — settlement (the banked audit file is unreadable or missing):\n${record.line}`, "settlement record"),
			source: "settlement-record",
		};
	}
	const uidMatch = /^unit\s+(\d+)$/i.exec(id);
	if (uidMatch !== null) {
		const uid = parseInt(uidMatch[1], 10);
		const u = state.ledger.units.find((x) => x.unitId === uid);
		if (u !== undefined) {
			return {
				text: `unit ${uid} (ledger close record)\nstub: ${u.stub}\nevidence: ${JSON.stringify(u.evidence ?? {})}\nstate: ${u.state}${u.resolvedBasis ? ` (basis: ${u.resolvedBasis})` : ""}\n\nFor the audit content, use the settlement line's retrieval id (it is in the session or a compaction summary) — e.g. sam_retrieve <id>.`,
				source: "ledger",
			};
		}
	}
	return {
		text: `no SAM record found for '${id}'. Settlement lines carry the retrieval id (12-hex) — look for them in the session or a compaction summary; units take the form 'unit 3'. /sam report lists the ledger.`,
		source: "none",
	};
}

/**
 * Provider-busyness probe (P3, DEFAULT off). Positive-only: `busy` defers,
 * anything else proceeds; a failure means nothing (om-guard contract).
 * `?autoload=false` MANDATORY (router evicts the resident model otherwise).
 * Bounded by an 8 s abort (pi awaits the settle handler, so the await is
 * safe; documented cost when enabled, zero cost when unset).
 */
async function probeBusyness(baseUrl: string): Promise<"busy" | "idle" | "unavailable"> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8_000);
		try {
			const res = await fetch(buildProbeUrl(baseUrl), {
				signal: controller.signal,
				headers: { accept: "application/json" },
			});
			if (!res.ok) return "unavailable";
			const body: unknown = await res.json();
			return parseBusyStatus(body);
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return "unavailable";
	}
}

/* ── factory ─────────────────────────────────────────────────────────────── */

export default function factory(pi: ExtensionAPI): void {
	// Announce once per session start, in every reason (startup/resume/reload/
	// new/fork), rebuild the ledger from the session file, and apply the P3
	// session-start duties: commit-proof tombstones, D2 detection, proofs for
	// restored units.
	pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
		try {
			const ledger = rebuildLedger(currentBranch(ctx));
			state = createSamState(ledger);
			if (ledger.auditInFlight) state.audit = { ...ledger.auditInFlight };

			const g = state.governor;
			// P3: probe config (DEFAULT off — unset env ⇒ no network at all).
			const probe = process.env["SAM_PROVIDER_PROBE_URL"];
			if (typeof probe === "string" && probe.trim() !== "") {
				g.probeUrl = probe.trim();
			}
			// P4 R1 / P5: audit delivery dial (DEFAULT "followUp" — the P2/P3
			// behavior). Both non-defaults are EXACT-value opt-ins, fail-safe:
			// "steer" = in-turn delivery at close (RETAINED TOGGLE, default off —
			// Paul 2026-09-30: keep the code, re-enable if needed; the 2/2
			// measured turn-hijack profile stays on record); "branch" (P5) = the
			// audit runs on a forked session file at a turn boundary (/sam audit),
			// the verdict is captured from that file, the main line never sees
			// the audit text. Anything else is ignored.
			if (process.env["SAM_AUDIT_DELIVERY"] === "steer") {
				state.auditDelivery = "steer";
			} else if (process.env["SAM_AUDIT_DELIVERY"] === "branch") {
				state.auditDelivery = "branch";
			}
			// P4 R3: compacted-span policy. DEFAULT "tombstone" since the
			// 2026-09-30 promotion (H1 live A/B 6/6 — the arms are functionally
			// identical; the ledger terminal is the only difference). The only
			// EXACT value that opts back out is "refuse" (the original default);
			// anything else is ignored (fail-safe, exact-value-only convention).
			if (process.env["SAM_COMPACTED_SPAN"] === "refuse") {
				g.compactedSpanPolicy = "refuse";
			}
			// A span native compaction already summed out of the view is never
			// folded (zero view-token gain; it would only rewrite preserved
			// bytes): the terminal is `resolved` (compaction-owned), the gate
			// arithmetic is kept as evidence, context_edits stay zero.
			// P5 resume backstop: after a switch-back from the audit fork (or
			// any fork that carried a completed branch audit), if the PREVIOUS
			// session file holds a finished branch audit for a close that is
			// still open and unsettled HERE, stage it for settle capture.
			// File + event derived — no in-memory state is required to survive
			// the rebind (whichever way pi's runtime rebind works out).
			if (
				(event.reason === "resume" || event.reason === "fork") &&
				typeof event.previousSessionFile === "string" &&
				ctx.sessionManager.getSessionFile() !== event.previousSessionFile
			) {
				try {
					stageBranchAuditFromPreviousSession(event.previousSessionFile, ctx);
				} catch (err) {
					// F1: the backstop must never break a session start.
					console.error(`sam: branch-settle backstop failed (audit NOT staged): ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			// P3: governor derivation for the current model.
			recomputeGovernor(ctx);

			// P3: D2 coexistence — settings + branch evidence (om-guard
			// omPresence pattern; conservative on unreadable).
			g.foreignFolder = coexistenceGate(detectForeignFolder(await readSettings()), currentBranch(ctx));

			// P3: ISSUED vs COMMITTED — tombstone folded units whose stub edit
			// is missing from the branch (the s5 discard, measured). Append-
			// only `foldLost` records; never re-pend (retry-loop trap).
			const branch = currentBranch(ctx);
			for (const unit of ledger.units) {
				if (unit.state !== "folded" || !unit.entryIds || unit.entryIds.length === 0) continue;
				if (ledger.units.some((u) => u.resolvedBasis !== undefined && u.unitId === unit.unitId)) continue;
				const alreadyTombstoned = hasFoldLostRecord(branch, unit.unitId);
				if (foldCommitProof({ unitId: unit.unitId, spanFirstId: unit.entryIds[0], stub: unit.stub, corrections: unit.corrections }, branch)) continue;
				if (alreadyTombstoned) continue;
				const record: SamFoldLostRecord = {
					v: 1,
					kind: "foldLost",
					unitId: unit.unitId,
					basis: "commit-rejected: the fold batch never landed in the branch (pi 0.87.1 all-or-nothing discard, measured on the s5 run 2026-09-29)",
					ts: Date.now(),
				};
				pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
				unit.state = "resolved";
				unit.resolvedBasis = record.basis;
			}

			// P3: stage proofs for restored commitments (pendingCommits +
			// sweep candidates) so commit-time revalidation has a reference.
			for (const pc of ledger.pendingCommits) {
				stageSpanProof(state, pc.unitId, pc.span, branch);
			}
			for (const unitId of sweepCandidates(ledger)) {
				const unit = ledger.units.find((u) => u.unitId === unitId);
				if (unit?.entryIds && unit.entryIds.length > 0) {
					stageSpanProof(state, unitId, { spanFirstId: unit.entryIds[0], spanLastId: unit.entryIds[unit.entryIds.length - 1], entryIds: unit.entryIds }, branch);
				}
			}

			const counts = countUnits(ledger);
			const flags: string[] = [];
			if (state.audit) flags.push("audit resuming");
			if (state.pendingCommits.length > 0) flags.push(`${state.pendingCommits.length} verdict(s) awaiting commit`);
			if (state.auditDelivery === "steer") flags.push("audit delivery: steer (retained toggle, default off)");
			if (state.auditDelivery === "branch") flags.push("audit delivery: branch (P5 side-branch audit; /sam audit <n> prepares the fork, the fork gets the audit prompt, /sam settle <n> <forkFile> settles — main line stays audit-free)");
			if (g.compactedSpanPolicy === "refuse") flags.push("compacted spans: refuse (P4 R3 opt-out; default is tombstone)");
			if (ledger.malformedRecords > 0) flags.push(`${ledger.malformedRecords} malformed ledger record(s) skipped`);
			if (g.foreignFolder.present) flags.push(`coexistence: ${g.foreignFolder.basis}`);
			const flagText = flags.length > 0 ? ` · ${flags.join(" · ")}` : "";
			emit(
				ctx,
				`${EXTENSION_NAME} ${SAM_VERSION} loaded — /sam for status · ${describeBuild()} · ` +
					`mode ${state.mode} · folded ${counts.folded} · refused ${counts.refused} · ` +
					`undone ${counts.undone} · resolved ${counts.resolved} · in flight ${counts.inFlight}${flagText}`,
			);
			if (g.foreignFolder.present) {
				// F1-style honesty: the user must see the D2 posture plainly.
				emit(ctx, `sam: a foreign folding folder is active (${g.foreignFolder.basis}) — SAM folds are REFUSED while this holds (D2); audits and display continue.`, "error");
			}
		} catch (err) {
			// F1: a half-rebuilt state is worse than a clean one.
			state = createSamState(rebuildLedger([]));
			emit(ctx, `sam: load error (continuing with a clean state): ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	});

	// Cache ledger (port 2): observe assistant usage at message_end.
	pi.on("message_end", (event: MessageEndEvent, _ctx: ExtensionContext) => {
		try {
			const message = event.message;
			if (message.role !== "assistant") return;
			const usage = (message as { usage?: PlainUsage }).usage;
			if (usage && (usage.input || usage.cacheRead || usage.cacheWrite || usage.totalTokens)) {
				state.governor.cacheLedger.observe(usage as PlainUsage, Date.now());
			}
		} catch {
			// F1: observation never affects the session.
		}
	});

	// P5: compaction takeover (Q3) — when the branch being compacted carries a
	// SAM settlement line, the extension OWNS the summary (deterministic, zero
	// model calls): the previous cumulative summary (carried over — pi
	// convention) + every settlement line VERBATIM (digest incl. EVIDENCE —
	// the must-survive lines) + the retrieval pointer. The `details` slot
	// carries the retrieval map (first-class — pi itself stores data there);
	// the raw branch is copied to the session-dir tombstone bank (safety net
	// for shapes that rewrite the file). Spans with NO settlement go through
	// pi's own summarization untouched (control semantics preserved — the arm-C
	// shape compacts exactly as SAM-less). F1: any failure lets pi's own
	// summary stand (the takeover never blocks a compaction).
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		try {
			const prep = event.preparation;
			const branchRaw = event.branchEntries as unknown as RawEntry[];
			if (!spanHasSettlement(branchRaw)) return undefined;
			const branch = currentBranch(ctx);
			const lines: string[] = [];
			const settlements: Array<Pick<SamSettlementRecord, "unitId" | "retrievalId" | "auditFile" | "replyId">> = [];
			for (const e of branch) {
				if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
				const data = e.data as Partial<SamSettlementRecord> | undefined;
				if (data === undefined || data.kind !== "settlement" || typeof data.line !== "string") continue;
				lines.push(data.line);
				settlements.push({ unitId: data.unitId ?? 0, retrievalId: data.retrievalId ?? "", auditFile: data.auditFile ?? "", replyId: data.replyId ?? null });
			}
			if (settlements.length === 0) return undefined; // nothing to preserve — pi's own path
			try {
				const dir = join(ctx.sessionManager.getSessionDir(), "sam-tombstones");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, `tombstone-${prep.firstKeptEntryId}.jsonl`), tombstoneJsonl(branchRaw));
			} catch {
				// F1: the bank copy is a safety net, never a gate.
			}
			return {
				compaction: {
					summary: takeoverSummary(prep.previousSummary, lines),
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore,
					details: takeoverDetails(settlements),
				},
			};
		} catch (err) {
			console.error(`sam: compaction takeover refused (pi's own summary stands): ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	});

	pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<BoundaryResult | undefined> => {
		try {
			return await settleDispatch(pi, ctx);
		} catch (err) {
			// F1: never hold the settle; the session continues unmodified.
			console.error(`sam: settle dispatch error (no entries drafted): ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	});

	// close_unit — the agent's own close mark (P2 tool, P3 close-time gates).
	const CLOSE_UNIT_PARAMS = {
		type: "object",
		properties: {
			stub: { type: "string", description: CLOSE_UNIT_TOOL.parametersDescription },
		},
		required: ["stub"],
	} as const;

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
				const folded = foldedEntryIdSet(state.ledger, branch);
				if (lastRealUserEntryIsFolded(branch, folded)) {
					return {
						content: [{ type: "text", text: CLOSE_UNIT_ALREADY_CLOSED_TEXT }],
						details: { unitId: null, rejected: "already-closed" },
					};
				}
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

				// P3 close-time gate (anti-self-sealing, port item 6): an
				// empty stub over demonstrable work is refused HERE (the model
				// gets one actionable refusal) instead of spending an audit
				// turn that could pass an empty claim (the s5 9-of-10-empty-
				// stub failure).
				const openerIndex = lastRealUserIndex(branch);
				const spanMessages: PlainMessage[] = [];
				if (openerIndex !== -1) {
					for (let i = openerIndex; i < branch.length; i++) {
						const e = branch[i];
						if (e.kind === "message") spanMessages.push(e.message);
					}
				}
				const floor = extractUnitFloor(spanMessages);
				const emptyGate = emptyStubGate(params.stub, floor);
				if (!emptyGate.ok) {
					return {
						content: [{ type: "text", text: emptyStubRefusalText(emptyGate.reason ?? "the stub is empty and the unit did demonstrable work") }],
						details: { unitId: null, rejected: "empty-stub" },
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
					evidence: {
						files: floor.files.map((f) => `${f.path}[${f.ops.join(",")}]`),
						errors: floor.errors.length,
						retries: floor.retries,
						nonTrivial: floor.nonTrivial,
					},
				};
				pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
				recordCloseInMemory(unitId, params.stub, floor);
				state.pendingCloses.push({ unitId, stub: params.stub, toolCallId });
				// P4 R1 (plan carry #7): steering delivery — while the loop is
				// running this injects the audit into THIS turn (pi 0.87.1
				// `deliverAs: "steer"` — delivered "after the current tool calls,
				// before the next LLM call", verified in agent-session.js): the
				// verdict lands on the still-warm prefix and the close settles the
				// moment the turn ends. DEFAULT stays "followUp" (P2/P3 behavior).
				if (state.auditDelivery === "steer") {
					try {
						pi.sendUserMessage(auditInstruction(unitId, auditPayload(unitId)), { deliverAs: "steer" });
						state.steeredAudits.push(unitId);
					} catch (err) {
						// F1: a delivery failure must never break the close — the
						// close settle falls back to the followUp audit path.
						console.error(
							`sam: steer delivery failed for unit ${unitId} — the followUp audit carries it: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
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

	// P5: sam_retrieve — the retrieval tool (Q5; the original content behind a
	// settlement hash: the banked side-branch audit file, section views, the
	// close record). Read-only; bounded output; total (unknown id ⇒ an
	// actionable "not found", never an error).
	pi.registerTool({
		name: SAM_RETRIEVE_TOOL.name,
		label: SAM_RETRIEVE_TOOL.label,
		description: SAM_RETRIEVE_TOOL.description,
		promptSnippet: SAM_RETRIEVE_TOOL.promptSnippet,
		promptGuidelines: [...SAM_RETRIEVE_TOOL.promptGuidelines],
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: SAM_RETRIEVE_TOOL.parametersDescription },
				section: { type: "string", description: "Optional: FACTS, DECISIONS, DISPROVED, EXPLORED-DISCARDED or EVIDENCE (omit for the full audit)." },
			},
			required: ["id"],
		} as const,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const id = String((params as { id?: unknown }).id ?? "");
				const section = (params as { section?: unknown }).section;
				const out = retrieveContent(id, typeof section === "string" ? section : undefined, ctx);
				return { content: [{ type: "text", text: out.text }], details: { source: out.source } };
			} catch (err) {
				return {
					content: [{ type: "text", text: `sam_retrieve failed (nothing read): ${err instanceof Error ? err.message : String(err)}` }],
				details: { source: "error" },
			};
		}
	},
});

	pi.registerCommand("sam", {
		description:
			"pi-self-aware-memory: /sam · /sam mode <display|manual|assisted|auto> · /sam report · /sam undo · /sam fold <n> · /sam resolve <n> · /sam audit <n> · /sam retrieve <id>",
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
						emit(ctx, statusText(ctx));
						return;
					}
					if (!isSamMode(target)) {
						emit(ctx, `sam: unknown mode '${target}' — one of: ${SAM_MODES.join(" | ")}`, "error");
						return;
					}
					if (target !== state.mode) {
						// P3: all four modes implemented; the mode change is a
						// breadcrumb (R3) and a model-independent ladder reset.
						state.governor.modeHistory.push({ from: state.mode, to: target, settle: state.governor.settleCount });
						state.mode = target;
						const record: SamModeRecord = { v: 1, kind: "mode", mode: target, ts: Date.now() };
						pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
						emit(ctx, `sam: mode is now '${state.mode}'`);
					}
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
					await foldHandler(pi, ctx, rest[0]);
					return;
				}
				if (head === "resolve") {
					resolveHandler(pi, ctx, rest[0]);
					return;
				}
				if (head === "audit") {
					// P5 v3: PREPARE the side-branch audit (fork + handoff emit; NO
					// model turn — every SAM command is model-free; the runner
					// prompts the fork, then /sam settle). Design doc §13.
					await auditHandler(pi, ctx, rest[0]);
					return;
				}
				if (head === "settle") {
					// P5 v3: stage the side-branch capture + settle synchronously.
					await settleBranchHandler(pi, ctx, rest[0], rest[1]);
					return;
				}
				if (head === "retrieve") {
					// P5: retrieval for humans/TUI (same resolver as sam_retrieve).
					const out = retrieveContent(rest.join(" ").trim(), undefined, ctx);
					emit(ctx, out.text);
					return;
				}
				emit(ctx, `sam: unknown subcommand '${head}' — /sam · /sam mode <display|manual|assisted|auto> · report · undo · fold <n> · resolve <n> · audit <n> (prepare branch) · settle <n> [forkFile] · retrieve <id>`, "error");
			} catch (err) {
				// F1 fail-open: the status surface must never take a session down.
				emit(ctx, `sam: internal error (no state changed): ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

function lastRealUserIndex(branch: readonly PlainEntry[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.kind !== "message" || entry.message.role !== "user") continue;
		if (isSamInjected(messageText(entry.message.content))) continue;
		return i;
	}
	return -1;
}

function hasFoldLostRecord(branch: readonly PlainEntry[], unitId: number): boolean {
	for (const entry of branch) {
		if (entry.kind !== "custom" || entry.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
		const data = entry.data as { kind?: unknown; unitId?: unknown } | undefined;
		if (data && data.kind === "foldLost" && data.unitId === unitId) return true;
	}
	return false;
}

/**
 * P3: `/sam fold <n>` — fold a specific unit NOW. VERIFIED units fold
 * normally; CORRECTIONS units fold with `override: true` (the user sees the
 * corrections in the fold record and the stub's corrected text); UNAUDITABLE
 * refuses (nothing was ever verified). Gates still bind (safety); the keep
 * window does not (intent).
 */
async function foldHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, arg: string | undefined): Promise<void> {
	if (arg === undefined) {
		emit(ctx, "sam: usage — /sam fold <unit-id>", "error");
		return;
	}
	const unitId = Number.parseInt(arg, 10);
	if (!Number.isFinite(unitId) || unitId < 1) {
		emit(ctx, `sam: '${arg}' is not a unit id`, "error");
		return;
	}
	const unit = state.ledger.units.find((u) => u.unitId === unitId);
	if (!unit) {
		emit(ctx, `sam: no unit ${unitId} in the ledger`, "error");
		return;
	}
	if (unit.state === "folded") {
		emit(ctx, `sam: unit ${unitId} is already folded`);
		return;
	}
	if (unit.state === "resolved") {
		emit(ctx, `sam: unit ${unitId} is a tombstone (${unit.resolvedBasis ?? "resolved"}) — it cannot be folded`, "error");
		return;
	}
	if (unit.verdict === undefined || unit.verdict.class === "UNAUDITABLE") {
		emit(ctx, `sam: unit ${unitId} has no verifiable verdict (not audited or UNAUDITABLE) — close and audit it first`, "error");
		return;
	}
	if (unit.entryIds === undefined || unit.entryIds.length === 0) {
		emit(ctx, `sam: unit ${unitId} has no span to fold (the ledger has no entry ids for it)`, "error");
		return;
	}
	const branch = currentBranch(ctx);
	const folded = foldedEntryIdSet(state.ledger, branch);
	if (unit.entryIds.some((id) => folded.has(id))) {
		emit(ctx, `sam: unit ${unitId}'s span touches a folded region — refused (second-fold rule)`, "error");
		return;
	}
	const override = unit.verdict.class === "CORRECTIONS";
	state.pendingFold = {
		unitId: unit.unitId,
		spanFirstId: unit.entryIds[0],
		spanLastId: unit.entryIds[unit.entryIds.length - 1],
		entryIds: unit.entryIds,
		corrections: unit.corrections,
		override,
	};
	stageSpanProof(state, unit.unitId, { spanFirstId: unit.entryIds[0], spanLastId: unit.entryIds[unit.entryIds.length - 1], entryIds: unit.entryIds }, branch);

	// The commit needs a boundary (P2 undo discipline). While streaming, the
	// ack rides the current run's settle; while idle, ride one short turn
	// (the same waitForNestedTurn that makes `/sam undo` deterministic).
	try {
		if (ctx.isIdle()) {
			pi.sendUserMessage(`${UNDO_ACK_PREFIX} fold of unit ${unitId} ${override ? "(user override)" : ""} requested. Reply with exactly OK.`);
			await waitForNestedTurn(ctx);
		} else {
			pi.sendUserMessage(`${UNDO_ACK_PREFIX} fold of unit ${unitId} ${override ? "(user override)" : ""} requested. Reply with exactly OK.`, { deliverAs: "followUp" });
		}
	} catch (err) {
		console.error(`sam: fold ack turn failed (fold stays pending for the next settle): ${err instanceof Error ? err.message : String(err)}`);
	}
	emit(ctx, `sam: fold of unit ${unitId}${override ? " (override — CORRECTIONS verdict)" : ""} in flight — commits after one short turn (gates still apply)`);
}

/** P3: `/sam resolve <n>` — positive resolution evidence for the unit's guard facts. */
function resolveHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, arg: string | undefined): void {
	if (arg === undefined) {
		emit(ctx, "sam: usage — /sam resolve <unit-id>", "error");
		return;
	}
	const unitId = Number.parseInt(arg, 10);
	if (!Number.isFinite(unitId) || unitId < 1) {
		emit(ctx, `sam: '${arg}' is not a unit id`, "error");
		return;
	}
	const unit = state.ledger.units.find((u) => u.unitId === unitId);
	if (!unit) {
		emit(ctx, `sam: no unit ${unitId} in the ledger`, "error");
		return;
	}
	const next = resolveFactIfPositive(state.governor.guardFacts, unitId, "disputed-stub", "user-resolved", state.governor.settleCount);
	if (next) state.governor.guardFacts = next;
	if (unit.state === "refused" || unit.state === "in-flight") unit.state = "resolved";
	unit.resolvedBasis = "user-resolved";
	const record: SamResolveRecord = { v: 1, kind: "resolve", unitId, basis: "user-resolved", ts: Date.now() };
	// durable
	try {
		pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
	} catch {
		// F1
	}
	emit(ctx, `sam: unit ${unitId} resolved (tombstone kept in the ledger — never reactivated, R2)`);
}

/**
 * Wait for the nested turn that pi.sendUserMessage just started to become
 * active and run to completion.
 *
 * v0.87.1: ExtensionAPI.sendUserMessage is fire-and-forget. In print mode
 * the process disposes the session as soon as the slash command returns
 * (dispose() aborts the run and drops listeners), so an un-awaited ack turn
 * is aborted mid-fetch and never persists — while the settle still fires,
 * leaving which stray entries survive to microtask timing (the P2 flaky
 * assertions). Awaiting here makes the final state deterministic (measured
 * on v0.87.1, walk undo arm).
 */
async function waitForNestedTurn(ctx: ExtensionCommandContext): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (ctx.isIdle() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 5));
	}
	if (!ctx.isIdle()) {
		await ctx.waitForIdle();
	}
}

/** /sam undo — restore the last folded unit (design note §5, P2). */
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
	try {
		if (ctx.isIdle()) {
			pi.sendUserMessage(undoAck(unit.unitId));
			await waitForNestedTurn(ctx);
		} else {
			pi.sendUserMessage(undoAck(unit.unitId), { deliverAs: "followUp" });
		}
	} catch (err) {
		console.error(`sam: undo ack turn failed (undo stays pending for the next settle): ${err instanceof Error ? err.message : String(err)}`);
	}
	emit(ctx, `sam: undo of unit ${unit.unitId} in flight — the original view is restored after one short turn`);
}

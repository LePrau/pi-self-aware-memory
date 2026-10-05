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
	InputEvent,
	MessageEndEvent,
	SessionBeforeCompactEvent,
	SessionBoundaryDraft,
	SessionEntry,
	SessionMessageEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { EXTENSION_NAME, SAM_VERSION, describeBuild } from "../../src/identity.ts";
import {
	AUDIT_INSTRUCTION_PREFIX,
	CLOSE_UNIT_ALREADY_CLOSED_TEXT,
	CLOSE_UNIT_NO_NEW_WORK_TEXT,
	CLOSE_UNIT_AUDIT_FORK_TEXT,
	CLOSE_UNIT_PENDING_TEXT,
	CLOSE_UNIT_TOOL,
	CLOSE_UNIT_TOOL_V4,
	auditInstruction,
	type SamAuditPayload,
	closeUnitResultText,
	emptyStubRefusalText,
	isSamInjected,
	undoAck,
	autoStubInstruction,
	UNDO_ACK_PREFIX,
	branchAuditInstruction,
	lightAuditInstruction,
	SAM_RETRIEVE_TOOL,
	ADJUST_GOAL_TOOL,
	READ_GOAL_TOOL,
	adjustGoalResultText,
	READ_GOAL_NO_GOAL_TEXT,
	goalToolAuditForkText,
} from "../../src/protocol.ts";
import { fallbackGoal, goalRecords, latestGoal, type SamGoalRecord } from "../../src/goal.ts";
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
	retrievalIdOf,
	parseBranchAuditReply,
	readRawSessionFile,
	spanHasSettlement,
	takeoverSummary,
	takeoverDetails,
	tombstoneJsonl,
	settleEligible,
	weakSettlementRecord,
	entryText,
	computeOrphanZone,
	orphanRecord,
	anchorWindow,
	renderAnchorWindow,
	type RawEntry,
	type SamSettlementRecord,
	type SamOrphanRecord,
	type BranchAuditStaged,
	branchSettlementRecords,
	settlementBlock,
} from "../../src/branchaudit.ts";
import {
	createRetireOfferState,
	retireCensus,
	retireOfferArmedOnFold,
	retireOfferDecision,
	retireOfferText,
	retireThresholdChars,
	validateRetireCall,
	type RetireLedgerEntry,
} from "../../src/retire.ts";
import { RETIRE_UNITS_TOOL, UNRETIRE_TOOL, retireAckText, retireRefuseText, unretireAckText } from "../../src/protocol.ts"; // v5 RETIRE (2026-10-06, Paul)
import {
	prepareChildArgs,
	auditChildArgs,
	parsePrepareHandoff,
	auditTimeoutMs,
	PREPARE_CHILD_DEFAULT_TIMEOUT_MS,
	classifyReClose,
	lastCloseRecord,
	settledUnitIds,
	closeRecordForUnit,
	lineIsAuditFork,
	closeAuditResultLine,
	stubLineCount,
	closeAuditDecision,
	auditDepthOf,
	missingAuditReplyClass,
	auditChildCompactionSettings,
	D10_AGENT_DIR_ENV,
	D10_CHILD_DIRNAME,
	lastSettlementStrengthFor,
	type CloseAuditLine,
	type CloseAuditDeferReason,
	type CloseAuditStagedItem,
	type SettlementStrength,
} from "../../src/closeaudit.ts";
import {
	NUDGE_LEDGER_CUSTOM_TYPE,
	DEFAULT_REASONING_CHARS,
	DEFAULT_REASONING_CALLS,
	NUDGE_GAP_TOKENS,
	MATERIALIZING_TOOLS,
	applyBaselineReset,
	applyNudgeFire,
	bumpActivity,
	childEnv,
	decideNudge,
	envInt,
	materializeReset,
	nudgeEnabled,
	nudgeLedgerEntry,
	nudgeText,
	reasoningCharsOf,
	resetNudgeStretch,
} from "../../src/nudge.ts";
import {
	GOAL_NUDGE_TEXTS,
	GOAL_NUDGE_VARIANTS,
	armGoalOffer,
	clearGoalPending,
	consumeGoalOffer,
	goalNudgeLedgerEntry,
	goalNudgeText,
	isGoalUserInput,
	type GoalNudgeState,
} from "../../src/goal-nudge.ts";
import {
	SAM_COMMAND_DESCRIPTION,
	samCompletionsFor,
} from "../../src/tui-completions.ts";
import { lastRealUserEntryIsFolded, resolveUnitSpan, resolveCloseUnitSpan, closeCandidateSpanOk, type PendingClose } from "../../src/units.ts";
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
	actionEnterOf,
	type GovernedModel,
} from "../../src/governor.ts";
import {
	SAM_LEDGER_CUSTOM_TYPE,
	parseSamRecord,
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
	auditDeliveryFromEnv,
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
	recomputeGovernor(ctx); // sam-05 (2026-10-05, measured): a model switch between settle boundaries leaves the STARTUP ladder in place (pi 0.87.1 has no model_change EXTENSION EVENT) — re-derive (idempotent signature diff) so the status view is honest for the CURRENT model
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
	// D11 (2026-10-02): the goal line (close-dial surface — the v3 control
	// arms keep their status block byte-stable).
	let goalView;
	if (state.auditDelivery === "close") {
		const goals = state.ledger.goals;
		const latest = goals.length > 0 ? goals[goals.length - 1] : undefined;
		goalView = {
			text: latest?.text,
			basis: latest?.basis,
			ts: latest?.ts,
			earlier: Math.max(0, goals.length - 1),
		};
	}
	return renderSamStatus(
		{ state, usage: ctx.getContextUsage(), model: modelInfo(ctx), goal: goalView },
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
	// P5 v3: the unit settled from the side branch in THIS dispatch (the
	// step-4 re-audit queue still carries it — the main line legitimately
	// has no in-series audit message — so it must not re-fire as a restored
	// close: measured noise in walk v3d, "already-closed").
	let stagedBranchSettledUnit: number | undefined;
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
		// P5 v3 (measured 2026-10-01, walk v3b): the settle normally runs in a
		// FRESH process (runner-orchestrated stages) — state.pendingCloses is
		// per-process memory (populated at close time, in the task's process).
		// The file-derived source is the close record (customType sam, kind
		// "close" — it carries unitId + stub + toolCallId): rebuild the
		// pending close from the LAST close record for this unit in view.
		let pendingClose: PendingClose | undefined =
			state.pendingCloses[state.pendingCloses.length - 1] ?? undefined;
		if (pendingClose === undefined || pendingClose.unitId !== staged.unitId) {
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
				const rec = parseSamRecord(e.data);
				if (rec !== undefined && rec.kind === "close" && rec.unitId === staged.unitId) {
					pendingClose = { unitId: rec.unitId, stub: rec.stub, toolCallId: rec.toolCallId };
					break;
				}
			}
		}
		if (pendingClose === undefined) {
			// F1: fail open — nothing is appended, the close stays pending,
			// the unit stays auditable in-series.
			console.error(`sam: branch settle of unit ${staged.unitId} refused — no close record for it in view (nothing half-written; the close stays pending)`);
			return { entries: [...entries] };
		}
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
		stagedBranchSettledUnit = span.unitId;
		state.pendingCloses = [];
	}

	// 2.5) v4 ("close" dial): commit the staged close-audits (FIFO) — one
	// settlement record + one resolve terminal (basis "close-audit") per
	// unit, NO fold draft (v4-plan §3 step 8 / D1: the span stays in view
	// until the compaction takeover re-emits the settlement line(s); an
	// explicit /sam fold remains the escape hatch). D9 (2026-10-02): this
	// drain is now the IDEMPOTENT BACKSTOP — the primary commit happened at
	// verdict time (commitCloseAuditItem, mid-turn); it still runs for items
	// whose verdict-commit did not land (span drift / unknown unit), and a
	// WEAK settlement (light / audit-failed) here is an UPGRADE target (the
	// strong record appends, naming the weak one in `supersedes`). Gates
	// still bind (the P3 empty-stub refusal keeps its semantics); proof
	// revalidation runs (a drifted span fails the commit — F1, raw span
	// stays in view); idempotent on the branch (a STRONG record already
	// present ⇒ skip).
	if (state.closeAuditStaged.length > 0) {
		const branch = currentBranch(ctx);
		const settledNow = settledUnitIds(branch);
		while (state.closeAuditStaged.length > 0) {
			const item = state.closeAuditStaged.shift()!;
			const unit = state.ledger.units.find((u) => u.unitId === item.unitId);
			if (unit === undefined) {
				console.error(`sam: close-audit settle refused — unknown unit ${item.unitId} (the fork file stays banked for /sam retrieve)`);
				continue;
			}
			// D9: a WEAK settlement (light / audit-failed) is an UPGRADE target —
			// the drain commits the strong settlement appended (naming the weak
			// one in `supersedes`); a STRONG one is final (idempotence-skip, as
			// in v4).
			// Anomaly fix (b) (2026-10-02, final-manifest candidates a/b/c; the
			// run-03 [201]–[204] re-settle wave): a WEAK staged item
			// (NOT-YET-VERIFIED) never re-commits over an existing settlement —
			// never weak-over-weak (especially not supersedes === own id); only
			// a STRONG item may upgrade a weak settlement.
			const itemIsWeak = item.verdict === "NOT-YET-VERIFIED";
			if (settledNow.has(item.unitId) && (lastSettlementStrengthFor(branch, item.unitId) !== "WEAK" || itemIsWeak)) {
				console.error(`sam: close-audit unit ${item.unitId} already settled on the branch (idempotence / weak-over-weak skip — the staged capture is dropped, the fork file stays banked)`);
				continue;
			}
			const spanMessages: PlainMessage[] = [];
			const ids = new Map(branch.map((e) => [e.id, e]));
			for (const id of item.span.entryIds) {
				const e = ids.get(id);
				if (e?.kind === "message") spanMessages.push(e.message);
			}
			const floor = extractUnitFloor(spanMessages);
			const emptyGate = emptyStubGate(item.span.stub, floor);
			if (!emptyGate.ok) {
				const record: SamNoFoldRecord = {
					v: 1, kind: "noFold", unitId: item.unitId, entryIds: item.span.entryIds,
					spanFirstId: item.span.spanFirstId, spanLastId: item.span.spanLastId,
					stub: item.span.stub, verdict: "UNAUDITABLE", reason: "empty-stub",
					reasons: [emptyGate.reason ?? "empty stub over work"], ts: Date.now(), mode: state.mode,
				};
				unit.state = "refused";
				entries.push(...toBoundaryEntries([], record));
				g.guardFacts.push({ unitId: item.unitId, kind: "gate-reject", basis: "empty-stub", sinceSettle: g.settleCount });
				continue;
			}
			if (unit.evidence === undefined) {
				unit.evidence = {
					files: floor.files.map((f) => `${f.path}[${f.ops.join(",")}]`),
					errors: floor.errors.length,
					retries: floor.retries,
					nonTrivial: floor.nonTrivial,
				};
			}
			// Proof revalidation (staged at close time): the span must be
			// intact at settle (append-only growth beyond it is fine).
			const proof = state.spanProofs.get(item.unitId);
			if (proof !== undefined) {
				const rv = revalidateSpan(proof, branch);
				if (rv.ok === false) {
					console.error(`sam: close-audit unit ${item.unitId} span drifted since close — settlement not committed (raw span stays in view; the fork file remains banked for /sam retrieve)`);
					continue;
				}
			}
			const record = buildSettlementRecord(item.unitId, item.auditFile, item.replyId, item.replyText, item.stagedAt, item.span.stub);
			if (record !== undefined) {
				// D9 upgrade path: name the weak settlement this strong one replaces.
				if (settledNow.has(item.unitId) && lastSettlementStrengthFor(branch, item.unitId) === "WEAK") {
					for (let i = branch.length - 1; i >= 0; i--) {
						const e = branch[i];
						if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
						const d2 = e.data as { kind?: unknown; unitId?: unknown; retrievalId?: unknown } | undefined;
						if (d2?.kind === "settlement" && d2.unitId === item.unitId && typeof d2.retrievalId === "string") {
							record.supersedes = d2.retrievalId;
							break;
						}
					}
				}
				entries.push(...toBoundaryEntries([], record));
			}
			const resolveRecord: SamResolveRecord = {
				v: 1, kind: "resolve", unitId: item.unitId, basis: "close-audit",
				spanFirstId: item.span.spanFirstId, spanLastId: item.span.spanLastId,
				entryIds: [...item.span.entryIds], stub: item.span.stub,
				verdict: item.verdict, corrections: item.corrections,
				gateReasons: [], ts: Date.now(),
			};
			entries.push(...toBoundaryEntries([], resolveRecord));
			unit.state = "resolved";
			unit.resolvedBasis = "close-audit";
			unit.verdict = { class: item.verdict, corrections: item.corrections };
			unit.corrections = item.corrections;
			g.guardFacts.push({ unitId: item.unitId, kind: "close-audit", basis: item.verdict, sinceSettle: g.settleCount });
			g.cacheLedger.noteCommit("close-audit", Date.now());
			state.pendingCloses = state.pendingCloses.filter((pc) => pc.unitId !== item.unitId);
		}
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
	if (nextClose !== undefined && nextClose.unitId === stagedBranchSettledUnit) {
		nextClose = undefined; // already settled from the side branch in this dispatch (consumed, not re-fired)
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

		// v4 ("close" dial): the close is committed but its audit is deferred
		// (awaiting the re-audit: the model's same-stub close_unit, or the
		// operator's /sam audit <n> + /sam settle). Never queue an in-series
		// audit (the main-line audit-free invariant is the v4 core); the unit
		// otherwise falls to native compaction (the pi base outcome, v4-plan
		// §1 crash row) and everything stays retrievable.
		if (state.auditDelivery === "close") {
			if (!g.closeHoldAnnounced) {
				g.closeHoldAnnounced = true;
				console.error(`sam: close-audit mode — unit ${span.unitId} awaits its audit: re-close with the same stub, or /sam audit ${span.unitId} (+ /sam settle) — the close is effective, nothing is folded`);
			}
			return entries.length > 0 ? { entries } : undefined;
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
	let prepareErr: string | undefined;
	const mainBase = (sFile as string).split("/").pop();
	const beforeSet = new Set(sDir === undefined ? [] : readdirSync(sDir).filter((f) => f.endsWith(".jsonl")));
	// pi 0.87.1 contract (measured 2026-10-01, first v3 walk run): after
	// ctx.fork() the captured command ctx is STALE — pi's guard rejects any
	// post-replacement use. All post-replacement work therefore runs inside
	// withSession(), on the fresh ReplacedSessionContext.
	const discoverForkFile = (fctx: ExtensionCommandContext): string | undefined => {
		// the fork is the replacement session — its file is the audit file;
		// belt + braces: fall back to the pre/post fork directory diff.
		const current = fctx.sessionManager.getSessionFile();
		if (current !== undefined && current !== null) {
			const base = String(current).split("/").pop() ?? "";
			if (base.endsWith(".jsonl") && base !== mainBase) return base;
		}
		const dir = sessionDirOf(fctx);
		if (dir !== undefined) {
			const fresh = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !beforeSet.has(f) && f !== mainBase).sort();
			if (fresh.length > 0) return fresh.at(-1);
		}
		return undefined;
	};
	try {
		const res = await ctx.fork(leafId, {
			position: "at",
			withSession: async (fctx) => {
				forkFile = discoverForkFile(fctx);
				if (forkFile === undefined) {
					prepareErr = "fork created but no new session file is visible (cannot hand off)";
					emit(fctx, `sam: ${prepareErr} — unit ${unitId} stays auditable in-series (the close is intact)`, "error");
					return;
				}
				// pi names session files <timestamp>_<sessionId>.jsonl (measured
				// main + fork banks) — the addressable session id is the basename
				// minus that timestamp prefix; the basename stem is handed off too
				// (belt + braces).
				const stem = forkFile.replace(/\.jsonl$/, "");
				const forkSessionId = stem.includes("_") ? stem.split("_").slice(1).join("_") : stem;
				const dir = sessionDirOf(fctx);
				const handoff = {
					"sam-branch-prepare": {
						unitId,
						forkFile: dir === undefined ? forkFile : join(dir, forkFile),
						forkSessionId,
						forkSessionStem: stem,
						instruction,
					},
				};
				emit(fctx, `sam: branch prepared for unit ${unitId} — next: prompt the fork session (${forkFile}) with the instruction, then run: /sam settle ${unitId} ${forkFile}`);
				emit(fctx, JSON.stringify(handoff));
			},
		});
		if (res.cancelled) {
			try {
				emit(ctx, "sam: the branch fork was cancelled (cannot prepare the side-branch audit) — the unit stays auditable in-series (the close is intact)", "error");
			} catch {
				/* the staleness guard already aborted the command with a reason */
			}
			return;
		}
		if (prepareErr !== undefined) return; // the fresh-ctx emit above already reported it
	} catch (err) {
		// F1: the close is never broken by the side branch — it stays pending
		// and the unit remains auditable in-series (the normal path).
		emit(ctx, `sam: branch preparation failed for unit ${unitId}: ${err instanceof Error ? err.message : String(err)} — unit stays auditable in-series (the close is intact)`, "error");
		return;
	}
}

/** P5 v3: `/sam settle <unit> [auditFile]` — stage the side-branch capture
 * and settle synchronously (the same step-2/step-3 machinery the in-series
 * settle uses; no model involved — the verdict reply was made on the fork).
 * F1: every refusal keeps the close pending and says why. */
async function settleBranchHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, unitArg: string | undefined, fileArg: string | undefined): Promise<void> {
	if (!ctx.isIdle()) {
		emit(ctx, "sam: wait for the current response to finish before settling the branch audit (the settle rides the settle boundary of the running turn)", "error");
		return;
	}
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
			if (turn !== undefined && turn.unitId === unitId && turn.replyId !== undefined && turn.replyText.trim() !== "") {
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
	const staged = state.branchAuditStaged !== null ? state.branchAuditStaged : null;
	if (state.branchAuditStaged === null || state.branchAuditStaged.unitId !== unitId) {
		emit(ctx, `sam: settle of unit ${unitId} refused — the side-branch capture is not eligible (reason in the log); the close stays pending`, "error");
		return;
	}
	// P5 v3 (measured 2026-10-01, walk v3e): extension commands SHORT-CIRCUIT
	// pi's prompt path (pi 0.87.1, agent-session.js: "Extension command
	// executed, no prompt to send" → return) — with no agent run, the
	// agent_before_settle boundary (which commits the staged boundary
	// entries — the extension ctx is a ReadonlySessionManager with no append
	// API) never fires, and the staged settlement is silently lost (v3e:
	// "staged for settlement" emitted, zero records banked). The /sam undo
	// arm rides the measured workaround: queue an ack message and await the
	// nested turn INSIDE the handler; the settle boundary fires after the
	// turn and pi commits the staged entries (P2 measurement: "the settle
	// still fires" — walk undo arm, green). The ack is [sam-internal] (like
	// the undo ack): the main line stays AUDIT-FREE (the analyzer asserts
	// zero [sam-audit] entries in the main file) — the model's reply
	// content is irrelevant to the commit.
	pi.sendUserMessage(`${UNDO_ACK_PREFIX} Settlement of unit ${unitId} is committing (the side-branch audit completed on the fork). Reply with exactly OK.`);
	// P5 v3: machine-readable settle handoff (runner capture) — the retrieval
	// id recomputes deterministically from the staged capture (same audit
	// file + reply id + reply text the settlement record will carry).
	if (staged !== null && staged.unitId === unitId && staged.replyId !== undefined && staged.replyText.trim() !== "") {
		const id = retrievalIdOf(staged.auditFile, staged.replyId, staged.replyText);
		emit(ctx, `sam: unit ${unitId} staged for settlement from the side-branch audit — committing in this turn's settle boundary (the close is never broken by the side branch)`);
		emit(ctx, JSON.stringify({ "sam-branch-settle": { unitId, retrievalId: id } }));
	}
	await waitForNestedTurn(ctx);
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
	// P5 v3 (measured 2026-10-01, walk v3b): pi banks EMPTY assistant messages
	// on model failures (500 retries) — an empty reply is NOT a verdict; never
	// stage one (fail open: the unit stays auditable in-series).
	if (turn === undefined || turn.replyId === undefined) return; // nothing to settle
	if (turn.replyText.trim() === "") {
		console.error(`sam: branch-settle backstop skipped unit ${turn.unitId} — the audit reply in ${auditFile} is empty (model failure on the fork?) — the unit stays auditable in-series`);
		return;
	}
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
function tombstoneLine(e: RawEntry): string {
	// one inspection line per banked entry (bounded — this is the "read a part"
	// surface: lines are what anchor-window slices over)
	if (e.type === "message" && e.message) {
		const role = String((e.message as { role?: string }).role ?? "?");
		const text = entryText(e).trim();
		const calls: string[] = [];
		const content = (e.message as { content?: unknown }).content;
		if (Array.isArray(content)) {
			for (const b of content as Array<{ type?: string; name?: string }>) {
				if (b?.type === "toolCall" && typeof b.name === "string") calls.push(b.name);
			}
		}
		const parts: string[] = [];
		if (text !== "") parts.push(`“${text.slice(0, 400)}${text.length > 400 ? "…" : ""}”`);
		if (calls.length > 0) parts.push(`calls: ${calls.join(", ")}`);
		return `[${role}] ${parts.length > 0 ? parts.join(" · ") : "(no text, no calls)"}`;
	}
	try {
		const j = JSON.stringify(e);
		return `[${e.type}] ${j.length > 300 ? j.slice(0, 300) + "…" : j}`;
	} catch {
		return `[${e.type}] (unserializable)`;
	}
}

function retrieveContent(idRaw: string, section: string | undefined, ctx: ExtensionContext, anchorRaw?: string): { text: string; source: string } {
	const id = idRaw.trim();
	const sec = section?.trim().toUpperCase() ?? undefined;
	const anchor = anchorRaw === undefined ? undefined : anchorRaw.trim() !== "" ? anchorRaw.trim() : undefined;
	/** exact-anchor slice over a full text (undefined when no anchor was asked) */
	const viaAnchor = (fullText: string, sourceName: string): string | undefined =>
		anchor !== undefined ? renderAnchorWindow(anchorWindow(fullText.split("\n"), anchor), sourceName, anchor) : undefined;
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
			const fullText = `SETTLEMENT LINE (main session, verbatim):\n${record.line}\n\nAUDIT INSTRUCTION (banked side branch, verbatim):\n${instr}\n\nAUDIT REPLY (with reasoning — banked side branch, verbatim):\n${turn.replyText}`;
			const awFull = viaAnchor(`[audit retrieval ${record.retrievalId} — unit ${record.unitId} · verdict ${record.verdict}]\n` + fullText, "the banked audit file");
			if (awFull !== undefined) return { text: bounded(awFull, "audit file (anchor window)"), source: `audit-file: ${record.auditFile}` };
			return {
				text: bounded(`[audit retrieval ${record.retrievalId} — unit ${record.unitId} · verdict ${record.verdict}]\n${fullText}`, "audit file (full)"),
				source: `audit-file: ${record.auditFile}`,
			};
		}
		return {
			text: bounded(`[${record.retrievalId}] unit ${record.unitId} — settlement (the banked audit file is unreadable or missing):\n${record.line}`, "settlement record"),
			source: "settlement-record",
		};
	}
	// 2026-10-02 orphan hatch: an ORPHANED retrieval id → the fold tombstone
	// (the raw entries of the unclosed-at-fold zone — inspect in anchored windows).
	for (const e of branch) {
		if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
		const d = e.data as Partial<SamOrphanRecord> | undefined;
		if (d?.kind !== "orphan" || typeof d.retrievalId !== "string" || d.retrievalId !== id) continue;
		const foldId = typeof d.foldId === "string" ? d.foldId : "?";
		const file = join(ctx.sessionManager.getSessionDir(), "sam-tombstones", `tombstone-${foldId}.jsonl`);
		const raw = readRawSessionFile(file);
		const ids = new Set((d.entryIds ?? []).filter((x) => typeof x === "string"));
		const zone = raw.filter((x) => ids.has(x.id));
		const pool = zone.length > 0 ? zone : raw; // tombstone drift ⇒ the whole fold span (total, never an error)
		const full = `[orphan ${id} — raw span banked at fold ${foldId} (${pool.length} entries; NOT audited, treat as UNVERIFIED)]\n` + pool.map((x) => tombstoneLine(x)).join("\n");
		const aw = viaAnchor(full, `the fold tombstone (${foldId})`);
		if (aw !== undefined) return { text: bounded(aw, "orphan tombstone (anchor window)"), source: `tombstone: ${file}` };
		return { text: bounded(full, "orphan tombstone (full)"), source: `tombstone: ${file}` };
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
		text: `no SAM record found for '${id}'. Settlement lines carry the retrieval id (12-hex) — look for them in the session or a compaction summary; orphaned spans (unclosed at fold) carry one in their ORPHANED section; units take the form 'unit 3'. /sam report lists the ledger.`,
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

// v4 (close-audit): the synchronous audit pipeline + its injectable runner
// seam (suite discipline: no real process inside the test run — the live
// probe banks exercise the real spawn; the v3 lesson is that the fork
// happens in a CHILD process, never in the tool handler).
export interface CloseAuditRunner {
	run(
		args: string[],
		opts: { timeoutMs: number; label: string; signal?: AbortSignal | undefined; /** D10 (2026-10-02): the child's env (default: childEnv — the audit child gets the never-fold agent dir via PI_CODING_AGENT_DIR; the prepare child keeps the default) */ env?: Record<string, string | undefined> },
	): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}

const capTail = (s: string, n: number): string => (s.length > n ? s.slice(s.length - n) : s);

// D10 (2026-10-02): the audit child must NEVER fold (Paul: "the child is under
// no circumstances allowed to fold"). MECHANISM (pi 0.87.1 source-measured;
// see the closeaudit.ts D10 note): the agent dir is env-overridable
// (PI_CODING_AGENT_DIR — dist/config.js getAgentDir), so the child gets its
// OWN agent dir: settings.json as a REAL file (parent's content +
// compaction.enabled=false FORCED — auditChildCompactionSettings, pure),
// everything else SYMLINKED (identical sharing to today's shared-dir child;
// settings writes land in the throwaway copy). with `enabled:false`:
// shouldCompact() = false (threshold dead) + _checkCompaction() early-return
// (overflow recovery dead) — the failure class is therefore the D9 hatch
// (UNVERIFIED-AUDIT-FAILED, "bold-claim-us-with-caution"): NOT-YET-VERIFIED
// is contractually impossible without an auditor reply (D8).
function parentAgentDir(): string {
	const envDir = process.env[D10_AGENT_DIR_ENV];
	if (envDir) return envDir;
	return join(homedir(), ".pi", "agent");
}

function buildAuditChildAgentDir(sessionDir: string, label: string): string | undefined {
	try {
		const parentDir = parentAgentDir();
		const childDir = join(sessionDir, D10_CHILD_DIRNAME, label);
		mkdirSync(childDir, { recursive: true });
		let parentSettingsRaw: string | null = null;
		try {
			parentSettingsRaw = readFileSync(join(parentDir, "settings.json"), "utf8");
		} catch {
			parentSettingsRaw = null; // absent/unreadable — degrade to minimal (F1)
		}
		writeFileSync(join(childDir, "settings.json"), JSON.stringify(auditChildCompactionSettings(parentSettingsRaw), null, 2));
		for (const name of ["models.json", "auth.json", "sessions", "themes", "tools", "bin", "prompts"]) {
			const src = join(parentDir, name);
			let st;
			try {
				st = statSync(src);
			} catch {
				continue; // parent lacks it — nothing to share (same as today)
			}
			try {
				symlinkSync(src, join(childDir, name), st.isDirectory() ? "dir" : "file");
			} catch {
				/* already present (label reuse) or race — the child works either way */
			}
		}
		return childDir;
	} catch (err) {
		// F1 fail-open: NEVER block the audit on the D10 plumbing. A fold inside
		// the child would be a D10 regression — the takeover + D9 hatch remain
		// the rescue (measured safe in run-03) until the arm passes.
		console.error(`sam: D10 child agent dir could not be built (${err instanceof Error ? err.message : String(err)}) — the audit child falls back to the shared agent dir (a child fold is possible; the takeover + D9 hatch remain the rescue)`);
		return undefined;
	}
}

// The production runner (the live probe-fork shape: a fresh node process
// on the same cli, stdio pipes, SIGKILL on timeout, hard-capped tails).
const defaultCloseAuditRunner: CloseAuditRunner = {
	run(args, opts) {
		return new Promise((resolve) => {
			let child: ReturnType<typeof spawn>;
			try {
				// D7: the audit child must never be nudged — the verdict is its whole job
				// (spawn inherits process.env by design, closeaudit.ts header; override the dial).
				// D10: opts.env carries the never-fold agent dir when the caller (the
				// audit step) built one — the prepare child gets the default (unchanged).
				child = spawn(process.execPath, args, { env: opts.env ?? childEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
			} catch (err) {
				resolve({ code: null, stdout: "", stderr: String(err instanceof Error ? err.message : err), timedOut: false });
				return;
			}
			let out = "";
			let errText = "";
			child.stdout?.on("data", (d) => {
				out += String(d);
			});
			child.stderr?.on("data", (d) => {
				errText += String(d);
			});
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, opts.timeoutMs);
			const onAbort = () => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			};
			if (opts.signal !== undefined) {
				if (opts.signal.aborted) onAbort();
				else opts.signal.addEventListener("abort", onAbort, { once: true });
			}
			const finish = (payload: { code: number | null; stdout: string; stderr: string }) => {
				clearTimeout(timer);
				if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
				resolve({ ...payload, timedOut });
			};
			child.on("error", (err) => finish({ code: null, stdout: capTail(out, 200_000), stderr: capTail(errText + String(err instanceof Error ? err.message : err), 8_000) }));
			child.on("exit", (c) => finish({ code: c ?? 1, stdout: capTail(out, 200_000), stderr: capTail(errText, 8_000) }));
		});
	},
};

let closeAuditRunner: CloseAuditRunner = defaultCloseAuditRunner;
export function __setCloseAuditRunner(r: CloseAuditRunner | null): void {
	closeAuditRunner = r ?? defaultCloseAuditRunner;
}

/** SAM_PI_CLI fail-safe (v4-plan S1.1): argv[1] first, the env second. */
function resolvePiCli(): string | undefined {
	const argv1 = process.argv[1];
	if (typeof argv1 === "string" && argv1 !== "" && existsSync(argv1)) return argv1;
	const env = process.env["SAM_PI_CLI"];
	if (typeof env === "string" && env.trim() !== "" && existsSync(env.trim())) return env.trim();
	return undefined;
}

/** Refusal text for a v4 close-span resolution error (pre-write refusals). */
function closeSpanRefusalText(error: "close-record-missing" | "no-new-work" | "already-closed"): string {
	if (error === "no-new-work") return CLOSE_UNIT_NO_NEW_WORK_TEXT;
	if (error === "already-closed") return CLOSE_UNIT_ALREADY_CLOSED_TEXT;
	return "close_unit refused — the close record for this unit is not in view (nothing to re-audit here).";
}

interface CloseAuditUnit {
	unitId: number;
	stub: string;
	span: { spanFirstId: string; spanLastId: string; entryIds: string[]; stub: string };
}


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
			// P4 R1 / P5 / 2026-10-05: audit delivery dial. DEFAULT "close" since 2026-10-05
			// (Paul: "followUp is deprecated, it bricks the main session — delivery=close
			// should be the default now"). "followUp" (the P2/P3 in-series behavior) is
			// retained ONLY as an explicit deprecated opt-in. "steer" = in-turn delivery
			// at close (RETAINED TOGGLE — Paul 2026-09-30: keep the code, re-enable if
			// needed; the 2/2 measured turn-hijack profile stays on record); "branch" (P5)
			// = the audit runs on a forked session file at a turn boundary (/sam audit),
			// the verdict is captured from that file, the main line never sees the audit
			// text. Exact-value mapping via the single source of truth
			// (auditDeliveryFromEnv — it is also the FACTORY's registration-time surface
			// resolver, because this mapping runs at session_start, AFTER the factory
			// registers tools); fail-safe: anything else ⇒ the DEFAULT (close).
			state.auditDelivery = auditDeliveryFromEnv(process.env);
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
			if (state.auditDelivery === "followUp") flags.push("audit delivery: followUp (DEPRECATED 2026-10-05 — known: bricks the main session; explicit opt-in; the default is now close)");
			if (state.auditDelivery === "branch") flags.push("audit delivery: branch (P5 side-branch audit; /sam audit <n> prepares the fork, the fork gets the audit prompt, /sam settle <n> <forkFile> settles — main line stays audit-free)");
		if (state.auditDelivery === "close") flags.push("audit delivery: close (DEFAULT since 2026-10-05 — v4 synchronous close-time audit: inside close_unit; N units per turn; no fold at close, the compaction takeover or /sam fold relieves the span)");
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
			state.auditDelivery = auditDeliveryFromEnv(process.env); // the F1 fallback keeps the operator's dial (the single mapping source)
			emit(ctx, `sam: load error (continuing with a clean state): ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	});

	// Cache ledger (port 2): observe assistant usage at message_end.
	// D7 (mid-session nudge — final spec 2026-10-02; design note + pure core:
	// src/nudge.ts, pins: test/nudge.test.ts). ONE ruler: gap = ctx − baseline,
	// baseline = the last successful close (or the post-compaction view).
	// Nudges may only fire once gap ≥ 20k (NUDGE_GAP_TOKENS = pi's measured
	// keepRecent default; NO override, Paul 2026-10-02): the `gap` class asks
	// for an early checkpoint (cheap audit, warm KV), the `band` class is the
	// urgency escalation in the pressure band (watch/action = ≥ W−2R — one
	// full reserve below the native compaction line W−R, governor.ts),
	// allowed even if the earlier nudge did not yield a close (Paul,
	// verbatim, 2026-10-02). One of each per stretch; a close or a
	// settlement-less compaction re-arms both (fresh stretch, baseline
	// re-stamped at the next observed ctx). Measured pi 0.87.1 (this
	// extension's own precedent, index.ts:1205/2276): ONE call covers both
	// states — sendUserMessage + deliverAs "steer" is queued mid-turn,
	// delivered AFTER the current tool calls, BEFORE the next LLM call, and
	// when idle it starts one short turn the model can act on (close, or a
	// brief continue). The nudge is a user message: visible to the LLM AND
	// in the session file (its [sam-nudge] marker is the readout's provenance
	// — self-partition vs. nudge-assisted must stay distinguishable, F1).
	// v3 dials untouched: the gate below is `close`-dial only, the control
	// arms stay byte-stable.
	const nudgeOnMessageEnd = (ctx: ExtensionContext, message: MessageEndEvent["message"]): void => {
		if (!nudgeEnabled(process.env) || state.auditDelivery !== "close") return; // the light off-path (SAM_NUDGE defaults ON — Paul, 2026-10-02; opt-out `SAM_NUDGE=off`)
		recomputeGovernor(ctx); // sam-05 (2026-10-05, measured — Paul's cancelled run): the zone read below came from the STARTUP ladder after a model switch with no intervening settle (band urgency fired at ~16% of a 131k session on a 33k-derived ruler). The signature-diff rule already applied at settle, added at the first consumer that can run without an intervening settle. Idempotent + cheap.
		const usage = ctx.getContextUsage();
		const zone = state.governor.ladder
			? pressureZone(state.governor.ladder, usage?.tokens ?? null, state.governor.zone)
			: "calm";
		if (zone !== state.governor.zone) state.governor.zone = zone; // the governor's own hysteresis fn — per-observation honesty for /sam status
		const now = Date.now();
		const contextTokens = typeof usage?.tokens === "number" ? usage.tokens : null; // F3: null ⇒ gap/band suspend, reasoning stays
		// a fresh stretch after a close / settlement-less compaction: this
		// observation becomes the new baseline (gap 0 here — no fire yet).
		if (state.nudge.pendingBaselineReset) applyBaselineReset(state.nudge, contextTokens);
		const reasoningChars = reasoningCharsOf(
			(message as { content?: readonly { type: string; thinking?: string }[] }).content,
		);
		// Design correction (Paul, 2026-10-02): this message's thinking feeds the
		// ACTIVITY budget — the "reasoning thereafter" side of the `reasoning`
		// nudge. Counted BEFORE the decision so the nudge lands right after the
		// reasoning block (the counter accumulates over the stretch; reset points
		// are close / write-edit / any nudge offer).
		bumpActivity(state.nudge, { thinkingChars: reasoningChars });
		const auditInFlight = state.audit !== null;
		const auditFork = lineIsAuditFork(currentBranch(ctx));
		// D9 (2026-10-02): the hard guard keys to AUDIT-IN-FLIGHT / audit-fork
		// ONLY — a pending settle no longer suppresses (the run-02 incident:
		// the close's turn never settled, `pendingCloses` stayed non-empty, and
		// the old guard sat silent ~36 minutes with NO ledger entry and NO
		// operator line from 88% to the fold). Decision first, guard second —
		// so a WOULD-HAVE-fired decision blocked by a guard leaves a trace
		// (suppressed ledger entry + operator line; F1).
		const d = decideNudge({
			enabled: true, // pre-checked above; re-checked in the pure total
			closeDial: true, // pre-checked above; re-checked in the pure total
			auditInFlight: false, // guarded below with suppression recording
			auditFork: false, // guarded below with suppression recording
			zone,
			st: state.nudge,
			contextTokens,
			gapFloorTokens: NUDGE_GAP_TOKENS,
			// START PHASE (Paul, 2026-10-05): arms the 2× gap floor while the
			// session is pre-fold — the floor itself is gapFloorFor's; no ladder
			// ⇒ base floor (F3). The fold call-site retires the phase.
			actionEnter: state.governor.ladder ? actionEnterOf(state.governor.ladder) : null,
			toolCallFloor: envInt(process.env, "SAM_NUDGE_REASONING_CALLS", DEFAULT_REASONING_CALLS),
			thinkingFloor: envInt(process.env, "SAM_NUDGE_REASONING_CHARS", DEFAULT_REASONING_CHARS),
		});
		if (d.fire && (auditInFlight || auditFork)) {
			// Suppressed (audit decision pending — F8: the nudge stays out of
			// the model's turn either way), but RECORDED: the run-02 gap
			// (no trace at all in a ~36-min in-band window) is the spec input.
			const suppressReason = auditInFlight ? "audit-in-flight" : "audit-fork";
			const gapNow = contextTokens === null ? null : Math.max(0, contextTokens - state.nudge.baselineTokens);
		pi.appendEntry(
			NUDGE_LEDGER_CUSTOM_TYPE,
			nudgeLedgerEntry({
				trigger: d.trigger,
				now,
				zone,
				tokens: contextTokens,
				contextWindow: usage?.contextWindow ?? null,
				gapTokens: gapNow,
				reasoningChars,
				suppressed: true,
				suppressReason,
				suppressDetail: d.why,
			}),
		);
		emit(ctx, `SAM nudge SUPPRESSED (${suppressReason}) — would have fired: ${d.trigger} (${d.why}) — the audit decision is pending`);
		return;
		}
		if (!d.fire) return;
		const trigger = d.trigger;
		const text = nudgeText(trigger, { contextPercent: usage?.percent ?? null }); // both `gap` and `band` carry the current context (Paul, 2026-10-02); `band` adds the imminent-fold warning
		// F1 provenance: the entry rides the ledger custom type the readout knows.
		const gapNow = contextTokens === null ? null : Math.max(0, contextTokens - state.nudge.baselineTokens);
		pi.appendEntry(
			NUDGE_LEDGER_CUSTOM_TYPE,
			nudgeLedgerEntry({
				trigger,
				now,
				zone,
				tokens: contextTokens,
				contextWindow: usage?.contextWindow ?? null,
				gapTokens: gapNow,
				reasoningChars,
			}),
		);
		pi.sendUserMessage(text, { deliverAs: "steer" }); // mid-turn: before the next LLM call; idle: one short turn
		applyNudgeFire(state.nudge, trigger);
		emit(ctx, `SAM nudge (${trigger}): ${d.why} — the model is asked to close the current checkable deliverable (or continue)`);
	};
	/** D11b (goal-clarification nudge — decided 2026-10-03; dev-repo note
	 *  `2026-10-03-v4-goal-clarification-nudge.md`; design note + pure core
	 *  in goal-nudge.ts): the offer delivery. Fires at the FIRST assistant
	 *  `message_end` after an outside user-input event armed the pending
	 *  offer — Paul's timing, verbatim: "after user input and the first agent
	 *  turn … only after the first agent invocation, before the second
	 *  round". Order (decided): gate → hard guards (D9 suppression + trace)
	 *  → fire-time re-check (the goal got stored — moot) → ledger + steer
	 *  delivery. Fail-safe: an offer defect = no offer; the session is
	 *  unaffected (D7 precedent). */
	const attemptGoalOffer = (ctx: ExtensionContext): void => {
		const st = state.goalNudge;
		const pending = st.pending;
		if (!pending) return;
		// the nudge-family gate (shared with D7 — ONE switch for the family;
		// spawn children boot SAM_NUDGE=off via childEnv, so the audit child
		// never sees an offer either)
		if (!nudgeEnabled(process.env) || state.auditDelivery !== "close") {
			st.pending = null; // dial off ⇒ never offered (no deferred offer queued)
			return;
		}
		const auditInFlight = state.audit !== null;
		const auditFork = lineIsAuditFork(currentBranch(ctx));
		if (auditInFlight || auditFork) {
			// suppressed (D9 pattern: a suppressed decision leaves a trace —
			// the run-02 lesson); the event is consumed either way (a later
			// outside input is a NEW event; the model's turn is not blocked).
			const suppressReason = auditInFlight ? "audit-in-flight" : "audit-fork";
			pi.appendEntry(
				NUDGE_LEDGER_CUSTOM_TYPE,
				goalNudgeLedgerEntry({ variant: pending, now: Date.now(), suppressed: true, suppressReason }),
			);
			emit(ctx, `SAM goal nudge SUPPRESSED (${suppressReason}) — would have fired: ${pending} — the audit decision is pending`);
			st.pending = null;
			return;
		}
		if (pending === "sessionstart" && latestGoal(currentBranch(ctx)) !== undefined) {
			// fire-time re-check — the `sessionstart` (setup-ask) variant ONLY
			// (2026-10-04, Paul: the B update-check is UNCONDITIONAL): the goal
			// was stored while the setup offer was pending (an adjust_goal inside
			// the first agent turn) — the setup ask is moot; the goal record is
			// the provenance. The `userinput` offer is dropped by NOTHING — it
			// fires so the model re-checks the goal against the new input (even
			// directly after its own adjust_goal: the user may have refined it).
			st.pending = null;
			return;
		}
		const text = goalNudgeText(pending);
			pi.appendEntry(NUDGE_LEDGER_CUSTOM_TYPE, goalNudgeLedgerEntry({ variant: pending, now: Date.now() }));
		pi.sendUserMessage(text, { deliverAs: "steer" }); // the D7 channel: mid-turn before the next LLM call; idle ⇒ one short turn
		st.pending = null;
		emit(ctx, `SAM goal nudge (${pending}): the model is asked to store/refresh the goal (adjust_goal)`);
	};
	/** v4 (2026-10-04, Paul: "every time on close, until the model at least
	 *  called adjust_goal once"): the close-time goal nudge — a close is a
	 *  settlement moment. Fired directly after an ACCEPTED close_unit call
	 *  (the new-unit and re-audit paths; the `/sam reaudit` operator command
	 *  is not a close_unit call and does not fire it) while NO goal record
	 *  exists on the branch — the file-derived record is the anchor, so once
	 *  the model has stored a goal (a successful adjust_goal) the offer is
	 *  retired for good (resume-proof). Delivery: the D7 channel (steer —
	 *  queued, delivered after the current tool calls, before the next LLM
	 *  call); by design it fires although the close's own audit may still be
	 *  settling (the audit child is offer-free via childEnv). Nudge-family
	 *  gate + the `close` dial only (no new dial); fail-safe: an offer defect
	 *  must never touch the close.
	 */
	/** v5 RETIRE (2026-10-06, Paul): the retirement offer — ONCE per post-fold
	 *  span, at the first close of it, when the rendered settlement stack
	 *  crosses the 40k threshold (or moot below it). The model may call
	 *  retire_units manually ANYTIME — this offer is only the hint (D7 steer
	 *  channel, nudge-family gate, close dial; suppressed with a trace when an
	 *  audit is in flight/on the fork — the D9 pattern). Fail-safe: an offer
	 *  defect never touches the close.
	 */
	const attemptRetireOffer = (ctx: ExtensionContext): void => {
		try {
			const st = state.retireOffer;
			if (!st.foldDone || st.offered) return; // pre-fold, or already consumed this span
			if (!nudgeEnabled(process.env) || state.auditDelivery !== "close") {
				st.offered = true; // dial off ⇒ no offer (cleared, no deferred queue — parity with the goal offer)
				return;
			}
			const branch = currentBranch(ctx);
			const records = branchSettlementRecords(branch);
			const census = retireCensus(records, (r) => settlementBlock(r), state.ledger.retirements);
			const threshold = retireThresholdChars(process.env);
			const decision = retireOfferDecision(st, census, threshold);
			if (decision === "wait") return;
			if (state.audit !== null || lineIsAuditFork(branch)) {
				// suppressed (D9 pattern: a suppressed decision leaves a trace —
				// the arm stays until the next fold re-arms it)
				const suppressReason = state.audit !== null ? "audit-in-flight" : "audit-fork";
				pi.appendEntry(NUDGE_LEDGER_CUSTOM_TYPE, { trigger: "retire", decision: "suppressed", suppressReason, census, now: Date.now() });
				emit(ctx, `SAM retire offer SUPPRESSED (${suppressReason}) — the audit decision is pending`);
				return;
			}
			st.offered = true;
			if (decision === "fire") {
				pi.appendEntry(NUDGE_LEDGER_CUSTOM_TYPE, { trigger: "retire", decision: "fire", census, now: Date.now() });
				pi.sendUserMessage(retireOfferText(census), { deliverAs: "steer" }); // the D7 channel: queued, before the next LLM call
				emit(ctx, `SAM retire offer (FIRE): ${census.records} record(s) / ${census.chars} chars (threshold ${threshold}) at the first post-fold close — the model is asked to retire/upgrade the stale units (or ignore)`);
			} else {
				pi.appendEntry(NUDGE_LEDGER_CUSTOM_TYPE, { trigger: "retire", decision: "moot", census, now: Date.now() });
				emit(ctx, `SAM retire offer MOOT (${census.records} record(s) / ${census.chars} chars < ${threshold}) — nothing to clean up this span (re-arms after the next fold)`);
			}
		} catch (err) {
			console.error(`sam: retire offer failed (the close is unaffected): ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const offerCloseGoalNudge = (ctx: ExtensionContext): void => {
		try {
			if (!nudgeEnabled(process.env) || state.auditDelivery !== "close") return; // the nudge-family gate + close dial (parity with D7/D11b)
			if (latestGoal(currentBranch(ctx)) !== undefined) return; // the anchor exists: a goal has been stored
			pi.appendEntry(NUDGE_LEDGER_CUSTOM_TYPE, goalNudgeLedgerEntry({ variant: "close", now: Date.now() }));
			pi.sendUserMessage(goalNudgeText("close"), { deliverAs: "steer" });
			emit(ctx, "SAM goal nudge (close): no goal has been stored yet (adjust_goal) — the model is asked to store one now");
		} catch (err) {
			console.error(`sam: close-goal nudge failed (the close is unaffected): ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	/** v0.87.1: the message_end event is the per-message observation point */
	pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
		try {
			const message = event.message;
			if (message.role === "toolResult") {
				// D7 + the 2026-10-02 design correction (Paul): toolResults are the
				// ACTIVITY observation point. close = the checkpoint (stretch
				// reset, incl. the activity rulers); a file-mutation (write/edit)
				// is a MATERIALIZATION (the findings reached disk — the checkpoint
				// meter starts over); every other call is research — "a lot of tool
				// calls have passed" (the `reasoning` nudge's call-side ruler).
				const tr = message as { toolName?: string; isError?: boolean };
				const name = tr.toolName ?? "";
				if (name === "close_unit" && tr.isError === false) resetNudgeStretch(state.nudge);
				else if (MATERIALIZING_TOOLS.includes(name)) materializeReset(state.nudge);
				else bumpActivity(state.nudge, { toolCall: true });
				// D11b: a SUCCESSFUL adjust_goal retires the pending SESSIONSTART
				// (setup-ask) offer only (the ask was answered — the goal record it
				// stored is the provenance). The USERINPUT (update-check) offer stays
				// pending and fires at the next assistant message_end (2026-10-04,
				// Paul: unconditional — the user may refine right after the model's
				// own update). A FAILED adjust_goal clears nothing (the model may
				// retry; clearGoalPending is the single exemption site, A-only).
				if (name === "adjust_goal" && tr.isError === false) clearGoalPending(state.goalNudge);
				return;
			}
			if (message.role !== "assistant") return;
			const usage = (message as { usage?: PlainUsage }).usage;
			if (usage && (usage.input || usage.cacheRead || usage.cacheWrite || usage.totalTokens)) {
				state.governor.cacheLedger.observe(usage as PlainUsage, Date.now());
			}
		} catch {
			// F1: observation never affects the session.
		}
		try {
			nudgeOnMessageEnd(ctx, event.message);
		} catch {
			// D7 fail-safe: a nudge defect = no nudge; the observation above stands.
		}
		if (event.message.role === "assistant") {
			try {
				attemptGoalOffer(ctx); // D11b: the first assistant message after the armed outside input
			} catch {
				// D11b fail-safe: an offer defect = no offer; the observation above stands.
			}
		}
	});

	/** D11b: the user-input observation point — the goal offer is ARMED here
	 *  (pi 0.87.1's `input` event; the classification is pure + pinned in
	 *  goal-nudge.ts — Paul 2026-10-03, verbatim: "outside input, mostly from
	 *  users (or an outside agent) are what should trigger the goal nudge.
	 *  tool calls, and automatically generated steers from within the TUI
	 *  session itself should never trigger that.": extension-delivered input
	 *  (our own steers, measured pi source: sendUserMessage ⇒ source
	 *  "extension"), `[sam-`-prefixed text and blank text never arm; tool
	 *  calls never fire the `input` event at all). One pending offer per
	 *  event; consumed by `attemptGoalOffer` or by a successful adjust_goal
	 *  (the toolResult branch above). */
	pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
		try {
			if (!nudgeEnabled(process.env) || state.auditDelivery !== "close") return; // the nudge-family gate (D7's precedent — one switch for the family)
			if (!isGoalUserInput({ text: event.text, source: event.source })) return;
			// variant selection (pure): the session's FIRST outside input with
			// NO stored goal ⇒ the setup ask (A); every other event ⇒ the
			// reminder (B) — including the first input of a session that
			// already carries a stored goal (resumed).
			armGoalOffer(state.goalNudge, { goalStored: latestGoal(currentBranch(ctx)) !== undefined });
		} catch {
			// D11b fail-safe: an arm defect = no offer; the session is unaffected.
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
			// D7: ANY compaction is a stretch boundary. Settlement-less (the
			// native path — no settlement to carry, or extension failure) the
			// loss is real and the nudge clock restarts from the fresh post-
			// compact view; takeover with a settlement is idempotent (the close
			// already re-armed). The baseline re-stamps at the next observed ctx.
			// (resetNudgeStretch also retires the START PHASE — the 2× gap floor is
			// a first-stretch allowance, Paul 2026-10-05 — so post-fold stretches
			// run the classic 1× floor, as the D7 behavior before this change.)
			resetNudgeStretch(state.nudge);
			// (Pre-TUI extension note: the native path now remains only for a truly empty branch or a
			// takeover failure — settlement-less folds are takeover-owned via the unconditional fallback
			// goal; the D7 stretch reset + baseline re-stamp behavior above is unchanged.)
			const prep = event.preparation;
			const branchRaw = event.branchEntries as unknown as RawEntry[];
			// D11 (2026-10-02) + PRE-TUI EXTENSION (Paul's GO 2026-10-02; measured on battery
			// rep 4, bank run-outputs/v4-live-ab-2026-10-02-armF-rep4-*): the takeover gate is
			// STATE-LEVEL — a goal on the branch OR a settlement on the branch, where the goal now
			// includes the UNCONDITIONAL fallback (the goal-defining user input + one agent turn,
			// captured below before the gate decision). Measured gap this closes: battery rep 4
			// folded at 32,984 tokens BEFORE its first close (and before any adjust_goal) — the old
			// gate (goal-record OR settlement) let that span through pi's lossy native summarization
			// (fromHook=false, empty map — banked); the band nudge had fired the same second and the
			// model closed 17 s LATER (a razor timing race — reps 3/5 won it). Because a real user
			// input exists in any live session, the fallback makes the takeover engage on EVERY
			// content-bearing fold: goal at the HEAD (D11), deterministic, zero model calls,
			// tombstone banked. The control arm now remains only for a truly empty branch — or a
			// takeover failure (F1: pi's own summary stands, logged).
			const goalNow = latestGoal(branchRaw);
			const branch = currentBranch(ctx);
			// D9 (2026-10-02): LATEST-PER-UNIT settlement wins (the session
			// journal is append-only; an UPGRADE settlement appends after the
			// weak one and names it in `supersedes`, so "last in branch order"
			// is "current state of the unit"). For one settlement per unit —
			// the v4 default — this is byte-identical to the old single-record
			// path (the control arm's shape is unchanged, F1).
			// v5 RETIRE (2026-10-06): the latest-wins settlement stack, extracted
			// PURE (branchaudit.branchSettlementRecords — the exact identity
			// semantics of the old inline build; the takeover pins are the
			// safety net), so offer census + takeover render the same stack.
			const records: SamSettlementRecord[] = branchSettlementRecords(branch);
			const settlements: Array<Pick<SamSettlementRecord, "unitId" | "retrievalId" | "auditFile" | "replyId">> = records.map((r) => ({
				unitId: r.unitId ?? 0,
				retrievalId: r.retrievalId ?? "",
				auditFile: r.auditFile ?? "",
				replyId: r.replyId ?? null,
			}));
			// D11 (2026-10-02): the goal at the HEAD of the summary (Paul: "the
			// goal gets inserted BEFORE session content after compaction"; latest
			// version replaces earlier ones — the old goal block is stripped from
			// the carried previous summary inside takeoverSummary via its pinned
			// shape, so pi-native prose is never touched).
			let goal = goalNow;
			// D11 FALLBACK (Paul's scope refinement 2026-10-02): capture the goal-defining user
			// input + ONE agent turn (n = 1) verbatim, labelled takeover-derived, and commit it as
			// a goal record (durable, append-only — like the D9 hatch pattern). PRE-TUI EXTENSION
			// (Paul's GO 2026-10-02, measured rep 4): it now acts on EVERY fold without a set goal —
			// the settlement precondition is REMOVED (a fold before the first close used to be
			// settlement-less ⇒ no goal could ride ⇒ lossy native summary; a goal-only takeover
			// carries goal + carried-previous + the retrieval pointer — takeoverSummary already
			// renders the zero-records set). Paul: "having the goal at the head is good in any
			// case — even if it is followed by pi-prose (the model then can see both verbatim first
			// prompt+agent turn, as well as the summarized version)".
			if (goal === undefined) {
				const fb = fallbackGoal(branchRaw, 1, Date.now());
				if (fb !== undefined) {
					try {
						pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, fb.record);
						emit(ctx, `sam: fallback goal captured — adjust_goal was never called after the goal-defining input; the user input + 1 agent turn are committed verbatim and ride every compaction first`);
					} catch (err) {
						// fail-open: the summary below still carries the goal (F1)
						console.error(`sam: fallback goal commit failed (the summary carries it anyway): ${err instanceof Error ? err.message : String(err)}`);
					}
					goal = fb.record;
				}
			}
			if (goal === undefined) return undefined; // nothing preservable (no user input to derive a goal from, no settlement) — the control arm, pi's own path
			// D11.2 (2026-10-02 orphan hatch; GO 2026-10-02, Paul: "no llm call, bare skeleton
			// of calls plus last model text marked as 'orphaned' — the model probably can
			// either just ignore, rederive or check whats done"): conserve the span that leaves
			// the live context WITHOUT a settlement and without a stub (fold span − settled
			// spans − goal capture; the kept raw tail is pi's cut and never lands here) —
			// deterministic, zero model calls; the raw span stays banked in the tombstone
			// below and the record's retrieval id points at it (anchored windows in
			// retrieveContent — "inspect parts of history without loading it fully").
			let orphan: SamOrphanRecord | undefined;
			{
				const excluded = new Set<string>();
				const add = (v: unknown) => {
					if (typeof v === "string" && v !== "") excluded.add(v);
				};
				for (const le of branch) {
					if (le.kind !== "custom" || le.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
					const d = le.data as Record<string, unknown> | undefined;
					if (d?.kind === "goal") {
						add(d.userEntryId);
						if (Array.isArray(d.turnEntryIds)) (d.turnEntryIds as unknown[]).forEach(add);
					} else if (d?.kind === "resolve" && Array.isArray(d.entryIds)) {
						(d.entryIds as unknown[]).forEach(add);
					}
				}
				add(goal.userEntryId);
				if (Array.isArray(goal.turnEntryIds)) (goal.turnEntryIds as unknown[]).forEach(add);
				const zone = computeOrphanZone(branchRaw, excluded);
				if (zone !== null) {
					orphan = orphanRecord(zone, prep.firstKeptEntryId, Date.now());
					try {
						pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, orphan);
					} catch (err) {
						// F1: the summary below still carries the ORPHANED section (the record is a bonus)
						console.error(`sam: orphan record commit failed (the summary carries it anyway): ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
			try {
				const dir = join(ctx.sessionManager.getSessionDir(), "sam-tombstones");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, `tombstone-${prep.firstKeptEntryId}.jsonl`), tombstoneJsonl(branchRaw));
			} catch {
				// F1: the bank copy is a safety net, never a gate.
			}
			// v5 RETIRE (2026-10-06): a fold happened ⇒ the post-fold span starts —
			// re-arm the once-per-span retirement offer (span identity = pi's per-fold
			// cut point; a NEW fold always re-arms, even if the previous span offered).
			retireOfferArmedOnFold(state.retireOffer, String(prep.firstKeptEntryId));
			return {
				compaction: {
					summary: takeoverSummary(
						prep.previousSummary,
						goal,
						records,
						orphan ?? null,
						// v5 RETIRE (2026-10-06): the render consumes the retire entries
						// (dropped → gone; superseded → one line; the superseding unit
						// gains its supersedes line). No retirements ⇒ byte-identical to the
						// pre-retire shape (all existing pins hold).
						state.ledger.retirements,
					),
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore,
					details: takeoverDetails(
						settlements,
						goal !== undefined ? { text: goal.text, basis: goal.basis, ts: goal.ts } : undefined,
						orphan !== undefined ? { retrievalId: orphan.retrievalId, foldId: orphan.foldId, spanFirstId: orphan.spanFirstId, spanLastId: orphan.spanLastId } : undefined,
					),
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

	/**
	 * D9 (2026-10-02, the audit-failure hatch — decided by Paul from the
	 * run-sam-small-units-02 incident): the close NEVER leaves unsettled —
	 * when the audit failed completely (spawn/timeout/handoff/crash, whatever
	 * the reason), the model's summary settles as UNVERIFIED (audit-failed):
	 * the stub + the recorded evidence files survive channel A verbatim
	 * (the close record is the source — nothing re-derived), its claims
	 * carry "verify before acting" (Paul: "the summary of the model is then
	 * to be treated as unverified and claims that have to be verified before
	 * being acted upon. it would still hold the filenames, dates, hashes
	 * and whatever the model summarized"), and the D5 upgrade lever (same-
	 * stub re-close / /sam reaudit) replaces the settlement on success
	 * (latest-per-unit wins at takeover). Idempotent: a settlement already
	 * on the branch (any strength) wins — no double commit. Committed via
	 * pi.appendEntry (crash-safe — the close-record pattern; the session
	 * journal is append-only, so nothing is ever rewritten).
	 */
	function commitWeakAudit(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		unitId: number,
		stub: string,
		reason: CloseAuditDeferReason,
		why: string,
		span?: CloseAuditUnit["span"],
	): void {
		try {
			const branch = currentBranch(ctx);
			if (settledUnitIds(branch).has(unitId)) {
				// Already settled (any strength) — the existing settlement wins.
				emit(ctx, `sam: unit ${unitId} already settled — the audit-failed settlement is NOT double-committed (the existing settlement stands; audit failed: ${reason})`);
				return;
			}
			const rec = closeRecordForUnit(branch, unitId);
			const recData = rec as unknown as { stub?: unknown; evidence?: { files?: unknown } } | undefined;
			const files = recData?.evidence?.files as string[] | undefined;
			const record = weakSettlementRecord(unitId, recData?.stub as string | undefined ?? stub, Array.isArray(files) ? files : [], `audit-failed: ${reason} — ${why}`);
			pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
			// resolve terminal: only when the span is known (a span-unresolved
			// failure settles the content WITHOUT the terminal — the settlement
			// line is what survives the fold; there is no span to resolve).
			if (span !== undefined) {
				const resolveRecord: SamResolveRecord = {
					v: 1, kind: "resolve", unitId, basis: "close-audit",
					spanFirstId: span.spanFirstId, spanLastId: span.spanLastId,
					entryIds: [...span.entryIds], stub: span.stub,
					verdict: "UNVERIFIED-AUDIT-FAILED", gateReasons: [reason], ts: Date.now(),
				};
				pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, resolveRecord);
			}
			const u = state.ledger.units.find((x) => x.unitId === unitId);
			if (u) {
				u.state = "resolved";
				u.resolvedBasis = "close-audit";
				u.verdict = { class: "UNVERIFIED-AUDIT-FAILED" };
			}
			state.pendingCloses = state.pendingCloses.filter((pc) => pc.unitId !== unitId);
			state.governor.guardFacts.push({ unitId, kind: "close-audit", basis: "audit-failed", sinceSettle: state.governor.settleCount });
			state.governor.cacheLedger.noteCommit("close-audit", Date.now());
			emit(ctx, `sam: unit ${unitId} — audit FAILED (${reason}); the settlement committed as UNVERIFIED (audit-failed): the summary survives, its claims are \u201cverify before acting\u201d (upgrade: same-stub close_unit or /sam reaudit ${unitId})`);
		} catch (err) {
			// F1: the hatch must never throw — the close record is already
			// durable; a failed hatch is a loud operator line (the close stays effective).
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`sam: hatch commit failed for unit ${unitId}: ${detail}`);
			emit(ctx, `sam: WARNING — the audit-failed settlement could not be committed for unit ${unitId} (the close record stays the source of record): ${detail}`, "error");
		}
	}

	/**
	 * D9 (2026-10-02, settle-at-verdict — the core decision): the PRIMARY
	 * commit — settlement record + resolve terminal commit AT VERDICT,
	 * inside the close pipeline (pi.appendEntry — the close-record
	 * crash-safe pattern), NOT at the close turn's settle boundary. The
	 * run-02 incident is the spec input: close committed + audit complete +
	 * settle pending (the close's turn never ended) → the native fold
	 * preempted the settle and folded the span lossy. Supersedes the v3-era
	 * "s5 lesson" (this file, ~:762) + the P2 same-settle rule (~:769) for
	 * the `close` dial (cited per house rule; the v3 in-series audit keeps
	 * its settle-boundary path — it is a different mechanism).
	 * The agent_before_settle drain (step 2.5) stays as the idempotent
	 * backstop for items still staged (a verdict-commit failure / pre-D9
	 * in-flight state). Guard: a STRONG settlement already on the branch
	 * wins (done); a WEAK settlement (D8 light / D9 hatch) is an UPGRADE
	 * target — the new record appends with `supersedes` (append-only
	 * journal; latest-per-unit wins at takeover).
	 */
	function commitCloseAuditItem(pi: ExtensionAPI, ctx: ExtensionContext, item: CloseAuditStagedItem): boolean {
		const branch = currentBranch(ctx);
		const already = settledUnitIds(branch);
		// Anomaly fix (b) (2026-10-02, final-manifest candidates a/b/c — the
		// run-03 [201]–[204] re-settle wave): WEAK item (NOT-YET-VERIFIED) never
		// commits over an existing settlement (never weak-over-weak, especially
		// not supersedes === own id); a weak settlement stays upgradable by a
		// STRONG audit only. Same guard as the settle drain.
		if (already.has(item.unitId) && (lastSettlementStrengthFor(branch, item.unitId) !== "WEAK" || item.verdict === "NOT-YET-VERIFIED")) {
			console.error(`sam: close-audit unit ${item.unitId} already settled on the branch (strong-idempotence / weak-over-weak skip — the staged capture is dropped, the fork file stays banked)`);
			return false;
		}
		const unit = state.ledger.units.find((u) => u.unitId === item.unitId);
		if (unit === undefined) {
			console.error(`sam: close-audit settle refused — unknown unit ${item.unitId} (the fork file stays banked for /sam retrieve)`);
			return false;
		}
		// Proof revalidation (staged at close time): the span must be intact
		// (append-only growth beyond it is fine). A failure keeps the item
		// STAGED for the settle-boundary backstop — fail open.
		const proof = state.spanProofs.get(item.unitId);
		if (proof !== undefined) {
			const rv = revalidateSpan(proof, branch);
			if (rv.ok === false) {
				console.error(`sam: close-audit unit ${item.unitId} span drifted since close — settlement not committed now (the staged item stays for the settle-boundary backstop; the raw span stays in view)`);
				return false;
			}
		}
		const record = buildSettlementRecord(item.unitId, item.auditFile, item.replyId, item.replyText, item.stagedAt, item.span.stub);
		if (record === undefined) {
			console.error(`sam: close-audit unit ${item.unitId} settlement record could not be built (the staged item stays for the backstop)`);
			return false;
		}
		// D9 upgrade path: name the weak settlement this strong one replaces.
		if (lastSettlementStrengthFor(branch, item.unitId) === "WEAK") {
			let prev: string | undefined;
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
				const d = e.data as { kind?: unknown; unitId?: unknown; retrievalId?: unknown } | undefined;
				if (d?.kind === "settlement" && d.unitId === item.unitId && typeof d.retrievalId === "string") {
					prev = d.retrievalId;
					break;
				}
			}
			record.supersedes = prev;
		}
		pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
		const resolveRecord: SamResolveRecord = {
			v: 1, kind: "resolve", unitId: item.unitId, basis: "close-audit",
			spanFirstId: item.span.spanFirstId, spanLastId: item.span.spanLastId,
			entryIds: [...item.span.entryIds], stub: item.span.stub,
			verdict: item.verdict, corrections: item.corrections,
			gateReasons: [], ts: Date.now(),
		};
		pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, resolveRecord);
		unit.state = "resolved";
		unit.resolvedBasis = "close-audit";
		unit.verdict = { class: item.verdict, corrections: item.corrections };
		unit.corrections = item.corrections;
		state.governor.guardFacts.push({ unitId: item.unitId, kind: "close-audit", basis: item.verdict, sinceSettle: state.governor.settleCount });
		state.governor.cacheLedger.noteCommit("close-audit", Date.now());
		state.pendingCloses = state.pendingCloses.filter((pc) => pc.unitId !== item.unitId);
		return true;
	}

	/**
	 * The v4 synchronous audit (v4-plan §3 steps 4–7, in order — the order IS
	 * the crash-safety design): (4) prepare child (the v3 model-free
	 * `/sam audit <n>` in a fresh MAIN-session process — it forks there, the
	 * rebind contained) → (5) audit child (one model turn on the FORK, hard
	 * timeout; depth per D8: full below the band, LIGHT at/above) → (6)
	 * validate from the FORK FILE (pure, file-based) → (7) stage (multi-slot
	 * FIFO; the drain backstop) → (7.5) D9: SETTLE AT VERDICT (settlement +
	 * resolve commit NOW) or the D9 HATCH on any failure (UNVERIFIED
	 * (audit-failed) settlement NOW — the close never leaves unsettled,
	 * D5 upgrade lever intact). F1: every failure keeps the committed close
	 * and a full content trail (close record + settlement/hatch line).
	 */
	async function runCloseAuditPipeline(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		unit: CloseAuditUnit,
		decision: { ctxTokens: number | null; zone: string; depth: "full" | "light" },
	): Promise<{ ok: boolean; line: CloseAuditLine }> {
		// D9: every failure path commits the hatch settlement on the way out
		// (the one-liner below stays the model-facing truth).
		const defer = (reason: CloseAuditDeferReason, why: string): { ok: boolean; line: CloseAuditLine } => {
			commitWeakAudit(pi, ctx, unit.unitId, unit.stub, reason, why, unit.span);
			return {
				ok: false,
				line: { unitId: unit.unitId, form: "unverifiedAuditFailed", reason, why, stubLines: stubLineCount(unit.stub) },
			};
		};
		const mainFile = ctx.sessionManager.getSessionFile?.();
		if (typeof mainFile !== "string" || mainFile === "") {
			return defer("prepare-spawn-failed", "no session file visible — nothing forked");
		}
		const cli = resolvePiCli();
		if (cli === undefined) {
			return defer("prepare-spawn-failed", "the pi cli path is not resolvable (argv[1] + SAM_PI_CLI fail-safe) — nothing forked");
		}
		const baseArgs = process.argv.slice(2);

		// (4) prepare child — model-free; emits the handoff on stdout.
		let prep: Awaited<ReturnType<typeof closeAuditRunner.run>>;
		try {
			prep = await closeAuditRunner.run(prepareChildArgs(cli, baseArgs, mainFile, unit.unitId), {
				timeoutMs: PREPARE_CHILD_DEFAULT_TIMEOUT_MS,
				label: `close-audit-prepare-u${unit.unitId}`,
				signal,
			});
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`sam: close-audit unit ${unit.unitId} prepare child crashed: ${detail}`);
			return defer("prepare-spawn-failed", `the prepare child crashed (${detail})`);
		}
		if (prep.timedOut) return defer("prepare-exit-failed", "the prepare child timed out");
		if (prep.code !== 0) {
			return defer("prepare-exit-failed", `the prepare child exited ${prep.code} (log tail: ${capTail(prep.stderr, 160).replace(/\s+/g, " ") || "no stderr"})`);
		}
		const handoff = parsePrepareHandoff(prep.stdout + "\n" + prep.stderr);
		if (handoff === undefined || handoff.unitId !== unit.unitId) {
			return defer("handoff-missing", `the prepare child produced no parseable handoff for this unit (child output tail: ${capTail(prep.stdout + "\n" + prep.stderr, 240).replace(/\s+/g, " ") || "empty"})`);
		}
		if (signal?.aborted) return defer("audit-aborted", "the session was interrupted during prepare");

		// (5) audit child — ONE model turn on the fork (the rep-1 mechanism).
		// D8 (2026-10-02): depth by dial + zone — auto = LIGHT at/above the
		// band (≥ W−2R, the "last 16k" R-reserve borrow; the child is
		// disposable: one turn, zero tool calls, used no further after
		// the audit), FULL below. The instruction differs per rung.
		// Everything from here is the AUDIT STEP: a crash there is reported as
		// audit-spawn-failed, never as a prepare failure (honesty — F1).
		try {
			// FRESH-ZONE AT CLOSE TIME (2026-10-02, Paul: "the inheritance should
			// be avoided — after a fold context SHOULD be safe" ⇒ ruling (b)): the
			// dispatch runs mid-turn (after a mid-turn fold, before the next
			// observation), so the governor's sticky state could still hold the
			// PRE-FOLD watch/action zone (measured 3×: rep-3 u2 @4,297 tok, rep-4
			// u1, rep-7 u4 — each dispatched LIGHT into a post-fold CALM close) —
			// depth is decided on the LIVE close-time ctx, same ladder, entry
			// thresholds only; unavailable ⇒ strict (FULL).
			// 2026-10-03 decision-in-ledger (Paul: "use the totalTokens formula in
			// both places; let us also transfer the decision into the ledger"): the
			// decision (zone + exact tokens + depth) is derived ONCE by the caller
			// (closeAuditDecision), recorded on the close record at the fresh-close
			// site, and handed here — the extension dispatches exactly what it
			// recorded, so the battery can grade from the ledger and the two agree
			// by construction (the F-14 u1 divergence was a second, narrower
			// re-derivation — input+cacheRead only — grading against a LIVE-ruler
			// decision; the 1,359-token output term of the close turn was the whole
			// 92-token straddle of the 32,768 line).
		const instruction = decision.depth === "light"
			? lightAuditInstruction(unit.unitId, auditPayload(unit.unitId))
			: branchAuditInstruction(unit.unitId, auditPayload(unit.unitId));
		const timeoutMs = auditTimeoutMs(process.env);
		// D10 (2026-10-02): the audit child must NEVER fold — it is spawned
		// with its own agent dir (compaction.enabled=false forced; everything
		// else shared by symlink — see buildAuditChildAgentDir). The prepare
		// child above is deliberately UNCHANGED (model-free — no assistant
		// turn, control). Fail-open: if the child dir cannot be built the
		// audit runs with the shared dir (logged; the takeover + D9 hatch
		// remain the rescue — measured safe in run-03).
		let d10ChildDir: string | undefined;
		try {
			d10ChildDir = buildAuditChildAgentDir(ctx.sessionManager.getSessionDir(), `u${unit.unitId}-${Date.now()}`);
		} catch {
			d10ChildDir = undefined;
		}
		const d10Env: Record<string, string | undefined> = childEnv(process.env);
		if (d10ChildDir !== undefined) d10Env[D10_AGENT_DIR_ENV] = d10ChildDir;
		const audit = await closeAuditRunner.run(auditChildArgs(cli, baseArgs, handoff.forkFile, instruction), {
			timeoutMs,
			label: `close-audit-u${unit.unitId}`,
			signal,
			env: d10Env,
		});
		// D10: the child agent dir is throwaway — removed once the child has
		// exited (best-effort; the audit evidence is the FORK file in the
		// shared session dir, not this dir).
		if (d10ChildDir !== undefined) {
			try {
				rmSync(d10ChildDir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
		if (signal?.aborted) return defer("audit-aborted", "the session was interrupted during the audit");
		if (audit.timedOut) {
			return defer("audit-timeout", `the audit child outlived its ${timeoutMs} ms budget (SAM_AUDIT_TIMEOUT_MS)`);
		}
		if (audit.code !== 0) {
			return defer("audit-exit-failed", `the audit child exited ${audit.code} (log tail: ${capTail(audit.stderr, 160).replace(/\s+/g, " ") || "no stderr"})`);
		}

		// (6) validate from the FORK FILE (pure, file-based — v4-plan §2.3).
		const raw = readRawSessionFile(handoff.forkFile);
		const turn = findLastAuditTurn(raw);
		if (turn === undefined || turn.unitId !== unit.unitId || turn.replyId === undefined || turn.replyText.trim() === "") {
			// 2026-10-04 (F-12 class, banked rep-12 u4 ×2): the missing reply is
			// CLASSIFIED by the child's own last turn (measured in the fork file
			// — the child exited 0 above, so this is not a spawn/pipe shape):
			// a thinking-only turn cut at stopReason "length" is the per-request
			// output budget running out (F-12: output: 1, thinking "Now" / "F") —
			// a budget limit, NOT a transport/pipe defect. The class rides the
			// one-liner AND the settlement REASON (the operator + battery read
			// WHY the audit failed; wording = pins, the F-12 pins below).
			const cls = missingAuditReplyClass(turn?.lastAssistantStopReason);
			if (cls === "audit-reply-truncated(length)") {
				return defer(cls, "the audit child's last turn ended stopReason=length with no reply text — the per-request output budget ran out on a thinking-only turn (a budget limit, not a transport/pipe defect)");
			}
			return defer("reply-missing", "the fork file carries no clean audit reply for this unit (nothing settled)");
		}
		const parse = parseBranchAuditReply(turn.replyText);
			// D8: the accepted line-1 contract is depth-bound (pinned): FULL =
			// VERIFIED / CORRECTIONS only (a NOT-YET-VERIFIED reply there is a
			// contract violation ⇒ UNAUDITABLE ⇒ the D9 hatch); LIGHT accepts
			// NOT-YET-VERIFIED (its own contract) — VERIFIED / CORRECTIONS
			// still accepted when the auditor over-achieved.
			const vc = parse.verdict.class;
			const accepted = decision.depth === "light"
				? vc === "VERIFIED" || vc === "CORRECTIONS" || vc === "NOT-YET-VERIFIED"
				: vc === "VERIFIED" || vc === "CORRECTIONS";
			if (!accepted) {
				return defer("reply-unparseable", `line 1 of the audit reply is not the ${decision.depth}-depth verdict contract (${decision.depth === "light" ? "NOT-YET-VERIFIED / VERIFIED / CORRECTIONS" : "VERIFIED / CORRECTIONS"})`);
			}
		const record = buildSettlementRecord(unit.unitId, handoff.forkFile, turn.replyId, turn.replyText);
		if (record === undefined) return defer("reply-unparseable", "the settlement record could not be built (no reply id)");

		// (7) stage (multi-slot FIFO; a re-audit REPLACES this unit's item).
		const item: CloseAuditStagedItem = {
			unitId: unit.unitId,
			span: { spanFirstId: unit.span.spanFirstId, spanLastId: unit.span.spanLastId, entryIds: [...unit.span.entryIds], stub: unit.span.stub },
			auditFile: handoff.forkFile,
			replyId: turn.replyId,
			replyText: turn.replyText,
			// D11 batch (2026-10-02) — verdict-honesty fix (D8 residual, MEASURED
			// in the run-03 bank: the two NOT-YET-VERIFIED audits' resolve
			// terminals were recorded "VERIFIED" — the v3-era coercion): a light
			// audit STAYS NOT-YET-VERIFIED in the staged item (and thus in the
			// resolve terminal + the ledger unit). Note: the ledger validator
			// (ledger.ts) now accepts the full LedgerVerdictClass — fixed in the
			// same batch (it rejected these verdicts on rebuild).
			verdict: record.verdict === "NOT-YET-VERIFIED" ? "NOT-YET-VERIFIED" : record.verdict === "CORRECTIONS" ? "CORRECTIONS" : "VERIFIED",
			corrections: parse.verdict.class === "CORRECTIONS" ? parse.verdict.corrections : undefined,
			parsedClean: parse.parsedClean,
			retrievalId: record.retrievalId,
			stagedAt: Date.now(),
		};
		const idx = state.closeAuditStaged.findIndex((x) => x.unitId === unit.unitId);
		if (idx !== -1) state.closeAuditStaged[idx] = item;
		else state.closeAuditStaged.push(item);

		// (7.5) D9 (2026-10-02): SETTLE AT VERDICT — the settlement + resolve
		// commit NOW (the close never leaves unsettled; the run-02 incident:
		// a settle-boundary commit let the native fold preempt the settle and
		// fold the span lossy). A failure here (span drift / unknown unit / idempotence)
		// keeps the item STAGED for the settle-boundary backstop — the one-
		// line result below still reports the audit outcome (F1).
		const committed = commitCloseAuditItem(pi, ctx, item);
		if (!committed) {
			emit(ctx, `sam: unit ${unit.unitId} — verdict-commit did not land (guard / span-drift / idempotence); the staged item stays for the settle-boundary backstop — the close is effective either way`, "error");
		} else {
			// Anomaly fix (a) (2026-10-02, final-manifest candidate a): dequeue
			// the committed unit's staged item on SUCCESS — the run-03 [201]–
			// [204] re-settle wave was exactly this missing step (the D9
			// verdict-commit never dequeued; the drain re-committed the weak
			// items at the first model-idle boundary after both verdicts).
			state.closeAuditStaged = state.closeAuditStaged.filter((x) => x.unitId !== item.unitId);
		}

		const line: CloseAuditLine =
			parse.verdict.class === "VERIFIED"
				? { unitId: unit.unitId, form: "verified", retrievalId: record.retrievalId, stubLines: stubLineCount(unit.stub) }
				: parse.verdict.class === "CORRECTIONS"
					? { unitId: unit.unitId, form: "corrections", corrections: parse.verdict.corrections ?? "", retrievalId: record.retrievalId, stubLines: stubLineCount(unit.stub) }
					: { unitId: unit.unitId, form: "notYetVerified", note: record.sections["NOT-YET-VERIFIED"] ?? "", retrievalId: record.retrievalId, stubLines: stubLineCount(unit.stub) };
		return { ok: true, line };
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`sam: close-audit unit ${unit.unitId} audit step crashed: ${detail}`);
			return defer("audit-spawn-failed", `the audit step crashed (${detail})`);
		}
	}

	/** v4 (2026-10-01, the D1 operator lever) — factory-scoped on purpose: it calls
	 * runCloseAuditPipeline (a factory closure function), so it must live inside the
	 * factory. `/sam reaudit <n>`: re-run the close's own audit (the v4 CHILD
	 * pipeline) for a CLOSED-BUT-UNSETTLED unit, reading the unit's own COMMITTED
	 * close record (stub + span — no model in the loop, no stub-identity hazard).
	 * Success: settlement + resolve terminal (basis close-audit) commit at the ack
	 * turn's settle boundary (the measured v3e command→ack→boundary pattern); no fold
	 * at close. Deferral: the unit stays re-auditable; reason + child output tail is
	 * emitted. F1: the close is already effective — this command can only add the audit. */
	async function reauditCloseHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, unitArg: string | undefined): Promise<void> {
		if (!ctx.isIdle()) {
		emit(ctx, "sam: wait for the current response to finish before re-auditing (the re-audit runs synchronously in this command)", "error");
		return;
	}
	const unitId = unitArg !== undefined && unitArg.trim() !== "" ? parseInt(unitArg, 10) : NaN;
	if (Number.isNaN(unitId) || unitId < 1) {
		emit(ctx, "sam: usage — /sam reaudit <unit-id> (a closed, unsettled unit — the audit of that unit re-runs now, synchronously, on child sessions)", "error");
		return;
	}
	const branch = currentBranch(ctx);
	const rec = closeRecordForUnit(branch, unitId);
	if (rec === undefined) {
		emit(ctx, `sam: unit ${unitId} has no close record in view — nothing to re-audit`, "error");
		return;
	}
	if (settledUnitIds(branch).has(unitId)) {
		const strength = lastSettlementStrengthFor(branch, unitId);
		if (strength !== "WEAK") {
			emit(ctx, `sam: unit ${unitId} is already settled (${strength === "STRONG" ? "VERIFIED / CORRECTIONS" : "final"}) — /sam reaudit has nothing to do (the original content is retrievable via /sam retrieve)`, "error");
			return;
		}
		// D9: a WEAK settlement (NOT-YET-VERIFIED light / UNVERIFIED audit-
		// failed) is an UPGRADE target — the re-audit replaces it on success
		// (latest-per-unit wins at takeover).
		emit(ctx, `sam: unit ${unitId} is currently settled with a non-verifying status (light / audit-failed) — the re-audit runs now; a full verdict will supersede it`);
	}
	const folded = foldedEntryIdSet(state.ledger, branch);
	const ra = resolveCloseUnitSpan(branch, { unitId: rec.unitId, stub: rec.stub, toolCallId: rec.toolCallId, closeRecordIndex: rec.index }, folded);
	if (!ra.ok) {
		emit(ctx, `sam: re-audit of unit ${unitId} refused — span: ${ra.error} (the close stays effective)`, "error");
		return;
	}
	// Re-audit path: the close record already exists (banks immutable — its
	// decision fields stay as recorded at fresh close); the decision for THIS
	// attempt is re-derived with the same closeAuditDecision (one ruler on all
	// paths — 2026-10-03 decision-in-ledger) and handed to the pipeline.
	recomputeGovernor(ctx); // sam-05 (2026-10-05): model-fresh ladder for the depth decision (switch without an intervening settle ⇒ the STARTUP ruler would mis-zone ⇒ mis-depth: action⇒light vs the true calm⇒full)
	const decision = closeAuditDecision(state.governor.ladder, ctx);
	const result = await runCloseAuditPipeline(pi, ctx, new AbortController().signal, { unitId: rec.unitId, stub: rec.stub, span: ra.span }, decision);
	if (!result.ok) {
		emit(ctx, closeAuditResultLine(result.line), "error");
		return;
	}
	// D9 (2026-10-02): the settlement + resolve committed AT VERDICT — no ack
	// turn needed (the v3e ack→settle pattern is superseded for the close
	// dial; the settle boundary remains the idempotent backstop). Nothing is
	// folded at close, and the original stays retrievable.
	emit(ctx, `sam: unit ${unitId} re-audited — settlement + resolve terminal (basis close-audit) committed at verdict; nothing is folded at close, and the original stays retrievable`);
}

	// v4 (S6): the tool surface is dial-aware — the `close` dial gets the v4
	// copy (N units per turn, synchronous side-session audit, no fold at
	// close); the v3 dials keep the byte-stable original (the control arm).
	const CLOSE_UNIT_TOOL_ACTIVE = process.env["SAM_AUDIT_DELIVERY"] === "close" ? CLOSE_UNIT_TOOL_V4 : CLOSE_UNIT_TOOL;
	const CLOSE_UNIT_PARAMS = {
		type: "object",
		properties: {
			stub: { type: "string", description: CLOSE_UNIT_TOOL_ACTIVE.parametersDescription },
		},
		required: ["stub"],
	} as const;

	pi.registerTool({
		name: CLOSE_UNIT_TOOL_ACTIVE.name,
		label: CLOSE_UNIT_TOOL_ACTIVE.label,
		description: CLOSE_UNIT_TOOL_ACTIVE.description,
		promptSnippet: CLOSE_UNIT_TOOL_ACTIVE.promptSnippet,
		promptGuidelines: [...CLOSE_UNIT_TOOL_ACTIVE.promptGuidelines],
		// v4: close_unit must never run concurrently (the audit pipeline is
		// single-flight by design — F7; pi 0.87.1 `executionMode`,
		// extensions/types.ts:483 + agent-loop.ts:514–516, source-read).
		executionMode: "sequential",
		parameters: CLOSE_UNIT_PARAMS,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			try {
				const branch = currentBranch(ctx);
				const folded = foldedEntryIdSet(state.ledger, branch);
				// v4 ("close" dial): this session must not ITSELF be the audited
				// side branch (the rogue-auditor guard, v4-plan §3 step 1). A
				// working main line never carries a [sam-audit] instruction
				// (the v3 main-line invariant), so this cannot false-fire there.
				if (state.auditDelivery === "close" && lineIsAuditFork(branch)) {
					return {
						content: [{ type: "text", text: CLOSE_UNIT_AUDIT_FORK_TEXT }],
						details: { unitId: null, rejected: "audit-fork" },
					};
				}
				if (lastRealUserEntryIsFolded(branch, folded)) {
					return {
						content: [{ type: "text", text: CLOSE_UNIT_ALREADY_CLOSED_TEXT }],
						details: { unitId: null, rejected: "already-closed" },
					};
				}
				// v3 dials keep the one-close-per-turn refusal byte-stable; the
				// v4 "close" dial lifts it (N units per turn) — a re-close is
				// then either a re-audit (D5 discriminator below) or a new unit
				// gated by no-work-since-previous-close.
				if (state.auditDelivery !== "close" && state.pendingCloses.length > 0) {
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
				// 2026-10-05 (Paul: live status on the tool line, "close_unit -
				// auditing the summary" while the audit runs): the pi-native live
				// channel — execute(..., onUpdate, ...) (pi 0.87.1 types.ts:490;
				// bash.ts streams exactly this way; the harness delivers
				// tool_execution_update). The audit stage is the long pole (up to
				// the 480 s budget) — name it in-flight, with the stub size Paul
				// also asked for ("how many lines are written to close_unit").
				onUpdate?.({
					content: [{ type: "text", text: `auditing the summary… (stub: ${params.stub.split("\n").length} lines)` }],
					details: undefined,
				});

				// v4 ("close" dial), BEFORE anything is written: the D5 re-audit
				// discriminator (last close unsettled + same stub ⇒ re-audit the
				// SAME unit — no new unit, no new close record) and the
				// no-work-since-previous-close guard (the refusal that replaces
				// CLOSE_UNIT_PENDING_TEXT on this dial).
				if (state.auditDelivery === "close") {
					const lastClose = lastCloseRecord(branch);
					if (lastClose !== undefined) {
						const lastSettled = settledUnitIds(branch).has(lastClose.unitId);
						// D9: a WEAK settlement (light / audit-failed) keeps the
						// D5 upgrade path open (same-stub re-close ⇒ re-audit);
						// a STRONG one is final (new-unit guard as before).
						const lastStrength = lastSettled ? lastSettlementStrengthFor(branch, lastClose.unitId) : undefined;
						if (
							classifyReClose(
								{ lastCloseUnitId: lastClose.unitId, lastCloseStub: lastClose.stub, lastCloseSettled: lastSettled, lastSettlementStrength: lastStrength, nextUnitId: state.ledger.nextUnitId },
								params.stub,
							) === "re-audit"
						) {
							// Re-audit the existing unit: re-run the pipeline for it.
							const ra = resolveCloseUnitSpan(branch, { unitId: lastClose.unitId, stub: lastClose.stub, toolCallId: lastClose.toolCallId, closeRecordIndex: lastClose.index }, folded);
							if (!ra.ok) {
								return { content: [{ type: "text", text: closeSpanRefusalText(ra.error) }], details: { unitId: lastClose.unitId, reAudit: true, rejected: ra.error } };
							}
							offerCloseGoalNudge(ctx); // v4 (2026-10-04): a re-audit close is also a close (Paul: every time on close, until adjust_goal)
							attemptRetireOffer(ctx); // v5 RETIRE (2026-10-06): the first close of the post-fold span is the offer moment (fail-safe — never touches the close)
							let raResult;
							try {
								recomputeGovernor(ctx); // sam-05 (2026-10-05): model-fresh ladder for the depth decision (as above)
								const decision = closeAuditDecision(state.governor.ladder, ctx);
								raResult = await runCloseAuditPipeline(pi, ctx, signal, { unitId: lastClose.unitId, stub: lastClose.stub, span: ra.span }, decision);
							} catch (err) {
								console.error(`sam: close-audit unit ${lastClose.unitId} pipeline crashed — the close stays committed: ${err instanceof Error ? err.message : String(err)}`);
								// D9: the pipeline's own catch should have committed the
								// hatch; if it escaped, commit it here (idempotent — a
								// settlement already on the branch wins).
								commitWeakAudit(pi, ctx, lastClose.unitId, lastClose.stub, "pipeline-crashed", "the audit pipeline crashed", ra.span);
								raResult = { ok: false, line: { unitId: lastClose.unitId, form: "unverifiedAuditFailed" as const, reason: "pipeline-crashed" as const, why: "the audit pipeline crashed", stubLines: stubLineCount(lastClose.stub) } };
							}
							return { content: [{ type: "text", text: closeAuditResultLine(raResult.line) }], details: { unitId: lastClose.unitId, reAudit: true, closed: true, audit: raResult.ok ? "settled" : "unverifiedAuditFailed" } };
						}
						const guard = closeCandidateSpanOk(branch, lastClose.index, toolCallId, folded);
						if (guard === "no-new-work") {
							return { content: [{ type: "text", text: CLOSE_UNIT_NO_NEW_WORK_TEXT }], details: { unitId: null, rejected: "no-new-work" } };
						}
						if (guard === "already-closed") {
							return { content: [{ type: "text", text: CLOSE_UNIT_ALREADY_CLOSED_TEXT }], details: { unitId: null, rejected: "already-closed" } };
						}
					}
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
				// D8 decision (2026-10-03 decision-in-ledger): derived ONCE from
				// the LIVE close-time context (ruler = pi's calculateContextTokens
				// — totalTokens || input+output+cacheRead+cacheWrite — the same
				// metric pi's own compaction trigger decides with), recorded on the
				// close record, and handed to the pipeline below: the extension
				// dispatches exactly what the ledger shows.
				recomputeGovernor(ctx); // sam-05 (2026-10-05): model-fresh ladder for the depth decision (as above)
				const decision = closeAuditDecision(state.governor.ladder, ctx);
				const record: SamCloseRecord = {
					v: 1,
					kind: "close",
					unitId,
					stub: params.stub,
					toolCallId,
					ts: Date.now(),
					mode: state.mode,
					depth: decision.depth,
					depthZone: decision.zone,
					ctxTokens: decision.ctxTokens,
					depthRuler: "pi calculateContextTokens (totalTokens || input+output+cacheRead+cacheWrite) @ pinned pi 0.87.1 — same metric as pi's compaction trigger; source: ctx.getContextUsage().tokens at close time",
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
				offerCloseGoalNudge(ctx); // v4 (2026-10-04): the close-time goal nudge (every accepted close until a goal exists)
				attemptRetireOffer(ctx); // v5 RETIRE (2026-10-06): the first close of the post-fold span is the offer moment (fail-safe — never touches the close)
				// v4 ("close" dial): the audit runs NOW, synchronously (the
				// session waits like any slow tool — pi 0.87.1 has no tool
				// timeout, source-read §2.1). The close record is already
				// file-durable (a crash leaves "close committed + audit
				// pending" — the model's same-stub re-close re-audits it, D5).
				if (state.auditDelivery === "close") {
					const branchNow = currentBranch(ctx);
					const thisClose = lastCloseRecord(branchNow);
					const thisSpan =
						thisClose !== undefined && thisClose.unitId === unitId
							? resolveCloseUnitSpan(branchNow, { unitId, stub: params.stub, toolCallId, closeRecordIndex: thisClose.index }, folded)
							: { ok: false as const, error: "close-record-missing" as const };
					if (!thisSpan.ok) {
						// D9: the close never leaves unsettled — span-unresolved
						// commits the UNVERIFIED (audit-failed) settlement (the
						// content survives; the resolve terminal is absent — there
						// is no span to resolve).
						console.error(`sam: close-audit unit ${unitId} span unresolved (${thisSpan.error}) — the close stays committed; the audit-fail settlement commits`);
						commitWeakAudit(pi, ctx, unitId, params.stub, "span-unresolved", thisSpan.error);
						return {
							content: [{ type: "text", text: closeAuditResultLine({ unitId, form: "unverifiedAuditFailed", reason: "span-unresolved", why: thisSpan.error, stubLines: stubLineCount(params.stub) }) }],
							details: { unitId, closed: true, audit: "unverifiedAuditFailed" },
						};
					}
					stageSpanProof(state, unitId, thisSpan.span, branchNow);
					let result;
					try {
						result = await runCloseAuditPipeline(pi, ctx, signal, { unitId, stub: params.stub, span: thisSpan.span }, decision);
					} catch (err) {
						// F1 honesty: the close was committed BEFORE the audit —
						// say so (a mid-pipeline crash must never read as
						// "nothing recorded"). D9: the hatch commit is idempotent
						// — if the pipeline's own catch already committed it, this
						// is a no-op (a settlement already on the branch wins).
						console.error(`sam: close-audit unit ${unitId} pipeline crashed — the close stays committed: ${err instanceof Error ? err.message : String(err)}`);
						commitWeakAudit(pi, ctx, unitId, params.stub, "pipeline-crashed", "the audit pipeline crashed", thisSpan.span);
						result = { ok: false, line: { unitId, form: "unverifiedAuditFailed" as const, reason: "pipeline-crashed" as const, why: "the audit pipeline crashed", stubLines: stubLineCount(params.stub) } };
					}
					return {
						content: [{ type: "text", text: closeAuditResultLine(result.line) }],
						details: { unitId, closed: true, audit: result.ok ? "settled" : "unverifiedAuditFailed" },
					};
				}

				// P4 R1 (plan carry #7): steering delivery — while the loop is
				// running this injects the audit into THIS turn (pi 0.87.1
				// `deliverAs: "steer"` — delivered "after the current tool calls,
				// before the next LLM call", verified in agent-session.js): the
				// verdict lands on the still-warm prefix and the close settles the
				// moment the turn ends. (This is STEER — the retained toggle, Paul
				// 2026-09-30; the DEFAULT is close since 2026-10-05.)
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

	// D11 (2026-10-02): the goal tools — the stored goal (mutable, latest-
	// wins) + its verbatim retrieval. Close-dial surface (the v3 control arms
	// keep their tool set byte-stable) — resolved from the ENV at registration
	// time (auditDeliveryFromEnv): this registration runs BEFORE
	// session_start maps the env onto state, so `state.auditDelivery` here is
	// still the module default, not the operator's dial (the rep-3 trace:
	// the goal offer fired with the goal tools ABSENT on the followUp-default
	// 2-tool surface). Soft expectation only (Paul:
	// "soft is what we want"): no refusal on missing adjust_goal — the
	// deterministic takeover fallback (user input + 1 agent turn, committed at
	// the fold) is the safety net. Fork-refused (the rogue-auditor guard,
	// goal family).
	// v5 RETIRE (2026-10-06, Paul): the retirement/upgrade pair. Manual-anytime
	// (the nudge offer is only the hint); the audit-fork guard applies (a
	// side-branch must not mutate the session ledger — rogue-auditor guard,
	// goal-family pattern); refusal is ATOMIC (a bad id changes nothing — the
	// whole batch is refused, no entry is appended). SOFT: ledger + sidecars
	// stay immutable; only the post-compaction render changes; unretire
	// revokes (latest-wins per unit).
	// SURFACE: the pair rides the close-dial shape — the retirement lifecycle (fold-armed
	// offer at close time) is a close/fold mechanism, so its tools ship with the close dial
	// (like adjust_goal/read_goal); the deprecated followUp surface keeps its frozen 2-tool set.
	if (auditDeliveryFromEnv(process.env) === "close") {
	pi.registerTool({
		name: RETIRE_UNITS_TOOL.name,
		label: RETIRE_UNITS_TOOL.label,
		description: RETIRE_UNITS_TOOL.description,
		promptSnippet: RETIRE_UNITS_TOOL.promptSnippet,
		promptGuidelines: [...RETIRE_UNITS_TOOL.promptGuidelines],
		parameters: {
			type: "object",
			properties: {
				superseded: { type: "array", items: { type: "number" }, description: "the settled unit ids whose content you carry into the new superseding unit (the new unit's close_unit stub carries the selected content)" },
				supersededBy: { type: "number", description: "the id of the NEW curated close_unit unit — REQUIRED when superseded is non-empty" },
				dropped: { type: "array", items: { type: "number" }, description: "the unit ids to retire COMPLETELY (no content carried anywhere)" },
				reason: { type: "string", description: "why this batch is stale (auditable)" },
			},
			required: ["superseded", "dropped"],
		} as const,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const branch = currentBranch(ctx);
				if (lineIsAuditFork(branch)) {
					return { content: [{ type: "text", text: goalToolAuditForkText("retire_units") }], details: { rejected: "audit-fork" } };
				}
				const p = (params ?? {}) as { superseded?: unknown; supersededBy?: unknown; dropped?: unknown; reason?: unknown };
				const superseded = Array.isArray(p.superseded) ? p.superseded.filter((u): u is number => typeof u === "number") : [];
				const dropped = Array.isArray(p.dropped) ? p.dropped.filter((u): u is number => typeof u === "number") : [];
				const supersededBy = typeof p.supersededBy === "number" ? p.supersededBy : undefined;
				const reason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason.trim() : undefined;
				// the known unit ids on this branch (ledger + this session's closes)
				const known = new Set<number>(state.ledger.units.map((u) => u.unitId));
				for (const pc of state.pendingCloses) known.add(pc.unitId);
				for (const e of branch) {
					if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
					const uid = (e.data as { unitId?: unknown } | undefined)?.unitId;
					if (typeof uid === "number") known.add(uid);
				}
				const knownList = [...known].sort((a, b) => a - b);
				const err = validateRetireCall(knownList, superseded, supersededBy, dropped);
				if (err !== null) {
					return { content: [{ type: "text", text: retireRefuseText(err) }], details: { rejected: err } };
				}
				const entry: RetireLedgerEntry = {
					v: 1,
					kind: "retire",
					ts: Date.now(),
					superseded,
					dropped,
					...(supersededBy !== undefined ? { supersededBy } : {}),
					...(reason !== undefined ? { reason } : {}),
				};
				pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, entry); // the branch is the durable source (append-only)
				state.ledger.retirements = [...state.ledger.retirements, entry]; // in-memory mirror (same span)
				emit(ctx, `SAM retire: ${superseded.length} superseded${supersededBy !== undefined ? ` by u${supersededBy}` : ""} + ${dropped.length} dropped (soft — retrievable, restorable)`);
				return { content: [{ type: "text", text: retireAckText(superseded, supersededBy, dropped) }], details: { superseded, supersededBy, dropped } };
			} catch (e) {
				return { content: [{ type: "text", text: `retire_units failed (nothing changed): ${e instanceof Error ? e.message : String(e)}` }], details: { rejected: "error" } };
			}
		},
	});
	pi.registerTool({
		name: UNRETIRE_TOOL.name,
		label: UNRETIRE_TOOL.label,
		description: UNRETIRE_TOOL.description,
		promptSnippet: UNRETIRE_TOOL.promptSnippet,
		promptGuidelines: [...UNRETIRE_TOOL.promptGuidelines],
		parameters: {
			type: "object",
			properties: {
				units: { type: "array", items: { type: "number" }, description: "the unit ids to restore to the post-compaction summary" },
				reason: { type: "string", description: "why (auditable)" },
			},
			required: ["units"],
		} as const,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const branch = currentBranch(ctx);
				if (lineIsAuditFork(branch)) {
					return { content: [{ type: "text", text: goalToolAuditForkText("unretire") }], details: { rejected: "audit-fork" } };
				}
				const p = (params ?? {}) as { units?: unknown; reason?: unknown };
				const units = Array.isArray(p.units) ? p.units.filter((u): u is number => typeof u === "number") : [];
				if (units.length === 0) {
					return { content: [{ type: "text", text: retireRefuseText("no unit ids given (units: []) — nothing to unretire") }], details: { rejected: "empty" } };
				}
				const known = new Set<number>(state.ledger.units.map((u) => u.unitId));
				for (const pc of state.pendingCloses) known.add(pc.unitId);
				for (const e of branch) {
					if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
					const uid = (e.data as { unitId?: unknown } | undefined)?.unitId;
					if (typeof uid === "number") known.add(uid);
				}
				const unknown = units.filter((u) => !known.has(u));
				if (unknown.length > 0) {
					return { content: [{ type: "text", text: retireRefuseText(`unknown unit id(s): ${unknown.join(", ")}`) }], details: { rejected: `unknown: ${unknown}` } };
				}
				const reason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason.trim() : undefined;
				const entry: RetireLedgerEntry = { v: 1, kind: "unretire", ts: Date.now(), units, ...(reason !== undefined ? { reason } : {}) } as RetireLedgerEntry;
				pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, entry);
				state.ledger.retirements = [...state.ledger.retirements, entry];
				emit(ctx, `SAM unretire: ${units.length} unit(s) restored to the summary (latest-wins)`);
				return { content: [{ type: "text", text: unretireAckText(units) }], details: { units } };
			} catch (e) {
				return { content: [{ type: "text", text: `unretire failed (nothing changed): ${e instanceof Error ? e.message : String(e)}` }], details: { rejected: "error" } };
			}
		},
	});
	}

	if (auditDeliveryFromEnv(process.env) === "close") {
		pi.registerTool({
			name: ADJUST_GOAL_TOOL.name,
			label: ADJUST_GOAL_TOOL.label,
			description: ADJUST_GOAL_TOOL.description,
			promptSnippet: ADJUST_GOAL_TOOL.promptSnippet,
			promptGuidelines: [...ADJUST_GOAL_TOOL.promptGuidelines],
			// sequential: the goal state is branch-ordered (latest wins); never
			// race a concurrent goal write into the branch order.
			executionMode: "sequential",
			parameters: {
				type: "object",
				properties: {
					goal: { type: "string", description: ADJUST_GOAL_TOOL.parametersDescription },
				},
				required: ["goal"],
			} as const,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					const branch = currentBranch(ctx);
					if (lineIsAuditFork(branch)) {
						return { content: [{ type: "text", text: goalToolAuditForkText("adjust_goal") }], details: { rejected: "audit-fork" } };
					}
					const text = String((params as { goal?: unknown }).goal ?? "").trim();
					if (text === "") {
						return {
							content: [{ type: "text", text: "adjust_goal refused — an empty goal is no goal. Pass the full current goal (objective, scope, constraints)." }],
							details: { rejected: "empty" },
						};
					}
					const record: SamGoalRecord = { v: 1, kind: "goal", text, ts: Date.now(), basis: "adjust-goal" };
					pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
					const version = goalRecords(branch).length + 1; // this record is not on the branch view yet
					return { content: [{ type: "text", text: adjustGoalResultText(version) }], details: { version, basis: "adjust-goal" } };
				} catch (err) {
					return { content: [{ type: "text", text: `adjust_goal failed (nothing stored): ${err instanceof Error ? err.message : String(err)}` }], details: { rejected: "error" } };
				}
			},
		});

		pi.registerTool({
			name: READ_GOAL_TOOL.name,
			label: READ_GOAL_TOOL.label,
			description: READ_GOAL_TOOL.description,
			promptSnippet: READ_GOAL_TOOL.promptSnippet,
			promptGuidelines: [...READ_GOAL_TOOL.promptGuidelines],
			parameters: { type: "object", properties: {}, required: [] } as const,
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				try {
					const branch = currentBranch(ctx);
					if (lineIsAuditFork(branch)) {
						return { content: [{ type: "text", text: goalToolAuditForkText("read_goal") }], details: { rejected: "audit-fork" } };
					}
					const goals = goalRecords(branch);
					if (goals.length === 0) {
						return { content: [{ type: "text", text: READ_GOAL_NO_GOAL_TEXT }], details: { versions: 0 } };
					}
					const latest = goals[goals.length - 1];
					const earlier = goals
						.slice(0, -1)
						.map((g) => `· ${new Date(g.ts).toISOString()} (${g.basis === "takeover-fallback" ? "takeover fallback" : "adjust_goal"}, ${g.text.length} chars)`)
						.join("\n");
					const label = latest.basis === "takeover-fallback" ? "TAKEOVER FALLBACK (adjust_goal was never called; the text is verbatim session content)" : "adjust_goal";
					const text =
						`GOAL (current — stored ${new Date(latest.ts).toISOString()}, ${label}):\n` +
						`${latest.text}\n` +
						`--- earlier version(s), kept in the session ledger (tombstones): ${goals.length - 1}\n` +
						`${earlier === "" ? "(none)" : earlier}\n` +
						`The current goal rides every compaction first (latest wins). To change it: adjust_goal (it replaces this version).`;
					return { content: [{ type: "text", text }], details: { versions: goals.length, basis: latest.basis } };
				} catch (err) {
					return { content: [{ type: "text", text: `read_goal failed (nothing read): ${err instanceof Error ? err.message : String(err)}` }], details: { rejected: "error" } };
				}
			},
		});
	}

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
				anchor: { type: "string", description: "Optional: an EXACT substring (case-sensitive) of the banked content — returns ONLY a small window (±3 lines) around the first exact match, for inspecting parts of your history without loading it all." },
			},
			required: ["id"],
		} as const,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const id = String((params as { id?: unknown }).id ?? "");
				const section = (params as { section?: unknown }).section;
				const anchor = (params as { anchor?: unknown }).anchor;
				const out = retrieveContent(id, typeof section === "string" ? section : undefined, ctx, typeof anchor === "string" ? anchor : undefined);
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
		description: SAM_COMMAND_DESCRIPTION, // 2026-10-05: short enough for the TUI line; the detail lives in the completions now
		// 0.0.2 (Paul, 2026-10-05): "UI settings autocomplete if possible … show valid
		// options while typing" — pi 0.87.1 native (RegisteredCommand.
		// getArgumentCompletions; the /model + /thinking precedent). The TUI's visual
		// rendering is verified by Paul on the Qube TUI (the VM cannot display it).
		getArgumentCompletions: (prefix: string) =>
			samCompletionsFor(
				prefix,
				state.ledger.units.map((u) => u.unitId).sort((a, b) => a - b),
			),
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
				if (head === "goal") {
					// 0.0.2 final feature (Paul, 2026-10-05): see the current goal —
					// latest-wins, same resolver as the goal-nudge waiver (goalStored).
					const goal = latestGoal(currentBranch(ctx));
					if (!goal) {
						emit(ctx, "sam: no goal stored on this branch yet — the model stores one with adjust_goal (the close-time offer does too); /sam report shows the full ledger.");
						return;
					}
					emit(ctx, [`sam: goal — stored ${new Date(goal.ts).toISOString()} (basis ${goal.basis})`, goal.text].join("\n"));
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
				if (head === "reaudit") {
					// v4: re-run the close's own audit for a closed-unsettled unit (operator lever,
					// synchronous children; the commit rides the ack turn's settle boundary).
					await reauditCloseHandler(pi, ctx, rest[0]);
					return;
				}
				if (head === "retrieve") {
					// P5: retrieval for humans/TUI (same resolver as sam_retrieve).
					// 2026-10-02: + exact anchor — `/sam retrieve <id> "exact phrase"`
					// returns only a small window around the first exact match.
					let rest2 = rest;
					let idTok: string | undefined;
					if (rest2.length > 0) {
						idTok = rest2[0];
						rest2 = rest2.slice(1);
						if (/^unit$/i.test(String(idTok)) && rest2.length > 0) {
							idTok = `${idTok} ${rest2[0]}`;
							rest2 = rest2.slice(1);
						}
					}
					const out = retrieveContent(String(idTok ?? "").trim(), undefined, ctx, rest2.length > 0 ? rest2.join(" ").trim() : undefined);
					emit(ctx, out.text);
					return;
				}
				emit(ctx, `sam: unknown subcommand '${head}' — /sam · /sam goal · /sam mode <display|manual|assisted|auto> · report · undo · fold <n> · resolve <n> · audit <n> (prepare branch) · settle <n> [forkFile] · reaudit <n> (v4, closed-unsettled unit) · retrieve <id> [\"exact text\"]`, "error");
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

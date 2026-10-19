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
 * - `/sam fold <n>` overrides a CORRECTIONS verdict (override ledger flag),
 *   `/sam resolve <n>` is the positive-resolution evidence (guard facts R1);
 * - D2 coexistence: detect a foreign folding folder (settings + branch
 *   evidence) ⇒ warn once and refuse folds (conservative, om-guard
 *   omPresence pattern; audits continue — measurement is safe);
 * - cache-ledger (port 2): assistant usages observed at message_end;
 *   commits marked (continuity); fold records carry commitTiming.
 *
 * Modes: 2026-10-16 — display/assisted/auto removed; manual is the only
 * behaviour (verified units fold at close_unit; /sam fold overrides a
 * CORRECTIONS verdict).
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
	MessageUpdateEvent,
	SessionBeforeCompactEvent,
	SessionBoundaryDraft,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionEntry,
	SessionMessageEntry,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolExecutionEndEvent,
	ToolExecutionUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, readdirSync,existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { EXTENSION_NAME, SAM_VERSION, describeBuild } from "../../src/identity.ts";
import {
	AUDIT_INSTRUCTION_PREFIX,
	CLOSE_UNIT_ALREADY_CLOSED_TEXT,
	CLOSE_UNIT_NO_NEW_WORK_TEXT,
	CLOSE_UNIT_AUDIT_FORK_TEXT,
	CLOSE_UNIT_TOOL_V4,
	type SamAuditPayload,
	emptyStubRefusalText,
	isSamInjected,
	undoAck,
	autoStubInstruction,
	UNDO_ACK_PREFIX,
	branchAuditInstruction,
	lightAuditInstruction,
	mediumAuditInstruction, // MEDIUM AUDIT TIER (2026-10-17): the routine close
	SAM_RETRIEVE_TOOL,
	pressureNudgeText, // context-pressure safenet (2026-10-16): the act-now nudge (part a)
	ADJUST_GOAL_TOOL,
	READ_GOAL_TOOL,
	adjustGoalResultText,
	READ_GOAL_NO_GOAL_TEXT,
	goalToolAuditForkText,
} from "../../src/protocol.ts";
import { fallbackGoal, goalBlock, goalRecords, lastRealUserMessage, latestGoal, type SamGoalRecord } from "../../src/goal.ts";
import { assistantText } from "../../src/verdict.ts";
import {
	messageText,
	buildProjection, // context-pressure safenet (2026-10-16): the post-fold estimate
	type PlainEntry,
	type PlainMessage,
	type PlainUsage,
} from "../../src/projection.ts";
import { estimateMessageTokens, estimateProjectedTokens } from "../../src/estimate.ts";
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
	weakSettlementRecord,
	entryText,
	computeOrphanZone,
	orphanRecord,
	anchorWindow,
	renderAnchorWindow,
	type RawEntry,
	type SamSettlementRecord,
	type SamOrphanRecord,
	branchSettlementRecords,
	settlementBlock,
	orphanKeepCount,
} from "../../src/branchaudit.ts";
import {
	createRetireOfferState,
	retireCensus,
	retireOfferArmedOnFold,
	retireOfferDecision,
	retireOfferText,
	retireThresholdChars,
	validateRetireCall,
	parseRetireCarryMarker, // v5 RETIRE light-carry (2026-10-06)
	createAutoRetireState, // context-pressure safenet (2026-10-16): part b — the system backstop
	retiredStates,
	autoRetireArmOnNudge,
	autoRetireSupersededByModel,
	autoRetireDecision,
	autoRetireCandidates,
	autoRetireSelect,
	autoRetireTargetChars,
	previousAutoRetire,
	type RetireLedgerEntry,
	type AutoRetireAction,
} from "../../src/retire.ts";
import { RETIRE_UNITS_TOOL, UNRETIRE_TOOL, retireAckText, retireRefuseText, unretireAckText, auditDeadlineNudgeText } from "../../src/protocol.ts"; // v5 RETIRE (2026-10-06, Paul) + v0.0.11 deadline nudge
import {
	prepareChildArgs,
	auditChildArgs,
	parsePrepareHandoff,
	childDiagnosticDetail, // v0.0.14: D9-hatch diagnostic detail (4 KB cap, Paul)
	auditTimeoutMs,
	auditTimeoutMsForDepth, // v0.0.14: per-depth hard budgets (medium/full dials)
	calmAuditDepthOf, // v0.0.14: the calm-zone level (SAM_AUDIT_CALM_DEPTH)
	PREPARE_CHILD_DEFAULT_TIMEOUT_MS,
	classifyReClose,
	lastCloseRecord,
	settledUnitIds,
	closeRecordForUnit,
	lineIsAuditFork,
	closeAuditResultLine,
	stubLineCount,
	stubCharCount,
	closeAuditDecision,
	auditDepthOf,
	missingAuditReplyClass,
	parseGlobalCompactionEnabled,
	parseCompactionTokens, // context-pressure safenet Q5 (2026-10-16): the deployed compaction token values
	parseArmMarker,
	shouldRestoreCompaction,
	D10A_ARM_MARKER,
	type AuditCompactionArmMarker,
	lastSettlementStrengthFor,
	canSupersede, // MEDIUM AUDIT TIER (2026-10-17): rung-ordered settlement upgrade guard
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
	AUDIT_STARTED_AT_ENV, // v0.0.11 (2026-10-17, Paul): the audit-child deadline-nudge stamp
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
	FOLD_ACK_CUSTOM_TYPE,
	FOLD_NOW_TOOL_ACTIVE,
	FOLD_NOW_PARAMS,
	FOLD_NOW_AUDIT_FORK_TEXT,
	FOLD_NOW_DISABLED_TEXT,
	FOLD_NOW_IN_FLIGHT_TEXT,
	FOLD_NOW_TRIGGERED_TEXT,
	foldAckText,
	foldEnabled,
	foldFailText,
} from "../../src/fold.ts"; // v0.0.4 FOLD (2026-10-14, Paul)
import {
	GOAL_NUDGE_TEXTS,
	GOAL_NUDGE_VARIANTS,
	armGoalOffer,
	clearGoalPending,
	consumeGoalOffer,
	goalNudgeLanding,
	goalNudgeLedgerEntry,
	goalNudgeText,
	isGoalUserInput,
	stampGoalCovered,
	waiveNextUserinput,
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
	coexistenceGate,
	detectForeignFolder,
	foreignFolderEvidence,
	ladderFor,
	modelSignature,
	pressureZone,
	pressureHeadroomTokens, // context-pressure safenet (2026-10-16): part a — the pressure line
	pressureLineOf,
	pressureNudgeDue,
	type DeployedCompactionTokens,
	resolveFactIfPositive,
	actionEnterOf,
	type GovernedModel,
	type Zone,
} from "../../src/governor.ts";
import {
	SAM_LEDGER_CUSTOM_TYPE,
	parseSamRecord,
	rebuildLedger,
	latestAuditDepth,
	DEPTH_VALUES,
	type SamCloseRecord,
	type SamFoldRecord,
	type SamDepthRecord,
	type SamAuditDepth,
	type SamNoFoldRecord,
	type SamUndoRecord,
	type SamFoldLostRecord,
	type SamResolveRecord,
} from "../../src/ledger.ts";
import {
	countUnits,
	createSamState,
	foldedEntryIdSet,
	stageSpanProof,
	type SamPendingCommit,
	type SamState,
} from "../../src/state.ts";
import { renderSamReport, renderSamStatus, samOutputChannel, type SamGovernorView } from "../../src/output.ts";
import { type SamStatusLineInput } from "../../src/statusbar.ts";
import { SamTuiStatus, type SamTuiStatusDeps } from "../../src/tui-status.ts";

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

/** 2026-10-06 (Paul, audit-ergonomics): the effective depth + its source, shown
 *  by `/sam depth` (no arg) and `/sam status` — precedence: the in-session
 *  command (`/sam depth`, latest-wins on the branch) > the env dial
 *  (`SAM_AUDIT_DEPTH`) > the zone-driven auto default (light at/above the
 *  watch line W−2R, the CALM-ZONE level below — MEDIUM by default, FULL via
 *  SAM_AUDIT_CALM_DEPTH since v0.0.14 — the routine close since 2026-10-17).
 *  The RETIRE-CARRY marker stays strongest at the carrier's own close (decision
 *  sites apply it last). */
function auditDepthStatusLine(branch: readonly PlainEntry[], env: Record<string, string | undefined> = process.env): string {
	const cmd = latestAuditDepth(branch);
	const envMode = auditDepthOf(env);
	if (cmd !== undefined && cmd !== "auto") return `audit depth: ${cmd} (source: /sam depth command — overrides the env dial for this session)`;
	if (envMode !== "auto") return `audit depth: ${envMode} (source: env SAM_AUDIT_DEPTH — the machine default)`;
	return `audit depth: auto (zone-driven: light at/above the watch line W−2R, ${calmAuditDepthOf(env)} below — the routine close; set the below-band level with SAM_AUDIT_CALM_DEPTH) — switch with /sam depth light|medium|full|auto`;
}

/** 2026-10-06 (Paul, audit-ergonomics): the SINGLE depth derivation — used by
 *  all three dispatch sites (fresh close, D5 re-audit, /sam reaudit) AND the
 *  in-flight display, so the line the user sees is the line the pipeline gets.
 *  Precedence (strongest last): env dial / zone auto (closeAuditDecision —
 *  the calm-zone level via SAM_AUDIT_CALM_DEPTH since v0.0.14) ⇒ the in-
 *  session command (`/sam depth`, latest-wins on the branch — overrides the
 *  env dial for this session) ⇒ the model's close_unit depth arg (v0.0.14,
 *  Paul: a FULL OVERRIDE — any of light | medium | full, upgrades AND
 *  downgrades, even against a /sam depth session setting: "even if the user
 *  set session to full the model should be allowed to downgrade for one
 *  call"; the 2026-10-17 R7 upgrade-only lever is gone) ⇒ the RETIRE-CARRY
 *  marker (a carrier's close is ALWAYS light — the system convention beats
 *  the model). decision-in-ledger: the source is recorded on the record. */
type CloseAuditDecision = {
	ctxTokens: number | null;
	zone: Zone;
	depth: "full" | "medium" | "light";
	depthSource: "retire-carry" | "command" | "tool-override" | "env" | "zone";
};

function decideCloseAuditDepth(
	ctx: ExtensionContext,
	stub: string,
	toolDepth?: "light" | "medium" | "full",
): CloseAuditDecision {
	recomputeGovernor(ctx); // sam-05 (2026-10-05): model-fresh ladder for the depth decision
	const base = closeAuditDecision(state.governor.ladder, ctx);
	let decision: CloseAuditDecision = { ...base };
	const cmd = latestAuditDepth(currentBranch(ctx));
	if (cmd !== undefined && cmd !== "auto") decision = { ...decision, depth: cmd, depthSource: "command" };
	if (toolDepth !== undefined) decision = { ...decision, depth: toolDepth, depthSource: "tool-override" };
	if (parseRetireCarryMarker(stub) !== undefined) decision = { ...decision, depth: "light", depthSource: "retire-carry" };
	return decision;
}

/** v0.0.14 (request A, Paul): the visual hint that the model set an EXPLICIT
 *  depth on this close — "(depth override: X)" on the close lines (in-flight
 *  + result), so the override is visible where it happens. */
function depthOverrideHint(d: CloseAuditDecision): string {
	return d.depthSource === "tool-override" ? ` (depth override: ${d.depth})` : "";
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
		rebuilds: { ...g.cacheLedger.summary().rebuilds },
	};
}

function statusText(ctx: ExtensionContext): string {
	// D11 (2026-10-02): the goal line.
	const goals = state.ledger.goals;
	const latest = goals.length > 0 ? goals[goals.length - 1] : undefined;
	const goalView = {
		text: latest?.text,
		basis: latest?.basis,
		ts: latest?.ts,
		earlier: Math.max(0, goals.length - 1),
	};
	// v0.0.15 (Paul, 2026-10-19): the context bar (plan: 2026-10-19-sam-status-line.md).
	return renderSamStatus(
		{
			state,
			usage: ctx.getContextUsage() ?? undefined,
			model: modelInfo(ctx),
			goal: goalView,
			contextBar: contextBarInput(ctx),
		},
		countUnits(state.ledger),
		governorView(ctx), // recomputeGovernor inside (idempotent signature diff)
	).join("\n");
}

/**
 * v0.0.15 (plan: 2026-10-19-sam-status-line.md), extracted for v0.0.16
 * (decision D6): the context-bar inputs — ONE source of truth for /sam status
 * and the live TUI widget. The system prompt is MEASURED (decision D3); tokens
 * are null right after start or ANY fold (D7).
 *
 * v0.0.16 fix-up 2 (Paul 2026-10-19, rulings 5 + 6): O is now the "before
 * first turn after fold" prompt — sysPrompt + the latest takeover summary
 * (post-fold; the summary CONTAINS the goal block) or the stored goal block
 * (pre-fold); the dots are the RAW tokens of closed (audited) units still in
 * the current context (interpretation B) — the close boundary is the last
 * settlement ledger entry (a custom entry written at close time; custom
 * entries never project into the LLM context).
 */
/**
 * The close boundary: the RAW tokens of closed (audited) units still in the
 * current context — the projection messages whose source entry lies BEFORE
 * the LAST settlement ledger entry. Everything before the last settlement is
 * inside some closed span (an orphaned span's entries are absorbed into the
 * next closed span — the settlement's audited span covers them), so no
 * compaction lower bound is needed: the projection already contains only
 * current-context entries (post-fold: the retention tail + the latest
 * compaction summary + post-fold entries). The takeover-summary entry itself
 * (rawIdx === compIdx) is excluded — it belongs to the O segment, not the
 * raw dots. Estimated with the pi-mirrored ruler (estimate.ts). 0 when there
 * is no close at all.
 *
 * v0.0.16 fix-up 3 (Paul 2026-10-19): the previous window (lastCompaction,
 * lastSettlement] structurally missed closed spans that pi preserved in the
 * post-fold retention tail — a close immediately followed by a fold rendered
 * 0 dots although the closed span's raw entries sat in the context (measured:
 * session 2026-10-16T17-58-17…jsonl, u105 close @4645 then fold @4656, the
 * tail's 17,744 tokens of closed span showed as 0 dots; the genuine orphaned
 * post-close tail was 3,119 tokens ≈ 1 block).
 */
function closedSpanTokens(branch: PlainEntry[]): number {
	let compIdx = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].kind === "compaction") {
			compIdx = i;
			break;
		}
	}
	let settleIdx = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.kind === "custom" && e.customType === SAM_LEDGER_CUSTOM_TYPE) {
			const data = e.data as { kind?: string } | undefined;
			if (data?.kind === "settlement") {
				settleIdx = i;
				break;
			}
		}
	}
	if (settleIdx < 0) return 0; // no close at all
	const idToIndex = new Map<string, number>();
	branch.forEach((b, i) => idToIndex.set(b.id, i));
	let total = 0;
	for (const entry of buildProjection(branch).entries) {
		const rawIdx = idToIndex.get(entry.sourceEntryId);
		if (rawIdx === undefined) continue;
		if (rawIdx >= settleIdx) continue; // open span (post-last-settlement) — not closed
		if (rawIdx === compIdx) continue; // takeover summary — O's job, not raw dots
		for (const m of entry.messages) total += estimateMessageTokens(m);
	}
	return total;
}

/** Test-only export: the close-boundary measurement (test/closed-span.test.ts). */
export function __closedSpanTokens(branch: PlainEntry[]): number {
	return closedSpanTokens(branch);
}

/** The char footprint of a (partial) tool result — a mirror of estimate.ts's
 *  contentChars for the in-flight tail (fix-up 2). ToolResult-shaped values
 *  ({content: string | block[]}) are unwrapped first; image blocks count the
 *  same fixed 4800 chars pi's ruler uses. */
function toolOutputChars(value: unknown): number {
	const c = value !== null && typeof value === "object" && "content" in (value as Record<string, unknown>)
		? (value as { content: unknown }).content
		: value;
	if (typeof c === "string") return c.length;
	if (Array.isArray(c)) {
		let n = 0;
		for (const b of c) {
			if (b !== null && typeof b === "object" && "text" in b) n += String((b as { text?: unknown }).text ?? "").length;
			else if (b !== null && typeof b === "object" && "image" in b) n += 4800;
		}
		return n;
	}
	return 0;
}

function contextBarInput(ctx: ExtensionContext): SamStatusLineInput {
	const usage = ctx.getContextUsage() ?? undefined;
	const gov = governorView(ctx); // recomputeGovernor inside (idempotent signature diff)
	let sysPromptTokens = 0;
	try {
		sysPromptTokens = Math.ceil(ctx.getSystemPrompt().length / 4); // measured, not estimated (decision D3)
	} catch {
		// best-effort: without the system prompt the goal block still renders the summary head
	}
	const branch = currentBranch(ctx);
	let summaryTokens = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.kind === "compaction") {
			summaryTokens = Math.ceil(e.summary.length / 4); // the takeover summary IS the post-fold O part
			break;
		}
	}
	const auditedTokens = closedSpanTokens(branch); // interpretation B (ruling 6)
	const goals = state.ledger.goals;
	const latest = goals.length > 0 ? goals[goals.length - 1] : undefined;
	const goalTokens = latest !== undefined ? Math.ceil(goalBlock(latest).length / 4) : 0;
	return {
		tokens: usage?.tokens ?? null,
		window: gov.window,
		reserve: gov.reserve,
		sysPromptTokens,
		goalTokens,
		summaryTokens,
		auditedTokens,
		auditDepth: decideCloseAuditDepth(ctx, "").depth, // the same derivation the nudge level line uses
	};
}

/**
 * v0.0.16 (Paul 2026-10-19): the live TUI status line below the input line
 * (plan: 2026-10-19-sam-tui-status-line.md). One instance per process; the
 * widget is installed at session_start (dial SAM_STATUS_LINE, tui mode only),
 * refreshed at exactly the sites that change the bar (close / retire /
 * unretire / fold / goal — finally on the tool paths, every return covered),
 * and cleared at session_shutdown.
 */
const samTui: SamTuiStatus = new SamTuiStatus({
	bar: (ctx) => contextBarInput(ctx),
	keepRecent: (ctx) => governorView(ctx).keepRecent,
	anchor: (ctx) => ({ // fix-up 2: the cheap anchor re-read for message_end (no full recompute)
		tokens: ctx.getContextUsage()?.tokens ?? null,
		auditDepth: decideCloseAuditDepth(ctx, "").depth,
	}),
});

/* ── ledger helpers (in-memory bookkeeping after durable writes) ────────── */

function recordCloseInMemory(unitId: number, stub: string, evidence?: UnitFloor): void {
	state.ledger.units.push({
		unitId,
		stub,
		state: "in-flight",
		mode: "manual",
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

/** The CURRENT deployed compaction token values (context-pressure safenet
 *  Q5, Paul 2026-10-16: "read the current pi values, avoid magic numbers")
 *  — pi's settings `compaction.reserveTokens` / `compaction.keepRecentTokens`
 *  (pi 0.87.1 settings-manager.ts: defaults 16384 / 20000, the SAME values
 *  the built-in PI_DEFAULT_* constants encode — so on a default deployment
 *  the ladder is byte-identical to before). SYNC (recomputeGovernor runs on
 *  a hot path with no async): the SAM_SETTINGS_JSON env seam is honored
 *  first (the test VM, same seam as readSettings), then the raw global
 *  settings (the D10A readGlobalSettingsRaw pattern). Absent / malformed /
 *  non-numeric values ⇒ omitted fields ⇒ ladderFor falls back to the
 *  built-ins (parseCompactionTokens is pure/total). */
function deployedCompactionTokens(): DeployedCompactionTokens {
	const override = process.env["SAM_SETTINGS_JSON"];
	const raw = typeof override === "string" && override.trim() !== "" ? override : readGlobalSettingsRaw(parentAgentDir());
	return parseCompactionTokens(raw);
}

/** model_select recompute (P3): ladder re-derives on model identity change.
 *  2026-10-16 (context-pressure safenet Q5): the ladder is derived from the
 *  DEPLOYED compaction values (the operator's settings, read live), not
 *  from the built-in defaults — the pressure line must track what pi
 *  actually deploys. */
function recomputeGovernor(ctx: ExtensionContext): void {
	const g = state.governor;
	const model: GovernedModel | undefined = modelInfo(ctx) as GovernedModel | undefined;
	const sig = modelSignature(model ?? null);
	const usageWindow = ctx.getContextUsage()?.contextWindow;
	if (sig !== g.lastModelSig) {
		g.lastModelSig = sig;
		g.ladder = ladderFor(usageWindow ?? model?.contextWindow, model ?? null, deployedCompactionTokens());
		g.zone = "calm"; // hysteresis resets with the model
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
				mode: "manual",
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
				mode: "manual",
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
	// P4 R3 (2026-09-30): this span is already carried by a compaction
	// summary — it is OUT of the view. Folding it would save ZERO view tokens
	// and only rewrite preserved ground-truth bytes, so the correct terminal
	// is `resolved` (compaction-owned): the fold is never issued (zero
	// context_edits in both gate outcomes), the gate arithmetic stays on
	// record as evidence (a noFold SIBLING when the gate rejected), and the
	// honest terminal replaces the (arguably wrong) ceiling refusal. The
	// "refuse" opt-out (SAM_COMPACTED_SPAN) was removed 2026-10-16 —
	// tombstone is the only policy. Pure decision:
	// folder.tombstoneCompactedSpan (harness-replayable, R4 discipline); the
	// glue only dispatches and records.
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
				mode: "manual",
			},
		);
		return { kind: "resolveCompacted", record: d.record, noFold: d.noFold };
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
				mode: "manual",
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
		mode: "manual",
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
	if (waiting.verdict.class === "VERIFIED") {
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
		if (decision.kind === "fold" && waiting.usage) {
			decision.record.usage = waiting.usage;
		}
		applyDecision(decision, entries);
	} else {
		const reason = `verdict ${waiting.verdict.class}`;
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
			mode: "manual",
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
		// is the ground truth). Terminal by every existing rule: /sam resolve
		// rejects resolved units, and no retry path re-pends them (the sweep
		// candidate path went 2026-10-16 with the assisted/auto modes). ZERO context
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

	// 2) v4: commit the staged close-audits (FIFO) — one
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
			// D9, re-rung 2026-10-17 (MEDIUM AUDIT TIER): a SETTLEMENT is an UPGRADE
			// target iff the new item's rung is strictly higher (canSupersede):
			// STRONG (VERIFIED/CORRECTIONS) is final; MEDIUM (PLAUSIBLE) and WEAK
			// (NOT-YET-VERIFIED / UNVERIFIED) never commit over an equal-or-higher
			// rung (anomaly fix (b), 2026-10-02, generalised — the run-03
			// [201]–[204] re-settle wave: never weak-over-weak, no downgrades,
			// especially not supersedes === own id); only a strictly higher rung
			// upgrades (the supersedes search below names the replaced one).
			if (settledNow.has(item.unitId) && !canSupersede(lastSettlementStrengthFor(branch, item.unitId), item.verdict)) {
				console.error(`sam: close-audit unit ${item.unitId} already settled on the branch (idempotence / no-upgrade skip — the staged capture is dropped, the fork file stays banked)`);
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
					reasons: [emptyGate.reason ?? "empty stub over work"], ts: Date.now(), mode: "manual",
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

	// 4) a close from this turn (in-memory, last effective) or a restored
	//    re-audit (FIFO, oldest first) → resolve the span, stage the proof,
	//    apply the P3 close-time gates, and hold the settle for the close
	//    (the v4 close-time audit settled it, or the re-close re-audits it).
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
				reasons: [emptyGate.reason ?? "empty stub over work"], ts: Date.now(), mode: "manual",
			};
			if (unit) unit.state = "refused";
			applyDecision({ kind: "noFold", record }, entries);
			state.pendingCloses = [];
			g.guardFacts.push({ unitId: span.unitId, kind: "gate-reject", basis: "empty-stub", sinceSettle: g.settleCount });
			state.pendingCloses = [];
			return entries.length > 0 ? { entries } : undefined;
		}

		// v4: the close is committed but its audit is deferred (awaiting the
		// re-audit: the model's same-stub close_unit). Never queue an
		// in-series audit (the main-line audit-free invariant is the v4
		// core); the unit otherwise falls to native compaction (the pi
		// base outcome, v4-plan §1 crash row) and everything stays
		// retrievable. (2026-10-16, Wave A: the operator's /sam audit +
		// /sam settle commands are REMOVED — the user does not trigger
		// audits; re-close with the same stub is the recovery path.)
		if (!g.closeHoldAnnounced) {
			g.closeHoldAnnounced = true;
			console.error(`sam: close-audit mode — unit ${span.unitId} awaits its audit: re-close with the same stub — the close is effective, nothing is folded`);
		}
		return entries.length > 0 ? { entries } : undefined;
	}

	if (entries.length === 0) return undefined;
	return { entries };
}

function byIdOf(branch: readonly PlainEntry[], id: string): PlainEntry | undefined {
	for (const entry of branch) if (entry.id === id) return entry;
	return undefined;
}

/* ── P5 branch audit: the prepare child's fork + handoff ── */

/**
 * The branch audit on a FORKED session file (P5; a turn-boundary operation —
 * pi core refuses session transitions while streaming). position "at" puts
 * the FULL unit context (incl. the last assistant line) on the fork; the
 * audit reply is read from the fork's file by the close pipeline's
 * validate step (file-based — no in-memory state needs to survive the
 * child). (2026-10-16, Wave A: the operator's /sam audit command and its
 * session_start resume backstop are REMOVED — the close pipeline's prepare
 * child is the sole caller of this method, via `sam-prepare-audit`.)
 * F1: any failure carries the unit on the in-series followUp audit (the R1
 * fall-through pattern); the close itself is never broken.
 */
/** INTERNAL METHOD (2026-10-16, Paul's abstraction rule): prepare the
 * branch audit for `unitArg` — fork at the leaf + emit the machine-readable
 * handoff (model-free; no model turn starts). The only caller today is the
 * close pipeline's prepare child, via the internal `sam-prepare-audit`
 * command (registered in the factory). The user-facing `/sam audit` command
 * is REMOVED — the user does not trigger audits (the model does: close_unit
 * + the nudge channels); re-adding a user command later is one dispatch line
 * calling this method. `unitArg` undefined/invalid ⇒ the last pending close,
 * else the last in-flight unit (kept for a possible future user wrapper). */
async function prepareBranchAudit(ctx: ExtensionCommandContext, unitArg?: number): Promise<void> {
	if (!ctx.isIdle()) {
		emit(ctx, "sam: wait for the current response to finish before the branch audit (session transitions are turn-boundary operations)", "error");
		return;
	}
	let unitId: number | undefined = unitArg;
	if (unitId === undefined || Number.isNaN(unitId) || unitId < 1) {
		const pc = state.pendingCloses[state.pendingCloses.length - 1];
		if (pc !== undefined) unitId = pc.unitId;
		else {
			const units = state.ledger.units.filter((u) => u.state === "in-flight");
			unitId = units.length > 0 ? units[units.length - 1].unitId : undefined;
		}
	}
	if (unitId === undefined || Number.isNaN(unitId)) {
		emit(ctx, "sam: no open unit to audit — close one first (close_unit) or name the unit", "error");
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
	// (3) the close pipeline validates the verdict from the FORK FILE and
	// settles through the normal settle boundary (2026-10-16, Wave A: the
	// operator's `/sam settle <n> <forkFile>` is REMOVED — no operator settle
	// step remains; the internal `sam-prepare-audit` entry replaced the
	// user-facing `/sam audit` command — Paul: the user does not trigger
	// audits; this method is the audit's home, the command a thin wrapper).
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
				emit(fctx, `sam: branch prepared for unit ${unitId} — next: prompt the fork session (${forkFile}) with the instruction (the close pipeline validates the verdict from the fork file and settles at the settle boundary)`);
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

/** The session dir (pi API: getSessionDir) — total: undefined if unknown. */
function sessionDirOf(ctx: ExtensionCommandContext): string | undefined {
	try {
		const d = ctx.sessionManager.getSessionDir();
		return d === undefined || d === null ? undefined : String(d);
	} catch {
		return undefined;
	}
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
	// (the raw entries of the unclosed-at-fold zone — inspect in anchored
	// windows). 2026-10-16 (context-pressure safenet): 'unit N' ALSO resolves
	// orphan units — the unitId minted at fold time makes them addressable
	// exactly like real close units (pre-unitId orphans keep the id-only path).
	const orphanUnitMatch = /^unit\s+(\d+)$/i.exec(id);
	for (const e of branch) {
		if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
		const d = e.data as Partial<SamOrphanRecord> | undefined;
		if (d?.kind !== "orphan" || typeof d.retrievalId !== "string") continue;
		const isOrphanUnit = orphanUnitMatch !== null && typeof d.unitId === "number" && d.unitId === parseInt(orphanUnitMatch[1], 10);
		if (d.retrievalId !== id && !isOrphanUnit) continue;
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
		// context-pressure safenet (2026-10-16): no extra path needed for the
		// synthetic units — the synthesized AUTO-RETIRE settlement owns the same
		// unitId and is served by the settlement scan above (auditFile "" ⇒ the
		// line answer); minted orphans are served by the orphan path above ('unit
		// N' resolves their minted unitId exactly like a close unit's).
	}
	return {
		text: `no SAM record found for '${id}'. Settlement lines carry the retrieval id (12-hex) — look for them in the session or a compaction summary; orphaned spans (unclosed at fold) carry one in their ORPHANED section; units take the form 'unit 3'. /sam report lists the ledger.`,
		source: "none",
	};
}

/* ── factory ─────────────────────────────────────────────────────────────── */

// v4 (close-audit): the synchronous audit pipeline + its injectable runner
// seam (suite discipline: no real process inside the test run — the live
// probe banks exercise the real spawn; the v3 lesson is that the fork
// happens in a CHILD process, never in the tool handler).
export interface CloseAuditRunner {
	run(
		args: string[],
		opts: { timeoutMs: number; label: string; signal?: AbortSignal | undefined; /** the child's env (default: childEnv — SAM_NUDGE=off; D10-A: BOTH children run in the MAIN agent dir) */ env?: Record<string, string | undefined> },
	): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}

const capTail = (s: string, n: number): string => (s.length > n ? s.slice(s.length - n) : s);

// D10-A (2026-10-13, Paul's option A — supersedes D10's throwaway child agent
// dir, see the closeaudit.ts D10-A note): the audit child must NEVER fold.
// The parent temporarily flips compaction.enabled=FALSE in the SHARED
// settings.json (pi's own SettingsManager — proper-lockfile RMW; no file
// watcher ⇒ the parent's in-memory settings are unaffected), spawns the child
// in the MAIN agent dir (prompt identity by construction), and restores the
// previous value as soon as the child exits (finished OR timed out).
// Crash window ⇒ the ARM MARKER (D10A_ARM_MARKER in the session dir) + the
// session_start backstop (disarmCrashedAuditArm). Fail-open on arm failure:
// the child may fold — the takeover + D9 hatch remain the rescue (measured
// safe in run-03).

/** One armed toggle: `disarm()` restores the previous `compaction.enabled`
 *  (via the same locked writer) and removes the ARM MARKER — the marker is
 *  kept until the restore succeeds, so a failed disarm leaves the
 *  session_start backstop a retry path. */
export interface AuditCompactionArm {
	disarm(): void;
}

type ArmAuditCompaction = (sessionDir: string, cwd: string, unitId: number) => Promise<AuditCompactionArm | undefined>;

/** The parent's agent dir, exactly as pi resolves it (env override first —
 *  measured: dist/config.js getAgentDir; APP_NAME "pi" in the 0.87.1 build). */
function parentAgentDir(): string {
	const envDir = process.env["PI_CODING_AGENT_DIR"];
	if (envDir) return envDir;
	return join(homedir(), ".pi", "agent");
}

function armMarkerPath(sessionDir: string): string {
	return join(sessionDir, D10A_ARM_MARKER);
}

/** Raw global settings.json of the parent agent dir (null: absent/unreadable). */
function readGlobalSettingsRaw(agentDir: string): string | null {
	try {
		return readFileSync(join(agentDir, "settings.json"), "utf8");
	} catch {
		return null;
	}
}

async function defaultArmAuditCompaction(sessionDir: string, cwd: string, unitId: number): Promise<AuditCompactionArm | undefined> {
	const agentDir = parentAgentDir();
	const prev = parseGlobalCompactionEnabled(readGlobalSettingsRaw(agentDir));
	if (prev === false) return undefined; // the user's own global off — the child sees false anyway; nothing to toggle (and the backstop must never flip it on)
	// 1. ARM MARKER FIRST (crash safety: marker present ⇒ the file may be off ⇒ the backstop restores `prev`).
	const marker: AuditCompactionArmMarker = { prev: true, unit: unitId, at: Date.now() };
	try {
		writeFileSync(armMarkerPath(sessionDir), JSON.stringify(marker, null, 2));
	} catch (err) {
		console.error(`sam: D10-A could not write the arm marker (${err instanceof Error ? err.message : String(err)}) — the audit child may fold (the takeover + D9 hatch remain the rescue)`);
		return undefined; // fail-open (F1): no marker ⇒ no arm
	}
	// 2. The toggle — pi's own SettingsManager (same proper-lockfile RMW as pi's own writes; only the modified field is persisted).
	let mgr: { setCompactionEnabled(v: boolean): void } | undefined;
	try {
		const pi = await import("@earendil-works/pi-coding-agent");
		mgr = pi.SettingsManager.create(cwd);
		mgr.setCompactionEnabled(false);
	} catch (err) {
		try {
			rmSync(armMarkerPath(sessionDir), { force: true });
		} catch {
			/* best-effort */
		}
		console.error(`sam: D10-A compaction arm failed (${err instanceof Error ? err.message : String(err)}) — the audit child may fold (the takeover + D9 hatch remain the rescue)`);
		return undefined; // fail-open (F1)
	}
	return {
		disarm() {
			let restored = false;
			try {
				mgr!.setCompactionEnabled(true);
				restored = true;
			} catch {
				/* best-effort — the session_start backstop retries from the marker */
			}
			if (restored) {
				try {
					rmSync(armMarkerPath(sessionDir), { force: true });
				} catch {
					/* best-effort — the backstop removes a stale marker too */
				}
			}
		},
	};
}

let armAuditCompaction: ArmAuditCompaction = defaultArmAuditCompaction;
export function __setArmAuditCompaction(r: ArmAuditCompaction | null): void {
	armAuditCompaction = r ?? defaultArmAuditCompaction;
}

/**
 * D10-A session_start backstop (total — never throws): if the ARM MARKER is
 * present in the session dir, an arm never disarmed (a crash, a failed
 * restore, or a missed disarm). Restore `compaction.enabled` to the marker's
 * `prev` when the file currently reads `false` (idempotent — never clobbers a
 * user re-enable), then remove the marker. A present-but-unparseable marker
 * is restored as `prev: true` (the conservative default — the arm only ever
 * writes `prev: true`). No-op when the marker is absent.
 */
export async function disarmCrashedAuditArm(sessionDir: string, cwd: string): Promise<void> {
	const markerPath = armMarkerPath(sessionDir);
	let raw: string | null = null;
	try {
		raw = readFileSync(markerPath, "utf8");
	} catch {
		return; // no marker — nothing to fix
	}
	const marker = parseArmMarker(raw); // unparseable ⇒ null ⇒ conservative restore below
	const agentDir = parentAgentDir();
	const current = parseGlobalCompactionEnabled(readGlobalSettingsRaw(agentDir));
	if (shouldRestoreCompaction(marker, current) || (marker === null && current === false)) {
		const pi = await import("@earendil-works/pi-coding-agent");
		const mgr = pi.SettingsManager.create(cwd);
		mgr.setCompactionEnabled(true);
	}
	try {
		rmSync(markerPath, { force: true });
	} catch {
		/* best-effort */
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
				// D10-A: opts.env is the SAM dial override only (childEnv —
				// SAM_NUDGE=off); both children run in the MAIN agent dir.
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


/**
 * v0.0.11 (2026-10-17, Paul): the audit-child deadline nudge. Runs ONLY in
 * the audit child — the parent stamps SAM_AUDIT_STARTED_AT_MS into the
 * child's env (the main session and the prepare child never have it). One
 * one-shot timer at 50 % of the shared budget (4 min at the default 8 min;
 * it scales with the SAM_AUDIT_TIMEOUT_MS dial, R4) steers the verdict
 * reminder in. Measured pi 0.87.1: the print-run loop continues with a
 * further turn whenever a message is queued, so the steer reaches the model
 * mid-audit. Deliberately UNGATED by SAM_NUDGE: D7 keeps the pressure/goal
 * nudges off in the child; this is the audit's own deadline — a separate
 * mechanism, no new dial. Unref'd: a fast verdict must not hold the child
 * process open past its run. Total: never breaks a session start.
 */
export function armAuditDeadlineNudge(pi: ExtensionAPI): void {
	try {
		const raw = process.env[AUDIT_STARTED_AT_ENV];
		if (!raw) return; // not an audit child — main session / prepare child
		const startedAt = Number(raw);
		if (!Number.isFinite(startedAt)) return;
		const budgetMs = auditTimeoutMs(process.env);
		const delay = startedAt + budgetMs / 2 - Date.now();
		if (delay <= 0) return; // already past the halfway mark — nothing to save
		setTimeout(() => {
			try {
				pi.sendUserMessage(auditDeadlineNudgeText(budgetMs), { deliverAs: "steer" });
			} catch {
				/* best-effort — the runner's SIGKILL timeout is the backstop */
			}
		}, delay).unref();
	} catch {
		/* best-effort — total */
	}
}

export default function factory(pi: ExtensionAPI): void {
	// Announce once per session start, in every reason (startup/resume/reload/
	// new/fork), rebuild the ledger from the session file, and apply the P3
	// session-start duties: commit-proof tombstones, D2 detection, proofs for
	// restored units.
	pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
		try {
			// v0.0.11 (2026-10-17, Paul): if THIS process is an audit child (the
			// parent stamped SAM_AUDIT_STARTED_AT_MS), arm the one-shot deadline
			// nudge at 50 % of the shared budget. No-op in the main session and
			// the prepare child (no stamp).
			armAuditDeadlineNudge(pi);

			const ledger = rebuildLedger(currentBranch(ctx));
			state = createSamState(ledger);

			// D10-A backstop (2026-10-13): a crash inside the compaction-arm
			// window (between arm and disarm in close_unit) leaves
			// compaction.enabled=false in the SHARED settings.json + the arm
			// marker in the session dir. Only FRESH processes read that file,
			// so restore it before the first turn. The marker itself is the
			// evidence (it exists only when an arm never disarmed). Total:
			// never breaks a session start; no-op when the marker is absent.
			try {
				await disarmCrashedAuditArm(ctx.sessionManager.getSessionDir(), ctx.cwd);
			} catch (err) {
				console.error(`sam: D10-A compaction backstop failed (compaction may stay off): ${err instanceof Error ? err.message : String(err)}`);
			}

			const g = state.governor;
			// A span native compaction already summed out of the view is never
			// folded (zero view-token gain; it would only rewrite preserved
			// bytes): the terminal is `resolved` (compaction-owned), the gate
			// arithmetic is kept as evidence, context_edits stay zero.

			// P3: governor derivation for the current model.
			recomputeGovernor(ctx);

			// v0.0.16 (Paul 2026-10-19): the live TUI status line below the input
			// line (plan: 2026-10-19-sam-tui-status-line.md). No-op when the dial
			// (SAM_STATUS_LINE) is off or the mode is not tui; idempotent.
			samTui.install(ctx);

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

			// P3: stage proofs for restored commitments (pendingCommits) so
			// commit-time revalidation has a reference.
			for (const pc of ledger.pendingCommits) {
				stageSpanProof(state, pc.unitId, pc.span, branch);
			}

			const counts = countUnits(ledger);
			const flags: string[] = [];
			if (state.pendingCommits.length > 0) flags.push(`${state.pendingCommits.length} verdict(s) awaiting commit`);
			flags.push("audit delivery: close (the only mode since 2026-10-16 — v4 synchronous close-time audit: inside close_unit; N units per turn; no fold at close, the compaction takeover or /sam fold relieves the span; the SAM_AUDIT_DELIVERY dial is REMOVED)");
		flags.push(auditDepthStatusLine(currentBranch(ctx))); // 2026-10-06 (Paul): the depth switch + its source, always visible
			if (ledger.malformedRecords > 0) flags.push(`${ledger.malformedRecords} malformed ledger record(s) skipped`);
			if (g.foreignFolder.present) flags.push(`coexistence: ${g.foreignFolder.basis}`);
			const flagText = flags.length > 0 ? ` · ${flags.join(" · ")}` : "";
			emit(
				ctx,
				`${EXTENSION_NAME} ${SAM_VERSION} loaded — /sam for status · ${describeBuild()} · ` +
					`folded ${counts.folded} · refused ${counts.refused} · ` +
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
	const nudgeOnMessageEnd = (ctx: ExtensionContext, message: MessageEndEvent["message"]): void => {
		if (!nudgeEnabled(process.env)) return; // the light off-path (SAM_NUDGE defaults ON — Paul, 2026-10-02; opt-out `SAM_NUDGE=off`)
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
		if (d.fire && auditFork) {
			// Suppressed (the audit decision is pending on the fork — F8:
			// the nudge stays out of the model's turn either way), but
			// RECORDED: the run-02 gap (no trace at all in a ~36-min
			// in-band window) is the spec input.
			const suppressReason = "audit-fork";
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
		// v0.0.4 FOLD hint (2026-10-14, Paul — the "when the context window
		// is high" part): the `band`/`gap` texts gain a fold_now pointer when
		// the fold dial is ON, the zone is under pressure, and the last close
		// is settled (everything up to it is summarized in the settlement
		// lines — a fold now is the clean case; the nudge is pointing at this
		// exact pressure). The `reasoning` trigger never carries it (it is
		// not context-pressure). No new dial: it rides SAM_FOLD + the
		// existing nudge switch (nudge.ts carries the text + pin).
		let foldHint: { unit: number } | undefined;
		if (foldEnabled(process.env) && (zone === "watch" || zone === "action")) {
			const nudgeBranch = currentBranch(ctx);
			const lastClose = lastCloseRecord(nudgeBranch);
			if (lastClose !== undefined && settledUnitIds(nudgeBranch).has(lastClose.unitId)) {
				foldHint = { unit: lastClose.unitId };
			}
		}
		// v0.0.14 (Paul): the close nudges state the audit level that WILL be called if the model
		// does not override it — the same single derivation (no tool arg, no stub: a nudge
		// precedes any close).
		const text = nudgeText(trigger, { contextPercent: usage?.percent ?? null, foldHint, auditDepth: decideCloseAuditDepth(ctx, "").depth }); // both `gap` and `band` carry the current context (Paul, 2026-10-02); `band` adds the imminent-fold warning; v0.0.4 adds the fold hint (nudge.ts); v0.0.14 adds the active audit level
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
		if (!nudgeEnabled(process.env)) {
			st.pending = null; // dial off ⇒ never offered (no deferred offer queued)
			return;
		}
		const branch = currentBranch(ctx);
		const lastReal = lastRealUserMessage(branch);
		const auditFork = lineIsAuditFork(branch);
		if (auditFork) {
			// suppressed (D9 pattern: a suppressed decision leaves a trace —
			// the run-02 lesson); the event is consumed either way (a later
			// outside input is a NEW event; the model's turn is not blocked).
			const suppressReason = "audit-fork";
			pi.appendEntry(
				NUDGE_LEDGER_CUSTOM_TYPE,
				goalNudgeLedgerEntry({ variant: pending, now: Date.now(), suppressed: true, suppressReason }),
			);
			emit(ctx, `SAM goal nudge SUPPRESSED (${suppressReason}) — would have fired: ${pending} — the audit decision is pending`);
			st.pending = null;
			stampGoalCovered(st, lastReal); // a consumed event advances the covered watermark (Bug A — no double offer later)
			return;
		}
		// Bug A (Paul 2026-10-14): the goal-nudge fires only if there was an
		// ACTUAL user input — one that LANDED in the session. The `input` event
		// (the arm point) fires BEFORE the session append (pi v0.87.1
		// `prompt()`), so a queued steer the user edited away armed the offer
		// without ever landing. At this point (the first assistant message_end
		// after the arm) every input that will land HAS landed — require a NEW
		// real user message beyond the covered watermark, else invalidate with
		// a trace.
		const landing = goalNudgeLanding(st.lastCoveredRealUser, lastReal);
		if (!landing.ok) {
			pi.appendEntry(
				NUDGE_LEDGER_CUSTOM_TYPE,
				goalNudgeLedgerEntry({ variant: pending, now: Date.now(), invalidated: true, invalidateReason: landing.why }),
			);
			emit(ctx, `SAM goal nudge INVALIDATED (${landing.why}) — armed by an input event that never landed in the session — no offer`);
			st.pending = null;
			stampGoalCovered(st, lastReal);
			return;
		}
		// Bug B (Paul 2026-10-14): the one-shot waiver — a successful
		// adjust_goal stored the goal in the previous turn, so this offer
		// (the model re-asking about a goal it just wrote) is moot: cleared
		// silently, no ledger entry. Consumed here (a live, landed offer) —
		// not by a suppression above (environmental) and not by an
		// invalidation (the input never landed — there was no offer). The
		// update check stays unconditional for every later offer.
		if (pending === "userinput" && st.waivedNextUserinput) {
			st.pending = null;
			st.waivedNextUserinput = false;
			stampGoalCovered(st, lastReal); // the consumed offer advances the covered watermark
			return;
		}
		if (pending === "sessionstart" && latestGoal(branch) !== undefined) {
			// fire-time re-check — the `sessionstart` (setup-ask) variant ONLY
			// (2026-10-04, Paul: the B update-check is UNCONDITIONAL): the goal
			// was stored while the setup offer was pending (an adjust_goal inside
			// the first agent turn) — the setup ask is moot; the goal record is
			// the provenance. The `userinput` offer is dropped by NOTHING — it
			// fires so the model re-checks the goal against the new input (even
			// directly after its own adjust_goal: the user may have refined it).
			st.pending = null;
			stampGoalCovered(st, lastReal); // a consumed offer advances the covered watermark
			return;
		}
		const text = goalNudgeText(pending);
			pi.appendEntry(NUDGE_LEDGER_CUSTOM_TYPE, goalNudgeLedgerEntry({ variant: pending, now: Date.now() }));
		pi.sendUserMessage(text, { deliverAs: "steer" }); // the D7 channel: mid-turn before the next LLM call; idle ⇒ one short turn
		st.pending = null;
		stampGoalCovered(st, lastReal); // the offer covers the landed input that armed it
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
			if (!nudgeEnabled(process.env)) {
				st.offered = true; // dial off ⇒ no offer (cleared, no deferred queue — parity with the goal offer)
				return;
			}
			const branch = currentBranch(ctx);
			const records = branchSettlementRecords(branch);
			const census = retireCensus(records, (r, sup) => settlementBlock(r, sup), state.ledger.retirements); // 2026-10-18: the census now renders the supersedes metadata + the retired shapes exactly as the takeover does
			const threshold = retireThresholdChars(process.env);
			const decision = retireOfferDecision(st, census, threshold);
			if (decision === "wait") return;
			if (lineIsAuditFork(branch)) {
				// suppressed (D9 pattern: a suppressed decision leaves a trace —
				// the arm stays until the next fold re-arms it)
				const suppressReason = "audit-fork";
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
			if (!nudgeEnabled(process.env)) return; // the nudge-family gate (parity with D7/D11b)
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
				if (name === "adjust_goal" && tr.isError === false) {
					clearGoalPending(state.goalNudge); // retires the pending SESSIONSTART (setup-ask) offer only
					// Bug B (Paul 2026-10-14): the one-shot waiver — the goal was
					// just stored, so the NEXT userinput offer is moot (silent;
					// subsequent offers fire normally).
					waiveNextUserinput(state.goalNudge);
					// Bug A: that consumption advances the covered watermark — the
					// adjust_goal is answering the last landed real user input, so
					// the next real input must be NEWER than it to arm a live offer.
					stampGoalCovered(state.goalNudge, lastRealUserMessage(currentBranch(ctx)));
				}
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
		try {
			samTui.bumpAnchor(ctx); // v0.0.16 fix-up 2: a message was appended — re-read the anchor (tokens + depth), reset the in-flight tail
		} catch {
			// fail-open: a stale bar beats a broken message path
		}
	});

	/** v0.0.16 fix-up 2 (Paul's cache ruling): the in-flight tail of the TUI
	 *  bar. Per-token and tool-stream events touch ONLY the char counters +
	 *  requestRender — never a ctx read (getContextUsage is per-message, at
	 *  message_end / bumpAnchor, and per coarse site via refresh). */
	pi.on("message_update", (event: MessageUpdateEvent) => {
		const d = event.assistantMessageEvent;
		if (d.type === "text_delta" || d.type === "thinking_delta" || d.type === "toolcall_delta") {
			try {
				samTui.onDelta(d.delta.length);
			} catch {
				// fail-open: a missing bump beats a broken stream
			}
		}
	});
	pi.on("tool_execution_update", (event: ToolExecutionUpdateEvent) => {
		try {
			samTui.onToolPartial(event.toolCallId, toolOutputChars(event.partialResult)); // CUMULATIVE — only the growth counts
		} catch {
			// fail-open
		}
	});
	pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
		try {
			samTui.onToolEnd(event.toolCallId, toolOutputChars(event.result)); // final correction, then drop
		} catch {
			// fail-open
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
			if (!nudgeEnabled(process.env)) return; // the nudge-family gate (D7's precedent — one switch for the family)
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
	/* ── context-pressure safenet (decision point 1, Paul 2026-10-16) ───────
 * Part a (the pressure nudge): after EVERY fold, estimate the post-fold
 * context; when it sits within `headroom` of pi's auto-fold line (W−R),
 * send the act-now nudge, arm the auto-retire, and CONSUME the soft retire
 * offer (Q4: the emergency order supersedes the suggestion). Part b (the
 * auto-retire): the armed state is committed at the NEXT fold (takeover
 * hook, before the summary renders) — oldest settled units first, until the
 * remaining stack is under the token-aware target; the model's own
 * retire/unretire in between disarms it (the order was obeyed). F1: every
 * defect degrades to stderr and the fold proceeds without the safenet.
 */

/** The post-fold pressure check (part a). `estimate` = the post-fold context
 *  in tokens (null ⇒ the check is skipped — F3 fail-safe: an unknown
 *  estimate never nudges). `foldId` = span identity (pi's firstKeptEntryId). */
function postFoldPressureCheck(ctx: ExtensionContext, estimate: number | null, foldId: string): void {
	const ladder = state.governor.ladder;
	if (ladder === null) return; // no ladder ⇒ no line ⇒ no nudge (fail-safe)
	const headroom = pressureHeadroomTokens(process.env);
	if (!pressureNudgeDue(ladder, headroom, estimate)) return;
	const lineTokens = pressureLineOf(ladder, headroom);
	try {
		// the D7 channel (same as the retire offer): mid-turn before the next
		// LLM call; idle ⇒ one short turn (the model acts on the order in it).
		pi.sendUserMessage(pressureNudgeText(estimate ?? 0, lineTokens, headroom), { deliverAs: "steer" });
	} catch (err) {
		// F1: a send defect = no nudge (the arming below still stands — the
		// backstop is the safenet; the nudge is the warning).
		console.error(`sam: pressure nudge send failed (the auto-retire still arms): ${err instanceof Error ? err.message : String(err)}`);
	}
	autoRetireArmOnNudge(state.autoRetire, foldId, Date.now()); // part b arm (also marks offerConsumed)
	state.retireOffer.offered = true; // Q4: the soft offer for this span is CONSUMED (the order supersedes the suggestion)
	emit(ctx, `sam: context pressure — the post-fold estimate (~${estimate ?? "?"} tokens) sits within ${headroom} of pi's auto-fold line (~${lineTokens}); act-now nudge sent, auto-retire armed, retire offer consumed`);
}

/** The auto-retire commit (part b), called from the takeover hook BEFORE the
 *  summary renders — so the new summary already reflects the retirement
 *  (the retired units are gone from the settlement stack; the AUTO-RETIRE
 *  block is their only trace). Pure decision (retire.ts) + the durable write
 *  (an autoRetire ledger entry + the synthesized AUTO-RETIRE settlement, both
 *  appendEntry) + the in-memory bookkeeping (the retirements push + the
 *  unit-id bump — the recordCloseInMemory pattern). */
function commitAutoRetireIfDue(ctx: ExtensionContext, records: readonly SamSettlementRecord[], foldId: string): void {
	const superseded = autoRetireSupersededByModel(state.autoRetire, state.ledger.retirements);
	const candidates = autoRetireCandidates(records, state.ledger.retirements);
	const decision = autoRetireDecision(state.autoRetire, superseded, candidates.length);
	if (decision === "disarm") {
		state.autoRetire = createAutoRetireState(); // the arm is spent (the model acted, or nothing to retire); the next pressure nudge re-arms (Q2: no cool-down)
		return;
	}
	if (decision !== "commit") return; // wait — not armed
	const ladder = state.governor.ladder;
	if (ladder === null) {
		state.autoRetire = createAutoRetireState(); // F3: no ladder ⇒ no sizing ⇒ disarm (the next pressure nudge re-arms)
		return;
	}
	const headroom = pressureHeadroomTokens(process.env);
	const target = autoRetireTargetChars(ladder, headroom, retireThresholdChars(process.env));
	const picked = autoRetireSelect(records, state.ledger.retirements, target, settlementBlock);
	if (picked.length === 0) {
		state.autoRetire = createAutoRetireState(); // no candidates (defensive — the decision above says otherwise); disarm
		return;
	}
	const byId = new Map(records.map((r) => [r.unitId, r]));
	const items = picked.map((uid) => {
		const r = byId.get(uid);
		return { unitId: uid, retrievalId: r?.retrievalId ?? "", verdictClass: r?.verdict ?? "" };
	});
	const prev = previousAutoRetire(state.ledger.retirements); // the matryoshka: the immediate predecessor
	const ts = Date.now();
	// deterministic retrieval id for the synthesized settlement (12-hex, the
	// ledger's convention — retrievalIdOf's sha256-12) derived from the fold +
	// the retired units: a rebuild of the same branch state yields the same id.
	const retrievalId = retrievalIdOf("", "autoRetire", `${foldId}:${picked.join(",")}`);
	const unitId = state.ledger.nextUnitId;
	const info =
		picked.map((uid, i) => `u${uid} (${items[i].verdictClass})${items[i].retrievalId !== "" ? ` #${items[i].retrievalId}` : ""}`).join(", ") +
		` — system-retired at fold ${foldId}`;
	const action: AutoRetireAction = {
		v: 1,
		kind: "autoRetire",
		ts,
		foldId,
		unitId,
		retrievalId,
		units: picked,
		items,
		absorbed: prev !== undefined ? { retrievalId: prev.retrievalId, unitId: prev.unitId, units: prev.units } : undefined,
		reason: `context pressure: post-fold estimate within ${headroom} of the auto-fold line; the model did not retire after the act-now nudge (arm fold ${state.autoRetire.foldId})`,
	};
	const infoLine = `${retrievalId} AUTO-RETIRE: ${info}`;
	const settlement: SamSettlementRecord = {
		v: 1,
		kind: "settlement",
		unitId,
		retrievalId,
		verdict: "AUTO-RETIRE",
		sections: { "AUTO-RETIRE": info },
		line: infoLine,
		auditFile: "", // synthesized — no side-branch audit file; retrieveContent serves the line
		replyId: null,
		parsedClean: true,
		ts,
	};
	pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, action);
	pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, settlement);
	// in-memory bookkeeping (the recordCloseInMemory pattern): the retirements
	// push feeds the takeover render BELOW in the same hook; the unit-id bump
	// keeps the synthetic unit out of future close ids (rebuildLedger's
	// maxUnitId rule consumes the same id space — no gap, no reuse).
	state.ledger.retirements.push(action);
	state.ledger.nextUnitId = unitId + 1;
	state.autoRetire = createAutoRetireState(); // committed ⇒ the arm is spent
	emit(ctx, `sam: auto-retire committed — u${picked.join(", ")} system-retired (target ${target} rendered chars; matryoshka ${prev !== undefined ? prev.retrievalId : "none"})`);
}

/** The retrieval ids of the BRANCH's orphan records that are already retired
 *  (their minted unitId is in the retired states) — the takeover drops their
 *  carried blocks (a retired orphan is gone from the summary; the raw span
 *  stays banked). Pure of pi (branch handed in). */
function orphanRetiredIds(branch: readonly PlainEntry[]): Set<string> {
	const retired = retiredStates(state.ledger.retirements);
	const out = new Set<string>();
	for (const e of branch) {
		if (e.kind !== "custom" || e.customType !== SAM_LEDGER_CUSTOM_TYPE) continue;
		const d = e.data as Partial<SamOrphanRecord> | undefined;
		if (d?.kind !== "orphan" || typeof d.retrievalId !== "string") continue;
		if (typeof d.unitId === "number" && retired.has(d.unitId)) out.add(d.retrievalId);
	}
	return out;
}

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
					// context-pressure safenet (2026-10-16, Paul Q3): the orphan is
					// minted a unitId AT FOLD TIME — from this fold on it is
					// retireable (retire_units), unretirable, and
					// sam_retrieve-able as 'unit N' (the id-space bump is the
					// recordCloseInMemory pattern — synthetic units consume the
					// same space, no gap, no reuse).
					orphan.unitId = state.ledger.nextUnitId;
					state.ledger.nextUnitId += 1;
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
			// context-pressure safenet (2026-10-16, part b): a pressure nudge armed
			// the auto-retire since the last fold, and the model did not retire in
			// between ⇒ commit the system retirement HERE, before the summary
			// renders — the new summary already reflects it (the retired units are
			// gone from the settlement stack; the AUTO-RETIRE block is their only
			// trace). F1: a defect degrades to stderr and the fold proceeds without
			// the auto-retire.
			try {
				commitAutoRetireIfDue(ctx, records, String(prep.firstKeptEntryId));
			} catch (err) {
				console.error(`sam: auto-retire commit failed (the fold proceeds without it): ${err instanceof Error ? err.message : String(err)}`);
			}
			return {
				compaction: {
					summary: takeoverSummary(
						prep.previousSummary,
						goal,
						records,
						orphan ?? null,
						// v5 RETIRE (2026-10-06): the render consumes the retire entries
						// (dropped → gone; superseded → one line; the superseding unit
						// gains its supersedes line). 2026-10-16: autoRetire entries
						// ride the same list (their units are dropped; the newest
							// entry renders as the AUTO-RETIRE block).
						state.ledger.retirements,
						// 2026-10-15: carried-orphan cap (SAM_ORPHAN_KEEP, default 2).
						orphanKeepCount(process.env),
						// context-pressure safenet (2026-10-16): orphans ARE retireable
						// now (minted unitId) — the carried blocks of RETIRED orphan
						// units are dropped before the cap (the raw span stays banked).
						orphanRetiredIds(branch),
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

	// v0.0.4 FOLD (Paul 2026-10-14): the fold ack channel — EVERY fold kind
	// (the model's fold_now, the user's /compact, and pi's native
	// threshold/overflow folds) gets a model-visible acknowledgement: a
	// sam-fold-ack CUSTOM MESSAGE (pi.sendMessage — a CustomMessageEntry
	// participates in the LLM context, session-manager.ts:1332; in
	// contrast to appendEntry's ledger records, which never reach the
	// model). For the MODEL-INITIATED fold (reason "manual" with the
	// in-flight flag set by the tool) the ack is DEFERRED to the tool's
	// onComplete — pi emits this event BEFORE the ctx-level onComplete
	// resolves (measured, pinned commit), and only the CompactionResult
	// carries the exact estimatedTokensAfter. The user's manual /compact
	// (reason "manual", flag not set) and the native folds are acked
	// immediately (tokensBefore from the entry — exact; the estimated
	// after is the honest retention-tail phrase).
	// v0.0.12 (Paul 2026-10-18, option 1): the NATIVE folds ack with
	// triggerTurn (measured, pi 0.87.1): while the run is active (the common
	// mid-run catch, agent-session.ts:1135) the steer is queued, and pi's
	// own hasQueuedMessages() continuation (agent-session.ts:2245) fires a
	// new LLM call that STARTS with the ack — the model learns of the fold
	// without a user post (the old deliverAs:"nextTurn" left the ack
	// invisible until the user typed — the bug). Not streaming (the rare
	// pre-send catch of an aborted over-threshold run, :1278) ⇒ one short
	// ack turn before the just-posted message — the accepted cost.
	// User /compact keeps deliverAs:"nextTurn" (never auto-start inference
	// while the user is about to type). F1: an ack defect is a stderr line
	// — a fold never fails because of its ack.
	pi.on("session_compact", (event: SessionCompactEvent, ctx: ExtensionContext) => {
		try {
			const tokensBefore = event.compactionEntry.tokensBefore;
			// v0.0.16: the bar goes to the unknown state (tokens null after ANY
			// fold) and the stack grows — refresh on every fold path (both the
			// immediate and the deferred model-initiated ack).
			samTui.refresh(ctx);
			if (event.reason === "manual" && state.foldInFlight) {
				// model-initiated: defer the ack to the tool's onComplete
				// (it carries the exact CompactionResult); the flag stays set
				// until then (onComplete clears it — the single-flight guard
				// holds across the event→callback gap; pi itself refuses
				// prompt submission while compaction is in progress,
				// agent-session.ts ~1901, so no turn can double-trigger).
				state.foldAckPending = { tokensBefore, fromExtension: event.fromExtension, firstKeptEntryId: String(event.compactionEntry.firstKeptEntryId) };
				return;
			}
			const origin = event.reason === "manual" ? "user" : "native";
			pi.sendMessage(
				{
					customType: FOLD_ACK_CUSTOM_TYPE,
					content: foldAckText({ origin, tokensBefore, estimatedTokensAfter: null, fromExtension: event.fromExtension }),
					display: true,
				},
				origin === "native" ? { triggerTurn: true } : { deliverAs: "nextTurn" },
			);
			// context-pressure safenet (2026-10-16, part a): the post-fold pressure
			// check (AFTER the ack — the model learns the fold happened first,
			// then gets the order). pi's own getContextUsage reports tokens:null
			// right after ANY fold (measured, agent-session.ts — the last
			// assistant usage still reflects the pre-compaction size), so the
			// post-fold context is re-estimated through the SAME formula pi's
			// estimator uses (estimateProjectedTokens over the branch
			// projection — the compaction entry is the checkpoint, the summary
			// message + the retained tail are the context).
			try {
				const postBranch = currentBranch(ctx);
				const estimate = estimateProjectedTokens(buildProjection(postBranch), postBranch).tokens;
				postFoldPressureCheck(ctx, estimate, String(event.compactionEntry.firstKeptEntryId));
			} catch (err) {
				// F1: a check defect = no nudge (the fold stands; the backstop is
				// simply not armed this fold).
				console.error(`sam: post-fold pressure check failed (the fold stands): ${err instanceof Error ? err.message : String(err)}`);
			}
			emit(ctx, `sam: fold complete (${origin}) — ${tokensBefore} tokens folded; the sam-fold-ack is ${origin === "native" ? "sent triggerTurn (the model sees it without a user post)" : "queued for the next turn"}`);
		} catch (err) {
			console.error(`sam: fold ack failed (the fold itself completed): ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// v0.0.4 FOLD: the fold-failure ack — the turn was aborted, nothing was
	// compacted, no state change; the in-flight flag is cleared here so a
	// retry is possible. Aborted (user cancelled mid-fold) ⇒ operator line
	// only (no failed-fold message to the model — there is nothing to
	// report); a genuine failure ⇒ the model sees the failure ack (it might
	// otherwise assume the context shrank). v0.0.5: a genuine
	// MODEL-INITIATED failure restarts the turn too (the model lost its
	// turn and nothing was compacted — it can retry fold_now or continue);
	// aborted stays operator-only (the user may be typing themselves).
	// v0.0.12: a NATIVE failure is auto-acked too (triggerTurn — same
	// rationale as the native success ack: mid-run the steer makes pi's
	// hasQueuedMessages() continuation deliver it, so the model learns the
	// fold failed and the context did NOT shrink); a USER failure stays
	// queued for the next turn (the user may be typing themselves). The
	// flag is read before it is cleared — that is the model-initiated
	// marker at event time.
	pi.on("session_compact_failed", (event: SessionCompactFailedEvent, ctx: ExtensionContext) => {
		try {
			const modelInitiated = state.foldInFlight;
			state.foldInFlight = false;
			state.foldAckPending = null;
			if (event.aborted) {
				emit(ctx, "sam: fold aborted (no state change)");
				return;
			}
			const message = event.errorMessage ?? "compaction failed";
			pi.sendMessage(
				{
					customType: FOLD_ACK_CUSTOM_TYPE,
					content: foldFailText(message),
					display: true,
				},
				modelInitiated || event.reason !== "manual" ? { triggerTurn: true } : { deliverAs: "nextTurn" },
			);
			emit(ctx, `sam: fold failed (no state change): ${message}`);
		} catch (err) {
			console.error(`sam: fold-failure ack failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// v0.0.16 (D8): clear the TUI status line at shutdown — belt and braces on
	// pi's resetExtensionUI (extension widgets are cleared on every session
	// switch too); the explicit teardown is the same-session path.
	pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
		try {
			samTui.shutdown(ctx);
		} catch (err) {
			console.error(`sam: tui status shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
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
		// Anomaly fix (b) (2026-10-02), re-rung 2026-10-17 (MEDIUM AUDIT TIER):
		// a settlement commits only when it UPGRADES the existing one's rung
		// (canSupersede — never an equal-or-lower rung, especially not
		// supersedes === own id; the run-03 [201]–[204] re-settle wave was
		// exactly this). Same guard as the settle drain.
		if (already.has(item.unitId) && !canSupersede(lastSettlementStrengthFor(branch, item.unitId), item.verdict)) {
			console.error(`sam: close-audit unit ${item.unitId} already settled on the branch (idempotence / no-upgrade skip — the staged capture is dropped, the fork file stays banked)`);
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
		// D9 upgrade path, re-rung 2026-10-17: name the LOWER-rung settlement
		// this one replaces (weak-or-medium ⇒ a strictly higher rung lands here).
		if (canSupersede(lastSettlementStrengthFor(branch, item.unitId), item.verdict)) {
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
	 * the crash-safety design): (4) prepare child (the model-free internal
	 * `sam-prepare-audit <n>` command in a fresh MAIN-session process — it
	 * forks there, the rebind contained; the user-facing `/sam audit` command
	 * is REMOVED 2026-10-16 — the child runs the internal entry, not a user
	 * command) → (5) audit child (one model turn on the FORK, hard
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
		decision: CloseAuditDecision, // v0.0.14: the full decision (depthSource rides for the override hint)
	): Promise<{ ok: boolean; line: CloseAuditLine }> {
		// D9: every failure path commits the hatch settlement on the way out
		// (the one-liner below stays the model-facing truth).
		const defer = (reason: CloseAuditDeferReason, why: string): { ok: boolean; line: CloseAuditLine } => {
			commitWeakAudit(pi, ctx, unit.unitId, unit.stub, reason, why, unit.span);
			return {
				ok: false,
				line: { unitId: unit.unitId, form: "unverifiedAuditFailed", reason, why, stubLines: stubLineCount(unit.stub), stubChars: stubCharCount(unit.stub), overrideHint: depthOverrideHint(decision) || undefined },
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
			return defer("prepare-exit-failed", `the prepare child exited ${prep.code} (child output: ${childDiagnosticDetail(prep.stdout, prep.stderr) || "no output"})`);
		}
		const handoff = parsePrepareHandoff(prep.stdout + "\n" + prep.stderr);
		if (handoff === undefined || handoff.unitId !== unit.unitId) {
			return defer("handoff-missing", `the prepare child produced no parseable handoff for this unit (child output: ${childDiagnosticDetail(prep.stdout, prep.stderr) || "empty"})`);
		}
		if (signal?.aborted) return defer("audit-aborted", "the session was interrupted during prepare");

		// (5) audit child — ONE model turn on the fork (the rep-1 mechanism).
		// D8 (2026-10-02), re-rung 2026-10-17 (MEDIUM AUDIT TIER, Paul): depth by
		// dial + zone — auto = LIGHT at/above the band (≥ W−2R, the "last 16k"
		// R-reserve borrow; the child is disposable: one turn, zero tool calls,
		// used no further after the audit), MEDIUM below (the routine close —
		// cheap cross-check, the instruction differs per rung; full is reached
		// only by explicit depth (dial, command, or the model's close_unit
		// depth arg), never by the auto mapping).
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
		// v0.0.14 (Paul): per-depth hard budgets — medium/full get their own dials
		// (SAM_AUDIT_TIMEOUT_MEDIUM_MS / _FULL_MS), each falling back to the shared
		// SAM_AUDIT_TIMEOUT_MS; light keeps the shared budget. The EFFECTIVE number
		// is stamped into the child's env below, so the child-side deadline nudge
		// matches the kill exactly.
		const timeoutMs = auditTimeoutMsForDepth(decision.depth, process.env);
		// MEDIUM AUDIT TIER (2026-10-17): three-way instruction per rung
		// (v0.0.14: the medium rung also hears its own budget up front — the
		// stop-early contract, Paul's approved ruling).
		const instruction = decision.depth === "light"
			? lightAuditInstruction(unit.unitId, auditPayload(unit.unitId))
			: decision.depth === "medium"
				? mediumAuditInstruction(unit.unitId, auditPayload(unit.unitId), timeoutMs)
				: branchAuditInstruction(unit.unitId, auditPayload(unit.unitId));
		// D10-A (2026-10-13, Paul's option A): the audit child must NEVER fold.
		// The parent temporarily flips compaction.enabled=FALSE in the SHARED
		// settings.json (pi's own SettingsManager — proper-lockfile RMW; no
		// file watcher ⇒ the parent's in-memory settings are unaffected),
		// spawns the child in the MAIN agent dir (prompt identity by
		// construction — SYSTEM.md/packages/skills/extensions all resolve as
		// in the parent), and restores the previous value as soon as the
		// child exits (finished OR timed out — the runner resolves only after
		// exit/SIGKILL). The prepare child above is deliberately UNCHANGED
		// (model-free — no assistant turn, control). Crash window: a parent
		// death between arm and disarm leaves compaction off in the shared
		// file — the session_start backstop restores it from the arm marker.
		// Fail-open: if the arm fails the audit runs with compaction on
		// (logged; the takeover + D9 hatch remain the rescue — measured safe
		// in run-03).
		let arm: AuditCompactionArm | undefined;
		try {
			arm = await armAuditCompaction(ctx.sessionManager.getSessionDir(), ctx.cwd, unit.unitId);
		} catch (err) {
			console.error(`sam: D10-A compaction arm failed (${err instanceof Error ? err.message : String(err)}) — the audit child may fold (the takeover + D9 hatch remain the rescue)`);
		}
		let audit: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
		try {
			audit = await closeAuditRunner.run(auditChildArgs(cli, baseArgs, handoff.forkFile, instruction), {
				timeoutMs,
				label: `close-audit-u${unit.unitId}`,
				signal,
				// v0.0.11 (2026-10-17, Paul): stamp the SPAWN time into the audit child's
				// env — the child-side SAM arms its one-shot deadline nudge at 50 % of the
				// budget it reads from SAM_AUDIT_TIMEOUT_MS. The prepare child (the other
				// run site) gets no stamp — it must never receive a nudge. childEnv keeps
				// D7's SAM_NUDGE=off.
				// v0.0.14: the STAMPED budget is the EFFECTIVE one for the decided depth
				// (per-depth dials resolved above) — overriding whatever the parent env
				// carried, so the child's nudge timer matches this close's kill.
				env: { ...childEnv(process.env), [AUDIT_STARTED_AT_ENV]: String(Date.now()), SAM_AUDIT_TIMEOUT_MS: String(timeoutMs) },
			});
		} finally {
			// D10-A: restore compaction NOW — in the FINALLY, so a runner that
			// throws (a spawn failure — the child never started) does not leave
			// compaction off in the shared file. Best-effort: a failed restore
			// keeps the arm marker (the session_start backstop retries from it).
			try {
				arm?.disarm();
			} catch (err) {
				console.error(`sam: D10-A compaction disarm failed (${err instanceof Error ? err.message : String(err)}) — compaction may stay off (the session_start backstop retries from the arm marker)`);
			}
		}
		if (signal?.aborted) return defer("audit-aborted", "the session was interrupted during the audit");
		if (audit.timedOut) {
			// v0.0.14: the message carries the EFFECTIVE budget (the per-depth dial may have set it).
			return defer("audit-timeout", `the audit child outlived its ${timeoutMs} ms audit budget (child output: ${childDiagnosticDetail(audit.stdout, audit.stderr) || "no output"})`);
		}
		if (audit.code !== 0) {
			return defer("audit-exit-failed", `the audit child exited ${audit.code} (child output: ${childDiagnosticDetail(audit.stdout, audit.stderr) || "no output"})`);
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
			// D8: the accepted line-1 contract is depth-bound (pinned). v0.0.11
			// (2026-10-17, Paul): FULL now accepts NYV too — a completed audit that
			// verified nothing settles honestly NOT-YET-VERIFIED (weakest rung,
			// re-auditable); the D9 hatch is reserved for audit-PROCESS failures.
			// MEDIUM accepts VERIFIED / PLAUSIBLE / CORRECTIONS / NOT-YET-VERIFIED
			// (its total-failure escape); LIGHT accepts NOT-YET-VERIFIED (its own
			// contract); the zero-tool delivery check makes no contradiction judgment,
			// so no PLAUSIBLE there.
			const vc = parse.verdict.class;
			// v0.0.11 (2026-10-17, Paul): NYV allowed for the full audit too — a
			// completed audit that verified nothing settles honestly NOT-YET-VERIFIED
			// (weakest rung, re-auditable); the D9 hatch stays reserved for audit-
			// PROCESS failures (timeout, missing/truncated/unparseable reply).
			const accepted = decision.depth === "light"
				? vc === "VERIFIED" || vc === "CORRECTIONS" || vc === "NOT-YET-VERIFIED"
				: decision.depth === "medium"
					? vc === "VERIFIED" || vc === "PLAUSIBLE" || vc === "CORRECTIONS" || vc === "NOT-YET-VERIFIED"
					: vc === "VERIFIED" || vc === "PLAUSIBLE" || vc === "CORRECTIONS" || vc === "NOT-YET-VERIFIED";
			if (!accepted) {
				const contract =
					decision.depth === "light"
						? "NOT-YET-VERIFIED / VERIFIED / CORRECTIONS"
						: decision.depth === "medium"
							? "VERIFIED / PLAUSIBLE / CORRECTIONS / NOT-YET-VERIFIED"
							: "VERIFIED / PLAUSIBLE / CORRECTIONS / NOT-YET-VERIFIED";
				return defer("reply-unparseable", `line 1 of the audit reply is not the ${decision.depth}-depth verdict contract (${contract})`);
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
			// MEDIUM AUDIT TIER (2026-10-17): PLAUSIBLE rides through like the other
			// honest verdicts (the ledger validator accepts the full LedgerVerdictClass).
			verdict:
				record.verdict === "NOT-YET-VERIFIED"
					? "NOT-YET-VERIFIED"
					: record.verdict === "CORRECTIONS"
						? "CORRECTIONS"
						: record.verdict === "PLAUSIBLE"
							? "PLAUSIBLE"
							: "VERIFIED",
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
				? { unitId: unit.unitId, form: "verified", retrievalId: record.retrievalId, stubLines: stubLineCount(unit.stub), stubChars: stubCharCount(unit.stub), overrideHint: depthOverrideHint(decision) || undefined }
				: parse.verdict.class === "CORRECTIONS"
					? { unitId: unit.unitId, form: "corrections", corrections: parse.verdict.corrections ?? "", retrievalId: record.retrievalId, stubLines: stubLineCount(unit.stub), stubChars: stubCharCount(unit.stub), overrideHint: depthOverrideHint(decision) || undefined }
					: parse.verdict.class === "PLAUSIBLE"
						? { unitId: unit.unitId, form: "plausible", note: parse.verdict.note ?? "", retrievalId: record.retrievalId, stubLines: stubLineCount(unit.stub), stubChars: stubCharCount(unit.stub), overrideHint: depthOverrideHint(decision) || undefined }
						: { unitId: unit.unitId, form: "notYetVerified", note: record.sections["NOT-YET-VERIFIED"] ?? "", depth: decision.depth, retrievalId: record.retrievalId, stubLines: stubLineCount(unit.stub), stubChars: stubCharCount(unit.stub), overrideHint: depthOverrideHint(decision) || undefined };
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
		// MEDIUM AUDIT TIER (2026-10-17): STRONG (VERIFIED / CORRECTIONS) is final;
		// MEDIUM (PLAUSIBLE) and WEAK (NOT-YET-VERIFIED / UNVERIFIED) are UPGRADE
		// TARGETS — the re-audit replaces them on success (latest-per-unit wins
		// at takeover).
		if (strength === "STRONG") {
			emit(ctx, `sam: unit ${unitId} is already settled (VERIFIED / CORRECTIONS) — /sam reaudit has nothing to do (the original content is retrievable via /sam retrieve)`, "error");
			return;
		}
		// D9, re-rung 2026-10-17: a MEDIUM (PLAUSIBLE) or WEAK (NOT-YET-VERIFIED
		// light / UNVERIFIED audit-failed) settlement is an UPGRADE target — the
		// re-audit (full, by the command's resolution) replaces it on success.
		emit(ctx, `sam: unit ${unitId} is currently settled with a non-verifying status (${strength === "MEDIUM" ? "PLAUSIBLE" : "light / audit-failed"}) — the re-audit runs now; a full verdict will supersede it`);
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
	const decision = decideCloseAuditDepth(ctx, rec.stub); // 2026-10-06: single derivation (command + marker overrides included)
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

	// v4 (S6): the close_unit tool surface is the v4 copy (N units per turn,
	// synchronous close-time audit, no fold at close) — the only surface
	// since 2026-10-16 (the SAM_AUDIT_DELIVERY dial is REMOVED; the v3
	// 2-tool surface is gone with it).
	const CLOSE_UNIT_TOOL_ACTIVE = CLOSE_UNIT_TOOL_V4;
	const CLOSE_UNIT_PARAMS = {
		type: "object",
		properties: {
			stub: { type: "string", description: CLOSE_UNIT_TOOL_ACTIVE.parametersDescription },
			// v0.0.14 (Paul): the model's per-close depth lever is a FULL OVERRIDE —
			// any of light | medium | full, upgrades AND downgrades (even against
			// a /sam depth session setting). The description frames it as a RARE
			// escape, not the default way (the configured level is the default).
			depth: {
				type: "string",
				enum: ["light", "medium", "full"],
				description:
					"Optional, RARE: the audit depth for THIS close — 'light', 'medium', or 'full' — a full override of the configured level (even a /sam depth session setting) for this one close. Omit it for routine closes (the configured level applies); use it only where the configured audit would be a waste of budget, or to re-audit a failed close at a cheaper rung.",
			},
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
				// v4: this session must not ITSELF be the audited side branch
				// (the rogue-auditor guard, v4-plan §3 step 1). A working main
				// line never carries a [sam-audit] instruction (the main-line
				// invariant), so this cannot false-fire there.
				if (lineIsAuditFork(branch)) {
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
				// v0.0.14 (Paul): the model's per-close depth lever is a FULL OVERRIDE —
				// any of "light" | "medium" | "full", upgrades AND downgrades (R7's
				// upgrade-only ladder is gone). Params arrive untyped: validate
				// membership before use; an unknown value is a no-op, not an error —
				// the close must not be refused over an optional lever.
				const toolDepth: "light" | "medium" | "full" | undefined =
					params.depth === "light" || params.depth === "medium" || params.depth === "full" ? params.depth : undefined;
				const inFlightDecision = decideCloseAuditDepth(ctx, params.stub, toolDepth);
				onUpdate?.({
					content: [{ type: "text", text: `auditing the summary… (${inFlightDecision.depth} audit${inFlightDecision.depthSource === "tool-override" ? ", depth override" : ""} · stub: ${params.stub.split("\n").length} lines · ${params.stub.length} chars)` }],
					details: undefined,
				});

				// D5 (re-audit discriminator): the model's same-stub close re-audits
				// the last weakly-settled unit; a strong settlement is final (the
				// new-unit guard below decides).
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
						let decision: CloseAuditDecision | undefined;
						try {
							decision = decideCloseAuditDepth(ctx, lastClose.stub, toolDepth); // 2026-10-06: single derivation (the carrier marker ⇒ light, as before; v0.0.14: the model's depth-arg FULL override)
							raResult = await runCloseAuditPipeline(pi, ctx, signal, { unitId: lastClose.unitId, stub: lastClose.stub, span: ra.span }, decision);
						} catch (err) {
							console.error(`sam: close-audit unit ${lastClose.unitId} pipeline crashed — the close stays committed: ${err instanceof Error ? err.message : String(err)}`);
							// D9: the pipeline's own catch should have committed the
							// hatch; if it escaped, commit it here (idempotent — a
							// settlement already on the branch wins).
							commitWeakAudit(pi, ctx, lastClose.unitId, lastClose.stub, "pipeline-crashed", "the audit pipeline crashed", ra.span);
							raResult = { ok: false, line: { unitId: lastClose.unitId, form: "unverifiedAuditFailed" as const, reason: "pipeline-crashed" as const, why: "the audit pipeline crashed", stubLines: stubLineCount(lastClose.stub), stubChars: stubCharCount(lastClose.stub), overrideHint: decision === undefined ? undefined : depthOverrideHint(decision) || undefined } };
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
				const decision = decideCloseAuditDepth(ctx, params.stub, toolDepth); // 2026-10-06: single derivation (command + marker overrides included; 2026-10-17: the model's depth-arg upgrade lever, R7)
				// v5 RETIRE light-carry (2026-10-06, Paul: the retire-upgrade close is
				// ALWAYS light — a curated carry-over ("copy selected data from a to
				// b"); the carried-over claims are taken over as-is, not re-derived).
				// The marker (RETIRE-CARRY first stub line — taught by the retire offer)
				// is the deterministic close-time signal: the retire_units entry lands
				// AFTER the close (validateRetireCall requires supersededBy to be a
				// known unit), so no ledger signal exists yet. Absent marker ⇒ the zone
				// decision stands (fail-safe: a full audit is stronger, never wrong).
				const carryMarker = parseRetireCarryMarker(params.stub);
				const record: SamCloseRecord = {
					v: 1,
					kind: "close",
					unitId,
					stub: params.stub,
					toolCallId,
					ts: Date.now(),
					mode: "manual",
					depth: decision.depth,
					depthSource: decision.depthSource, // WHAT decided the rung (v0.0.14: retire-carry > tool-override > command > env > zone)
					depthZone: decision.zone,
					ctxTokens: decision.ctxTokens,
					...(carryMarker !== undefined ? { depthForced: "retire-carry" as const } : {}),
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
						content: [{ type: "text", text: closeAuditResultLine({ unitId, form: "unverifiedAuditFailed", reason: "span-unresolved", why: thisSpan.error, stubLines: stubLineCount(params.stub), stubChars: stubCharCount(params.stub), overrideHint: depthOverrideHint(decision) || undefined }) }],
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
					result = { ok: false, line: { unitId, form: "unverifiedAuditFailed" as const, reason: "pipeline-crashed" as const, why: "the audit pipeline crashed", stubLines: stubLineCount(params.stub), stubChars: stubCharCount(params.stub), overrideHint: depthOverrideHint(decision) || undefined } };
				}
				return {
					content: [{ type: "text", text: closeAuditResultLine(result.line) }],
					details: { unitId, closed: true, audit: result.ok ? "settled" : "unverifiedAuditFailed" },
				};
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
			} finally {
				// v0.0.16: the settlement stack changed on every path — refresh
				// the TUI bar (no-op when not installed).
				samTui.refresh(ctx);
			}
		},
	});

	// D11 (2026-10-02): the goal tools — the stored goal (mutable, latest-
	// wins) + its verbatim retrieval. Unconditional since 2026-10-16 (the
	// SAM_AUDIT_DELIVERY dial is REMOVED — the close surface is the only
	// surface; the rep-3 trace that motivated the env resolver at
	// registration time is obsolete with the dial). Soft expectation only
	// (Paul:
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
	// SURFACE: the pair ships unconditionally (the close surface is the only
	// surface since 2026-10-16 — the retired dials are gone).
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
			} finally {
				samTui.refresh(ctx); // v0.0.16: the rendered stack changed (every path)
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
			} finally {
				samTui.refresh(ctx); // v0.0.16: the rendered stack changed (every path)
			}
		},
	});

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
				} finally {
					samTui.refresh(ctx); // v0.0.16: the goal block changed the O segment (every path)
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

		// v0.0.4 FOLD (Paul 2026-10-14): model-initiated fold — the SAME code
		// path as the user's /compact (pi 0.87.1 agent-session.ts compact()
		// manual path ~2685; the ctx wiring ~3369 — ExtensionToolContext
		// extends ExtensionContext, types.ts:383). The takeover handler
		// (reason-independent) owns the summary; pi's retention cut
		// (keepRecentTokens, default 20 000) rides through verbatim. F1
		// (verified pi source): compact() aborts the calling turn first —
		// the tool's own result is never read by the model; the ack rides a
		// sam-fold-ack custom message (a CustomMessageEntry participates in
		// the LLM context). v0.0.5: the MODEL-INITIATED ack (consumed by the
		// tool's onComplete) is sent triggerTurn — it restarts the turn right
		// after the fold; user/native folds (the session_compact listener)
		// stay queued for the next turn. Dial: SAM_FOLD
		// (DEFAULT ON — fold.ts; the native threshold fold applies either
		// way, the dial only arms the tool + the nudge hint).
		pi.registerTool({
			name: FOLD_NOW_TOOL_ACTIVE.name,
			label: FOLD_NOW_TOOL_ACTIVE.label,
			description: FOLD_NOW_TOOL_ACTIVE.description,
			promptSnippet: FOLD_NOW_TOOL_ACTIVE.promptSnippet,
			promptGuidelines: [...FOLD_NOW_TOOL_ACTIVE.promptGuidelines],
			// F3: never two compactions at once — pi's compact() is
			// fire-and-forget and each call creates a fresh
			// _compactionAbortController (a second call aborts the in-flight
			// first); the SAM-side flag below is the refusal.
			executionMode: "sequential",
			parameters: FOLD_NOW_PARAMS,
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				try {
					if (!foldEnabled(process.env)) {
						return { content: [{ type: "text", text: FOLD_NOW_DISABLED_TEXT }], details: { folded: false, rejected: "disabled" } };
					}
					const branch = currentBranch(ctx);
					// F4: a child fork must not fold (it would burn its one-shot
					// turn and trip the takeover inside the child) — the guard
					// family's one-liner (close_unit/adjust_goal/retire shape).
					if (lineIsAuditFork(branch)) {
						return { content: [{ type: "text", text: FOLD_NOW_AUDIT_FORK_TEXT }], details: { folded: false, rejected: "audit-fork" } };
					}
					// F3: single-flight — a fold already in progress.
					if (state.foldInFlight) {
						return { content: [{ type: "text", text: FOLD_NOW_IN_FLIGHT_TEXT }], details: { folded: false, rejected: "in-flight" } };
					}
					state.foldInFlight = true;
					ctx.compact({
						onComplete: (result) => {
							// pi emits session_compact BEFORE the ctx-level
							// onComplete resolves (measured at the pinned commit,
							// agent-session.ts ~2774 vs ~2800) — the listener has
							// deferred the ack into state.foldAckPending; if it
							// did not run, the ack still lands exactly once here.
							state.foldInFlight = false;
							const pending = state.foldAckPending;
							state.foldAckPending = null;
							const estimated = typeof result.estimatedTokensAfter === "number" && Number.isFinite(result.estimatedTokensAfter) ? result.estimatedTokensAfter : null;
							try {
									pi.sendMessage(
										// display: true — the ack is a real user-visible event (the context just shrank); the TUI shows it, and the CustomMessageEntry participates in the LLM context regardless (the model MUST see it — that is the point).
										{
											customType: FOLD_ACK_CUSTOM_TYPE,
											content: foldAckText({
												origin: "model",
												tokensBefore: pending?.tokensBefore ?? result.tokensBefore,
												estimatedTokensAfter: estimated,
												fromExtension: pending?.fromExtension ?? false,
											}),
											display: true,
										},
										// v0.0.5 (Paul 2026-10-14): triggerTurn — the turn is
										// already dead (F1: compact() aborted it), so
										// sendCustomMessage takes the not-streaming branch
										// → _runAgentPrompt: the ack starts a new LLM turn
										// right after the fold. The agent-settled race is
										// pi's (_deferredSettledActions); even a streaming
										// fallback (agent.followUp) would resume the turn
										// once idle.
										{ triggerTurn: true },
								);
							} catch (ackErr) {
								console.error(`sam: fold ack send failed (the compaction itself completed): ${ackErr instanceof Error ? ackErr.message : String(ackErr)}`);
							}
							// context-pressure safenet (2026-10-16, part a): model folds
							// carry the EXACT post-fold estimate (CompactionResult.
							// estimatedTokensAfter — the re-estimation above is only
							// needed for the native/user folds, whose ack has no
							// estimate). The steer lands with the ack's triggered
							// turn (the model sees the ack, then the order).
							try {
								postFoldPressureCheck(ctx, estimated, pending?.firstKeptEntryId ?? "model");
							} catch (err) {
								console.error(`sam: post-fold pressure check failed (the fold stands): ${err instanceof Error ? err.message : String(err)}`);
							}
							emit(ctx, `sam: fold complete (model-initiated) — ${result.tokensBefore} → ${estimated ?? "?"} tokens; the ack message restarts your turn`);
						},
						onError: (err) => {
							// F1: a failed fold leaves no state change (the
							// session_compact_failed listener sends the model ack
							// and clears the flag — this path is the backstop if
							// that listener never runs).
							state.foldInFlight = false;
							state.foldAckPending = null;
							console.error(`sam: fold failed (no state change): ${err.message}`);
							emit(ctx, `sam: fold failed (no state change): ${err.message}`);
						},
					});
					emit(ctx, "sam: fold triggered — the turn ends; the sam-fold-ack restarts your turn");
					return { content: [{ type: "text", text: FOLD_NOW_TRIGGERED_TEXT }], details: { folded: true, triggered: true } };
				} catch (err) {
					state.foldInFlight = false;
					state.foldAckPending = null;
					return { content: [{ type: "text", text: `fold_now failed (nothing triggered): ${err instanceof Error ? err.message : String(err)}` }], details: { folded: false, rejected: "error" } };
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
				if (head === "depth") {
					// 2026-10-06 (Paul, audit-ergonomics): the in-session audit-depth
					// switch — the ledger record IS the switch (latest-wins, file-
					// derived at every decision site ⇒ survives restart + folds). The
					// env dial SAM_AUDIT_DEPTH stays the machine default (this command
					// overrides it for the session); the RETIRE-CARRY marker stays
					// strongest (a carrier's close is ALWAYS light).
					const target = rest[0];
					if (target === undefined) {
						emit(ctx, auditDepthStatusLine(currentBranch(ctx)));
						return;
					}
					if (!DEPTH_VALUES.includes(target as SamAuditDepth)) {
						emit(ctx, `sam: unknown depth '${target}' — one of: ${DEPTH_VALUES.join(" | ")}`, "error");
						return;
					}
					const depth = target as SamAuditDepth; // the guard above validated membership in DEPTH_VALUES
					const record: SamDepthRecord = { v: 1, kind: "depth", depth, ts: Date.now() };
					pi.appendEntry(SAM_LEDGER_CUSTOM_TYPE, record);
					emit(ctx, `sam: audit depth is now '${target}' (effective from the next close / re-audit; it overrides the env dial SAM_AUDIT_DEPTH for this session — '/sam depth auto' releases back to the default)`);
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
				emit(ctx, `sam: unknown subcommand '${head}' — /sam · /sam goal · report · undo · fold <n> · resolve <n> · reaudit <n> (v4, closed-unsettled unit) · retrieve <id> [\"exact text\"]`, "error");
			} catch (err) {
				// F1 fail-open: the status surface must never take a session down.
				emit(ctx, `sam: internal error (no state changed): ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// 2026-10-16 (Paul): the user-facing `/sam audit` command is REMOVED —
	// the user does not trigger audits (the model does: close_unit + the
	// nudge channels). This VISIBLE normal command is the internal entry the
	// close pipeline's prepare child runs (model-free fork + handoff on
	// stdout). Deliberately visible (not hidden/env-gated): pi's system
	// prompt does not list slash commands (measured vs pi 0.87.1), so
	// registering it changes no model context — the cold-KV constraint is
	// about TOOL signatures, not commands. Re-adding a user command later is
	// one dispatch line: `if (head === "audit") return prepareBranchAudit(…)`.
	pi.registerCommand("sam-prepare-audit", {
		description: "internal entry: the close pipeline's prepare child (model-free fork + handoff) — not an operator command",
		handler: (args: string, ctx: ExtensionCommandContext) => {
			const t = args.trim();
			return prepareBranchAudit(ctx, t === "" ? undefined : parseInt(t, 10));
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

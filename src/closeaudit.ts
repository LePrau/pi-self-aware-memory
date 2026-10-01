/**
 * v4 close-audit (audit-at-close, `SAM_AUDIT_DELIVERY=close`) — pure logic.
 *
 * Design note: dev repo `v4-plan.md` §2–§5 (S2/S4). The v3 building blocks it
 * reuses (findLastAuditTurn / parseBranchAuditReply / buildSettlementRecord /
 * readRawSessionFile, branchaudit.ts) are unchanged. What lives HERE:
 * - the child-command lines (prepare + audit children) and their argv hygiene
 *   (the strip list is total and test-pinned; the live probe
 *   probe-midturn-fork r1/r2 proved the spawn-self shape on real pi 0.87.1);
 * - the prepare handoff parse (plain + RPC-wrapped capture channel — the
 *   rep-0/rep-3 measured channel);
 * - the `SAM_AUDIT_TIMEOUT_MS` dial (default 8 min);
 * - the re-audit-vs-new-unit discriminator (v4 D5: model-driven retry —
 *   committed-unsettled close + same stub ⇒ re-audit the SAME unit; settled
 *   ⇒ new-unit path (the no-work-since-previous-close guard may refuse it));
 * - the one-line toolResults (the main line never sees the audit exchange);
 * - the audit-fork identity signal (a session that is itself being audited
 *   must not run close_unit — the rogue-auditor guard) and the settled-unit
 *   scan (idempotence for the settle drain).
 *
 * The SPAWN itself is glue (index.ts) and is injectable for the suite
 * (no real process in tests).
 */

import { AUDIT_INSTRUCTION_PREFIX } from "./protocol.ts";

/* ── deferred reasons (the fail-open matrix, v4-plan §3/§8) ─────────────── */

export const CLOSE_AUDIT_DEFER_REASONS = [
	"prepare-spawn-failed",
	"prepare-exit-failed",
	"handoff-missing",
	"span-unresolved",
	"audit-spawn-failed",
	"audit-timeout",
	"audit-aborted",
	"audit-exit-failed",
	"reply-missing",
	"reply-unparseable",
	"pipeline-crashed", // handler-level unexpected throw (the close stays committed)
] as const;
export type CloseAuditDeferReason = (typeof CLOSE_AUDIT_DEFER_REASONS)[number];

/* ── the staged capture (committed at the close turn's settle boundary) ─── */

export interface CloseAuditStagedItem {
	unitId: number;
	/** the resolved close-to-close span (units.ts) at close time */
	span: { spanFirstId: string; spanLastId: string; entryIds: string[]; stub: string };
	/** the fork (audit) file the reply was read from — the banked evidence */
	auditFile: string;
	replyId: string;
	replyText: string;
	/** line-1 verdict class (parseVerdict contract) */
	verdict: "VERIFIED" | "CORRECTIONS";
	corrections?: string;
	parsedClean: boolean;
	/** deterministic retrieval id (retrievalIdOf — sam_retrieve / takeover) */
	retrievalId: string;
	stagedAt: number;
}

/* ── child argv builders ────────────────────────────────────────────────── */

/**
 * Flags a spawn-child must never inherit from its parent's command line
 * (total list — a parent launched with any of these would make the child
 * resume the wrong session, attach to the terminal, or fork-attach):
 * session-selection flags (--session/--continue/--resume/--no-session),
 * the fork flag (--fork), the interactive mode flag (--mode <v>), and the
 * print pairing (-p <prompt> / --print <prompt> — the child gets its own).
 * Everything else (model, provider, extensions, thinking wiring, session
 * dir) is inherited on purpose (same env + same HOME config by construction).
 */
export const CHILD_STRIP_FLAGS = [
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--no-session",
	"--mode",
	"--session",
	"--fork",
	"--name",
	"-n",
	"-p",
	"--print",
] as const;

/**
 * Removes the child-incompatible flags from a parent argv slice. TOTAL:
 * known flags drop, everything else passes through untouched. Value
 * handling mirrors pi 0.87.1's own parser (cli/args.ts, source-read):
 * - "--mode"/"--session"/"--fork"/"--name"/"-n" REQUIRE a value (a working
 *   parent always has one) → the value is consumed with the flag;
 * - "-p"/"--print" take an OPTIONAL message value, taken unless it starts
 *   with "@" or with "-" (pi's exact rule) → consumed only in that case;
 * - "--continue"/"--resume"/"--no-session" (and the -c/-r short forms) are
 *   boolean → dropped alone.
 * Stripping "--name" (the session-name echo flag) also drops the child's
 * resume-echo entry (the probe-midturn-fork measured side-effect —
 * probe plan §2.11: stripping keeps one ghost entry out of the fork file).
 */
export function stripIncompatibleArgs(baseArgs: readonly string[]): string[] {
	const ALWAYS_VALUE = new Set<string>(["--mode", "--session", "--fork", "--name", "-n"]);
	const MAYBE_VALUE = new Set<string>(["-p", "--print"]);
	// pi 0.87.1 -p/--print value rule (cli/args.ts): a value is taken unless
	// it starts with "@" or with "-" (a triple-dash token excepted — pi's own).
	const printWouldTake = (tok: string): boolean => !tok.startsWith("@") && (!tok.startsWith("-") || tok.startsWith("---"));
	const out: string[] = [];
	for (let i = 0; i < baseArgs.length; i++) {
		const a = baseArgs[i];
		if ((CHILD_STRIP_FLAGS as readonly string[]).includes(a)) {
			if (ALWAYS_VALUE.has(a)) {
				if (i + 1 < baseArgs.length) i++;
			} else if (MAYBE_VALUE.has(a) && i + 1 < baseArgs.length && printWouldTake(baseArgs[i + 1])) {
				i++;
			}
			continue;
		}
		out.push(a);
	}
	return out;
}


/** The prepare child (model-free): run the v3 `/sam audit <n>` command in a
 * FRESH process on the MAIN session (it forks there — the rebind is
 * contained in the child, the v3 rep-2 lesson). */
export function prepareChildArgs(cli: string, baseArgs: readonly string[], unitId: number): string[] {
	return [cli, ...stripIncompatibleArgs(baseArgs), "-p", `/sam audit ${unitId}`];
}

/** The audit child: one print-mode model turn pinned to the FORK session
 * (the rep-1 mechanism: fresh process, the exact instruction, exit on
 * quiescence) — pinned with `--session <forkFile>`: the STRONGEST pin
 * (measured against pi 0.87.1: `--session <path|id>` accepts the exact file
 * path, and a missing session is a hard, visible error; the alternative
 * `--session-id` resolves by id and — if the id is not found in the session
 * dir — CREATES a fresh session instead of failing, which would silently run
 * the audit on an empty session). `--session` is added only when the
 * inherited base args do not already pin one (they always strip one). */
export function auditChildArgs(cli: string, baseArgs: readonly string[], forkFile: string, instruction: string): string[] {
	const stripped = stripIncompatibleArgs(baseArgs);
	if (!stripped.includes("--session")) stripped.push("--session", forkFile);
	return [cli, ...stripped, "-p", instruction];
}

/* ── prepare handoff parse (the stdout capture channel) ─────────────────── */

export interface PrepareHandoff {
	unitId: number;
	forkFile: string;
	forkSessionId: string;
	instruction: string;
}

function isHandoffShape(v: unknown): v is { unitId: number; forkFile: string; forkSessionId: string; instruction: string } {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.unitId === "number" &&
		typeof o.forkFile === "string" &&
		typeof o.forkSessionId === "string" &&
		o.forkSessionId !== "" &&
		typeof o.instruction === "string" &&
		o.instruction !== ""
	);
}

/**
 * Parses ONE line of a prepare child's output into the handoff. Handles
 * both measured capture forms: the plain `{"sam-branch-prepare":{…}}` line
 * and the RPC/wrapped form where the JSON is embedded as an escaped string
 * in a `.message` field (walk v3 / live-e-shape capture channel).
 */
export function parsePrepareHandoffLine(line: string): PrepareHandoff | undefined {
	const t = line.trim();
	if (t === "" || !t.includes("sam-branch-prepare")) return undefined;
	try {
		const o: unknown = JSON.parse(t);
		if (o && typeof o === "object") {
			const direct = (o as Record<string, unknown>)["sam-branch-prepare"];
			if (isHandoffShape(direct)) return direct;
			if (typeof (o as Record<string, unknown>)["message"] === "string") {
				try {
					const inner = JSON.parse((o as Record<string, unknown>)["message"] as string);
					if (isHandoffShape(inner?.["sam-branch-prepare"])) return (inner["sam-branch-prepare"] as PrepareHandoff);
				} catch {
					// not the escaped form
				}
			}
		}
	} catch {
		// not the handoff line
	}
	return undefined;
}

/** Scans a whole output stream (stdout or stderr) for the handoff line. */
export function parsePrepareHandoff(output: string): PrepareHandoff | undefined {
	for (const line of output.split("\n")) {
		const h = parsePrepareHandoffLine(line);
		if (h !== undefined) return h;
	}
	return undefined;
}

/* ── the audit-timeout dial ─────────────────────────────────────────────── */

export const SAM_AUDIT_TIMEOUT_DEFAULT_MS = 8 * 60_000; // v4-plan D3 default
export const SAM_AUDIT_TIMEOUT_MAX_MS = 24 * 3600_000; // sanity cap (never infinite)

/**
 * `SAM_AUDIT_TIMEOUT_MS` — the hard budget for the audit child. Total:
 * unset / blank / non-numeric / <= 0 / > cap ⇒ the 8-min default (fail-safe,
 * same exact-value convention as the delivery dial).
 */
export function auditTimeoutMs(env: Record<string, string | undefined>, fallback: number = SAM_AUDIT_TIMEOUT_DEFAULT_MS): number {
	const raw = env["SAM_AUDIT_TIMEOUT_MS"];
	if (typeof raw !== "string" || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.floor(n), SAM_AUDIT_TIMEOUT_MAX_MS);
}

/** Prepare-child budget: the v3 banked prepare stages ran in seconds (no
 * model); 120 s is generous without risking a hung prepare holding a turn. */
export const PREPARE_CHILD_DEFAULT_TIMEOUT_MS = 120_000;

/* ── the re-audit vs new-unit discriminator (v4 D5, plan §3 step 2) ─────── */

export interface ReCloseView {
	/** the last close record in view (file-derived; undefined when none) */
	lastCloseUnitId: number | null;
	lastCloseStub: string;
	/** true when that close already carries a settlement/resolve record */
	lastCloseSettled: boolean;
	/** the next unit id to assign (ledger.nextUnitId) */
	nextUnitId: number;
}

export type ReCloseClass = "re-audit" | "new-unit";

/**
 * The D5 retry rule over FILE entries (total, pure): re-close over an
 * UNSETTLED committed close with the SAME stub (trimmed-compare) is a
 * re-audit of that unit (no new unit, no new close record). A settled
 * last close (or a different stub) is a new unit — the
 * no-work-since-previous-close guard then decides whether it is refused.
 */
export function classifyReClose(view: ReCloseView, newStub: string): ReCloseClass {
	if (view.lastCloseUnitId === null) return "new-unit";
	if (view.lastCloseSettled) return "new-unit";
	if (newStub.trim() === view.lastCloseStub.trim()) return "re-audit";
	return "new-unit";
}

/* ── the one-line toolResults (v4-plan §1/§3 step 7; §14 shape) ─────────── */

export type CloseAuditLine =
	| { unitId: number; form: "verified"; retrievalId: string }
	| { unitId: number; form: "corrections"; corrections: string; retrievalId: string }
	| { unitId: number; form: "deferred"; reason: CloseAuditDeferReason; why: string };

/**
 * The close_unit toolResult under the `close` dial. Invariants: one line
 * (the main line never carries the audit exchange), the close is stated
 * effective even on deferral, and the retry affordance names the exact
 * action (re-close with the same stub, or /sam audit N for the operator).
 */
export function closeAuditResultLine(l: CloseAuditLine): string {
	switch (l.form) {
		case "verified":
			return `Unit ${l.unitId} closed — audit VERIFIED (${l.retrievalId})`;
		case "corrections":
			return `Unit ${l.unitId} closed — audit CORRECTIONS: ${l.corrections} (${l.retrievalId})`;
		case "deferred":
			return `Unit ${l.unitId} closed — audit deferred (${l.why}; ${l.reason}). The close is effective; to re-audit, call close_unit again with the same stub (or run /sam audit ${l.unitId}).`;
	}
}

/* ── entry-view helpers (plain AND raw entry shapes; total) ─────────────── */

/** A loose entry view: PlainEntry (`kind`) and RawEntry (`type`) both match. */
export interface LooseEntry {
	id?: string;
	kind?: string;
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown } | undefined;
}

/** Message text of an entry (string or text-block content; total). */
export function looseEntryText(e: LooseEntry): string {
	const c = e.message?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return (c as unknown[])
			.map((b) => (b && typeof b === "object" && "text" in (b as object) ? String((b as { text?: unknown }).text ?? "") : ""))
			.join("");
	}
	return "";
}

function isSamCustomEntry(e: LooseEntry, kind: string, unitId?: number): boolean {
	if (e.kind !== "custom" && e.type !== "custom") return false;
	if (e.customType !== "sam") return false;
	const d = e.data as { kind?: unknown; unitId?: unknown } | undefined;
	if (d?.kind !== kind) return false;
	if (unitId !== undefined && d.unitId !== unitId) return false;
	return true;
}

/**
 * Audit instruction user message (the v3 finder shape: prefix + unit id).
 */
export function isAuditInstructionEntry(e: LooseEntry): boolean {
	if (e.message?.role !== "user") return false;
	const t = looseEntryText(e);
	return t.startsWith(AUDIT_INSTRUCTION_PREFIX) && /^\s*Unit\s*\d+/.test(t.slice(AUDIT_INSTRUCTION_PREFIX.length));
}

/** Units that already carry a settlement OR resolve record (settle idempotence). */
export function settledUnitIds(entries: readonly LooseEntry[]): Set<number> {
	const out = new Set<number>();
	for (const e of entries) {
		for (const kind of ["settlement", "resolve"]) {
			if (isSamCustomEntry(e as LooseEntry, kind)) {
				const d = e.data as { unitId?: unknown } | undefined;
				if (typeof d?.unitId === "number") out.add(d.unitId);
			}
		}
	}
	return out;
}

/** The last close record in view (file-derived; the re-audit key). */
export function lastCloseRecord(
	entries: readonly LooseEntry[],
): { unitId: number; stub: string; toolCallId: string; index: number } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (isSamCustomEntry(e as LooseEntry, "close")) {
			const d = e.data as { unitId?: unknown; stub?: unknown; toolCallId?: unknown } | undefined;
			if (typeof d?.unitId === "number" && typeof d?.stub === "string" && typeof d?.toolCallId === "string") {
				return { unitId: d.unitId, stub: d.stub, toolCallId: d.toolCallId, index: i };
			}
		}
	}
	return undefined;
}

/**
 * Audit-FORK identity (the rogue-auditor guard): TRUE when this line is
 * itself a side-branch audit — the LAST audit-instruction user message sits
 * AFTER the last close record (and a close record exists). A MAIN line never
 * carries a [sam-audit] instruction (the v3 main-line invariant), and a
 * followUp-dial history (instruction preceding a later close record) does
 * NOT fire: only instruction-after-close means "being audited now".
 */
export function lineIsAuditFork(entries: readonly LooseEntry[]): boolean {
	const close = lastCloseRecord(entries);
	if (close === undefined) return false;
	let lastAudit = -1;
	for (let i = 0; i < entries.length; i++) {
		if (isAuditInstructionEntry(entries[i] as LooseEntry)) lastAudit = i;
	}
	return lastAudit !== -1 && lastAudit > close.index;
}

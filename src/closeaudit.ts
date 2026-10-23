/**
 * v4 close-audit (audit-at-close) — pure logic (the only close-audit path since
 * 2026-10-16 — the SAM_AUDIT_DELIVERY dial is REMOVED).
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
import { closeAuditZone, type Ladder, type Zone } from "./governor.ts";
import { samEffectiveRaw } from "./settings.ts"; // v0.0.20/21: the settings dial layer (cycle is call-time-only)

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
	"audit-reply-truncated(length)", // 2026-10-04 (F-12 class): budget exhaustion, not a pipe defect
	"reply-unparseable",
	"pipeline-crashed", // handler-level unexpected throw (the close stays committed)
] as const;
export type CloseAuditDeferReason = (typeof CLOSE_AUDIT_DEFER_REASONS)[number];

/* ── the missing-reply class split (2026-10-04, F-12 class — banked rep-12 u4 ×2) ── */

export type MissingAuditReplyClass = "reply-missing" | "audit-reply-truncated(length)";

/**
 * The missing-reply CLASS, by how the audit child's last turn ended (the
 * FORK FILE carries the child's own measured stopReason; the pipeline site
 * that calls this already knows the child exited 0 — the audit-exit-failed
 * path left earlier).
 * - last turn `stopReason: "length"` = the per-request output budget ran
 *   out mid-generation (measured F-12 u4, BOTH attempts: thinking-only
 *   turns, `output: 1`, thinking fragments "Now" / "F" — a budget limit,
 *   NOT a transport/pipe defect); the child ran to completion and its
 *   final turn was cut;
 * - anything else — no assistant turn at all, or a turn that did not end
 *   truncated ("stop" / "toolUse" / "error" / "aborted" / unknown) — = the
 *   true `reply-missing` shape (transport/pipe / no usable text turn).
 * Total over unknown/absent stopReasons (undefined ⇒ `reply-missing`).
 */
export function missingAuditReplyClass(lastAssistantStopReason: string | undefined): MissingAuditReplyClass {
	return lastAssistantStopReason === "length" ? "audit-reply-truncated(length)" : "reply-missing";
}

/* ── the staged capture (committed at the close turn's settle boundary) ─── */

export interface CloseAuditStagedItem {
	unitId: number;
	/** the resolved close-to-close span (units.ts) at close time */
	span: { spanFirstId: string; spanLastId: string; entryIds: string[]; stub: string };
	/** the fork (audit) file the reply was read from — the banked evidence */
	auditFile: string;
	replyId: string;
	replyText: string;
	/** line-1 verdict class (parseVerdict contract) — D8 adds the light rung,
	 *  2026-10-17 adds PLAUSIBLE (the medium-tier outcome) */
	verdict: "VERIFIED" | "CORRECTIONS" | "PLAUSIBLE" | "NOT-YET-VERIFIED";
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
	"--session-id",
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
 * - "--mode"/"--session"/"--session-id"/"--fork"/"--name"/"-n" REQUIRE a value (a working
 *   parent always has one) → the value is consumed with the flag;
 *   (--session-id added 2026-10-01 by the S9 walk arm: the walk parent passes
 *   --session-id <id> and pi refuses "--session-id combined with --session" —
 *   the per-consumer --session pin is the only session source a child may have);
 * - "-p"/"--print" take an OPTIONAL message value, taken unless it starts
 *   with "@" or with "-" (pi's exact rule) → consumed only in that case;
 * - "--continue"/"--resume"/"--no-session" (and the -c/-r short forms) are
 *   boolean → dropped alone.
 * Stripping "--name" (the session-name echo flag) also drops the child's
 * resume-echo entry (the probe-midturn-fork measured side-effect —
 * probe plan §2.11: stripping keeps one ghost entry out of the fork file).
 */
export function stripIncompatibleArgs(baseArgs: readonly string[]): string[] {
	const ALWAYS_VALUE = new Set<string>(["--mode", "--session", "--session-id", "--fork", "--name", "-n"]);
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


/** The prepare child (model-free): run the internal `sam-prepare-audit <n>`
 * command in a new process ON THE MAIN SESSION — pinned with
 * `--session <mainFile>` (D1, banked from the sam-close-ref reference run
 * 2026-10-01): the banked v3 recipe pins the main session (run-live-ab.mjs
 * E2: `--session-id <main>`); without it the child starts a FRESH EMPTY
 * session where the closed unit does not exist, the prepare refuses, and no
 * handoff is emitted. The pin is the strongest form (exact file path — a
 * miss is a hard, visible error), added AFTER the strip, so an inherited
 * session flag never wins. (2026-10-16, Paul: the user-facing `/sam audit`
 * command is REMOVED — the child runs the internal entry, a visible normal
 * command registered in the same process; the prompt below is its only
 * caller.) */
export function prepareChildArgs(cli: string, baseArgs: readonly string[], mainFile: string, unitId: number): string[] {
	const stripped = stripIncompatibleArgs(baseArgs);
	if (!stripped.includes("--session")) stripped.push("--session", mainFile);
	return [cli, ...stripped, "-p", `/sam-prepare-audit ${unitId}`];
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

/* ── v0.0.14 diagnostic detail (Paul, 2026-10-18: "bank the error in more
 *    detail in the future. cap it at 4kb though, so it does not explode") ── */

/** The 4 KB cap on the banked child-output detail. The detail rides the
 *  D9-hatch REASON (settlement record ⇒ post-compaction summary, and the
 *  model-facing result line) — bounded so a pathological stream cannot
 *  explode the summary. */
export const AUDIT_DIAGNOSTIC_CAP_CHARS = 4096;

/** Labeled, whitespace-normalized tails of a child's captured streams, capped
 *  at `cap` characters TOTAL (the TAIL is kept — the failure is at the end of
 *  the stream). Each present stream is labelled (`stdout: …` / `stderr: …`),
 *  joined by " | " (a label can never be confused with stream content); both
 *  streams empty ⇒ "". */
export function childDiagnosticDetail(
	stdout: string,
	stderr: string,
	cap: number = AUDIT_DIAGNOSTIC_CAP_CHARS,
): string {
	const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
	const parts: string[] = [];
	const out = normalize(stdout);
	if (out !== "") parts.push(`stdout: ${out}`);
	const err = normalize(stderr);
	if (err !== "") parts.push(`stderr: ${err}`);
	const detail = parts.join(" | ");
	if (detail.length <= cap) return detail;
	return detail.slice(detail.length - cap);
}

/* ── the audit-timeout dial ─────────────────────────────────────────────── */

/* D8 (2026-10-02): the audit-depth dial + auto trigger (audit-at-close). */

export type AuditDepth = "auto" | "full" | "medium" | "light";

/**
 * `SAM_AUDIT_DEPTH` — total: exactly "auto", "full", "medium" or "light";
 * anything else (unset / blank / garbage) ⇒ the "auto" default (fail-safe,
 * same exact-value convention as the delivery dial). "auto" = the band
 * trigger below; "full"/"medium"/"light" force the rung regardless of zone.
 * (MEDIUM AUDIT TIER 2026-10-17, Paul: "medium" added as a dial value.)
 */
export function auditDepthOf(env: Record<string, string | undefined>): AuditDepth {
	// v0.0.20: the settings.json dial joins the env dial — env (if set) still
	// wins temporarily; unset env ⇒ the settings value; unset there ⇒ default.
	const raw = samEffectiveRaw("SAM_AUDIT_DEPTH", env); // v0.0.21: in-session > env > settings > default
	if (raw === "full" || raw === "medium" || raw === "light") return raw;
	return "auto";
}

/**
 * CALM-ZONE AUDIT LEVEL (v0.0.14, Paul: the pre-pressure auto level as a
 * SETTING): `SAM_AUDIT_CALM_DEPTH` — the rung the auto decision uses BELOW
 * the band (zone calm / unknown). Exact-value convention: "medium" (the
 * default — unchanged behaviour) or "full"; anything else (unset / blank /
 * garbage) ⇒ "medium" (fail-safe). Above the band the zone stays LIGHT —
 * this setting never reaches the band (the light rung is the band contract,
 * not a preference).
 */
export function calmAuditDepthOf(env: Record<string, string | undefined>): "medium" | "full" {
	// v0.0.20: settings.json dial (same precedence as auditDepthOf above).
	const raw = samEffectiveRaw("SAM_AUDIT_CALM_DEPTH", env); // v0.0.21: in-session > env > settings > default
	if (raw === "full" || raw === "medium") return raw;
	return "medium";
}

/**
 * D8 auto trigger (total, pure): at/above the band (zone "watch" or
 * "action" — ≥ W−2R, the same band the D7 nudge knows) the audit runs
 * LIGHT (one turn, zero tool calls — the Paul contract; the child may use
 * up to the R reserve ≈ the last 16k that pi's compaction line reserves,
 * because the child is disposable: compaction inside it is cancelable and
 * the child is used no further after the audit). Below the band: the
 * CALM-ZONE LEVEL (v0.0.14) — MEDIUM by default, FULL when
 * SAM_AUDIT_CALM_DEPTH=full. (MEDIUM AUDIT TIER 2026-10-17, Paul: "medium
 * is the new default for auto, aside light" — medium is the routine close;
 * FULL is no longer auto-reached, only via this setting, the dial, the
 * /sam depth command, or the model's depth-arg override.)
 */
export function autoAuditDepth(env: Record<string, string | undefined>, zone: string): AuditDepth {
	const mode = auditDepthOf(env);
	if (mode !== "auto") return mode;
	return zone === "watch" || zone === "action" ? "light" : calmAuditDepthOf(env);
}

/**
 * D8 depth decision as a SINGLE DERIVATION (2026-10-03, Paul's rulings: "we
 * use the totalTokens formula in both places" + "let us also transfer the
 * decision into the ledger"); see closeAudit.test.ts/close-audit.test.ts for
 * the pins and the F-14 u1 reproduction that motivated this.
 * zone = closeAuditZone(ladder, ctx.getContextUsage()?.tokens) — the ruler
 * is pi's calculateContextTokens (totalTokens || input + output +
 * cacheRead + cacheWrite — verified at the pinned pi 0.87.1, estimate.js:5)
 * — the SAME metric pi's own compaction trigger (shouldCompact) decides with,
 * so the depth ruling stays coherent with the fold line it exists to serve.
 * depth = autoAuditDepth(env, zone) — the dial always wins.
 * ALL THREE travel together: the caller records the exact values used on the
 * close record (decision-in-ledger) and dispatches the same ones — one
 * number end-to-end, auditable from the session file. Unavailable tokens ⇒
 * strict FULL (no hysteresis, no silent light rung — the pre-2026-10-03
 * default is preserved).
 */
export function closeAuditDecision(
	ladder: Ladder | null,
	ctx: { getContextUsage?: () => { tokens: number | null } | undefined },
	env: Record<string, string | undefined> = process.env,
): { ctxTokens: number | null; zone: Zone; depth: "full" | "medium" | "light"; depthSource: "env" | "zone" } {
	const ctxTokens = ctx.getContextUsage?.()?.tokens ?? null;
	const zone = closeAuditZone(ladder, ctxTokens);
	const depth = autoAuditDepth(env, zone);
	// 2026-10-06 (Paul, audit-ergonomics): the source of the rung (decision-in-
	// ledger) — this one is env or zone; the callers may override with the
	// stronger sources ("command" = /sam depth, "retire-carry" = the marker).
	return { ctxTokens, zone, depth: depth === "auto" ? "full" : depth, depthSource: auditDepthOf(env) !== "auto" ? "env" : "zone" };
}

export const SAM_AUDIT_TIMEOUT_DEFAULT_MS = 8 * 60_000; // v4-plan D3 default
export const SAM_AUDIT_TIMEOUT_MAX_MS = 24 * 3600_000; // sanity cap (never infinite)

/**
 * `SAM_AUDIT_TIMEOUT_MS` — the hard budget for the audit child. Total:
 * unset / blank / non-numeric / <= 0 / > cap ⇒ the 8-min default (fail-safe,
 * same exact-value convention as the delivery dial).
 */
export function auditTimeoutMs(env: Record<string, string | undefined>, fallback: number = SAM_AUDIT_TIMEOUT_DEFAULT_MS): number {
	// v0.0.20: settings.json dial (same precedence — env (if set) wins
	// temporarily; the parse discipline below is unchanged).
	const raw = samEffectiveRaw("SAM_AUDIT_TIMEOUT_MS", env); // v0.0.21: in-session > env > settings > default
	if (typeof raw !== "string" || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.floor(n), SAM_AUDIT_TIMEOUT_MAX_MS);
}

/**
 * Per-depth hard budgets (v0.0.14, Paul: separate timeouts for medium and
 * full): `SAM_AUDIT_TIMEOUT_MEDIUM_MS` / `SAM_AUDIT_TIMEOUT_FULL_MS`, each
 * falling back to the shared `SAM_AUDIT_TIMEOUT_MS` value (unset / blank /
 * garbage ⇒ the shared value; the shared dial's own fail-safe ⇒ 8 min).
 * LIGHT keeps the shared budget as-is (the light audit is one turn — it
 * never comes close). Same exact-value convention; same sanity cap.
 * The parent stamps the EFFECTIVE budget of the decided depth into the
 * audit child's env (as `SAM_AUDIT_TIMEOUT_MS`) so the child's deadline
 * nudge timer matches the kill.
 */
export function auditTimeoutMsForDepth(
	depth: "light" | "medium" | "full",
	env: Record<string, string | undefined>,
): number {
	const shared = auditTimeoutMs(env);
	const key = depth === "medium" ? "SAM_AUDIT_TIMEOUT_MEDIUM_MS" : depth === "full" ? "SAM_AUDIT_TIMEOUT_FULL_MS" : undefined;
	if (key === undefined) return shared;
	// v0.0.20: per-depth settings.json dial — absent ⇒ the shared value
	// (which itself already falls back env → settings → default).
	const raw = samEffectiveRaw(key, env); // v0.0.21: in-session > env > settings > default
	if (typeof raw !== "string" || raw.trim() === "") return shared;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return shared;
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
	/** D9 (2026-10-02): the strength of that settlement (settled only) */
	lastSettlementStrength?: SettlementStrength;
	/** the next unit id to assign (ledger.nextUnitId) */
	nextUnitId: number;
}

export type ReCloseClass = "re-audit" | "new-unit";

/**
 * D9 (2026-10-02): settlement strength for the re-close rule. WEAK = the
 * audit did not verify (the D8 light NOT-YET-VERIFIED / D9 hatch
 * UNVERIFIED-AUDIT-FAILED) — the unit stays upgradable (D5 retry
 * semantics, now with a committed settlement instead of a pending one).
 * MEDIUM = PLAUSIBLE (MEDIUM AUDIT TIER 2026-10-17) — settled, positive-
 * leaning, but upgradeable to a full audit (the model's depth-arg lever).
 * STRONG = VERIFIED / CORRECTIONS — final (reaudit refused, as before).
 * (My naming — flagged, vetoable.)
 */
export type SettlementStrength = "STRONG" | "MEDIUM" | "WEAK";

/**
 * MEDIUM AUDIT TIER (2026-10-17): the ordered RUNG of a settlement verdict
 * (the commit/supersede rule compares rungs, not booleans): 1 = the audit
 * did not verify (WEAK), 2 = PLAUSIBLE (holds up on the quick check),
 * 3 = VERIFIED / CORRECTIONS (thoroughly audited / corrected). A new
 * settlement commits iff it has NO existing settlement for the unit, or its
 * rung is STRICTLY HIGHER (it then supersedes the older one — append-only,
 * latest-per-unit wins at takeover). Same-rung or lower ⇒ skip (no
 * downgrades, no weak-over-weak, strong-idempotence preserved).
 */
export function settlementRung(verdict: string): 1 | 2 | 3 {
	if (verdict === "NOT-YET-VERIFIED" || verdict === "UNVERIFIED-AUDIT-FAILED" || verdict === "UNAUDITABLE")
		return 1; // the not-verified classes (UNAUDITABLE = the gate verdict — same treatment as lastSettlementStrengthFor)
	if (verdict === "PLAUSIBLE") return 2;
	return 3; // VERIFIED / CORRECTIONS
}

/** The rung of a settled unit (from lastSettlementStrengthFor; undefined when unsettled). */
export function strengthRung(strength: SettlementStrength | undefined): 1 | 2 | 3 | undefined {
	if (strength === undefined) return undefined;
	if (strength === "WEAK") return 1;
	if (strength === "MEDIUM") return 2;
	return 3;
}

/** Can a settlement carrying `newVerdict` commit over the unit's existing
 *  settlement of `existingStrength` (undefined = no settlement yet)? */
export function canSupersede(existingStrength: SettlementStrength | undefined, newVerdict: string): boolean {
	const existing = strengthRung(existingStrength);
	return existing === undefined || existing < settlementRung(newVerdict);
}

/**
 * The D5 retry rule over FILE entries (total, pure) — D9 (2026-10-02)
 * adds the upgrade path: an UPGRADEABLE-settled last close (WEAK — audit
 * failed or ran light — or MEDIUM — PLAUSIBLE, the medium tier) + the SAME
 * stub is a re-audit of that unit (a higher-rung audit then REPLACES the
 * settlement — latest-per-unit wins at takeover; the commit guard's rung
 * order is what actually decides what lands). A STRONG-settled last close
 * (or a different stub) is a new unit — the no-work-since-previous-close
 * guard then decides whether it is refused. Unsettled + same stub ⇒
 * re-audit (unchanged).
 */
export function classifyReClose(view: ReCloseView, newStub: string): ReCloseClass {
	if (view.lastCloseUnitId === null) return "new-unit";
	if (view.lastCloseSettled) {
		const upgradeable = view.lastSettlementStrength === "WEAK" || view.lastSettlementStrength === "MEDIUM";
		if (upgradeable && newStub.trim() === view.lastCloseStub.trim()) return "re-audit"; // upgrade (D9 / medium tier)
		return "new-unit";
	}
	if (newStub.trim() === view.lastCloseStub.trim()) return "re-audit";
	return "new-unit";
}

/* ── the one-line toolResults (v4-plan §1/§3 step 7; §14 shape) ─────────── */

export type CloseAuditLine =
	| { unitId: number; form: "verified"; retrievalId: string; stubLines: number; stubChars: number; overrideHint?: string }
	| { unitId: number; form: "corrections"; corrections: string; retrievalId: string; stubLines: number; stubChars: number; overrideHint?: string }
	// D8 (2026-10-02): the light audit (near the fold) — delivered, not verified.
	// v0.0.11 (2026-10-17): `depth` — NYV is now reachable at every depth (full's
	// honest weakest rung, Paul), and the retry affordance names the right lever
	// per depth (an "upgrade to medium" is not an upgrade from full).
	| { unitId: number; form: "notYetVerified"; note: string; depth: "light" | "medium" | "full"; retrievalId: string; stubLines: number; stubChars: number; overrideHint?: string }
	// MEDIUM AUDIT TIER (2026-10-17): the PLAUSIBLE rung — nothing in the
	// session contradicts the stub; cheaply checkable claims are verified,
	// the rest stand plausibility-level (per-fact `plausible:` markers in the
	// sections). The upgrade lever (depth: "full") stays named.
	| { unitId: number; form: "plausible"; note: string; retrievalId: string; stubLines: number; stubChars: number; overrideHint?: string }
	// D9 (2026-10-02): the audit-failure hatch — the settlement committed as
	// UNVERIFIED (audit-failed); the model's summary survives, its claims
	// carry "verify before acting"; the retry affordance (D5) stays named.
	// v0.0.14: `overrideHint` — the "(depth override: X)" visual mark (request A,
	// Paul) when the model set an explicit depth on this close.
	| { unitId: number; form: "unverifiedAuditFailed"; reason: CloseAuditDeferReason; why: string; stubLines: number; stubChars: number; overrideHint?: string };

/** The stub's line count (Paul, 2026-10-05: "how many lines are written to
 *  close_unit, similar to the write tool" — the write tool reports "(N lines)"
 *  in its result; this rides the close_unit ack the same way). */
export function stubLineCount(stub: string | null | undefined): number {
	return stub ? stub.split("\n").length : 0;
}

/** The stub's char count (Paul, 2026-10-06: line count alone is uninformative
 *  — measured over 486 real stubs in the 131 session files: 454 (93 %) are
 *  exactly 1 line, chars range 507–6,188 — the char count is the metric that
 *  varies). Same total-safe fallback as stubLineCount (never undefined/null in
 *  the rendered line). */
export function stubCharCount(stub: string | null | undefined): number {
	return stub ? stub.length : 0;
}

/**
 * The close_unit toolResult under the `close` dial. Invariants: one line
 * (the main line never carries the audit exchange), the close is stated
 * effective on EVERY form (success, light, failure — from D9 onward a close
 * never leaves unsettled), and the retry affordance names the exact action
 * (same-stub re-close, or /sam reaudit N). Wording = pins (house rule).
 */
export function closeAuditResultLine(l: CloseAuditLine): string {
	const hint = l.overrideHint ? ` ${l.overrideHint}` : ""; // v0.0.14 request A: " (depth override: X)"
	switch (l.form) {
		case "verified":
			return `Unit ${l.unitId} closed${hint} — audit VERIFIED (${l.retrievalId}) — stub: ${l.stubLines} line${l.stubLines === 1 ? "" : "s"} · ${l.stubChars} chars`;
		case "corrections":
			return `Unit ${l.unitId} closed${hint} — audit CORRECTIONS: ${l.corrections} (${l.retrievalId}) — stub: ${l.stubLines} line${l.stubLines === 1 ? "" : "s"} · ${l.stubChars} chars`;
		case "notYetVerified":
			// Depth-aware retry affordance (v0.0.14): the depth arg is a FULL
			// OVERRIDE (upgrades AND downgrades — v0.0.11's upgrade-only lever
			// is gone): light offers both upgrades; medium offers the full
			// upgrade and the cheap light downgrade; full offers re-audits at
			// any rung (a cheaper rung can settle the unit after a failure).
			const retry = l.depth === "full"
				? `To re-audit, call close_unit again with the same stub — depth: 'medium' (quick check) or 'light' (settle cheaply), or 'full' again (or run /sam reaudit ${l.unitId}).`
				: l.depth === "medium"
					? `To upgrade to a full audit, call close_unit again with the same stub and depth: 'full' (thorough); to settle cheaply, depth: 'light' (or run /sam reaudit ${l.unitId}).`
					: `To upgrade, call close_unit again with the same stub and depth: 'medium' (quick check) or 'full' (thorough) (or run /sam reaudit ${l.unitId}).`;
			return `Unit ${l.unitId} closed${hint} — audit NOT-YET-VERIFIED: ${l.note} (${l.retrievalId}). Unmarked claims are not yet verified — verify them before acting. ${retry} — stub: ${l.stubLines} line${l.stubLines === 1 ? "" : "s"} · ${l.stubChars} chars`;
		case "plausible": {
			const note = l.note === "" ? "" : `: ${l.note}`;
			return `Unit ${l.unitId} closed${hint} — audit PLAUSIBLE${note} (${l.retrievalId}). No contradiction observed on the quick check; cheaply checkable claims are verified, the rest stand plausibility-level (plausible: markers). To upgrade to a full audit, call close_unit again with the same stub and depth: 'full' (or run /sam reaudit ${l.unitId}). — stub: ${l.stubLines} line${l.stubLines === 1 ? "" : "s"} · ${l.stubChars} chars`;
		}
		case "unverifiedAuditFailed":
			return `Unit ${l.unitId} closed${hint} — audit UNVERIFIED (audit-failed: ${l.why}; ${l.reason}). The close and its summary are committed — the summary is UNVERIFIED: verify its claims before acting. To re-audit, call close_unit again with the same stub — depth: 'full' (thorough), 'medium' (quick check), or 'light' (settle cheaply) (or run /sam reaudit ${l.unitId}). — stub: ${l.stubLines} line${l.stubLines === 1 ? "" : "s"} · ${l.stubChars} chars`;
	}
}

/* ── D10-A (2026-10-13, supersedes D10's throwaway dir): the audit child must NEVER fold ── */

/**
 * D10 — the audit child is spawned with compaction DISABLED (Paul, 2026-10-02:
 * "the child is under no circumstances allowed to fold. the weak audits
 * existence is exactly to get a cheap exit that does not need several turns,
 * and still fits in the free kv cache.").
 *
 * D10-A MECHANISM (2026-10-13, Paul's option A — replaces D10's throwaway
 * child agent dir; pi 0.87.1, source-measured — labeled):
 * - `shouldCompact()` returns false when `settings.enabled === false`
 *   (dist/core/compaction/compaction.js:314ff — the threshold path is dead);
 * - `_checkCompaction()` early-returns on `!settings.enabled`
 *   (dist/core/agent-session.js:2029 — the OVERFLOW-recovery path is dead
 *   too: a non-foldable child that overflows DIES with the un-recovered
 *   overflow error — it cannot produce an auditor reply, so the failure
 *   class is the D9 hatch `UNVERIFIED-AUDIT-FAILED` ("bold-claim-us-with-
 *   caution"); NOT-YET-VERIFIED is contractually impossible without a reply
 *   (D8));
 * - the CLI has NO compaction flag (verified in the D10 row); the only
 *   runtime setter `SettingsManager.setCompactionEnabled`
 *   (settings-manager.ts:850 @ v0.87.1) PERSISTS the GLOBAL
 *   `<agentDir>/settings.json` via a proper-lockfile read-modify-write that
 *   applies ONLY the modified fields (FileSettingsStorage.withLock —
 *   re-reads the file under the lock); there is NO file watcher (the
 *   manager's reload() is explicit-only — agent-session.ts:3296 /
 *   resource-loader.ts:384,402) ⇒ the parent process's IN-MEMORY settings
 *   are unaffected by the toggle (it merged them at its own startup);
 * - therefore: the parent's close_unit handler temporarily flips
 *   `compaction.enabled` to FALSE in the SHARED settings.json, spawns the
 *   audit child in the MAIN agent dir (no PI_CODING_AGENT_DIR — the child is
 *   literally in the main dir), and restores the previous value as soon as
 *   the child exits (finished OR timed out — the runner resolves only after
 *   exit/SIGKILL). The child in the main dir resolves SYSTEM.md, the
 *   settings `packages` relative paths, skills/, extensions/, prompts/,
 *   models-store exactly as the parent does ⇒ the child's prompt is
 *   structurally identical (the D10 bug — the throwaway dir's missing
 *   SYSTEM.md — is gone at the root);
 * - CRASH WINDOW: a parent death between arm and disarm leaves compaction
 *   off in the shared file (a silent landmine for the next fresh process —
 *   no folding, no error, until the context overflows). Mitigation: the ARM
 *   MARKER file (D10A_ARM_MARKER, session dir) records the pre-toggle value;
 *   the session_start backstop restores from it (disarmCrashedAuditArm in
 *   index.ts — total, never throws, idempotent);
 * - if the arm itself fails (settings file locked / pi package unresolvable
 *   in the process): FAIL-OPEN — the child may fold; the takeover + D9 hatch
 *   remain the rescue (measured safe in run-03).
 */

/** The ARM MARKER filename under the session dir (pin). Records the
 *  `compaction.enabled` value in force before the toggle, so the session_start
 *  backstop restores the exact previous value (not blindly `true`). */
export const D10A_ARM_MARKER = "sam-audit-compaction-arm.json";

/** The ARM MARKER content (total shape; validated by parseArmMarker). */
export interface AuditCompactionArmMarker {
	/** The global `compaction.enabled` in force before the toggle (always `true`
	 *  when the marker is written — the arm is a no-op when the user already
	 *  disabled compaction globally, so the backstop never flips a user-
	 *  preference on). */
	prev: boolean;
	/** The unit under audit (diagnostic only). */
	unit: number;
	/** Arm epoch ms (diagnostic only). */
	at: number;
}

/**
 * Pure + total: the current GLOBAL `compaction.enabled` from raw settings
 * JSON. Absent / empty / unparseable / missing key / non-boolean ⇒ `true`
 * (pi's default — `getCompactionEnabled` = `settings.compaction?.enabled ??
 * true`).
 */
export function parseGlobalCompactionEnabled(settingsRaw: string | null | undefined): boolean {
	if (typeof settingsRaw !== "string" || settingsRaw.trim() === "") return true;
	try {
		const parsed: unknown = JSON.parse(settingsRaw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
		const compaction = (parsed as Record<string, unknown>)["compaction"];
		if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) return true;
		const enabled = (compaction as Record<string, unknown>)["enabled"];
		return typeof enabled === "boolean" ? enabled : true;
	} catch {
		return true;
	}
}

/**
 * pi's DEPLOYED compaction token settings (Q5, Paul 2026-10-16: read the
 * live values — "avoid magic numbers"). Pure + total: the positive finite
 * integer values of `compaction.reserveTokens` / `compaction.keepRecentTokens`
 * from raw settings JSON; absent / empty / unparseable / wrong-shape /
 * non-positive fields are simply omitted (the caller falls back to the
 * built-in defaults — `ladderFor`, governor.ts).
 */
export interface ParsedCompactionTokens {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

export function parseCompactionTokens(settingsRaw: string | null | undefined): ParsedCompactionTokens {
	if (typeof settingsRaw !== "string" || settingsRaw.trim() === "") return {};
	try {
		const parsed: unknown = JSON.parse(settingsRaw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const compaction = (parsed as Record<string, unknown>)["compaction"];
		if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) return {};
		const c = compaction as Record<string, unknown>;
		const out: ParsedCompactionTokens = {};
		if (typeof c["reserveTokens"] === "number" && Number.isFinite(c["reserveTokens"]) && (c["reserveTokens"] as number) > 0) {
			out.reserveTokens = Math.floor(c["reserveTokens"] as number);
		}
		if (typeof c["keepRecentTokens"] === "number" && Number.isFinite(c["keepRecentTokens"]) && (c["keepRecentTokens"] as number) > 0) {
			out.keepRecentTokens = Math.floor(c["keepRecentTokens"] as number);
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Pure + total: parse the ARM MARKER. Unparseable / wrong shape ⇒ null (the
 * backstop treats a present-but-unparseable marker as `prev: true` — the
 * conservative restore).
 */
export function parseArmMarker(raw: string | null | undefined): AuditCompactionArmMarker | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const o = parsed as Record<string, unknown>;
		if (typeof o["prev"] !== "boolean" || typeof o["unit"] !== "number" || typeof o["at"] !== "number") return null;
		return { prev: o["prev"], unit: o["unit"], at: o["at"] };
	} catch {
		return null;
	}
}

/**
 * Pure: the backstop decision. Restore `true` only when a marker is present
 * AND it records `prev: true` AND the file currently reads `false` (idempotent
 * — never clobbers a user re-enable, never writes when there is nothing to
 * fix). A present-but-unparseable marker is handled by the caller as
 * `prev: true`.
 */
export function shouldRestoreCompaction(marker: AuditCompactionArmMarker | null, currentEnabled: boolean): boolean {
	return marker !== null && marker.prev === true && currentEnabled === false;
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

/**
 * D9 (2026-10-02): the settlement strength of the LATEST settlement record
 * for a unit in view (file-derived — upgrades append; the newest wins).
 * STRONG = VERIFIED / CORRECTIONS; MEDIUM = PLAUSIBLE (medium tier,
 * 2026-10-17 — settled, upgradeable to a full audit); WEAK =
 * NOT-YET-VERIFIED / UNVERIFIED-AUDIT-FAILED (the D8/D9 settlement classes —
 * everything the audit did not verify). Undefined when the unit has no
 * settlement record.
 */
export function lastSettlementStrengthFor(
	entries: readonly LooseEntry[],
	unitId: number,
): SettlementStrength | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (!isSamCustomEntry(entries[i] as LooseEntry, "settlement", unitId)) continue;
		const v = (entries[i].data as { verdict?: unknown } | undefined)?.verdict;
		if (v === "NOT-YET-VERIFIED" || v === "UNVERIFIED-AUDIT-FAILED") return "WEAK";
		if (v === "PLAUSIBLE") return "MEDIUM";
		if (v === "VERIFIED" || v === "CORRECTIONS") return "STRONG";
		return "WEAK"; // v3-era UNAUDITABLE and unknown ⇒ treat as not-verified
	}
	return undefined;
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

/** The close record for a specific unit in view (file-derived; the newest,
 * if the unit was re-issued). The D5 re-audit key + the /sam reaudit lever
 * both read the unit's own committed record (stub + toolCallId + index) —
 * never a re-quoted model string. */
export function closeRecordForUnit(
	entries: readonly LooseEntry[],
	unitId: number,
): { unitId: number; stub: string; toolCallId: string; index: number } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (isSamCustomEntry(e as LooseEntry, "close", unitId)) {
			const d = e.data as { unitId?: unknown; stub?: unknown; toolCallId?: unknown } | undefined;
			if (typeof d?.stub === "string" && typeof d?.toolCallId === "string") {
				return { unitId, stub: d.stub, toolCallId: d.toolCallId, index: i };
			}
		}
	}
	return undefined;
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

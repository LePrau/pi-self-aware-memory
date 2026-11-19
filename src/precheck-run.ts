/**
 * Stub pre-check — the close-time orchestration (parse → discover → execute),
 * the settings-dial reader, and the circuit-breaker state.
 *
 * Settled design: dev-repo `notes/2026-11-18-stub-precheck-*.md` (Paul + agent,
 * 2026-11-18). The pipeline itself is the pure, tested modules:
 * precheck-parse (entity extraction), precheck-discovery (repo/file candidates
 * from the session entries), precheck-executor (the read-only check commands
 * through an INJECTED runner — in the live close path the runner is a thin
 * adapter over `ctx.executeTool("bash", …)`, so the pre-check commands pass
 * through the same validation, hooks, and permission checks as model-issued
 * calls and land on whichever bash implementation is live).
 *
 * The dial: `prechecks` (SAM_PRECHECKS, onoff, DEFAULT ON — Paul, 2026-11-18;
 * off = no pre-check commands at close time). Pre-1.3.0 pi builds have no
 * `ctx.executeTool` — the close path feature-detects and degrades silently
 * (no pre-check block, the audit instruction is unchanged).
 *
 * The circuit breaker (Paul, 2026-11-18): if ALL bash calls of one pre-check
 * run are hard errors (runner-level failures / unclassifiable — not the
 * expected "not found" negatives the design anticipates), the pre-check is
 * disabled FOR THAT SESSION (in-memory, process-scoped, NOT persistent across
 * reload/restart) and the user gets a message in the SAM-nudge-deferred style.
 * Any single non-hard-error outcome (ok or expected-negative) keeps it enabled.
 *
 * Run: covered by test/precheck-run.test.ts (dial reader, breaker, the
 * PlainEntry→RawEntry adapter, and the full pipeline against a scripted runner).
 */

import type { PlainEntry } from "./projection.ts";
import type { RawEntry } from "./branchaudit.ts"; // type-only: no runtime cycle
import { extractFacts, type ParsedFact } from "./precheck-parse.ts";
import { discoverFromSession, type Discovery } from "./precheck-discovery.ts";
import { runPrechecks, type PrecheckClock, type PrecheckOptions, type PrecheckPositives, type PrecheckResult, type Runner } from "./precheck-executor.ts";
import { samEffectiveRaw } from "./settings.ts";

export const PRECHECKS_ENV = "SAM_PRECHECKS";

/** The `prechecks` dial (onoff, default ON): in-session > env > settings >
 *  default — the house reader (the nudgeEnabled pattern, nudge.ts). */
export function prechecksEnabled(env: Record<string, string | undefined>): boolean {
	const raw = samEffectiveRaw(PRECHECKS_ENV, env);
	return raw !== "off";
}

/** In-memory circuit-breaker state (process-scoped — never persisted; a
 *  process hosts one working session, and the fork-mode summary child shares
 *  it by construction: the breaker protects the session's bash channel, not
 *  a file). The close path reads it BEFORE running and trips it AFTER a
 *  run where every command was a hard error. */
const breaker = { disabled: false, reason: "" };

export function precheckBreakerDisabled(): boolean {
	return breaker.disabled;
}

export function precheckBreakerReason(): string {
	return breaker.reason;
}

export function tripPrecheckBreaker(reason: string): void {
	breaker.disabled = true;
	breaker.reason = reason;
}

/** Test seam — resets the breaker between test runs (the live process never
 *  resets it: the trip lasts the session by design). */
export function _resetPrecheckBreakerForTests(): void {
	breaker.disabled = false;
	breaker.reason = "";
}

/**
 * PlainEntry (the in-memory branch projection) → RawEntry (the session-file
 * shape discovery scans). Only `message` and `compaction` carry discovery
 * signal; the other kinds pass through as inert rows (discovery ignores them).
 * The session-header row (type "session", cwd) is absent from the in-memory
 * branch — the caller supplies the cwd FALLBACK (process.cwd() in the live
 * close path: pi starts the process in the session's working directory).
 */
/** 2026-11-18 (Phase D — summary carry): the compact POSITIVES-ONLY block
 *  for the settlement summary (the "deterministic pre-checks:" section):
 *  "git repos used:" (repos with actual hits only), one line per found
 *  commit, one line per found file (multiple matches joined " and " — no
 *  line-extract). ONLY true facts — no not-found lines, no not-cheaply-
 *  checkable lines, no verbose commit details (Paul's settled exclusions).
 *  Returns "" when there is nothing at all — the caller then omits the
 *  section entirely (confirmed suggestion 3). */
export function renderPrecheckPositives(positives: PrecheckPositives): string {
	const lines: string[] = [];
	if (positives.reposUsed.length > 0) lines.push(`git repos used: ${positives.reposUsed.join(", ")}`);
	for (const c of positives.commitsFound) lines.push(`commit ${c.hash} exists in repo ${c.repo}`);
	for (const f of positives.filesFound) lines.push(`file ${f.claim} exists in ${f.paths.join(" and ")}`);
	return lines.join("\n");
}

export function plainToRawEntries(entries: PlainEntry[]): RawEntry[] {
	return entries.map((e) => {
		if (e.kind === "message") {
			return { id: e.id, type: "message", message: { role: e.message.role, content: e.message.content } };
		}
		if (e.kind === "compaction") {
			return { id: e.id, type: "compaction", summary: e.summary };
		}
		return { id: e.id, type: e.kind };
	});
}

export interface PrecheckRunOptions {
	/** The resolved stub (the claims to check). */
	stub: string;
	/** The in-memory branch (last fold → end is discovery's own window). */
	entries: PlainEntry[];
	/** The injected runner (the ctx.executeTool adapter in the live path). */
	runner: Runner;
	/** Session cwd — the discovery fallback AND the executor's workspace-root
	 *  probe location (the session's working directory). */
	cwd: string;
	/** Optional injected clock (tests); the live path lets the executor run
	 *  the two `date -u` forms itself. */
	clock?: PrecheckClock;
	/** Optional executor options (windowCap etc.). */
	executorOptions?: Partial<PrecheckOptions>;
}

/** The full pipeline at close time: parse the stub, discover repos/files
 *  from the branch, run the read-only checks. NEVER throws — every failure
 *  mode degrades inside the executor (no-result lines) or surfaces as the
 *  result's tallies. */
export async function runClosePrechecks(opts: PrecheckRunOptions): Promise<PrecheckResult> {
	const facts: ParsedFact[] = extractFacts(opts.stub);
	const discovery: Discovery = discoverFromSession(plainToRawEntries(opts.entries), opts.cwd);
	return runPrechecks(facts, discovery, opts.runner, opts.clock, opts.executorOptions ?? {});
}

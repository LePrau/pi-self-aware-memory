/**
 * Host cache ledger — slim port of pi-smart-compact's `app/host-cache-ledger.ts`
 * (v10.0.1 @ ce34692, MIT; 2026-09-30 port list item 2), rebuilt only from
 * REPORTED usage — never inferred from timing (plan §7 rule).
 *
 * What changes for SAM:
 * - their lifetime constants (5 min / 1 h) encode Anthropic-style prompt
 *   cache retention. On the qube llama.cpp route "cold" means KV
 *   eviction/rebuild, whose lifetime we have NOT measured — so the
 *   constants are PARAMETERS here with their Anthropic-flavour labelled,
 *   and the P4 live round is what tunes them (banked 2026-09-30: "lifetime
 *   constants deferred to P4 — Anthropic cache ≠ qube KV").
 * - their `cache_warm` refresh hook has no SAM counterpart (pi 0.87.1
 *   exposes no warm event to extensions); the ledger instead classifies
 *   the rebuilds OUR commits cause: `continuity` (a SAM fold/undo landed in
 *   the interval — the rebuild is the fold's own cost), `idle-expiry`
 *   (gap beyond the lifetime), `foreign` (else — another client or
 *   eviction; >2 in a row is a warn-worthy pattern, their
 *   FOREIGN_REBUILD_WARN_COUNT).
 * - what SAM consumes in P3 is the OBSERVATION + the commit-timing mark:
 *   the fold record carries `commitTiming` ("warm": the fold landed right
 *   after a cache hit, so the NEXT request rebuilds a prefix we just paid
 *   to warm; "cold": a rebuild already happened, the fold rides it;
 *   "unknown": no usage yet). The P1 s5 lesson (nine folds inside 46 s ⇒
 *   nine prefix rebuilds) is operationalized by Batching — all pending
 *   commits at one settle share one boundary (P2 already does this; P3
 *   pins it in tests). Actual "commit when cold" deferral needs live
 *   lifetime tuning ⇒ P4 (labelled, not shipped speculative).
 */

import type { PlainUsage } from "./projection.ts";

/**
 * Rebuild threshold (uncached prompt tokens = input + cacheWrite): ported
 * constant `REBUILD_MIN_TOKENS = 16_384` (their comment: above tool-result
 * tail noise, below a real prefix rebuild). Labelled Anthropic-scale; P4
 * tunes for the qube route.
 */
export const REBUILD_MIN_TOKENS = 16_384;
/** Default prefix lifetime. THEIR 5-minute default, Anthropic-flavoured (labelled). */
export const DEFAULT_LIFETIME_MS = 5 * 60_000;
/** Their FOREIGN_REBUILD_WARN_COUNT, ported verbatim as semantics. */
export const FOREIGN_REBUILD_WARN_COUNT = 3;

export type RebuildCause = "continuity" | "idle-expiry" | "foreign";

export interface CacheLedgerEntry {
	at: number;
	prompt: number;
	uncached: number;
	cacheRead: number;
	/** gap since the previous observed request (absent for the first) */
	gapMs?: number;
	rebuild: boolean;
	cause?: RebuildCause;
	/** a SAM commit landed in (prevAt, at] — attributes the rebuild to us */
	commit?: "fold" | "undo" | "close-audit";
	/** set on the rebuild that makes the foreign count reach the warn count */
	warn?: true;
}

export interface CacheLedgerSummary {
	requests: number;
	rebuilds: Record<RebuildCause, number>;
	foreignStreak: number;
}

export interface HostCacheLedger {
	/** New session: forget all state. */
	reset(): void;
	/** A SAM commit landed at `at`; attributes the next observed rebuild. */
	noteCommit(kind: "fold" | "undo" | "close-audit", at: number): void;
	/** An assistant message end (their `observe`); null when no usable usage. */
	observe(usage: PlainUsage | undefined, at?: number, modelTimestampMs?: number): CacheLedgerEntry | null;
	summary(): CacheLedgerSummary;
	/**
	 * Commit-timing mark for a fold landing at `at`: "cold" when a rebuild
	 * already happened within `lifetimeMs` (we ride it), "warm" when the
	 * prefix is still hot (we pay the next rebuild), "unknown" before the
	 * second observed request.
	 */
	commitTiming(at: number, lifetimeMs?: number): "warm" | "cold" | "unknown";
}

export function createHostCacheLedger(opts?: { rebuildMinTokens?: number; lifetimeMs?: number }): HostCacheLedger {
	const rebuildMinTokens = opts?.rebuildMinTokens ?? REBUILD_MIN_TOKENS;
	const lifetimeMs = opts?.lifetimeMs ?? DEFAULT_LIFETIME_MS;

	let previousAt: number | undefined;
	let pendingCommit: "fold" | "undo" | "close-audit" | undefined;
	let foreignCount = 0;
	let entries: CacheLedgerEntry[] = [];

	const reset = (): void => {
		previousAt = undefined;
		pendingCommit = undefined;
		foreignCount = 0;
		entries = [];
	};
	reset();

	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

	return {
		reset,
		noteCommit(kind, at) {
			pendingCommit = kind;
			if (previousAt !== undefined && at < previousAt) previousAt = at; // commits between requests
		},
		observe(usage, at, modelTimestampMs) {
			const input = num(usage?.input);
			const cacheRead = num(usage?.cacheRead);
			const cacheWrite = num(usage?.cacheWrite);
			const prompt = input + cacheRead + cacheWrite;
			if (prompt === 0) return null; // aborted/failed requests report nothing
			const uncached = input + cacheWrite;
			const time = at ?? (typeof modelTimestampMs === "number" ? modelTimestampMs : Date.now());
			const entry: CacheLedgerEntry = { at: time, prompt, uncached, cacheRead, rebuild: false };

			if (previousAt !== undefined) {
				entry.gapMs = Math.max(0, time - previousAt);
				if (uncached >= Math.max(rebuildMinTokens, 0.5 * prompt)) {
					entry.rebuild = true;
					entry.cause = pendingCommit ? "continuity" : time - previousAt > lifetimeMs ? "idle-expiry" : "foreign";
					if (pendingCommit) entry.commit = pendingCommit;
					if (entry.cause === "foreign") {
						foreignCount++;
						if (foreignCount === FOREIGN_REBUILD_WARN_COUNT) entry.warn = true;
					} else {
						foreignCount = 0;
					}
				}
			}
			entries.push(entry);
			previousAt = time;
			pendingCommit = undefined;
			return entry;
		},
		summary() {
			const rebuilds: Record<RebuildCause, number> = { continuity: 0, "idle-expiry": 0, foreign: 0 };
			for (const entry of entries) if (entry.rebuild && entry.cause) rebuilds[entry.cause]++;
			return { requests: entries.length, rebuilds, foreignStreak: foreignCount };
		},
		commitTiming(at) {
			const life = opts?.lifetimeMs ?? DEFAULT_LIFETIME_MS;
			const relevant = entries.filter((e) => e.at < at);
			if (relevant.length < 2) return "unknown";
			const last = relevant[relevant.length - 1];
			const lastRebuild = [...relevant].reverse().find((e) => e.rebuild);
			if (lastRebuild !== undefined && at - lastRebuild.at <= life) return "cold";
			if (at - last.at <= life && last.cacheRead > 0) return "warm";
			return "cold";
		},
	};
}

/**
 * Option B (v0.0.24, WISHLIST fork-child-session-size, 2026-10-24): the REDUCED
 * child session file for the branch audit.
 *
 * The audit child session file no longer carries the full root→leaf history of
 * the main session (pi's `createBranchedSession` copies it — measured 73 forks =
 * 781.6 MB from one 21.35 MB 3-day session). Instead it carries exactly the
 * compaction-aware active path: **the pi-fork entry list truncated at the last
 * compaction's `firstKeptEntryId`**.
 *
 * Invariant (pinned by the pi-semantics equivalence test): pi's
 * `buildContextEntries(full path)` and `buildContextEntries(reduced entries)`
 * produce the SAME context — truncation drops only entries before
 * `firstKeptEntryId`, which `buildContextEntries` never projects (its
 * `foundFirstKept` guard).
 *
 * Pure + total (house style): never throws, `undefined` when no usable path.
 * Ports the two small pi code sections it must agree with (path walk = pi's
 * `buildSessionPath`; label filter + re-chain = pi's `createBranchedSession`,
 * minus the label re-creation, D2): verified identical at pi v0.87.1 / v1.3.0 /
 * v1.4.0 (source-read; the gate's equivalence test re-checks the projection
 * semantics against each gated pi's own dist).
 *
 * Design + decisions D1–D8: dev repo notes/2026-10-24-reduced-fork-child.md.
 */

import type { RawEntry } from "./branchaudit.ts";

/** A compaction entry as it appears in a session file. */
export interface RawCompactionEntry extends RawEntry {
	type: "compaction";
	summary?: string;
	firstKeptEntryId?: string | null;
}

/** The reduced fork file's content (header written by the caller, D5). */
export interface ReducedFork {
	/** The entries to write after the header — path order (root→leaf),
	 *  labels excluded (D2), re-chained linearly (first entry's parentId null,
	 *  each next entry's parentId = the previous entry's id). */
	entries: RawEntry[];
	/** True when the leaf path contains a compaction entry — the only case
	 *  where the reduced file is smaller than the full fork (D3: no
	 *  compaction ⇒ the caller keeps pi's own `ctx.fork`). */
	truncated: boolean;
}

/**
 * Builds the reduced fork file's entry list from a main session file's raw
 * entries (header line included — it is skipped) and the current leaf id.
 *
 * Total: unreadable shape / empty / unknown leaf ⇒ `undefined` (the caller
 * falls back to pi's full-path `ctx.fork` — D3).
 */
export function buildReducedFork(entries: RawEntry[], leafId: string | null | undefined): ReducedFork | undefined {
	if (!Array.isArray(entries) || typeof leafId !== "string" || leafId === "") return undefined;

	// byId over non-header entries (pi's buildEntryIndex: last occurrence wins).
	const byId = new Map<string, RawEntry>();
	for (const e of entries) {
		if (e === undefined || e === null || typeof e !== "object") continue;
		if (typeof e.id !== "string" || e.id === "") continue;
		if (e.type === "session") continue; // the header line is not a path entry
		byId.set(e.id, e);
	}

	// Path walk from the leaf (pi's buildSessionPath: parentId links to root;
	// a missing id terminates the walk).
	const leaf = byId.get(leafId);
	if (leaf === undefined) return undefined;
	const path: RawEntry[] = [];
	let current: RawEntry | undefined = leaf;
	while (current !== undefined) {
		path.push(current);
		// explicit annotation: tsgo 7.0.2 (the gate's compiler) reports TS7022
		// for an unannotated const initialized from a let that is reassigned
		// in the same loop body using that const (probe 2026-10-24).
		const pid: string | null | undefined = current.parentId;
		current = typeof pid === "string" && pid !== "" ? byId.get(pid) : undefined;
	}
	path.reverse();
	if (path.length === 0) return undefined;

	// Label filter + re-chain (pi's createBranchedSession step, minus the
	// label re-creation — D2): labels are dropped, the kept entries are
	// re-linked linearly, and each compaction's firstKeptEntryId is remapped
	// through the labels that preceded it.
	const kept: RawEntry[] = [];
	const replacementByLabelId = new Map<string, string>();
	let pendingLabelIds: string[] = [];
	let pathParentId: string | null = null;
	for (const entry of path) {
		if (entry.type === "label") {
			pendingLabelIds.push(entry.id);
			continue;
		}
		for (const labelId of pendingLabelIds) replacementByLabelId.set(labelId, entry.id);
		pendingLabelIds.length = 0;
		if (entry.type === "compaction") {
			const fk = (entry as RawCompactionEntry).firstKeptEntryId;
			kept.push({
				...entry,
				parentId: pathParentId,
				// fk can be null (raw files are lenient) — only strings are remappable
				firstKeptEntryId: fk === undefined || fk === null ? fk : fk === entry.id ? entry.id : (replacementByLabelId.get(fk) ?? fk),
			});
		} else {
			kept.push({ ...entry, parentId: pathParentId });
		}
		pathParentId = entry.id;
	}
	if (kept.length === 0) return undefined;

	// Truncation at the LAST compaction's firstKeptEntryId (the invariant):
	// everything before it is never projected by buildContextEntries.
	let compaction: RawCompactionEntry | undefined;
	for (const e of kept) {
		if (e.type === "compaction") compaction = e as RawCompactionEntry;
	}
	let out = kept;
	if (compaction !== undefined) {
		const fk = compaction.firstKeptEntryId;
		const fIdx = typeof fk === "string" && fk !== "" ? out.findIndex((e) => e.id === fk) : -1;
		if (fIdx > 0) {
			out = out.slice(fIdx);
			out[0] = { ...out[0], parentId: null }; // the chain now starts here
		}
	}
	return { entries: out, truncated: compaction !== undefined };
}

// v0.0.26 (2026-10-26): the stale-session tool exposure fix — pure core.
//
// The measured defect (pi 1.3.0, tag v1.3.0 / 71023aec1,
// packages/coding-agent/src/core/agent-session.ts): a process that RESUMES a
// session predating an extension upgrade first activates ALL extension tools
// (`_buildRuntime({ includeAllExtensionTools: true })`) and then REPLACES the
// active set with the transcript's declared toolsAdded (`_restoreToolsFromTranscript`
// — a replacement, not a merge). A tool registered by the new build (update_unit,
// v0.0.25) is therefore DROPPED from the active set in the stale session. The
// active set is authoritative twice (extensions/types.ts: "The active tool set
// is the set declared to the model"): it defines the declared function list AND
// callability (`_getCallableTools` requires active for direct-exposure tools) —
// so the tool is invisible AND unroutable. A fold never heals it:
// `appendCompaction` stores `getCurrentSystemMessage(...)` as the compaction
// entry's `systemMessage` ("the compaction entry carries their replay") — the
// stale declaration is replayed, never rebuilt. Nothing else re-adds the tool:
// `refreshTools` (no options) only handles exposure changes of tools already in
// the registry; session-tree navigation calls `_restoreToolsFromTranscript` again.
//
// The fix (wired in extensions/self-aware-memory/index.ts): (1) the MAIN session
// stamps a `sam/version` marker entry at session_start (provenance: "this
// session was first touched by SAM <version>"); (2) EVERY process (main, stub
// child, audit child) heals at session_start: missing SAM tool = registered
// (getAllTools) but not active (getActiveTools) → pi.setActiveTools adds it; the
// next request's declareToolChanges emits the toolsAdded delta into the
// transcript, which then carries the tool across future resumes and forks
// (self-healing). (3) The fork-mode close backstops in runStubChildStage: if
// update_unit is not active there, fail fast with the main-mode fallback text
// instead of a 480 s stub timeout.
//
// This module is pure (no pi runtime import — house style); the wiring reads
// pi.getActiveTools()/getAllTools()/setActiveTools — all three present in the
// ExtensionAPI of the supported pi versions (0.87.1 types.ts:1518-1524,
// 1.3.0 agent-session.ts:3452-3456, 1.4.0 agent-session.ts:3485).

import type { PlainEntry } from "./projection.ts";

/** The custom entry type of the session version marker (NOT the ledger type —
 * the ledger rebuild counts unknown kinds as malformed). */
export const SAM_VERSION_CUSTOM_TYPE = "sam/version";

/** The SAM tools registered by THIS build (the 8 tool names — the two
 * close_unit/fold_now dial variants share their base name). A new SAM tool
 * must be added here: the heal only covers the listed names. */
export const SAM_TOOL_NAMES = [
	"close_unit",
	"update_unit",
	"retire_units",
	"unretire",
	"adjust_goal",
	"read_goal",
	"fold_now",
	"sam_retrieve",
] as const;

/** The session version marker (customType `sam/version`, `v: 1`). */
export interface SamVersionMarker {
	v: 1;
	/** the SAM_VERSION string of the build that first touched the session */
	version: string;
	/** epoch ms */
	ts: number;
}

/** True when `data` is a well-formed version marker record. */
export function isSamVersionMarker(data: unknown): data is SamVersionMarker {
	if (typeof data !== "object" || data === null) return false;
	const m = data as Record<string, unknown>;
	return m.v === 1 && typeof m.version === "string" && m.version !== "" && typeof m.ts === "number";
}

/** All version markers on the branch, in entry order (the first write is the
 * session's first touch by a SAM build). */
export function samVersionMarkers(branch: readonly PlainEntry[]): SamVersionMarker[] {
	const out: SamVersionMarker[] = [];
	for (const e of branch) {
		if (e.kind === "custom" && e.customType === SAM_VERSION_CUSTOM_TYPE && isSamVersionMarker(e.data)) {
			out.push(e.data);
		}
	}
	return out;
}

/** The latest marker (highest ts; the first entry wins ties) — undefined when
 * the branch has none (a session that predates versioning). */
export function latestSamVersion(branch: readonly PlainEntry[]): string | undefined {
	const markers = samVersionMarkers(branch);
	if (markers.length === 0) return undefined;
	let best = markers[0];
	for (const m of markers.slice(1)) if (m.ts > best.ts) best = m;
	return best.version;
}

/** Numeric dot-tuple compare ("0.0.25" < "0.0.26" < "0.1.0"); used for the
 * warning text ("older"/"newer") — the DETECTION itself is exact string
 * inequality plus the missing-tool diff (any mismatch is stale, including a
 * downgrade). Non-numeric segments compare as strings, longest-segment-first. */
export function compareSamVersion(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const x = pa[i] ?? "";
		const y = pb[i] ?? "";
		const nx = Number(x);
		const ny = Number(y);
		if (Number.isFinite(nx) && Number.isFinite(ny)) {
			if (nx !== ny) return nx < ny ? -1 : 1;
			continue;
		}
		if (x === y) continue;
		return x < y ? -1 : 1;
	}
	return 0;
}

/** The missing SAM tools: registered (present in `registered`, i.e. in
 * pi.getAllTools()) but not active (absent from `active`, i.e. in
 * pi.getActiveTools()). Order: SAM_TOOL_NAMES order. */
export function missingSamTools(
	samToolNames: readonly string[],
	registered: ReadonlySet<string>,
	active: ReadonlySet<string>,
): string[] {
	return samToolNames.filter((n) => registered.has(n) && !active.has(n));
}

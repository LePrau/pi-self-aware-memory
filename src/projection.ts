/**
 * Plain-entry model + projection — a minimal, dependency-free mirror of pi's
 * session-entry / projection semantics, pinned to pi **v0.87.1**
 * (`packages/coding-agent/src/core/session-manager.ts`, tag v0.87.1 in
 * `pi-agent/git/pi-mirror`).
 *
 * Why: the product logic (span resolution, folding, ledger rebuild, estimate)
 * must be unit-testable without a pi runtime. The extension entry-point maps
 * pi's `SessionEntry[]` onto this model before calling the pure modules, and
 * `test/pi-semantics.test.ts` cross-checks this mirror against pi's real
 * `SessionManager.buildSessionProjection()` on identical synthetic inputs.
 *
 * Scope of the mirror (documented, deliberate):
 * - branch = a flat ordered entry list (no tree/leaf walking — pi's
 *   `getBranch()` already hands us the active branch);
 * - latest context_edit wins per target; `null` replacement = omit the entry's
 *   messages from the projection, raw entry stays in the file;
 * - string replacements are normalized to a single text block for the
 *   array-only roles (assistant, toolResult) — pi's `projectContextEntry`
 *   does exactly this;
 * - custom entries contribute no messages (never sent to the LLM);
 * - the newest compaction entry contributes its summary message; older ones
 *   contribute none (pi keeps only the newest checkpoint in projection).
 */

/** A content block (subset of pi's content block shapes). */
export type PlainBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; name: string; arguments: Record<string, unknown> }
	| { type: "image"; text?: string };

export type PlainContent = string | PlainBlock[];

/** Provider usage as reported on an assistant message (pi's `Usage`, subset). */
export interface PlainUsage {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** A message (subset of pi's `AgentMessage` union, v0.87.1). */
export interface PlainMessage {
	role:
		| "system"
		| "user"
		| "assistant"
		| "toolResult"
		| "compactionSummary"
		| "branchSummary"
		| "custom"
		| "bashExecution";
	/**
	 * user/assistant/toolResult/system/custom: the content;
	 * compactionSummary/branchSummary use `summary`; bashExecution uses
	 * `command`/`output` (content stays "").
	 */
	content: PlainContent;
	/** compactionSummary/branchSummary only (pi's summary) */
	summary?: string;
	/** assistant only */
	usage?: PlainUsage;
	/** assistant only (pi's StopReason, full union) */
	stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
	/** toolResult only */
	toolCallId?: string;
	/** toolResult only */
	toolName?: string;
	/** toolResult only */
	isError?: boolean;
	/** custom message only (pi's `CustomMessage.customType`) */
	customType?: string;
	/** bashExecution only (pi's `BashExecutionMessage`) */
	command?: string;
	/** bashExecution only */
	output?: string;
}

/** A session entry (subset of pi's `SessionEntry` union). */
export type PlainEntry =
	| { id: string; kind: "message"; message: PlainMessage }
	| { id: string; kind: "context_edit"; targetId: string; replacement: { content: PlainContent } | null }
	| { id: string; kind: "custom"; customType: string; data?: unknown }
	| {
			id: string;
			kind: "compaction";
			summary: string;
			/** first entry (before the compaction) that is kept in the projection */
			firstKeptEntryId: string;
			/** pi snapshots the current system message into the compaction entry */
			systemMessage?: PlainMessage;
		};

/** One projected entry: a source entry plus the messages it contributes. */
export interface ProjectedEntry {
	sourceEntryId: string;
	messages: PlainMessage[];
}

/** A projection: per-entry messages plus the flattened message list. */
export interface PlainProjection {
	entries: ProjectedEntry[];
	messages: PlainMessage[];
}

/** Normalize a string replacement for array-only roles (pi: projectContextEntry). */
function normalizeReplacement(role: PlainMessage["role"], content: PlainContent): PlainContent {
	if ((role === "assistant" || role === "toolResult") && typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content;
}

/**
 * Project a branch (ordered entry list) into the model-visible message list.
 * Pure; mirrors pi v0.87.1 `buildSessionProjection` for the scope documented
 * above.
 */
export function buildProjection(entries: PlainEntry[]): PlainProjection {
	// pi v0.87.1 `buildContextEntries`: the newest compaction is the checkpoint;
	// entries before it are kept only from its firstKeptEntryId onwards
	// (system messages there are dropped — the compaction snapshots them).
	let compIdx = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].kind === "compaction") {
			compIdx = i;
			break;
		}
	}

	let contextEntries: PlainEntry[];
	if (compIdx === -1) {
		contextEntries = entries;
	} else {
		const comp = entries[compIdx];
		if (comp.kind !== "compaction") throw new Error("unreachable");
		contextEntries = [comp];
		let foundFirstKept = false;
		for (let i = 0; i < compIdx; i++) {
			const entry = entries[i];
			if (entry.id === comp.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept && !(entry.kind === "message" && entry.message.role === "system")) {
				contextEntries.push(entry);
			}
		}
		for (let i = compIdx + 1; i < entries.length; i++) contextEntries.push(entries[i]);
	}

	// Latest edit wins per target — edits from entries outside the kept range
	// are ignored (pi builds the edit map from contextEntries only).
	const edits = new Map<string, { content: PlainContent } | null>();
	for (const entry of contextEntries) {
		if (entry.kind === "context_edit") {
			edits.set(entry.targetId, entry.replacement);
		}
	}

	const projected: ProjectedEntry[] = [];
	contextEntries.forEach((entry, index) => {
		if (entry.kind === "message") {
			const edit = edits.get(entry.id);
			if (edit === null) {
				projected.push({ sourceEntryId: entry.id, messages: [] });
				return;
			}
			if (edit === undefined) {
				projected.push({ sourceEntryId: entry.id, messages: [entry.message] });
				return;
			}
			// pi's projectContextEntry: a replacement only rewrites the content of
		// user/assistant/toolResult/custom messages; every other role passes
		// through untouched.
			const role = entry.message.role;
			const rewritable = role === "user" || role === "assistant" || role === "toolResult" || role === "custom";
			if (!rewritable) {
				projected.push({ sourceEntryId: entry.id, messages: [entry.message] });
				return;
			}
			const content = normalizeReplacement(role, edit.content);
			projected.push({
				sourceEntryId: entry.id,
				messages: [{ ...entry.message, content }],
			});
		} else if (entry.kind === "compaction") {
			// Only the newest compaction (index 0 of the kept range) contributes.
			const messages: PlainMessage[] = [];
			if (index === 0) {
				if (entry.systemMessage) messages.push(entry.systemMessage);
				messages.push({ role: "compactionSummary", content: "", summary: entry.summary });
			}
			projected.push({ sourceEntryId: entry.id, messages });
		} else {
			// context_edit / custom: never messages.
			projected.push({ sourceEntryId: entry.id, messages: [] });
		}
	});
	return { entries: projected, messages: projected.flatMap((e) => e.messages) };
}

/** Concatenated text of a message's content (blocks without text are skipped). */
export function messageText(content: PlainContent): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

/**
 * Display/audit text of a projected message. compactionSummary/branchSummary
 * use `summary`; bashExecution uses command+output (the exact input pi's
 * estimator counts); everything else is the concatenated content text.
 */
export function projectedText(message: PlainMessage): string {
	if (message.role === "compactionSummary" || message.role === "branchSummary") return message.summary ?? "";
	if (message.role === "bashExecution") return (message.command ?? "") + (message.output ?? "");
	return messageText(message.content);
}

/**
 * Deterministic unit floor — a slim port of pi-smart-compact's zero-LLM
 * extraction floor (their `src/utils/extraction.ts`, v10.0.1 @ ce34692, MIT —
 * 2026-09-30 port list item 6: "port a slim floor only").
 *
 * Why it exists here: our folds are ENTIRELY model-written (a stub the model
 * handed to close_unit). The live s5 re-run showed the exact failure this
 * pins down — 9/10 empty stubs, so nothing could be checked against anything
 * (dev repo self-review 2026-09-30). A deterministic floor per unit gives
 *
 * - the F5 governor a checkable fold minimum even when the stub is empty
 *   (an empty stub over demonstrable work is refused BEFORE the audit spend —
 *   the anti-self-sealing rule: "summary-derived fields cannot become
 *   evidence for their own verification");
 * - the ledger an audit referent beyond token ratio (the P4 claim check
 *   re-derives the same floor from the session file — it is mechanical);
 * - zero prefix cost: the floor rides in `sam` custom entries, which pi
 *   never sends to the LLM (pinned source, CustomEntry).
 *
 * Slim scope (documented, deliberate — their full pipeline is NOT ported):
 * - argument-shape based, not tool-name based (their principle from
 *   `classifyToolOperation`): `path`-family arg keys identify file ops;
 * - shell path-mining (their `extractShellFileOperations`) is NOT ported —
 *   it is the full pipeline's feature; command evidence and failure signals
 *   are;
 * - the transient-diagnostic list is their four signatures plus the generic
 *   network/timeout class (labelled), not their provider catalogue.
 */

import type { PlainMessage } from "./projection.ts";

/* ── helpers (their names, ported) ───────────────────────────────────────── */

/** Flatten a message content payload (string or block array) to text. */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (typeof block === "string") text += block;
		else if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const t = (block as { text?: unknown }).text;
			if (typeof t === "string") text += t;
		}
	}
	return text;
}

export interface FlatToolCall {
	name: string;
	id?: string;
	arguments: Record<string, unknown>;
}

/**
 * Flatten one assistant toolCall block to a descriptor. SAM's plain model
 * carries flat tool calls (pi's OpenAI-compatible mapping), so there is no
 * parallel-wrapper expansion to port — documented slim scope.
 */
export function flattenToolCallBlock(block: unknown): FlatToolCall[] {
	if (!block || typeof block !== "object") return [];
	const b = block as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown };
	if (b.type !== "toolCall" || typeof b.name !== "string") return [];
	const args = b.arguments && typeof b.arguments === "object" ? (b.arguments as Record<string, unknown>) : {};
	return [{ name: b.name, id: typeof b.id === "string" ? b.id : undefined, arguments: args }];
}

/* ── classification ───────────────────────────────────────────────────────── */

const PATH_ARG_KEYS = ["path", "file_path", "filePath", "notebook_path", "target_file"] as const;

function argPath(args: Record<string, unknown>): string | undefined {
	for (const key of PATH_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * Argument-shape mutation hints (their `classifyToolOperation` principle:
 * gated by shape, not name). `write`/`content`-family keys or
 * write-ish names ⇒ modified; read-ish names or no mutation evidence ⇒ read.
 * `close_unit` (our protocol tool) is self-noise and never counted (F4).
 */
function classifyFileOp(name: string, args: Record<string, unknown>): "mutate" | "read" | "none" {
	if (name === "close_unit") return "none";
	if (
		/\b(write|edit|patch|create|append|move|rename|copy|delete|remove|apply)\b/i.test(name) ||
		("content" in args && typeof args.content === "string") ||
		("new_text" in args) ||
		("old_text" in args && "new_text" in args)
	) {
		return "mutate";
	}
	if (/\b(read|view|cat|ls|list|glob|grep|search|find|stat)\b/i.test(name)) return "read";
	if (argPath(args) !== undefined) return "read";
	return "none";
}

export const COMMAND_TOOL_NAMES = /\b(bash|shell|exec|execute|run)\b/i;

/**
 * Command-tool detection, argument-shape first (their `classifyToolOperation`
 * principle): a `command`/`cmd`/`script` arg IS the command; a command-ish
 * name with no arg text means "command tool, no text" (empty string — still
 * failure-scanned, never a file op). `undefined` = not a command tool.
 */
export function commandOf(name: string, args: Record<string, unknown>): string | undefined {
	if (name === "close_unit") return undefined;
	for (const key of ["command", "cmd", "script"]) {
		if (typeof args[key] === "string") return args[key] as string;
	}
	if (COMMAND_TOOL_NAMES.test(name)) return "";
	return undefined;
}

/**
 * Port of their `hasCommandFailureSignal` (slim: the signal set that matters
 * on our stack) — a non-zero exit line or a leading error marker.
 */
export function hasCommandFailureSignal(text: string): boolean {
	if (/Command exited with code [1-9]\d*\s*$/i.test(text)) return true;
	const firstLine =
		text
			.split(/\r?\n/)
			.find((line) => line.trim())
			?.trim() ?? "";
	return (
		/(?:^|\n)\s*(?:error(?:\s|:)|fatal:|traceback\b|command not found|no such file|permission denied)/i.test(
			firstLine,
		) || /^(?:npm\s+error|ECONNREFUSED|ETIMEDOUT)/i.test(firstLine)
	);
}

/** Port of their `isTransientToolDiagnostic` + the generic network class. */
export function isTransientToolDiagnostic(text: string): boolean {
	const candidate = text.trim();
	// Their four signatures (provider-specific, kept verbatim in spirit):
	if (/\bBrave Search API error\s*\(429\)/i.test(candidate)) return true;
	if (/\bnpm error code ENOLOCK\b/i.test(candidate) && /(?:audit|existing lockfile|loadVirtual)/i.test(candidate)) return true;
	if (/^Found \d+ occurrences? of edits\[\d+\](?!\w)/i.test(candidate)) return true;
	if (/^Unknown JSON field:/i.test(candidate) && /Available fields:/i.test(candidate)) return true;
	// Generic transient class (labelled addition for our stack):
	return (
		/\bECONNRESET\b/.test(candidate) ||
		/\bETIMEDOUT\b/.test(candidate) ||
		/\bsocket hang up\b/i.test(candidate) ||
		/\btimeout(?:ed)? after \d+/i.test(candidate) ||
		/\b\d{3}\s*requests?\/s.*retry/i.test(candidate)
	);
}

/** Port of their `commandFailureEvidence` (keep the actionable part, not the prefix). */
export function commandFailureEvidence(text: string, maxChars = 400): string {
	if (text.length <= maxChars) return text;
	const match =
		/(?:command not found|no such file|permission denied|syntax error|cannot find|module not found|compilation error|build failed|test failed|^FAIL\b|ERROR:|FATAL\b|Traceback\b|(?:failed|failure)\b)/im.exec(
			text,
		);
	const evidenceBudget = Math.max(1, Math.floor(maxChars * 0.7));
	const tailBudget = Math.max(0, maxChars - evidenceBudget);
	const anchor = match?.index ?? Math.max(0, text.length - evidenceBudget);
	const start = Math.max(0, anchor - Math.floor(evidenceBudget / 4));
	const evidence = text.slice(start, start + evidenceBudget);
	const tail = tailBudget > 0 ? text.slice(-tailBudget) : "";
	return evidence + (tail && !evidence.endsWith(tail) ? "\n...\n" + tail : "");
}

/* ── the floor ────────────────────────────────────────────────────────────── */

export interface UnitFloor {
	/** file paths the unit touched, with the operations observed */
	files: { path: string; ops: string[] }[];
	/** errors worth remembering (transient diagnostics excluded) */
	errors: { tool: string; snippet: string }[];
	/** retry signals: a same-tool call after an error within the retry window */
	retries: number;
	/** demonstrable work — the empty-stub gate's basis */
	nonTrivial: boolean;
}

const RETRY_WINDOW = 4; // assistant messages after an error (their ERROR_RETRY_WINDOW idea, slim)

type FloorCall = { name: string; id?: string; args: Record<string, unknown>; command?: string; signature: string };

export function argSignature(call: FloorCall): string {
	return `${call.name}:${JSON.stringify(call.args) ?? "{}"}`;
}

/**
 * Compute the deterministic floor of one unit's messages (span order). Pure.
 * Reads only observed content — no model call, no inference beyond the
 * labelled heuristics above.
 */
export function extractUnitFloor(messages: readonly PlainMessage[]): UnitFloor {
	const files = new Map<string, Set<string>>();
	const errors: { tool: string; snippet: string }[] = [];
	let retries = 0;
	let toolResults = 0;
	let assistantTextChars = 0;

	// Collect calls in order (id used as pairing key; pi always assigns one).
	const calls: FloorCall[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		assistantTextChars += extractText(message.content).length;
		if (typeof message.content === "string") continue;
		for (const block of message.content) {
			const flat = flattenToolCallBlock(block);
			for (const call of flat) {
				const floorCall: FloorCall = {
					name: call.name,
					id: call.id,
					args: call.arguments,
					command: commandOf(call.name, call.arguments),
					signature: "",
				};
				floorCall.signature = argSignature(floorCall);
				calls.push(floorCall);
			}
		}
	}
	const callById = new Map<string, FloorCall>();
	for (const call of calls) if (call.id) callById.set(call.id, call);

	// Pending failures awaiting a retry (same tool + args) within the window.
	interface PendingFailure { call: FloorCall; untilAssistant: number }
	const pendingFailures: PendingFailure[] = [];
	let assistantSeen = 0;

	for (const message of messages) {
		if (message.role === "assistant") {
			assistantSeen++;
			continue;
		}
		if (message.role !== "toolResult") continue;
		// F4: the protocol tool is self-noise — its result is not work.
		if (message.toolName === "close_unit" || (message.toolCallId !== undefined && callById.get(message.toolCallId)?.name === "close_unit")) continue;
		toolResults++;
		const text = extractText(message.content);
		const call = message.toolCallId ? callById.get(message.toolCallId) : undefined;
		const toolName = message.toolName ?? call?.name ?? "unknown";

		// Transient diagnostics are noise for the floor (their skip rule).
		if (isTransientToolDiagnostic(text)) continue;

		const failed = message.isError === true || (call !== undefined && call.command !== undefined && hasCommandFailureSignal(text));
		if (failed) {
			errors.push({ tool: toolName, snippet: commandFailureEvidence(text) });
			if (call !== undefined) pendingFailures.push({ call, untilAssistant: assistantSeen + RETRY_WINDOW });
			continue;
		}

		// A success that repeats a pending failure is the retry signal.
		for (let i = pendingFailures.length - 1; i >= 0; i--) {
			const pending = pendingFailures[i];
			if (assistantSeen > pending.untilAssistant) {
				pendingFailures.splice(i, 1);
				continue;
			}
			if (call !== undefined && call.signature === pending.call.signature) {
				retries++;
				pendingFailures.splice(i, 1);
			}
		}

		if (call !== undefined && call.command === undefined) {
			const op = classifyFileOp(call.name, call.args);
			if (op !== "none") {
				const path = argPath(call.args);
				if (path) {
					const ops = files.get(path) ?? new Set<string>();
					ops.add(op);
					files.set(path, ops);
				}
			}
		}
	}

	const nonTrivial = toolResults > 0 || assistantTextChars >= 100 || errors.length > 0 || files.size > 0;
	return {
		files: [...files.entries()].map(([path, ops]) => ({ path, ops: [...ops].sort() })).sort((a, b) => a.path.localeCompare(b.path)),
		errors,
		retries,
		nonTrivial,
	};
}

/**
 * The close-time empty-stub gate (anti-self-sealing): a stub that is
 * whitespace-only over demonstrable work cannot be audited into a fold —
 * an empty claim contradicts nothing, so the audit would pass it. Refuse the
 * close itself (the model gets one actionable refusal, not a silent noFold).
 */
export function emptyStubGate(stub: string, floor: UnitFloor): { ok: boolean; reason?: string } {
	if (stub.trim() === "" && floor.nonTrivial) {
		return {
			ok: false,
			reason: `empty stub over demonstrable work (${floor.files.length} file(s), ${floor.errors.length} error(s)) — an audit cannot verify an empty claim; write a real stub`,
		};
	}
	return { ok: true };
}

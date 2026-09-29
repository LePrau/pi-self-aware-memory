/**
 * Token estimation — a dependency-free mirror of pi v0.87.1's rulers
 * (`packages/coding-agent/src/core/compaction/compaction.ts` lines 162-280, 320-375,
 * tag v0.87.1 in `pi-agent/git/pi-mirror`).
 *
 * The product treats pi's estimate as the single ruler (plan constraint F3):
 * this module exists so the same math can be unit-tested without a pi runtime
 * and so the dev walk can predict pi's numbers by hand. `test/pi-semantics.test.ts`
 * cross-checks it against pi's real `estimateProjectedContextTokens()`.
 *
 * Rules mirrored (pi v0.87.1, verbatim):
 * - per-message estimate = ceil(chars / 4) where:
 *   - system/user/toolResult: text chars; image blocks count 4800 chars;
 *   - assistant: text + thinking + toolCall (name.length + JSON.stringify(args).length);
 * - a last assistant usage is trusted only when its source entry is after the
 *   latest `context_edit` or `compaction` entry in the branch;
 *   otherwise the full per-message sum is used.
 * - usage counts only when the assistant message is not stopped by
 *   "aborted"/"error" and its context tokens > 0.
 */

import { messageText, type PlainEntry, type PlainMessage, type PlainProjection, type PlainUsage } from "./projection.ts";

const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * pi's `calculateContextTokens`: totalTokens or the component sum. Unlike pi
 * (whose Usage fields are all populated) the plain model treats absent
 * components as 0, so partial usages degrade to their known sum instead of NaN.
 */
export function calculateContextTokens(usage: PlainUsage): number {
	if (usage.totalTokens && usage.totalTokens > 0) return usage.totalTokens;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** pi's `getAssistantUsage` gate: usable usage or undefined. */
export function getAssistantUsage(message: PlainMessage): PlainUsage | undefined {
	if (message.role !== "assistant" || !message.usage) return undefined;
	if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
	if (calculateContextTokens(message.usage) <= 0) return undefined;
	return message.usage;
}

function contentChars(content: string | { type: string; text?: string }[]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) chars += block.text.length;
		else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
	}
	return chars;
}

/** pi's `estimateTokens` (per message). */
export function estimateMessageTokens(message: PlainMessage): number {
	switch (message.role) {
		case "system":
		case "user":
		case "toolResult":
			return Math.ceil(contentChars(message.content) / 4);
		case "assistant": {
			// pi's AssistantMessage.content is always an array; the plain model
			// also allows a plain string, which counts as a single text block.
			const blocks =
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			let chars = 0;
			for (const block of blocks) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			return Math.ceil(chars / 4);
		}
		case "compactionSummary":
		case "branchSummary":
			// pi: summary.length only
			return Math.ceil((message.summary ?? "").length / 4);
		case "custom":
			// pi: CustomMessage content (text + images)
			return Math.ceil(contentChars(message.content) / 4);
		case "bashExecution":
			// pi: command.length + output.length
			return Math.ceil(((message.command ?? "").length + (message.output ?? "").length) / 4);
		default:
			return 0;
	}
}

/** pi's `ContextUsageEstimate`. */
export interface Estimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

/** pi's `estimateContextTokens` (over a message list). */
export function estimateMessagesTokens(messages: PlainMessage[]): Estimate {
	const lastUsageIndex = (() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (getAssistantUsage(messages[i])) return i;
		}
		return -1;
	})();

	if (lastUsageIndex === -1) {
		let estimated = 0;
		for (const message of messages) estimated += estimateMessageTokens(message);
		return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
	}

	const usage = getAssistantUsage(messages[lastUsageIndex])!;
	const usageTokens = calculateContextTokens(usage);
	let trailingTokens = 0;
	for (let i = lastUsageIndex + 1; i < messages.length; i++) {
		trailingTokens += estimateMessageTokens(messages[i]);
	}
	return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex };
}

/**
 * pi's `estimateProjectedContextTokens`: the projected message estimate, but
 * the last-usage shortcut is only trusted when the usage's source entry lies
 * after every `context_edit`/`compaction` entry in the branch.
 */
export function estimateProjectedTokens(projection: PlainProjection, branchEntries: PlainEntry[]): Estimate {
	const estimate = estimateMessagesTokens(projection.messages);
	if (estimate.lastUsageIndex !== null) {
		// Locate the source entry of the last-usage projected message.
		let projectedIndex = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const next = projectedIndex + entry.messages.length;
			if (estimate.lastUsageIndex < next) {
				usageEntryId = entry.sourceEntryId;
				break;
			}
			projectedIndex = next;
		}
		const usageEntryIndex = usageEntryId ? branchEntries.findIndex((e) => e.id === usageEntryId) : -1;
		let latestInvalidatingIndex = -1;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const kind = branchEntries[i].kind;
			if (kind === "context_edit" || kind === "compaction") {
				latestInvalidatingIndex = i;
				break;
			}
		}
		if (usageEntryIndex > latestInvalidatingIndex) return estimate;
	}

	// Fallback: full per-message sum, system merged once (pi: joined with "\n\n").
	const systemTexts: string[] = [];
	for (const message of projection.messages) {
		if (message.role === "system") {
			const text = messageText(message.content);
			if (text.length > 0) systemTexts.push(text);
		}
	}
	let tokens = systemTexts.length > 0 ? Math.ceil(systemTexts.join("\n\n").length / 4) : 0;
	for (const message of projection.messages) {
		if (message.role !== "system") tokens += estimateMessageTokens(message);
	}
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * Audit verdict parsing (product port of the P1 spike `parseVerdict`, which
 * cleared the P1 live bar 9/10 against a 4B auditor — see dev repo run-outputs).
 *
 * The protocol demands exactly `VERIFIED` or `CORRECTIONS: …`. Anything else —
 * including a `CORRECTIONS:` with an empty list — is UNAUDITABLE, and the fold
 * policy (P2: VERIFIED-only) keeps the raw entries in view.
 */

export type VerdictClass = "VERIFIED" | "CORRECTIONS" | "UNAUDITABLE";

export interface Verdict {
	class: VerdictClass;
	/** CORRECTIONS only: the text after "CORRECTIONS:" (trimmed). */
	corrections?: string;
}

export function parseVerdict(raw: string): Verdict {
	const text = (raw ?? "").trim();
	if (/^verified$/i.test(text)) return { class: "VERIFIED" };
	const m = text.match(/^corrections:\s*([\s\S]*)$/i);
	if (m) {
		const corrections = m[1].trim();
		if (corrections === "") return { class: "UNAUDITABLE" };
		return { class: "CORRECTIONS", corrections };
	}
	return { class: "UNAUDITABLE" };
}

/** Extracts the plain text of an assistant reply (string or content blocks). */
export function assistantText(content: string | unknown[]): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.map((part) =>
			part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("");
}

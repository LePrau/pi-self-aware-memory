/**
 * Audit verdict parsing (product port of the P1 spike `parseVerdict`, which
 * cleared the P1 live bar 9/10 against a 4B auditor — see dev repo run-outputs).
 *
 * The protocol demands exactly `VERIFIED` or `CORRECTIONS: …` from a FULL
 * audit. Anything else — including a `CORRECTIONS:` with an empty list — is
 * UNAUDITABLE, and the fold policy (P2: VERIFIED-only) keeps the raw entries
 * in view.
 *
 * D8 (2026-10-02): the LIGHT audit (KV pressure near the fold) answers
 * `NOT-YET-VERIFIED: <note>` — a delivery check, not a verification (Paul's
 * contract: "just check that filenames and statements have been delivered,
 * not verify them all, and then just mark claims that are not marked open
 * as not yet verified"). The class is parseable here; the pipeline
 * ACCEPTS it only for a light-depth audit (a full audit replying it is a
 * contract violation ⇒ UNAUDITABLE ⇒ the D9 hatch — pinned).
 */

export type VerdictClass = "VERIFIED" | "CORRECTIONS" | "NOT-YET-VERIFIED" | "UNAUDITABLE";

/** D9 (2026-10-02): the FULL set of verdict classes the LEDGER can carry —
 *  the model verdicts (parseVerdict output) plus the hatch synthesis
 *  ("UNVERIFIED-AUDIT-FAILED": the audit itself failed; no model ever
 *  replies with it, and parseVerdict never produces it — it is committed,
 *  not parsed). */
export type LedgerVerdictClass = VerdictClass | "UNVERIFIED-AUDIT-FAILED";

export interface Verdict {
	class: VerdictClass;
	/** CORRECTIONS only: the text after "CORRECTIONS:" (trimmed). */
	corrections?: string;
	/** NOT-YET-VERIFIED only: the note after the token (trimmed; optional). */
	note?: string;
}

/** D9: the ledger's unit verdict slot — model verdicts plus the D9 hatch
 *  class (the audit-failed settlement is the unit's terminal state when the
 *  audit failed; upgrade (same-stub re-close / /sam reaudit) appends a
 *  strong settlement and supersedes it). */
export interface LedgerVerdict {
	class: LedgerVerdictClass;
	corrections?: string;
	note?: string;
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
	// D8: NOT-YET-VERIFIED must match BEFORE any ".*VERIFIED"-style reading —
	// explicit token, then the optional delivery note after a colon.
	if (/^not-yet-verified$/i.test(text)) return { class: "NOT-YET-VERIFIED" };
	const ny = text.match(/^not-yet-verified\s*:\s*([\s\S]*)$/i);
	if (ny) {
		const note = ny[1].trim();
		if (note === "") return { class: "UNAUDITABLE" };
		return { class: "NOT-YET-VERIFIED", note };
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

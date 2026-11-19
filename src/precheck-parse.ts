/**
 * Stub pre-check — deterministic claim-splitter + fact-extractor (the port of
 * dev-repo `measurements/audit-quality/parse-stubs.mjs`, settled design:
 * dev-repo notes `2026-11-18-stub-precheck-*.md` + `stub-structure.md`).
 *
 * EXTRACTS ONLY — it runs no checks and knows no workspace, repo, or machine.
 * Every extracted fact carries a *check spec* (a command template with a
 * `<repo>`/`<cwd-or-repo>`/`<repo:tag>` placeholder) that the pre-check
 * executor (src/precheck-executor.ts) fills in and runs at close time.
 *
 * Port fidelity: the regexes, guards, and fact ordering are 1:1 with the
 * .mjs (verified against the 599-stub dataset rows 120/300/306 — marker
 * ownership, the comma-guarded testcounts, the apostrophe-safe quotes, the
 * tagged-commit dedupe, the method-chain guard). Three deliberate fixes:
 * (1) the file-RANGE sed template now spans `a-5..b+5` (the .mjs template
 *     emitted `a-5..a+5` for ranges — dead code in practice, since the
 *     settled display carries only the range's byte size, never a window);
 * (2) the size regex now accepts a decimal fraction (`10.3 KB` — the .mjs
 *     regex anchored at the first digit, so decimals captured only their
 *     fraction, e.g. "10.3 KB" → "3 KB"); integer sizes behave identically;
 * (3) the bare-file pass now drops domain:port candidates (base path ends in
 *     a TLD, e.g. host.example.com:443 — the .mjs regex's `(?::\d+)?` tail
 *     let them through as file facts; the fileLine pass's TLD guard already
 *     suppresses the file-LINE fact, but the bare path's end-anchored TLD
 *     test missed the `:443` suffix). file:line tokens (src/foo.ts:1135) are
 *     kept exactly as the .mjs emits them (file fact + file-line fact; the
 *     executor dedupes on the base path). All three fixes drop spurious
 *     facts only — nothing is added.
 *
 * Pure: total, side-effect free, no I/O — test-pinned by
 * test/precheck-parse.test.ts.
 */

/* ── fact model ─────────────────────────────────────────────────────────── */

export interface ParsedFact {
	/** Fact kind (commit, commit-tagged, file, file-line, file-range, …). */
	type: string;
	/** The extracted value as it appears in the stub. */
	value: string;
	/** Check-spec template (command(s) with <repo>/<cwd-or-repo> placeholders). */
	spec: string;
	/** Character offset of the fact's occurrence in the stub. */
	at: number;
	/** Optional reliability note (e.g. "ambiguous-digit", "session-id"). */
	note?: string;
}

/* ── splitting ───────────────────────────────────────────────────────────── */

/**
 * Hierarchical split of one stub into claim-like fragments:
 *   1. newlines (safe: 3.1% of fragments start mid-claim)
 *   2. inline section markers " (n)" / " (A)" … " (Z)" (7.7% dangling)
 *   3. semicolons followed by whitespace (15.3% dangling, +8.5% open-paren)
 *   4. ". " before an upper/digit/backtick/quote (14.2% dangling)
 *   `finer` adds: 5. ", " before an alphanumeric/backtick/quote/open-paren
 * Fragments keep their original marker prefix (e.g. "2.", "(A)") when it
 * leads the fragment, so the reader still sees the list structure.
 */
export function splitClaims(stub: string, finer = false): string[] {
	const out: string[] = [];
	for (const rawLine of (stub || "").split("\n")) {
		if (!rawLine.trim()) continue;
		// step 2: inline (n)/(A) markers — the marker opens the fragment that follows it
		const pieces = rawLine.split(/( \(\d+\)| \([A-Z]\))(?=\s|[A-Z"'])/);
		const parts: string[] = [];
		if ((pieces[0] || "").trim()) parts.push(pieces[0]);
		for (let i = 1; i < pieces.length; i += 2) parts.push((pieces[i] || "") + (pieces[i + 1] || ""));
		for (const body of parts) {
			for (const p of body.split(/;(?=\s)/)) {
				for (const q of p.split(/\. (?=[A-Z0-9`"~])/)) {
					if (finer) for (const r of q.split(/, (?=[A-Za-z0-9`"~(])/)) push(r);
					else push(q);
				}
			}
		}
	}
	function push(t: string) {
		const s = t.trim();
		if (!s) return;
		out.push(s);
	}
	return out;
}

/* ── extraction ──────────────────────────────────────────────────────────── */

const H = {
	// commit candidates: 7–12 hex, not glued to word chars or hyphens (keeps
	// UUIDs, hashes-inside-md5, and 40-hex out); all-digit tokens kept but flagged
	commit7: /(?<![\w-])[0-9a-f]{7}(?![\w-])/g,
	commit8: /(?<![\w-])[0-9a-f]{8}(?![\w-])/g,
	commit9_12: /(?<![\w-])[0-9a-f]{9,12}(?![\w-])/g,
	// SAM banked ids: 12 hex appearing with sam/audit context, or after "·"/"id"
	sam12: /(?<![\w-])[0-9a-f]{12}(?![\w-])/g,
	// pi session ids: 8 hex starting with 01a (UUIDv7 time prefix)
	session8: /(?<![\w-])01a[0-9a-f]{5}(?![\w-])/g,
	// file refs: path-ish prefix (>=1 letter, dot/slash/tilde allowed), :N or :N-M
	fileLine: /((?:[\w.~]+\/)*[\w.~-]*[a-zA-Z][\w.~\-]*):(\d{1,5})(?:-(\d{1,5}))?(?!\d)/g,
	// bare ":N" with no visible path (implicit file)
	bareLine: /(^|[^0-9A-Za-z.])\:(\d{1,5})(?!\d)/g,
	// sizes
	// PORT FIX 2: decimal sizes (10.3 KB) — the .mjs captured only the fraction
	size: /\b(\d[\d,]*(?:\.\d+)?)(\s?(?:B|KB|MB|GB|G|K|M))\b/g,

	// test/gate counts (comma-guarded: 9,142/92,688 must not yield 142/92)
	testcount: /(?<![\d,])(\d{1,7})\/(\d{1,7})(?![\d,])/g,
	gate: /\bGATE:?\s+(PASS|FAIL|GREEN|FAILURES|green|failures)\b/gi,
	exit: /\bexit\s+([0-9]+)\b/g,
	// versions
	version: /\bv?(\d+\.\d+\.\d+)\b/g,
	// dates
	date: /\b(20\d{2}-\d{2}-\d{2})\b/g,
	// unit refs
	unit: /\bu(\d{1,3})\b/g,
	// quoted text near a user word (Paul/he/his/her/user/they/them);
	// single quotes must NOT sit inside a word (avoids apostrophes in Paul's/v0.0.27's)
	quote: /("[^"']{8,}"|(?<![\w])'[^']{8,}'(?!\w))/g,
	// repo tag preceding a commit: "ext <hash>" / "dev <hash>" / "root <hash>" / "workspace <hash>"
	tag: /\b(ext|dev|root|workspace) (?:`)?([0-9a-f]{7,12})/g,
	// approximate line refs
	approx: /~\s*(?:line|lines)?\s*(\d+(?:-\d+)?)\b/g,
};

const TLD = /\.(?:com|de|net|org|local|io|me|dev|test|localhost)$/i;

function classifyCommit(tok: string, pre: string): string {
	const preL = pre.toLowerCase();
	if (/^\d+$/.test(tok)) return "ambiguous-digit"; // byte-count vs all-digit hash — only the git check decides
	if (/01a/.test(tok.slice(0, 3))) return "session-id";
	if (/replyid|firstkept|entryid|entry/i.test(preL)) return "sam-id";
	if (/(commit|committed|head|fork|amend|reset|revert|merged|tip|parent|as|hash)/.test(preL)) return "commit";
	if (/`/.test(pre.slice(-1))) return "commit"; // backticked hashes are commits in practice
	return "commit?";
}

/** Extract all facts from one stub string, ordered by their offset in it. */
export function extractFacts(stub: string): ParsedFact[] {
	const s = stub || "";
	const facts: ParsedFact[] = [];
	const add = (type: string, value: string, spec: string, at: number, note?: string) =>
		facts.push({ type, value, spec, at, ...(note ? { note } : {}) });

	// repo-tagged commits first: the tag names WHICH repo, and the tagged
	// hashes are then suppressed in the bare-commit pass below
	const taggedSet = new Set<string>();
	for (const m of s.matchAll(H.tag)) {
		add("commit-tagged", `${m[1]} ${m[2]}`, `git -C <repo:${m[1]}> log -1 --stat --format='%h %s' ${m[2]}`, m.index);
		taggedSet.add(m[2]);
	}

	// commits, longest-first so 9-12 hex are not double-counted as 7/8
	const seen = new Set<string>();
	const take = (re: RegExp, kind: string, lo: number, hi: number) => {
		for (const m of s.matchAll(re)) {
			const tok = m[0];
			if (tok.length < lo || tok.length > hi) continue;
			if (taggedSet.has(tok)) continue;
			if ([...seen].some((x) => tok.startsWith(x) && x.length >= lo)) continue;
			seen.add(tok);
			const pre = s.slice(Math.max(0, m.index - 40), m.index);
			const cls = classifyCommit(tok, pre);
			const repoTag = pre.match(/\b(ext|dev|root|workspace) (?:`)?$/);
			add(
				kind,
				tok,
				repoTag
					? `git -C <repo:${repoTag[1]}> log -1 --stat --format='%h %s' ${tok}`
					: `git -C <repo> log -1 --stat --format='%h %s' ${tok}   [resolve: rev-parse --verify ${tok}^{commit}]`,
				m.index,
				cls !== "commit" ? cls : undefined,
			);
		}
	};
	take(H.commit9_12, "commit", 9, 12);
	take(H.commit8, "commit", 8, 8);
	take(H.commit7, "commit", 7, 7);

	// 12-hex SAM banked ids that survived the commit pass (i.e. not consumed above)
	for (const m of s.matchAll(H.sam12)) {
		if ([...seen].some((x) => m[0] === x)) continue;
		const pre = s.slice(Math.max(0, m.index - 30), m.index);
		if (/sam_retrieve|orphan|fold|settlement|design|id\b|·/i.test(pre))
			add("sam-id", m[0], `sam_retrieve ${m[0]}   [no shell needed]`, m.index);
	}
	// pi session ids (skip those already reported by the commit pass)
	for (const m of s.matchAll(H.session8)) {
		if (seen.has(m[0])) continue;
		add("session-id", m[0], `n/a — pi session file id (01a… prefix)`, m.index);
	}

	// file:line refs
	for (const m of s.matchAll(H.fileLine)) {
		const [full, path, a, b] = m;
		if (/^\d+$/.test(path)) continue; // time-like (18:24, 11:51) — prefix must contain a letter
		if (TLD.test(path)) continue; // domain:port
		// PORT FIX: the range window spans a-5..b+5 (the .mjs template emitted a+5).
		add(
			b ? "file-range" : "file-line",
			full,
			`ls <cwd-or-repo>/${path}  →  if exists: sed -n '${Math.max(1, +a - 5)},${b ? +b + 5 : +a + 5}p' ${path}`, // PORT FIX 1
			m.index,
		);
	}
	// implicit-file line refs ":N" / "/ :N" (the regex itself rejects digit
	// prefixes, so times like 18:24 do not reach here)
	for (const m of s.matchAll(H.bareLine)) {
		const n = m[2];
		add("bare-line", `:${n}`, `sed -n '${Math.max(1, +n - 5)},${+n + 5}p' <last-mentioned-file>   [file implicit — resolver needed]`, m.index);
	}
	// approximate line refs
	for (const m of s.matchAll(H.approx))
		add("line-approx", `~${m[1]}`, `window check around line(s) ${m[1]} of <last-mentioned-file>   [approximate — window, not exact]`, m.index);

	// absolute files (leading "/" kept in the value; the executor tests the
	// literal path first, then the de-slashified relative reading — 2026-11-19).
	// Own pass by design: two regexes for two path semantics are cheaper to
	// reason about than one all-purpose one (still nothing next to an LLM).
	const absFileEnds = new Set<number>();
	for (const m of s.matchAll(/(?:^|[\s(`"'=~>:,-])(\/[\w.~\-]+(?:\/[\w.~\-]+)*\.\w{1,6}(?::\d+)?)/g)) {
		const p = m[1];
		if (/^v?\d+(\.\d+)+$/.test(p)) continue; // version-like (v1.3.0, 7.0.2), not a file
		if (s[m.index + m[0].length] === "(") continue; // method chain (task.tokens.size()), not a file
		if (p.includes(":") && TLD.test(p.split(":")[0])) continue; // domain:port leak
		if (TLD.test(p)) continue;
		if (/^[\d.]+$/.test(p)) continue;
		absFileEnds.add(m.index + m[0].length);
		add("file", p, `ls ${p}   [exists? — absolute; fallback: relative without the leading slash]`, m.index);
	}
	// bare files (extension-carrying, one or more dir segments; not already covered above)
	for (const m of s.matchAll(/(?:^|[\s(`"'=~>\/:,-])([\w.~\-]+(?:\/[\w.~\-]+)*\.\w{1,6}(?::\d+)?)/g)) {
		const p = m[1];
		if (/^v?\d+(\.\d+)+$/.test(p)) continue; // version-like (v1.3.0, 7.0.2), not a file
		if (s[m.index + m[0].length] === "(") continue; // method chain (task.tokens.size()), not a file
		if (p.includes(":") && TLD.test(p.split(":")[0])) continue; // PORT FIX 3: domain:port leak — the bare-file regex's `(?::\d+)?` tail let host.example.com:443 through (the fileLine pass's TLD guard suppresses the file-LINE fact, but the bare path's end-anchored test missed the `:443` suffix). file:line tokens (src/foo.ts:1135) are kept — the .mjs emits them as file facts too, and the executor dedupes on the base path.
		if (TLD.test(p)) continue;
		if (/^[\d.]+$/.test(p)) continue;
		if (absFileEnds.has(m.index + m[0].length)) continue; // the absolute pass already captured this token (with its leading "/") — one file fact per token
		add("file", p, `ls <cwd-or-repo>/${p}   [exists?]`, m.index);
	}

	for (const m of s.matchAll(H.size)) add("size", `${m[1]}${m[2]}`, `n/a — size claim (wc -c / du if the file resolves)`, m.index);
	for (const m of s.matchAll(H.testcount)) add("testcount", `${m[1]}/${m[2]}`, `n/a — pass/total claim (needs the gate log, if named)`, m.index);
	for (const m of s.matchAll(H.gate)) add("gate", m[0].trim(), `n/a — gate verdict claim (check the named log file, if any)`, m.index);
	for (const m of s.matchAll(H.exit)) add("exit-code", m[1], `n/a — exit-code claim`, m.index);
	for (const m of s.matchAll(H.version)) add("version", m[1], `n/a — version claim (package.json / --version of the named tool)`, m.index);
	for (const m of s.matchAll(H.date)) add("date", m[1], `n/a — date claim (git log dates, file mtimes)`, m.index);
	for (const m of s.matchAll(H.unit)) add("unit-ref", `u${m[1]}`, `n/a — unit ref (SAM ledger, not shell)`, m.index);
	for (const m of s.matchAll(H.quote)) {
		const pre = s.slice(Math.max(0, m.index - 40), m.index);
		add(
			"quote",
			m[0].slice(0, 80) + (m[0].length > 80 ? "…" : ""),
			/\b(paul|he|his|her|user|they|them)\b/i.test(pre) ? "user's verbatim words — EVIDENCE-grade, not shell-checkable" : "quoted text (possibly verbatim source)",
			m.index,
		);
	}
	// OPEN section
	const om = s.match(/\bOPEN:?\s/);
	if (om) {
		const at = om.index ?? 0; // RegExpMatchArray.index is typed optional (always present at runtime)
		add("open-section", s.slice(at, at + 120).replace(/\n/g, " ") + "…", `n/a — claims after this marker are OPEN items (must stay open in the audit)`, at);
	}

	return facts.sort((a, b) => a.at - b.at);
}

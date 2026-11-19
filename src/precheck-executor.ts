/**
 * Stub pre-check — executor (implementation step 3).
 *
 * Takes the parsed stub facts (step 1, `precheck-parse.ts`) and the discovered
 * repos/files (step 2, `precheck-discovery.ts`) and runs the settled check
 * pipeline against an injected runner (in production: `ctx.executeTool("bash",
 * …)` — same validation/hooks/permissions as model-issued calls). Pure apart
 * from the injected runner + clock; no fs, no pi types.
 *
 * Settled design (dev repo, 2026-11-18):
 *  notes/2026-11-18-stub-precheck-repo-file-discovery.md  (the algorithm)
 *  notes/2026-11-18-stub-precheck-prompt-mockup.md        (the display spec)
 *  notes/2026-11-18-stub-precheck-summary-carry.md        (the positives)
 *
 * Display rules implemented verbatim (mockup, all rounds settled):
 *  - clock line carries BOTH formats (long `date -u` + `Y-M-D H:i:s`)
 *  - header `Git repos checked:` — reduced-noise rule: all commits found →
 *    only repos with hits; ANY commit not found → all valid repos listed
 *  - found commits: `- commit <h> exists in <repo>` + 4-space continuations
 *    (date + subject, one-line stat with totals `+A/−B`)
 *  - hash not found: `commit <h> not found in the named repos` (no per-hash
 *    repo enumeration — the header carries the context)
 *  - files: `file <claim> exists at <p> [and <p2>…]` (multiple matches: all
 *    listed, NO line extract) · not found: `file <claim> could not cheaply be
 *    found — checked: workspace root, known git repos`
 *  - file-line: `sed -n` ±5-line verbatim window in a code fence, capped at
 *    2000 bytes (oversize → the byte-count warning instead); ambiguous file →
 *    no window; file-range: size-only line `file <p>:<a>-<b> — contains N
 *    bytes`
 *  - one flat block, no group headers; every checkable claim type gets a
 *    self-explanatory line, unchecked ones prefixed `— no cheap result (…)`
 *  - NEVER rejects: every failure degrades to a no-result line (Paul: the
 *    expensive model reasoning then finds the rest, as before)
 *
 * Circuit-breaker signal (settled 2026-11-18, u299): `hardErrors` counts the
 * unexpected failures (runner-level `isError`, unclassifiable non-zero exits);
 * expected negatives (git unknown/bad revision, "not a git repository", ls /
 * sed no-such-file) are normal outcomes. The session-scoped disable flag is
 * the caller's (step 4); this module only reports.
 *
 * Run: node --test test/precheck-executor.test.ts
 */
import type { ParsedFact } from "./precheck-parse.ts";
import type { Discovery } from "./precheck-discovery.ts";

/* ── the injected runner contract ───────────────────────────────────────── */

export interface RunResult {
	/** Combined stdout+stderr of the command. */
	stdout: string;
	/** Tool-level failure (unknown tool, blocked, validation error, throw). */
	isError: boolean;
}

export type Runner = (command: string) => Promise<RunResult>;

/* ── results ────────────────────────────────────────────────────────────── */

export interface PrecheckPositives {
	/** Repos with at least one actual hit (commit or file) — summary label
	 *  "git repos used:"; may differ from the audit-prompt header. */
	reposUsed: string[];
	commitsFound: { hash: string; repo: string }[];
	filesFound: { claim: string; paths: string[] }[];
}

export interface PrecheckResult {
	/** The flat display block (headers + entries, no trailing newline). */
	block: string;
	positives: PrecheckPositives;
	commands: number;
	/** Runner-level / unclassifiable failures — feeds the circuit breaker. */
	hardErrors: number;
}

export interface PrecheckClock {
	/** `date -u` as-is, e.g. "Wed Nov 18 17:26:29 UTC 2026". */
	long: string;
	/** `Y-M-D H:i:s`, e.g. "2026-11-18 17:26:29". */
	short: string;
}

export interface PrecheckOptions {
	/** Byte cap for the ±5-line window (settled: 2000). */
	windowCap: number;
}

const DEFAULT_WINDOW_CAP = 2000;

/* ── internals ──────────────────────────────────────────────────────────── */

interface Tally {
	commands: number;
	hardErrors: number;
}

type Outcome = "ok" | "expected-negative" | "hard-error";

/**
 * The runner sees the command with an exit-code trailer:
 *   <cmd> 2>&1; printf '\nEXIT:%s\n' "$?"
 * so expected negatives (non-zero exits with known markers) stay
 * distinguishable from unexpected ones without trusting the tool result's
 * error flag alone.
 */
function withExit(cmd: string): string {
	return `${cmd} 2>&1; printf '\\nEXIT:%s\\n' "$?"`;
}

function parseOutput(out: string): { body: string; exit: number | null } {
	const m = out.match(/\nEXIT:(-?\d+)\s*$/);
	if (!m) return { body: out, exit: null };
	return { body: out.slice(0, m.index ?? out.length).replace(/\n$/, ""), exit: Number(m[1]) };
}

function classify(out: RunResult, exit: number | null): Outcome {
	if (out.isError) return "hard-error";
	if (exit === 0) return "ok";
	if (exit === null) {
		// no trailer (runner quirk) — judge by content: known git negatives
		// stay expected; anything else is unexpected
		return /unknown revision|bad revision|not a (valid )?git repository|pathspec .* did not match|No such file or directory/i.test(out.stdout)
			? "expected-negative"
			: "hard-error";
	}
	return /unknown revision|bad revision|not a (valid )?git repository|ambiguous argument|pathspec .* did not match|No such file or directory/i.test(out.stdout)
		? "expected-negative"
		: "hard-error";
}

async function run(runner: Runner, tally: Tally, cmd: string): Promise<{ body: string; exit: number | null; outcome: Outcome }> {
	tally.commands += 1;
	const out = await runner(cmd);
	const { body, exit } = parseOutput(out.stdout);
	const outcome = classify(out, exit);
	if (outcome === "hard-error") tally.hardErrors += 1;
	return { body, exit, outcome };
}

/** shell-quote an argument (single quotes; escape embedded single quotes). */
function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface CommitCheck {
	hash: string;
	repo: string | null; // null = not found in any valid repo
	date: string;
	subject: string;
	fileStat: string; // "(1 file: X +4/−2)" or "(N files, +A/−B)" style
}

/** Parse `git log -1 --stat --format='%ad%x09%s' --date=short <h>` output. */
function parseCommitLog(body: string): { date: string; subject: string; fileStat: string } | null {
	const lines = body.split("\n");
	const head = lines[0]?.split("\t");
	if (!head || head.length < 2) return null;
	const date = head[0];
	const subject = head.slice(1).join("\t");
	// summary line: "N file(s) changed, A insertion(s)(+), B deletion(s)(-)"
	let fileStat = "";
	for (const line of lines) {
		const m = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
		if (m) {
			const n = m[1];
			const ins = m[2] ?? "0";
			const del = m[3] ?? "0";
			fileStat = n === "1" ? `(1 file: ${firstStatFile(lines)} +${ins}/−${del})` : `(${n} files, +${ins}/−${del})`;
			break;
		}
	}
	if (fileStat === "") fileStat = "(stat unavailable)";
	return { date, subject, fileStat };
}

/** The single file name from a one-file `--stat` block (for the 1-file form). */
function firstStatFile(lines: string[]): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = lines[i].match(/^\s{0,3}(\S[^|]*?)\s*\|\s*\d+/);
		if (m) return m[1];
	}
	return "1 file";
}

function groupLines(claims: string[]): string[] {
	return claims.map((c, i) => (i === 0 ? c : `    ${c}`));
}

const NO_CHEAP = "— no cheap result";

/* ── the pipeline ───────────────────────────────────────────────────────── */

export async function runPrechecks(
	facts: ParsedFact[],
	discovery: Discovery,
	runner: Runner,
	clock?: PrecheckClock,
	opts: Partial<PrecheckOptions> = {},
): Promise<PrecheckResult> {
	const cap = opts.windowCap ?? DEFAULT_WINDOW_CAP;
	const tally: Tally = { commands: 0, hardErrors: 0 };
	const entries: string[] = [];
	const positives: PrecheckPositives = { reposUsed: [], commitsFound: [], filesFound: [] };
	const reposUsed = new Set<string>();
	const workspaceRoot = discovery.cwd;

	const valid = new Set<string>();
	for (const repo of discovery.repos) {
		const r = await run(runner, tally, withExit(`git -C ${q(repo.path)} status --porcelain`));
		if (r.outcome === "ok") valid.add(repo.path);
	}
	const validRepos = discovery.repos.filter((r) => valid.has(r.path)).map((r) => r.path);

	/* — clock (injected, or the two `date -u` forms via the runner) — */
	let c = clock;
	if (!c) {
		const r = await run(runner, tally, withExit(`date -u; date -u '+%Y-%m-%d %H:%M:%S'`));
		const lines = r.body.split("\n");
		c = { long: lines[0] ?? "", short: lines[1] ?? "" };
	}
	entries.push(`Clock: ${c.long} · ${c.short}`);

	/* — commits (most-recent repos first, first hit wins) — */
	const commitFacts = facts.filter((f) => f.type === "commit" || f.type === "commit-tagged");
	const commitHashes: string[] = [];
	for (const f of commitFacts) {
		const h = f.type === "commit-tagged" ? f.value.split(/\s+/).pop()! : f.value;
		if (!commitHashes.includes(h)) commitHashes.push(h);
	}
	const commits: CommitCheck[] = [];
	for (const h of commitHashes) {
		let found: CommitCheck | null = null;
		for (const repo of validRepos) {
			const r = await run(runner, tally, withExit(`git -C ${q(repo)} log -1 --stat --format='%ad%x09%s' --date=short ${q(h)}`));
			if (r.outcome === "ok" && r.exit === 0) {
				const parsed = parseCommitLog(r.body);
				if (parsed) {
					found = { hash: h, repo, ...parsed };
					reposUsed.add(repo);
					break;
				}
			}
			if (r.outcome === "hard-error") break; // nothing more can run reliably
		}
		commits.push(found ?? { hash: h, repo: null, date: "", subject: "", fileStat: "" });
	}
	const anyCommitMissing = commits.some((c) => c.repo === null);
	if (commitHashes.length > 0) {
		// header: reduced-noise rule — all found ⇒ repos with hits only;
		// any miss ⇒ ALL valid repos by design
		const headerRepos = anyCommitMissing ? validRepos : [...reposUsed].filter((r) => commits.some((c) => c.repo === r));
		if (headerRepos.length > 0) {
			entries.push("Git repos checked:");
			for (const r of headerRepos) entries.push(`- ${r}`);
		}
	}
	for (const c of commits) {
		if (c.repo) {
			entries.push(`- commit ${c.hash} exists in ${c.repo}`);
			entries.push(`    ${c.date} "${c.subject}"`);
			entries.push(`    ${c.fileStat}`);
			positives.commitsFound.push({ hash: c.hash, repo: c.repo });
		} else {
			entries.push(`- commit ${c.hash} not found in the named repos`);
		}
	}

	/* — files (existence) + file:line / file:range — */
	const fileFacts = facts.filter((f) => f.type === "file" && !/:\d+$/.test(f.value));
	const fileLineFacts = facts.filter((f) => f.type === "file-line");
	const fileRangeFacts = facts.filter((f) => f.type === "file-range");

	/** Resolve a claim path → the absolute paths that exist (all matches).
	 * An absolute claim is tested as the literal path first; on a miss it
	 * falls back to the de-slashified relative reading (2026-11-19, Paul) —
	 * the result is one hit-set per claim either way. */
	const resolvePaths = async (value: string): Promise<string[]> => {
		const hits: string[] = [];
		const isAbs = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
		// 1. the session file index (paths known from edit/write/read) — a
		//    relative claim is resolved against the session cwd first
		const absClaim = isAbs ? value : `${workspaceRoot}/${value}`;
		const indexed = discovery.files.find((f) => f.absPath === value || f.absPath === absClaim);
		if (indexed) {
			const r = await run(runner, tally, withExit(`ls ${q(indexed.absPath)}`));
			if (r.outcome === "ok") hits.push(indexed.absPath);
			return hits;
		}
		if (isAbs) {
			const r = await run(runner, tally, withExit(`ls ${q(value)}`));
			if (r.outcome === "ok") {
				hits.push(value);
				return hits;
			}
			// absolute miss → fall through to the relative reading (leading
			// slash / drive prefix stripped — the claim is then probed like
			// any other relative claim; one hit-set per claim, absolute wins)
			value = value.replace(/^[A-Za-z]:[\\/]/, "").replace(/^\//, "");
		}
		// 2. workspace root + every valid repo root (relative claim)
		const roots = [workspaceRoot, ...validRepos.filter((r) => r !== workspaceRoot)];
		const candidates = [...new Set(roots.map((root) => `${root}/${value}`))];
		// trailing `true`: a claim where every candidate misses must still
		// exit 0 (the misses are the EXPECTED negative, not a hard error)
		const cmd = candidates.map((p) => `[ -f ${q(p)} ] && printf 'HIT %s\\n' ${q(p)}`).join(" ; ") + " ; true";
		const r = await run(runner, tally, withExit(cmd));
		if (r.outcome === "ok" || r.outcome === "expected-negative") {
			for (const line of r.body.split("\n")) {
				const m = line.match(/^HIT (.+)$/);
				if (m) hits.push(m[1]);
			}
		}
		return hits;
	};

	const checkedFiles = new Map<string, string[]>(); // claim → hits (dedupe repeated claims)
	const checkFile = async (claim: string): Promise<string[]> => {
		let hits = checkedFiles.get(claim);
		if (!hits) {
			hits = await resolvePaths(claim);
			checkedFiles.set(claim, hits);
			if (hits.length > 0) {
				positives.filesFound.push({ claim, paths: hits });
				for (const h of hits) {
					const root = validRepos.find((r) => h === r || h.startsWith(r + "/"));
					if (root) reposUsed.add(root);
					else if (h === workspaceRoot || h.startsWith(workspaceRoot + "/")) reposUsed.add(workspaceRoot);
				}
			}
		}
		return hits;
	};

	const fileEntries: string[] = [];
	for (const f of fileFacts) {
		const hits = await checkFile(f.value);
		if (hits.length > 0) fileEntries.push(`- file ${f.value} exists at ${hits.join(" and ")}`);
		else fileEntries.push(`- file ${f.value} could not cheaply be found — checked: workspace root, known git repos`);
	}
	for (const f of fileLineFacts) {
		const m = f.value.match(/^(.*):(\d+)$/);
		if (!m) {
			fileEntries.push(`- file ${f.value} ${NO_CHEAP} (malformed line ref)`);
			continue;
		}
		const [, path, n] = m;
		const hits = await checkFile(path);
		if (hits.length === 0) {
			fileEntries.push(`- file ${f.value} ${NO_CHEAP} (file not found)`);
			continue;
		}
		if (hits.length > 1) {
			fileEntries.push(`- file ${f.value} ${NO_CHEAP} (ambiguous: ${hits.join(", ")})`);
			continue;
		}
		const lo = Math.max(1, Number(n) - 5);
		const hi = Number(n) + 5;
		const r = await run(runner, tally, withExit(`sed -n '${lo},${hi}p' ${q(hits[0])}`));
		if (r.outcome !== "ok" || r.exit !== 0) {
			fileEntries.push(`- file ${f.value} ${NO_CHEAP} (window unavailable)`);
			continue;
		}
		const bytes = Buffer.byteLength(r.body, "utf8");
		if (bytes > cap) {
			fileEntries.push(`- file ${f.value} — surrounding lines ${lo}-${hi} contain ${bytes} bytes`);
		} else {
			fileEntries.push(`- file ${f.value}`);
			fileEntries.push("```");
			fileEntries.push(...(r.body.split("\n").length > 0 ? r.body.split("\n") : [""]));
			fileEntries.push("```");
		}
	}
	for (const f of fileRangeFacts) {
		const m = f.value.match(/^(.*):(\d+)-(\d+)$/);
		if (!m) {
			fileEntries.push(`- file ${f.value} ${NO_CHEAP} (malformed range ref)`);
			continue;
		}
		const [, path, a, b] = m;
		const hits = await checkFile(path);
		if (hits.length === 0) {
			fileEntries.push(`- file ${f.value} ${NO_CHEAP} (file not found)`);
			continue;
		}
		if (hits.length > 1) {
			fileEntries.push(`- file ${f.value} ${NO_CHEAP} (ambiguous: ${hits.join(", ")})`);
			continue;
		}
		const r = await run(runner, tally, withExit(`sed -n '${a},${b}p' ${q(hits[0])} | wc -c`));
		if (r.outcome !== "ok" || r.exit !== 0 || !/^\d+$/.test(r.body.trim())) {
			fileEntries.push(`- file ${f.value} ${NO_CHEAP} (range size unavailable)`);
			continue;
		}
		fileEntries.push(`- file ${f.value} — contains ${r.body.trim()} bytes`);
	}
	entries.push(...fileEntries);

	/* — the remaining claim types: flat self-explanatory lines — */
	const line = (type: string, values: string[], reason: string) => {
		for (const v of values) entries.push(`- ${type} ${v} ${NO_CHEAP} (${reason})`);
	};
	const byType = (t: string) => facts.filter((f) => f.type === t).map((f) => f.value);

	line("testcount", byType("testcount"), "no gate log named in the stub");
	line("gate", byType("gate"), "no named log");
	line("exit-code", byType("exit-code"), "no cheaply reproducible run");
	line("size", byType("size"), "no file association in the stub");
	line("sam-id", byType("sam-id"), "SAM ledger — sam_retrieve, not shell");
	line("session-id", byType("session-id"), "pi session file, not a repo");
	line("unit-ref", byType("unit-ref"), "SAM ledger, not shell");
	line("line-approx", byType("line-approx"), "approximate ref — window, not exact");
	line("bare-line", byType("bare-line"), "implicit file ref — resolver needed");

	// versions + dates: one joined line each (settled display, round 1–3)
	const versions = byType("version");
	if (versions.length > 0) {
		entries.push(`- versions ${[...new Set(versions)].join(" / ")} ${NO_CHEAP} (not checkable from the stub alone)`);
	}
	const dates = byType("date");
	if (dates.length > 0) {
		const foundDates = new Set(commits.filter((c) => c.repo).map((c) => c.date));
		const consistent = [...new Set(dates)].some((d) => foundDates.has(d));
		entries.push(
			`- date ${[...new Set(dates)].join(" / ")} ${NO_CHEAP} (${
				consistent ? "consistent with the commit dates found above, not independently checked" : "not independently checked"
			})`,
		);
	}

	return {
		block: entries.join("\n"),
		positives: {
			reposUsed: [...reposUsed],
			commitsFound: positives.commitsFound,
			filesFound: positives.filesFound,
		},
		commands: tally.commands,
		hardErrors: tally.hardErrors,
	};
}

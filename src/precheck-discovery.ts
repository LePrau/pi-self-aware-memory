/**
 * Stub pre-check — repo/file discovery from the session file (pure, no I/O).
 *
 * Settled design: dev-repo `notes/2026-11-18-stub-precheck-repo-file-discovery.md`
 * (design by Paul, 2026-11-18, including the "Check execution" settlements).
 *
 * What it does:
 * - scans the session file FROM THE LAST FOLD (the last `compaction` entry) to
 *   the end — in a fork session file (which by construction contains only
 *   post-fold history) there is no compaction entry, so the rule is
 *   automatically whole-file; one rule, both cases (Paul, 2026-11-18:
 *   "we only have the sessions since the last fold anyway — this makes
 *   'from the last fold' automatically consistent in both cases");
 * - derives repo candidates from bash commands: `git -C <dir>` (wins over any
 *   `cd` in the same command), `git --git-dir=`/`--work-tree=`, and any
 *   `cd <dir>` (in a command that also invokes git — covers `sudo git` — or
 *   bare); unanchored, so subshells `(cd …)` and `bash -c "cd …"` are covered;
 *   both OS path separators; variable-indirected dirs are out of scope by
 *   design (the executor's `git status` validity filter discards strays);
 * - always adds the session cwd (bare `git` runs there);
 * - indexes files from edit/write/read tool calls ONLY (bash-written files are
 *   invisible by design — they surface in `git log --stat`), keyed by the
 *   ABSOLUTE path resolved against the session cwd at collection time.
 *
 * What it does NOT do: it runs no commands, makes no network/FS claims, and
 * never scans the workspace (that is the executor's bounded job, and only the
 * workspace root + the discovered repo roots are ever touched there).
 *
 * Pure and total: test-pinned by test/precheck-discovery.test.ts.
 */

import type { RawEntry } from "./branchaudit.ts";
import { flattenToolCallBlock } from "./extraction.ts";

export interface DiscoveredRepo {
	/** The directory as discovered (absolute or `~` — not normalized; commit
	 *  checks work from any subfolder of a work tree, so no toplevel fix-up). */
	path: string;
	/** Index of the last session entry that referenced this dir. */
	lastEntryIndex: number;
	/** The (truncated) command that surfaced it, for the audit-prompt table. */
	evidence: string;
}

export interface DiscoveredFile {
	/** Absolute path, resolved against the session cwd at collection time. */
	absPath: string;
	/** The tool of the LAST occurrence (write > edit > read is the executor's
	 *  resolution ORDER; the index keeps raw recency). */
	lastTool: "write" | "edit" | "read";
	/** Index of the last session entry that touched this file. */
	lastEntryIndex: number;
}

export interface Discovery {
	/** Unique candidate dirs, most-recent-first (the commit-testing order). */
	repos: DiscoveredRepo[];
	/** Unique file-index entries, most-recent-first. */
	files: DiscoveredFile[];
	/** The session cwd (from the `session` header entry, or the fallback). */
	cwd: string;
	/** Entry index the scan started at (last compaction + 1, or 0). */
	scanStart: number;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const EVIDENCE_MAX = 80;

function truncate(s: string, max = EVIDENCE_MAX): string {
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Absolute-ish dir tokens: /…, ./…, ../…, ~…, A:\… / A:/… */
const DIR = "(?:~|/|\\.\\./|\\./|[A-Za-z]:[\\\\/])(?:[\\w.\\-@+]*(?:[\\\\/][\\w.\\-@+]+)*)";
const QUOTED = "(\"|')?";

const GIT_C = new RegExp(`git\\s+-C\\s+${QUOTED}(${DIR})\\1`, "g");
const GIT_GITDIR = new RegExp(`--git-dir=(${DIR})`, "g");
const GIT_WORKTREE = new RegExp(`--work-tree=(${DIR})`, "g");
const CD = new RegExp(`\\bcd\\s+${QUOTED}(${DIR})\\1`, "g");

/**
 * Repo candidates from ONE bash command, per the settled precedence:
 * `git -C <dir>` wins over any `cd` in the same command; then
 * `--git-dir=`/`--work-tree=`; then every `cd <dir>` (bare-cd included —
 * the executor's `git status` filter discards non-repos).
 */
export function repoDirsOfCommand(command: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (p: string) => {
		if (!seen.has(p)) {
			seen.add(p);
			out.push(p);
		}
	};
	let m: RegExpExecArray | null;
	// group layout: GIT_C/CD → 1=quote, 2=dir · GIT_GITDIR/GIT_WORKTREE → 1=dir
	GIT_C.lastIndex = 0;
	while ((m = GIT_C.exec(command))) push(m[2]);
	if (out.length === 0) {
		GIT_GITDIR.lastIndex = 0;
		while ((m = GIT_GITDIR.exec(command))) push(m[1]);
	}
	if (out.length === 0) {
		GIT_WORKTREE.lastIndex = 0;
		while ((m = GIT_WORKTREE.exec(command))) push(m[1]);
	}
	if (out.length === 0) {
		// cd targets — bare cd included (the executor's `git status`
		// validity filter is what keeps strays out, per the settled design)
		CD.lastIndex = 0;
		while ((m = CD.exec(command))) push(m[2]);
	}
	return out;
}

/** Resolve a tool-call path against the session cwd (POSIX normalization;
 *  absolute/`~`/drive paths pass through untouched). */
export function resolvePath(p: string, cwd: string): string {
	if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("~")) return p;
	const parts = (cwd.replace(/\\/g, "/").split("/").filter((x) => x !== "" && x !== "."));
	for (const seg of p.replace(/\\/g, "/").split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (parts.length > 0) parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return "/" + parts.join("/");
}

/* ── the scan ────────────────────────────────────────────────────────────── */

const FILE_TOOLS = new Set(["edit", "write", "read"]);

export function discoverFromSession(entries: RawEntry[], fallbackCwd: string): Discovery {
	const cwdEntry = entries.find((e) => e.type === "session" && typeof e.cwd === "string" && e.cwd !== "");
	const cwd = cwdEntry?.cwd ?? fallbackCwd;

	let scanStart = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			scanStart = i + 1;
			break;
		}
	}

	const repos = new Map<string, DiscoveredRepo>();
	const files = new Map<string, DiscoveredFile>();
	let cwdUseIndex = -1; // last bare `git` (a git command with no cd/-C dir of its own)

	for (let i = scanStart; i < entries.length; i++) {
		const e = entries[i];
		if (e.type !== "message" || !e.message || e.message.role !== "assistant") continue;
		const content = e.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			for (const call of flattenToolCallBlock(block)) {
				const name = call.name;
				const args = call.arguments ?? {};
				if (name === "bash") {
				const command = typeof args.command === "string" ? args.command : "";
				if (command === "") continue;
				const dirs = repoDirsOfCommand(command);
				if (dirs.length === 0 && /\bgit\b/.test(command)) cwdUseIndex = i;
				for (const dir of dirs) {
					const prev = repos.get(dir);
					if (prev) prev.lastEntryIndex = i;
					else repos.set(dir, { path: dir, lastEntryIndex: i, evidence: truncate(command) });
				}
			} else if (FILE_TOOLS.has(name)) {
				const path = typeof args.path === "string" ? args.path : "";
				if (path === "") continue;
				const abs = resolvePath(path, cwd);
				const prev = files.get(abs);
				const tool = name as "write" | "edit" | "read";
				if (prev) {
					prev.lastTool = tool;
					prev.lastEntryIndex = i;
				} else {
					files.set(abs, { absPath: abs, lastTool: tool, lastEntryIndex: i });
				}
			}
		}
	}
	}

	// session cwd is always a candidate (bare `git` runs there); its recency is
	// the last bare-git command, or least-recent when none was seen
	if (cwd) {
		const prev = repos.get(cwd);
		if (prev) prev.lastEntryIndex = Math.max(prev.lastEntryIndex, cwdUseIndex);
		else repos.set(cwd, { path: cwd, lastEntryIndex: cwdUseIndex, evidence: "session cwd" });
	}

	const reposArr = [...repos.values()].sort((a, b) => b.lastEntryIndex - a.lastEntryIndex);
	const filesArr = [...files.values()].sort((a, b) => b.lastEntryIndex - a.lastEntryIndex);
	return { repos: reposArr, files: filesArr, cwd, scanStart };
}

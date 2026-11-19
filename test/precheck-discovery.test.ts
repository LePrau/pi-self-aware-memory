/**
 * Stub pre-check — repo/file discovery (src/precheck-discovery.ts).
 *
 * Pins the settled design (dev-repo notes/2026-11-18-stub-precheck-repo-file-discovery.md):
 * the last-fold scan window (whole file when there is no compaction entry —
 * fork files, per Paul's consistency ruling), the repo-derivation patterns and
 * their precedence (git -C wins over cd in the same command; --git-dir /
 * --work-tree; any cd incl. bare cd and subshell forms; variable-indirected
 * dirs out of scope), the session-cwd candidate and its recency (last bare git),
 * and the edit/write/read file index keyed by the ABSOLUTE path resolved at
 * collection time (bash-written files invisible by design).
 *
 * Run: node --test test/precheck-discovery.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { repoDirsOfCommand, resolvePath, discoverFromSession } from "../src/precheck-discovery.ts";
import type { RawEntry } from "../src/branchaudit.ts";

/* ── repoDirsOfCommand (unit) ────────────────────────────────────────────── */

test("repoDirsOfCommand: cd with git, bare cd, subshells, sudo git", () => {
	assert.deepEqual(repoDirsOfCommand("cd /w/ext && git status"), ["/w/ext"]);
	assert.deepEqual(repoDirsOfCommand("cd /w/dev && git log -1"), ["/w/dev"]);
	assert.deepEqual(repoDirsOfCommand("(cd /w/a && git status)"), ["/w/a"]);
	assert.deepEqual(repoDirsOfCommand('bash -c "cd /w/b && git status"'), ["/w/b"]);
	assert.deepEqual(repoDirsOfCommand("cd /w/c\ngit status"), ["/w/c"]);
	assert.deepEqual(repoDirsOfCommand("cd /w/d; git status"), ["/w/d"]);
	assert.deepEqual(repoDirsOfCommand("sudo git -C /w/e status"), ["/w/e"]);
	assert.deepEqual(repoDirsOfCommand("cd /w/f"), ["/w/f"]); // bare cd — validity filter later
});

test("repoDirsOfCommand: git -C wins over cd in the same command; --git-dir/--work-tree", () => {
	assert.deepEqual(repoDirsOfCommand("cd /w/a && git -C /w/b log"), ["/w/b"]);
	assert.deepEqual(repoDirsOfCommand("git --git-dir=/w/c/.git log"), ["/w/c/.git"]);
	assert.deepEqual(repoDirsOfCommand("git --work-tree=/w/d log"), ["/w/d"]);
	// space in a dir name is not in the token class — no candidate (limitation);
	// the claim then simply stays unresolved, which is the safe behaviour
	assert.deepEqual(repoDirsOfCommand('git -C "/w/e f" status'), []);
});

test("repoDirsOfCommand: no git, no cd → none; variable-indirected dirs out of scope; windows paths", () => {
	assert.deepEqual(repoDirsOfCommand("git status"), []);
	assert.deepEqual(repoDirsOfCommand("cd $HOME/repo && git status"), []);
	assert.deepEqual(repoDirsOfCommand("cd ~/x && echo hi"), ["~/x"]);
	assert.deepEqual(repoDirsOfCommand("cd C:\\repo && git status"), ["C:\\repo"]);
	assert.deepEqual(repoDirsOfCommand("cd ./ext && git status"), ["./ext"]);
	assert.deepEqual(repoDirsOfCommand("cd ../up && git status"), ["../up"]);
	// a cd glued to other words must not match (the \b guard)
	assert.deepEqual(repoDirsOfCommand("echo discard /x && git status"), []);
});

/* ── resolvePath ─────────────────────────────────────────────────────────── */

test("resolvePath: relative joins against cwd, absolute/~/drive pass through, .. normalizes", () => {
	assert.equal(resolvePath("CURRENT_TASK.md", "/workspace"), "/workspace/CURRENT_TASK.md");
	assert.equal(resolvePath("src/x.ts", "/workspace/a"), "/workspace/a/src/x.ts");
	assert.equal(resolvePath("../up/x", "/workspace/a/b"), "/workspace/a/up/x");
	assert.equal(resolvePath("/abs/p.ts", "/workspace"), "/abs/p.ts");
	assert.equal(resolvePath("~/.pi/x", "/workspace"), "~/.pi/x");
	assert.equal(resolvePath("C:\\win\\p.ts", "/workspace"), "C:\\win\\p.ts");
});

/* ── discoverFromSession (integration) ───────────────────────────────────── */

type Block = { type: "toolCall"; name: string; arguments: Record<string, unknown> };
let seq = 0;
const id = () => `e${++seq}`;
const assistant = (...blocks: Block[]): RawEntry => ({ id: id(), type: "message", message: { role: "assistant", content: blocks } });
const bash = (command: string): Block => ({ type: "toolCall", name: "bash", arguments: { command } });
const fileTool = (name: "write" | "edit" | "read", path: string): Block => ({ type: "toolCall", name, arguments: { path } });
const header = (cwd: string): RawEntry => ({ id: id(), type: "session", cwd, version: 1 });
const compaction = (summary: string): RawEntry => ({ id: id(), type: "compaction", summary });

test("discoverFromSession: last-fold window — pre-fold tool calls are ignored", () => {
	const entries: RawEntry[] = [
		header("/workspace"),
		assistant(bash("cd /w/pre-fold && git status")),
		compaction("old"),
		assistant(bash("cd /w/post-fold && git status")),
	];
	const d = discoverFromSession(entries, "/fallback");
	assert.equal(d.scanStart, 3); // the entry after the compaction marker
	assert.deepEqual(d.repos.map((r) => r.path), ["/w/post-fold", "/workspace"]);
});

test("discoverFromSession: fork file (no compaction entry) scans the whole file", () => {
	const entries: RawEntry[] = [header("/workspace"), assistant(bash("cd /w/all && git status"))];
	const d = discoverFromSession(entries, "/fallback");
	assert.equal(d.scanStart, 0);
	assert.ok(d.repos.some((r) => r.path === "/w/all"));
});

test("discoverFromSession: most-recent-first ordering; cwd recency = last bare git", () => {
	const entries: RawEntry[] = [
		header("/workspace"),
		assistant(bash("cd /w/ext && git status")), // i=1
		assistant(bash("cd /w/dev && git status")), // i=2
		assistant(bash("git status")), // i=3 → bare git at cwd
	];
	const d = discoverFromSession(entries, "/fallback");
	assert.deepEqual(d.repos.map((r) => r.path), ["/workspace", "/w/dev", "/w/ext"]);
});

test("discoverFromSession: cwd candidate always present, least-recent when no bare git", () => {
	const entries: RawEntry[] = [header("/workspace"), assistant(bash("cd /w/only && git status"))];
	const d = discoverFromSession(entries, "/fallback");
	assert.deepEqual(d.repos.map((r) => r.path), ["/w/only", "/workspace"]);
	assert.equal(d.repos.find((r) => r.path === "/workspace")?.evidence, "session cwd");
});

test("discoverFromSession: file index — absolute keys, last occurrence wins, recency order", () => {
	const entries: RawEntry[] = [
		header("/workspace"),
		assistant(fileTool("write", "/workspace/a.ts")), // i=1
		assistant(fileTool("edit", "/workspace/b.ts")), // i=2
		assistant(fileTool("read", "/workspace/a.ts")), // i=3 → a.ts now lastTool=read
		assistant(fileTool("write", "tmp/rel.log")), // i=4 → /workspace/tmp/rel.log
	];
	const d = discoverFromSession(entries, "/fallback");
	assert.deepEqual(
		d.files.map((f) => `${f.absPath}:${f.lastTool}`),
		["/workspace/tmp/rel.log:write", "/workspace/a.ts:read", "/workspace/b.ts:edit"],
	);
});

test("discoverFromSession: bash tool calls never enter the file index; unknown args are skipped", () => {
	const entries: RawEntry[] = [
		header("/workspace"),
		assistant(bash("echo hi > /workspace/bash-written.txt")),
		assistant({ type: "toolCall", name: "write", arguments: {} }), // no path
		assistant({ type: "toolCall", name: "grep", arguments: { path: "/workspace/x.ts" } }), // not a file tool
	];
	const d = discoverFromSession(entries, "/fallback");
	assert.equal(d.files.length, 0);
});

test("discoverFromSession: cwd falls back to the parameter when the header has none; empty input is total", () => {
	const d1 = discoverFromSession([{ id: "u0", type: "message", message: { role: "user", content: "hi" } }], "/fallback-cwd");
	assert.equal(d1.cwd, "/fallback-cwd");
	assert.deepEqual(d1.repos.map((r) => r.path), ["/fallback-cwd"]);
	const d2 = discoverFromSession([], "/none");
	assert.deepEqual(d2.files, []);
	assert.equal(d2.scanStart, 0);
});

test("discoverFromSession: evidence is the truncated first command", () => {
	const cmd = "cd /w/long && " + "git log -1 --stat ".repeat(5) + "tail";
	const d = discoverFromSession([header("/workspace"), assistant(bash(cmd))], "/f");
	const repo = d.repos.find((r) => r.path === "/w/long");
	assert.ok(repo && repo.evidence.length <= 80 && repo.evidence.endsWith("…"));
});

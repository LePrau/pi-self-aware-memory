/**
 * Integration-ish tests for the P0 factory, without pi:
 * the factory is driven against a fake ExtensionAPI and fake contexts, so
 * the suite pins what the extension *does* (and, crucially, does not do)
 * to a session: registers the /sam surface, announces once, and never
 * appends entries, sends messages, or registers tools.
 *
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import factory from "../extensions/self-aware-memory/index.ts";

/* ── fakes ─────────────────────────────────────────────────────────── */

interface FakeCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}
type Listener = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakePi {
  api: ExtensionAPI;
  commands: Map<string, FakeCommand>;
  listeners: Map<string, Listener[]>;
  toolRegistrations: number;
  appendEntryCalls: number;
  sendCalls: number;
}

function makeFakePi(): FakePi {
  const commands = new Map<string, FakeCommand>();
  const listeners = new Map<string, Listener[]>();
  const fake = {
    commands,
    listeners,
    toolRegistrations: 0,
    appendEntryCalls: 0,
    sendCalls: 0,
    on: (event: string, handler: Listener) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    registerCommand: (name: string, options: Omit<FakeCommand, never>) => {
      commands.set(name, options);
    },
    registerTool: () => {
      fake.toolRegistrations += 1;
    },
    appendEntry: () => {
      fake.appendEntryCalls += 1;
    },
    sendMessage: () => {
      fake.sendCalls += 1;
    },
    sendUserMessage: () => {
      fake.sendCalls += 1;
    },
  };
  return {
    api: fake as unknown as ExtensionAPI,
    commands,
    listeners,
    get toolRegistrations() {
      return fake.toolRegistrations;
    },
    get appendEntryCalls() {
      return fake.appendEntryCalls;
    },
    get sendCalls() {
      return fake.sendCalls;
    },
  };
}

interface FakeCtxOverrides {
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  usage?: () => unknown;
  model?: unknown;
}

function makeCtx(over: FakeCtxOverrides = {}) {
  const notified: string[] = [];
  const raw = {
    hasUI: over.hasUI ?? true,
    mode: over.mode ?? "tui",
    ui: { notify: (msg: string) => notified.push(msg) },
    getContextUsage: () => over.usage?.() ?? undefined,
    model: over.model ?? undefined,
  };
  return { ctx: raw as unknown as ExtensionContext, notified };
}

function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return fn()
    .then((result) => ({ result, lines }))
    .finally(() => {
      console.error = orig;
    });
}

async function runSam(pi: FakePi, args: string, over: FakeCtxOverrides = {}): Promise<string[]> {
  const { ctx, notified } = makeCtx(over);
  const cmd = pi.commands.get("sam");
  assert.ok(cmd, "the factory must register the /sam command");
  await cmd.handler(args, ctx);
  return notified;
}

/* ── tests ─────────────────────────────────────────────────────────── */

test("factory: registers /sam + one session_start listener, nothing else", () => {
  const pi = makeFakePi();
  factory(pi.api);
  assert.deepEqual([...pi.commands.keys()], ["sam"]);
  assert.ok(pi.commands.get("sam")?.description?.includes("/sam"));
  assert.equal(pi.listeners.get("session_start")?.length, 1);
  assert.equal(pi.toolRegistrations, 0, "P0 registers no tool (close_unit lands with P2)");
});

test("factory: announces exactly once at session start", async () => {
  const pi = makeFakePi();
  factory(pi.api);
  const start = pi.listeners.get("session_start")!;
  const { ctx, notified } = makeCtx({ mode: "print", hasUI: false });
  await captureStderr(async () => {
    for (const l of start) l({ type: "session_start", reason: "startup" }, ctx);
  }).then(({ lines }) => {
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^pi-self-aware-memory 0\.0\.1 loaded — \/sam for status · /);
  });
  // hasUI channel: notification, not console
  const ui = makeCtx({ mode: "tui", hasUI: true });
  for (const l of start) l({ type: "session_start", reason: "resume" }, ui.ctx);
  assert.equal(ui.notified.length, 1);
  assert.match(ui.notified[0], /^pi-self-aware-memory 0\.0\.1 loaded — \/sam for status · /);
});

test("/sam: renders the P0 status block (UI channel)", async () => {
  const pi = makeFakePi();
  factory(pi.api);
  const lines = await runSam(pi, "");
  assert.equal(lines.length, 1);
  const text = lines[0];
  assert.match(text, /^── sam ── pi-self-aware-memory 0\.0\.1 ──$/m);
  assert.match(text, /mode: manual/m);
  assert.match(text, /model: none/m);
  assert.match(text, /context: unknown \(no usage yet\)/m);
  assert.match(text, /units: open 0 · closed 0 · folds 0 · audits 0$/m);
  assert.match(text, /fold · report · undo: not yet — P2/m);
});

test("/sam: print mode goes to stderr, json mode is silent", async () => {
  const pi = makeFakePi();
  factory(pi.api);
  const { lines } = await captureStderr(() => runSam(pi, "", { hasUI: false, mode: "print" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /── sam ──/);
  const { lines: jsonLines } = await captureStderr(() => runSam(pi, "", { hasUI: false, mode: "json" }));
  assert.equal(jsonLines.length, 0);
});

test("/sam mode: switches, reports, and rejects unknown modes", async () => {
  const pi = makeFakePi();
  factory(pi.api);
  const ok = await runSam(pi, "mode display");
  assert.match(ok[0], /^sam: mode is now 'display'/);
  const status = await runSam(pi, "");
  assert.match(status[0], /mode: display/m);
  const bad = await runSam(pi, "mode turbo");
  assert.equal(bad.length, 1);
  assert.match(bad[0], /^sam: unknown mode 'turbo' — one of: display \| manual \| assisted \| auto$/);
  const still = await runSam(pi, "");
  assert.match(still[0], /mode: display/m);
  // restore the default for the other tests in this file/process
  await runSam(pi, "mode manual");
});

test("/sam fold|report|undo: honest 'not yet' stubs", async () => {
  const pi = makeFakePi();
  factory(pi.api);
  for (const sub of ["fold", "report", "undo"]) {
    const lines = await runSam(pi, sub);
    assert.match(lines[0], new RegExp(`^sam: '/sam ${sub}' is planned but not yet implemented \\(phase P2\\)`));
  }
  const unknown = await runSam(pi, "warp");
  assert.match(unknown[0], /^sam: unknown subcommand 'warp'/);
});

test("fail-open: a throwing handler degrades to an error line, never a throw", async () => {
  const pi = makeFakePi();
  factory(pi.api);
  const { ctx, notified } = makeCtx({
    usage: () => {
      throw new Error("boom (simulated)");
    },
  });
  const cmd = pi.commands.get("sam")!;
  await cmd.handler("", ctx);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /^sam: internal error \(no state changed\): boom \(simulated\)$/);
});

test("P0 contract: driving the whole surface mutates nothing", async () => {
  // One fake for the entire drive: the fake counts every mutation channel
  // the extension code could use (entries, messages, tools, plus the
  // boundary drafts pi would receive from turn_end/agent_before_settle —
  // the P0 code registers no such handlers at all).
  const pi = makeFakePi();
  factory(pi.api);
  await captureStderr(async () => {
    for (const l of pi.listeners.get("session_start") ?? [])
      l({ type: "session_start", reason: "startup" }, makeCtx({ hasUI: false, mode: "print" }).ctx);
    for (const args of ["", "mode display", "mode bogus", "mode manual", "fold", "report", "undo", "warp"]) {
      await runSam(pi, args, { hasUI: false, mode: "print" });
    }
  });
  assert.equal(pi.appendEntryCalls, 0, "no ledger entries in P0");
  assert.equal(pi.sendCalls, 0, "no messages sent in P0");
  assert.equal(pi.toolRegistrations, 0, "no tools registered in P0");
  for (const evt of ["turn_end", "agent_before_settle", "session_before_compact"]) {
    assert.equal(pi.listeners.get(evt)?.length ?? 0, 0, `no ${evt} handler in P0`);
  }
});

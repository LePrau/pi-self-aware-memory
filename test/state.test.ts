/**
 * Unit tests: session state + identity (P0).
 * Run: node --test test/   (node ≥ 22.6 with type stripping; zero deps)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EXTENSION_NAME, SAM_VERSION, describeBuild } from "../src/identity.ts";
import { createSamState, DEFAULT_SAM_MODE, isSamMode, SAM_MODES } from "../src/state.ts";

test("state defaults: manual mode, all counters zero", () => {
  const s = createSamState();
  assert.equal(s.mode, DEFAULT_SAM_MODE);
  assert.equal(DEFAULT_SAM_MODE, "manual"); // D5 default, pinned here
  assert.equal(s.openUnits, 0);
  assert.equal(s.closedUnits, 0);
  assert.equal(s.folds, 0);
  assert.equal(s.audits, 0);
  assert.equal(s.inFlight, 0);
});

test("SAM_MODES is exactly the plan-§2 set, in order", () => {
  assert.deepEqual([...SAM_MODES], ["display", "manual", "assisted", "auto"]);
});

test("isSamMode accepts the four modes and rejects the rest", () => {
  for (const m of SAM_MODES) assert.equal(isSamMode(m), true);
  for (const bad of ["", "off", "MANUAL", "auto ", "manualx", "fold"]) assert.equal(isSamMode(bad), false);
});

test("identity: name and version match package.json", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { name: string; version: string };
  assert.equal(EXTENSION_NAME, pkg.name);
  assert.equal(SAM_VERSION, pkg.version);
});

test("describeBuild carries name, version and node version", () => {
  const line = describeBuild();
  assert.ok(line.startsWith(`${EXTENSION_NAME} ${SAM_VERSION} `), line);
  assert.ok(line.includes(`node ${process.version}`), line);
});

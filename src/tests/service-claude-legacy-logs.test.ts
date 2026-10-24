import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { legacySpecs, parseLegacyJob } from "../service-claude-legacy.js";
import { legacyObjects } from "./service-claude-staging-support.js";

test("the pinned inference's private legacy log stays untouched while its component gets a private service log", () => {
  const home = "/tmp/claude-legacy-log-fixture";
  const spec = legacySpecs.find(value => value.kind === "inference")!;
  const plist = legacyObjects(home)[spec.label]!;
  const log = join(home, "Library/Application Support/Claude-3p/inference/inference.log");
  plist.StandardOutPath = log; plist.StandardErrorPath = log;
  const saved = JSON.stringify(plist);
  const state = join(home, "gateway-state");
  const context = { home, state, appNode: "/Applications/Harness Gateway.app/Contents/Resources/backend/runtime/bin/node" };
  const parsed = parseLegacyJob(spec, Buffer.from(saved), plist, context);
  assert.equal(parsed.component.log, join(state, "services", "claude-inference.log"));
  assert.notEqual(parsed.component.log, log);
  assert.deepEqual(parsed.component.args, (plist.ProgramArguments as string[]).slice(1));
  assert.equal(JSON.stringify(plist), saved, "the legacy registration and log destinations are not rewritten");
  for (const path of [join(home, "Library/Application Support/Claude-3p/other/inference.log"), "/tmp/unrelated.log"]) {
    assert.throws(() => parseLegacyJob(spec, Buffer.from(saved), { ...plist, StandardOutPath: path, StandardErrorPath: path }, context), /log path/);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { claudeSessionHolds, recoverClaudeSession, claudeRecoveryPath } from "../claude-session-recovery.js";
import { pinReplay, sessionRegistry, claudeToolNameMode } from "../providers/claude-session-registry.js";
import { sessionKey } from "../providers/claude-live-contract.js";
import { claudeLive } from "../providers/claude-live.js";
import { startGateway } from "../server.js";
import { gatewayToken, validateConfig } from "../config.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { previousClaudeToolPin } from "../providers/claude-legacy-tools.js";
import { prepareClaudeToolNames } from "../providers/claude-session-registry.js";
import { claudeWireToolName, legacyClaudeToolName } from "../providers/claude-tool-names.js";
import type { OpenAITool } from "../protocol/types.js";

test("operator recovery is scoped, compares hold identity and starts no inference", () => {
  const r = sessionRegistry(), scope = "operator-recovery", thread = "held", key = sessionKey(scope, thread), since = Date.now();
  pinReplay(r, key, since, "crashed");
  try {
    const hold = claudeSessionHolds().find(row => row.threadKey === key.slice(0, 8))!;
    assert.deepEqual({ ...hold, revision: "receipt" }, { threadKey: key.slice(0, 8), revision: "receipt", since, reason: "crashed", active: false });
    assert.throws(() => recoverClaudeSession({ ...hold, since: since - 1, toolNameMode: "legacy" }), /changed/);
    pinReplay(r, key, since, "crashed"); // A replacement can have the same millisecond timestamp.
    assert.throws(() => recoverClaudeSession({ ...hold, toolNameMode: "legacy" }), /changed/);
    Object.assign(hold, claudeSessionHolds().find(row => row.threadKey === hold.threadKey));
    r.starting.add(key);
    assert.throws(() => recoverClaudeSession({ ...hold, toolNameMode: "legacy" }), /starting/);
    r.starting.delete(key);
    const other = sessionKey(scope, "other"); pinReplay(r, other, since, "prefix_diverged");
    assert.throws(() => recoverClaudeSession({ threadKey: other.slice(0, 8), since, toolNameMode: "legacy" }), /not a crash/);
    assert.deepEqual(recoverClaudeSession({ ...hold, toolNameMode: "legacy" }), { recovered: true, threadKey: hold.threadKey, inferenceStarted: false });
    assert.equal(r.replayUntil.has(key), false); assert.equal(r.replayUntil.has(other), true);
    assert.equal(claudeToolNameMode(scope, thread), "legacy");
    assert.throws(() => recoverClaudeSession({ ...hold, toolNameMode: "legacy" }), /missing/);
    r.replayUntil.delete(other); r.ended.delete(other);
  } finally { r.starting.delete(key); r.replayUntil.delete(key); r.ended.delete(key); r.recoveryToolNameModes?.delete(key); }
});

test("an adopted 2.0.3 private marker and the current marker both see a legacy request", async () => {
  const root = await mkdtemp("/tmp/gw-old-tool-pin-"), releases = join(root, "releases"), pkg = join(releases, "2.0.3/package"), dist = join(pkg, "dist");
  await mkdir(join(dist, "providers"), { recursive: true, mode: 0o700 });
  await writeFile(join(pkg, "package.json"), '{"type":"module"}');
  await writeFile(join(releases, "2.0.3/.gateway-release"), "2.0.3\n", { mode: 0o600 });
  await writeFile(join(dist, "cli.js"), "", { mode: 0o600 });
  const path = join(dist, "providers/claude-tool-names.js");
  await writeFile(path, "const seen=new WeakSet();export const keepLegacyClaudeToolNames=tools=>tools.forEach(t=>seen.add(t));export const has=t=>seen.has(t);", { mode: 0o600 });
  const r = sessionRegistry(), scope = "legacy-private-weakset", thread = "kept", key = sessionKey(scope, thread);
  try {
    const pin = await previousClaudeToolPin(pathToFileURL(join(releases, "2.0.4/package/dist/providers/claude-legacy-tools.js")).href);
    assert.ok(pin);
    const old = await import(pathToFileURL(path).href) as { has(tool: unknown): boolean };
    const tool: OpenAITool = { type: "function", function: { name: "read" } };
    r.sessions.set(key, { state: "turn_done" } as never); (r.toolNameModes ??= new Map()).set(key, "legacy");
    assert.equal(old.has(tool), false);
    await assert.rejects(prepareClaudeToolNames(scope, thread, [tool], async () => undefined), /cannot be verified/);
    assert.equal(await prepareClaudeToolNames(scope, thread, [tool], async () => pin), "legacy");
    assert.equal(old.has(tool), true);
    assert.equal(claudeWireToolName(tool), legacyClaudeToolName(tool));
  } finally { r.sessions.delete(key); r.toolNameModes?.delete(key); r.toolNamePins?.delete(key); await rm(root, { recursive: true, force: true }); }
});

test("blocked retries do not refresh a crash hold", async () => {
  const r = sessionRegistry(), scope = "fixed-deadline", key = sessionKey(scope, "held"), since = Date.now() - 20000;
  pinReplay(r, key, since, "crashed"); const original = r.replayUntil.get(key);
  try {
    const live = claudeLive({ max: 6, parkMinutes: 60, warmup: 0 });
    for (let i = 0; i < 3; i++) {
      const result = await live.attach({ scope, threadId: "held" } as never, new AbortController().signal);
      assert.deepEqual(result, { kind: "fallback", reason: "session_dead" });
      assert.equal(r.replayUntil.get(key), original);
    }
  } finally { r.replayUntil.delete(key); r.ended.delete(key); }
});

test("recovery HTTP requires authentication, refuses browser origins, and rejects stale apply receipts", async () => {
  const home = await mkdtemp("/tmp/gw-recovery-http-"), r = sessionRegistry(), key = sessionKey("http-recovery", "held"), since = Date.now();
  const config = validateConfig({ version: 1, port: 0, stateDirectory: join(home, "state"), providers: [{ id: "fixture", type: "claude-subscription", models: { fixture: "fixture" } }] });
  const server = await startGateway(config), url = `http://127.0.0.1:${(server.address() as { port: number }).port}${claudeRecoveryPath}`;
  const token = await gatewayToken(config.stateDirectory), headers = { Authorization: `Bearer ${token}` };
  pinReplay(r, key, since, "crashed");
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: "https://untrusted.invalid" } })).status, 403);
    const status = await (await fetch(url, { headers })).json() as { holds: Array<{ threadKey: string; revision: string }> };
    assert.ok(status.holds.some(row => row.threadKey === key.slice(0, 8)));
    const post = (body: unknown) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await post({ threadKey: key.slice(0, 8), since: since - 1, toolNameMode: "legacy" })).status, 409);
    const revision = status.holds.find(row => row.threadKey === key.slice(0, 8))!.revision;
    assert.equal((await post({ threadKey: key.slice(0, 8), revision, since, toolNameMode: "legacy" })).status, 200);
    assert.equal((await post({ threadKey: key.slice(0, 8), since, toolNameMode: "legacy" })).status, 409);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); r.replayUntil.delete(key); r.ended.delete(key); r.recoveryToolNameModes?.delete(key); await rm(home, { recursive: true, force: true }); }
});

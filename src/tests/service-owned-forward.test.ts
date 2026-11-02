import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServiceComponent } from "../service-plan.js";
import { clearOwnedForward, rememberOwnedForward, type OwnedForwardDeps } from "../service-owned-forward.js";

const component: ServiceComponent = { id: "claude-inference-studio", kind: "tunnel", command: "/usr/bin/ssh",
  args: ["-N", "-T", "-o", "ExitOnForwardFailure=yes", "-R", "127.0.0.1:3468:127.0.0.1:3468", "studio"], log: "/fixture/forward.log" };
const owner = { pid: 12345, start: "Mon Nov 2 10:00:00 2026", peer: "100.73.86.17:63954" };

async function fixture() {
  const state = await mkdtemp(join(tmpdir(), "owned-forward-"));
  let alive = true; let clearCalls = 0; let match = true;
  const deps: OwnedForwardDeps = {
    start: async pid => pid === 34567 && alive ? 1000 : undefined,
    alive: () => alive,
    wait: async () => {},
    run: async (file, args) => {
      if (file === "/usr/sbin/lsof") return "n100.73.86.17:63954->100.124.102.126:22\n";
      const command = args.at(-1)!; const encoded = command.match(/'([A-Za-z0-9_-]+)'$/)?.[1]; assert.ok(encoded);
      const request = JSON.parse(Buffer.from(encoded, "base64url").toString());
      assert.equal(request.port, 3468); assert.equal(request.peer, owner.peer);
      if (request.action === "probe") return JSON.stringify(owner);
      clearCalls++; assert.deepEqual(request.owner, owner); return match ? "1\n" : "0\n";
    },
  };
  return { state, deps, dead: () => { alive = false; }, foreign: () => { match = false; }, clearCalls: () => clearCalls };
}

test("a proven forward is recorded without interruption; its live client cannot authorize cleanup", async () => {
  const f = await fixture();
  assert.equal(await rememberOwnedForward(component, 34567, f.state, f.deps), true);
  assert.equal(await clearOwnedForward(component, f.state, f.deps), 0);
  assert.equal(f.clearCalls(), 0);
  f.dead(); assert.equal(await clearOwnedForward(component, f.state, f.deps), 1);
  assert.equal(f.clearCalls(), 1);
});

test("foreign remote ownership and changed definitions never clear a forward", async () => {
  const f = await fixture(); await rememberOwnedForward(component, 34567, f.state, f.deps); f.dead();
  assert.equal(await clearOwnedForward({ ...component, args: [...component.args.slice(0, -1), "other-host"] }, f.state, f.deps), 0);
  assert.equal(f.clearCalls(), 0);
  f.foreign(); assert.equal(await clearOwnedForward(component, f.state, f.deps), 0);
});

test("an unreadable start stamp never proves a live or unprobeable original client is dead", async () => {
  const f = await fixture(); await rememberOwnedForward(component, 34567, f.state, f.deps);
  for (const alive of [true, undefined]) {
    assert.equal(await clearOwnedForward(component, f.state, { ...f.deps, start: async () => undefined, alive: () => alive }), 0);
  }
  assert.equal(f.clearCalls(), 0);
});

test("missing, shared-readable and malformed receipts refuse recovery without sending SSH commands", async () => {
  const f = await fixture(); assert.equal(await clearOwnedForward(component, f.state, f.deps), 0);
  await rememberOwnedForward(component, 34567, f.state, f.deps); f.dead();
  const file = join(f.state, "services", (await readdir(join(f.state, "services")))[0]);
  const saved = await readFile(file, "utf8");
  await writeFile(file, "{}"); assert.equal(await clearOwnedForward(component, f.state, f.deps), 0);
  await writeFile(file, saved); await chmod(file, 0o644);
  assert.equal(await clearOwnedForward(component, f.state, f.deps), 0); assert.equal(f.clearCalls(), 0);
});

test("unproved child sockets, PID replacement, local forwards and unrelated components create no ownership", async () => {
  const f = await fixture();
  assert.equal(await rememberOwnedForward(component, 99999, f.state, f.deps), false);
  for (const candidate of [{ ...component, id: "ordinary-tunnel" }, { ...component, args: ["-N", "-L", "127.0.0.1:3468:127.0.0.1:3468", "studio"] }]) {
    assert.equal(await rememberOwnedForward(candidate, 34567, f.state, f.deps), false);
    assert.equal(await clearOwnedForward(candidate, f.state, f.deps), 0);
  }
  assert.equal(await rememberOwnedForward(component, 34567, f.state, { ...f.deps, run: async () => "" }), false);
  let reads = 0;
  assert.equal(await rememberOwnedForward(component, 34567, f.state, { ...f.deps, start: async () => ++reads === 1 ? 1000 : 2000 }), false);
  assert.equal(f.clearCalls(), 0);
});

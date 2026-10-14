import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { acquireAccountLease, accountLeasePath, inspectAccountLease, processStartedAt } from "../account-lease.js";
import { accountFixture } from "./account-fixture.js";

test("the lease holds pid and start time, excludes a second holder, and releases", async () => {
  const f = await accountFixture(); const release = await acquireAccountLease(f.state, "codex3", "connection"); assert.ok(release);
  const stored = JSON.parse(await readFile(accountLeasePath(f.state, "codex3"), "utf8")); assert.equal(stored.pid, process.pid); assert.ok(Math.abs(stored.startedAt - processStartedAt()) < 5000);
  assert.equal(await acquireAccountLease(f.state, "codex3", "login"), undefined); assert.equal((await inspectAccountLease(f.state, "codex3"))?.holder, "connection");
  assert.ok(await acquireAccountLease(f.state, "other", "login")); // leases are per account
  await release!(); assert.equal(await inspectAccountLease(f.state, "codex3"), undefined); assert.ok(await acquireAccountLease(f.state, "codex3", "host"));
});
test("a lease whose pid was reused (wrong start time) is stale", async () => {
  const f = await accountFixture(); const release = await acquireAccountLease(f.state, "codex3", "host"); await release!();
  const path = accountLeasePath(f.state, "codex3");
  await writeFile(path, JSON.stringify({ version: 1, pid: process.pid, startedAt: processStartedAt() - 3_600_000, acquiredAt: Date.now(), holder: "host", nonce: "n" }) + "\n", { mode: 0o600 });
  assert.equal(await inspectAccountLease(f.state, "codex3"), undefined); assert.ok(await acquireAccountLease(f.state, "codex3", "login"));
});

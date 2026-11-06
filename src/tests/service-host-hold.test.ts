import test from "node:test";
import assert from "node:assert/strict";
import { appsAttached, attachedFromPs } from "../service-host-hold.js";
import { ServiceSupervisor } from "../service-supervisor.js";
import type { ServicePlan } from "../service-plan.js";

const node = "/x/runtime/bin/node /x/current/package/dist/cli.js";

test("an attached desktop adapter or SSH listener holds the host move; an outgoing SSH proxy does not", () => {
  assert.equal(attachedFromPs(`${node} codex-shim --config /c -- app-server --listen stdio://\n`), true, "a desktop adapter");
  assert.equal(attachedFromPs(`${node} codex-shim --ssh --config /c -- app-server --listen unix:///tmp/s\n`), true, "an SSH listener");
  assert.equal(attachedFromPs(`${node} codex-shim --ssh --config /c -- app-server proxy --sock /tmp/s\n`), false, "a proxy to another Mac");
  assert.equal(attachedFromPs(`${node} daemon --config /c\n${node} serve --config /c\n`), false, "the service alone");
});

test("a process list that cannot be read counts as attached", async () => {
  assert.equal(await appsAttached(async () => { throw new Error("ps failed"); }), true);
});

test("while held, the keeper's quiet grace never elapses; released, it is the configured one", () => {
  const plan: ServicePlan = { version: 1, config: "/tmp/gateway.json", components: [] };
  const supervisor = new ServiceSupervisor(plan, "/tmp/gw-hold-state", 1000, undefined, undefined, undefined, undefined, { hostQuietGraceMs: 1234 });
  const heal = (supervisor as unknown as { heal: { hostQuietGraceMs?: number } }).heal;
  assert.equal(heal.hostQuietGraceMs, Number.MAX_SAFE_INTEGER, "a new controller is held until its first scan, or a live swap could move the host");
  (supervisor as unknown as { hostHeld: boolean }).hostHeld = false;
  assert.equal(heal.hostQuietGraceMs, 1234);
  (supervisor as unknown as { hostHeld: boolean }).hostHeld = true;
  assert.equal(heal.hostQuietGraceMs, Number.MAX_SAFE_INTEGER);
});

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { macTunnel } from "../mac-tunnel.js";
import { servicePlanPath } from "../service-plan.js";
import { darwin, fixture, homeIn, none, tempRoot, removeAllRoots, removeRoot } from "./mac-tunnel-remove-fixtures.js";

after(removeAllRoots);

const usageError = /^Error: Choose tunnel install\/status\/uninstall and a lowercase --tunnel-id$/;

/** An action and `--tunnel-id` pair that `gateway tunnel` must refuse before it reads, writes or locks anything. */
const refused: Array<[string | undefined, string]> = [];
for (const action of ["status", "install", "uninstall"] as const) {
  for (const id of ["Spark", "../x", "", "a".repeat(65)]) refused.push([action, id]);
}
refused.push(["bogus", "spark"], [undefined, "spark"]);

test("a bad tunnel action or id is refused without creating the state directory or taking the login lock", async () => {
  for (const [action, id] of refused) {
    const root = await tempRoot("gwt.");
    const state = join(root, "state");
    try {
      await darwin(async () => homeIn(root, async () => {
        await assert.rejects(macTunnel(action, { id }, state, none), usageError);
        assert.equal(existsSync(state), false, `a refused ${action ?? "missing"} --tunnel-id=${id} leaves no state directory`);
        assert.equal(existsSync(join(state, "service-login")), false, "a refusal never takes the login lock");
      }));
    } finally { await removeRoot(root); }
  }
});

test("a bad tunnel id is refused even when a unified plan is present, leaving that plan untouched", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const before = readFileSync(servicePlanPath(f.state), "utf8");
    await darwin(async () => homeIn(f.root, async () => {
      await assert.rejects(macTunnel("uninstall", { id: "Spark" }, f.state, none), usageError);
    }));
    assert.equal(readFileSync(servicePlanPath(f.state), "utf8"), before, "the plan is byte-for-byte unchanged");
  } finally { await f.stop(); }
});

test("gateway tunnel refuses to manage tunnels anywhere but macOS", async () => {
  const state = join(await tempRoot("gwt."), "state");
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    await assert.rejects(macTunnel("status", { id: "spark" }, state, none), /Managed SSH tunnels currently support macOS/);
  } finally { Object.defineProperty(process, "platform", original); }
});

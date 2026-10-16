import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readinessGap } from "../mac-consolidate.js";
import { writePrivateJson } from "../config.js";
import { validateServicePlan, type ServicePlan } from "../service-plan.js";
import { shortFolder } from "./short-folder.js";

/**
 * Consolidation reads what the running service already says, so only the snapshot is
 * injected here: a paused relay on a machine that never registered one is ready, a
 * registered relay still has to connect, and everything else keeps its old answer.
 */
function fixture(state: string, relayHome: string, components: Array<{ id: string; kind: string; state: string }>): { plan: ServicePlan; gap: () => Promise<string | undefined> } {
  const plan = validateServicePlan({ version: 1, config: join(state, "gateway.json"), components: components.map(component => ({
    ...component, command: "/bin/true", args: component.kind === "native" ? ["--daemon", "--relay-home", relayHome] : [], log: join(state, `${component.id}.log`),
  })) }) as ServicePlan;
  return { plan, gap: async () => await readinessGap({ stateDirectory: state, port: 3457 }, plan, Date.now() - 60_000, { status: async () => ({ statusCurrent: true, pid: process.pid, runtime: { components } }) }) };
}

test("a paused relay is ready when nothing registered one here", async () => {
  const folder = await shortFolder("gw-readiness-");
  try {
    assert.equal(await fixture(folder.directory, join(folder.directory, "relay"), [{ id: "desktop", kind: "desktop", state: "complete" }, { id: "native", kind: "native", state: "paused" }]).gap(), undefined);
  } finally { await folder.remove(); }
});

test("a registered relay still has to connect before consolidation is ready", async () => {
  const folder = await shortFolder("gw-readiness-relay-"); const relayHome = join(folder.directory, "relay");
  try {
    await mkdir(relayHome, { recursive: true, mode: 0o700 });
    await writePrivateJson(join(folder.directory, "native-registration.json"), { registered: true, home: relayHome, nativeHome: folder.directory });
    const ready = fixture(folder.directory, relayHome, [{ id: "native", kind: "native", state: "paused" }]);
    assert.equal(await ready.gap(), "native_relay_not_connected");
    await writeFile(join(relayHome, "status.json"), JSON.stringify({ status: "connected" }));
    assert.equal(await ready.gap(), undefined, "a connected relay closes the gap");
  } finally { await folder.remove(); }
});

test("a component that is only waiting, or a plan whose components disagree with the service, is still a gap", async () => {
  const folder = await shortFolder("gw-readiness-waiting-");
  try {
    assert.equal(await fixture(folder.directory, join(folder.directory, "relay"), [{ id: "tunnel", kind: "tunnel", state: "waiting" }]).gap(), "components_not_running");
    assert.equal(await fixture(folder.directory, join(folder.directory, "relay"), [{ id: "desktop", kind: "desktop", state: "running" }]).gap(), undefined);
    const plan = validateServicePlan({ version: 1, config: join(folder.directory, "gateway.json"), components: [{ id: "desktop", kind: "desktop", command: "/bin/true", args: [], log: join(folder.directory, "d.log") }] }) as ServicePlan;
    // A service running a component the plan never asked for is not this installation's ready service.
    assert.equal(await readinessGap({ stateDirectory: folder.directory, port: 3457 }, plan, Date.now() - 60_000, { status: async () => ({ statusCurrent: true, pid: process.pid, runtime: { components: [{ id: "desktop", kind: "desktop", state: "running" }, { id: "native", kind: "native", state: "paused" }] } }) }), "components_not_running");
  } finally { await folder.remove(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireMaintenanceWindow } from "../mac-consolidate.js";
import { servicePlanPath, type ServiceComponent } from "../service-plan.js";
import { writePrivateJson } from "../config.js";

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port; await new Promise(done => server.close(done)); return port;
}
async function fixture(kinds: ServiceComponent["kind"][]) {
  const root = await mkdtemp(join(tmpdir(), "gw-window-")); const state = join(root, "state"); const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: await freePort(), stateDirectory: state, providers: [{ id: "test", type: "claude-subscription", models: { test: "test" } }] }));
  const components = kinds.map(kind => ({ id: kind, kind, command: "/bin/true", args: [], log: join(state, `${kind}.log`) }));
  await writePrivateJson(servicePlanPath(state), { version: 1, config, components });
  return config;
}
const idle = async () => "/sbin/launchd\n";

test("a running plan without inference skips the inference health check", async () => {
  await requireMaintenanceWindow(await fixture(["desktop", "tunnel"]), idle);
});

test("a running plan with inference still requires a healthy idle listener", async () => {
  await assert.rejects(requireMaintenanceWindow(await fixture(["inference", "desktop"]), idle), /fetch failed/);
});

test("an open ChatGPT app still blocks the maintenance window", async () => {
  await assert.rejects(requireMaintenanceWindow(await fixture(["desktop"]), async () => "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n"), /chats are open/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
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
async function fixture(kinds: ServiceComponent["kind"][] | undefined, port?: number) {
  const root = await mkdtemp(join(tmpdir(), "gw-window-")); const state = join(root, "state"); const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: port ?? await freePort(), stateDirectory: state, providers: [{ id: "test", type: "claude-subscription", models: { test: "test" } }] }));
  const components = (kinds ?? []).map(kind => ({ id: kind, kind, command: "/bin/true", args: [], log: join(state, `${kind}.log`) }));
  if (kinds) await writePrivateJson(servicePlanPath(state), { version: 1, config, components });
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

async function listener(body: unknown): Promise<{ port: number; close(): Promise<void> }> {
  const server = createHttpServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as { port: number }).port, close: () => new Promise(done => server.close(() => done())) };
}

test("a busy or unhealthy inference listener blocks the window, an idle healthy one allows it", async () => {
  for (const [body, outcome] of [[{ active: 1, status: "ok" }, /busy or unhealthy/], [{ active: 0, status: "degraded" }, /busy or unhealthy/], [{ active: 0, status: "ok" }, undefined]] as const) {
    const server = await listener(body);
    try {
      const config = await fixture(["inference", "desktop"], server.port);
      if (outcome) await assert.rejects(requireMaintenanceWindow(config, idle), outcome); else await requireMaintenanceWindow(config, idle);
    } finally { await server.close(); }
  }
});

test("a standalone config with no running plan still requires the inference health check", async () => {
  const server = await listener({ active: 2, status: "ok" });
  try { await assert.rejects(requireMaintenanceWindow(await fixture(undefined, server.port), idle), /busy or unhealthy/); } finally { await server.close(); }
});

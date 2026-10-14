import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTunnelComponent } from "../mac-tunnel-remove.js";
import { readServicePlan, servicePlanPath, type ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";

const bind = async (server: { once(event: "error", cb: () => void): unknown; listen(port: number, host: string, cb: () => void): unknown }): Promise<boolean> =>
  new Promise(done => { server.once("error", () => done(false)); server.listen(0, "127.0.0.1", () => done(true)); });

/** A port with nothing behind it; sandboxes that forbid sockets get a random one. */
async function unusedPort(): Promise<number> {
  const server = createNetServer();
  if (await bind(server)) { const port = (server.address() as { port: number }).port; await new Promise(done => server.close(done)); return port; }
  return 41000 + Math.floor(Math.random() * 1000);
}

interface Health { port: number; stop(): Promise<void> }
/** The gateway's /health listener. `null` means no inference listener answers at all. */
async function health(body: Record<string, unknown> | null): Promise<Health> {
  if (body === null) return { port: await unusedPort(), stop: async () => {} };
  const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); });
  if (await bind(server)) return { port: (server.address() as { port: number }).port, stop: () => new Promise(done => server.close(() => done())) };
  const port = await unusedPort(); const real = globalThis.fetch;
  globalThis.fetch = (input, init) => new URL(String(input)).port === String(port)
    ? Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })) : real(input as never, init as never);
  return { port, stop: async () => { globalThis.fetch = real; } };
}

/** A plan with inference, the forward tunnel under test, and a reverse tunnel that must survive. */
async function fixture(answer: Record<string, unknown> | null, provider?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "gw-tunnel-remove-")); const state = join(root, "state"); await mkdir(state, { recursive: true, mode: 0o700 });
  const listener = await health(answer); const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: listener.port, stateDirectory: state,
    providers: [{ id: "claude", type: "claude-subscription", models: { claude: "claude" } }, ...(provider ? [provider] : [])] }));
  const tunnel = (id: string, args: string[]) => ({ id, kind: "tunnel" as const, command: "/usr/bin/ssh", args, log: join(state, `${id}.log`) });
  const plan: ServicePlan = { version: 1, config, sharedExecutors: true, components: [
    { id: "inference", kind: "inference", command: "/bin/true", args: [], log: join(state, "inference.log") },
    { id: "desktop", kind: "desktop", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", args: ["--app", "/Applications/ChatGPT.app"], log: join(state, "desktop.log") },
    tunnel("tunnel-spark", ["-N", "-T", "-L", "127.0.0.1:18301:127.0.0.1:18300", "qwen-spark"]),
    tunnel("tunnel-studio", ["-N", "-T", "-R", "3459:127.0.0.1:3457", "mac-studio"]),
  ] };
  await writePrivateJson(servicePlanPath(state), plan);
  return { state, plan, stop: () => listener.stop() };
}

test("removing a tunnel keeps every other component and archives the plan it replaced", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const result = await removeTunnelComponent(f.state, (await readServicePlan(f.state))!, "spark");
    assert.equal(result.tunnel, "spark"); assert.equal(result.removed, true); assert.equal(result.appliesAt, "next service restart");
    assert.match(String(result.note), /stops at the next gateway service restart/);
    const next = (await readServicePlan(f.state))!;
    assert.deepEqual(next.components.map(component => component.id), ["inference", "desktop", "tunnel-studio"]);
    assert.equal(next.sharedExecutors, true, "the rest of the plan is unchanged");
    assert.deepEqual({ ...next, components: [...next.components.slice(0, 2), f.plan.components[2], next.components[2]] }, f.plan);
    assert.equal((await stat(servicePlanPath(f.state))).mode & 0o777, 0o600);
    const backup = String(result.backup);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(backup, "utf8")), f.plan, "the backup holds the plan from before the removal");
  } finally { await f.stop(); }
});

test("a provider already using the tunnel's local port blocks its removal without a write", async () => {
  const f = await fixture({ active: 0 }, { id: "spark_api", type: "responses-api", baseUrl: "http://127.0.0.1:18301/v1", apiKeyEnv: "SPARK_API_KEY", models: { spark: "spark" } });
  try {
    await assert.rejects(removeTunnelComponent(f.state, (await readServicePlan(f.state))!, "spark"), /Provider spark_api uses this tunnel's local port 18301/);
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    assert.ok(!(await readdir(f.state)).includes("service-backups"));
  } finally { await f.stop(); }
});

test("an unknown tunnel is refused and repeating a removal is idempotent", async () => {
  const f = await fixture({ active: 0 });
  try {
    await assert.rejects(removeTunnelComponent(f.state, (await readServicePlan(f.state))!, "missing"), /No tunnel missing in the unified service plan/);
    assert.ok(!(await readdir(f.state)).includes("service-backups"));
    await removeTunnelComponent(f.state, (await readServicePlan(f.state))!, "spark");
    assert.deepEqual(await removeTunnelComponent(f.state, (await readServicePlan(f.state))!, "spark"), { tunnel: "spark", removed: false, alreadyRemoved: true });
    assert.deepEqual((await readServicePlan(f.state))!.components.map(component => component.id), ["inference", "desktop", "tunnel-studio"]);
  } finally { await f.stop(); }
});

test("busy or unreachable inference blocks a tunnel removal before anything is written", async () => {
  for (const [answer, message] of [[{ active: 2, status: "ok" }, /Gateway has active inference/], [null, /Cannot verify the running gateway is idle/]] as const) {
    const f = await fixture(answer);
    try {
      await assert.rejects(removeTunnelComponent(f.state, (await readServicePlan(f.state))!, "spark"), message);
      assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
      assert.ok(!(await readdir(f.state)).includes("service-backups"));
    } finally { await f.stop(); }
  }
});

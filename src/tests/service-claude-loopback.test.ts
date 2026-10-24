import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor } from "../service-supervisor.js";
import { serviceStatusPath, type ServiceComponent } from "../service-plan.js";
import { fixtureComponent, killFixtures, killFixturesAfterTests } from "./supervisor-fixture.js";

killFixturesAfterTests();

type ComponentStatus = { id: string; kind: string; state: string; pid?: number; restarts: number };
type Status = { components: ComponentStatus[] };

async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1500; attempt++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`the supervisor never reached: ${label}`);
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

async function json(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; } catch { return undefined; }
}

test("the supervisor keeps Claude loopback inference up while its adapter restarts", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-loopback-"));
  const workingDirectory = await realpath(directory);
  const token = "synthetic-loopback-token";
  const alias = "claude-hg-route-2147483647";
  const upstreamModel = "codex/gpt-6.1-sol";
  const upstreamPort = await freePort();
  const adapterPort = await freePort();
  const tokenFile = join(directory, "adapter.token");
  const adapterConfig = join(directory, "adapter.json");
  const adapterReady = join(directory, "adapter-ready.json");
  const inferenceReady = join(directory, "inference-ready.json");
  const requests = join(directory, "inference-requests.jsonl");
  const adapterScript = pathToFileURL(join(process.cwd(), "scripts", "claude-desktop-adapter.mjs")).href;
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await writeFile(adapterConfig, JSON.stringify({
    listenPort: adapterPort, upstream: `http://127.0.0.1:${upstreamPort}`, tokenFile,
    models: [{ id: alias, upstream: upstreamModel, displayName: "GPT · Harness route" }],
  }), { mode: 0o600 });

  const inference = fixtureComponent(directory, "claude-inference", "claude-inference", `
    const fs = require("node:fs"); const http = require("node:http");
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ model: body.model, authorization: request.headers.authorization }) + "\\n");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "message", model: ${JSON.stringify(upstreamModel)}, content: [{ type: "text", text: "loopback ok" }] }));
      });
    });
    server.listen(${upstreamPort}, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(inferenceReady)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, cwd: process.cwd() })));
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
  `);
  const adapter = fixtureComponent(directory, "claude-adapter", "claude-adapter", `
    const fs = require("node:fs");
    import(${JSON.stringify(adapterScript)}).then(async ({ startAdapter }) => {
      const running = await startAdapter({ configPath: ${JSON.stringify(adapterConfig)} });
      fs.writeFileSync(${JSON.stringify(adapterReady)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, cwd: process.cwd(), port: running.port }));
      for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => running.close().then(() => process.exit(0)));
    }).catch(error => { console.error(error); process.exit(1); });
  `);
  for (const component of [inference, adapter]) component.workingDirectory = directory;
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "gateway.json"), components: [inference, adapter] }, directory, 25);
  const status = async (): Promise<Status> => JSON.parse(await readFile(serviceStatusPath(directory), "utf8")) as Status;
  const component = (current: Status, id: string): ComponentStatus => {
    const found = current.components.find(value => value.id === id);
    assert.ok(found, `status includes ${id}`);
    return found;
  };
  const request = async () => fetch(`http://127.0.0.1:${adapterPort}/v1/messages`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: alias, max_tokens: 32, messages: [{ role: "user", content: "hello" }] }),
  });

  try {
    await supervisor.start();
    await until(async () => (await json(adapterReady)) !== undefined && (await json(inferenceReady)) !== undefined, "both loopback children ready");
    await until(async () => (await status()).components.every(value => value.state === "running"), "both loopback children running");
    const before = await status();
    const adapterBefore = component(before, "claude-adapter");
    const inferenceBefore = component(before, "claude-inference");
    assert.ok(adapterBefore.pid && inferenceBefore.pid);
    const [adapterProcess, inferenceProcess] = [await json(adapterReady), await json(inferenceReady)];
    for (const child of [adapterProcess, inferenceProcess]) {
      assert.equal(child?.ppid, process.pid, "the supervised child belongs directly to this test process");
      assert.equal(child?.cwd, workingDirectory, "the component's configured working directory is preserved");
    }

    assert.equal((await fetch(`http://127.0.0.1:${adapterPort}/health`)).status, 401, "the adapter authenticates local routes");
    const catalog = await fetch(`http://127.0.0.1:${adapterPort}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(catalog.status, 200);
    assert.deepEqual((await catalog.json() as { data: Array<{ id: string }> }).data.map(model => model.id), [alias]);
    const first = await request();
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { model: string }).model, alias, "the adapter restores its opaque model alias");
    await until(async () => (await readFile(requests, "utf8").catch(() => "")).includes(upstreamModel), "the mock inference request");
    const firstRequest = JSON.parse((await readFile(requests, "utf8")).trim().split("\n")[0]) as { model: string; authorization: string };
    assert.deepEqual(firstRequest, { model: upstreamModel, authorization: `Bearer ${token}` }, "the adapter forwards only the true upstream model and its synthetic credential");

    process.kill(adapterBefore.pid, "SIGKILL");
    await until(async () => {
      const current = await status();
      const restarted = component(current, "claude-adapter");
      const unchanged = component(current, "claude-inference");
      const ready = await json(adapterReady);
      return restarted.state === "running" && restarted.pid !== adapterBefore.pid && unchanged.pid === inferenceBefore.pid && ready?.pid === restarted.pid;
    }, "adapter retry without inference replacement");
    const after = await status();
    assert.equal(component(after, "claude-inference").pid, inferenceBefore.pid, "adapter recovery leaves Claude inference in place");
    assert.ok(component(after, "claude-adapter").restarts >= 1, "the killed adapter was supervised and retried");
    const recovered = await request();
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as { model: string }).model, alias, "requests still cross the recovered adapter");
  } finally {
    await supervisor.stop();
    await killFixtures(directory);
  }
});

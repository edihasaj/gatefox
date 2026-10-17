import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { adoptGatewayHandler, type GatewayHandler } from "../server.js";

function handler(name: string) {
  let busy = 0; const held: ServerResponse[] = [];
  const value: GatewayHandler & { releaseAll(): void } = {
    handle: (req: IncomingMessage, res: ServerResponse) => { busy++; res.once("close", () => { busy--; }); if (req.url === "/hold") held.push(res); else res.end(name); },
    isIdle: () => busy === 0, abortAll: () => { for (const res of held) res.destroy(); },
    releaseAll: () => { for (const res of held.splice(0)) res.end(name); },
  };
  return value;
}

test("a new handler generation serves new requests while the old one finishes its own", async () => {
  const server = createServer(); const first = handler("first"); const second = handler("second");
  const gateway = adoptGatewayHandler(server, first);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const held = fetch(`${url}/hold`).then(response => response.text());
    while (gateway.isIdle()) await new Promise(resolve => setTimeout(resolve, 5)); // the old generation has accepted the request
    adoptGatewayHandler(server, second);
    assert.equal(await (await fetch(`${url}/now`)).text(), "second", "new requests use the new generation at once");
    assert.equal(gateway.isIdle(), false, "the old generation's running request keeps the server busy");
    first.releaseAll(); assert.equal(await held, "first", "a running request finishes on the code that accepted it");
    while (!gateway.isIdle()) await new Promise(resolve => setTimeout(resolve, 5)); // the closed request is counted out
    assert.equal(gateway.isIdle(), true);
  } finally { server.closeAllConnections(); server.close(); }
});

// No time bound of its own: the steps below (two release copies, a process start, the new release's module load) all slow down with
// the machine, so the only limit is the runner's per-test timeout, and a loaded machine fails nothing.
test("a running server takes over a newly installed release in place, without a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-hot-swap-")); const releases = join(root, "releases");
  for (const version of ["9.0.1", "9.0.2"]) {
    const pkg = join(releases, version, "package"); await mkdir(pkg, { recursive: true });
    // The server needs the compiled sources only: leaving out the tests, maps and declarations makes each copy a tenth of the size.
    await cp(resolve("dist"), join(pkg, "dist"), { recursive: true, filter: source => { const path = relative(resolve("dist"), source); return !/^tests([\\/]|$)/.test(path) && !/\.(map|d\.ts)$/.test(path); } }); await symlink(resolve("node_modules"), join(pkg, "node_modules"));
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@edihasaj/harness-gateway", version, type: "module" }));
  }
  await symlink("releases/9.0.1", join(root, "current"));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const port = (probe.address() as { port: number }).port; probe.close();
  const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port, stateDirectory: join(root, "state"), providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_HOT_SWAP_FIXTURE_KEY", models: { fixture: "upstream" } }] }), { mode: 0o600 });
  const child = spawn(process.execPath, [join(root, "current", "package", "dist", "cli.js"), "serve", "--config", config], { env: { ...process.env, GATEWAY_UPGRADE_CHECK_MS: "100", GATEWAY_TELEMETRY: "off", GATEWAY_ERROR_REPORTS: "off" }, stdio: ["ignore", "ignore", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { child.stderr!.on("data", chunk => { if (String(chunk).includes("Listening")) resolve(); }); child.once("exit", code => reject(new Error(`server exited ${code}`))); });
    const release = async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined))?.headers.get("x-gateway-release") ?? null;
    assert.equal(await release(), "9.0.1");
    await rm(join(root, "current")); await symlink("releases/9.0.2", join(root, "current"));
    // The server checks for a newer release every 100 ms, then loads it; ask until the answer names it, however long that takes.
    let served: string | null = null;
    while (served !== "9.0.2") { await new Promise(resolve => setTimeout(resolve, 50)); served = await release(); }
    assert.equal(served, "9.0.2", "the same process serves the new release");
    assert.equal(child.exitCode, null, "no restart happened");
  } finally { child.kill("SIGTERM"); await once(child, "exit").catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

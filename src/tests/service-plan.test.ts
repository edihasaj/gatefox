import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectServicePlan } from "../mac-consolidate.js";
import { servicePlist } from "../mac-service.js";

test("consolidation preserves tunnel endpoints and excludes CI and unrelated jobs", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-plan-inventory-")); const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({ version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [{ id: "test", type: "claude-subscription", models: { test: "test" } }] }));
  const originalEnvironment = { installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND };
  process.env.GATEWAY_INSTALLED = "1"; process.env.GATEWAY_COMMAND = join(directory, "bin/gateway");
  const file = join(directory, "com.edihasaj.subscription-gateway.plist");
  await writeFile(file, servicePlist(process.execPath, "/unused/cli.js", path, join(directory, "log"), "/usr/bin:/bin"));
  const tunnel = `<?xml version="1.0"?><!-- Managed by subscription-gateway tunnel --><plist version="1.0"><dict><key>Label</key><string>com.edihasaj.subscription-gateway.tunnel.studio</string><key>ProgramArguments</key><array><string>/usr/bin/ssh</string><string>-N</string><string>-R</string><string>127.0.0.1:3460:127.0.0.1:3457</string><string>studio</string></array></dict></plist>`;
  await writeFile(join(directory, "com.edihasaj.subscription-gateway.tunnel.studio.plist"), tunnel);
  await writeFile(join(directory, "actions.runner.edihasaj-subscription-gateway.test.plist"), "unrelated runner, deliberately not parsed");
  await writeFile(join(directory, "com.edihasaj.subscription-gateway.unknown.plist"), "unknown service, deliberately not parsed");
  try {
    const { plan, jobs } = await collectServicePlan(path, directory);
    assert.equal(jobs.length, 2);
    assert.deepEqual(plan.components.find(component => component.kind === "tunnel")?.args, ["-N", "-R", "127.0.0.1:3460:127.0.0.1:3457", "studio"]);
    assert.equal(await readFile(file, "utf8"), servicePlist(process.execPath, "/unused/cli.js", path, join(directory, "log"), "/usr/bin:/bin"));
    await writeFile(file, (await readFile(file, "utf8")).replace("<!-- Managed by subscription-gateway -->", ""));
    await assert.rejects(collectServicePlan(path, directory), /unmanaged service/);
  } finally {
    for (const [key, value] of [["GATEWAY_INSTALLED", originalEnvironment.installed], ["GATEWAY_COMMAND", originalEnvironment.command]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
  }
});

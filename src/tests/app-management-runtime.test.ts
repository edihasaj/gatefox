import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createManagementRuntime, isManagementUnavailable, validateManagementConfig } from "../app-management/runtime.js";

async function bundledFixture(configSource: string, catalogSource: string): Promise<URL> {
  const root = await mkdtemp(join(tmpdir(), "harness-management-runtime-"));
  const management = join(root, "Resources", "management", "dist", "app-management");
  const backend = join(root, "Resources", "backend", "package", "dist");
  await mkdir(management, { recursive: true }); await mkdir(backend, { recursive: true });
  await writeFile(join(management, "runtime.js"), "// fixed fixture anchor\n");
  await writeFile(join(backend, "config.js"), configSource);
  await writeFile(join(backend, "catalog.js"), catalogSource);
  return pathToFileURL(join(management, "runtime.js"));
}

test("delegates validation and discovery to the bundled backend", async () => {
  const runtime = createManagementRuntime(await bundledFixture(
    "export function validateConfig(raw, directory) { return { ...raw, stateDirectory: directory, bundledValidator: true }; }\n",
    "export async function discoverModels() { return [{ model: 'bundled-model', metadata: { displayName: 'Bundled' } }]; }\n",
  ));
  const config = await runtime.validateManagementConfig({
    version: 1, port: 3457, stateDirectory: ".state",
    providers: [{ id: "dgx", type: "chat-completions-api", baseUrl: "http://dgx.tailnet.example/v1", tailnet: true, credentialFile: "key", models: { dgx: "model" } }],
  }, "/fixture");
  assert.equal((config as unknown as Record<string, unknown>).bundledValidator, true);
  assert.equal((config.providers[0] as unknown as Record<string, unknown>).tailnet, true);
  assert.deepEqual(await runtime.discoverManagementModels({ id: "remote", type: "chat-completions-api", models: {}, baseUrl: "http://dgx.example/v1" } as never), [{ model: "bundled-model", metadata: { displayName: "Bundled" } }]);
});

test("fails closed when a present bundled backend cannot be loaded", async () => {
  const runtime = createManagementRuntime(await bundledFixture(
    "export const validateConfig = true;\n",
    "export async function discoverModels() { return []; }\n",
  ));
  await assert.rejects(runtime.validateManagementConfig({}, "/fixture"), isManagementUnavailable);
});

test("uses local validation when no app-bundled backend exists", async () => {
  const config = await validateManagementConfig({
    version: 1, port: 3457, stateDirectory: ".state",
    providers: [{ id: "local", type: "responses-api", baseUrl: "http://127.0.0.1:3457/v1", credentialFile: "key", models: { local: "model" } }],
  }, "/fixture");
  assert.equal(config.providers[0]?.id, "local");
});

test("a packaged app with a missing backend never falls back to source policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-missing-runtime-"));
  const anchor = pathToFileURL(join(root, "Resources", "management", "dist", "app-management", "runtime.js"));
  await assert.rejects(createManagementRuntime(anchor).validateManagementConfig({}, "/fixture"), isManagementUnavailable);
});

test("the management executable responds when invoked through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-management-entry-"));
  const link = join(root, "management.js");
  await symlink(fileURLToPath(new URL("../app-management.js", import.meta.url)), link);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [link], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error("Management response timed out")); }, 5000);
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", code => {
      clearTimeout(timer);
      code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error("Management command failed"));
    });
    child.stdin.end(JSON.stringify({ operation: "inspect", configPath: join(root, "gateway.json") }));
  });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.providers, []);
});

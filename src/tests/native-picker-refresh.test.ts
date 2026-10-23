import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { readNativePickerPreferences, maximumPickerConfigBytes } from "../native-picker-preferences.js";
import type { GatewayConfig } from "../config.js";
import { configureTelemetry } from "../telemetry.js";

type ObjectValue = Record<string, unknown>;
const row = (model: string): ObjectValue => ({ id: model, model, displayName: model, hidden: false, isDefault: false });
const catalog = ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-terra"].map(row);
const slugs = (result: ObjectValue) => (result.data as ObjectValue[]).map(model => String(model.model));
const scratch = () => mkdtemp(join(tmpdir(), "gateway-picker-refresh-"));

// --- Reader ----------------------------------------------------------------------------------------------------------

test("the reader returns only the two picker fields and leaves absent ones absent", async () => {
  const directory = await scratch();
  try {
    const path = join(directory, "gateway.json");
    await writeFile(path, JSON.stringify({ version: 1, providers: [{ credentialFile: "/secret" }], nativeModelPicker: ["gpt-6-astra"], nativeModelPickerPlacement: "last" }));
    assert.deepEqual(await readNativePickerPreferences(path), { nativeModelPicker: ["gpt-6-astra"], nativeModelPickerPlacement: "last" });
    await writeFile(path, JSON.stringify({ version: 1 }));
    assert.deepEqual(await readNativePickerPreferences(path), {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the reader rejects invalid values, bad JSON and non-objects without echoing content", async () => {
  const directory = await scratch(); const path = join(directory, "gateway.json");
  try {
    for (const body of ['{"nativeModelPicker":[]}', '{"nativeModelPicker":["bad id sk-secret"]}', '{"nativeModelPicker":"x"}', '{"nativeModelPickerPlacement":"middle"}', "not json sk-secret", "[]", "null"]) {
      await writeFile(path, body);
      await assert.rejects(readNativePickerPreferences(path), (error: Error) => !error.message.includes("secret"), body);
    }
    await assert.rejects(readNativePickerPreferences(join(directory, "missing.json")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the reader refuses symbolic links, oversized files, directories and FIFOs without hanging", { timeout: 15000 }, async () => {
  const directory = await scratch(); const path = join(directory, "gateway.json");
  try {
    await writeFile(join(directory, "real.json"), "{}");
    await symlink(join(directory, "real.json"), path);
    await assert.rejects(readNativePickerPreferences(path), "a symbolic link is refused");
    const big = join(directory, "big.json");
    await writeFile(big, " ".repeat(maximumPickerConfigBytes + 1));
    await assert.rejects(readNativePickerPreferences(big), "an oversized file is refused");
    await assert.rejects(readNativePickerPreferences(directory), "a directory is refused");
    if (process.platform !== "win32") {
      const fifo = join(directory, "fifo.json");
      execFileSync("mkfifo", [fifo]);
      await assert.rejects(readNativePickerPreferences(fifo, 1000), "a FIFO is refused instead of blocking the open");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// --- Router ----------------------------------------------------------------------------------------------------------

async function routed(read?: () => Promise<{ nativeModelPicker?: string[]; nativeModelPickerPlacement?: "first" | "last" | "hidden" }>, nativeModelPicker?: string[]) {
  const root = await scratch();
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" }, modelMetadata: { "codex/model": { reasoningEfforts: ["low", "high"] } } },
  ], ...(nativeModelPicker ? { nativeModelPicker } : {}) };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "model/list") return { data: catalog.map(model => ({ ...model })), nextCursor: null };
    if (method === "thread/read") return { thread: { id: params.threadId, modelProvider: "openai", model: "gpt-5.6-terra", path: "/no/rollout.jsonl" } };
    if (method === "thread/resume") return { thread: { id: params.threadId }, model: "gpt-5.6-terra", modelProvider: "openai", serviceTier: null };
    return {};
  };
  const levels = ["low", "high"].map(effort => ({ effort }));
  const source = new DesktopCatalog(config, catalog.map(model => ({ slug: model.model, supported_reasoning_levels: levels })), join(root, "desktop.json"));
  const router = new AppServerRouter(config, backend, undefined, source, native, undefined, read); await router.initialize();
  return { router, calls, config };
}

test("without a callback the connect-time picker stays frozen", async () => {
  const f = await routed(undefined, ["gpt-6-astra"]);
  assert.deepEqual(slugs(await f.router.request("model/list", {})).filter(name => name.startsWith("gpt-")), ["gpt-6-astra"]);
  assert.deepEqual(slugs(await f.router.request("model/list", {})).filter(name => name.startsWith("gpt-")), ["gpt-6-astra"]);
});

test("each model/list applies a valid re-read, and an invalid or failing read keeps the last valid values", async () => {
  let next: () => Promise<{ nativeModelPicker?: string[]; nativeModelPickerPlacement?: "first" | "last" | "hidden" }> = async () => ({ nativeModelPicker: ["gpt-6.1-sol"] });
  const f = await routed(() => next(), ["gpt-6-astra"]);
  const natives = async () => slugs(await f.router.request("model/list", {})).filter(name => name.startsWith("gpt-"));
  assert.deepEqual(await natives(), ["gpt-6.1-sol"], "the new allowlist applies without reconnecting");
  next = async () => ({ nativeModelPicker: ["gpt-6.1-sol", "gpt-5.6-terra"], nativeModelPickerPlacement: "last" });
  const all = slugs(await f.router.request("model/list", {}));
  assert.deepEqual(all.filter(name => name.startsWith("gpt-")), ["gpt-6.1-sol", "gpt-5.6-terra"]);
  assert.equal(all[0], "codex/model", "placement last puts the gateway rows first");
  next = async () => { throw new Error("invalid"); };
  assert.deepEqual(slugs(await f.router.request("model/list", {})), all, "a failed read retains the last valid preferences");
  next = async () => ({});
  assert.deepEqual(await natives(), ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-terra"], "a cleared allowlist shows every native row");
});

test("a refreshed picker never changes routing: an unselected native chat resumes and the config is untouched", async () => {
  const f = await routed(async () => ({ nativeModelPicker: ["gpt-6-astra"] }), ["gpt-6.1-sol"]);
  await f.router.request("model/list", {});
  const resumed = { threadId: "saved", model: "gpt-5.6-terra", modelProvider: "openai", path: "/no/rollout.jsonl", config: {} };
  await f.router.request("thread/resume", structuredClone(resumed));
  assert.deepEqual(f.calls.filter(call => call.method === "thread/resume").at(-1)!.params, resumed);
  assert.deepEqual(f.config.nativeModelPicker, ["gpt-6.1-sol"], "the frozen route config object is not replaced");
});

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { modelCatalog } from "./catalog.js";
import { writePrivateJson, type GatewayConfig } from "./config.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};

/** The native engine refreshes its own public metadata with its own authentication. */
async function nativeMetadata(executable: string, args: string[]): Promise<{ models: string[]; catalogPath?: string }> {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve())); child.stderr.resume();
  const pending = new Map<number, { resolve: (value: ObjectValue) => void; reject: (error: Error) => void }>();
  let sequence = 0; let timedOut = false; let hardStop: NodeJS.Timeout | undefined;
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; child.stdin.end(); child.kill("SIGTERM"); hardStop = setTimeout(() => child.kill("SIGKILL"), 1500).unref(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 20000).unref();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message: ObjectValue; try { message = object(JSON.parse(line)); } catch { stop(); return; }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const request = pending.get(message.id)!; pending.delete(message.id);
      message.error ? request.reject(new Error("Native catalog metadata request failed")) : request.resolve(object(message.result));
    } else if (message.id !== undefined && message.method) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Catalog preflight does not execute server requests" } }) + "\n");
  });
  child.on("error", () => stop()); child.stdin.on("error", () => stop());
  child.on("close", () => { for (const request of pending.values()) request.reject(new Error(timedOut ? "Native catalog preflight timed out" : "Native catalog preflight exited")); pending.clear(); });
  const rpc = (method: string, params: ObjectValue) => new Promise<ObjectValue>((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await rpc("initialize", { clientInfo: { name: "gateway_catalog", title: "Gateway catalog metadata", version: "0.1.0" } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const config = object((await rpc("config/read", {})).config);
    const models: string[] = []; let cursor: unknown = null;
    do {
      if (models.length >= 4096) throw new Error("Native catalog exceeds the gateway model limit");
      const response = await rpc("model/list", { cursor, limit: 100 });
      if (!Array.isArray(response.data)) throw new Error("Native engine returned invalid model metadata");
      for (const model of response.data) { const id = object(model).model; if (typeof id !== "string") throw new Error("Native engine returned an invalid model ID"); models.push(id); }
      cursor = response.nextCursor;
    } while (typeof cursor === "string" && cursor);
    return { models, ...(typeof config.model_catalog_json === "string" ? { catalogPath: config.model_catalog_json } : {}) };
  } finally { clearTimeout(timer); stop(); await exited.catch(() => {}); clearTimeout(hardStop); lines.close(); }
}

export async function combinedNativeCatalog(executable: string, args: string[], config: GatewayConfig): Promise<string> {
  const metadata = await nativeMetadata(executable, args);
  const home = process.env.CODEX_HOME || resolve(homedir(), ".codex");
  const source = metadata.catalogPath || resolve(home, "models_cache.json");
  let cached: ObjectValue;
  try {
    if ((await stat(source)).size > 16 * 1024 * 1024) throw new Error();
    cached = object(JSON.parse(await readFile(source, "utf8")));
  } catch { throw new Error("The native model catalog is unavailable; use ordinary Codex until its model cache is ready"); }
  if (!Array.isArray(cached.models)) throw new Error("Native model catalog has no model metadata");
  const native = cached.models.map(object);
  const nativeIDs = new Set(native.map(model => model.slug));
  if (native.some(model => typeof model.slug !== "string") || nativeIDs.size !== native.length || metadata.models.some(model => !nativeIDs.has(model))) throw new Error("Native cache does not match the engine's available models; refusing to replace native metadata");
  const extra = modelCatalog(config).models;
  if (extra.some(model => nativeIDs.has(model.slug))) throw new Error("A gateway model alias collides with a native model ID; rename that alias");
  const highest = Math.max(0, ...native.map(model => typeof model.priority === "number" ? model.priority : 0));
  const path = resolve(config.stateDirectory, "desktop-models.json");
  // Copy only public ModelInfo rows, never cache identity or authentication metadata.
  await writePrivateJson(path, { models: [...native, ...extra.map((model, index) => ({ ...model, priority: highest + index + 1 }))] });
  return path;
}

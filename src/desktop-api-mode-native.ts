import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { nativeEngineExecutable } from "./native-engine-path.js";
import { nativeEnvironment } from "./executor-identity.js";
import { chatGptAppExecutable, chatGptAppRunning, realProcessList } from "./native-pause.js";
import { testSafeRoot } from "./test-root-guard.js";
import { clearDesktopCliPath, desktopCliPathOwner, presetDesktopEnvLocked } from "./mac-desktop.js";
import type { ApiModeDeps } from "./desktop-api-mode.js";

/**
 * Reads and writes the native Codex configuration through the ChatGPT app's own signed engine, never by editing
 * `config.toml` by hand. The engine is started the way the app starts it, pointed at the native home, and answers
 * `config/read` and `config/batchWrite` for that home's user layer. Because the engine does the writing, key order,
 * comments and every setting the gateway never touches stay exactly as the user left them, and a write that races
 * another editor fails on its `expectedVersion` instead of clobbering it.
 *
 * Only the user layer is exposed here. The merged `config/read` answer also carries packaged and managed defaults,
 * which the gateway must never copy into a user file, so this module reads the sparse layer the engine itself writes.
 */

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};

/** One key of the user layer, in the dotted spelling the engine parses, with the value to put there. */
export type NativeConfigEdit = { keyPath: string; value: unknown; mergeStrategy: "replace" | "upsert" };
/** The user layer as the engine sees it: its version stamp and only the keys the file itself holds. */
export type NativeUserConfig = { version: string; config: ObjectValue; file: string };

export interface NativeConfigClient {
  read(): Promise<NativeUserConfig>;
  write(edits: NativeConfigEdit[], expectedVersion: string): Promise<void>;
  close(): Promise<void>;
}

/** The engine rejected a batch before applying it (including an expected-version conflict). */
export class NativeConfigWriteRejected extends Error {}

/** How long one engine round trip may take before the whole call is given up on. */
const engineTimeoutMs = 20000;

/** The engine the app would launch: the signed binary behind the bundle's `codex-cli/bin/codex` launcher. */
export async function apiModeEngine(app: string): Promise<string> {
  return await nativeEngineExecutable(resolve(app, "Contents/Resources/codex-cli/bin/codex"));
}

/** The native home the app's own engine reads: `CODEX_HOME`, else `~/.codex`. Never a gateway-managed home. */
export function apiModeNativeHome(): string {
  return testSafeRoot(resolve(process.env.CODEX_HOME || homedir() + "/.codex"), "native Codex home");
}

/**
 * What API mode does without a test in front of it. The app is found where the desktop adapter already finds it, the
 * process check is the same one the native relay makes, and the session's adapter override is judged and moved by the
 * desktop registration code that owns it, so API mode can never claim a wrapper that is not this gateway's.
 */
export function apiModeDeps(): ApiModeDeps {
  return {
    native: async (nativeHome, app) => await openNativeConfig(await apiModeEngine(app), nativeHome),
    appRunning: async app => await chatGptAppRunning(realProcessList, app === "/Applications/ChatGPT.app" ? chatGptAppExecutable : resolve(app, "Contents/MacOS/ChatGPT")),
    nativeHome: apiModeNativeHome,
    cliPathOwner: stateDirectory => desktopCliPathOwner(stateDirectory),
    clearCliPath: () => clearDesktopCliPath(),
    presetEnv: async stateDirectory => await presetDesktopEnvLocked(stateDirectory),
    now: () => new Date(),
  };
}

/**
 * The user layer of one `config/read` answer. A missing or unreadable layer is a failure, not an empty file: writing
 * against a version the engine never reported is how a configuration gets clobbered.
 */
function userLayer(result: ObjectValue): NativeUserConfig {
  const layers = Array.isArray(result.layers) ? result.layers : [];
  const layer = layers.map(object).find(l => object(l.name).type === "user");
  const version = layer && typeof layer.version === "string" ? layer.version : undefined;
  if (!layer || !version || typeof layer.config !== "object" || layer.config === null || Array.isArray(layer.config)) {
    throw new Error("The Codex engine reported no user configuration layer");
  }
  return { version, config: layer.config as ObjectValue, file: typeof object(layer.name).file === "string" ? object(layer.name).file as string : "" };
}

/**
 * Starts one engine for one API mode operation. Every call is bounded: an engine that never answers, or dies, fails
 * the command instead of hanging it, and `close` always runs. Nothing the engine prints is kept, logged, or returned
 * beyond the configuration values this module was asked to read.
 */
export type NativeConfigProcessDeps = {
  spawn?: typeof spawn;
  setTimeout?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (timeout: NodeJS.Timeout | undefined) => void;
};

export async function openNativeConfig(engine: string, nativeHome: string, deps: NativeConfigProcessDeps = {}): Promise<NativeConfigClient> {
  const child = (deps.spawn || spawn)(engine, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], env: { ...nativeEnvironment(), CODEX_HOME: nativeHome } }) as ChildProcessWithoutNullStreams;
  const setEngineTimeout = deps.setTimeout || setTimeout; const clearEngineTimeout = deps.clearTimeout || clearTimeout;
  const exited = new Promise<void>(done => child.once("close", () => done()));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: ObjectValue) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  let sequence = 0; let failure: Error | undefined; let closed = false; let hardStop: NodeJS.Timeout | undefined;
  const stop = (error: Error) => {
    if (failure) return;
    failure = error;
    child.stdin.end(); child.kill("SIGTERM");
    hardStop = setEngineTimeout(() => child.kill("SIGKILL"), 1500).unref();
  };
  const settle = (error: Error) => { for (const request of pending.values()) { clearEngineTimeout(request.timeout); request.reject(error); } pending.clear(); };
  lines.on("line", line => {
    let message: ObjectValue;
    try { message = object(JSON.parse(line)); } catch { stop(new Error("Codex engine returned an unreadable response")); return; }
    // A server request (a notification the engine wants answered) is refused without acting on it: this client only
    // reads and writes configuration, and executing anything the engine asked for would be orchestration.
    if (message.method !== undefined && message.id !== undefined && message.result === undefined && message.error === undefined) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Configuration access does not execute engine requests" } }) + "\n");
      return;
    }
    if (typeof message.id !== "number" || !pending.has(message.id)) return;
    const request = pending.get(message.id)!; pending.delete(message.id); clearEngineTimeout(request.timeout);
    message.error ? request.reject(new NativeConfigWriteRejected("The Codex engine refused this configuration change")) : request.resolve(object(message.result));
  });
  child.on("error", () => { stop(new Error("The Codex engine could not start")); settle(failure!); });
  child.stdin.on("error", () => { stop(new Error("The Codex engine closed its input")); settle(failure!); });
  child.on("close", () => { settle(failure || new Error("The Codex engine exited before answering")); });
  const call = (method: string, params: ObjectValue): Promise<ObjectValue> => new Promise((resolveCall, rejectCall) => {
    if (failure) return rejectCall(failure);
    const id = ++sequence;
    // One guard per call: an engine that never answers is stopped, and everything in flight fails with it.
    const timeout = setEngineTimeout(() => { stop(new Error("The Codex engine did not answer in time")); settle(failure!); }, engineTimeoutMs).unref();
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timeout });
    try { child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }
    catch (error) { pending.delete(id); clearEngineTimeout(timeout); rejectCall(error instanceof Error ? error : new Error("The Codex engine closed its input")); }
  });
  await call("initialize", { clientInfo: { name: "harness_gateway_api_mode", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  return {
    read: async () => userLayer(await call("config/read", { includeLayers: true })),
    write: async (edits, expectedVersion) => {
      await call("config/batchWrite", { edits: edits.map(edit => ({ keyPath: edit.keyPath, value: edit.value, mergeStrategy: edit.mergeStrategy })), filePath: null, expectedVersion, reloadUserConfig: false });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      child.stdin.end(); child.kill("SIGTERM");
      hardStop = setEngineTimeout(() => child.kill("SIGKILL"), 1500).unref();
      await exited;
      clearEngineTimeout(hardStop); lines.close();
    },
  };
}

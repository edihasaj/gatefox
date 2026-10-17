import { spawn } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { writePrivateJson } from "./config.js";
import { nativeRelayHome } from "./native-control.js";
import { nativePendingPath, nativeRegistrationPath, nativeRegistrationRecord } from "./native-pause.js";
import { serviceLabel, type ServicePlan } from "./service-plan.js";
import { telemetry } from "./telemetry.js";

/** What registering a relay under the unified service may do; each step is replaceable in tests. */
export interface PlanRelayDeps {
  /** Whether a ChatGPT app runs here; a relay never connects beside the app's own remote control. */
  appRunning(): Promise<boolean>;
  /** The relay's `--check`: the app engine, ChatGPT sign-in and the existing, enabled Codex Desktop registration. */
  check(binary: string, args: string[]): Promise<void>;
  /** The relay's `--enable`: it connects with that registration and stops once connected. */
  enable(binary: string, args: string[]): Promise<void>;
  /**
   * Retires the idle SSH listeners that may hold this machine's remote-control slot, or throws a refusal that changes nothing.
   * `pendingAtMs` is when the pending registration was written; only engines started before it can hold the slot.
   */
  clearHolders(pendingAtMs: number): Promise<number>;
}

/** A fixed reason for a relay `--enable` that failed; the relay's own messages are fixed text, so this never reads output. */
function enableFailure(error: unknown): "timeout" | "exit" | "start" | "other" {
  const message = error instanceof Error ? error.message : "";
  return /within 45 seconds/.test(message) ? "timeout" : /stopped before connecting/.test(message) ? "exit" : /could not start/.test(message) ? "start" : "other";
}

/** The relay component's own paths, exactly as the service runs it. */
function planRelay(plan: ServicePlan): { binary: string; args: string[]; home: string; nativeHome: string; codex: string; id: string } {
  const native = plan.components.find(component => component.kind === "native");
  if (!native) throw new Error("The unified service has no native relay component, so there is nothing to register; ChatGPT keeps its own remote control");
  const value = (flag: string): string => {
    const positions = native.args.flatMap((arg, index) => arg === flag ? [index] : []); const found = native.args[positions[0] + 1];
    if (positions.length !== 1 || typeof found !== "string" || !isAbsolute(found)) throw new Error(`The service's native relay needs one absolute ${flag}; nothing was registered`);
    return resolve(found);
  };
  if (native.args.filter(arg => arg === "--daemon").length !== 1) throw new Error("The service's native relay is not its daemon; nothing was registered");
  const home = value("--relay-home"), nativeHome = value("--native-home"), codex = value("--codex");
  // Adapters accept a relay home only under the relay root; one elsewhere would make every adapter start fail.
  const root = dirname(nativeRelayHome(plan.config, nativeHome));
  if (dirname(home) !== root) throw new Error("The service's relay home is outside the gateway's relay folder; nothing was registered");
  return { binary: native.command, args: native.args.filter(arg => arg !== "--daemon"), home, nativeHome, codex, id: native.id };
}

/**
 * Registers the relay a unified service already runs, for a Mac whose relay slot waits as `not_registered`. It uses the
 * plan's own relay binary, relay home, native home and app CLI, proves the existing Codex Desktop registration with the
 * relay's `--check` and `--enable`, and only then writes `<state>/native-registration.json`. It never enrolls a new
 * machine (the relay refuses to), never quits ChatGPT, and installs no LaunchAgent: the service starts the relay at its
 * next re-check while no ChatGPT app is open.
 */
export async function registerPlanRelay(stateDirectory: string, plan: ServicePlan, deps: PlanRelayDeps): Promise<Record<string, unknown>> {
  const relay = planRelay(plan);
  const saved = await nativeRegistrationRecord(stateDirectory);
  const receipt = { registered: true, home: relay.home, nativeHome: relay.nativeHome, codex: relay.codex };
  const result = { service: serviceLabel, mode: "supervised", component: relay.id, relayHome: relay.home, nativeConfigUntouched: true };
  if (saved && JSON.stringify(saved) === JSON.stringify(receipt)) return { ...result, registered: true, unchanged: true };
  if (await deps.appRunning()) { telemetry("native_activation_refused", { reason: "app_running" }); throw new Error("Quit ChatGPT normally on this Mac before registering the native relay; it must replace the original remote transport without two hosts competing"); }
  await deps.check(relay.binary, relay.args);
  // Written before anything else changes: an adapter or SSH listener that starts while the relay connects already stands down.
  // `native-registration.json` is not touched until the relay connected, so the previous registration is its own rollback.
  const pending = nativePendingPath(stateDirectory);
  await writePrivateJson(pending, receipt);
  try {
    await deps.clearHolders((await stat(pending)).mtimeMs);
    process.stderr.write("Connecting the native Codex relay…\n");
    try { await deps.enable(relay.binary, relay.args); }
    catch (error) {
      telemetry("native_activation_failed", { reason: enableFailure(error) });
      throw new Error(`${error instanceof Error ? error.message : "Native relay could not connect"}; the previous registration was kept`);
    }
    await writePrivateJson(nativeRegistrationPath(stateDirectory), receipt);
  } finally { await unlink(pending).catch(() => {}); }
  return { ...result, registered: true, next: "The service starts the relay within seconds while ChatGPT stays closed. Once gateway native status says connected, restart the service while idle (gateway service restart), then open ChatGPT" };
}

/** The relay's `--check`, which resolves everything up to the websocket and prints whether the existing machine is ready. */
export function relayCheck(binary: string, args: string[], timeoutMs = 60000): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(binary, [...args, "--check"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = ""; child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 65536) child.kill("SIGKILL"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs); timer.unref();
    const refused = () => new Error("The native relay check failed: it needs a verified ChatGPT app engine, ChatGPT sign-in and this account's existing, enabled Codex Desktop machine registration (turn on remote control in ChatGPT once). It never enrolls a new machine, and nothing was registered");
    child.once("error", () => { clearTimeout(timer); fail(new Error("Native relay could not start")); });
    child.once("close", code => {
      clearTimeout(timer);
      let ready: { ready?: unknown; existingMachine?: unknown } | undefined;
      try { ready = JSON.parse(output.trim().split("\n").at(-1) || "null"); } catch { ready = undefined; }
      if (code === 0 && ready?.ready === true && ready.existingMachine === true) done(); else fail(refused());
    });
  });
}

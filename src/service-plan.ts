import { readFile, lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export const serviceLabel = "com.edihasaj.subscription-gateway";
export const serviceMarker = "<!-- Managed by subscription-gateway -->";
export interface ServiceComponent {
  id: string;
  kind: "inference" | "desktop" | "native" | "tunnel" | "claude-adapter" | "claude-inference";
  command: string;
  args: string[];
  environment?: Record<string, string>;
  /** The directory the component is spawned in; the Claude adapter and its private inference run beside configs that name relative state. */
  workingDirectory?: string;
  log: string;
}
export interface ServicePlan { version: 1; config: string; components: ServiceComponent[]; sharedExecutors?: boolean; sharedNativeExecutor?: boolean }
export const servicePlanPath = (state: string) => resolve(state, "service-plan.json");
export const serviceStatusPath = (state: string) => resolve(state, "service-status.json");

export function validateServicePlan(value: unknown): ServicePlan {
  const plan = value as ServicePlan;
  if (!plan || plan.version !== 1 || typeof plan.config !== "string" || !isAbsolute(plan.config) || !Array.isArray(plan.components) || !plan.components.length || plan.components.length > 16) throw new Error("Invalid gateway service plan");
  if (plan.sharedExecutors !== undefined && typeof plan.sharedExecutors !== "boolean") throw new Error("sharedExecutors must be boolean");
  if (plan.sharedNativeExecutor !== undefined && typeof plan.sharedNativeExecutor !== "boolean") throw new Error("sharedNativeExecutor must be boolean");
  const ids = new Set<string>(); const singles = new Set<string>();
  for (const component of plan.components) {
    if (!component || !/^[a-z][a-z0-9-]{0,63}$/.test(component.id) || ids.has(component.id) || !["inference", "desktop", "native", "tunnel", "claude-adapter", "claude-inference"].includes(component.kind)) throw new Error("Invalid or duplicate service component");
    ids.add(component.id);
    if (component.kind !== "tunnel" && singles.has(component.kind)) throw new Error("Duplicate service responsibility");
    singles.add(component.kind);
    if (typeof component.command !== "string" || !isAbsolute(component.command) || !Array.isArray(component.args) || component.args.some(arg => typeof arg !== "string" || arg.includes("\0")) || typeof component.log !== "string" || !isAbsolute(component.log)) throw new Error("Invalid service command or log path");
    if (component.workingDirectory !== undefined && (typeof component.workingDirectory !== "string" || !isAbsolute(component.workingDirectory) || /[\0\r\n]/.test(component.workingDirectory))) throw new Error("Invalid service working directory");
    if (component.environment && (typeof component.environment !== "object" || Array.isArray(component.environment) || Object.entries(component.environment).some(([key, val]) => !["PATH", "SSH_AUTH_SOCK"].includes(key) || typeof val !== "string" || /[\0\r\n]/.test(val)))) throw new Error("Service plans allow only PATH and SSH_AUTH_SOCK environment overrides");
  }
  if (plan.sharedExecutors) serviceExecutionPaths(plan);
  if (plan.sharedNativeExecutor) serviceNativeExecutionPaths(plan);
  return plan;
}

/** Native ownership requires this installation's existing remote relay registration. */
export function serviceNativeExecutionPaths(plan: ServicePlan): { codex: string; nativeHome: string } {
  const native = plan.components.find(component => component.kind === "native");
  if (!native) throw new Error("Shared native ownership requires an existing native relay; the desktop-only machine was preserved");
  const positions = native.args.flatMap((arg, index) => arg === "--relay-home" ? [index] : []);
  const relayHome = native.args[positions[0] + 1];
  if (!native.args.includes("--daemon") || positions.length !== 1 || typeof relayHome !== "string" || !isAbsolute(relayHome) || relayHome.includes("\0")) {
    throw new Error("Shared native ownership requires the existing daemon relay and one absolute --relay-home");
  }
  return serviceExecutionPaths(plan);
}

/** Reuse the SDK and native home already selected by this installation. */
export function serviceExecutionPaths(plan: ServicePlan): { codex: string; nativeHome: string } {
  const native = plan.components.find(component => component.kind === "native");
  const desktop = plan.components.find(component => component.kind === "desktop");
  const argument = (component: ServiceComponent, flag: string): string => {
    const positions = component.args.flatMap((arg, index) => arg === flag ? [index] : []);
    const value = component.args[positions[0] + 1];
    if (positions.length !== 1 || typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new Error(`Shared executors require one absolute ${flag} in the existing service plan`);
    return resolve(value);
  };
  if (native) return { codex: argument(native, "--codex"), nativeHome: argument(native, "--native-home") };
  if (desktop) return { codex: resolve(argument(desktop, "--app"), "Contents/Resources/codex-cli/bin/codex"), nativeHome: resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex")) };
  throw new Error("Shared executors require an existing native or desktop component; register it before migration");
}

export async function readServicePlan(state: string): Promise<ServicePlan | undefined> {
  const path = servicePlanPath(state);
  let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 65536) throw new Error("Gateway service plan must be a private file owned by this user");
  return validateServicePlan(JSON.parse(await readFile(path, "utf8")));
}

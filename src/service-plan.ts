import { readFile, lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const serviceLabel = "com.edihasaj.subscription-gateway";
export const serviceMarker = "<!-- Managed by subscription-gateway -->";
export interface ServiceComponent {
  id: string;
  kind: "inference" | "desktop" | "native" | "tunnel";
  command: string;
  args: string[];
  environment?: Record<string, string>;
  log: string;
}
export interface ServicePlan { version: 1; config: string; components: ServiceComponent[] }
export const servicePlanPath = (state: string) => resolve(state, "service-plan.json");
export const serviceStatusPath = (state: string) => resolve(state, "service-status.json");

export function validateServicePlan(value: unknown): ServicePlan {
  const plan = value as ServicePlan;
  if (!plan || plan.version !== 1 || typeof plan.config !== "string" || !isAbsolute(plan.config) || !Array.isArray(plan.components) || !plan.components.length || plan.components.length > 16) throw new Error("Invalid gateway service plan");
  const ids = new Set<string>(); const singles = new Set<string>();
  for (const component of plan.components) {
    if (!component || !/^[a-z][a-z0-9-]{0,63}$/.test(component.id) || ids.has(component.id) || !["inference", "desktop", "native", "tunnel"].includes(component.kind)) throw new Error("Invalid or duplicate service component");
    ids.add(component.id);
    if (component.kind !== "tunnel" && singles.has(component.kind)) throw new Error("Duplicate service responsibility");
    singles.add(component.kind);
    if (typeof component.command !== "string" || !isAbsolute(component.command) || !Array.isArray(component.args) || component.args.some(arg => typeof arg !== "string" || arg.includes("\0")) || typeof component.log !== "string" || !isAbsolute(component.log)) throw new Error("Invalid service command or log path");
    if (component.environment && (typeof component.environment !== "object" || Array.isArray(component.environment) || Object.entries(component.environment).some(([key, val]) => !["PATH", "SSH_AUTH_SOCK"].includes(key) || typeof val !== "string" || /[\0\r\n]/.test(val)))) throw new Error("Service plans allow only PATH and SSH_AUTH_SOCK environment overrides");
  }
  return plan;
}

export async function readServicePlan(state: string): Promise<ServicePlan | undefined> {
  const path = servicePlanPath(state);
  let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 65536) throw new Error("Gateway service plan must be a private file owned by this user");
  return validateServicePlan(JSON.parse(await readFile(path, "utf8")));
}

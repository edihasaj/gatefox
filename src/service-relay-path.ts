import { accessSync, constants, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ServiceComponent } from "./service-plan.js";

const relayInRelease = /^(.+)\/releases\/[^/]+\/package\/native\/gateway-native-relay$/;

/**
 * A plan written by an older installer can name the native relay inside one release folder
 * (`<root>/releases/0.5.0/package/native/gateway-native-relay`). That path never moves, so every
 * later update and every service restart kept starting the old relay. The supervisor starts the
 * relay of `<root>/current` instead whenever that installed relay is an executable file. The plan
 * file itself is left as written, so staged receipts that pin its digest stay valid.
 */
export function followCurrentRelease(component: ServiceComponent, executable: (path: string) => boolean = executableFile): ServiceComponent {
  if (component.kind !== "native" || sep !== "/") return component;
  const match = relayInRelease.exec(resolve(component.command));
  if (!match) return component;
  const current = resolve(match[1], "current", "package", "native", "gateway-native-relay");
  return current !== component.command && executable(current) ? { ...component, command: current } : component;
}

function executableFile(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

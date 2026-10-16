import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ServicePlan } from "./service-plan.js";
import type { AppInfo, Exec } from "./health-types.js";
import { appPairChanged, type HealthState } from "./health-state.js";

/**
 * The app engine section of `gateway health`: which ChatGPT build this Mac runs, and
 * whether it is the build the last run saw. The signed `CodexCLI.app` binary is the one
 * the compatibility check itself requires, so it is the engine the watchdog names, and
 * `CFBundleShortVersionString` is what the update actually moved.
 *
 * Both answers come from one local command each, and only a version token is kept from
 * either, so a surprise in the app's layout can never ride into a report.
 */
const exec = promisify(execFile);
const commandTimeoutMs = 5000;
export const defaultAppPath = "/Applications/ChatGPT.app";
const engineTail = "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const plistTool = "/usr/libexec/PlistBuddy";
const plistKey = "CFBundleShortVersionString";
/** A version field is a token, never a sentence: anything else reads as unknown. */
const versionToken = /^(?:codex-cli\s+)?([0-9][0-9A-Za-z.+-]{0,63})$/;

/** The app the unified service launches, from its desktop component, or the standard location. */
export function appPathFromPlan(plan: ServicePlan | undefined): string {
  const args = plan?.components.find(component => component.kind === "desktop")?.args ?? [];
  const at = args.indexOf("--app");
  const value = at >= 0 ? args[at + 1] : undefined;
  return typeof value === "string" && value.startsWith("/") ? value : defaultAppPath;
}

/** The signed engine binary and the app's Info.plist, both under one app bundle. */
export const appEnginePath = (app: string) => resolve(app, engineTail);
export const appInfoPlist = (app: string) => resolve(app, "Contents/Info.plist");

/** What one command's stdout says about a version, or nothing when it says something else. */
function versionOf(out: string): string | null {
  const match = versionToken.exec(out.trim());
  return match?.[1] ?? null;
}

export interface AppDeps {
  /** Runs one local command and returns its stdout. */
  exec?: Exec;
  exists?: (path: string) => Promise<boolean>;
}

/** The versions this Mac's app reports now. A missing app is `absent`, never a failure. */
export async function readAppInfo(app: string, deps: AppDeps = {}): Promise<AppInfo> {
  const run = deps.exec ?? (async (command: string, args: string[]) => (await exec(command, args, { timeout: commandTimeoutMs })).stdout);
  const present = deps.exists ?? (path => access(path, constants.F_OK).then(() => true, () => false));
  const enginePath = appEnginePath(app);
  if (!await present(app)) return { state: "absent", path: app, enginePath, bundle: null, engine: null };
  const [engine, bundle] = await Promise.all([
    run(enginePath, ["--version"]).then(versionOf, () => null),
    run(plistTool, ["-c", `Print ${plistKey}`, appInfoPlist(app)]).then(versionOf, () => null),
  ]);
  return { state: "found", path: app, enginePath, bundle, engine };
}

/** Whether this run's pair is a new one, and what the record should become afterwards. */
export function detectAppChange(seen: HealthState["app"], info: AppInfo, at: string): { changed: boolean; record: HealthState["app"] } {
  if (info.state === "absent") return { changed: false, record: seen };
  const pair = { bundle: info.bundle, engine: info.engine };
  return { changed: appPairChanged(seen, pair), record: { ...pair, seenAt: at } };
}

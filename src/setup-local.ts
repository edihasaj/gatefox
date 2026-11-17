import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { requireCodexDesktopApp } from "./desktop-launch.js";
import { readServicePlan } from "./service-plan.js";

/**
 * `gatefox setup --local`: one command from a configured, signed-in gateway to a working Mac. It installs the service,
 * registers the desktop adapter, merges them into the single startup job and puts the signed GateFox.app in place to own
 * that job's name and icon, so a new Mac ends with one Login Item. Each step reuses the existing command; an already
 * unified Mac only gets a missing app. It refuses while ChatGPT runs, because the merge restarts the service.
 */
export interface SetupLocalDeps {
  chatGptRunning: (app: string) => Promise<boolean>;
  service: (configPath: string) => Promise<unknown>;
  register: (configPath: string, app: string) => Promise<unknown>;
  consolidate: (configPath: string) => Promise<unknown>;
  /** The installed GateFox.app, or undefined. */
  findApp: () => Promise<string | undefined>;
  installApp: (version: string) => Promise<string>;
  openApp: (path: string) => Promise<unknown>;
  requireDesktopApp: (app: string) => Promise<void>;
  version: () => Promise<string>;
  config: (configPath: string) => Promise<{ clientOnly?: boolean; providers: unknown[]; stateDirectory: string }>;
  /** True once the service plan exists, which means the startup jobs are already one. */
  unified: (state: string) => Promise<boolean>;
}

const run = promisify(execFile);
const exists = (path: string) => access(path).then(() => true, () => false);
const repository = "edihasaj/gatefox";

/** Downloads the published app for this release, checks it against the release's SHA256SUMS and its Developer ID and notarization, and installs it in ~/Applications. */
export async function installPublishedApp(version: string, verify: (app: string) => Promise<unknown>, download: (url: string) => Promise<Buffer> = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) }); if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`); return Buffer.from(await response.arrayBuffer());
}): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("This gateway has no release version; install GateFox.app from https://gatefox.dev");
  const base = `https://github.com/${repository}/releases/download/v${version}`; const name = `GateFox-${version}-macos-arm64.zip`;
  const sums = (await download(`${base}/SHA256SUMS`)).toString("utf8");
  const expected = sums.split("\n").map(line => line.trim().split(/\s+/)).find(([, file]) => file === name || file === `*${name}`)?.[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`The ${version} release lists no checksum for ${name}`);
  const zip = await download(`${base}/${name}`);
  if (createHash("sha256").update(zip).digest("hex") !== expected) throw new Error("The downloaded GateFox app does not match its published checksum");
  const work = await mkdtemp(join(tmpdir(), "gatefox-app-")); await writeFile(join(work, name), zip, { mode: 0o600 });
  await run("/usr/bin/ditto", ["-x", "-k", join(work, name), join(work, "app")], { timeout: 120_000 });
  const staged = join(work, "app", "GateFox.app"); await verify(staged);
  const target = resolve(homedir(), "Applications", "GateFox.app");
  if (await exists(target)) throw new Error(`${target} already exists; it was left unchanged`);
  await mkdir(resolve(homedir(), "Applications"), { recursive: true }); await rename(staged, target);
  return target;
}

export async function setupLocal(configPath: string, app: string, overrides: Partial<SetupLocalDeps> = {}): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin" && !overrides.service) throw new Error("gatefox setup --local currently supports macOS");
  const deps = { ...await localDeps(), ...overrides };
  const config = await deps.config(configPath);
  if (config.clientOnly) throw new Error("This Mac uses another Mac's gateway; set it up with gatefox setup --client and gatefox tunnel install");
  if (!config.providers.length) throw new Error("Connect an account first: gatefox login PROVIDER and gatefox discover PROVIDER --load");
  await deps.requireDesktopApp(app);
  const steps: string[] = [];
  if (await deps.unified(config.stateDirectory)) steps.push("service already unified");
  else {
    if (await deps.chatGptRunning(app)) throw new Error("Quit ChatGPT (⌘Q), then run gatefox setup --local again: merging the startup jobs restarts the gateway service");
    await deps.service(configPath); steps.push("service installed");
    await deps.register(configPath, app); steps.push("desktop registered");
    await deps.consolidate(configPath); steps.push("startup jobs merged into one");
  }
  let gatefoxApp = await deps.findApp();
  if (!gatefoxApp) { gatefoxApp = await deps.installApp(await deps.version()); steps.push("GateFox.app installed"); }
  await deps.openApp(gatefoxApp); steps.push("GateFox.app opened");
  return { ready: true, steps, app: gatefoxApp,
    next: "Open ChatGPT. Gateway models appear after the built-in ones. macOS may keep showing old Login Items until the next login." };
}

async function localDeps(): Promise<SetupLocalDeps> {
  const [{ macService }, { macDesktop }, { consolidateService }, { defaultVerifyApp }] = await Promise.all([import("./mac-service.js"), import("./mac-desktop.js"), import("./mac-consolidate.js"), import("./app-updates.js")]);
  return {
    chatGptRunning: async app => { try { await run("/usr/bin/pgrep", ["-f", `^${resolve(app, "Contents/MacOS/ChatGPT").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`]); return true; } catch { return false; } },
    service: path => macService("install", path),
    register: (path, app) => macDesktop("register", path, app),
    consolidate: path => consolidateService(path, true),
    findApp: async () => { for (const path of [resolve(homedir(), "Applications/GateFox.app"), "/Applications/GateFox.app"]) if (await exists(path)) return path; return undefined; },
    installApp: version => installPublishedApp(version, app => defaultVerifyApp(app)),
    openApp: path => run("/usr/bin/open", [path], { timeout: 10_000 }),
    requireDesktopApp: app => requireCodexDesktopApp(app),
    config: path => loadConfig(path),
    unified: async state => Boolean(await readServicePlan(state)),
    version: async () => String(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version),
  };
}

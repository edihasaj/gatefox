import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { writePrivateJson } from "../config.js";
import { atomicWrite } from "../service-claude-io.js";
import { claudeAdapterMarker, legacySpecs } from "../service-claude-legacy.js";
import type { ClaudeDependencies } from "../service-claude-staging.js";
import { serviceLabel, serviceMarker, servicePlanPath, type ServicePlan } from "../service-plan.js";

/** Shared fixture for the Claude consolidation tests: a private fake home, a fake launchd/process world and no live system access. */
export const labels = { adapter: legacySpecs[0]!.label, inference: legacySpecs[1]!.label, tunnel: legacySpecs[2]!.label, studio: legacySpecs[3]!.label };
export const allLabels = legacySpecs.map(spec => spec.label);
export type PlistObject = Record<string, any>;
export interface Notice { event: string; fields: Record<string, string | number> }
const release = "0123456789abcdef0123";
const sshOptions = ["BatchMode=yes", "RequestTTY=no", "RemoteCommand=none", "ControlMaster=no", "ControlPath=none", "ExitOnForwardFailure=yes", "ConnectTimeout=10", "ServerAliveInterval=30", "ServerAliveCountMax=3"];
export const sshArguments = (direction: "-L" | "-R", host: string): string[] =>
  ["/usr/bin/ssh", "-N", "-T", ...sshOptions.flatMap(option => ["-o", option]), direction, "127.0.0.1:3468:127.0.0.1:3468", host];

export class World {
  loaded = new Map<string, number>();
  processes = new Map<number, { args: string; start: number }>();
  extraRows: string[] = [];
  disabled = new Set<string>();
  busy = new Set<number>();
  stuck = new Set<string>();
  failBootout = new Set<string>();
  failBootstrap = new Set<string>();
  calls: string[] = [];
  primary = true; printFails = false; censusFails = false; lsofFails = false;
  commitHook?: (path: string, text: string) => Promise<void>;
  onBootout?: (label: string) => void;
  private next = 5000;
  mutating(): string[] { return this.calls.filter(call => /^(bootout|bootstrap|commit)/.test(call)); }
  ops(kind: string): string[] { return this.calls.filter(call => call.startsWith(`${kind}:`)).map(call => call.slice(kind.length + 1)); }
  start(label: string, args: string[]): number {
    const pid = this.next++; this.loaded.set(label, pid);
    this.processes.set(pid, { args: args.join(" "), start: 1_700_000_000_000 + pid * 1000 }); return pid;
  }
  deps(home: string, notices: Notice[]): ClaudeDependencies {
    return {
      platform: "darwin", home, primary: async () => this.primary, decodePlist: async bytes => JSON.parse(bytes.toString("utf8").split("\n")[0]!),
      verifySignature: async () => true, pendingLogin: async () => undefined, pendingNative: async () => undefined,
      wait: async () => {}, settleTries: 3, settleMs: 0, notice: (event, fields) => { notices.push({ event, fields }); },
      commit: async (path, text) => { this.calls.push("commit"); await (this.commitHook ?? ((p: string, t: string) => atomicWrite(p, t)))(path, text); },
      launchd: {
        print: async label => {
          this.calls.push(`print:${label}`); if (this.printFails) throw new Error("launchd");
          const pid = this.loaded.get(label); return pid === undefined ? { loaded: false } : { loaded: true, pid };
        },
        disabled: async label => this.disabled.has(label),
        bootout: async label => {
          this.calls.push(`bootout:${label}`); if (this.failBootout.has(label)) throw new Error("bootout");
          this.onBootout?.(label); const pid = this.loaded.get(label); this.loaded.delete(label);
          if (pid !== undefined && !this.stuck.has(label)) this.processes.delete(pid);
        },
        bootstrap: async path => {
          const label = basename(path, ".plist"); this.calls.push(`bootstrap:${label}`); if (this.failBootstrap.has(label)) throw new Error("bootstrap");
          const object = JSON.parse((await readFile(path, "utf8")).split("\n")[0]!); this.start(label, object.ProgramArguments);
        },
      },
      processes: {
        census: async () => {
          if (this.censusFails) throw new Error("ps");
          return [...[...this.processes].map(([pid, row]) => ({ pid, args: row.args })), ...this.extraRows.map((args, index) => ({ pid: 9000 + index, args }))];
        },
        alive: pid => this.processes.has(pid), startMs: async pid => this.processes.get(pid)?.start,
        established: async pid => { if (this.lsofFails) throw new Error("lsof"); return this.busy.has(pid); },
      },
    };
  }
}

export function legacyObjects(home: string): Record<string, PlistObject> {
  const support = join(home, "Library", "Application Support", "Claude-3p"); const adapter = join(support, "desktop-adapter"); const inference = join(support, "inference");
  const node = "/opt/homebrew/Cellar/node@24/24.21.0_2/bin/node"; const script = (dir: string) => join(dir, "releases", release, "package", "dist", "cli.js");
  const log = (name: string) => join(home, "Library", "Logs", name);
  const common = (label: string, args: string[], name: string, extra: PlistObject = {}): PlistObject =>
    ({ Label: label, ProgramArguments: args, EnvironmentVariables: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, RunAtLoad: true, KeepAlive: true, ...extra, StandardOutPath: log(name), StandardErrorPath: log(name) });
  return {
    [labels.adapter]: common(labels.adapter, [node, script(adapter), "claude-desktop", "serve", "--config", join(adapter, "config.json")], "harness-gateway-claude-desktop-adapter.log", { WorkingDirectory: adapter }),
    [labels.inference]: common(labels.inference, [node, script(inference), "claude-desktop", "inference", "--gateway-config", join(inference, "gateway.json"), "--native-config", join(inference, "native-messages.json")], "claude-inference.log", { WorkingDirectory: inference, ThrottleInterval: 10 }),
    [labels.tunnel]: common(labels.tunnel, sshArguments("-L", "macbook-server"), "claude-inference-tunnel.log", { ThrottleInterval: 10 }),
    [labels.studio]: common(labels.studio, sshArguments("-R", "studio"), "claude-inference-studio.log", { ThrottleInterval: 10 }),
  };
}

export interface Fixture {
  root: string; home: string; state: string; config: string; app: string; appNode: string; plan: ServicePlan;
  world: World; notices: Notice[]; files: Record<string, string>; mainPath: string; planPath: string; receiptPath: string;
  deps(extra?: ClaudeDependencies): ClaudeDependencies; cleanup(): Promise<void>;
}

const text = (object: PlistObject, marker: string) => `${JSON.stringify(object)}\n${marker}\n`;
export async function writeLegacy(f: Fixture, label: string, object: PlistObject, marked = label === labels.adapter): Promise<void> {
  await writeFile(f.files[label]!, text(object, marked ? claudeAdapterMarker : "<!-- legacy -->")); await chmod(f.files[label]!, 0o644);
}
export async function readObject(path: string): Promise<PlistObject> { return JSON.parse((await readFile(path, "utf8")).split("\n")[0]!); }
export async function rewrite(f: Fixture, label: string, change: (object: PlistObject) => void): Promise<void> {
  const object = await readObject(f.files[label]!); change(object); await writeLegacy(f, label, object);
}
export async function rewriteMain(f: Fixture, change: (object: PlistObject) => void): Promise<void> {
  const object = await readObject(f.mainPath); change(object); await writeFile(f.mainPath, text(object, serviceMarker)); await chmod(f.mainPath, 0o644);
}
export const writePlan = (f: Fixture, plan: ServicePlan): Promise<void> => writePrivateJson(f.planPath, plan);
export async function snapshot(f: Fixture): Promise<{ plan: string; plists: Record<string, string | undefined> }> {
  const plists: Record<string, string | undefined> = {};
  for (const label of allLabels) plists[label] = (await readFile(f.files[label]!).catch(() => undefined))?.toString("base64");
  return { plan: await readFile(f.planPath, "utf8"), plists };
}

export async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(process.env.GATEWAY_TEST_TMPDIR ?? "/tmp", "gwcl-")));
  const dir = (path: string) => mkdir(path, { recursive: true, mode: 0o700 });
  const home = join(root, "home"); const state = join(root, "state"); const config = join(root, "gateway.json");
  const agents = join(home, "Library", "LaunchAgents"); await dir(agents); await dir(join(home, "Library", "Logs")); await dir(state);
  const app = join(home, "Applications", "Harness Gateway.app"); const helper = join(app, "Contents", "MacOS", "GatewayService");
  const appNode = join(app, "Contents", "Resources", "backend", "runtime", "bin", "node");
  await dir(join(app, "Contents", "MacOS")); await dir(join(appNode, ".."));
  for (const path of [helper, appNode]) { await writeFile(path, "#!/bin/sh\n"); await chmod(path, 0o755); }
  await writePrivateJson(config, { version: 1, port: 3457, clientOnly: true, stateDirectory: state, providers: [] });
  const plan: ServicePlan = { version: 1, config, components: [{ id: "inference", kind: "inference", command: "/private/gateway", args: ["serve", "--config", config], log: join(state, "services", "inference.log") }] };
  const planPath = servicePlanPath(state); await writePrivateJson(planPath, plan);
  const mainPath = join(agents, `${serviceLabel}.plist`);
  await writeFile(mainPath, text({ Label: serviceLabel, Program: helper, AssociatedBundleIdentifiers: "com.edihasaj.harness-gateway.app", ProgramArguments: ["/private/gateway", "daemon", "--config", config] }, serviceMarker)); await chmod(mainPath, 0o644);
  const world = new World(); const notices: Notice[] = []; const files: Record<string, string> = {};
  const objects = legacyObjects(home);
  for (const label of allLabels) {
    const object = objects[label]!; files[label] = join(agents, `${label}.plist`);
    await writeFile(files[label], text(object, label === labels.adapter ? claudeAdapterMarker : "<!-- legacy -->")); await chmod(files[label], 0o644);
    await writeFile(object.StandardOutPath, "old log\n"); await chmod(object.StandardOutPath, 0o644);
    if (object.WorkingDirectory) {
      const pins = label === labels.adapter ? ["config.json"] : ["gateway.json", "native-messages.json"];
      const script = object.ProgramArguments[1] as string; await dir(join(script, ".."));
      for (const path of [script, ...pins.map(name => join(object.WorkingDirectory, name))]) { await writeFile(path, "{}\n"); await chmod(path, 0o600); }
    }
    world.start(label, object.ProgramArguments);
  }
  const fixed: Fixture = {
    root, home, state, config, app, appNode, plan, world, notices, files, mainPath, planPath, receiptPath: join(state, "service-claude-pending.json"),
    deps: (extra = {}) => { const base = world.deps(home, notices); return { ...base, ...extra, launchd: { ...base.launchd, ...extra.launchd }, processes: { ...base.processes, ...extra.processes } }; },
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
  return fixed;
}

export async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture(); try { await run(f); } finally { await f.cleanup(); }
}

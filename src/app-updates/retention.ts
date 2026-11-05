import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const day = 86_400_000;
const inventoryLimits = { encoding: "utf8" as const, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 };
const releaseName = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const generationName = /^shared-v1-[a-z0-9-]+$/;

export const generationsKept = 12;
export const generationMinimumAgeMs = 3 * day;

export interface RetentionOptions {
  installRoot: string;
  stateDirectory: string;
  now?: number;
  /** Everything running processes refer to. Undefined means the inventory is incomplete, which prevents all pruning. */
  inventory?: () => Promise<string | undefined>;
  remove?: (path: string) => Promise<void>;
}
export interface RetentionResult { releases: string[]; generations: string[]; skipped?: "inventory_incomplete" | "update_in_progress" }

const newestFirst = (left: string, right: string) => {
  const [a, b] = [left, right].map(name => name.split(".").map(Number));
  return b![0]! - a![0]! || b![1]! - a![1]! || b![2]! - a![2]!;
};

/** The same rule as scripts/install.sh: keep current, previous and the newest other release, then anything still in use. */
export function planReleases(names: string[], current: string | undefined, previous: string | undefined, inventory: string): string[] {
  let spare = false;
  return names.filter(name => releaseName.test(name)).sort(newestFirst).filter(name => {
    if (name === current || name === previous) return false;
    if (!spare) { spare = true; return false; }
    return !inventory.includes(`/releases/${name}/`);
  });
}

/** Keeps the newest generations, and any changed recently or referred to by a running process. */
export function planGenerations(entries: { name: string; modifiedMs: number }[], inventory: string, now: number): string[] {
  return entries.filter(entry => generationName.test(entry.name)).sort((a, b) => b.modifiedMs - a.modifiedMs).slice(generationsKept)
    .filter(entry => now - entry.modifiedMs >= generationMinimumAgeMs && !inventory.includes(entry.name)).map(entry => entry.name);
}

/** True when a process runs through `current` with no open entry point, so its source release cannot be identified. */
export function hasUnidentifiedProcess(files: string, processes: string): boolean {
  const entrypoints = new Set<string>(); let pid = "";
  for (const line of files.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && /\/releases\/[^/]+\/package\/dist\/cli\.js$/.test(line)) entrypoints.add(pid);
  }
  return processes.split("\n").some(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return !!match && match[2]!.includes("/subscription-gateway/current/package/dist/cli.js") && !entrypoints.has(match[1]!);
  });
}

/** Open files, process environments and saved service plans. Anything incomplete or unidentified yields undefined. */
export async function defaultInventory(): Promise<string | undefined> {
  try {
    const [files, processes] = await Promise.all([
      exec("/usr/sbin/lsof", ["-nP", "-u", String(process.getuid?.()), "-Fpn"], inventoryLimits),
      exec("/bin/ps", ["-xwwE", "-o", "pid=", "-o", "command="], inventoryLimits)
    ]);
    if (hasUnidentifiedProcess(files.stdout, processes.stdout)) return undefined;
    const agents = join(homedir(), "Library", "LaunchAgents");
    const plans = await readdir(agents).catch(error => { if (error.code === "ENOENT") return [] as string[]; throw error; });
    const saved = await Promise.all(plans.filter(name => name.includes("gateway") && name.endsWith(".plist"))
      .map(name => readFile(join(agents, name), "utf8")));
    return [files.stdout, processes.stdout, ...saved].join("\n");
  } catch { return undefined; }
}

const defaultRemove = (path: string) => rm(path, { recursive: true, force: true });

/**
 * Runs after an update is fully finalized, because update transactions deliberately skip the installer's own pruning. Old
 * releases and gateway generations otherwise accumulate for ever: 240 generations held 21 GiB on one Mac. Both come back from
 * a release download or the next engine start. Never throws; an interrupted deletion leaves only a `.retired-*` folder.
 */
export async function pruneRetained(options: RetentionOptions): Promise<RetentionResult> {
  const result: RetentionResult = { releases: [], generations: [] };
  const remove = options.remove ?? defaultRemove, root = options.installRoot;
  try {
    if (await lstat(join(root, "app-update-transaction.json")).then(() => true, error => error.code !== "ENOENT")) return { ...result, skipped: "update_in_progress" };
    const inventory = await (options.inventory ?? defaultInventory)();
    if (inventory === undefined) return { ...result, skipped: "inventory_incomplete" };
    const releases = join(root, "releases");
    const current = await realpath(join(root, "current")).then(path => basename(path), () => undefined);
    const previous = await readFile(join(root, "previous-release"), "utf8").then(text => basename(text.trim()), () => undefined);
    if (current) {
      const names = await readdir(releases).catch(() => [] as string[]);
      for (const name of planReleases(names, current, previous, inventory)) {
        const path = join(releases, name);
        if (!await lstat(join(path, ".gateway-release")).then(info => info.isFile(), () => false)) continue;
        const retired = join(releases, `.retired-${name}-${process.pid}`);
        try { await rename(path, retired); await remove(retired); result.releases.push(name); } catch { /* A later update tries again. */ }
      }
    }
    const generations = join(options.stateDirectory, "desktop-generations");
    const entries = await Promise.all((await readdir(generations).catch(() => [] as string[])).map(async name => {
      const info = await lstat(join(generations, name)).catch(() => undefined);
      return info?.isDirectory() && !info.isSymbolicLink() ? { name, modifiedMs: info.mtimeMs } : undefined;
    }));
    const present = entries.filter((entry): entry is { name: string; modifiedMs: number } => !!entry);
    for (const name of planGenerations(present, inventory, options.now ?? Date.now())) {
      try { await remove(join(generations, name)); result.generations.push(name); } catch { /* A later update tries again. */ }
    }
  } catch { /* Retention never affects a finished update. */ }
  return result;
}

import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, rename, symlink, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify, parseArgs } from "node:util";
import { gatefoxConfigPath, legacyConfigPath } from "./paths.js";
import { withPrivateFileLock } from "./private-file-lock.js";

interface Alias { path: string; backing: string; kind: "configuration" | "installation" }
interface Published extends Alias { ino?: number; dev?: number; ctimeMs?: number }
interface Journal { version: 1; aliases: Published[]; phase: "prepared" | "applied" | "reverted" }
export interface RenameOptions {
  home?: string; platform?: NodeJS.Platform; apply?: boolean; revert?: boolean;
  /** Test seam. Production always inspects local writers without printing their command lines. */
  busy?: () => Promise<string[]>;
}
export interface RenameResult {
  applied: boolean; phase: string; aliases: Array<Alias & { status: string }>;
  preserved: string[]; blockers: string[];
}
const preserved = ["Saved chat provider identities and history", "Credentials, account IDs, models and permissions",
  "Signing identities, LaunchAgent labels and ownership receipts", "Original storage, immutable releases and rollback bundles"];
const absent = (error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; };
const inspect = (path: string) => lstat(path).catch(absent);
const unsafe = (): never => { throw new Error("Rename refused an unowned, writable, linked or conflicting path; nothing was overwritten"); };

/** Every existing ancestor must be a directory owned by this user or root, with no foreign write access. */
async function ancestry(path: string): Promise<void> {
  // /tmp and /var are system aliases on macOS; home itself is canonicalized before deriving any paths.
  let current: string = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await inspect(current);
    if (!info) return;
    if (!info.isDirectory() || ![0, process.getuid?.()].includes(info.uid) ||
      (info.mode & 0o022) && !(info.uid === 0 && info.mode & 0o1000)) unsafe();
  }
}
async function privateFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 4 * 1024 * 1024) unsafe();
    return await file.readFile();
  } finally { await file.close(); }
}
async function validateBacking(alias: Alias): Promise<void> {
  await ancestry(alias.backing);
  const info = await inspect(alias.backing);
  if (!info?.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) unsafe();
  if (alias.kind === "installation") {
    if ((await privateFile(join(alias.backing, ".gateway-installation"))).toString().trim() !== "subscription-gateway") unsafe();
  } else {
    let config: { version?: unknown; providers?: unknown; stateDirectory?: unknown };
    try { config = JSON.parse((await privateFile(join(alias.backing, "gateway.json"))).toString()); }
    catch { throw new Error("Cannot validate the existing configuration for rename"); }
    if (!config || config.version !== 1 || !Array.isArray(config.providers) || typeof config.stateDirectory !== "string") unsafe();
  }
}
async function aliasStatus(alias: Alias): Promise<string> {
  await ancestry(dirname(alias.path));
  const current = await inspect(alias.path), backing = await inspect(alias.backing);
  if (!current) { if (!backing) return "absent"; await validateBacking(alias); return "pending"; }
  if (!current.isSymbolicLink()) {
    if (backing) unsafe();
    await validateBacking({ ...alias, backing: alias.path });
    return "canonical";
  }
  if (current.uid !== process.getuid?.() || resolve(dirname(alias.path), await readlink(alias.path)) !== alias.backing) unsafe();
  await validateBacking(alias);
  return "compatible";
}
export async function renameBusy(): Promise<string[]> {
  const { stdout } = await promisify(execFile)("/bin/ps", ["-axo", "pid=,command="], { maxBuffer: 16 * 1024 * 1024 });
  const result = stdout.split("\n").filter(line => /(?:ChatGPT|GateFox|Harness Gateway)\.app\/Contents\/MacOS\/|\bapp-server\b|gateway-native-relay\b|dist\/cli\.js (?:serve|daemon|codex-shim|executor-host)\b|claude-desktop-adapter\.mjs/.test(line) && !/ --test(?:[ =-]|$)/.test(line))
    .map(line => `writer PID ${line.trim().split(/\s/)[0]}`);
  if (process.platform === "darwin") {
    for (const label of ["com.edihasaj.subscription-gateway", "com.edihasaj.gatefox"]) {
      try {
        await promisify(execFile)("/bin/launchctl", ["print", `gui/${process.getuid?.()}/${label}`], { timeout: 5000 });
        result.push(`loaded service: ${label}`);
      } catch (error) {
        if (!/Could not find service|service not found|No such process/i.test(String((error as Error).message))) result.push(`cannot verify unloaded service: ${label}`);
      }
    }
  }
  return result;
}
async function blockers(aliases: Alias[], busy: () => Promise<string[]>): Promise<string[]> {
  const result = await busy();
  for (const alias of aliases) {
    if (alias.kind !== "installation" || !await inspect(alias.backing)) continue;
    for (const name of ["app-update-transaction.json", ".gateway-installation-lock"])
      if (await inspect(join(alias.backing, name))) result.push(`pending installation work: ${name}`);
    const state = await inspect(join(alias.backing, "app-update.json"));
    if (state) {
      try { if (JSON.parse((await privateFile(join(alias.backing, "app-update.json"))).toString()).pending) result.push("pending app update"); }
      catch { result.push("unreadable app update state"); }
    }
  }
  return result;
}
async function save(path: string, journal: Journal): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(journal) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function owns(path: string, alias: Published): Promise<boolean> {
  const info = await inspect(path);
  return !!info?.isSymbolicLink() && info.uid === process.getuid?.() && info.ino === alias.ino && info.dev === alias.dev && info.ctimeMs === alias.ctimeMs &&
    resolve(dirname(path), await readlink(path)) === alias.backing;
}
async function readJournal(path: string, aliases: Alias[]): Promise<Journal | undefined> {
  if (!await inspect(path)) return;
  let journal: Journal;
  try { journal = JSON.parse((await privateFile(path)).toString()); } catch { throw new Error("Rename journal is unreadable; preserved for recovery"); }
  if (journal.version !== 1 || !["prepared", "applied", "reverted"].includes(journal.phase) || !Array.isArray(journal.aliases) || journal.aliases.length > 2) unsafe();
  const seen = new Set<string>();
  for (const entry of journal.aliases) {
    if (!aliases.some(alias => alias.path === entry.path && alias.backing === entry.backing && alias.kind === entry.kind) ||
      seen.has(entry.path) || (entry.ino !== undefined || entry.dev !== undefined) &&
      (!Number.isSafeInteger(entry.ino) || !Number.isSafeInteger(entry.dev) || !Number.isFinite(entry.ctimeMs))) unsafe();
    seen.add(entry.path);
  }
  return journal;
}

/** Publishes canonical entry paths to the original storage. No files move and no service starts or stops. */
export async function migrateGatefox(options: RenameOptions = {}): Promise<RenameResult> {
  const { realpath } = await import("node:fs/promises");
  const home = await realpath(resolve(options.home ?? homedir())), platform = options.platform ?? process.platform;
  const aliases: Alias[] = [
    { kind: "configuration", path: dirname(gatefoxConfigPath(home, platform)), backing: dirname(legacyConfigPath(home, platform)) },
    { kind: "installation", path: join(home, ".local/share/gatefox"), backing: join(home, ".local/share/subscription-gateway") },
  ];
  const folder = join(home, ".local/state/gatefox-rename"), path = join(folder, "transaction.json");
  await ancestry(folder);
  const describe = async (): Promise<RenameResult> => ({ applied: false, phase: "preview", preserved, blockers: await blockers(aliases, options.busy ?? renameBusy),
    aliases: await Promise.all(aliases.map(async alias => ({ ...alias, status: await aliasStatus(alias) }))) });
  if (!options.apply) {
    const result = await describe(); const journal = await readJournal(path, aliases);
    if (options.revert) result.phase = journal ? `rollback_${journal.phase}` : "nothing_to_revert";
    else if (journal) result.phase = journal.phase;
    return result;
  }
  const initial = await describe();
  if (initial.blockers.length) throw new Error(`Close clients and stop GateFox together before applying the rename; ${initial.blockers.join(", ")}`);
  await mkdir(folder, { recursive: true, mode: 0o700 }); await ancestry(folder);
  if ((await lstat(folder)).uid !== process.getuid?.() || (await lstat(folder)).mode & 0o077) unsafe();
  return withPrivateFileLock(path, async () => {
    let journal = await readJournal(path, aliases);
    const next = await describe(); if (next.blockers.length) throw new Error("GateFox became busy; migration was not applied");
    if (options.revert) {
      if (!journal || journal.phase === "reverted") return { ...next, phase: "nothing_to_revert" };
      // Preflight every publication before removing any; never remove a replacement, even one with the same target.
      for (const entry of journal.aliases) if (await inspect(entry.path) && !await owns(entry.path, entry)) unsafe();
      for (const entry of [...journal.aliases].reverse()) if (await owns(entry.path, entry)) await unlink(entry.path);
      journal.phase = "reverted"; await save(path, journal);
      return { ...await describe(), applied: true, phase: "reverted" };
    }
    if (journal?.phase === "reverted") {
      const archive = await open(`${path}.reverted-${randomUUID()}`, "wx", 0o600);
      try { await archive.writeFile(await privateFile(path)); await archive.sync(); } finally { await archive.close(); }
      journal = undefined;
    }
    if (!journal) {
      journal = { version: 1, phase: "prepared", aliases: next.aliases.filter(alias => alias.status === "pending").map(({ kind, path, backing }) => ({ kind, path, backing })) };
      await save(path, journal);
    }
    for (const entry of journal.aliases) {
      await validateBacking(entry);
      if (await inspect(entry.path)) {
        if (entry.ino === undefined) throw new Error("Rename stopped before recording alias ownership; review the preserved alias and journal before recovery");
        if (!await owns(entry.path, entry)) unsafe();
      }
      else {
        if (entry.ino !== undefined) throw new Error("A recorded rename alias is missing; preserved the journal for recovery");
        // Exclusive creation refuses a concurrent occupant. A crash before the next receipt fails closed on retry.
        await symlink(entry.backing, entry.path);
        const info = await lstat(entry.path); entry.ino = info.ino; entry.dev = info.dev; entry.ctimeMs = info.ctimeMs;
        await save(path, journal);
      }
    }
    journal.phase = "applied"; await save(path, journal);
    return { ...await describe(), applied: true, phase: "applied" };
  });
}

export async function gatefoxMigrateCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, strict: true, options: { apply: { type: "boolean" }, revert: { type: "boolean" }, json: { type: "boolean" } } });
  const result = await migrateGatefox({ apply: values.apply, revert: values.revert });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readlink, rename, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const journalName = "app-update-transaction.json";
const lockName = ".gateway-installation-lock";
const noFollow = constants.O_NOFOLLOW ?? 0;
const maximumJournalBytes = 512 * 1024;
const wrapperNames = ["gateway", "harness-gateway", "subscription-gateway"] as const;

export type TransactionCommand = (program: string, args: string[], signal?: AbortSignal) => Promise<void>;
export interface InstallationLocation { root: string; prefix: string }
export interface InstallationTransaction {
  readonly installation: InstallationLocation;
  readonly app: string;
  readonly version: string;
  readonly team: string;
}
export interface TransactionInstaller {
  (options: { command: TransactionCommand; signal?: AbortSignal }): Promise<void>;
}
type Receipt = { dev: number; ino: number; mode: number; size: number; digest: string };
type SavedPath = { type: "absent" } | { type: "file"; receipt: Receipt; bytes: string } | { type: "link"; receipt: Receipt; target: string };
type Journal = {
  schema: 1; root: string; prefix: string; app: string; version: string; team: string;
  phase: "prepared" | "cli_installing" | "cli_published" | "app_swap_started" | "app_swapped" | "committed";
  before: { current: SavedPath; wrappers: Record<string, SavedPath>; app: Receipt };
  published?: { current: SavedPath; wrappers: Record<string, SavedPath>; release: string };
  swap?: { stage: string; incoming: Receipt; target: Receipt };
};

function failure(message = "The app update transaction is unsafe."): never { throw new Error(message); }
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function equal(left: Receipt, right: Receipt): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.digest === right.digest;
}
function installationPaths(input: InstallationLocation): { root: string; prefix: string; journal: string } {
  if (!isAbsolute(input.root) || !isAbsolute(input.prefix)) failure();
  const root = resolve(input.root); const prefix = resolve(input.prefix);
  if (root !== resolve(prefix, "share", "subscription-gateway")) failure();
  return { root, prefix, journal: join(root, journalName) };
}
function transactionPaths(tx: InstallationTransaction): { root: string; prefix: string; journal: string } {
  return installationPaths(tx.installation);
}
function validVersion(value: string): boolean { return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/.test(value); }
function validTeam(value: string): boolean { return /^[A-Z0-9]{10}$/.test(value); }
function safeChild(parent: string, child: string): string {
  const path = resolve(parent, child);
  if (relative(parent, path).startsWith("..")) failure();
  return path;
}
async function safeDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => failure());
  const mode = Number(info.mode);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== process.getuid?.() && info.uid !== 0) || (mode & 0o022 && !(info.uid === 0 && mode & 0o1000))) failure();
}
async function safeExistingParent(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    const info = await lstat(current).catch(error => absent(error) ? undefined : failure());
    if (info) { await safeDirectory(current); return; }
    const next = dirname(current); if (next === current) failure(); current = next;
  }
}
async function assertTransaction(tx: InstallationTransaction): Promise<void> {
  const { root, prefix } = transactionPaths(tx);
  if (!isAbsolute(tx.app) || resolve(tx.app) !== tx.app || !validVersion(tx.version) || !validTeam(tx.team)) failure();
  await safeDirectory(root); await safeExistingParent(prefix); await safeExistingParent(dirname(tx.app));
}
async function atomic(path: string, bytes: Buffer): Promise<void> {
  await safeDirectory(dirname(path));
  const temporary = join(dirname(path), `.${journalName}.${randomUUID()}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try { await file.writeFile(bytes); await file.sync(); await chmod(temporary, 0o600); await rename(temporary, path); }
  finally { await file.close(); await unlink(temporary).catch(error => { if (!absent(error)) throw error; }); }
  const directory = await open(dirname(path), constants.O_RDONLY | noFollow);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function source(path: string, backup = false): Promise<SavedPath> {
  const info = await lstat(path).catch(error => absent(error) ? undefined : failure());
  if (!info) return { type: "absent" };
  const receipt = { dev: info.dev, ino: info.ino, mode: Number(info.mode) & 0o777, size: info.size, digest: "" };
  if (info.isSymbolicLink()) {
    const target = await readlink(path); return { type: "link", receipt: { ...receipt, digest: digest(Buffer.from(target)) }, target };
  }
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) || info.size > maximumJournalBytes / 2 || info.nlink !== 1) failure();
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const bytes = await file.readFile(); const after = await file.stat();
    if (bytes.length !== info.size || after.dev !== info.dev || after.ino !== info.ino) failure();
    const saved = { ...receipt, digest: digest(bytes) };
    return { type: "file", receipt: saved, ...(backup ? { bytes: bytes.toString("base64") } : { bytes: "" }) };
  } finally { await file.close(); }
}
function receiptOf(value: SavedPath): Receipt | undefined { return value.type === "absent" ? undefined : value.receipt; }
async function matches(path: string, expected: SavedPath): Promise<boolean> {
  const actual = await source(path);
  if (actual.type !== expected.type) return false;
  if (actual.type === "absent" || expected.type === "absent") return true;
  return equal(actual.receipt, expected.receipt) && (actual.type !== "link" || expected.type !== "link" || actual.target === expected.target);
}
async function appReceipt(path: string): Promise<Receipt> {
  await safeExistingParent(dirname(path)); const app = await lstat(path).catch(() => failure());
  if (!app.isDirectory() || app.isSymbolicLink()) failure();
  const infoPath = safeChild(path, "Contents/Info.plist"); const info = await lstat(infoPath).catch(() => failure());
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) failure();
  const bytes = await readFile(infoPath, { flag: noFollow });
  return { dev: app.dev, ino: app.ino, mode: Number(app.mode) & 0o777, size: info.size, digest: digest(bytes) };
}
async function withInstallationLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const path = safeChild(root, lockName);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600).catch(() => failure("The gateway installer is busy; retry the update."));
  try { await file.writeFile(String(process.pid)); await file.sync(); return await action(); }
  finally { await file.close(); await unlink(path).catch(error => { if (!absent(error)) throw error; }); }
}
async function save(tx: InstallationTransaction, journal: Journal): Promise<void> {
  const { journal: path } = transactionPaths(tx); await atomic(path, Buffer.from(JSON.stringify(journal)));
}
function validJournal(value: unknown, tx: InstallationTransaction): value is Journal {
  const record = value as Partial<Journal>;
  return !!record && record.schema === 1 && record.root === resolve(tx.installation.root) && record.prefix === resolve(tx.installation.prefix) &&
    record.app === tx.app && record.version === tx.version && record.team === tx.team && typeof record.before === "object" &&
    ["prepared", "cli_installing", "cli_published", "app_swap_started", "app_swapped", "committed"].includes(String(record.phase));
}
async function load(tx: InstallationTransaction): Promise<Journal | undefined> {
  const { journal } = transactionPaths(tx); const info = await lstat(journal).catch(error => absent(error) ? undefined : failure());
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > maximumJournalBytes) failure();
  const file = await open(journal, constants.O_RDONLY | noFollow);
  try {
    const bytes = await file.readFile(); let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { failure(); }
    if (!validJournal(parsed, tx)) failure(); return parsed;
  } finally { await file.close(); }
}
async function clear(tx: InstallationTransaction): Promise<void> {
  const { journal } = transactionPaths(tx); await unlink(journal).catch(error => { if (!absent(error)) throw error; });
}
async function snapshot(tx: InstallationTransaction): Promise<Journal["before"]> {
  const { root, prefix } = transactionPaths(tx); const bin = safeChild(prefix, "bin");
  await safeDirectory(bin);
  const wrappers: Record<string, SavedPath> = {};
  for (const name of wrapperNames) wrappers[name] = await source(safeChild(bin, name), true);
  return { current: await source(safeChild(root, "current"), true), wrappers, app: await appReceipt(tx.app) };
}
async function published(tx: InstallationTransaction): Promise<Journal["published"]> {
  const { root, prefix } = transactionPaths(tx); const bin = safeChild(prefix, "bin"); const current = await source(safeChild(root, "current"));
  if (current.type !== "link" || current.target !== `releases/${tx.version}`) failure("The canonical installer did not publish its expected release.");
  const release = await readFile(safeChild(safeChild(root, "releases"), tx.version + "/.gateway-release"), "utf8").catch(() => failure());
  if (release.trim() !== tx.version) failure();
  const wrappers: Record<string, SavedPath> = {};
  for (const name of wrapperNames) wrappers[name] = await source(safeChild(bin, name));
  return { current, wrappers, release: digest(Buffer.from(release)) };
}
async function restore(path: string, before: SavedPath, expected: SavedPath): Promise<boolean> {
  if (!await matches(path, expected)) return false;
  if (before.type === "absent") { await unlink(path); return true; }
  const temporary = join(dirname(path), `.${randomUUID()}.restore`);
  if (before.type === "link") await symlink(before.target, temporary);
  else await atomic(temporary, Buffer.from(before.bytes, "base64"));
  await rename(temporary, path); return true;
}
async function restoreApp(tx: InstallationTransaction, journal: Journal, command: TransactionCommand, verifyApp?: (app: string) => Promise<void>): Promise<boolean> {
  if (!journal.swap || !(await equalApp(tx.app, journal.swap.incoming))) return !journal.swap;
  const helper = join(tx.app, "Contents", "MacOS", "GatewayUpdateInstaller");
  await verifyApp?.(tx.app); await command(helper, [tx.app, journal.swap.stage]);
  return await equalApp(tx.app, journal.before.app);
}
async function equalApp(path: string, expected: Receipt): Promise<boolean> {
  try { return equal(await appReceipt(path), expected); } catch { return false; }
}

export async function beginInstallationTransaction(input: InstallationTransaction): Promise<InstallationTransaction> {
  const tx = { installation: { ...input.installation }, app: input.app, version: input.version, team: input.team };
  await assertTransaction(tx);
  await withInstallationLock(tx.installation.root, async () => {
    if (await load(tx)) failure("An earlier app update transaction needs recovery.");
    await save(tx, { schema: 1, root: resolve(tx.installation.root), prefix: resolve(tx.installation.prefix), app: tx.app, version: tx.version, team: tx.team,
      phase: "prepared", before: await snapshot(tx) });
  });
  return tx;
}

export async function runCanonicalInstall(tx: InstallationTransaction, options: { installer: TransactionInstaller; command: TransactionCommand; signal?: AbortSignal }): Promise<void> {
  let journal = await load(tx); if (!journal) failure();
  journal.phase = "cli_installing"; await save(tx, journal);
  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("cancelled");
    await options.installer({ command: options.command, signal: options.signal });
    await withInstallationLock(tx.installation.root, async () => { journal = (await load(tx))!; journal.phase = "cli_published"; journal.published = await published(tx); await save(tx, journal); });
  } catch (error) {
    await withInstallationLock(tx.installation.root, async () => {
      journal = (await load(tx))!; try { journal.published = await published(tx); journal.phase = "cli_published"; await save(tx, journal); } catch { /* no owned publication */ }
      await rollbackJournal(tx, journal, options.command);
    });
    throw error;
  }
}

async function rollbackJournal(tx: InstallationTransaction, journal: Journal, command: TransactionCommand, verifyApp?: (app: string) => Promise<void>): Promise<void> {
  if (journal.swap && !await restoreApp(tx, journal, command, verifyApp)) failure("The app changed while its update was being recovered.");
  if (journal.published) {
    const { root, prefix } = transactionPaths(tx); const bin = safeChild(prefix, "bin");
    if (!await restore(safeChild(root, "current"), journal.before.current, journal.published.current)) failure("The gateway release changed while its update was being recovered.");
    for (const name of wrapperNames) if (!await restore(safeChild(bin, name), journal.before.wrappers[name]!, journal.published.wrappers[name]!)) failure("A gateway wrapper changed while its update was being recovered.");
  }
  await clear(tx);
}

export async function rollbackOwnedTransaction(tx: InstallationTransaction, options: { command?: TransactionCommand; verifyApp?: (app: string) => Promise<void> } = {}): Promise<void> {
  await assertTransaction(tx);
  await withInstallationLock(tx.installation.root, async () => {
    const journal = await load(tx); if (journal) await rollbackJournal(tx, journal, options.command ?? (async () => failure()), options.verifyApp);
  });
}

export async function swapAndCommitInstallationTransaction(tx: InstallationTransaction, options: {
  helper: string; stage: string; command: TransactionCommand; signal?: AbortSignal; verifyTarget: (app: string) => Promise<void>;
}): Promise<void> {
  await assertTransaction(tx); const stage = resolve(options.stage);
  if (!isAbsolute(options.stage) || dirname(stage) !== dirname(tx.app) || options.helper !== join(stage, "Contents", "MacOS", "GatewayUpdateInstaller")) failure();
  await safeExistingParent(dirname(stage)); await options.verifyTarget(stage);
  let journal = await load(tx); if (!journal?.published) failure();
  const incoming = await appReceipt(stage); const target = await appReceipt(tx.app);
  if (!equal(target, journal.before.app)) failure("The installed app changed before its update could start.");
  journal.phase = "app_swap_started"; journal.swap = { stage, incoming, target }; await save(tx, journal);
  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("cancelled");
    await options.verifyTarget(stage); await options.command(options.helper, [tx.app, stage], options.signal);
    if (!await equalApp(tx.app, incoming)) failure("The app swap did not publish the verified candidate.");
    journal = (await load(tx))!; journal.phase = "app_swapped"; await save(tx, journal);
    journal.phase = "committed"; await save(tx, journal); await clear(tx);
  } catch (error) {
    await rollbackOwnedTransaction(tx, { command: options.command, verifyApp: options.verifyTarget }).catch(() => undefined);
    throw error;
  }
}

export async function recoverInstallationTransaction(input: InstallationTransaction & {
  command: TransactionCommand; signal?: AbortSignal; verifyApp?: (app: string) => Promise<void>; pending?: unknown;
}): Promise<void> {
  const tx: InstallationTransaction = { installation: input.installation, app: input.app, version: input.version, team: input.team };
  await assertTransaction(tx);
  await withInstallationLock(tx.installation.root, async () => {
    const journal = await load(tx); if (!journal) return;
    if (input.signal?.aborted) failure("The app update recovery was cancelled.");
    if (journal.phase === "committed") { await clear(tx); return; }
    if (input.pending && journal.swap && await equalApp(tx.app, journal.swap.incoming)) {
      await input.verifyApp?.(tx.app); journal.phase = "committed"; await save(tx, journal); await clear(tx); return;
    }
    await rollbackJournal(tx, journal, input.command, input.verifyApp);
  });
}

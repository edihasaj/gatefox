import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, readlink, rename, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readPrivate, safeAncestors, safeAppResourceAncestors } from "./private-fs.js";
import { withInstallationLock } from "../app-runtime-lock.js";

const noFollow = constants.O_NOFOLLOW ?? 0;
const journalFile = "app-update-transaction.json";
const wrappers = ["gateway", "harness-gateway", "subscription-gateway", "gatefox"] as const;
/** Launchers a journal may omit: an updater from before 1.8.0 never recorded `gatefox`. */
const optionalWrappers: ReadonlySet<string> = new Set(["gatefox"]);
/** The launchers this journal records, in a fixed order. */
const recorded = (set: Record<string, Saved>) => wrappers.filter(name => set[name] !== undefined);
const maximum = 512 * 1024;

export type TransactionCommand = (program: string, args: string[], signal?: AbortSignal) => Promise<void>;
export interface InstallationLocation { root: string; prefix: string }
export interface InstallationTransaction { installation: InstallationLocation; app: string; version: string; team: string; nonce: string }
export type TransactionInstaller = (options: { command: TransactionCommand; signal?: AbortSignal; nonce: string }) => Promise<void>;
type Receipt = { dev: number; ino: number; mode: number; size: number; digest: string };
type Saved = { kind: "none" } | { kind: "link"; target: string; receipt: Receipt } | { kind: "file"; bytes: string; receipt: Receipt };
type Journal = {
  schema: 1; root: string; prefix: string; app: string; version: string; team: string;
  nonce: string;
  phase: "prepared" | "installing" | "installed" | "swapping" | "swapped" | "committed";
  before: { app: Receipt; current: Saved; previous: Saved; wrappers: Record<string, Saved> };
  after?: { current: Saved; previous: Saved; wrappers: Record<string, Saved> };
  swap?: { stage: string; incoming: Receipt };
  installer?: { outputs: Partial<Record<"current" | "previous" | typeof wrappers[number], Receipt>> };
};

function bad(detail = "unsafe transaction"): never { throw new Error(detail); }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: Receipt, b: Receipt) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.digest === b.digest;
const checkVersion = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/.test(value);
const checkTeam = (value: string) => /^[A-Z0-9]{10}$/.test(value);
const checkNonce = (value: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
function newerVersion(left: string, right: string): boolean {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  return a[0]! > b[0]! || a[0] === b[0]! && (a[1]! > b[1]! || a[1] === b[1]! && a[2]! > b[2]!);
}
function inside(parent: string, path: string): string {
  const value = resolve(parent, path), part = relative(parent, value);
  if (part === ".." || part.startsWith("../") || isAbsolute(part)) bad();
  return value;
}
function paths(installation: InstallationLocation): { root: string; prefix: string; journal: string } {
  if (!isAbsolute(installation.root) || !isAbsolute(installation.prefix)) bad();
  const root = resolve(installation.root), prefix = resolve(installation.prefix);
  return { root, prefix, journal: join(root, journalFile) };
}
async function valid(tx: InstallationTransaction): Promise<void> {
  const value = paths(tx.installation);
  if (!isAbsolute(tx.app) || resolve(tx.app) !== tx.app || !checkVersion(tx.version) || !checkTeam(tx.team) || !checkNonce(tx.nonce)) bad();
  await safeAncestors(value.root); await safeAppResourceAncestors(dirname(tx.app));
}
async function privateJson(path: string, value: unknown): Promise<void> {
  await safeAncestors(dirname(path));
  const temp = join(dirname(path), `.${randomUUID()}.transaction`);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); await chmod(temp, 0o600); await rename(temp, path); }
  finally { await file.close(); await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
  const directory = await open(dirname(path), constants.O_RDONLY | noFollow);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function source(path: string, backup = false): Promise<Saved> {
  const info = await lstat(path).catch(error => missing(error) ? undefined : Promise.reject(error));
  if (!info) return { kind: "none" };
  const receipt = { dev: info.dev, ino: info.ino, mode: Number(info.mode) & 0o777, size: info.size, digest: "" };
  if (info.isSymbolicLink()) {
    const target = await readlink(path); return { kind: "link", target, receipt: { ...receipt, digest: hash(Buffer.from(target)) } };
  }
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) || info.size > maximum / 2 || info.nlink !== 1) bad();
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const bytes = await file.readFile(), after = await file.stat();
    if (after.dev !== info.dev || after.ino !== info.ino || bytes.length !== info.size) bad();
    return { kind: "file", bytes: backup ? bytes.toString("base64") : "", receipt: { ...receipt, digest: hash(bytes) } };
  } finally { await file.close(); }
}
async function wrapper(path: string, name: string, backup = false): Promise<Saved> {
  const item = await source(path, true);
  if (item.kind === "none") return item;
  if (item.kind === "link") {
    if (name === "gateway" || item.target !== "gateway") bad();
    return item;
  }
  const text = Buffer.from(item.bytes, "base64").toString("utf8");
  if (!(item.receipt.mode & 0o111) || !["# Managed by gatefox installer", "# Managed by subscription-gateway installer"].some(marker => text.includes(marker))) bad();
  return backup ? item : { ...item, bytes: "" };
}
async function currentLink(path: string, backup = false): Promise<Saved> {
  const item = await source(path, backup);
  if (item.kind !== "link" || !/^releases\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.[0-9]$/.test(item.target)) bad();
  return item;
}
async function appReceipt(app: string): Promise<Receipt> {
  const bundle = await lstat(app).catch(() => bad());
  if (!bundle.isDirectory() || bundle.isSymbolicLink()) bad();
  const contents = await lstat(join(app, "Contents")).catch(() => bad());
  if (!contents.isDirectory() || contents.isSymbolicLink()) bad();
  const file = await open(join(app, "Contents", "Info.plist"), constants.O_RDONLY | noFollow).catch(() => bad());
  try {
    const info = await file.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || info.nlink !== 1 || (info.mode & 0o022)) bad();
    const bytes = await file.readFile(); if (bytes.length !== info.size) bad();
    return { dev: bundle.dev, ino: bundle.ino, mode: Number(bundle.mode) & 0o777, size: bytes.length, digest: hash(bytes) };
  } finally { await file.close(); }
}
async function appIs(path: string, receipt: Receipt): Promise<boolean> {
  try { return same(await appReceipt(path), receipt); } catch { return false; }
}
async function save(tx: InstallationTransaction, journal: Journal): Promise<void> { await privateJson(paths(tx.installation).journal, journal); }
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function receipt(value: unknown): Receipt | undefined {
  const row = record(value);
  const dev = row?.dev, ino = row?.ino, mode = row?.mode, size = row?.size, valueHash = row?.digest;
  return row && typeof dev === "number" && typeof ino === "number" && typeof mode === "number" && typeof size === "number" &&
    Number.isSafeInteger(dev) && Number.isSafeInteger(ino) && Number.isInteger(mode) && Number.isSafeInteger(size) &&
    typeof valueHash === "string" && /^[a-f0-9]{64}$/.test(valueHash) && dev >= 0 && ino >= 0 && mode >= 0 && mode <= 0o777 &&
    size >= 0 && size <= maximum ? { dev, ino, mode, size, digest: valueHash } : undefined;
}
function saved(value: unknown, backup: boolean): Saved | undefined {
  const row = record(value); if (!row || typeof row.kind !== "string") return;
  if (row.kind === "none") return Object.keys(row).length === 1 ? { kind: "none" } : undefined;
  const source = receipt(row.receipt); if (!source) return;
  if (row.kind === "link") return typeof row.target === "string" && !!row.target && !isAbsolute(row.target) &&
    !row.target.split("/").includes("..") && hash(Buffer.from(row.target)) === source.digest ? { kind: "link", target: row.target, receipt: source } : undefined;
  if (row.kind !== "file" || typeof row.bytes !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.bytes)) return;
  const bytes = Buffer.from(row.bytes, "base64");
  if (backup && (bytes.length !== source.size || hash(bytes) !== source.digest)) return;
  if (!backup && row.bytes !== "") return;
  return { kind: "file", bytes: row.bytes, receipt: source };
}
function savedSet(value: unknown, backup: boolean): Record<string, Saved> | undefined {
  const row = record(value); if (!row || Object.keys(row).some(key => !(wrappers as readonly string[]).includes(key))) return;
  const result: Record<string, Saved> = {};
  for (const name of wrappers) {
    if (row[name] === undefined && optionalWrappers.has(name)) continue;
    const item = saved(row[name], backup); if (!item) return; result[name] = item;
  }
  return result;
}
function parseJournal(value: unknown, installation: InstallationLocation, app: string, team: string): Journal {
  const row = record(value), expected = paths(installation); if (!row || row.schema !== 1 || row.root !== expected.root || row.prefix !== expected.prefix ||
    row.app !== app || row.team !== team || typeof row.version !== "string" || !checkVersion(row.version) || typeof row.nonce !== "string" || !checkNonce(row.nonce) ||
    !["prepared", "installing", "installed", "swapping", "swapped", "committed"].includes(String(row.phase))) bad();
  const before = record(row.before), priorApp = receipt(before?.app), priorCurrent = saved(before?.current, true), priorPrevious = saved(before?.previous, true),
    priorWrappers = savedSet(before?.wrappers, true);
  if (!before || Object.keys(before).length !== 4 || !priorApp || !priorCurrent || !priorPrevious || !priorWrappers) bad();
  let after: Journal["after"];
  if (row.after !== undefined) {
    const output = record(row.after), current = saved(output?.current, false), previous = saved(output?.previous, false), outputWrappers = savedSet(output?.wrappers, false);
    if (!output || Object.keys(output).length !== 3 || !current || !previous || !outputWrappers) bad();
    after = { current, previous, wrappers: outputWrappers };
  }
  let swap: Journal["swap"];
  if (row.swap !== undefined) {
    const item = record(row.swap), stage = item?.stage, incoming = receipt(item?.incoming);
    if (typeof stage !== "string" || !incoming || !isAbsolute(stage) || resolve(stage) !== stage || dirname(stage) !== dirname(app) ||
      !stage.endsWith(".app") || stage === app) bad();
    swap = { stage, incoming };
  }
  let installer: Journal["installer"];
  if (row.installer !== undefined) {
    const item = record(row.installer), outputs = record(item?.outputs);
    if (!item || !outputs || Object.keys(outputs).some(key => !["current", "previous", ...wrappers].includes(key))) bad();
    const result: NonNullable<Journal["installer"]>["outputs"] = {};
    for (const [key, value] of Object.entries(outputs)) { const valueReceipt = receipt(value); if (!valueReceipt) bad(); result[key as keyof typeof result] = valueReceipt; }
    installer = { outputs: result };
  }
  if ((row.phase === "swapping" || row.phase === "swapped") && !swap || (row.phase === "installed" && !after)) bad();
  return { schema: 1, root: expected.root, prefix: expected.prefix, app, version: row.version, team, nonce: row.nonce, phase: row.phase as Journal["phase"],
    before: { app: priorApp, current: priorCurrent, previous: priorPrevious, wrappers: priorWrappers }, ...(after ? { after } : {}), ...(swap ? { swap } : {}), ...(installer ? { installer } : {}) };
}
async function load(tx: Pick<InstallationTransaction, "installation" | "app" | "team">): Promise<Journal | undefined> {
  const bytes = await readPrivate(paths(tx.installation).journal, maximum);
  if (!bytes) return;
  try { return parseJournal(JSON.parse(bytes.toString("utf8")), tx.installation, tx.app, tx.team); } catch { bad(); }
}
async function locked<T>(root: string, action: () => Promise<T>): Promise<T> {
  return withInstallationLock(root, async guard => { guard.check(); const value = await action(); guard.check(); return value; });
}
async function snapshot(tx: InstallationTransaction): Promise<Journal["before"]> {
  const { root, prefix } = paths(tx.installation), bin = inside(prefix, "bin");
  await safeAncestors(bin); const prior: Record<string, Saved> = {};
  for (const name of wrappers) prior[name] = await wrapper(inside(bin, name), name, true);
  const current = await currentLink(inside(root, "current"), true);
  const installed = current.kind === "link" ? current.target.slice("releases/".length) : "";
  if (current.kind !== "link" || (await readFile(inside(join(root, "releases"), `${installed}/.gateway-release`), "utf8").catch(() => "")).trim() !== installed) bad();
  if (newerVersion(installed, tx.version)) bad("a newer gateway release is already installed");
  return { app: await appReceipt(tx.app), current,
    previous: await source(inside(root, "previous-release"), true), wrappers: prior };
}
async function publication(tx: InstallationTransaction, journal: Journal): Promise<NonNullable<Journal["after"]>> {
  const { root, prefix } = paths(tx.installation), expected = journal.installer?.outputs;
  if (!expected) {
    const visible = (item: Saved): Saved => item.kind === "file" ? { ...item, bytes: "" } : item;
    return { current: visible(journal.before.current), previous: visible(journal.before.previous),
      wrappers: Object.fromEntries(recorded(journal.before.wrappers).map(name => [name, visible(journal.before.wrappers[name]!)])) };
  }
  const choose = async (path: string, prior: Saved, read: () => Promise<Saved>, key: "current" | "previous" | typeof wrappers[number]) => {
    const output = await read();
    const receipt = expected[key];
    return receipt && output.kind !== "none" && same(output.receipt, receipt) ? output :
      prior.kind === "file" ? { ...prior, bytes: "" } : prior;
  };
  const bin = inside(prefix, "bin"), output: Record<string, Saved> = {};
  for (const name of recorded(journal.before.wrappers)) output[name] = await choose(inside(bin, name), journal.before.wrappers[name]!, () => wrapper(inside(bin, name), name), name);
  const current = await choose(inside(root, "current"), journal.before.current, () => currentLink(inside(root, "current")), "current");
  const previous = await choose(inside(root, "previous-release"), journal.before.previous, () => source(inside(root, "previous-release")), "previous");
  return { current, previous, wrappers: output };
}
function completePublication(tx: InstallationTransaction, journal: Journal, after: NonNullable<Journal["after"]>): void {
  const outputs = journal.installer?.outputs;
  if (!outputs || after.current.kind !== "link" || after.current.target !== `releases/${tx.version}` || !outputs.current ||
    !same(after.current.receipt, outputs.current)) bad("installer did not publish expected release");
  for (const name of ["gateway", "harness-gateway"] as const) {
    const item = after.wrappers[name];
    if (!item || item.kind === "none" || !outputs[name] || !same(item.receipt, outputs[name]!)) bad("installer did not publish expected wrapper");
  }
}
async function matches(path: string, expected: Saved): Promise<boolean> {
  const actual = await source(path);
  return actual.kind === expected.kind && (actual.kind === "none" || expected.kind === "none" ||
    same(actual.receipt, expected.receipt) && (actual.kind !== "link" || expected.kind !== "link" || actual.target === expected.target));
}
async function desired(path: string, before: Saved): Promise<boolean> {
  const actual = await source(path);
  if (actual.kind !== before.kind) return false;
  if (actual.kind === "none" || before.kind === "none") return true;
  if (actual.kind === "link" && before.kind === "link") return actual.target === before.target;
  return actual.kind === "file" && before.kind === "file" && actual.receipt.mode === before.receipt.mode &&
    actual.receipt.size === before.receipt.size && actual.receipt.digest === before.receipt.digest;
}
async function restore(path: string, before: Saved, after: Saved): Promise<void> {
  if (before.kind === "none" && after.kind === "none") return;
  if (await desired(path, before)) return;
  if (!await matches(path, after)) bad("published output changed");
  if (before.kind === "none") { await unlink(path); return; }
  const temp = join(dirname(path), `.${randomUUID()}.rollback`);
  if (before.kind === "link") await symlink(before.target, temp);
  else {
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, before.receipt.mode);
    try { await file.writeFile(Buffer.from(before.bytes, "base64")); await file.sync(); await chmod(temp, before.receipt.mode); } finally { await file.close(); }
  }
  await rename(temp, path);
}
async function restoreApp(tx: InstallationTransaction, journal: Journal, command: TransactionCommand, verifyIncoming?: (app: string) => Promise<void>, verifyRetained?: (app: string) => Promise<void>): Promise<void> {
  if (!journal.swap || await appIs(tx.app, journal.before.app)) return;
  if (!await appIs(tx.app, journal.swap.incoming)) bad("app changed");
  if (!await appIs(journal.swap.stage, journal.before.app)) bad("retained app changed");
  await verifyIncoming?.(tx.app); await verifyRetained?.(journal.swap.stage);
  await command(join(tx.app, "Contents", "MacOS", "GatewayUpdateInstaller"), [tx.app, journal.swap.stage]);
  if (!await appIs(tx.app, journal.before.app)) bad("app rollback failed");
}
async function rollback(tx: InstallationTransaction, journal: Journal, command: TransactionCommand, verifyIncoming?: (app: string) => Promise<void>, verifyRetained?: (app: string) => Promise<void>): Promise<void> {
  if (journal.swap && !await appIs(tx.app, journal.before.app) &&
    (!await appIs(tx.app, journal.swap.incoming) || !await appIs(journal.swap.stage, journal.before.app))) bad("app changed");
  if (journal.after) {
    const { root, prefix } = paths(tx.installation), bin = inside(prefix, "bin");
    const names = recorded(journal.before.wrappers);
    if (names.some(name => !journal.after!.wrappers[name])) bad("published output changed");
    const checks: Array<readonly [string, Saved, Saved]> = [
      ...names.map(name => [inside(bin, name), journal.before.wrappers[name]!, journal.after!.wrappers[name]!] as const),
      [inside(root, "previous-release"), journal.before.previous, journal.after.previous],
      [inside(root, "current"), journal.before.current, journal.after.current],
    ];
    for (const [path, before, after] of checks) if (!await desired(path, before) && !await matches(path, after)) bad("published output changed");
    await restoreApp(tx, journal, command, verifyIncoming, verifyRetained);
    for (const name of names) await restore(inside(bin, name), journal.before.wrappers[name]!, journal.after.wrappers[name]!);
    await restore(inside(root, "previous-release"), journal.before.previous, journal.after.previous);
    await restore(inside(root, "current"), journal.before.current, journal.after.current);
  } else await restoreApp(tx, journal, command, verifyIncoming, verifyRetained);
  await unlink(paths(tx.installation).journal);
}

export async function beginInstallationTransaction(input: Omit<InstallationTransaction, "nonce">): Promise<InstallationTransaction> {
  const tx = { installation: { ...input.installation }, app: input.app, version: input.version, team: input.team, nonce: randomUUID() };
  await valid(tx);
  await locked(paths(tx.installation).root, async () => {
    if (await load(tx)) bad("transaction needs recovery");
    await save(tx, { schema: 1, root: resolve(tx.installation.root), prefix: resolve(tx.installation.prefix), app: tx.app, version: tx.version, team: tx.team, nonce: tx.nonce,
      phase: "prepared", before: await snapshot(tx) });
  });
  return tx;
}
/** Rehydrate only the exact durable transaction; callers cannot supply or guess its nonce. */
export async function resumeInstallationTransaction(input: Omit<InstallationTransaction, "nonce">): Promise<InstallationTransaction> {
  const base = { installation: input.installation, app: input.app, team: input.team };
  const journal = await load(base);
  if (!journal || journal.version !== input.version || !journal.after || journal.phase !== "installed" && journal.phase !== "swapping") bad("transaction needs recovery");
  const tx: InstallationTransaction = { ...input, installation: { ...input.installation }, nonce: journal.nonce };
  await valid(tx); return tx;
}
/** Rehydrate only a completed transaction so its caller can acknowledge a separately fsynced state update. */
export async function committedInstallationTransaction(input: Omit<InstallationTransaction, "nonce">): Promise<InstallationTransaction> {
  const base = { installation: input.installation, app: input.app, team: input.team };
  const journal = await load(base);
  if (!journal || journal.version !== input.version || journal.phase !== "committed") bad("transaction is not committed");
  const tx: InstallationTransaction = { ...input, installation: { ...input.installation }, nonce: journal.nonce };
  await valid(tx); return tx;
}

export async function runCanonicalInstall(tx: InstallationTransaction, options: { installer: TransactionInstaller; command: TransactionCommand; signal?: AbortSignal }): Promise<void> {
  await valid(tx); let journal = await load(tx); if (!journal || journal.version !== tx.version) bad();
  journal.phase = "installing"; await save(tx, journal);
  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("cancelled");
    await options.installer({ command: options.command, signal: options.signal, nonce: tx.nonce });
    await locked(paths(tx.installation).root, async () => {
      journal = (await load(tx))!; journal.after = await publication(tx, journal); completePublication(tx, journal, journal.after);
      journal.phase = "installed"; await save(tx, journal);
    });
  } catch (error) {
    await locked(paths(tx.installation).root, async () => {
      journal = (await load(tx))!;
      try { journal.after = await publication(tx, journal); journal.phase = "installed"; await save(tx, journal); await rollback(tx, journal, options.command); }
      catch { /* retain unprovable partial publication for explicit recovery */ }
    }).catch(() => undefined);
    throw error;
  }
}

export async function rollbackOwnedTransaction(tx: InstallationTransaction, options: { command?: TransactionCommand; verifyIncoming?: (app: string) => Promise<void>; verifyRetained?: (app: string) => Promise<void>; verifyApp?: (app: string) => Promise<void> } = {}): Promise<void> {
  await valid(tx);
  await locked(paths(tx.installation).root, async () => {
    const journal = await load(tx); if (journal) await rollback(tx, journal, options.command ?? (async () => bad()), options.verifyIncoming ?? options.verifyApp, options.verifyRetained ?? options.verifyApp);
  });
}

export async function swapAndCommitInstallationTransaction(tx: InstallationTransaction, options: {
  helper: string; stage: string; command: TransactionCommand; signal?: AbortSignal; verifyIncoming?: (app: string) => Promise<void>; verifyRetained?: (app: string) => Promise<void>; verifyTarget?: (app: string) => Promise<void>;
}): Promise<void> {
  await valid(tx); const stage = resolve(options.stage);
  if (!isAbsolute(options.stage) || dirname(stage) !== dirname(tx.app) || options.helper !== join(stage, "Contents", "MacOS", "GatewayUpdateInstaller")) bad();
  const verifyIncoming = options.verifyIncoming ?? options.verifyTarget; if (!verifyIncoming) bad();
  await safeAppResourceAncestors(dirname(stage)); await verifyIncoming(stage);
  let journal = await load(tx); if (!journal?.after || journal.version !== tx.version || !await appIs(tx.app, journal.before.app)) bad();
  journal.swap = { stage, incoming: await appReceipt(stage) }; journal.phase = "swapping"; await save(tx, journal);
  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("cancelled");
    await verifyIncoming(stage); await options.command(options.helper, [tx.app, stage], options.signal);
    if (!await appIs(tx.app, journal.swap.incoming)) bad("app swap did not publish candidate");
    journal = (await load(tx))!; journal.phase = "swapped"; await save(tx, journal);
    journal.phase = "committed"; await save(tx, journal);
  } catch (error) {
    await locked(paths(tx.installation).root, async () => rollback(tx, (await load(tx))!, options.command, verifyIncoming, options.verifyRetained ?? options.verifyTarget)).catch(() => undefined);
    throw error;
  }
}

export async function recoverInstallationTransaction(input: {
  installation: InstallationLocation; app: string; team: string; pending?: unknown; command: TransactionCommand; signal?: AbortSignal; verifyIncoming?: (app: string) => Promise<void>; verifyRetained?: (app: string) => Promise<void>; verifyApp?: (app: string) => Promise<void>;
}): Promise<"none" | "rolled_back" | "committed" | "resume_pending"> {
  const base = { installation: input.installation, app: input.app, team: input.team };
  const verifyIncoming = input.verifyIncoming ?? input.verifyApp, verifyRetained = input.verifyRetained ?? input.verifyApp;
  const initial = await load(base); if (!initial) return "none";
  const tx: InstallationTransaction = { ...base, version: initial.version, nonce: initial.nonce }; await valid(tx);
  return locked(paths(tx.installation).root, async () => {
    const journal = await load(tx); if (!journal) return "none" as const;
    if (input.signal?.aborted) bad("recovery cancelled");
    if (journal.phase === "committed") return "committed" as const;
    const pending = record(input.pending), stage = pending?.appStage;
    const matchingPending = pending?.version === tx.version && typeof stage === "string" && isAbsolute(stage) && resolve(stage) === stage &&
      dirname(stage) === dirname(tx.app) && stage.endsWith(".app");
    if (journal.phase === "installed" && matchingPending) { await verifyIncoming?.(stage); return "resume_pending" as const; }
    if (matchingPending && journal.swap && stage === journal.swap.stage && await appIs(tx.app, journal.before.app)) {
      await verifyIncoming?.(stage); return "resume_pending" as const;
    }
    if (matchingPending && journal.swap && stage === journal.swap.stage && await appIs(tx.app, journal.swap.incoming) && journal.after &&
      await matches(inside(paths(tx.installation).root, "current"), journal.after.current)) {
      await verifyIncoming?.(tx.app); journal.phase = "committed"; await save(tx, journal); return "committed" as const;
    }
    if (!journal.after && journal.phase === "installing") {
      journal.after = await publication(tx, journal); await save(tx, journal);
    }
    await rollback(tx, journal, input.command, verifyIncoming, verifyRetained);
    return "rolled_back" as const;
  });
}

/** Deletes only a durable commit acknowledgement after the caller fsyncs its pending-state deletion. */
export async function finalizeCommittedInstallationTransaction(tx: InstallationTransaction): Promise<void> {
  await valid(tx);
  await locked(paths(tx.installation).root, async () => {
    const journal = await load(tx);
    if (!journal || journal.version !== tx.version || journal.nonce !== tx.nonce || journal.phase !== "committed") bad("transaction is not committed");
    await unlink(paths(tx.installation).journal);
  });
}
/** Clears only an already committed journal when the caller has no pending-state version left to rehydrate. */
export async function finalizeRecoveredCommittedInstallationTransaction(input: { installation: InstallationLocation; app: string; team: string }): Promise<boolean> {
  const base = { installation: input.installation, app: input.app, team: input.team };
  const initial = await load(base); if (!initial) return false;
  const tx: InstallationTransaction = { ...base, version: initial.version, nonce: initial.nonce };
  await valid(tx);
  return locked(paths(tx.installation).root, async () => {
    const journal = await load(tx); if (!journal) return false;
    if (journal.phase !== "committed") return false;
    await unlink(paths(tx.installation).journal); return true;
  });
}

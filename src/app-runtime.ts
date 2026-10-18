import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readlink, rename, symlink, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type InstallationGuard, withInstallationLock } from "./app-runtime-lock.js";

const installerMarker = "# Managed by subscription-gateway installer";
const installationMarker = "subscription-gateway";
const maximumWrapperBytes = 64 * 1024;
const noFollow = constants.O_NOFOLLOW ?? 0;
const owner = process.getuid?.();
const launcherNames = ["gateway", "harness-gateway", "subscription-gateway"] as const;

interface Source {
  bytes: Buffer;
  mode: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  hash: string;
}
interface Launcher { path: string; source: Source; output: Buffer }
interface PublishedLauncher { launcher: Launcher; output: Source }
interface PublishedLink { target: string }
export interface AppRuntimeOptions {
  home: string;
  appPath: string;
  stateDirectory: string;
  commandPath: string;
  apply?: boolean;
  /** Internal publication seam used by the isolated filesystem regression tests. */
  beforePublish?: (path: string, guard: InstallationGuard) => Promise<void>;
  /** Runs only after the just-published output has been recorded for rollback. */
  afterPublish?: (path: string, guard: InstallationGuard) => Promise<void>;
}
export interface ManagedInstallation { prefix: string; root: string; commandPath: string }

function unsafe(): never { throw new Error("unsafe"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** The installed launcher always uses the app runtime when the verified registration link exists. */
export function renderInstalledLauncher(root: string, command: string): string {
  const appRuntime = join(root, "app-runtime");
  return "#!/bin/sh\n" +
    "# Managed by subscription-gateway installer\n" +
    "# App runtime is registered by Harness Gateway.\n" +
    `runtime=${quote(join(root, "current/runtime/bin/node"))}\n` +
    `if [ -L ${quote(appRuntime)} ] || [ -e ${quote(appRuntime)} ]; then\n` +
    ` runtime=${quote(join(appRuntime, "bin/node"))}\n` +
    " [ -x \"$runtime\" ] || { echo 'Harness Gateway app runtime is unavailable.' >&2; exit 78; }\n" +
    ` PATH=${quote(join(appRuntime, "bin"))}:\"${"${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"}\"\n` +
    " export PATH\n" +
    "fi\n" +
    `GATEWAY_COMMAND=${quote(command)} GATEWAY_INSTALLED=1 exec \"$runtime\" ${quote(join(root, "current/package/dist/cli.js"))} \"$@\"\n`;
}

function safeDirectory(info: Awaited<ReturnType<typeof lstat>>): boolean {
  const mode = Number(info.mode);
  return info.isDirectory() && !info.isSymbolicLink() && (info.uid === owner || info.uid === 0) &&
    (!(mode & 0o022) || (info.uid === 0 && !!(mode & 0o1000)));
}
function appDirectory(path: string, info: Awaited<ReturnType<typeof lstat>>): boolean {
  return path === "/Applications" && info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 &&
    (Number(info.mode) & 0o777) === 0o775 || safeDirectory(info);
}
async function canonical(path: string): Promise<string> {
  if (!isAbsolute(path)) unsafe();
  let checked = resolve(path);
  for (const [alias, target] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]] as const) {
    if (checked === alias || !checked.startsWith(`${alias}${sep}`)) continue;
    const info = await lstat(alias).catch(unsafe);
    if (!info.isSymbolicLink()) continue;
    if (info.uid !== 0 || resolve("/", await readlink(alias).catch(unsafe)) !== target) unsafe();
    checked = `${target}${checked.slice(alias.length)}`;
    break;
  }
  return checked;
}
async function checkedAncestry(path: string, allowApplications = false): Promise<string> {
  const checked = await canonical(path);
  let current: string = sep;
  for (const part of checked.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(unsafe);
    if (!(allowApplications ? appDirectory(current, info) : safeDirectory(info))) unsafe();
  }
  return checked;
}
/** Validates the existing path and every existing parent before making private state directories. */
async function createPrivateDirectory(path: string, guard?: InstallationGuard): Promise<void> {
  const checked = await canonical(path);
  let current: string = sep;
  for (const part of checked.split(sep).filter(Boolean)) {
    current = join(current, part);
    let info = await lstat(current).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : unsafe());
    if (!info) {
      guard?.check(); await mkdir(current, { mode: 0o700 }).catch(error => (error as NodeJS.ErrnoException).code === "EEXIST" ? undefined : unsafe()); guard?.check();
      info = await lstat(current).catch(unsafe);
    }
    if (!safeDirectory(info) || (current === checked && (info.uid !== owner || !!(info.mode & 0o077)))) unsafe();
  }
}
async function readRegular(path: string, requiredMarker?: string, executable = true): Promise<Source | undefined> {
  await checkedAncestry(dirname(path));
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; unsafe(); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== owner || executable && !(info.mode & 0o100) || (info.mode & 0o022) || info.size > maximumWrapperBytes || info.nlink !== 1) unsafe();
    const bytes = await file.readFile();
    if (bytes.length !== info.size || requiredMarker && !bytes.toString("utf8").split("\n").includes(requiredMarker)) unsafe();
    return { bytes, mode: info.mode & 0o777, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, hash: createHash("sha256").update(bytes).digest("hex") };
  } finally { await file.close(); }
}
function sameSource(left: Source, right: Source): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.hash === right.hash && left.bytes.equals(right.bytes);
}
/** A rename can update ctime after the staged descriptor captured this owned inode. */
function samePublication(left: Source, right: Source): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.hash === right.hash && left.bytes.equals(right.bytes);
}
async function validateInstall(root: string): Promise<void> {
  const marker = await readRegular(join(root, ".gateway-installation"), undefined, false);
  if (!marker || !(marker.bytes.equals(Buffer.from(installationMarker)) || marker.bytes.equals(Buffer.from(`${installationMarker}\n`)))) unsafe();
}
function legacyLauncher(root: string, command: string): Buffer {
  return Buffer.from("#!/bin/sh\n" + installerMarker + "\n" +
    `GATEWAY_COMMAND=${quote(command)} GATEWAY_INSTALLED=1 exec ${quote(join(root, "current/runtime/bin/node"))} ${quote(join(root, "current/package/dist/cli.js"))} \"$@\"\n`);
}
function recognizedLauncher(bytes: Buffer, root: string, command: string): boolean {
  const variants = (path: string) => [path, path.replace(/^\/private\/var(?=\/|$)/, "/var").replace(/^\/private\/tmp(?=\/|$)/, "/tmp")];
  return variants(root).some(candidateRoot => variants(command).some(candidateCommand => {
    const bin = dirname(candidateCommand);
    return launcherNames.some(name => bytes.equals(Buffer.from(renderInstalledLauncher(candidateRoot, join(bin, name)))) || bytes.equals(legacyLauncher(candidateRoot, join(bin, name))));
  }));
}
/** Derives an installation only from an exact installer launcher and verifies its root marker and template. */
export async function managedInstallationForCommand(commandPath: string): Promise<ManagedInstallation> {
  const command = await canonical(commandPath); const name = basename(command); const bin = dirname(command);
  if (!launcherNames.includes(name as typeof launcherNames[number]) || basename(bin) !== "bin") unsafe();
  const prefix = dirname(bin); const root = join(prefix, "share", "subscription-gateway");
  if (command !== join(prefix, "bin", name)) unsafe();
  await validateInstall(root);
  const source = await readRegular(command, installerMarker);
  if (!source || !recognizedLauncher(source.bytes, root, command)) unsafe();
  return { prefix, root, commandPath: command };
}
async function validateAppRuntime(appPath: string): Promise<string> {
  const runtime = await checkedAncestry(join(appPath, "Contents/Resources/backend/runtime"), true);
  const nodePath = join(await checkedAncestry(join(runtime, "bin"), true), "node");
  const node = await open(nodePath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow).catch(unsafe);
  try {
    const info = await node.stat();
    if (!info.isFile() || (info.uid !== owner && info.uid !== 0) || !(info.mode & 0o100) || (info.mode & 0o022)) unsafe();
  } finally { await node.close(); }
  return runtime;
}
async function appRuntimeChange(path: string, target: string): Promise<boolean> {
  const info = await lstat(path).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : unsafe());
  if (!info) return true;
  if (!info.isSymbolicLink() || info.uid !== owner || resolve(dirname(path), await readlink(path).catch(unsafe)) !== target) unsafe();
  return false;
}
async function wrappers(root: string, commandPath: string): Promise<Launcher[]> {
  const bin = dirname(commandPath);
  const paths = launcherNames.map(name => join(bin, name));
  if (!paths.includes(commandPath)) unsafe();
  const available: Array<{ path: string; source: Source }> = [];
  let commandFound = false;
  for (const path of paths) {
    const info = await lstat(path).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : unsafe());
    if (!info) continue;
    if (info.isSymbolicLink()) unsafe();
    const source = await readRegular(path, installerMarker);
    if (!source || !recognizedLauncher(source.bytes, root, path)) unsafe();
    if (path === commandPath) commandFound = true;
    available.push({ path, source });
  }
  if (!commandFound) unsafe();
  const primary = available.find(item => item.path === join(bin, "harness-gateway"))?.path ?? commandPath;
  return available.flatMap(({ path, source }) => {
    const output = Buffer.from(renderInstalledLauncher(root, primary));
    return source.bytes.equals(output) ? [] : [{ path, source, output }];
  });
}
async function atomicFile(path: string, bytes: Buffer, mode: number, guard?: InstallationGuard): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.app-runtime`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, mode).catch(unsafe);
  let published = false;
  try {
    guard?.check(); await file.writeFile(bytes); guard?.check(); await file.sync(); guard?.check(); await chmod(temporary, mode); guard?.check();
    await file.close(); guard?.check(); await rename(temporary, path).catch(unsafe); published = true; guard?.check();
  } finally {
    await file.close().catch(() => undefined);
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}
async function backup(directory: string, launcher: Launcher, guard: InstallationGuard): Promise<void> {
  const name = `app-runtime-${launcher.path.split(sep).at(-1)!}-${randomUUID()}.sh`;
  await atomicFile(join(directory, name), launcher.source.bytes, 0o600, guard);
  const handle = await open(directory, constants.O_RDONLY).catch(unsafe);
  try { guard.check(); await handle.sync(); guard.check(); } finally { await handle.close(); }
}
async function replaceLauncher(launcher: Launcher, guard: InstallationGuard): Promise<Source> {
  const temporary = join(dirname(launcher.path), `.${randomUUID()}.app-runtime`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, launcher.source.mode).catch(unsafe);
  let published = false;
  try {
    guard.check(); await file.writeFile(launcher.output); guard.check(); await file.sync(); guard.check(); await chmod(temporary, launcher.source.mode); guard.check();
    const current = await readRegular(launcher.path, installerMarker);
    if (!current || !sameSource(launcher.source, current)) unsafe();
    const info = await file.stat();
    const output: Source = { bytes: launcher.output, mode: info.mode & 0o777, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, hash: createHash("sha256").update(launcher.output).digest("hex") };
    await file.close(); await rename(temporary, launcher.path); published = true;
    return output;
  } finally {
    await file.close().catch(() => undefined);
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}

async function canUndoLauncher(published: PublishedLauncher): Promise<boolean> {
  const current = await readRegular(published.launcher.path, installerMarker).catch(() => undefined);
  return !!current && samePublication(published.output, current);
}
async function undoLauncher(published: PublishedLauncher): Promise<boolean> {
  if (!await canUndoLauncher(published)) return false;
  const temporary = join(dirname(published.launcher.path), `.${randomUUID()}.app-runtime-undo`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, published.launcher.source.mode).catch(() => undefined);
  if (!file) return false;
  let restored = false;
  try {
    await file.writeFile(published.launcher.source.bytes); await file.sync(); await chmod(temporary, published.launcher.source.mode);
    const final = await readRegular(published.launcher.path, installerMarker);
    if (final && samePublication(published.output, final)) { await file.close(); await rename(temporary, published.launcher.path); restored = true; }
  } catch { /* A competing writer wins; the private backup remains useful. */ }
  finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  return restored;
}
async function undoLink(path: string, published: PublishedLink): Promise<boolean> {
  const current = await lstat(path).catch(() => undefined);
  if (!current || !current.isSymbolicLink()) return false;
  const target = await readlink(path).catch(() => undefined);
  if (target !== published.target) return false;
  await unlink(path).catch(() => undefined);
  return !(await lstat(path).catch(() => undefined));
}
function rollbackRefused(error: unknown): Error {
  return Object.assign(new Error("Runtime rollback was refused; signed runtime remains registered."), { code: "EROLLBACK", cause: error });
}
async function publishAssociation(options: AppRuntimeOptions, afterPublish: ((guard: InstallationGuard) => Promise<void>) | undefined, guard: InstallationGuard): Promise<boolean> {
  const home = await canonical(options.home);
  await checkedAncestry(home);
  const installation = await managedInstallationForCommand(options.commandPath);
  // A command under a different user's home is never an association target for this app request.
  if (installation.commandPath !== join(installation.prefix, "bin", basename(installation.commandPath))) unsafe();
  const runtime = await validateAppRuntime(await canonical(options.appPath));
  const registration = join(installation.root, "app-runtime");
  const registrationChange = await appRuntimeChange(registration, runtime);
  const changes = await wrappers(installation.root, installation.commandPath);
  const changed = registrationChange || changes.length > 0;
  if (options.apply === false || !changed && !afterPublish) return changed;
  if (changed) {
    const backups = join(await canonical(options.stateDirectory), "service-backups");
    await createPrivateDirectory(backups, guard);
    for (const launcher of changes) { guard.check(); await backup(backups, launcher, guard); }
  }
  let link: PublishedLink | undefined; const launchers: PublishedLauncher[] = [];
  try {
    if (registrationChange) {
      guard.check(); await options.beforePublish?.(registration, guard); guard.check(); await symlink(runtime, registration).catch(unsafe);
      link = { target: runtime };
      await options.afterPublish?.(registration, guard); guard.check();
    }
    for (const launcher of changes) {
      guard.check(); await options.beforePublish?.(launcher.path, guard); guard.check();
      const published = { launcher, output: await replaceLauncher(launcher, guard) };
      launchers.push(published);
      await options.afterPublish?.(launcher.path, guard); guard.check();
    }
    guard.check(); await afterPublish?.(guard); guard.check();
    return changed;
  } catch (error) {
    if ((error as { preserveRuntimeDependencies?: unknown }).preserveRuntimeDependencies) throw rollbackRefused(error);
    if (!await Promise.all(launchers.map(canUndoLauncher)).then(values => values.every(Boolean))) throw rollbackRefused(error);
    let restored = true;
    for (const launcher of launchers.reverse()) if (!await undoLauncher(launcher)) restored = false;
    if (!restored) throw rollbackRefused(error);
    if (link && !await undoLink(registration, link)) throw rollbackRefused(error);
    throw error;
  }
}

/** Associates already-verified app runtime identity with installer-owned command wrappers. */
export async function associateAppRuntime(options: AppRuntimeOptions): Promise<boolean> {
  if (owner === undefined || !isAbsolute(options.home) || !isAbsolute(options.appPath) || !isAbsolute(options.stateDirectory) || !isAbsolute(options.commandPath)) unsafe();
  const installation = await managedInstallationForCommand(options.commandPath);
  return withInstallationLock(installation.root, guard => publishAssociation(options, undefined, guard));
}

/** Publishes an app-runtime association and a dependent private publication as one rollback boundary. */
export async function associateAppRuntimeTransaction(options: AppRuntimeOptions, afterPublish: (guard: InstallationGuard) => Promise<void>): Promise<boolean> {
  if (options.apply === false) return associateAppRuntime(options);
  const installation = await managedInstallationForCommand(options.commandPath);
  return withInstallationLock(installation.root, guard => publishAssociation(options, afterPublish, guard));
}

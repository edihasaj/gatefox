import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readlink, rename, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

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
async function createPrivateDirectory(path: string): Promise<void> {
  const checked = await canonical(path);
  let current: string = sep;
  for (const part of checked.split(sep).filter(Boolean)) {
    current = join(current, part);
    let info = await lstat(current).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : unsafe());
    if (!info) {
      await mkdir(current, { mode: 0o700 }).catch(error => (error as NodeJS.ErrnoException).code === "EEXIST" ? undefined : unsafe());
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
async function validateInstall(root: string): Promise<void> {
  const marker = await readRegular(join(root, ".gateway-installation"), undefined, false);
  if (!marker || !(marker.bytes.equals(Buffer.from(installationMarker)) || marker.bytes.equals(Buffer.from(`${installationMarker}\n`)))) unsafe();
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
async function wrappers(home: string, root: string, commandPath: string): Promise<Launcher[]> {
  const bin = join(home, ".local", "bin");
  const paths = launcherNames.map(name => join(bin, name));
  if (!paths.includes(commandPath)) unsafe();
  const output: Launcher[] = [];
  let commandFound = false;
  for (const path of paths) {
    const info = await lstat(path).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : unsafe());
    if (!info || info.isSymbolicLink()) continue;
    const source = await readRegular(path, installerMarker);
    if (!source) unsafe();
    if (path === commandPath) commandFound = true;
    const next = Buffer.from(renderInstalledLauncher(root, path));
    if (!source.bytes.equals(next)) output.push({ path, source, output: next });
  }
  if (!commandFound) unsafe();
  return output;
}
async function atomicFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.app-runtime`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, mode).catch(unsafe);
  let published = false;
  try {
    await file.writeFile(bytes); await file.sync(); await chmod(temporary, mode);
    await file.close(); await rename(temporary, path).catch(unsafe); published = true;
  } finally {
    await file.close().catch(() => undefined);
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}
async function backup(directory: string, launcher: Launcher): Promise<void> {
  const name = `app-runtime-${launcher.path.split(sep).at(-1)!}-${randomUUID()}.sh`;
  await atomicFile(join(directory, name), launcher.source.bytes, 0o600);
  const handle = await open(directory, constants.O_RDONLY).catch(unsafe);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function replaceLauncher(launcher: Launcher): Promise<void> {
  const temporary = join(dirname(launcher.path), `.${randomUUID()}.app-runtime`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, launcher.source.mode).catch(unsafe);
  let published = false;
  try {
    await file.writeFile(launcher.output); await file.sync(); await chmod(temporary, launcher.source.mode);
    const current = await readRegular(launcher.path, installerMarker);
    if (!current || !sameSource(launcher.source, current)) unsafe();
    await file.close(); await rename(temporary, launcher.path); published = true;
  } finally {
    await file.close().catch(() => undefined);
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}

/** Associates already-verified app runtime identity with installer-owned command wrappers. */
export async function associateAppRuntime(options: { home: string; appPath: string; stateDirectory: string; commandPath: string; apply?: boolean }): Promise<boolean> {
  if (owner === undefined || !isAbsolute(options.home) || !isAbsolute(options.appPath) || !isAbsolute(options.stateDirectory) || !isAbsolute(options.commandPath)) unsafe();
  const home = await canonical(options.home);
  const root = join(home, ".local", "share", "subscription-gateway");
  const commandPath = await canonical(options.commandPath);
  const stateDirectory = await canonical(options.stateDirectory);
  await checkedAncestry(home);
  await validateInstall(root);
  const runtime = await validateAppRuntime(await canonical(options.appPath));
  const registration = join(root, "app-runtime");
  const registrationChange = await appRuntimeChange(registration, runtime);
  const changes = await wrappers(home, root, commandPath);
  const changed = registrationChange || changes.length > 0;
  if (options.apply === false || !changed) return changed;
  await createPrivateDirectory(join(stateDirectory, "service-backups"));
  for (const launcher of changes) await backup(join(stateDirectory, "service-backups"), launcher);
  if (registrationChange) await symlink(runtime, registration).catch(unsafe);
  for (const launcher of changes) await replaceLauncher(launcher);
  return true;
}

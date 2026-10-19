import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readlink, rename, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type GatewayConfig } from "../config.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { throwIfCancelled } from "./errors.js";
import { isManagementUnavailable, validateManagementConfig } from "./runtime.js";

const maximumFileSize = 2 * 1024 * 1024;
const noFollow = constants.O_NOFOLLOW ?? 0;
const owner = process.getuid?.();

export interface ConfigSnapshot {
  raw: Record<string, unknown>;
  config: GatewayConfig;
  revision: string;
}

type StorageCode = "invalid_configuration" | "unsafe_path" | "configuration_changed";
type FileInfo = { isFile(): boolean; uid: number; mode: number; size: number };
type DirectoryInfo = { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number };

function failure(code: StorageCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function unsafePath(): Error { return failure("unsafe_path", "Configuration path is unsafe"); }
function invalidConfiguration(): Error { return failure("invalid_configuration", "Configuration is invalid"); }
function configurationChanged(): Error { return failure("configuration_changed", "Configuration changed; retry"); }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownedPrivateFile(info: FileInfo): boolean {
  return info.isFile() && info.uid === owner && (info.mode & 0o777) === 0o600 && info.size <= maximumFileSize;
}

function ownedConfigFile(info: FileInfo): boolean {
  return info.isFile() && info.uid === owner && info.size <= maximumFileSize;
}

function ownedPrivateDirectory(info: DirectoryInfo): boolean {
  return info.isDirectory() && info.uid === owner && (info.mode & 0o777) === 0o700;
}

function safeExistingDirectory(info: DirectoryInfo): boolean {
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  if (info.uid !== owner && info.uid !== 0) return false;
  const groupOrWorldWritable = (info.mode & 0o022) !== 0;
  return !groupOrWorldWritable || (info.uid === 0 && (info.mode & 0o1000) !== 0);
}

async function normalizedPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw unsafePath();
  const result = normalize(path);
  for (const [alias, target] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]] as const) {
    if (result !== alias && !result.startsWith(`${alias}${sep}`)) continue;
    const info = await lstat(alias).catch(() => undefined);
    if (!info?.isSymbolicLink() || info.uid !== 0) continue;
    const targetValue = await readlink(alias).catch(() => { throw unsafePath(); });
    const linkTarget = resolve(dirname(alias), targetValue);
    if (linkTarget !== target) throw unsafePath();
    return `${target}${result.slice(alias.length)}`;
  }
  return result;
}

async function directoryTree(path: string, createMissing: boolean, privateTarget: boolean): Promise<string> {
  const checked = await normalizedPath(path);
  const parts = checked.split(sep).filter(Boolean);
  let current: string = sep;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    let info = await lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw unsafePath();
    });
    if (!info) {
      if (!createMissing) return checked;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unsafePath();
      }
      info = await lstat(current).catch(() => { throw unsafePath(); });
      if (!ownedPrivateDirectory(info)) throw unsafePath();
      continue;
    }
    const target = index === parts.length - 1;
    if (target && privateTarget ? !ownedPrivateDirectory(info) : !safeExistingDirectory(info)) throw unsafePath();
  }
  return checked;
}

async function privateParent(path: string): Promise<string> {
  const checked = await normalizedPath(path);
  await directoryTree(dirname(checked), true, true);
  return checked;
}

async function configParent(path: string): Promise<string> {
  const checked = await normalizedPath(path);
  await directoryTree(dirname(checked), true, false);
  return checked;
}

/** Creates a private, user-owned directory without traversing directory links. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await directoryTree(path, true, true);
}

async function openOwned(path: string, privateMode: boolean): Promise<ReturnType<typeof open>> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw unsafePath();
  }
  try {
    const info = await file.stat();
    if (!(privateMode ? ownedPrivateFile(info) : ownedConfigFile(info))) throw unsafePath();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function checkedConfigPath(path: string): Promise<string> {
  const checked = await normalizedPath(path);
  if (extname(checked) !== ".json") throw unsafePath();
  await directoryTree(dirname(checked), false, false);
  return checked;
}

export async function readSnapshot(configPathValue: string): Promise<ConfigSnapshot | undefined> {
  const configPath = await checkedConfigPath(configPathValue);
  const configBase = dirname(normalize(configPathValue));
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await openOwned(configPath, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const bytes = await file.readFile();
    let rawValue: unknown;
    try { rawValue = JSON.parse(bytes.toString("utf8")); }
    catch { throw invalidConfiguration(); }
    if (!isPlainRecord(rawValue)) throw invalidConfiguration();
    let config: GatewayConfig;
    try { config = await validateManagementConfig(rawValue, configBase); }
    catch (error) { if (isManagementUnavailable(error)) throw error; throw invalidConfiguration(); }
    return { raw: rawValue, config, revision: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if ((error as { code?: string }).code === "invalid_configuration" || isManagementUnavailable(error)) throw error;
    throw unsafePath();
  } finally {
    await file.close();
  }
}

export async function readOwnedJson<T>(path: string): Promise<T> {
  const checked = await normalizedPath(path);
  await directoryTree(dirname(checked), false, true);
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await openOwned(checked, true); }
  catch { throw unsafePath(); }
  try {
    try { return JSON.parse((await file.readFile()).toString("utf8")) as T; }
    catch { throw invalidConfiguration(); }
  } finally {
    await file.close();
  }
}

async function writeJson(
  path: string,
  value: unknown,
  exclusive: boolean,
  allowedExisting: (info: FileInfo) => boolean,
  parent: (value: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal);
  const checked = await parent(path);
  throwIfCancelled(signal);
  const existing = await lstat(checked).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unsafePath();
  });
  if (existing && !allowedExisting(existing)) throw unsafePath();

  let content: string;
  try {
    content = JSON.stringify(value, null, 2);
    if (content === undefined) throw new Error("not JSON");
  } catch { throw invalidConfiguration(); }

  const temporary = join(dirname(checked), `.${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    created = true;
    try {
      await file.writeFile(`${content}\n`);
      await file.sync();
      await chmod(temporary, 0o600);
    } finally {
      await file.close();
    }
    if (exclusive) {
      throwIfCancelled(signal);
      try { await link(temporary, checked); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw configurationChanged();
        throw unsafePath();
      }
      await unlink(temporary);
      created = false;
      return;
    }
    throwIfCancelled(signal);
    await rename(temporary, checked);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

export async function writeOwnedJson(path: string, value: unknown, exclusive = false, signal?: AbortSignal): Promise<void> {
  await writeJson(path, value, exclusive, ownedPrivateFile, privateParent, signal);
}

async function writeConfigJson(path: string, value: unknown, exclusive: boolean, signal?: AbortSignal): Promise<void> {
  await writeJson(path, value, exclusive, ownedConfigFile, configParent, signal);
}

export async function mutateConfig(
  configPathValue: string,
  expectedRevision: string | undefined,
  update: (snapshot: ConfigSnapshot | undefined) => Promise<Record<string, unknown>> | Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ConfigSnapshot> {
  throwIfCancelled(signal);
  const configPath = await configParent(configPathValue);
  throwIfCancelled(signal);
  const configBase = dirname(normalize(configPathValue));
  if (extname(configPath) !== ".json") throw unsafePath();
  return withPrivateFileLock(configPath, async () => {
    throwIfCancelled(signal);
    const current = await readSnapshot(configPathValue);
    if (expectedRevision === undefined ? current !== undefined : current?.revision !== expectedRevision) throw configurationChanged();

    const next = await update(current);
    if (!isPlainRecord(next)) throw invalidConfiguration();
    try { await validateManagementConfig(next, configBase); }
    catch (error) { if (isManagementUnavailable(error)) throw error; throw invalidConfiguration(); }
    if (current && isDeepStrictEqual(current.raw, next)) return current;

    if (current) {
      throwIfCancelled(signal);
      const backupDirectory = join(dirname(configPath), "app-backups");
      await ensurePrivateDirectory(backupDirectory);
      throwIfCancelled(signal);
      const beforeBackup = await readSnapshot(configPathValue);
      if (!beforeBackup || beforeBackup.revision !== current.revision) throw configurationChanged();
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      await writeOwnedJson(join(backupDirectory, `${stamp}-${randomUUID()}.json`), current.raw, true, signal);
      const beforeWrite = await readSnapshot(configPathValue);
      if (!beforeWrite || beforeWrite.revision !== current.revision) throw configurationChanged();
    }
    throwIfCancelled(signal);
    await writeConfigJson(configPath, next, current === undefined, signal);
    const saved = await readSnapshot(configPathValue);
    if (!saved) throw configurationChanged();
    return saved;
  });
}

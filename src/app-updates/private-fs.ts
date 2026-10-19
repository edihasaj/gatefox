import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readlink, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const noFollow = constants.O_NOFOLLOW ?? 0;
const owner = process.getuid?.();
const macAdminGroup = 80;

export function contained(parent: string, path: string): boolean {
  const part = relative(parent, path);
  return part === "" || !!part && !part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part);
}
export function safeName(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(value); }
export function safeVersion(value: unknown): value is string {
  return typeof value === "string" && /^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
}
export function versionNumber(value: string): [number, number, number] {
  const parts = value.replace(/^v/, "").split(".").map(Number);
  return [parts[0]!, parts[1]!, parts[2]!];
}
export function newer(left: string, right: string): boolean {
  const a = versionNumber(left), b = versionNumber(right);
  return a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2]);
}
function safeDirectory(info: Awaited<ReturnType<typeof lstat>>): boolean {
  const mode = Number(info.mode);
  return info.isDirectory() && !info.isSymbolicLink() && (info.uid === owner || info.uid === 0) &&
    (!(mode & 0o022) || info.uid === 0 && !!(mode & 0o1000));
}
/** Normalizes only macOS's root-owned standard aliases, never arbitrary links. */
async function canonical(path: string): Promise<string> {
  const checked = resolve(path);
  for (const [alias, target] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]] as const) {
    if (checked === alias || !checked.startsWith(`${alias}${sep}`)) continue;
    const info = await lstat(alias).catch(() => undefined);
    if (!info?.isSymbolicLink()) continue;
    if (info.uid !== 0 || resolve("/", await readlink(alias)) !== target) throw new Error("unsafe");
    return `${target}${checked.slice(alias.length)}`;
  }
  return checked;
}
function protectedUserDirectory(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && info.uid === owner && !(Number(info.mode) & 0o022);
}
/** App bundles may be user-owned children of the standard root:admin /Applications.
 * State and downloads never use this exception. */
export function appResourceAncestorAllowed(path: string, info: Awaited<ReturnType<typeof lstat>>, underApplications: boolean): boolean {
  if (path === "/Applications") {
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && info.gid === macAdminGroup &&
      (Number(info.mode) & 0o777) === 0o775 && process.getgroups?.().includes(macAdminGroup) === true;
  }
  return underApplications ? protectedUserDirectory(info) : safeDirectory(info);
}
export async function safeAppResourceAncestors(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("unsafe");
  let current: string = sep; let underApplications = false;
  for (const part of (await canonical(path)).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!appResourceAncestorAllowed(current, info, underApplications)) throw new Error("unsafe");
    if (current === "/Applications") underApplications = true;
  }
}
/** Checks every existing parent without traversing links. The target may be created afterwards. */
export async function safeAncestors(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("unsafe");
  let current: string = sep;
  for (const part of (await canonical(path)).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!safeDirectory(info)) throw new Error("unsafe");
  }
}
export async function privateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("unsafe");
  const checked = await canonical(path);
  let current: string = sep;
  for (const part of checked.split(sep).filter(Boolean)) {
    current = join(current, part);
    let info = await lstat(current).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
    if (!info) {
      await mkdir(current, { mode: 0o700 }).catch(error => (error as NodeJS.ErrnoException).code === "EEXIST" ? undefined : Promise.reject(error));
      info = await lstat(current);
    }
    if (!safeDirectory(info) || current === checked && (info.uid !== owner || !!(info.mode & 0o077))) throw new Error("unsafe");
  }
}
export async function readPrivate(path: string, limit = 64 * 1024): Promise<Buffer | undefined> {
  await safeAncestors(dirname(path));
  const handle = await open(path, constants.O_RDONLY | noFollow).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== owner || !!(info.mode & 0o077) || info.size > limit || info.nlink !== 1) throw new Error("unsafe");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) throw new Error("unsafe");
    return bytes;
  } finally { await handle.close(); }
}
/** Signed bundle metadata may be 0644 and root-owned; it must still be regular and non-writable by others. */
export async function readProtected(path: string, limit = 64 * 1024): Promise<Buffer | undefined> {
  await safeAncestors(dirname(path));
  const handle = await open(path, constants.O_RDONLY | noFollow).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.uid !== owner && info.uid !== 0) || !!(info.mode & 0o022) || info.size > limit || info.nlink !== 1) throw new Error("unsafe");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) throw new Error("unsafe");
    return bytes;
  } finally { await handle.close(); }
}
export async function readAppResource(path: string, limit = 64 * 1024): Promise<Buffer | undefined> {
  await safeAppResourceAncestors(dirname(path));
  const handle = await open(path, constants.O_RDONLY | noFollow).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== owner || !!(info.mode & 0o022) || info.size > limit || info.nlink !== 1) throw new Error("unsafe");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) throw new Error("unsafe");
    return bytes;
  } finally { await handle.close(); }
}
export async function writePrivate(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.update`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); await chmod(path, 0o600); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
export async function fileDigest(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1_500 * 1024 * 1024) throw new Error("unsafe");
    const digest = createHash("sha256");
    for await (const piece of file.createReadStream({ autoClose: false })) digest.update(piece);
    return digest.digest("hex");
  } finally { await file.close(); }
}
export async function readJson(path: string, limit = 64 * 1024): Promise<unknown | undefined> {
  const bytes = await readPrivate(path, limit);
  if (!bytes) return undefined;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export async function readProtectedJson(path: string, limit = 64 * 1024): Promise<unknown | undefined> {
  const bytes = await readProtected(path, limit);
  if (!bytes) return undefined;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export async function readAppResourceJson(path: string, limit = 64 * 1024): Promise<unknown | undefined> {
  const bytes = await readAppResource(path, limit);
  if (!bytes) return undefined;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

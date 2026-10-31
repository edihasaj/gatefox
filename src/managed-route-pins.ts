import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ManagedRoutePin {
  schema: "managed-route-pin.v1";
  alias: string;
  providerId: string;
  upstreamModel: string;
  bindingFingerprint: string;
  policyFingerprint: string;
}

const fields = ["schema", "alias", "providerId", "upstreamModel", "bindingFingerprint", "policyFingerprint"] as const;
const maxFileBytes = 4096;
const lockSymbol = Symbol.for("harness-gateway.managed-route-pins.locks");
const unsafe = () => new Error("Managed route pin state is unsafe or unreadable");
const conflict = () => new Error("Managed route pin conflicts with the stored pin");

/** Shared with read-only status projection; preserve the existing persisted key format. */
export const managedWorkerKey = (model: string, identity: string): string => createHash("sha256").update(JSON.stringify([model, identity])).digest("hex");

function locks(): Map<string, Promise<void>> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
  return holder[lockSymbol] ??= new Map();
}
/** One queue per directory and key, shared by every instance and module copy in this process. */
async function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
  const queue = locks();
  const previous = queue.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  queue.set(id, tail);
  await previous;
  try { return await work(); } finally {
    release();
    if (queue.get(id) === tail) queue.delete(id);
  }
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256;
}
function parsePin(value: unknown): ManagedRoutePin {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unsafe();
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) throw unsafe();
  if (row.schema !== "managed-route-pin.v1" || !bounded(row.alias) || !bounded(row.providerId) || !bounded(row.upstreamModel)) throw unsafe();
  for (const key of ["bindingFingerprint", "policyFingerprint"] as const) {
    if (typeof row[key] !== "string" || !/^[0-9a-f]{64}$/.test(row[key] as string)) throw unsafe();
  }
  return Object.fromEntries(fields.map(key => [key, row[key]])) as unknown as ManagedRoutePin;
}
const same = (a: ManagedRoutePin, b: ManagedRoutePin) => fields.every(key => a[key] === b[key]);

function privateDirectory(path: string, create: boolean): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw unsafe();
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        privateDirectory(dirname(path), true);
        try { mkdirSync(path, { mode: 0o700 }); }
        catch (race) { if ((race as NodeJS.ErrnoException).code !== "EEXIST") throw race; }
      } else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw unsafe();
  // A child directory's own fsync cannot persist its link in the parent.
  // Sync even an existing directory: another process may have just created it.
  if (create) syncDirectory(dirname(path));
}
function readExisting(path: string): ManagedRoutePin | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unsafe();
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maxFileBytes) throw unsafe();
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw unsafe();
      offset += count;
    }
    try { return parsePin(JSON.parse(buffer.toString("utf8"))); } catch { throw unsafe(); }
  } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Writes a private temporary file and links it into place without overwriting; an existing identical pin is idempotent. */
function writeNew(directory: string, path: string, pin: ManagedRoutePin): void {
  const temporary = join(directory, `.pin-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      const stat = fstatSync(fd);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw unsafe();
      const body = Buffer.from(JSON.stringify(Object.fromEntries(fields.map(key => [key, pin[key]]))) + "\n");
      for (let offset = 0; offset < body.length;) offset += writeSync(fd, body, offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readExisting(path);
      if (!existing || !same(existing, pin)) throw conflict();
      syncDirectory(directory);
      return;
    }
    syncDirectory(directory);
  } finally {
    try { unlinkSync(temporary); } catch { /* the temporary is already gone */ }
  }
}

/**
 * Durable per-worker route pins. Construction does no I/O; the first `withPin` call verifies and creates the private
 * store. A pin is written once and never replaced; neither the raw key nor request content is stored.
 */
export class ManagedRoutePins {
  constructor(private readonly stateDirectory: string) {}
  /** Read-only observation: never creates a store, writes a pin or reselects a provider. */
  read(key: string): ManagedRoutePin | undefined {
    if (typeof key !== "string" || key.length < 1 || key.length > 4096 || !isAbsolute(this.stateDirectory)) throw unsafe();
    const directory = join(resolve(this.stateDirectory), "managed-route-pins");
    try { privateDirectory(resolve(this.stateDirectory), false); privateDirectory(directory, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw unsafe(); }
    return readExisting(join(directory, `${createHash("sha256").update(key).digest("hex")}.json`));
  }
  async withPin<T>(key: string, run: (pin: ManagedRoutePin | undefined, save: (pin: ManagedRoutePin) => Promise<void>) => Promise<T>): Promise<T> {
    if (typeof key !== "string" || key.length < 1 || key.length > 4096 || !isAbsolute(this.stateDirectory)) throw unsafe();
    const stateDirectory = resolve(this.stateDirectory);
    const name = createHash("sha256").update(key).digest("hex");
    return exclusive(`${stateDirectory}\0${name}`, async () => {
      const directory = join(stateDirectory, "managed-route-pins");
      try {
        privateDirectory(stateDirectory, true);
        privateDirectory(directory, true);
      } catch { throw unsafe(); }
      const path = join(directory, `${name}.json`);
      const existing = readExisting(path);
      // A concurrent linker can expose the pin before its creator's fsync.
      if (existing) syncDirectory(directory);
      return run(existing, async candidate => {
        const pin = parsePin(candidate);
        privateDirectory(directory, false);
        const stored = readExisting(path);
        if (stored) {
          if (!same(stored, pin)) throw conflict();
          syncDirectory(directory);
          return;
        }
        writeNew(directory, path, pin);
      });
    });
  }
}

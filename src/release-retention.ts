import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseLease { readonly releaseName?: string; release(): void }

type HeldRelease = { descriptor: number; references: number };
type RetentionState = { held: Map<string, HeldRelease>; entrypoints: Map<string, number> };
const retentionKey = Symbol.for("edihasaj.harness-gateway.release-retention");

function retentionState(): RetentionState {
  const global = globalThis as typeof globalThis & { [retentionKey]?: RetentionState };
  return global[retentionKey] ??= { held: new Map(), entrypoints: new Map() };
}

const noLease: ReleaseLease = { releaseName: undefined, release() {} };
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.([0-9])$/;

function safeDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && !(info.mode & 0o022);
  } catch { return false; }
}

/**
 * Resolves this compiled module only when it lives in the immutable managed-release
 * layout. Checkouts deliberately produce no lease.
 */
function managedMarker(moduleUrl: string): { marker: string; release: string } | undefined {
  try {
    const file = realpathSync(fileURLToPath(moduleUrl));
    const dist = dirname(file), packageDirectory = dirname(dist), releaseDirectory = dirname(packageDirectory);
    const releases = dirname(releaseDirectory), name = basename(releaseDirectory);
    if (!version.test(name) || basename(releases) !== "releases" || file !== resolve(dist, basename(file))) return;
    if (!safeDirectory(releases) || !safeDirectory(releaseDirectory) || !safeDirectory(packageDirectory) || !safeDirectory(dist)) return;
    const marker = resolve(releaseDirectory, ".gateway-release"), info = lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) || info.size > 80) return;
    if (readFileSync(marker, "utf8") !== `${name}\n`) return;
    return { marker, release: name };
  } catch { return; }
}

/**
 * Holds a read-only descriptor for the managed release marker. The descriptor is
 * visible to lsof, so a later installer can keep code a live app-owned Node still
 * executes through `current`. Repeated callers in one process share one descriptor.
 */
export function retainRunningRelease(moduleUrl = import.meta.url): ReleaseLease {
  const managed = managedMarker(moduleUrl);
  if (!managed) return noLease;
  const state = retentionState();
  let held = state.held.get(managed.marker);
  if (!held) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(managed.marker, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) || readFileSync(descriptor, "utf8") !== `${managed.release}\n`) throw new Error("unsafe marker");
      held = { descriptor, references: 0 }; state.held.set(managed.marker, held);
    } catch {
      if (descriptor !== undefined) closeSync(descriptor);
      return noLease;
    }
  }
  held.references++;
  let released = false;
  return {
    releaseName: managed.release,
    release() {
      if (released) return;
      released = true;
      const current = state.held.get(managed.marker);
      if (!current || --current.references > 0) return;
      state.held.delete(managed.marker);
      try { closeSync(current.descriptor); } catch {}
    },
  };
}

/**
 * The CLI is the process-lifetime owner of its source release. Holding its
 * immutable entrypoint separately lets the installer distinguish that bootstrap
 * release from markers acquired later by a hot-swapped runtime. It intentionally
 * has no release method: the operating system closes it when this process exits.
 */
export function retainCliEntryPoint(moduleUrl = import.meta.url): void {
  const managed = managedMarker(moduleUrl);
  if (!managed) return;
  // Keep the source release marker too. The ignored lease is deliberately a
  // process-lifetime reference, acquired before command dispatch.
  retainRunningRelease(moduleUrl);
  let entrypoint: string;
  try {
    entrypoint = realpathSync(fileURLToPath(moduleUrl));
    if (basename(entrypoint) !== "cli.js") return;
    const info = lstatSync(entrypoint);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022)) return;
  } catch { return; }
  const state = retentionState();
  if (state.entrypoints.has(entrypoint)) return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(entrypoint, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022)) throw new Error("unsafe entrypoint");
    state.entrypoints.set(entrypoint, descriptor);
  } catch {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    // A marker is still safer than no marker. The installer treats a `current`
    // process without this explicit immutable entrypoint as legacy and skips prune.
  }
}

import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { contained, fileDigest, readJson, safeAncestors } from "./private-fs.js";
import { updateStateFile } from "./types.js";
import { releaseNameSets } from "./names.js";

/**
 * Removes the downloaded and extracted stage of ONE successful update, `<install root>/app-update-<uuid>`.
 *
 * A stage is trusted only when every fact about it matches the update that was just installed: it is an exact child of the
 * managed installation root with the canonical name and archive name, no ancestor is a link or writable by others, it holds
 * exactly the entries the updater creates (`app/Harness Gateway.app`, `backend/harness-gateway-V-macos-arm64`, optionally
 * `activate-<uuid>/...`), every node is a plain file or directory owned by this user and writable by nobody else, and its
 * manifest agrees with the recorded update. Anything else is refused and left alone.
 *
 * Planning records a fingerprint of the whole tree (every path, kind, owner, mode, size, inode, link count and time). Removal
 * walks the tree again and deletes only when the fingerprint is identical, so a file added, edited or replaced by a link after
 * planning stops the deletion. Nothing here ever changes a permission: a directory that could not be deleted as it stands is
 * refused instead. The deletion itself never follows links. The retained rollback bundle, releases, journal, lock and state file
 * are never inside a stage, and the caller names every path that must stay, so a mistaken stage can never contain them.
 *
 * Validation is NOT proof that the update was committed. Planning only shows that this folder is the stage the recorded update
 * would have produced, that its archive bytes match the recorded digest, and that no pending record or transaction journal
 * still refers to it (a readable state file naming the stage, an unreadable one, or any journal makes it refuse). The caller
 * must already know the update is finished, and a caller that sweeps old stages must hold the update and installation locks
 * and check for running processes itself. `current`, `app-runtime` and `previous-release` are resolved, and a stage that is,
 * contains or lies inside any of them is refused.
 *
 * `planUpdateStageCleanup` and `confirmPlannedStage` only inspect. `cleanupUpdateStage` plans, confirms and removes. None throws;
 * failures are fixed words. The caller holds the update lock, which keeps the updater itself out while this runs.
 */
export type StageCleanupReason = "invalid_request" | "not_a_stage" | "protected" | "unsafe_path" | "unexpected_entry"
  | "manifest_mismatch" | "changed" | "remove_failed" | "missing";
export interface StageExpectation { version: string; source: string; backendSha256: string; backendArchive: string }
export interface StagePlan { stage: string; version: string; dev: number; ino: number; fingerprint: string; entries: number }
export type StagePlanResult = { ok: true; plan: StagePlan } | { ok: false; reason: StageCleanupReason };
export interface StageCleanupResult { removed: boolean; reason?: StageCleanupReason }
export interface StageCleanupOptions {
  /** Paths that must survive: the live app, the retained rollback bundle, anything else the caller keeps. */
  protect?: string[];
  /** The deletion itself; defaults to a recursive `rm` that never follows links. The fleet cleanup supplies a move to Trash. */
  remove?: (path: string) => Promise<void>;
}

const owner = process.getuid?.();
const maximumEntries = 200_000;
const maximumDepth = 128;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const stageName = new RegExp(`^app-update-${uuid}$`);
const activationName = new RegExp(`^activate-${uuid}$`);
const fail = (reason: StageCleanupReason): StagePlanResult => ({ ok: false, reason });

function object(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const plainVersion = (value: unknown): value is string => typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
/** Both release name sets the updater accepts (see names.ts); a stage holds one of them. */
const names = (version: string) => releaseNameSets(version).map(set => ({ archive: set.backendAsset, zip: set.appAsset, backend: set.backendRoot, app: set.app }));

/** Whether `parts` (path below the stage) is a place the updater itself puts something, and of the right kind. */
function expected(parts: string[], directory: boolean, version: string): boolean {
  return names(version).some(name => expectedIn(parts, directory, name));
}

function expectedIn(parts: string[], directory: boolean, name: ReturnType<typeof names>[number]): boolean {
  if (parts.length === 1) {
    const [first] = parts as [string];
    if (first === "app-update.json" || first === name.archive || first === name.zip) return !directory;
    return directory && (first === "app" || first === "backend" || activationName.test(first));
  }
  if (parts.length === 2) {
    const [first, second] = parts as [string, string];
    if (first === "app") return directory && (second === name.app || second === "__MACOSX");
    if (first === "backend" || activationName.test(first)) return directory && second === name.backend;
    return false;
  }
  return true;
}

/**
 * Reads the whole stage once without changing anything. Returns a fingerprint of every node, or undefined when any node is a
 * link, an odd kind, owned by someone else, writable by others, shared by a hard link, read-only for its owner, misplaced or
 * beyond the bounds.
 */
async function walkStage(stage: string, version: string): Promise<{ fingerprint: string; entries: number; top: Set<string> } | undefined> {
  const hash = createHash("sha256"); const top = new Set<string>(); let count = 0;
  const visit = async (path: string, parts: string[]): Promise<boolean> => {
    if (++count > maximumEntries || parts.length > maximumDepth) return false;
    const info = await lstat(path); const mode = Number(info.mode);
    if (info.isSymbolicLink() || info.uid !== owner || (mode & 0o022) !== 0) return false;
    const directory = info.isDirectory();
    if (!directory && (!info.isFile() || info.nlink !== 1)) return false;
    if (directory && (mode & 0o700) !== 0o700) return false;
    if (parts.length && !expected(parts, directory, version)) return false;
    if (parts.length === 1) top.add(parts[0]!);
    hash.update(`${parts.join("/")}\0${directory ? "d" : "f"}\0${info.dev}\0${info.ino}\0${mode}\0${info.size}\0${info.mtimeMs}\0${info.nlink}\0${info.uid}\n`);
    if (directory) for (const name of (await readdir(path)).sort()) if (!await visit(join(path, name), [...parts, name])) return false;
    return true;
  };
  return await visit(stage, []) ? { fingerprint: hash.digest("hex"), entries: count, top } : undefined;
}

export async function planUpdateStageCleanup(installRoot: string, pending: StageExpectation, options: Pick<StageCleanupOptions, "protect"> = {}): Promise<StagePlanResult> {
  try {
    if (owner === undefined || typeof installRoot !== "string" || !isAbsolute(installRoot) || resolve(installRoot) !== installRoot) return fail("invalid_request");
    if (!plainVersion(pending.version) || !/^[a-f0-9]{40}$/.test(pending.source) || !/^[a-f0-9]{64}$/.test(pending.backendSha256) ||
      typeof pending.backendArchive !== "string" || !isAbsolute(pending.backendArchive) || resolve(pending.backendArchive) !== pending.backendArchive) return fail("invalid_request");
    const archive = pending.backendArchive, stage = dirname(archive);
    const name = names(pending.version).find(set => basename(archive) === set.archive);
    if (!name || dirname(stage) !== installRoot || !stageName.test(basename(stage))) return fail("not_a_stage");
    const keep = [installRoot, join(installRoot, "current"), join(installRoot, "releases"), join(installRoot, "previous-release"), ...(options.protect ?? [])];
    for (const path of keep) {
      if (typeof path !== "string" || !isAbsolute(path)) return fail("invalid_request");
      const checked = resolve(path);
      if (checked === stage || contained(stage, checked) || contained(checked, stage) && checked !== installRoot) return fail("protected");
    }

    const info = await lstat(stage).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
    if (!info) return fail("missing");
    await safeAncestors(stage);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner || (Number(info.mode) & 0o077) !== 0) return fail("unsafe_path");
    const realStage = await realpath(stage);
    for (const link of ["current", "app-runtime", "previous-release"]) {
      const resolved = await realpath(join(installRoot, link)).catch(() => undefined);
      if (resolved && (resolved === realStage || contained(realStage, resolved) || contained(resolved, realStage))) return fail("protected");
    }
    if (await lstat(join(installRoot, "app-update-transaction.json")).then(() => true, error => (error as NodeJS.ErrnoException).code !== "ENOENT")) return fail("protected");
    const state = await readJson(join(installRoot, updateStateFile));
    if (state !== undefined) {
      const row = object(state); if (!row) return fail("unsafe_path");
      const held = object(row.pending);
      if (row.pending !== undefined && !held) return fail("unsafe_path");
      if (held && [held.backendArchive, held.appStage].some(item => typeof item === "string" && isAbsolute(item) && contained(stage, resolve(item)))) return fail("protected");
    }
    const walked = await walkStage(stage, pending.version);
    if (!walked || !walked.top.has("app-update.json") || !walked.top.has(name.archive)) return fail("unexpected_entry");

    // The recorded digest must describe the bytes on disk, not only the manifest that repeats it.
    if (await fileDigest(archive) !== pending.backendSha256) return fail("manifest_mismatch");
    const manifest = object(await readJson(join(stage, "app-update.json")));
    if (!manifest || manifest.schemaVersion !== 1 || manifest.version !== pending.version || manifest.source !== pending.source ||
      manifest.branch !== "production" || manifest.backendSha256 !== pending.backendSha256 || manifest.backendAsset !== name.archive ||
      manifest.appAsset !== name.zip) return fail("manifest_mismatch");
    return { ok: true, plan: { stage, version: pending.version, dev: info.dev, ino: info.ino, fingerprint: walked.fingerprint, entries: walked.entries } };
  } catch { return fail("unsafe_path"); }
}

/** True only when the stage and every ancestor are still exactly what planning approved. Inspects only. */
export async function confirmPlannedStage(plan: StagePlan): Promise<boolean> {
  try {
    await safeAncestors(plan.stage);
    const info = await lstat(plan.stage);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== plan.dev || info.ino !== plan.ino || info.uid !== owner || (Number(info.mode) & 0o077) !== 0) return false;
    const walked = await walkStage(plan.stage, plan.version);
    return !!walked && walked.fingerprint === plan.fingerprint && walked.entries === plan.entries;
  } catch { return false; }
}

async function defaultRemove(path: string): Promise<void> { await rm(path, { recursive: true, force: true }); }

/** Confirms a planned stage is unchanged, then removes it. Permissions are never modified. */
export async function removePlannedStage(plan: StagePlan, remove: (path: string) => Promise<void> = defaultRemove): Promise<StageCleanupResult> {
  if (!await confirmPlannedStage(plan)) return { removed: false, reason: "changed" };
  try { await remove(plan.stage); } catch { return { removed: false, reason: "remove_failed" }; }
  const left = await lstat(plan.stage).then(() => true, error => (error as NodeJS.ErrnoException).code !== "ENOENT");
  return left ? { removed: false, reason: "remove_failed" } : { removed: true };
}

export async function cleanupUpdateStage(installRoot: string, pending: StageExpectation, options: StageCleanupOptions = {}): Promise<StageCleanupResult> {
  try {
    const planned = await planUpdateStageCleanup(installRoot, pending, options.protect ? { protect: options.protect } : {});
    if (!planned.ok) return { removed: false, reason: planned.reason };
    return await removePlannedStage(planned.plan, options.remove);
  } catch { return { removed: false, reason: "remove_failed" }; }
}

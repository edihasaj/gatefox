import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readlink, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { claudeDesktopProfileName, claudeDesktopProfileNames, type ClaudeDesktopAdapterConfig } from "./claude-desktop-profile.js";

const maximumJsonBytes = 2 * 1024 * 1024;
const safeProfileId = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const noFollow = constants.O_NOFOLLOW ?? 0;
const currentUser = process.getuid?.();

export interface SelectedClaudeDesktopProfile {
  profilePath: string;
  profile: Record<string, unknown>;
  profileBytes: Buffer;
  profileHash: string;
}

export interface ClaudeDesktopCandidatePaths {
  desktopProfilePath: string;
  adapterConfigPath: string;
}

export interface ClaudeDesktopApplyOptions {
  library: string;
  adapterRoot: string;
  backupRoot: string;
  profile: Record<string, unknown>;
  expectedProfile: SelectedClaudeDesktopProfile;
  adapterConfig: ClaudeDesktopAdapterConfig;
  protectedPaths: string[];
  appNotRunning: () => boolean | Promise<boolean>;
  replace?: (stagedPath: string, destinationPath: string) => Promise<void>;
}

export interface ClaudeDesktopApplyResult extends ClaudeDesktopCandidatePaths {
  backupDirectory: string;
}

export interface ClaudeDesktopPaths {
  root: string;
  library: string;
  adapterRoot: string;
  backupRoot: string;
  candidateRoot: string;
}

type ProtectedHash = { path: string; digest?: string };

function fail(message: string): never { throw new Error(message); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function absentOr<T>(action: () => Promise<T>): Promise<T | undefined> {
  try { return await action(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function canonicalPath(path: string): Promise<string> {
  const result = resolve(path);
  for (const [alias, target] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]] as const) {
    if (result !== alias && !result.startsWith(`${alias}${sep}`)) continue;
    const info = await absentOr(() => lstat(alias));
    if (!info?.isSymbolicLink() || info.uid !== 0) break;
    const linkTarget = resolve(dirname(alias), await readlink(alias));
    if (linkTarget !== target) break;
    return `${target}${result.slice(alias.length)}`;
  }
  return result;
}

/** Refuses a path or an ancestor that could redirect a write through a link. */
async function checkedPath(path: string, createParent: boolean): Promise<string> {
  if (!isAbsolute(path)) fail("Claude Desktop path must be absolute");
  const result = await canonicalPath(path);
  const parts = result.split(sep).filter(Boolean);
  let current: string = sep;
  for (let index = 0; index < parts.length - 1; index++) {
    current = join(current, parts[index]!);
    const info = await absentOr(() => lstat(current));
    if (!info) {
      if (!createParent) fail("Claude Desktop path has a missing parent");
      await mkdir(current, { mode: 0o700 });
      const made = await lstat(current);
      if (!made.isDirectory() || made.isSymbolicLink()) fail("Claude Desktop path has an unsafe parent");
    } else if (!info.isDirectory() || info.isSymbolicLink()) {
      fail("Claude Desktop path has an unsafe parent");
    }
  }
  return result;
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) fail("Claude Desktop directory must be absolute");
  const root = await canonicalPath(path);
  if (root === sep) fail("Claude Desktop directory is too broad");
  const prior = await absentOr(() => lstat(root));
  const checked = await checkedPath(join(root, ".probe"), true);
  const directory = dirname(checked);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (currentUser !== undefined && info.uid !== currentUser) || (info.mode & 0o777) !== 0o700) {
    fail("Claude Desktop directory must be private and user-owned");
  }
  if (prior && (!prior.isDirectory() || prior.isSymbolicLink())) fail("Claude Desktop directory is unsafe");
  return directory;
}

async function checkedFile(path: string, createParent = false): Promise<string> {
  const checked = await checkedPath(path, createParent);
  const info = await absentOr(() => lstat(checked));
  if (info && (!info.isFile() || info.isSymbolicLink())) fail("Claude Desktop file is unsafe");
  return checked;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return parseJson(await readPlainFile(path));
}

function parseJson(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) fail("Claude Desktop JSON must be an object");
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) fail("Claude Desktop JSON is invalid");
    throw error;
  }
}

function profileHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readPlainFile(path: string): Promise<Buffer> {
  const checked = await checkedFile(path);
  const handle = await open(checked, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumJsonBytes) fail("Claude Desktop JSON file is unsafe");
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

function confined(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/** Reads only the unique active named profile in a caller-selected config library. */
export async function readSelectedClaudeDesktopProfile(library: string): Promise<SelectedClaudeDesktopProfile> {
  const libraryRoot = await ensureExistingLibrary(library);
  const meta = await readJson(join(libraryRoot, "_meta.json"));
  if (!Array.isArray(meta.entries)) fail("Claude Desktop config library _meta.json has no entries array");
  const matches = meta.entries.filter(entry => isRecord(entry) && claudeDesktopProfileNames.includes(String(entry.name)) && typeof entry.id === "string");
  if (matches.length !== 1) fail(`Expected exactly one Claude Desktop profile named ${claudeDesktopProfileName} (or Harness Gateway)`);
  const profileId = matches[0]!.id as string;
  if (meta.appliedId !== profileId) fail(`Claude Desktop appliedId must select the unique ${claudeDesktopProfileName} profile`);
  if (!safeProfileId.test(profileId)) fail(`Claude Desktop ${claudeDesktopProfileName} profile ID is not a safe filename`);
  const profilePath = resolve(libraryRoot, `${profileId}.json`);
  if (!confined(libraryRoot, profilePath)) fail(`Claude Desktop ${claudeDesktopProfileName} profile escapes its config library`);
  const profileBytes = await readPlainFile(profilePath);
  return { profilePath, profile: parseJson(profileBytes), profileBytes, profileHash: profileHash(profileBytes) };
}

async function ensureExistingLibrary(library: string): Promise<string> {
  if (!isAbsolute(library)) fail("Claude Desktop library must be absolute");
  const root = await canonicalPath(library);
  await checkedPath(join(root, ".probe"), false);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("Claude Desktop config library is unsafe");
  return root;
}

async function stageJson(path: string, value: unknown): Promise<string> {
  const checked = await checkedFile(path, true);
  let content: string;
  try { content = JSON.stringify(value, null, 2); } catch { fail("Claude Desktop JSON is not serializable"); }
  if (content === undefined) fail("Claude Desktop JSON is not serializable");
  const temporary = join(dirname(checked), `.${basename(checked)}.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try { await file.writeFile(`${content}\n`); await file.sync(); } finally { await file.close(); }
  await chmod(temporary, 0o600);
  return temporary;
}

async function discard(path: string | undefined): Promise<void> {
  if (path) await rm(path, { force: true }).catch(() => undefined);
}

async function stageBytes(path: string, bytes: Buffer, mode: number): Promise<string> {
  const checked = await checkedFile(path, true);
  const temporary = join(dirname(checked), `.${basename(checked)}.${randomUUID()}.rollback`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, mode);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await chmod(temporary, mode);
  return temporary;
}

/** Writes a private, isolated candidate pair; it never touches the selected profile. */
export async function writeClaudeDesktopCandidate(root: string, profile: Record<string, unknown>, adapterConfig: ClaudeDesktopAdapterConfig): Promise<ClaudeDesktopCandidatePaths> {
  const candidateRoot = await ensurePrivateDirectory(root);
  const desktopProfilePath = join(candidateRoot, "desktop-profile.json");
  const adapterConfigPath = join(candidateRoot, "adapter-config.json");
  const profileStage = await stageJson(desktopProfilePath, profile);
  let adapterStage: string | undefined;
  try {
    adapterStage = await stageJson(adapterConfigPath, adapterConfig);
    await rename(profileStage, desktopProfilePath);
    await rename(adapterStage, adapterConfigPath);
  } catch (error) {
    await discard(profileStage); await discard(adapterStage);
    throw error;
  }
  return { desktopProfilePath, adapterConfigPath };
}

/** Writes the candidate of a profile that needs no adapter: the gateway itself serves its model IDs. */
export async function writeClaudeDesktopDirectCandidate(root: string, profile: Record<string, unknown>): Promise<{ desktopProfilePath: string }> {
  const desktopProfilePath = join(await ensurePrivateDirectory(root), "desktop-profile.json");
  const staged = await stageJson(desktopProfilePath, profile);
  try { await rename(staged, desktopProfilePath); } catch (error) { await discard(staged); throw error; }
  return { desktopProfilePath };
}

async function protectedHashes(paths: string[]): Promise<ProtectedHash[]> {
  const unique = new Set<string>();
  const result: ProtectedHash[] = [];
  for (const path of paths) {
    const checked = await checkedFile(path);
    if (unique.has(checked)) continue;
    unique.add(checked);
    const bytes = await absentOr(() => readPlainFile(checked));
    result.push({ path: checked, digest: bytes && createHash("sha256").update(bytes).digest("hex") });
  }
  return result;
}

async function assertProtectedUnchanged(baseline: ProtectedHash[]): Promise<void> {
  const current = await protectedHashes(baseline.map(entry => entry.path));
  for (let index = 0; index < baseline.length; index++) if (baseline[index]!.digest !== current[index]!.digest) fail("Protected configuration changed unexpectedly");
}

async function assertExpectedProfile(library: string, expected: SelectedClaudeDesktopProfile): Promise<SelectedClaudeDesktopProfile> {
  if (!Buffer.isBuffer(expected.profileBytes) || profileHash(expected.profileBytes) !== expected.profileHash) {
    fail("Claude Desktop profile snapshot is invalid");
  }
  const expectedPath = await checkedFile(expected.profilePath);
  const current = await readSelectedClaudeDesktopProfile(library);
  if (current.profilePath !== expectedPath || current.profileHash !== expected.profileHash) {
    fail("Claude Desktop selected profile changed; rebuild the candidate before applying");
  }
  return current;
}

async function backupFile(destination: string, bytes: Buffer): Promise<void> {
  const staged = await stageBytes(destination, bytes, 0o600);
  try { await rename(staged, destination); }
  catch (error) { await discard(staged); throw error; }
}

/**
 * Applies both files as one recoverable transaction. The caller must determine
 * whether the app is stopped; this module deliberately does not inspect processes.
 */
export async function applyClaudeDesktopProfile(options: ClaudeDesktopApplyOptions): Promise<ClaudeDesktopApplyResult> {
  const applied = await applyProfile(options);
  return { ...applied, adapterConfigPath: applied.adapterConfigPath! };
}

export type ClaudeDesktopDirectApplyOptions = Omit<ClaudeDesktopApplyOptions, "adapterRoot" | "adapterConfig">;
/** Applies a direct profile alone, with the same backup and rollback. An adapter configuration already on disk is left as it is. */
export async function applyClaudeDesktopDirectProfile(options: ClaudeDesktopDirectApplyOptions): Promise<{ desktopProfilePath: string; backupDirectory: string }> {
  const { desktopProfilePath, backupDirectory } = await applyProfile(options);
  return { desktopProfilePath, backupDirectory };
}

async function applyProfile(options: ClaudeDesktopDirectApplyOptions & Partial<Pick<ClaudeDesktopApplyOptions, "adapterRoot" | "adapterConfig">>): Promise<{ desktopProfilePath: string; adapterConfigPath?: string; backupDirectory: string }> {
  if (!await options.appNotRunning()) fail("Quit Claude Desktop before applying its saved configuration");
  const selected = await assertExpectedProfile(options.library, options.expectedProfile);
  const withAdapter = options.adapterRoot !== undefined && options.adapterConfig !== undefined;
  const adapterConfigPath = withAdapter ? await checkedFile(join(await ensurePrivateDirectory(options.adapterRoot!), "config.json"), true) : undefined;
  const backupRoot = await ensurePrivateDirectory(options.backupRoot);
  const protectedPaths = await protectedHashes(options.protectedPaths);
  const protectedDestinations = new Set(protectedPaths.map(entry => entry.path));
  if (protectedDestinations.has(selected.profilePath) || (adapterConfigPath !== undefined && protectedDestinations.has(adapterConfigPath))) fail("Protected configuration overlaps a Claude Desktop destination");
  const profileBytes = await readPlainFile(selected.profilePath);
  const profileMode = (await lstat(selected.profilePath)).mode & 0o777;
  const adapterInfo = adapterConfigPath === undefined ? undefined : await absentOr(() => lstat(adapterConfigPath));
  const adapterBytes = adapterInfo ? await readPlainFile(adapterConfigPath!) : undefined;
  const adapterMode = adapterInfo ? adapterInfo.mode & 0o777 : 0o600;
  const backupDirectory = join(backupRoot, `claude-aliases-${new Date().toISOString().replaceAll(/[-:.]/g, "")}-${randomUUID()}`);
  await mkdir(backupDirectory, { mode: 0o700 });
  await chmod(backupDirectory, 0o700);
  try {
    await backupFile(join(backupDirectory, "desktop-profile.json"), profileBytes);
    if (adapterBytes) await backupFile(join(backupDirectory, "adapter-config.json"), adapterBytes);
  } catch (error) {
    await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  let profileStage: string | undefined;
  let adapterStage: string | undefined;
  try {
    profileStage = await stageJson(selected.profilePath, options.profile);
    if (adapterConfigPath !== undefined) adapterStage = await stageJson(adapterConfigPath, options.adapterConfig);
    await assertProtectedUnchanged(protectedPaths);
    await assertExpectedProfile(options.library, options.expectedProfile);
  } catch (error) {
    await discard(profileStage); await discard(adapterStage);
    throw error;
  }
  const replace = options.replace ?? rename;
  let profileReplaced = false;
  let adapterReplaced = false;
  try {
    await replace(profileStage, selected.profilePath); profileReplaced = true; profileStage = undefined;
    if (adapterStage !== undefined && adapterConfigPath !== undefined) { await replace(adapterStage, adapterConfigPath); adapterReplaced = true; adapterStage = undefined; }
  } catch (error) {
    await discard(profileStage); await discard(adapterStage);
    let restored = true;
    try {
      if (profileReplaced) await replace(await stageBytes(selected.profilePath, profileBytes, profileMode), selected.profilePath);
      if (adapterReplaced && adapterConfigPath !== undefined) {
        if (adapterBytes) await replace(await stageBytes(adapterConfigPath, adapterBytes, adapterMode), adapterConfigPath);
        else await rm(adapterConfigPath, { force: true });
      }
    } catch { restored = false; }
    if (!restored) fail("Could not apply the Claude Desktop alias profile and rollback was incomplete");
    throw new Error("Could not apply the Claude Desktop alias profile; previous files were restored", { cause: error });
  }
  return { desktopProfilePath: selected.profilePath, ...(adapterConfigPath === undefined ? {} : { adapterConfigPath }), backupDirectory };
}

export const readClaudeDesktopProfile = readSelectedClaudeDesktopProfile;

/** Returns the fixed Claude Desktop-owned locations beneath an explicit home. */
export function claudeDesktopPaths(home: string): ClaudeDesktopPaths {
  if (!isAbsolute(home)) fail("Claude Desktop home must be absolute");
  const root = join(resolve(home), "Library", "Application Support", "Claude-3p");
  return {
    root,
    library: join(root, "configLibrary"),
    adapterRoot: join(root, "desktop-adapter"),
    backupRoot: join(root, "setup-backups"),
    candidateRoot: join(root, "alias-trial", "candidate"),
  };
}

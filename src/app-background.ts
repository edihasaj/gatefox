import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readlink, realpath, rename, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readSnapshot, type ConfigSnapshot } from "./app-management/storage.js";
import { withLoginRegistrationLock } from "./login-registration-lock.js";
import { serviceLabel, serviceMarker } from "./service-plan.js";
import { associateAppRuntime, associateAppRuntimeTransaction, managedInstallationForCommand } from "./app-runtime.js";
import { installationAbortSignal, type InstallationGuard } from "./app-runtime-lock.js";

const appIdentifier = "com.edihasaj.harness-gateway.app";
const maximumPlistBytes = 64 * 1024;
const noFollow = constants.O_NOFOLLOW ?? 0;
const owner = process.getuid?.();

type Status = "associated" | "already_associated" | "not_installed" | "unsigned" | "pending" | "preview";
type Result = { status: Status; changed: boolean; appliesAt: "next_service_start"; wouldChange?: boolean };
export type AppBackgroundResponse = { ok: true; result: Result } | { ok: false; error: { code: string; message: string } };
type Plist = Record<string, unknown>;

export interface AppBackgroundDependencies {
  readSnapshot?: (path: string) => Promise<ConfigSnapshot | undefined>;
  decodePlist?: (bytes: Buffer) => Promise<Plist>;
  encodePlist?: (value: Plist) => Promise<Buffer>;
  verifySignature?: (app: string, helper: string) => Promise<boolean>;
  registerApp?: (app: string) => Promise<void>;
  beforeReplace?: () => Promise<void>;
  /** Runs after an owned plist receipt exists, before its post-publication validation. */
  afterReplace?: () => Promise<void>;
  associateRuntime?: typeof associateAppRuntime;
}

export type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
interface Source { bytes: Buffer; mode: number; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface Validated { source: Source; plist: Plist; needsChange: boolean }
interface PublishedPlist { path: string; source: Source; output: Source }

function failure(code: string, message: string): AppBackgroundResponse { return { ok: false, error: { code, message } }; }
function result(status: Status, changed = false, wouldChange?: boolean): AppBackgroundResponse { return { ok: true, result: { status, changed, appliesAt: "next_service_start", ...(wouldChange === undefined ? {} : { wouldChange }) } }; }
function plain(value: unknown): value is Plist { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }

/** The fixed bundle layout is the only source of an app identity; argv is untrusted input. */
export function bundledAppPath(moduleURL = import.meta.url): string | undefined {
  if (!moduleURL.startsWith("file:")) return undefined;
  const path = fileURLToPath(moduleURL);
  const suffix = "/Contents/Resources/management/dist/app-background.js";
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : undefined;
}

export function parseAppBackgroundArgs(args: string[]): { configPath: string; apply: boolean } | undefined {
  if (args.length < 2 || args.length > 3 || args[0] !== "--config" || !isAbsolute(args[1]!) || extname(args[1]!) !== ".json") return undefined;
  if (args.length === 3 && args[2] !== "--apply") return undefined;
  return { configPath: resolve(args[1]!), apply: args[2] === "--apply" };
}

export interface AncestryInfo { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number | bigint }
export interface PathInspector { lstat(path: string): Promise<AncestryInfo>; readlink(path: string): Promise<string> }
const filesystemInspector: PathInspector = { lstat, readlink };

function safeDirectory(info: AncestryInfo): boolean {
  const mode = Number(info.mode); return info.isDirectory() && !info.isSymbolicLink() && (info.uid === owner || info.uid === 0) && (!(mode & 0o022) || (info.uid === 0 && !!(mode & 0o1000)));
}
/** Normalizes only macOS's verified standard aliases; ordinary Linux directories stay literal. */
export async function canonicalPath(path: string, inspector: PathInspector = filesystemInspector): Promise<string> {
  if (!isAbsolute(path)) throw new Error("unsafe");
  let checked = resolve(path);
  for (const [alias, target] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]] as const) {
    if (checked !== alias && !checked.startsWith(`${alias}${sep}`)) continue;
    const info = await inspector.lstat(alias).catch(() => { throw new Error("unsafe"); });
    if (!info.isSymbolicLink()) continue;
    if (info.uid !== 0 || resolve("/", await inspector.readlink(alias)) !== target) throw new Error("unsafe");
    checked = `${target}${checked.slice(alias.length)}`; break;
  }
  return checked;
}
/** App resources may live below standard root:admin /Applications; user-owned state never uses this exception. */
export function appResourceAncestorAllowed(path: string, info: AncestryInfo): boolean {
  return path === "/Applications" && info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && (Number(info.mode) & 0o777) === 0o775 || safeDirectory(info);
}
async function safeAncestry(path: string): Promise<void> {
  const checked = await canonicalPath(path);
  const parts = checked.split(sep).filter(Boolean); let current: string = sep;
  for (const part of parts) {
    current = join(current, part); const info = await lstat(current).catch(() => { throw new Error("unsafe"); });
    if (!safeDirectory(info)) throw new Error("unsafe");
  }
}
async function appResourceAncestry(path: string): Promise<void> {
  const checked = await canonicalPath(path); const parts = checked.split(sep).filter(Boolean); let current: string = sep;
  for (const part of parts) {
    current = join(current, part); const info = await lstat(current).catch(() => { throw new Error("unsafe"); });
    if (!appResourceAncestorAllowed(current, info)) throw new Error("unsafe");
  }
}
/** Creates every missing directory one level at a time, checking every ancestor before its first write. */
async function ensureDirectory(path: string, privateTarget: boolean): Promise<void> {
  const checked = await canonicalPath(path); const parts = checked.split(sep).filter(Boolean); let current: string = sep;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!); let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try { info = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("unsafe");
      try { await mkdir(current, { mode: 0o700 }); } catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("unsafe"); }
      info = await lstat(current).catch(() => { throw new Error("unsafe"); });
    }
    if (!safeDirectory(info) || (index === parts.length - 1 && (info.uid !== owner || privateTarget && !!(Number(info.mode) & 0o077)))) throw new Error("unsafe");
  }
}
async function readOwnedFile(path: string, limit = maximumPlistBytes): Promise<Source | undefined> {
  await safeAncestry(resolve(path, ".."));
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path, constants.O_RDONLY | noFollow); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("unsafe"); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== owner || (info.mode & 0o022) || info.size > limit || info.nlink !== 1) throw new Error("unsafe");
    const bytes = await file.readFile(); if (bytes.length !== info.size) throw new Error("unsafe");
    return { bytes, mode: info.mode & 0o777, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  } finally { await file.close(); }
}
function sameSource(left: Source, right: Source): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.bytes.equals(right.bytes);
}
function samePublication(left: Source, right: Source): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.bytes.equals(right.bytes);
}

async function plutil(input: Buffer, convert: "json" | "xml1"): Promise<Buffer> {
  if (input.length > maximumPlistBytes) throw new Error("plist");
  return new Promise((resolveResult, reject) => {
    const child = spawn("/usr/bin/plutil", ["-convert", convert, "-o", "-", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    const output: Buffer[] = []; let size = 0; let settled = false; let killTimer: NodeJS.Timeout | undefined;
    const fail = () => { if (!settled) { settled = true; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 250); reject(new Error("plist")); } };
    const timer = setTimeout(fail, 5000);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maximumPlistBytes) fail(); else output.push(chunk); });
    child.once("error", fail); child.once("close", code => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (!settled) { settled = true; code === 0 ? resolveResult(Buffer.concat(output)) : reject(new Error("plist")); } });
    child.stdin.once("error", fail); child.stdin.end(input);
  });
}
async function decodePlist(bytes: Buffer): Promise<Plist> {
  const parsed: unknown = JSON.parse((await plutil(bytes, "json")).toString("utf8")); if (!plain(parsed)) throw new Error("plist"); return parsed;
}
async function encodePlist(value: Plist): Promise<Buffer> { return plutil(Buffer.from(JSON.stringify(value)), "xml1"); }
export async function runBoundedCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); let size = 0; let timedOut = false; let killTimer: NodeJS.Timeout | undefined; const out: Buffer[] = []; const err: Buffer[] = [];
    const stop = () => { timedOut = true; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 250); };
    const timer = setTimeout(stop, 5000); const add = (into: Buffer[]) => (chunk: Buffer) => { size += chunk.length; if (size > maximumPlistBytes) stop(); else into.push(chunk); };
    child.stdout.on("data", add(out)); child.stderr.on("data", add(err)); child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); resolveResult({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code: timedOut ? 1 : code ?? 1 }); });
  });
}
export async function verifySignature(app: string, helper: string, run: CommandRunner = runBoundedCommand): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const developerID = "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
    if ((await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${developerID} and identifier "${appIdentifier}"`, app])).code !== 0) return false;
    const appInfo = await run("/usr/bin/codesign", ["-d", "--verbose=4", app]);
    const team = (text: string) => text.match(/(?:^|\n)TeamIdentifier=([^\r\n]+)/)?.[1];
    const appTeam = team(appInfo.stderr); if (appInfo.code !== 0 || !appTeam || !/^[A-Z0-9]{10}$/.test(appTeam)) return false;
    for (const [path, identifier] of [
      [helper, "com.edihasaj.harness-gateway.service"],
      [join(app, "Contents/Resources/backend/runtime/bin/node"), "com.edihasaj.harness-gateway.node"],
    ] as const) {
      if ((await run("/usr/bin/codesign", ["--verify", "--strict",
        `-R=${developerID} and certificate leaf[subject.OU] = "${appTeam}" and identifier "${identifier}"`, path])).code !== 0) return false;
    }
    return true;
  } catch { return false; }
}
async function trustedLauncher(path: string): Promise<boolean> {
  try { await managedInstallationForCommand(path); return true; } catch { return false; }
}
async function readBundleInfo(path: string, decode: (bytes: Buffer) => Promise<Plist>): Promise<Plist> {
  await appResourceAncestry(resolve(path, ".."));
  const file = await open(path, constants.O_RDONLY | noFollow).catch(() => { throw new Error("unsafe"); });
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > maximumPlistBytes || (info.mode & 0o022)) throw new Error("unsafe");
    return await decode(await file.readFile());
  } finally { await file.close(); }
}
function plistIsAssociated(plist: Plist, helper: string): boolean {
  return plist.Program === helper && plist.AssociatedBundleIdentifiers === appIdentifier;
}
async function validate(source: Source, configPath: string, helper: string, decode: (bytes: Buffer) => Promise<Plist>): Promise<Validated> {
  if (!source.bytes.toString("utf8").includes(serviceMarker)) throw new Error("unsafe");
  const plist = await decode(source.bytes); const args = plist.ProgramArguments;
  if (plist.Label !== serviceLabel || !Array.isArray(args) || args.some(arg => typeof arg !== "string") || args[1] !== "daemon" && args[1] !== "serve") throw new Error("unsafe");
  const commandPath = args[0]; if (typeof commandPath !== "string" || !await trustedLauncher(commandPath)) throw new Error("unsafe");
  const positions = args.flatMap((arg, index) => arg === "--config" ? [index] : []);
  if (positions.length !== 1 || args[positions[0]! + 1] !== configPath) throw new Error("unsafe");
  if (plist.Program !== undefined && plist.Program !== commandPath && plist.Program !== helper) throw new Error("unsafe");
  const associated = plist.AssociatedBundleIdentifiers;
  const emptyAssociated = associated === undefined || associated === "" || Array.isArray(associated) && associated.length === 0;
  if (!emptyAssociated && associated !== appIdentifier && !(Array.isArray(associated) && associated.length === 1 && associated[0] === appIdentifier)) throw new Error("unsafe");
  return { source, plist, needsChange: !plistIsAssociated(plist, helper) };
}
function marked(bytes: Buffer): Buffer {
  const text = bytes.toString("utf8"); const index = text.indexOf("<plist"); if (index < 0 || text.includes(serviceMarker)) throw new Error("plist");
  return Buffer.from(`${text.slice(0, index)}${serviceMarker}\n${text.slice(index)}`);
}
async function replace(path: string, source: Source, plist: Plist, state: string, encode: (value: Plist) => Promise<Buffer>, beforeReplace: (() => Promise<void>) | undefined, guard: InstallationGuard): Promise<PublishedPlist> {
  const backups = join(state, "service-backups"); await ensureDirectory(backups, true);
  const backup = join(backups, `app-background-${randomUUID()}.plist`); const stagedBackup = join(backups, `.${randomUUID()}.app-background`);
  const original = await open(stagedBackup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    guard.check(); await original.writeFile(source.bytes); guard.check(); await original.sync(); guard.check(); await chmod(stagedBackup, 0o600); guard.check(); await link(stagedBackup, backup); guard.check();
    const directory = await open(backups, constants.O_RDONLY); try { await directory.sync(); guard.check(); } finally { await directory.close(); }
  }
  finally { await original.close(); await unlink(stagedBackup).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  const output = marked(await encode(plist)); if (output.length > maximumPlistBytes) throw new Error("plist");
  const temporary = join(resolve(path, ".."), `.${randomUUID()}.app-background`); const target = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, source.mode);
  try {
    guard.check(); await target.writeFile(output); guard.check(); await target.sync(); guard.check(); await chmod(temporary, source.mode); guard.check(); await beforeReplace?.(); guard.check();
    const current = await readOwnedFile(path); if (!current || !sameSource(source, current)) throw new Error("changed");
    const info = await target.stat();
    const published: Source = { bytes: output, mode: info.mode & 0o777, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    await target.close(); await rename(temporary, path);
    return { path, source, output: published };
  }
  finally { await target.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
async function restorePlist(publication: PublishedPlist): Promise<boolean> {
  const current = await readOwnedFile(publication.path).catch(() => undefined);
  if (!current || !samePublication(publication.output, current)) return false;
  const temporary = join(resolve(publication.path, ".."), `.${randomUUID()}.app-background-undo`);
  const target = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, publication.source.mode).catch(() => undefined);
  if (!target) return false;
  let restored = false;
  try {
    await target.writeFile(publication.source.bytes); await target.sync(); await chmod(temporary, publication.source.mode);
    const final = await readOwnedFile(publication.path);
    if (final && samePublication(publication.output, final)) { await target.close(); await rename(temporary, publication.path); restored = true; }
  } catch { /* A concurrent LaunchAgent writer wins. */ }
  finally { await target.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  return restored;
}

/** Core handler intentionally accepts only explicit dependencies so fixture tests cannot reach real signing or plist tools. */
export async function handleAppBackground(options: { configPath: string; apply: boolean; appPath: string }, dependencies: AppBackgroundDependencies = {}): Promise<AppBackgroundResponse> {
  try {
    if (!isAbsolute(options.configPath) || !isAbsolute(options.appPath)) return failure("invalid_request", "The background attribution request is invalid.");
    const snapshot = await (dependencies.readSnapshot || readSnapshot)(options.configPath); if (!snapshot) return failure("invalid_configuration", "The gateway configuration is invalid.");
    const home = process.env.HOME; if (!home || !isAbsolute(home)) return failure("unsafe_installation", "The installed gateway service is not safe to update.");
    const plistPath = join(home, "Library", "LaunchAgents", `${serviceLabel}.plist`); const first = await readOwnedFile(plistPath);
    if (!first) return result("not_installed");
    const decode = dependencies.decodePlist || decodePlist; const encode = dependencies.encodePlist || encodePlist; const helper = join(options.appPath, "Contents", "MacOS", "GatewayService");
    const initial = await validate(first, resolve(options.configPath), helper, decode);
    await appResourceAncestry(join(options.appPath, "Contents", "MacOS"));
    const info = await readBundleInfo(join(options.appPath, "Contents", "Info.plist"), decode);
    if (info.CFBundleIdentifier !== appIdentifier || !(await (dependencies.verifySignature || verifySignature)(options.appPath, helper))) return result("unsigned");
    if (!options.apply) {
      const runtimeChange = await (dependencies.associateRuntime || associateAppRuntime)({
        home, appPath: options.appPath, stateDirectory: snapshot.config.stateDirectory,
        commandPath: (initial.plist.ProgramArguments as string[])[0]!, apply: false,
      });
      return result("preview", false, initial.needsChange || runtimeChange);
    }
    await ensureDirectory(snapshot.config.stateDirectory, false);
    return await withLoginRegistrationLock(snapshot.config.stateDirectory, async () => {
      if (await lstat(join(snapshot.config.stateDirectory, "service-login-pending.json")).then(() => true).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? false : true)) return result("pending");
      const currentSnapshot = await (dependencies.readSnapshot || readSnapshot)(options.configPath);
      if (!currentSnapshot || currentSnapshot.revision !== snapshot.revision || currentSnapshot.config.stateDirectory !== snapshot.config.stateDirectory) return failure("configuration_changed", "The gateway configuration changed; refresh and try again.");
      const current = await readOwnedFile(plistPath); if (!current) return result("not_installed");
      const confirmed = await validate(current, resolve(options.configPath), helper, decode);
      await (dependencies.registerApp || (async app => {
        if ((await runBoundedCommand("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app])).code !== 0) throw new Error("register");
      }))(options.appPath);
      const runtimeOptions = { home, appPath: options.appPath, stateDirectory: snapshot.config.stateDirectory,
        commandPath: (confirmed.plist.ProgramArguments as string[])[0]! };
      const publishPlist = async (guard: InstallationGuard) => {
        if (!confirmed.needsChange) return;
        const next: Plist = { ...confirmed.plist, Program: helper, AssociatedBundleIdentifiers: appIdentifier };
        let publication: PublishedPlist | undefined;
        try {
          publication = await replace(plistPath, confirmed.source, next, snapshot.config.stateDirectory, encode, dependencies.beforeReplace, guard);
          await dependencies.afterReplace?.(); guard.check();
          const written = await readOwnedFile(plistPath); guard.check();
          if (!written || !plistIsAssociated((await validate(written, resolve(options.configPath), helper, decode)).plist, helper)) throw new Error("changed");
        } catch (error) {
          if (publication && !await restorePlist(publication)) throw Object.assign(error as Error, { preserveRuntimeDependencies: true });
          throw error;
        }
      };
      const runtimeChanged = dependencies.associateRuntime
        ? await dependencies.associateRuntime(runtimeOptions)
        : await associateAppRuntimeTransaction(runtimeOptions, publishPlist);
      if (dependencies.associateRuntime) await publishPlist({ check: () => undefined });
      return confirmed.needsChange || runtimeChanged ? result("associated", true) : result("already_associated");
    });
  } catch (error) {
    if (installationAbortSignal(error)) throw error;
    const code = (error as { code?: unknown })?.code;
    if (code === "invalid_configuration") return failure("invalid_configuration", "The gateway configuration is invalid.");
    if (code === "configuration_changed" || (error as Error).message === "changed") return failure("configuration_changed", "The gateway configuration changed; refresh and try again.");
    return failure("unsafe_installation", "The installed gateway service is not safe to update.");
  }
}

async function main(): Promise<void> {
  const parsed = parseAppBackgroundArgs(process.argv.slice(2)); const appPath = bundledAppPath();
  let response: AppBackgroundResponse;
  try { response = parsed && appPath ? await handleAppBackground({ ...parsed, appPath }) : failure("invalid_request", "The background attribution request is invalid."); }
  catch (error) {
    const signal = installationAbortSignal(error);
    if (signal) { process.exitCode = signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143; return; }
    response = failure("operation_failed", "The background attribution did not complete.");
  }
  const output = JSON.stringify(response); process.stdout.write(output.length <= 8192 ? output : JSON.stringify(failure("operation_failed", "The background attribution did not complete.")));
}

const invokedFile = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) await main();

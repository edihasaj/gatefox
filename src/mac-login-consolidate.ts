import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { open, lstat, stat, mkdir, rename, readdir, access, link, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { gatewayCommand } from "./command.js";
import { collectServicePlan } from "./mac-consolidate.js";
import { servicePlist } from "./mac-service.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { readServicePlan, serviceLabel, servicePlanPath, validateServicePlan, type ServicePlan } from "./service-plan.js";
import { bootIdentity, ownerAlive, ownerStamp, type OwnerRecord } from "./boot-identity.js";
import { telemetry } from "./telemetry.js";

const exec = promisify(execFile);
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const unique = () => randomBytes(8).toString("hex");
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export const pendingLoginConsolidationPath = (state: string) => resolve(state, "service-login-pending.json");
/**
 * Written when the daemon rolls an interrupted staging back, before the staging record is archived; it keeps every relaunch
 * of that daemon idle in the same boot and names the restored jobs each relaunch loads again when they are not loaded.
 */
export const recoveredLoginConsolidationPath = (state: string) => resolve(state, "service-login-recovered.json");
/** A check that answered no. Only a refusal rolls an interrupted staging back; a check that could not run (launchctl, the disk) is retried. */
class LoginRefusal extends Error {}
const refuse = (message: string) => new LoginRefusal(message);
interface Source { label: string; digest: string; mode: number }
export interface PendingLoginConsolidation {
  version: 1; phase: "preparing" | "ready"; config: string; plan: ServicePlan;
  primaryLabel: string; primaryPlistDigest: string; removedLabels: string[]; backup: string; sources: Source[];
  /** The staging process, so a marker it left behind can be told apart from a staging still under way. Absent before 0.4.4. */
  stager?: OwnerRecord;
}
interface JobStatus { loaded: boolean; pid?: number }
interface Plist { Label?: string; Program?: string; ProgramArguments?: string[] }
type Collected = Awaited<ReturnType<typeof collectServicePlan>>;
export interface LoginConsolidationDependencies {
  /** `trash` is private retirement quarantine; discard alone invokes macOS Trash. */
  directory: string; trash: string; label: string; command: { command: string; args: string[] };
  collect: (config: string, directory: string) => Promise<Collected>;
  status: (label: string) => Promise<JobStatus>; listLabels: () => Promise<string[]>;
  disabled: (label: string) => Promise<boolean>; inspect: (path: string) => Promise<Plist>;
  move: typeof rename; discard: (path: string) => Promise<void>;
  /** `launchctl bootstrap` of a restored login job, so it runs in this session. */
  bootstrap: (path: string) => Promise<void>;
}
const owns = (label: string, primary: string) => label === primary || ["desktop", "native", "macbook-pro-2"].some(suffix => label === primary + "." + suffix) || new RegExp("^" + primary.replace(/\./g, "\\.") + "\\.tunnel\\.[a-z][a-z0-9-]{0,63}$").test(label);
function dependencies(state: string, overrides: Partial<LoginConsolidationDependencies>): LoginConsolidationDependencies {
  const domain = `gui/${process.getuid!()}`;
  return {
    directory: resolve(homedir(), "Library/LaunchAgents"), trash: resolve(state, "service-login-retired"), label: serviceLabel,
    command: gatewayCommand(), collect: collectServicePlan, move: rename,
    discard: async path => { await exec("/usr/bin/trash", ["-s", path], { timeout: 10000 }); },
    status: async label => {
      try {
        const { stdout } = await exec("/bin/launchctl", ["print", `${domain}/${label}`], { timeout: 5000 });
        return { loaded: true, pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
      } catch (error) {
        if (/Could not find (?:specified )?service/.test(String((error as { stderr?: string }).stderr))) return { loaded: false };
        throw new Error("Cannot verify gateway launchd ownership");
      }
    },
    listLabels: async () => (await exec("/bin/launchctl", ["list"], { timeout: 5000 })).stdout.split("\n").map(line => line.trim().split(/\s+/).at(-1) || ""),
    disabled: async label => {
      const { stdout } = await exec("/bin/launchctl", ["print-disabled", domain], { timeout: 5000 });
      return stdout.split("\n").some(line => line.includes(`"${label}"`) && /=>\s*(?:true|disabled)\b/.test(line));
    },
    inspect: async path => JSON.parse((await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", path])).stdout) as Plist,
    bootstrap: async path => { await exec("/bin/launchctl", ["bootstrap", domain, path], { timeout: 10000 }); },
    ...overrides,
  };
}
async function directory(path: string, create = true): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022)) throw new Error("Gateway login directories must be owned and not writable by others");
  if (create) { const parent = await open(dirname(path), "r"); try { await parent.sync(); } finally { await parent.close(); } }
}
async function bytes(path: string, privateFile = false): Promise<{ data: Buffer; mode: number } | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Cannot safely read gateway login file"); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & (privateFile ? 0o077 : 0o022)) || info.size > 131072) throw new Error("Gateway login files must be regular owned files with safe permissions");
    return { data: await file.readFile(), mode: info.mode & 0o777 };
  } finally { await file.close(); }
}
async function atomic(path: string, data: Uint8Array | string, mode = 0o600, exclusive = false): Promise<void> {
  const temporary = path + "." + unique() + ".tmp"; const file = await open(temporary, "wx", mode);
  try { await file.chmod(mode); await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  try { if (exclusive) await link(temporary, path); else await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  const parent = await open(dirname(path), "r"); try { await parent.sync(); } finally { await parent.close(); }
}
async function savePending(state: string, pending: PendingLoginConsolidation): Promise<void> {
  if (Buffer.byteLength(encoded(pending)) > 131072 || Buffer.byteLength(encoded(pending.plan)) > 65536) throw new Error("Gateway login consolidation plan is too large to load safely");
  await atomic(pendingLoginConsolidationPath(state), encoded(pending));
}
/** A staging record from before 0.4.4 has no stager; a present one must name a pid and, at most, its boot and start. */
function validStager(value: unknown): boolean {
  if (value === undefined) return true;
  const stager = value as Partial<OwnerRecord> | null;
  return !!stager && typeof stager === "object" && Number.isSafeInteger(stager.pid) && stager.pid! >= 1 &&
    (stager.bootId === undefined || typeof stager.bootId === "string" && stager.bootId.length <= 128) &&
    (stager.startedAtMs === undefined || Number.isSafeInteger(stager.startedAtMs) && stager.startedAtMs! >= 0);
}
export async function readPendingLoginConsolidation(stateDirectory: string): Promise<PendingLoginConsolidation | undefined> {
  const file = await bytes(pendingLoginConsolidationPath(stateDirectory), true); if (!file) return undefined;
  const value = JSON.parse(file.data.toString("utf8")) as PendingLoginConsolidation;
  const hash = (text: unknown) => typeof text === "string" && /^[a-f0-9]{64}$/.test(text);
  if (value.version !== 1 || !["preparing", "ready"].includes(value.phase) || typeof value.config !== "string" || !isAbsolute(value.config) || typeof value.primaryLabel !== "string" || !/^com\.edihasaj\.subscription-gateway(?:\.[a-zA-Z0-9-]+)*$/.test(value.primaryLabel) || !hash(value.primaryPlistDigest) || typeof value.backup !== "string" || dirname(value.backup) !== resolve(stateDirectory, "service-backups") || !Array.isArray(value.sources) || !value.sources.length || value.sources.some(source => !owns(source.label, value.primaryLabel) || !hash(source.digest) || !Number.isInteger(source.mode) || source.mode < 0 || source.mode > 0o777 || (source.mode & 0o022)) || new Set(value.sources.map(source => source.label)).size !== value.sources.length || !Array.isArray(value.removedLabels) || JSON.stringify(value.removedLabels) !== JSON.stringify(value.sources.filter(source => source.label !== value.primaryLabel).map(source => source.label))) throw new Error("Invalid pending gateway login consolidation");
  if (!validStager(value.stager)) throw new Error("Invalid pending gateway login consolidation");
  value.plan = validateServicePlan(value.plan);
  if (Buffer.byteLength(encoded(value.plan)) > 65536) throw new Error("Pending gateway login service plan is too large");
  if (resolve(value.plan.config) !== resolve(value.config)) throw new Error("Pending gateway login configuration does not match its plan");
  return value;
}
async function locked<T>(state: string, deps: LoginConsolidationDependencies, action: () => Promise<T>): Promise<T> {
  await directory(state); await directory(deps.directory); await directory(deps.trash);
  if ((await lstat(deps.trash)).mode & 0o077) throw new Error("Gateway login retirement quarantine must be private");
  return withPrivateFileLock(resolve(state, "service-login"), action);
}
async function noDuplicates(deps: LoginConsolidationDependencies): Promise<void> {
  const labels = [...(await readdir(deps.directory)).map(name => name.endsWith(".plist") ? name.slice(0, -6) : ""), ...await deps.listLabels()];
  if (labels.some(label => label !== deps.label && owns(label, deps.label))) throw refuse("Separate gateway login jobs still exist; leave the running service unchanged");
}
async function verifyPending(pending: PendingLoginConsolidation, config: string, deps: LoginConsolidationDependencies): Promise<void> {
  if (pending.config !== config || pending.primaryLabel !== deps.label) throw refuse("Pending gateway login consolidation belongs to another installation");
  const primary = await bytes(resolve(deps.directory, deps.label + ".plist"));
  if (!primary || digest(primary.data) !== pending.primaryPlistDigest) throw refuse("The staged gateway LaunchAgent changed; refusing to replace it");
  for (const label of pending.removedLabels) if (await bytes(resolve(deps.directory, label + ".plist"))) throw refuse("A retired gateway LaunchAgent was recreated; refusing consolidation");
  for (const name of await readdir(deps.directory)) if (name.endsWith(".plist") && name !== deps.label + ".plist" && owns(name.slice(0, -6), deps.label)) throw refuse("Another gateway LaunchAgent appeared after staging");
  for (const label of await deps.listLabels()) if (label !== deps.label && owns(label, deps.label) && !pending.removedLabels.includes(label)) throw refuse("Another gateway login job loaded after staging");
}
/** Every check a staged consolidation passes before this process promotes it; returns the plan already published, if any. */
async function promotable(pending: PendingLoginConsolidation, config: string, state: string, deps: LoginConsolidationDependencies): Promise<ServicePlan | undefined> {
  await verifyPending(pending, config, deps);
  const primary = await deps.status(deps.label);
  // Both of these only say "not yet" (a manual start, or an old job still unloading at login), so they are plain errors: the
  // next launchd start tries again, and a fully staged consolidation is never rolled back for timing.
  if (!primary.loaded || primary.pid !== process.pid) throw new Error("Pending gateway login consolidation activates only in its primary launchd process");
  for (const label of pending.removedLabels) if ((await deps.status(label)).loaded) throw new Error("An earlier gateway login job remains loaded; consolidation waits for the next login");
  await noDuplicates(deps);
  const existing = await readServicePlan(state);
  if (existing && JSON.stringify(existing) !== JSON.stringify(pending.plan)) throw refuse("A different unified gateway service plan already exists");
  return existing;
}
async function promote(pending: PendingLoginConsolidation, state: string, existing: ServicePlan | undefined): Promise<ServicePlan> {
  if (!existing) await atomic(servicePlanPath(state), encoded(pending.plan), 0o600, true);
  await directory(dirname(pending.backup), false); await directory(pending.backup, false);
  await rename(pendingLoginConsolidationPath(state), resolve(pending.backup, "login-activated." + unique() + ".json"));
  await unlink(recoveredLoginConsolidationPath(state)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  return pending.plan;
}
/**
 * After a rollback, loads each restored job other than the primary one now, so tunnels, the relay and desktop setup run
 * this session instead of at the next login. The primary job cannot be loaded: this daemon holds its label. A job that
 * is already loaded is left alone, and a job that fails to load is counted, never thrown.
 */
async function startRestored(labels: string[], deps: LoginConsolidationDependencies): Promise<{ started: number; failed: number }> {
  let started = 0; let failed = 0;
  for (const label of labels) {
    if (label === deps.label || !owns(label, deps.label)) continue;
    try { if (!(await deps.status(label)).loaded) { await deps.bootstrap(resolve(deps.directory, label + ".plist")); started++; } }
    catch { failed++; }
  }
  return { started, failed };
}
/**
 * The jobs a rollback this boot restored, when one left the daemon with nothing to run; undefined when none did. A record
 * without a boot (none could be read) counts. A record from before 0.4.4 names no jobs.
 */
async function recoveredThisBoot(state: string): Promise<{ removedLabels: string[] } | undefined> {
  const file = await bytes(recoveredLoginConsolidationPath(state), true).catch(() => undefined); if (!file) return;
  let record: { version?: unknown; bootId?: unknown; removedLabels?: unknown } | undefined;
  try { record = JSON.parse(file.data.toString("utf8")) as typeof record; } catch { return; }
  if (record?.version !== 1) return;
  const removedLabels = Array.isArray(record.removedLabels) ? record.removedLabels.filter((label): label is string => typeof label === "string") : [];
  if (typeof record.bootId !== "string") return { removedLabels };
  const boot = await bootIdentity().catch(() => undefined);
  return !boot?.id || boot.id === record.bootId ? { removedLabels } : undefined;
}
/**
 * What the daemon runs when nothing is pending: the published plan, or nothing at all while a rollback this boot stands.
 * Given the dependencies (under the login lock), a relaunch after that rollback also loads each restored job that is not
 * loaded yet, so a daemon that stopped between its rollback and those loads finishes them.
 */
async function settled(state: string, deps?: LoginConsolidationDependencies): Promise<{ plan?: ServicePlan; restored: boolean }> {
  const plan = await readServicePlan(state); if (plan) return { plan, restored: false };
  const recovered = await recoveredThisBoot(state); if (!recovered) return { plan, restored: false };
  if (deps) await startRestored(recovered.removedLabels, deps);
  return { plan, restored: true };
}
async function retire(path: string, destination: string, expected: string, deps: LoginConsolidationDependencies, rollback = false): Promise<void> {
  await deps.move(path, destination);
  try {
    const moved = await bytes(destination);
    if (!moved || digest(moved.data) !== expected) throw new Error("Gateway login file changed during retirement");
  } catch (error) {
    // Exclusive restoration preserves a replacement inserted after the move.
    await link(destination, path); await unlink(destination); throw error;
  }
  try {
    await deps.discard(destination);
    if (await bytes(destination)) throw new Error("macOS did not move the retired gateway login file to Trash");
  } catch (error) { if (!rollback) throw error; }
}
async function restore(pending: PendingLoginConsolidation, deps: LoginConsolidationDependencies): Promise<void> {
  await directory(dirname(pending.backup), false); await directory(pending.backup, false);
  for (const source of pending.sources) {
    const backup = await bytes(resolve(pending.backup, source.label + ".plist"), true);
    if (!backup || digest(backup.data) !== source.digest) throw new Error("Gateway login backup changed; originals were not overwritten");
    const target = resolve(deps.directory, source.label + ".plist"); const current = await bytes(target);
    if (current && digest(current.data) !== source.digest && !(source.label === deps.label && digest(current.data) === pending.primaryPlistDigest)) throw new Error("Gateway login files changed during rollback; saved originals remain in the private backup");
    if (!current || digest(current.data) !== source.digest) {
      if (current) await retire(target, resolve(deps.trash, `${source.label}.rollback.${unique()}.plist`), pending.primaryPlistDigest, deps, true);
      await atomic(target, backup.data, source.mode, true);
    }
  }
  if (!pending.sources.some(source => source.label === deps.label)) {
    const target = resolve(deps.directory, deps.label + ".plist"); const current = await bytes(target);
    if (current && digest(current.data) !== pending.primaryPlistDigest) throw new Error("Gateway primary LaunchAgent changed during rollback");
    if (current) await retire(target, resolve(deps.trash, `${deps.label}.rollback.${unique()}.plist`), pending.primaryPlistDigest, deps, true);
  }
}
function summary(pending: PendingLoginConsolidation): Record<string, unknown> {
  return { service: pending.primaryLabel, staged: true, activates: "next-login", activeChatsPreserved: true, jobsAfter: 1, backup: pending.backup, components: pending.plan.components.map(({ id, kind }) => ({ id, kind })) };
}
export async function stageLoginConsolidation(configPath: string, overrides: Partial<LoginConsolidationDependencies> = {}): Promise<Record<string, unknown>> {
  const config = resolve(configPath); const { stateDirectory: state } = await loadConfig(config); const deps = dependencies(state, overrides);
  return locked(state, deps, async () => {
    const existing = await readServicePlan(state);
    if (existing) { if (existing.config !== config) throw new Error("The unified gateway service belongs to another configuration"); await noDuplicates(deps); if (await readPendingLoginConsolidation(state)) throw new Error("Gateway login promotion needs recovery before another staging"); return { service: deps.label, staged: false, alreadyConsolidated: true }; }
    let previous = await readPendingLoginConsolidation(state);
    if (previous) {
      if (previous.config !== config || previous.primaryLabel !== deps.label) throw new Error("Pending gateway login consolidation belongs to another installation");
      if (previous.phase === "ready") { await verifyPending(previous, config, deps); return summary(previous); }
      await restore(previous, deps); await rename(pendingLoginConsolidationPath(state), resolve(previous.backup, "login-recovered." + unique() + ".json")); previous = undefined;
    }
    if (deps.command.args.length || !isAbsolute(deps.command.command)) throw new Error("Login consolidation requires the installed gateway command");
    if (await deps.disabled(deps.label)) throw new Error("The primary gateway login job is disabled; enable its login registration before staging");
    const { plan, jobs } = await deps.collect(config, deps.directory); validateServicePlan(plan);
    if (plan.config !== config || !jobs.length) throw new Error("Gateway login plan belongs to another configuration");
    for (const label of await deps.listLabels()) if (owns(label, deps.label) && !jobs.some(job => job.label === label)) throw new Error("A loaded gateway login job has no owned plist; leave it unchanged");
    const primaryPath = resolve(deps.directory, deps.label + ".plist");
    if (!jobs.some(job => job.label === deps.label) && await bytes(primaryPath)) throw new Error("An unmanaged primary gateway LaunchAgent already exists");
    const sources: Source[] = [];
    for (const job of jobs) {
      if (!owns(job.label, deps.label) || job.path !== resolve(deps.directory, job.label + ".plist")) throw new Error("Refusing an unknown gateway login path");
      const original = await bytes(job.path); const plist = await deps.inspect(job.path); const args = plist.ProgramArguments;
      if (!original || original.data.toString("utf8") !== job.text || plist.Label !== job.label || plist.Program !== undefined || !Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("Gateway login registration changed or has unexpected ownership");
      const legacy = job.label === deps.label + ".macbook-pro-2" && args[0] === "/usr/bin/ssh" && args.at(-1) === "macbook-pro-2" && args.includes("127.0.0.1:3459:127.0.0.1:3457") && args.includes("-R");
      if (!job.text.includes("<!-- Managed by subscription-gateway") && !legacy) throw new Error("Refusing an unmanaged gateway login registration");
      if (await deps.disabled(job.label)) throw new Error("A gateway login component is disabled; leave its registration unchanged");
      if (job.kind !== "tunnel") {
        const flag = job.kind === "native" ? "--gateway-config" : "--config"; const positions = args.flatMap((arg, index) => arg === flag ? [index] : []);
        if (positions.length !== 1 || args[positions[0] + 1] !== config) throw new Error("Gateway login configuration arguments are ambiguous");
        if (job.kind === "inference" && args[1] !== "serve" || job.kind === "native" && (basename(args[0]) !== "gateway-native-relay" || args.filter(arg => arg === "--daemon").length !== 1) || job.kind === "desktop" && !(args[1] === "desktop-restore" || args[1] === "desktop" && args[2] === "register")) throw new Error("Unexpected gateway login responsibility");
        if (job.kind === "native") for (const nativeFlag of ["--native-home", "--relay-home", "--codex", "--gateway", "--gateway-config"]) {
          const positions = args.flatMap((arg, index) => arg === nativeFlag ? [index] : []);
          if (positions.length !== 1 || typeof args[positions[0] + 1] !== "string" || !isAbsolute(args[positions[0] + 1])) throw new Error("Gateway native login paths are missing or ambiguous");
        }
        if (job.kind === "native" && args.some(arg => arg === "--check" || arg === "--enable")) throw new Error("Native setup and check modes cannot run as a login relay");
        if (job.kind === "desktop") {
          const positions = args.flatMap((arg, index) => arg === "--app" ? [index] : []);
          if (positions.length > 1 || positions.length === 1 && !isAbsolute(args[positions[0] + 1] || "")) throw new Error("Gateway desktop application paths are ambiguous");
        }
      } else if (args[0] !== "/usr/bin/ssh") throw new Error("Unexpected gateway tunnel command");
      sources.push({ label: job.label, digest: digest(original.data), mode: original.mode });
    }
    for (const command of new Set([deps.command.command, ...plan.components.map(component => component.command)])) {
      try { await access(command, constants.X_OK); if (!(await stat(command)).isFile()) throw new Error("Not an executable file"); } catch { throw new Error("A required gateway login executable is unavailable; existing jobs were left unchanged"); }
    }
    await directory(resolve(state, "service-backups"));
    const backup = resolve(state, "service-backups", "login-" + unique()); await directory(backup);
    for (const job of jobs) {
      const original = await bytes(job.path); if (!original || digest(original.data) !== sources.find(source => source.label === job.label)!.digest) throw new Error("Gateway login job changed before staging");
      await atomic(resolve(backup, job.label + ".plist"), original.data);
    }
    const paths = [...new Set([resolve(homedir(), ".local/bin"), ...(process.env.PATH || "/usr/bin:/bin").split(":").filter(path => path.startsWith("/"))])].join(":");
    const future = servicePlist("", "", config, resolve(state, "service.log"), paths, deps.command.command, "daemon").replace(`<string>${serviceLabel}</string>`, `<string>${deps.label}</string>`);
    const pending: PendingLoginConsolidation = { version: 1, phase: "preparing", config, plan, primaryLabel: deps.label, primaryPlistDigest: digest(future), removedLabels: sources.filter(source => source.label !== deps.label).map(source => source.label), backup, sources,
      stager: { pid: process.pid, ...await ownerStamp() } };
    try {
      await savePending(state, pending);
      for (const source of sources) {
        const target = resolve(deps.directory, source.label + ".plist"); const current = await bytes(target);
        if (!current || digest(current.data) !== source.digest) throw new Error("Gateway login job changed during staging");
        if (source.label !== deps.label) await retire(target, resolve(deps.trash, `${source.label}.${unique()}.plist`), source.digest, deps);
      }
      const primary = await bytes(primaryPath); const originalPrimary = sources.find(source => source.label === deps.label);
      if (originalPrimary ? !primary || digest(primary.data) !== originalPrimary.digest : !!primary) throw new Error("Gateway primary LaunchAgent changed during staging");
      if (originalPrimary) await retire(primaryPath, resolve(deps.trash, `${deps.label}.previous.${unique()}.plist`), originalPrimary.digest, deps);
      await atomic(primaryPath, future, 0o600, true); pending.phase = "ready"; await savePending(state, pending); return summary(pending);
    } catch (error) {
      await restore(pending, deps); if (await bytes(pendingLoginConsolidationPath(state), true)) await rename(pendingLoginConsolidationPath(state), resolve(backup, "login-rolled-back." + unique() + ".json")); throw error;
    }
  });
}
export async function activatePendingLoginConsolidation(configPath: string, overrides: Partial<LoginConsolidationDependencies> = {}): Promise<ServicePlan | undefined> {
  return (await activateLoginConsolidation(configPath, overrides)).plan;
}
/**
 * Promotes a staged next-login consolidation, and returns the plan the service runs. Staging holds the login lock from its
 * first write to its own rollback, so a `preparing` record seen under that lock was left by a staging process that is gone
 * (a crash, a reboot, a failed rollback); one whose process is still alive keeps the old refusal (a record from before
 * 0.4.4 names none). This daemon starts only from the staged LaunchAgent, so such a staging reached its last file write and
 * missed only its `ready` mark: it is finished and promoted like a `ready` one after the same checks. A check that only says
 * "not yet" (this is not the primary launchd process, or an old job is still loaded) fails this start, and the next one tries
 * again. Only a check that refuses rolls it back instead: each original is put back when its backup still has the digest
 * recorded at staging, the rollback mark is written, the record is kept in the backup as `login-recovered.*.json`, every
 * restored job but the primary one is loaded at once, and `restored` keeps this daemon, and each relaunch of it in this boot,
 * idle; each relaunch also loads a restored job that is not loaded yet.
 */
export async function activateLoginConsolidation(configPath: string, overrides: Partial<LoginConsolidationDependencies> = {}): Promise<{ plan?: ServicePlan; restored: boolean }> {
  const config = resolve(configPath); const { stateDirectory: state } = await loadConfig(config);
  if (!await readPendingLoginConsolidation(state)) { const now = await settled(state); if (!now.restored) return now; }
  const deps = dependencies(state, overrides);
  return locked(state, deps, async () => {
    const pending = await readPendingLoginConsolidation(state); if (!pending) return settled(state, deps);
    if (pending.phase !== "ready") {
      if (pending.config !== config || pending.primaryLabel !== deps.label) throw new Error("Pending gateway login consolidation belongs to another installation");
      const marker = await lstat(pendingLoginConsolidationPath(state));
      if (pending.stager && await ownerAlive(pending.stager, marker.mtimeMs)) throw new Error("Gateway login consolidation did not finish staging; repeat staging to recover its saved originals");
      try {
        const plan = await promote(pending, state, await promotable(pending, config, state, deps));
        telemetry("login_consolidation_completed", { jobs: pending.sources.length });
        return { plan, restored: false };
      } catch (error) { if (!(error instanceof LoginRefusal)) throw error; }
      await restore(pending, deps);
      await directory(dirname(pending.backup), false); await directory(pending.backup, false);
      // The mark goes before the record is archived: a relaunch after a crash between the two rolls back again (restore
      // leaves files that already match alone), and one after the archive finds the mark, never neither.
      const boot = await bootIdentity().catch(() => undefined);
      await atomic(recoveredLoginConsolidationPath(state), encoded({ version: 1, ...(boot?.id ? { bootId: boot.id } : {}), removedLabels: pending.removedLabels }));
      await rename(pendingLoginConsolidationPath(state), resolve(pending.backup, "login-recovered." + unique() + ".json"));
      const { started, failed } = await startRestored(pending.removedLabels, deps);
      telemetry("login_consolidation_restored", { jobs: pending.sources.length, started, failed });
      return { plan: await readServicePlan(state), restored: true };
    }
    return { plan: await promote(pending, state, await promotable(pending, config, state, deps)), restored: false };
  });
}

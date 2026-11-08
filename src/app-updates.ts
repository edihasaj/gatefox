import { constants } from "node:fs";
import { readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readSnapshot, type ConfigSnapshot } from "./app-management/storage.js";
import { managedAppServiceBinding } from "./app-background.js";
import { managedInstallationForCommand, type ManagedInstallation } from "./app-runtime.js";
import { readServicePlan, type ServicePlan } from "./service-plan.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { extractArchive, verifyChecksummedTree } from "./app-updates/archive.js";
import { cleanupUpdateStage } from "./app-updates/cleanup.js";
import { pruneRetained } from "./app-updates/retention.js";
import { githubDownload, githubReleases, runCommand } from "./app-updates/github.js";
import { beginInstallationTransaction, committedInstallationTransaction, finalizeCommittedInstallationTransaction, finalizeRecoveredCommittedInstallationTransaction, recoverInstallationTransaction, resumeInstallationTransaction, runCanonicalInstall, swapAndCommitInstallationTransaction, type TransactionCommand } from "./app-updates/transaction.js";
import { contained, fileDigest, newer, privateDirectory, readAppResourceJson, readJson, readProtectedJson, safeName, safeVersion, versionNumber, writePrivate } from "./app-updates/private-fs.js";
import { updateLockName, updateStateFile, type AppUpdateResponse, type Command, type Release, type ReleaseAsset, type UpdateManifest, type UpdatePolicy, type UpdateRequest, type UpdateResult, type UpdateState } from "./app-updates/types.js";

const maximumAsset = 1_500 * 1024 * 1024;
const appIdentifier = "com.edihasaj.harness-gateway.app";
const fixedServiceIdentifier = "com.edihasaj.harness-gateway.service";
const fixedNodeIdentifier = "com.edihasaj.harness-gateway.node";
const fixedUpdaterIdentifier = "com.edihasaj.harness-gateway.updater";
const trustedTeam = "T8J48M4QVY";
const unknown = "Updates are unavailable for this installation.";

export interface AppUpdateDependencies {
  readSnapshot?: (path: string) => Promise<ConfigSnapshot | undefined>;
  installation?: (command: string) => Promise<ManagedInstallation>;
  releases?: () => Promise<Release[]>;
  download?: (asset: ReleaseAsset, destination: string, signal?: AbortSignal) => Promise<void>;
  command?: Command;
  verifyApp?: (app: string, expectedTeam?: string) => Promise<string>;
  appRunning?: (app: string) => Promise<boolean>;
  appPath?: () => Promise<string | undefined>;
  servicePlan?: (state: string) => Promise<ServicePlan | undefined>;
  serviceBinding?: (configPath: string, appPath: string, expectedCommand: string) => Promise<boolean>;
  /** Deletes the finished download stage after a committed update; tests substitute it. */
  removeStage?: (path: string) => Promise<void>; pruneRetained?: false;
  signal?: AbortSignal;
}
interface Context { snapshot: ConfigSnapshot; installation: ManagedInstallation; app: string; version: string; installedVersion?: string; production: boolean; team: string; statePath: string; state: UpdateState }
interface Receipt { appVersion: string; backendVersion: string; source: string; sourceBranch: "production"; sourceModified: false; production: true; backendSha256: string }

function failure(code: string, message: string): AppUpdateResponse { return { ok: false, error: { code, message } }; }
function success(result: UpdateResult): AppUpdateResponse { return { ok: true, result }; }
function message(code: string): string {
  return code === "auth_required" ? "Sign in to GitHub once to receive private updates." : unknown;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function version(value: unknown): string | undefined { return safeVersion(value) ? value.replace(/^v/, "") : undefined; }
function releaseVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^app-v[0-9]+\.[0-9]+\.[0-9]+$/.test(value) ? value.slice(5) : undefined;
}
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function source(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{40}$/.test(value); }
function state(value: unknown): UpdateState {
  const row = object(value);
  if (!row || row.schemaVersion !== 1 || typeof row.automatic !== "boolean") return { schemaVersion: 1, automatic: false };
  const pending = object(row.pending);
  return { schemaVersion: 1, automatic: row.automatic,
    ...(typeof row.lastChecked === "string" && !Number.isNaN(Date.parse(row.lastChecked)) ? { lastChecked: row.lastChecked } : {}),
    ...(version(row.latestVersion) ? { latestVersion: version(row.latestVersion)! } : {}),
    ...(pending && version(pending.version) && source(pending.source) && hash(pending.backendSha256) &&
      typeof pending.appStage === "string" && isAbsolute(pending.appStage) && typeof pending.backendArchive === "string" &&
      isAbsolute(pending.backendArchive) && typeof pending.requestedAt === "string"
      ? { pending: { version: version(pending.version)!, source: pending.source, backendSha256: pending.backendSha256, appStage: pending.appStage, backendArchive: pending.backendArchive, requestedAt: pending.requestedAt } } : {}) };
}
function parseManifest(value: unknown): UpdateManifest | undefined {
  const row = object(value); const item = row && version(row.version);
  if (!row || row.schemaVersion !== 1 || !item || !source(row.source) || row.branch !== "production" ||
    !safeName(String(row.appAsset)) || !safeName(String(row.backendAsset)) || !hash(row.appSha256) || !hash(row.backendSha256)) return;
  const appAsset = `Harness-Gateway-${item}-macos-arm64.zip`, backendAsset = `harness-gateway-${item}-macos-arm64.tar.gz`;
  if (row.appAsset !== appAsset || row.backendAsset !== backendAsset) return;
  return { schemaVersion: 1, version: item, source: row.source, branch: "production", appAsset, appSha256: row.appSha256, backendAsset, backendSha256: row.backendSha256 };
}
function receipt(value: unknown): Receipt | undefined {
  const row = object(value); const appVersion = row && version(row.appVersion);
  if (!row || !appVersion || row.backendVersion !== appVersion || !source(row.source) || row.sourceBranch !== "production" ||
    row.sourceModified !== false || row.production !== true || !hash(row.backendSha256)) return;
  return { appVersion, backendVersion: appVersion, source: row.source, sourceBranch: "production", sourceModified: false, production: true, backendSha256: row.backendSha256 };
}
function recordedAppVersion(value: unknown): string | undefined {
  const row = object(value); return row && version(row.appVersion);
}
function policy(value: unknown): UpdatePolicy | undefined {
  const row = object(value); const item = row && version(row.version);
  if (!row || !item || row.schemaVersion !== 1 || !source(row.source) || row.branch !== "production" || !safeName(String(row.backendAsset)) || !hash(row.backendSha256)) return;
  return { schemaVersion: 1, version: item, source: row.source, branch: "production", backendAsset: row.backendAsset as string, backendSha256: row.backendSha256 as string };
}

async function defaultAppPath(installation: ManagedInstallation): Promise<string | undefined> {
  const target = await realpath(join(installation.root, "app-runtime")).catch(() => undefined);
  const suffix = "/Contents/Resources/backend/runtime";
  return target?.endsWith(suffix) ? target.slice(0, -suffix.length) : undefined;
}
async function defaultVerifyApp(app: string, expectedTeam = trustedTeam, candidate = true): Promise<string> {
  if (process.platform !== "darwin") throw new Error("not signed");
  const requirement = `anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier "${appIdentifier}"`;
  const verified = await runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${requirement}`, app], { timeoutMs: 30_000 });
  const details = await runCommand("/usr/bin/codesign", ["-d", "--verbose=4", app], { timeoutMs: 30_000 });
  const team = details.stderr.match(/(?:^|\n)TeamIdentifier=([A-Z0-9]{10})/)?.[1];
  if (verified.code !== 0 || details.code !== 0 || team !== expectedTeam) throw new Error("not signed");
  for (const [path, identifier] of [[join(app, "Contents/MacOS/GatewayService"), fixedServiceIdentifier],
    ...(candidate ? [[join(app, "Contents/MacOS/GatewayUpdateInstaller"), fixedUpdaterIdentifier]] : []),
    [join(app, "Contents/Resources/backend/runtime/bin/node"), fixedNodeIdentifier]]) {
    const result = await runCommand("/usr/bin/codesign", ["--verify", "--strict",
      `-R=anchor apple generic and certificate leaf[subject.OU] = "${team}" and identifier "${identifier}"`, path], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error("not signed");
  }
  const gatekeeper = await runCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app], { timeoutMs: 30_000 });
  if (gatekeeper.code !== 0 || !/source=Notarized Developer ID/.test(`${gatekeeper.stdout}\n${gatekeeper.stderr}`)) throw new Error("not notarized");
  return team;
}
async function defaultAppRunning(_app: string): Promise<boolean> {
  const result = await runCommand("/usr/bin/pgrep", ["-x", "GatewayApp"], { timeoutMs: 2000, stdoutLimit: 4096 });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error("app activity is unavailable");
}
function transactionCommand(command: Command): TransactionCommand {
  return async (program, args, signal) => {
    const result = await command(program, args, { timeoutMs: program === "/bin/sh" ? 180_000 : 30_000, signal });
    if (result.code !== 0) throw new Error("transaction command failed");
  };
}
async function verifyIncomingApp(deps: AppUpdateDependencies, path: string, team: string): Promise<void> {
  if (deps.verifyApp) await deps.verifyApp(path, team); else await defaultVerifyApp(path, team, true);
}
async function verifyRetainedApp(deps: AppUpdateDependencies, path: string, team: string): Promise<void> {
  if (deps.verifyApp) await deps.verifyApp(path, team); else await defaultVerifyApp(path, team, false);
}
async function reconcileWithoutPending(ctx: Context, deps: AppUpdateDependencies): Promise<boolean> {
  const command = transactionCommand(deps.command || runCommand);
  const outcome = await recoverInstallationTransaction({ installation: ctx.installation, app: ctx.app, team: ctx.team, command, signal: deps.signal,
    verifyIncoming: target => verifyIncomingApp(deps, target, ctx.team),
    verifyRetained: target => verifyRetainedApp(deps, target, ctx.team) });
  if (outcome === "committed") return finalizeRecoveredCommittedInstallationTransaction({ installation: ctx.installation, app: ctx.app, team: ctx.team });
  return outcome !== "none";
}
async function acquire(root: string): Promise<() => Promise<void>> {
  let unblock: (() => void) | undefined; let granted!: () => void; let refused!: (error: unknown) => void;
  const ready = new Promise<void>((resolveResult, reject) => { granted = resolveResult; refused = reject; });
  const held = withPrivateFileLock(join(root, updateLockName), async () => {
    granted(); await new Promise<void>(resolveResult => { unblock = resolveResult; });
  }, 5000);
  void held.catch(refused);
  await ready;
  return async () => { unblock?.(); await held; };
}
async function context(request: UpdateRequest, dependencies: AppUpdateDependencies): Promise<Context> {
  const snapshot = await (dependencies.readSnapshot || readSnapshot)(request.configPath);
  if (!snapshot) throw Object.assign(new Error("config"), { code: "invalid_configuration" });
  const plan = await (dependencies.servicePlan || readServicePlan)(snapshot.config.stateDirectory);
  if (!plan || resolve(plan.config) !== resolve(request.configPath)) throw new Error("unsafe");
  const home = process.env.HOME; if (!home || !isAbsolute(home)) throw new Error("unsafe");
  const command = join(resolve(home), ".local", "bin", "harness-gateway");
  const installation = await (dependencies.installation || managedInstallationForCommand)(command);
  const app = await (dependencies.appPath ? dependencies.appPath() : defaultAppPath(installation));
  if (!app || !isAbsolute(app) || !app.endsWith(".app")) throw new Error("unsafe");
  if (!await (dependencies.serviceBinding || managedAppServiceBinding)(request.configPath, app, installation.commandPath)) throw new Error("unsafe");
  const team = dependencies.verifyApp ? await dependencies.verifyApp(app, trustedTeam) : await defaultVerifyApp(app, trustedTeam, false);
  const data = await readAppResourceJson(join(app, "Contents/Resources/app-build.json"), 64 * 1024);
  const current = receipt(data);
  // Old signed apps may not have production receipts. They can bootstrap only after
  // their fixed identity is verified; automatic checks remain disabled.
  const currentVersion = current?.appVersion ?? recordedAppVersion(data) ?? "Current app";
  const currentRelease = await realpath(join(installation.root, "current")).catch(() => undefined);
  const installedVersion = currentRelease ? version(object(await readProtectedJson(join(currentRelease, "package", "release.json")))?.version) : undefined;
  const statePath = join(installation.root, updateStateFile);
  const stored = state(await readJson(statePath));
  // A signed production receipt is sufficient to default automatic checks on.
  // Bootstrap receipts and unsigned/development apps cannot reach this point.
  if (current && stored.automatic === false && !(await readJson(statePath))) stored.automatic = true;
  return { snapshot, installation, app, version: currentVersion, installedVersion, production: !!current, team, statePath, state: stored };
}
async function refreshState(ctx: Context): Promise<void> {
  const raw = await readJson(ctx.statePath);
  const next = state(raw);
  if (ctx.production && raw === undefined) next.automatic = true;
  ctx.state = next;
}
function output(ctx: Context, values: Partial<UpdateResult>): UpdateResult {
  return { automatic: ctx.state.automatic, currentVersion: ctx.version, available: false, phase: "idle", message: "GateFox is up to date.",
    ...(ctx.state.lastChecked ? { lastChecked: ctx.state.lastChecked } : {}), ...values };
}
function releaseFor(releases: Release[]): Release | undefined {
  return releases.filter(release => !release.draft && !release.prerelease && releaseVersion(release.tag_name))
    .sort((left, right) => {
      const a = versionNumber(releaseVersion(left.tag_name)!), b = versionNumber(releaseVersion(right.tag_name)!);
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
    })[0];
}
function asset(release: Release, name: string): ReleaseAsset | undefined {
  const matches = release.assets.filter(item => item.name === name && item.size > 0 && item.size <= maximumAsset);
  return matches.length === 1 ? matches[0] : undefined;
}

export async function handleAppUpdate(request: unknown, dependencies: AppUpdateDependencies = {}): Promise<AppUpdateResponse> {
  // The published updater is a notarized Apple-silicon app feature. Unit tests
  // provide explicit seams; an ordinary CLI invocation elsewhere makes no writes.
  if (process.platform !== "darwin" && !Object.keys(dependencies).length) return failure("unsupported_platform", unknown);
  const value = object(request);
  if (!value || !["status", "check", "install", "preferences"].includes(String(value.operation)) ||
    typeof value.configPath !== "string" || !isAbsolute(value.configPath) || !value.configPath.endsWith(".json") ||
    value.automatic !== undefined && typeof value.automatic !== "boolean") return failure("invalid_request", "The update request is invalid.");
  const parsed = value as unknown as UpdateRequest;
  let ctx: Context; let release: (() => Promise<void>) | undefined;
  try {
    ctx = await context(parsed, dependencies); release = await acquire(ctx.installation.root);
    await refreshState(ctx);
    if (!ctx.state.pending) await reconcileWithoutPending(ctx, dependencies);
    if (parsed.operation === "preferences") {
      if (parsed.automatic === undefined) return failure("invalid_request", "The update request is invalid.");
      // Automatic network checks require a production receipt, not merely a signed
      // bootstrap app. A manual check can reveal the upgrade needed to reach it.
      if (parsed.automatic && !ctx.production) return failure("unsafe_installation", unknown);
      ctx.state.automatic = parsed.automatic; await writePrivate(ctx.statePath, ctx.state);
      return success(output(ctx, { phase: "preferences_saved", message: "Update preferences saved." }));
    }
    if (parsed.operation === "status") return success(output(ctx, ctx.state.pending
      ? { latestVersion: ctx.state.pending.version, available: true, phase: "waiting_for_app_exit", message: "Update staged. Close GateFox to finish installing it." }
      : ctx.state.latestVersion && ctx.version !== "Current app" && newer(ctx.state.latestVersion, ctx.version)
        ? { latestVersion: ctx.state.latestVersion, available: true, phase: "available", message: "A newer update is available." } : {}));
    if (parsed.operation === "install" && ctx.state.pending) return success(output(ctx, {
      latestVersion: ctx.state.pending.version, available: true, phase: "waiting_for_app_exit", message: "Update staged. Close GateFox to finish installing it.",
    }));
    const releases = await (dependencies.releases || githubReleases)();
    const candidate = releaseFor(releases); const latest = candidate && releaseVersion(candidate.tag_name);
    ctx.state.lastChecked = new Date().toISOString(); if (latest) ctx.state.latestVersion = latest; await writePrivate(ctx.statePath, ctx.state);
    if (!candidate || !latest || ctx.version !== "Current app" && !newer(latest, ctx.version) ||
      ctx.installedVersion !== undefined && newer(ctx.installedVersion, latest)) {
      return success(output(ctx, { latestVersion: latest, phase: "checked", lastChecked: ctx.state.lastChecked }));
    }
    if (parsed.operation === "check") return success(output(ctx, { latestVersion: latest, available: true, phase: "available", message: "A newer update is available.", lastChecked: ctx.state.lastChecked }));
    return await install(ctx, candidate, latest, dependencies);
  } catch (error) {
    const code = (error as { code?: string }).code;
    return failure(code === "auth_required" ? "auth_required" : code === "busy" ? "busy" : code === "invalid_configuration" ? "invalid_configuration" : "unsafe_installation", message(code || ""));
  } finally { await release?.(); }
}

async function install(ctx: Context, release: Release, latest: string, deps: AppUpdateDependencies): Promise<AppUpdateResponse> {
  const command = deps.command || runCommand;
  const manifestAsset = asset(release, "app-update.json");
  if (!manifestAsset || release.tag_name !== `app-v${latest}`) throw new Error("manifest");
  const stage = join(ctx.installation.root, `app-update-${randomUUID()}`); await privateDirectory(stage);
  let appStage: string | undefined; let recorded = false;
  try {
    const fetch = deps.download || ((asset: ReleaseAsset, destination: string, signal?: AbortSignal) => githubDownload(asset, destination, command, signal));
    const manifestFile = join(stage, "app-update.json"); await fetch(manifestAsset, manifestFile, deps.signal);
    const manifest = parseManifest(await readJson(manifestFile)); if (!manifest || manifest.version !== latest) throw new Error("manifest");
    const appAsset = asset(release, manifest.appAsset), backendAsset = asset(release, manifest.backendAsset);
    if (!appAsset || !backendAsset) throw new Error("asset");
    const appArchive = join(stage, manifest.appAsset), backendArchive = join(stage, manifest.backendAsset);
    await fetch(appAsset, appArchive, deps.signal); await fetch(backendAsset, backendArchive, deps.signal);
    if (await fileDigest(appArchive) !== manifest.appSha256 || await fileDigest(backendArchive) !== manifest.backendSha256) throw new Error("digest");
    const extractedApp = await extractArchive("zip", appArchive, join(stage, "app"), "Harness Gateway.app", command);
    const appReceipt = receipt(await readAppResourceJson(join(extractedApp, "Contents/Resources/app-build.json")));
    const appPolicy = policy(await readAppResourceJson(join(extractedApp, "Contents/Resources/update-policy.json")));
    if (!appReceipt || !appPolicy || appReceipt.appVersion !== manifest.version || appReceipt.source !== manifest.source ||
      appReceipt.backendSha256 !== manifest.backendSha256 || JSON.stringify(appPolicy) !== JSON.stringify({ schemaVersion: 1, version: manifest.version, source: manifest.source, branch: "production", backendAsset: manifest.backendAsset, backendSha256: manifest.backendSha256 })) throw new Error("policy");
    if (deps.verifyApp) await deps.verifyApp(extractedApp, ctx.team); else await defaultVerifyApp(extractedApp, ctx.team, true);
    const backendRoot = await extractArchive("tar", backendArchive, join(stage, "backend"), `harness-gateway-${manifest.version}-macos-arm64`, command);
    await verifyChecksummedTree(backendRoot);
    const backendReceipt = object(await readProtectedJson(join(backendRoot, "package/release.json")));
    if (!backendReceipt || version(backendReceipt.version) !== manifest.version || backendReceipt.source !== manifest.source) throw new Error("backend");
    appStage = join(dirname(ctx.app), `.Harness-Gateway-Update-${randomUUID()}.app`);
    await rename(extractedApp, appStage);
    ctx.state.pending = { version: manifest.version, source: manifest.source, backendSha256: manifest.backendSha256,
      appStage, backendArchive, requestedAt: new Date().toISOString() }; ctx.state.latestVersion = manifest.version;
    await writePrivate(ctx.statePath, ctx.state); recorded = true;
    return success(output(ctx, { latestVersion: manifest.version, available: true, phase: "waiting_for_app_exit", message: "Update staged. Close GateFox to finish installing it.", lastChecked: ctx.state.lastChecked }));
  } catch (error) {
    if (appStage && !recorded) await rm(appStage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally { if (!recorded) await rm(stage, { recursive: true, force: true }).catch(() => undefined); }
}

/**
 * Removes only the download and extraction stage of an update that is already installed and acknowledged. It runs after the
 * pending record and journal are finalized, never throws, and never changes the result: a refused or failed cleanup leaves the
 * folder for a later sweep. Old releases and generations are pruned here too, under the same promise. The live app and the retained rollback bundle are named as protected.
 */
async function discardUpdateStage(ctx: Context, pending: NonNullable<UpdateState["pending"]>, deps: AppUpdateDependencies): Promise<void> {
  try {
    await cleanupUpdateStage(ctx.installation.root, pending, { protect: [ctx.app, pending.appStage], ...(deps.removeStage ? { remove: deps.removeStage } : {}) });
    if (deps.pruneRetained !== false) await pruneRetained({ installRoot: ctx.installation.root, stateDirectory: ctx.snapshot.config.stateDirectory, ...(deps.removeStage ? { remove: deps.removeStage } : {}) });
  } catch { /* The installation is complete whatever happens here. */ }
}

/** Called by the service scheduler after the app has exited. It never kills an app or service. */
export async function installPending(ctx: Context, deps: AppUpdateDependencies = {}): Promise<AppUpdateResponse> {
  const pending = ctx.state.pending; if (!pending || !contained(dirname(ctx.app), pending.appStage) || !pending.appStage.endsWith(".app") ||
    !contained(ctx.installation.root, pending.backendArchive)) throw new Error("pending");
  if (await (deps.appRunning || defaultAppRunning)(ctx.app)) return success(output(ctx, { latestVersion: pending.version, available: true, phase: "waiting_for_app_exit", message: "Update staged. Close GateFox to finish installing it." }));
  if (deps.signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
  const command = deps.command || runCommand;
  const invoke = transactionCommand(command);
  const recovered = await recoverInstallationTransaction({ installation: ctx.installation, app: ctx.app, team: ctx.team, pending,
    command: invoke, signal: deps.signal,
    verifyIncoming: target => verifyIncomingApp(deps, target, ctx.team),
    verifyRetained: target => verifyRetainedApp(deps, target, ctx.team) });
  if (recovered === "committed") {
    delete ctx.state.pending; await writePrivate(ctx.statePath, ctx.state);
    await finalizeCommittedInstallationTransaction(await committedInstallationTransaction({
      installation: ctx.installation, app: ctx.app, version: pending.version, team: ctx.team,
    }));
    await discardUpdateStage(ctx, pending, deps);
    return success(output(ctx, { latestVersion: pending.version, phase: "installed", message: "Update installed. Reopen GateFox to use it." }));
  }
  if (recovered === "rolled_back") {
    delete ctx.state.pending; await writePrivate(ctx.statePath, ctx.state);
    return success(output(ctx, { latestVersion: pending.version, available: true, phase: "available", message: "The staged update was recovered. Check again to stage it." }));
  }
  const liveApp = recordedAppVersion(await readAppResourceJson(join(ctx.app, "Contents/Resources/app-build.json")));
  if (liveApp && newer(liveApp, pending.version) || ctx.installedVersion && newer(ctx.installedVersion, pending.version)) throw new Error("pending downgrade");
  // Revalidate the staged candidate at the moment it becomes executable. The
  // transaction layer then installs the CLI and swaps the app as one unit.
  await verifyIncomingApp(deps, pending.appStage, ctx.team);
  const currentReceipt = receipt(await readAppResourceJson(join(pending.appStage, "Contents/Resources/app-build.json")));
  const currentPolicy = policy(await readAppResourceJson(join(pending.appStage, "Contents/Resources/update-policy.json")));
  if (!currentReceipt || !currentPolicy || currentReceipt.appVersion !== pending.version || currentReceipt.source !== pending.source ||
    currentReceipt.backendSha256 !== pending.backendSha256 || currentPolicy.version !== pending.version ||
    currentPolicy.source !== pending.source || currentPolicy.backendSha256 !== pending.backendSha256) throw new Error("pending");
  if (await fileDigest(pending.backendArchive) !== pending.backendSha256) throw new Error("pending");
  const activation = join(dirname(pending.backendArchive), `activate-${randomUUID()}`);
  const backend = await extractArchive("tar", pending.backendArchive, activation, `harness-gateway-${pending.version}-macos-arm64`, command);
  try {
    await verifyChecksummedTree(backend);
    const backendReceipt = object(await readProtectedJson(join(backend, "package/release.json")));
    if (!backendReceipt || version(backendReceipt.version) !== pending.version || backendReceipt.source !== pending.source) throw new Error("pending");
    let tx;
    if (recovered === "resume_pending") tx = await resumeInstallationTransaction({ installation: ctx.installation, app: ctx.app, version: pending.version, team: ctx.team });
    else {
      tx = await beginInstallationTransaction({ installation: ctx.installation, app: ctx.app, version: pending.version, team: ctx.team });
      await runCanonicalInstall(tx, { installer: async ({ command: run, signal, nonce }) =>
        run("/bin/sh", [join(backend, "install"), "--prefix", ctx.installation.prefix, "--update-transaction", nonce], signal), command: invoke, signal: deps.signal });
    }
    await swapAndCommitInstallationTransaction(tx, { helper: join(pending.appStage, "Contents", "MacOS", "GatewayUpdateInstaller"),
      stage: pending.appStage, command: invoke, signal: deps.signal,
      verifyIncoming: target => verifyIncomingApp(deps, target, ctx.team),
      verifyRetained: target => verifyRetainedApp(deps, target, ctx.team) });
    delete ctx.state.pending; await writePrivate(ctx.statePath, ctx.state);
    await finalizeCommittedInstallationTransaction(tx);
  } finally { await rm(activation, { recursive: true, force: true }).catch(() => undefined); }
  await discardUpdateStage(ctx, pending, deps);
  return success(output(ctx, { latestVersion: pending.version, phase: "installed", message: "Update installed. Reopen GateFox to use it." }));
}

/** Service-only pending retry. It is separate from the public protocol so UI calls never swap a live app. */
export async function processPendingAppUpdate(configPath: string, dependencies: AppUpdateDependencies = {}): Promise<boolean> {
  try {
    const hint = await appUpdateHint(configPath, dependencies);
    if (!hint?.pending && !hint?.recoveryNeeded) return false;
    // This is deliberately before context(): a GUI that is still open cannot be
    // swapped, and a bounded process probe avoids re-scanning signatures every
    // minute while the user works.
    if (await (dependencies.appRunning || defaultAppRunning)("")) return true;
    const ctx = await context({ operation: "status", configPath }, dependencies);
    const release = await acquire(ctx.installation.root);
    try {
      await refreshState(ctx);
      if (!ctx.state.pending) return reconcileWithoutPending(ctx, dependencies);
      await installPending(ctx, dependencies); return true;
    }
    finally { await release(); }
  } catch { return false; }
}

/** Cheap service tick: reads only private gateway-owned state. It never verifies,
 * launches, downloads, or contacts a provider; a pending action is revalidated
 * by `processPendingAppUpdate` before it can swap anything. */
export async function appUpdateHint(configPath: string, dependencies: AppUpdateDependencies = {}): Promise<{ pending: boolean; recoveryNeeded: boolean; automatic: boolean; lastChecked?: string } | undefined> {
  try {
    const snapshot = await (dependencies.readSnapshot || readSnapshot)(configPath);
    if (!snapshot) return;
    const plan = await (dependencies.servicePlan || readServicePlan)(snapshot.config.stateDirectory);
    if (!plan || resolve(plan.config) !== resolve(configPath)) return;
    const home = process.env.HOME; if (!home || !isAbsolute(home)) return;
    const installation = await (dependencies.installation || managedInstallationForCommand)(join(resolve(home), ".local", "bin", "harness-gateway"));
    const app = await (dependencies.appPath ? dependencies.appPath() : defaultAppPath(installation));
    if (!app || !await (dependencies.serviceBinding || managedAppServiceBinding)(configPath, app, installation.commandPath)) return;
    const saved = state(await readJson(join(installation.root, updateStateFile)));
    const recoveryNeeded = !!object(await readJson(join(installation.root, "app-update-transaction.json")));
    return { pending: !!saved.pending, recoveryNeeded, automatic: saved.automatic, ...(saved.lastChecked ? { lastChecked: saved.lastChecked } : {}) };
  } catch { return; }
}

async function stdin(limit = 16 * 1024): Promise<unknown> {
  let size = 0; const parts: Buffer[] = [];
  for await (const value of process.stdin) { const part = Buffer.from(value); size += part.length; if (size > limit) throw new Error("large"); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
async function main(): Promise<void> {
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  let response: AppUpdateResponse;
  try {
    if (!await trustedAppUpdateModule()) response = failure("unsupported_context", unknown);
    else response = await handleAppUpdate(await stdin(), { signal: controller.signal });
  }
  catch { response = failure("invalid_request", "The update request is invalid."); }
  const text = JSON.stringify(response); process.stdout.write(text.length <= 64 * 1024 ? text : JSON.stringify(failure("operation_failed", unknown)));
}
export async function trustedAppUpdateModule(moduleURL = import.meta.url): Promise<boolean> {
  const path = await realpath(fileURLToPath(moduleURL)).catch(() => "");
  const home = process.env.HOME; if (!home || !isAbsolute(home)) return false;
  try {
    const install = await managedInstallationForCommand(join(resolve(home), ".local", "bin", "harness-gateway"));
    const registeredApp = await defaultAppPath(install);
    if (registeredApp && path === await realpath(join(registeredApp, "Contents", "Resources", "management", "dist", "app-updates.js"))) return true;
    const match = new RegExp(`^${install.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/releases/([0-9]+\\.[0-9]+\\.[0-9]+)/package/dist/app-updates\\.js$`).exec(path);
    if (!match) return false;
    if ((await readFile(join(install.root, "releases", match[1]!, ".gateway-release"), "utf8").catch(() => ""))?.trim() !== match[1]) return false;
    const release = object(await readProtectedJson(join(install.root, "releases", match[1]!, "package", "release.json")));
    return release?.version === match[1] && source(release.source);
  } catch { return false; }
}
const invoked = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (invoked === fileURLToPath(import.meta.url)) await main();

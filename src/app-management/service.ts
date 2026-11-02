import { readCredentials, signIn as defaultSignIn } from "../auth/chatgpt.js";
import { readActivity } from "../activity.js";
import { readDiagnostics } from "../diagnostics-details.js";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import { mutateConfig, readSnapshot, type ConfigSnapshot } from "./storage.js";
import { ManagementError, safeFailure, throwIfCancelled } from "./errors.js";
import { discoverManagementModels, isManagementUnavailable } from "./runtime.js";
import { catalogEntry, checkedConfigPath, checkedDraftId, draftView, loadDraft, prepareDraft, saveDraft, writeCredential } from "./drafts.js";
import { commitDraft, gatewayOwnedCredential, loadCachedCatalog, mergeCatalog, removeProvider, renameProvider, reorderProviders, replaceGatewayCredential, saveCachedCatalog, updateModels, withConfiguredCatalog } from "./mutations.js";
import { sharedGatewayCatalog } from "./shared-gateway.js";
import { reconcileAutoLatest } from "../model-auto-latest/reconcile.js";
import { setAutoLatest } from "../model-auto-latest/toggle.js";
import { autoLatestStatus } from "../model-auto-latest/status.js";
import { emptyStatus, schedulePath } from "../model-auto-latest/state.js";
import { rawAutoLatest } from "../model-auto-latest/settings.js";
import { lockBusyCode, withPrivateFileLock } from "../private-file-lock.js";
import type { AutoLatestDependencies } from "../model-auto-latest/types.js";
import { effectivePlacement, setNativePickerPlacement } from "./native-picker.js";
import { cliAvailable, isApiKind, managedModels, managedProvider, providerPrerequisites, runSubscriptionLogin, validModelId } from "./providers.js";
import { metadataLabel } from "../model-label.js";
import { hasGrokLogin } from "../providers/grok-home.js";
import type { ManagedProvider } from "./types.js";
import type { CatalogEntry, DraftRecord, ManagementDependencies, ManagementRequest, ManagementResponse, ManagementResult, ProviderInput } from "./types.js";

const operations = new Set(["inspect", "prepare", "authenticate", "discover", "commit", "models", "rename", "reorder", "native-picker", "remove", "discard", "auto-latest", "auto-latest-check", "activity", "diagnostics"]);

function request(value: unknown): ManagementRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagementError("invalid_request");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.operation !== "string" || !operations.has(candidate.operation)) throw new ManagementError("invalid_request");
  return { ...candidate, operation: candidate.operation as ManagementRequest["operation"], configPath: checkedConfigPath(candidate.configPath) } as ManagementRequest;
}
function id(value: unknown): string { if (typeof value !== "string" || !/^[a-z][a-z0-9_-]*$/.test(value)) throw new ManagementError("invalid_request"); return value; }
function manual(value: unknown, provider: ProviderConfig): string[] {
  if (value === undefined) return []; if (!Array.isArray(value) || value.some(item => !validModelId(item)) || new Set(value).size !== value.length || !isApiKind(provider.type)) throw new ManagementError("invalid_request"); return value;
}
function input(value: unknown): ProviderInput { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagementError("invalid_provider"); return value as ProviderInput; }
function detail(value: unknown): string | undefined { return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value.trim().toLowerCase() : undefined; }

export class ManagementService {
  private readonly deps: ManagementDependencies;
  constructor(dependencies: ManagementDependencies = {}) { this.deps = { ...dependencies, discoverModels: dependencies.discoverModels || discoverManagementModels, signIn: dependencies.signIn || defaultSignIn }; }

  async handle(value: unknown): Promise<ManagementResponse> {
    try {
      const operation = request(value);
      throwIfCancelled(this.deps.signal);
      const result = await this.dispatch(operation);
      return { ok: true, result };
    } catch (error) {
      if (isManagementUnavailable(error)) return { ok: false, error: { code: "management_unavailable", message: "The bundled management runtime is unavailable." } };
      return safeFailure(error);
    }
  }

  private async dispatch(value: ManagementRequest): Promise<ManagementResult> {
    switch (value.operation) {
      case "diagnostics": {
        const hours = value.sinceHours ?? 1;
        if (![1, 6, 24].includes(hours)) throw new ManagementError("invalid_request");
        const snapshot = await readSnapshot(value.configPath); if (!snapshot) throw new ManagementError("not_found");
        return { configPath: value.configPath, diagnostics: await readDiagnostics(snapshot.config.stateDirectory, hours, this.deps.now?.()) };
      }
      case "activity": {
        const snapshot = await readSnapshot(value.configPath);
        if (!snapshot) throw new ManagementError("invalid_configuration");
        return { configPath: value.configPath, activity: await readActivity(value.configPath, snapshot.config.stateDirectory,
          { nativeHome: this.deps.nativeHome, signal: this.deps.signal }) };
      }
      case "inspect": return this.inspect(value.configPath);
      case "prepare": return this.prepare(value.configPath, input(value.provider));
      case "authenticate": return this.authenticate(value);
      case "discover": return this.discover(value);
      case "commit": return this.commit(value);
      case "models": return this.models(value);
      case "rename": return this.rename(value);
      case "reorder": return this.reorder(value);
      case "native-picker": return this.nativePicker(value);
      case "remove": return this.remove(value);
      case "discard": return this.discard(value);
      case "auto-latest": return this.autoLatest(value);
      case "auto-latest-check": return this.autoLatestCheck(value);
    }
  }

  private async inspect(configPath: string): Promise<ManagementResult> {
    const snapshot = await readSnapshot(configPath);
    if (!snapshot) return { configPath, providers: [], prerequisites: [], autoLatest: { ...emptyStatus, families: [], nativeFamilies: [] } };
    const result = await this.projectAt(configPath, snapshot);
    // A client-only configuration has no local providers; its catalog is the serving host's, read once and never kept.
    return snapshot.config.clientOnly ? { ...result, sharedGateway: await sharedGatewayCatalog(snapshot.config, this.deps.signal) } : result;
  }
  private async projectAt(configPath: string, snapshot: ConfigSnapshot): Promise<ManagementResult> {
    const providers = await Promise.all(snapshot.config.providers.map(async provider => grokStatus(provider,
      await managedProvider(provider, this.deps.lookupCli, withConfiguredCatalog(provider, await loadCachedCatalog(configPath, provider.id, provider)), false, snapshot.config.stateDirectory), this.deps.lookupCli)));
    return { configPath, revision: snapshot.revision, providers, nativeModelPickerPlacement: effectivePlacement(snapshot.raw), autoLatest: await autoLatestStatus(configPath, snapshot, this.deps.observeAutoLatestSchedule), prerequisites: await providerPrerequisites(this.deps.lookupCli, snapshot.config.providers.map(provider => provider.type)) };
  }

  private async prepare(configPath: string, provider: ProviderInput): Promise<ManagementResult> {
    const created = await prepareDraft(configPath, provider, this.deps);
    return { configPath, ...(created.snapshot ? { revision: created.snapshot.revision } : {}), draft: await draftView(created.draft, this.deps), prerequisites: await providerPrerequisites(this.deps.lookupCli, [provider.type]) };
  }

  private async authenticate(value: ManagementRequest): Promise<ManagementResult> {
    if (value.draftId !== undefined) {
      const draft = await loadDraft(value.configPath, checkedDraftId(value.draftId)); if (draft.committed || draft.cancelled) throw new ManagementError("invalid_request");
      await this.login(draft.provider, draft.accountEmail); return { configPath: value.configPath, draft: await draftView(draft, this.deps) };
    }
    const providerId = id(value.providerId); const snapshot = await readSnapshot(value.configPath); if (!snapshot) throw new ManagementError("not_found");
    if (value.revision !== undefined && value.revision !== snapshot.revision) throw new ManagementError("configuration_changed");
    const provider = snapshot.config.providers.find(item => item.id === providerId); if (!provider) throw new ManagementError("not_found");
    // Grok signs in through its own CLI in the gateway's private home, so Reconnect runs that flow.
    if (provider.type === "grok-subscription") { await this.login(provider); return this.projectAt(value.configPath, snapshot); }
    if (isApiKind(provider.type)) {
      const supplied = input(value.provider); const key = supplied.apiKey;
      if (typeof key !== "string" || !key.trim() || key.length > 4096 || /[\r\n]/.test(key)) throw new ManagementError("key_required");
      const updated = await replaceGatewayCredential(value.configPath, providerId, value.revision, key, this.deps.signal); return this.projectAt(value.configPath, updated);
    }
    // Existing Codex identities come from the private credential record, never caller input or raw config.
    const codexOwned = provider.type !== "codex-subscription" || await gatewayOwnedCredential(snapshot.config, provider);
    if (!codexOwned) throw new ManagementError("external_credential");
    const expected = provider.type === "codex-subscription" ? detail((await readCredentials(provider.credentialFile!))?.email) : undefined;
    await this.login(provider, expected);
    return this.projectAt(value.configPath, snapshot);
  }

  private async login(provider: ProviderConfig, expectedEmail?: string): Promise<void> {
    try {
      if (isApiKind(provider.type)) return;
      await runSubscriptionLogin(provider, this.deps, expectedEmail);
    } catch (error) { if (error instanceof ManagementError) throw error; throw new ManagementError("authentication_failed"); }
  }

  private async discover(value: ManagementRequest): Promise<ManagementResult> {
    const target = await this.discoveryTarget(value); const supplied = manual(value.manualModels, target.provider);
    let fresh: CatalogEntry[] = []; let verified = false;
    try {
      const discovered = await this.deps.discoverModels!(target.provider, { refresh: true }); verified = true;
      fresh = discovered.map(item => catalogEntry(item.model, metadataLabel(item.metadata.displayName) || item.model, item.metadata as Record<string, unknown>));
    } catch (error) {
      if (isManagementUnavailable(error)) throw error;
      if (!supplied.length) throw new ManagementError("discovery_failed");
    }
    const catalog = mergeCatalog(target.provider, fresh, supplied);
    if (target.draft) { target.draft.catalog = catalog; await saveDraft(target.draft, this.deps.signal); }
    else await saveCachedCatalog(value.configPath, target.provider.id, catalog, this.deps.signal, target.provider);
    const models = managedModels(target.provider, catalog, Boolean(target.draft));
    if (target.draft) {
      const draft = await draftView(target.draft, this.deps); if (verified) markChecked(draft.provider); return { configPath: value.configPath, draft, models };
    }
    const result = await this.projectAt(value.configPath, target.snapshot!); const provider = result.providers?.find(item => item.id === target.provider.id); if (provider && verified) markChecked(provider);
    return { ...result, models };
  }

  private async discoveryTarget(value: ManagementRequest): Promise<{ provider: ProviderConfig; draft?: DraftRecord; snapshot?: ConfigSnapshot }> {
    if (value.draftId !== undefined) { const draft = await loadDraft(value.configPath, checkedDraftId(value.draftId)); if (draft.committed || draft.cancelled) throw new ManagementError("invalid_request"); return { provider: draft.provider, draft }; }
    const providerId = id(value.providerId); const snapshot = await readSnapshot(value.configPath); const provider = snapshot?.config.providers.find(item => item.id === providerId); if (!snapshot || !provider) throw new ManagementError("not_found"); if (provider.type === "grok-subscription") throw new ManagementError("invalid_request"); return { provider, snapshot };
  }

  private async commit(value: ManagementRequest): Promise<ManagementResult> {
    const draft = await loadDraft(value.configPath, checkedDraftId(value.draftId)); if (draft.committed || draft.cancelled) throw new ManagementError("invalid_request");
    const snapshot = await commitDraft(value.configPath, draft, value.selectedModels, value.manualModels, this.deps.signal); draft.committed = true; await saveDraft(draft);
    return { ...(await this.projectAt(value.configPath, snapshot)), changed: true };
  }
  private async models(value: ManagementRequest): Promise<ManagementResult> {
    const result = await updateModels(value.configPath, id(value.providerId), value.revision, value.selectedModels, value.manualModels, this.deps.signal);
    return { ...(await this.projectAt(value.configPath, result.snapshot)), changed: result.changed };
  }
  private async rename(value: ManagementRequest): Promise<ManagementResult> {
    const result = await renameProvider(value.configPath, id(value.providerId), value.revision, value.label, this.deps.signal);
    return { ...(await this.projectAt(value.configPath, result.snapshot)), changed: result.changed };
  }
  private async reorder(value: ManagementRequest): Promise<ManagementResult> {
    const result = await reorderProviders(value.configPath, value.providerIds, value.revision, this.deps.signal);
    return { ...(await this.projectAt(value.configPath, result.snapshot)), changed: result.changed };
  }
  private async remove(value: ManagementRequest): Promise<ManagementResult> {
    const snapshot = await removeProvider(value.configPath, id(value.providerId), value.revision, this.deps.signal);
    return { ...(await this.projectAt(value.configPath, snapshot)), changed: true, removed: true };
  }
  private async nativePicker(value: ManagementRequest): Promise<ManagementResult> {
    const result = await setNativePickerPlacement(value.configPath, value.nativeModelPickerPlacement, value.revision, this.deps.signal);
    return { ...(await this.projectAt(value.configPath, result.snapshot)), changed: result.changed };
  }
  private autoDeps(): AutoLatestDependencies {
    return { discoverModels: this.deps.discoverModels!, ...(this.deps.signal ? { signal: this.deps.signal } : {}), ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.nativeHome ? { nativeHome: this.deps.nativeHome } : {}), ...(this.deps.perProviderMs !== undefined ? { perProviderMs: this.deps.perProviderMs } : {}), ...(this.deps.totalMs !== undefined ? { totalMs: this.deps.totalMs } : {}) };
  }
  /** Toggles automatic upkeep, then syncs its background job. A failed job is reported as not scheduled, never as success. */
  private async autoLatest(value: ManagementRequest): Promise<ManagementResult> {
    if (typeof value.enabled !== "boolean") throw new ManagementError("invalid_request");
    const result = await setAutoLatest(value.configPath, value.enabled, value.revision as string, this.autoDeps());
    const { schedule, snapshot } = await this.syncSchedule(value.configPath, result.snapshot);
    const projected = await this.projectAt(value.configPath, snapshot);
    const reason = typeof schedule?.reason === "string" && /^[a-z][a-z_]{0,40}$/.test(schedule.reason) ? schedule.reason : undefined;
    return { ...projected, changed: result.changed, autoLatest: { ...projected.autoLatest!, scheduled: schedule?.scheduled === true, ...(reason ? { scheduleReason: reason } : {}) } };
  }
  /**
   * Installs or removes the background job for what the configuration says now. Concurrent toggles queue on one lock and
   * each rereads the setting under it, so a slow "on" can never install the job after a later "off". The snapshot returned
   * is the one read under the guard.
   */
  private async syncSchedule(configPath: string, committed: ConfigSnapshot): Promise<{ schedule: { scheduled: boolean; reason?: string }; snapshot: ConfigSnapshot }> {
    try {
      return await withPrivateFileLock(await schedulePath(configPath), async () => {
        // The sync can outlast another toggle's lock wait, so the setting is reread after each sync and the job is brought
        // in line again until it matches what the configuration says, before the lock is released. At most three rounds.
        let snapshot = (await readSnapshot(configPath)) ?? committed; let schedule: { scheduled: boolean; reason?: string } = { scheduled: false, reason: "schedule_failed" };
        for (let round = 0; round < 3; round++) {
          // An aborted request never starts or repeats an install.
          if (this.deps.signal?.aborted) return { schedule: { scheduled: false, reason: "cancelled" }, snapshot };
          const enabled = rawAutoLatest(snapshot.raw)?.enabled === true;
          try { schedule = await (this.deps.syncAutoLatestSchedule ?? defaultScheduleSync)(configPath, enabled); }
          catch { return { schedule: { scheduled: false, reason: "schedule_failed" }, snapshot }; }
          const latest = (await readSnapshot(configPath).catch(() => undefined)) ?? snapshot;
          const changed = (rawAutoLatest(latest.raw)?.enabled === true) !== enabled;
          snapshot = latest;
          if (!changed) return { schedule, snapshot };
        }
        return { schedule: { scheduled: false, reason: "schedule_failed" }, snapshot };
      }, this.deps.scheduleLockMs ?? 10_000);
    } catch (error) {
      const busy = (error as { code?: string } | undefined)?.code === lockBusyCode;
      return { schedule: { scheduled: false, reason: busy ? "schedule_busy" : "schedule_failed" }, snapshot: (await readSnapshot(configPath).catch(() => undefined)) ?? committed };
    }
  }
  /** A manual check: metadata only, allowed to refresh a login the user is looking at, refused if the screen is out of date. */
  private async autoLatestCheck(value: ManagementRequest): Promise<ManagementResult> {
    if (typeof value.revision !== "string" || !value.revision) throw new ManagementError("invalid_request");
    const outcome = await reconcileAutoLatest(value.configPath, { ...this.autoDeps(), refresh: true, expectedRevision: value.revision });
    const snapshot = await readSnapshot(value.configPath); if (!snapshot) throw new ManagementError("not_found");
    const projected = await this.projectAt(value.configPath, snapshot);
    const ran = outcome.outcome !== "busy" && outcome.outcome !== "disabled";
    return { ...projected, changed: outcome.changed, autoLatest: { ...projected.autoLatest!, ...(ran ? { lastCheckedAt: outcome.checkedAt, lastOutcome: outcome.outcome } : {}) } };
  }
  private async discard(value: ManagementRequest): Promise<ManagementResult> {
    const draft = await loadDraft(value.configPath, checkedDraftId(value.draftId)); if (draft.committed) throw new ManagementError("invalid_request"); throwIfCancelled(this.deps.signal); draft.cancelled = true; await saveDraft(draft, this.deps.signal); return { configPath: value.configPath, draft: await draftView(draft, this.deps), changed: false };
  }
}

async function defaultScheduleSync(configPath: string, enabled: boolean): Promise<{ scheduled: boolean; reason?: string }> {
  return (await import("../model-auto-latest/schedule.js")).syncAutoLatestSchedule(configPath, enabled);
}

function rawProvider(snapshot: ConfigSnapshot, id: string): Record<string, unknown> {
  const providers = snapshot.raw.providers; if (!Array.isArray(providers)) throw new ManagementError("invalid_configuration");
  const provider = providers.find(value => value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).id === id);
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new ManagementError("not_found"); return provider as Record<string, unknown>;
}
function markChecked(provider: { authState: string; authDetail: string }): void {
  provider.authState = "ready"; provider.authDetail = "Model catalog was checked.";
}

/**
 * Grok signs in through its own CLI, so its state comes from the gateway's private home. The shared
 * provider view never probes a removed home beyond a file check, and it keeps every other field.
 */
async function grokStatus(provider: ProviderConfig, view: ManagedProvider, lookup: ManagementDependencies["lookupCli"]): Promise<ManagedProvider> {
  if (provider.type !== "grok-subscription") return view;
  const available = await (lookup || cliAvailable)("grok");
  const signedIn = await hasGrokLogin(provider.grokHome);
  return { ...view,
    authState: signedIn ? "ready" : available ? "needs-sign-in" : "missing-cli",
    authDetail: signedIn ? "Signed in through the Grok CLI in this gateway's private home."
      : available ? "Sign in with the Grok CLI's device code in this gateway's private home." : "The Grok CLI is not installed.",
    canDiscover: false, canReconnect: available };
}

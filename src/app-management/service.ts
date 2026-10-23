import { readCredentials, signIn as defaultSignIn } from "../auth/chatgpt.js";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import { mutateConfig, readSnapshot, type ConfigSnapshot } from "./storage.js";
import { ManagementError, safeFailure, throwIfCancelled } from "./errors.js";
import { discoverManagementModels, isManagementUnavailable } from "./runtime.js";
import { catalogEntry, checkedConfigPath, checkedDraftId, draftView, loadDraft, prepareDraft, saveDraft, writeCredential } from "./drafts.js";
import { commitDraft, gatewayOwnedCredential, loadCachedCatalog, mergeCatalog, removeProvider, renameProvider, replaceGatewayCredential, saveCachedCatalog, updateModels, withConfiguredCatalog } from "./mutations.js";
import { sharedGatewayCatalog } from "./shared-gateway.js";
import { isApiKind, managedModels, managedProvider, providerPrerequisites, runSubscriptionLogin, validModelId } from "./providers.js";
import type { CatalogEntry, DraftRecord, ManagementDependencies, ManagementRequest, ManagementResponse, ManagementResult, ProviderInput } from "./types.js";

const operations = new Set(["inspect", "prepare", "authenticate", "discover", "commit", "models", "rename", "remove", "discard"]);

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
      case "inspect": return this.inspect(value.configPath);
      case "prepare": return this.prepare(value.configPath, input(value.provider));
      case "authenticate": return this.authenticate(value);
      case "discover": return this.discover(value);
      case "commit": return this.commit(value);
      case "models": return this.models(value);
      case "rename": return this.rename(value);
      case "remove": return this.remove(value);
      case "discard": return this.discard(value);
    }
  }

  private async inspect(configPath: string): Promise<ManagementResult> {
    const snapshot = await readSnapshot(configPath);
    if (!snapshot) return { configPath, providers: [], prerequisites: [] };
    const result = await this.projectAt(configPath, snapshot);
    // A client-only configuration has no local providers; its catalog is the serving host's, read once and never kept.
    return snapshot.config.clientOnly ? { ...result, sharedGateway: await sharedGatewayCatalog(snapshot.config, this.deps.signal) } : result;
  }
  private async projectAt(configPath: string, snapshot: ConfigSnapshot): Promise<ManagementResult> {
    const providers = await Promise.all(snapshot.config.providers.map(async provider => managedProvider(provider, this.deps.lookupCli,
      withConfiguredCatalog(provider, await loadCachedCatalog(configPath, provider.id, provider)), false, snapshot.config.stateDirectory)));
    return { configPath, revision: snapshot.revision, providers, prerequisites: await providerPrerequisites(this.deps.lookupCli, snapshot.config.providers.map(provider => provider.type)) };
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
    if (provider.type === "grok-subscription") throw new ManagementError("invalid_request");
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
      fresh = discovered.map(item => catalogEntry(item.model, item.metadata.displayName || item.model, item.metadata as Record<string, unknown>));
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
  private async remove(value: ManagementRequest): Promise<ManagementResult> {
    const snapshot = await removeProvider(value.configPath, id(value.providerId), value.revision, this.deps.signal);
    return { ...(await this.projectAt(value.configPath, snapshot)), changed: true, removed: true };
  }
  private async discard(value: ManagementRequest): Promise<ManagementResult> {
    const draft = await loadDraft(value.configPath, checkedDraftId(value.draftId)); if (draft.committed) throw new ManagementError("invalid_request"); throwIfCancelled(this.deps.signal); draft.cancelled = true; await saveDraft(draft, this.deps.signal); return { configPath: value.configPath, draft: await draftView(draft, this.deps), changed: false };
  }
}

function rawProvider(snapshot: ConfigSnapshot, id: string): Record<string, unknown> {
  const providers = snapshot.raw.providers; if (!Array.isArray(providers)) throw new ManagementError("invalid_configuration");
  const provider = providers.find(value => value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).id === id);
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new ManagementError("not_found"); return provider as Record<string, unknown>;
}
function markChecked(provider: { authState: string; authDetail: string }): void {
  provider.authState = "ready"; provider.authDetail = "Model catalog was checked.";
}

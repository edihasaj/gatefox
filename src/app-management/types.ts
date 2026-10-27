import type { DiscoveredModel } from "../catalog.js";
import type { AccessTokenOptions } from "../auth/chatgpt.js";
import type { ProviderConfig, ProviderKind } from "../config.js";
import type { AutoLatestStatus } from "../model-auto-latest/types.js";
import type { ActivityReport } from "../activity.js";
import type { DiagnosticsReport } from "../diagnostics-details.js";

export type ManagementOperation = "inspect" | "prepare" | "authenticate" | "discover" | "commit" | "models" | "rename" | "reorder" | "native-picker" | "remove" | "discard" | "auto-latest" | "auto-latest-check" | "activity" | "diagnostics";

export interface ProviderInput {
  id?: string;
  label: string;
  type: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  useExistingLogin?: boolean;
  accountEmail?: string;
}

export interface ManagementRequest {
  operation: ManagementOperation;
  configPath: string;
  draftId?: string;
  providerId?: string;
  provider?: ProviderInput;
  selectedModels?: string[];
  manualModels?: string[];
  revision?: string;
  label?: string;
  providerIds?: string[];
  /** Validated at the operation: only "first", "last" or "hidden" are accepted. */
  nativeModelPickerPlacement?: string;
  /** The `auto-latest` operation: whether automatic newest-model upkeep is on. Requires `revision`. */
  enabled?: boolean;
  sinceHours?: number;
}

/** `releasedAt` is the vendor release time in UTC seconds, present only when the catalog states one. */
export interface ManagedModel { id: string; alias?: string; label: string; enabled: boolean; releasedAt?: number }
export interface ManagedProvider {
  id: string;
  label: string;
  type: ProviderKind;
  baseUrl?: string;
  authState: "saved" | "ready" | "unchecked" | "needs-sign-in" | "missing-cli" | "external-credential";
  authDetail: string;
  models: ManagedModel[];
  canDiscover: boolean;
  canReconnect: boolean;
}
export interface Prerequisite { id: string; label: string; available: boolean; downloadURL?: string }
export interface ManagedDraft { id: string; provider: ManagedProvider; revision?: string; configPath: string; isNewConfiguration: boolean }
/** One model the serving host routes: its configured alias and catalog label, nothing else. */
export interface SharedGatewayModel { id: string; label: string }
export interface SharedGatewayProvider { id: string; label: string; type: string; models: SharedGatewayModel[] }
/** The read-only view of the shared gateway a remote client configuration points at. A failed read carries no data. */
export interface SharedGateway {
  status: "available" | "unavailable";
  hostname?: string;
  providers: SharedGatewayProvider[];
}
export interface ManagementResult {
  diagnostics?: DiagnosticsReport;
  activity?: ActivityReport;
  configPath?: string;
  revision?: string;
  providers?: ManagedProvider[];
  prerequisites?: Prerequisite[];
  draft?: ManagedDraft;
  models?: ManagedModel[];
  changed?: boolean;
  removed?: boolean;
  sharedGateway?: SharedGateway;
  /** Normalised placement of the local native GPT models in the picker; "first" when the configuration has no setting. */
  nativeModelPickerPlacement?: "first" | "last" | "hidden";
  /** The automatic newest-model setting, present on every result that projects a configuration. */
  autoLatest?: AutoLatestStatus;
}
export type ManagementResponse = { ok: true; result: ManagementResult } | { ok: false; error: { code: string; message: string } };

export interface ManagementDependencies {
  discoverModels?: (provider: ProviderConfig, options?: AccessTokenOptions) => Promise<DiscoveredModel[]>;
  signIn?: (path: string, agentName: string, openBrowser: (url: string) => Promise<void>, signal?: AbortSignal, expectedEmail?: string) => Promise<void>;
  runLogin?: (command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<void>;
  lookupCli?: (command: string) => Promise<boolean>;
  openBrowser?: (url: string) => Promise<void>;
  signal?: AbortSignal;
  /** Test seams for automatic upkeep: the native Codex home, the clock (ms), and discovery deadlines. */
  nativeHome?: string;
  now?: () => number;
  perProviderMs?: number;
  totalMs?: number;
  /** Installs or removes the background job; its failure is reported, never hidden. */
  /** Test seam: observes whether the background job is loaded; only asked while the setting is on. */
  observeAutoLatestSchedule?: (configPath: string) => Promise<{ scheduled: boolean; reason?: string }>;
  /** Test seam: how long a toggle waits for the schedule lock. */
  scheduleLockMs?: number;
  syncAutoLatestSchedule?: (configPath: string, enabled: boolean) => Promise<{ scheduled: boolean; reason?: string }>;
}

export interface CatalogEntry { id: string; label: string; metadata?: Record<string, unknown> }
export interface DraftRecord {
  version: 1;
  id: string;
  configPath: string;
  revision?: string;
  isNewConfiguration: boolean;
  provider: ProviderConfig;
  accountEmail?: string;
  catalog?: CatalogEntry[];
  committed?: boolean;
  cancelled?: boolean;
}

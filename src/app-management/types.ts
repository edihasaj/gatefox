import type { DiscoveredModel } from "../catalog.js";
import type { AccessTokenOptions } from "../auth/chatgpt.js";
import type { ProviderConfig, ProviderKind } from "../config.js";

export type ManagementOperation = "inspect" | "prepare" | "authenticate" | "discover" | "commit" | "models" | "rename" | "reorder" | "remove" | "discard";

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
}

export interface ManagedModel { id: string; alias?: string; label: string; enabled: boolean }
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
  configPath?: string;
  revision?: string;
  providers?: ManagedProvider[];
  prerequisites?: Prerequisite[];
  draft?: ManagedDraft;
  models?: ManagedModel[];
  changed?: boolean;
  removed?: boolean;
  sharedGateway?: SharedGateway;
}
export type ManagementResponse = { ok: true; result: ManagementResult } | { ok: false; error: { code: string; message: string } };

export interface ManagementDependencies {
  discoverModels?: (provider: ProviderConfig, options?: AccessTokenOptions) => Promise<DiscoveredModel[]>;
  signIn?: (path: string, agentName: string, openBrowser: (url: string) => Promise<void>, signal?: AbortSignal, expectedEmail?: string) => Promise<void>;
  runLogin?: (command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<void>;
  lookupCli?: (command: string) => Promise<boolean>;
  openBrowser?: (url: string) => Promise<void>;
  signal?: AbortSignal;
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

export const updateRepository = "edihasaj/harness-gateway";
export const updateStateFile = "app-update.json";
export const updateLockName = ".gateway-app-update-lock";

export type UpdateOperation = "status" | "check" | "install" | "preferences";
export interface UpdateRequest {
  operation: UpdateOperation;
  configPath: string;
  automatic?: boolean;
}
export interface UpdateResult {
  automatic: boolean;
  currentVersion: string;
  latestVersion?: string;
  available: boolean;
  phase: string;
  message: string;
  lastChecked?: string;
}
export type AppUpdateResponse =
  | { ok: true; result: UpdateResult }
  | { ok: false; error: { code: string; message: string } };

export interface UpdateManifest {
  schemaVersion: 1;
  version: string;
  source: string;
  branch: "production";
  appAsset: string;
  appSha256: string;
  backendAsset: string;
  backendSha256: string;
}
export interface UpdatePolicy {
  schemaVersion: 1;
  version: string;
  source: string;
  branch: "production";
  backendAsset: string;
  backendSha256: string;
}
export interface ReleaseAsset { id: number; name: string; size: number }
export interface Release { tag_name: string; draft?: boolean; prerelease?: boolean; assets: ReleaseAsset[] }
export interface UpdateState {
  schemaVersion: 1;
  automatic: boolean;
  lastChecked?: string;
  latestVersion?: string;
  pending?: { version: string; source: string; backendSha256: string; appStage: string; backendArchive: string; requestedAt: string };
}

export interface CommandResult { code: number; stdout: string; stderr: string }
export type Command = (file: string, args: string[], options?: { timeoutMs?: number; stdoutLimit?: number; signal?: AbortSignal }) => Promise<CommandResult>;

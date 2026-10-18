import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { discoverModels as localDiscoverModels, type DiscoveredModel } from "../catalog.js";
import { validateConfig as localValidateConfig, type GatewayConfig, type ProviderConfig } from "../config.js";
import type { AccessTokenOptions } from "../auth/chatgpt.js";

type ConfigValidator = (raw: unknown, directory: string) => GatewayConfig | Promise<GatewayConfig>;
type ModelDiscoverer = (provider: ProviderConfig, options?: AccessTokenOptions) => Promise<DiscoveredModel[]>;
type RuntimeModules = { validateConfig: ConfigValidator; discoverModels: ModelDiscoverer };

const unavailableCode = "management_unavailable";

function unavailable(): Error {
  return Object.assign(new Error("Bundled management runtime is unavailable"), { code: unavailableCode });
}

/** A deliberately opaque packaged-runtime failure. It must never reveal bundle paths or loader errors. */
export function isManagementUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === unavailableCode);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function runtimeModules(config: unknown, catalog: unknown): RuntimeModules {
  const validator = record(config)?.validateConfig;
  const discoverer = record(catalog)?.discoverModels;
  if (typeof validator !== "function" || typeof discoverer !== "function") throw unavailable();
  return {
    validateConfig: validator as ConfigValidator,
    discoverModels: discoverer as ModelDiscoverer,
  };
}

async function exists(url: URL, directory = false): Promise<boolean> {
  if (url.protocol !== "file:") return false;
  try {
    const info = await lstat(fileURLToPath(url));
    return directory ? info.isDirectory() : info.isFile();
  } catch { return false; }
}

async function loadModules(runtimeURL: URL): Promise<RuntimeModules> {
  if (runtimeURL.protocol !== "file:") throw unavailable();
  const packaged = runtimeURL.pathname.endsWith("/Resources/management/dist/app-management/runtime.js");
  if (!packaged) return { validateConfig: localValidateConfig, discoverModels: localDiscoverModels };
  // This is fixed relative to Resources/management/dist/app-management/runtime.js.
  // No configuration or environment input participates in resolving the backend.
  const backend = new URL("../../../backend/package/", runtimeURL);
  if (!await exists(backend, true)) throw unavailable();
  const config = new URL("dist/config.js", backend);
  const catalog = new URL("dist/catalog.js", backend);
  if (!await exists(config) || !await exists(catalog)) throw unavailable();
  try {
    return runtimeModules(await import(config.href), await import(catalog.href));
  } catch { throw unavailable(); }
}

export interface ManagementRuntime {
  validateManagementConfig(raw: unknown, directory: string): Promise<GatewayConfig>;
  discoverManagementModels(provider: ProviderConfig, options?: AccessTokenOptions): Promise<DiscoveredModel[]>;
}

/**
 * The URL parameter exists solely to make the fixed bundle layout testable. Production uses
 * import.meta.url; callers never supply a module path from configuration or the environment.
 */
export function createManagementRuntime(runtimeURL: URL): ManagementRuntime {
  let modules: Promise<RuntimeModules> | undefined;
  const load = (): Promise<RuntimeModules> => modules ||= loadModules(runtimeURL);
  return {
    async validateManagementConfig(raw, directory): Promise<GatewayConfig> {
      return await (await load()).validateConfig(raw, directory) as GatewayConfig;
    },
    async discoverManagementModels(provider, options): Promise<DiscoveredModel[]> {
      return await (await load()).discoverModels(provider, options);
    },
  };
}

const productionRuntime = createManagementRuntime(new URL(import.meta.url));

export const validateManagementConfig = productionRuntime.validateManagementConfig;
export const discoverManagementModels = productionRuntime.discoverManagementModels;

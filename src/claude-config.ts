import { resolve } from "node:path";
import { readClientToken } from "./config.js";
import { gatewayCommand } from "./command.js";
import { endpointURL } from "./codex-config.js";
import { unknownContextWindow } from "./catalog.js";

const catalogLimitBytes = 1024 * 1024;

/** Quote one argv element for the POSIX shell Claude Code uses for apiKeyHelper. */
export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function claudeBaseURL(endpoint: string): string {
  const base = endpointURL(endpoint);
  return base.endsWith("/v1") ? base.slice(0, -3) : base;
}

function apiKeyHelper(credentialArgs: string[]): string {
  if (process.platform === "win32") throw new Error("Claude settings generation is unsupported on Windows because apiKeyHelper requires POSIX shell quoting");
  const helper = gatewayCommand();
  return [helper.command, ...helper.args, "token", ...credentialArgs].map(quotePosixShellArg).join(" ");
}

/** The public catalog fields Claude settings use. A remote catalog is untrusted, so each is checked where it is read. */
export interface ClaudeCatalog {
  models: Array<{ slug?: unknown; display_name?: unknown; description?: unknown; visibility?: unknown; context_window?: unknown }>;
  /** Known only where the gateway's configuration is available; a remote client sees just the public catalog. */
  knownWindows?: ReadonlySet<string>;
}
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/**
 * Claude Code's discovery keeps only IDs naming Claude or Anthropic, so gateway aliases are listed explicitly. Built-in rows
 * are replaced because they name models this gateway may not serve. The selected model stays listed even when hidden.
 */
function modelPicker(model: string, catalog: ClaudeCatalog) {
  const options = catalog.models.filter(row => typeof row.slug === "string" && (row.visibility !== "hide" || row.slug === model)).map(row => ({
    model: row.slug as string, ...(text(row.display_name) ? { label: text(row.display_name) } : {}), ...(text(row.description) ? { description: text(row.description) } : {}),
  }));
  return options.length ? { modelPicker: { options, replaceBuiltInOptions: true } } : {};
}

/** Claude Code assumes 200K for an unknown ID. The setting is per process, so it describes the launch model only. */
function contextWindow(model: string, catalog: ClaudeCatalog): Record<string, string> {
  const value = catalog.models.find(row => row.slug === model)?.context_window;
  const known = catalog.knownWindows?.has(model) === true || value !== unknownContextWindow;
  return known && typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(value) } : {};
}

export function claudeSettings(model: string, endpoint: string, credentialArgs: string[], catalog: ClaudeCatalog = { models: [] }): string {
  return JSON.stringify({
    model,
    env: { ANTHROPIC_BASE_URL: claudeBaseURL(endpoint), CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1", ...contextWindow(model, catalog) },
    apiKeyHelper: apiKeyHelper(credentialArgs),
    ...modelPicker(model, catalog),
  }, null, 2) + "\n";
}

async function boundedResponseText(response: Response): Promise<string> {
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength && Number(advertisedLength) > catalogLimitBytes) throw new Error("Remote model catalog exceeds 1 MiB");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > catalogLimitBytes) {
      await reader.cancel();
      throw new Error("Remote model catalog exceeds 1 MiB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Fetch the public catalog only; provider credentials stay on the inference host. */
export async function remoteClaudeSettings(model: string, endpoint: string, tokenFile: string): Promise<string> {
  const base = endpointURL(endpoint);
  const token = await readClientToken(tokenFile);
  const response = await fetch(`${base}/model-catalog`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Remote catalog returned HTTP ${response.status}`);
  const catalog = JSON.parse(await boundedResponseText(response)) as Partial<ClaudeCatalog> & { models?: ClaudeCatalog["models"] };
  if (!Array.isArray(catalog.models) || catalog.models.some(entry => !entry || typeof entry.slug !== "string") || new Set(catalog.models.map(entry => entry.slug)).size !== catalog.models.length || !catalog.models.some(entry => entry.slug === model)) throw new Error("Selected model is absent from a valid remote catalog");
  return claudeSettings(model, base, ["--file", resolve(tokenFile)], { models: catalog.models });
}

import { resolve } from "node:path";
import { readClientToken } from "./config.js";
import { gatewayCommand } from "./command.js";
import { endpointURL } from "./codex-config.js";

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

export function claudeSettings(model: string, endpoint: string, credentialArgs: string[]): string {
  return JSON.stringify({
    model,
    env: { ANTHROPIC_BASE_URL: claudeBaseURL(endpoint) },
    apiKeyHelper: apiKeyHelper(credentialArgs),
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
  const catalog = JSON.parse(await boundedResponseText(response)) as { models?: Array<{ slug?: string }> };
  if (!Array.isArray(catalog.models) || catalog.models.some(entry => !entry || typeof entry.slug !== "string") || new Set(catalog.models.map(entry => entry.slug)).size !== catalog.models.length || !catalog.models.some(entry => entry.slug === model)) throw new Error("Selected model is absent from a valid remote catalog");
  return claudeSettings(model, base, ["--file", resolve(tokenFile)]);
}

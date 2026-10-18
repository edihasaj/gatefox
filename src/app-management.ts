import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { ManagementService } from "./app-management/service.js";
import type { ManagementDependencies, ManagementResponse } from "./app-management/types.js";

export type { ManagementDependencies, ManagementRequest, ManagementResponse, ManagementResult, ManagedDraft, ManagedModel, ManagedProvider, Prerequisite, ProviderInput } from "./app-management/types.js";

/** Handles one untrusted native-app request without exposing its contents in errors or logs. */
export async function handleManagement(request: unknown, dependencies: ManagementDependencies = {}): Promise<ManagementResponse> {
  return new ManagementService(dependencies).handle(request);
}

async function readBoundedStdin(limit = 128 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const piece of process.stdin) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece); size += chunk.length;
    if (size > limit) throw new Error("input too large"); chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new Error("empty input"); return JSON.parse(text);
}

async function main(): Promise<void> {
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  let response: ManagementResponse;
  try { response = await handleManagement(await readBoundedStdin(), { signal: controller.signal }); }
  catch { response = { ok: false, error: { code: "invalid_request", message: "The management request is invalid." } }; }
  process.stdout.write(JSON.stringify(response));
}

const invokedFile = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) await main();

import type { GatewayConfig } from "../config.js";
import type { ResponsesRequest } from "../protocol/types.js";
export const managedNow = 1_800_000_000_000;
export function managedFixture(stateDirectory: string): GatewayConfig {
  return { version: 1, port: 0, stateDirectory, providers: [
    { id: "local", type: "chat-completions-api", baseUrl: "http://127.0.0.1:3000/v1", apiKeyEnv: "UNUSED_LOCAL_MANAGED_TEST_KEY", sessionAffinity: true, models: { "local/qwen": "qwen" }, modelMetadata: { "local/qwen": { contextWindow: 131072, reasoningEfforts: ["low", "medium", "high"] } } },
    { id: "sub", type: "codex-subscription", credentialFile: "unused", models: { "sub/sol": "gpt-6.1-sol" }, modelMetadata: { "sub/sol": { contextWindow: 500000, reasoningEfforts: ["low", "medium", "high"] } } },
    { id: "sub2", type: "claude-subscription", models: { "sub2/sonnet": "claude-sonnet-5-5" }, modelMetadata: { "sub2/sonnet": { contextWindow: 500000, reasoningEfforts: ["low", "medium", "high"] } } },
    { id: "paid", type: "responses-api", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "UNUSED_MANAGED_TEST_KEY", models: { "paid/flash": "deepseek/deepseek-v4-flash" }, modelMetadata: { "paid/flash": { contextWindow: 131072, reasoningEfforts: ["low", "medium"] } } },
  ], managedRouting: { routes: { "managed/routine": { purpose: "routine", candidates: ["local/qwen", "sub/sol", "sub2/sonnet", "paid/flash"], maxContextBytes: 262144, contextWindow: 32768, minRemainingPercent: 2, allowPaid: true } } } };
}
export function managedFacts(now = managedNow): Record<string, unknown> {
  const observedAt = new Date(now).toISOString();
  return { providers: [
    { id: "local", status: "available", reasons: [], health: { status: "healthy", fresh: true, observedAt, servedModels: ["qwen"] } },
    { id: "sub", status: "available", reasons: [], quota: { fresh: true, observedAt, remainingPercent: 50 } },
    { id: "sub2", status: "available", reasons: [], quota: { fresh: true, observedAt, remainingPercent: 50 } },
    { id: "paid", status: "available", reasons: [], balance: { fresh: true, observedAt, remainingUsd: 20 } },
  ] };
}
export function factsRows(facts: Record<string, unknown>): Record<string, unknown>[] { return facts.providers as Record<string, unknown>[]; }
export const managedRequest = (patch: Partial<ResponsesRequest> = {}): ResponsesRequest => ({ model: "managed/routine", input: "A small bounded task", ...patch });

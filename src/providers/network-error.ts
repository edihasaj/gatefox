import { classifyNetworkFailure, type ProviderNetworkStage } from "../provider-network.js";
import { ProviderError } from "./provider.js";

/** Convert only recognized raw errors at a transport boundary; never retain exception prose. */
export function networkProviderError(error: unknown, stage: ProviderNetworkStage): ProviderError | undefined {
  try { if (error instanceof ProviderError) return; } catch { return; }
  const failure = classifyNetworkFailure(error);
  if (failure.kind === "unknown" || failure.kind === "abort") return;
  return new ProviderError("upstream_unavailable", "Provider connection failed or disconnected; retry when its connection is available", 503, {
    event: "network", stage, ...(failure.code ? { code: failure.code } : {}), ...(failure.codes ? { networkCodes: failure.codes } : {}),
    ...(failure.kind === "transient" ? { retryableNetwork: true as const } : {}),
  });
}

import { networkCodesField } from "../provider-network.js";
import { telemetry } from "../telemetry.js";
import { networkProviderError } from "./network-error.js";
import { networkRetryExpired, networkRetryNow, networkRetrySleep, networkRetryWaitMs } from "./network-retry.js";
import { ProviderError } from "./provider.js";

/** Retry connection establishment only. A returned HTTP response and its body never enter this loop. */
export async function connectChatProvider(provider: string, signal: AbortSignal, send: () => Promise<Response>): Promise<Response> {
  let startedAt: number | undefined; let retries = 0;
  for (;;) {
    signal.throwIfAborted();
    try {
      const response = await send();
      if (startedAt !== undefined) telemetry("provider_connection_recovered", { provider, attempts: retries + 1,
        elapsedMs: networkRetryNow() - startedAt, httpStatus: response.status });
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      let failure: ProviderError | undefined;
      try { failure = error instanceof ProviderError ? error : networkProviderError(error, "connect"); } catch { throw error; }
      if (!failure || failure.upstream?.event !== "network" || failure.upstream.retryableNetwork !== true) throw failure ?? error;
      startedAt ??= networkRetryNow();
      const elapsedMs = networkRetryNow() - startedAt;
      const backoffMs = networkRetryWaitMs(retries, elapsedMs);
      if (backoffMs === undefined) throw failure;
      retries++;
      telemetry("provider_retry", { provider, attempt: retries + 1, code: failure.code, upstreamCode: failure.upstream.code,
        networkCodes: networkCodesField(failure.upstream.networkCodes), upstreamStage: "connect", backoffMs, elapsedMs });
      await networkRetrySleep(backoffMs, signal);
      if (signal.aborted || networkRetryExpired(startedAt)) throw failure;
    }
  }
}

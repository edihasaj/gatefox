import type { Message } from "./app-server-connection.js";
import { strictGatewayFeatureRequest, trimmedGatewayFeatures } from "./gateway-feature-schema.js";

/** The pinned SDK refused the request's configuration, which is how a feature value newer than its schema surfaces. */
export function isConfigLoadFailure(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === -32600 && error.message.startsWith("failed to load configuration");
}

/**
 * Send a gateway thread request. The static schema cannot know new enum values, the SDK's custom range checks or
 * future nested fields, so a configuration load failure that still has feature values beyond plain booleans is
 * retried once with the strict form (each feature is only its boolean `enabled`, or removed).
 *
 * A failed configuration load happens before the SDK creates or changes any thread, so the retry has no side
 * effects. If the retry fails too, the ORIGINAL error is the one that surfaces. The caller keeps its own request
 * accounting and compaction hooks: this runs inside them, so each runs once, and `params` returned here are the
 * ones the SDK accepted. Only thread start, resume and fork carry a config that is ever changed, so any other
 * request that fails is rethrown as it is.
 */
export async function sendWithStrictFeatureRetry(method: string, params: Message, send: (params: Message) => Promise<Message>): Promise<{ result: Message; params: Message }> {
  try { return { result: await send(params), params }; }
  catch (error) {
    if (!isConfigLoadFailure(error)) throw error;
    const strict = trimmedGatewayFeatures("retry", stats => strictGatewayFeatureRequest(method, params, stats));
    // Nothing to simplify: the same request would fail the same way.
    if (strict === params) throw error;
    try { return { result: await send(strict), params: strict }; }
    catch { throw error; }
  }
}

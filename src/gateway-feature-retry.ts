import type { Message } from "./app-server-connection.js";
import { strictGatewayFeatureRequest, trimmedGatewayFeatures } from "./gateway-feature-schema.js";

/**
 * The pinned SDK refused a feature setting in the request's configuration. Its message names the failing path
 * (``in `features` ``, ``in `features.multi_agent_v2` ``, ``in `profiles.w.features` ``). Any other configuration
 * failure, such as an unavailable cloud configuration bundle, is not about features and is never retried.
 */
const featurePath = /\bin `(?:features|profiles\.[^`]+\.features)(?:\.[^`]*)?`/;
export function isConfigLoadFailure(error: unknown): boolean {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== -32600) return false;
  const data = (error as { data?: unknown }).data;
  if (data && typeof data === "object" && (data as { reason?: unknown }).reason === "cloudConfigBundle") return false;
  return error.message.startsWith("failed to load configuration") && featurePath.test(error.message);
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

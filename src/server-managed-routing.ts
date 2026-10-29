import type { GatewayConfig } from "./config.js";
import type { ResponsesRequest } from "./protocol/types.js";
import type { InferenceContext } from "./providers/provider.js";
import type { AvailabilityService } from "./availability/service.js";
import type { ManagedRouter, ManagedRouteDecision } from "./managed-routing.js";
/** The explicit managed path alone starts collection; fixed aliases keep their original latency and semantics. */
export async function resolveManagedRequest(input: {
  config: GatewayConfig; request: ResponsesRequest; context: InferenceContext; router: ManagedRouter;
  availability: AvailabilityService; report: () => Record<string, unknown>; signal: AbortSignal;
}): Promise<ManagedRouteDecision | undefined> {
  if (!input.config.managedRouting || !Object.hasOwn(input.config.managedRouting.routes, input.request.model)) return;
  let timer: NodeJS.Timeout | undefined;
  const aborted = () => { rejectAbort?.(input.signal.reason); };
  let rejectAbort: ((reason: unknown) => void) | undefined;
  try {
    input.signal.throwIfAborted();
    const cancellation = new Promise<never>((_resolve, reject) => { rejectAbort = reject; input.signal.addEventListener("abort", aborted, { once: true }); });
    await Promise.race([input.availability.touch(input.config), new Promise<void>(resolve => { timer = setTimeout(resolve, 2500); }), cancellation]);
    input.signal.throwIfAborted();
    return await input.router.resolve(input.config, input.request, input.context, input.report());
  } finally { clearTimeout(timer); input.signal.removeEventListener("abort", aborted); }
}

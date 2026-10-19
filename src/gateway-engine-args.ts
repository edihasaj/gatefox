import type { Message } from "./app-server-connection.js";
import { readPublicServiceTierMetadata } from "./model-service-tiers.js";

/** The native engine's launch arguments with only the legacy gateway provider registered, so saved gateway chats still resolve it. */
export const nativeArguments = (args: string[], overrides: Message): string[] => [...args,
  ...Object.entries(overrides).flatMap(([key, value]) => ["-c", `model_providers.subscription_gateway.${key}=${JSON.stringify(value)}`])];

/** Whether any gateway row offers the priority (Fast) tier, which turns the SDK's fast_mode feature on for the executor. */
export function offersPriority(models: Message[]): boolean {
  return models.some(model => readPublicServiceTierMetadata(model).serviceTiers?.some(tier => tier.id === "priority"));
}

/** A caller's own fast_mode toggle is dropped when the catalog turns it on, since SDK toggles apply after -c overrides. */
export function gatewayFeatureArgs(args: string[], priority: boolean): string[] {
  if (!priority) return args;
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    // SDK feature toggles are appended after -c overrides, regardless of their CLI position.
    if (["--enable", "--disable"].includes(arg) && args[index + 1] === "fast_mode") { index++; continue; }
    if (["--enable=fast_mode", "--disable=fast_mode"].includes(arg)) continue;
    result.push(arg);
  }
  return result;
}

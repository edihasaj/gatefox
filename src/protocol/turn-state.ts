import { maxTurnStateLength } from "../providers/provider.js";

/** Longest upstream x-codex-turn-state the gateway wraps, so the wrapped value always fits the inbound limit. */
export const maxUpstreamTurnStateLength = 6000;
const printable = /^[\x21-\x7e]+$/;
const prefix = (scope: string) => `gts1:${scope.slice(0, 16)}:`;
const valid = (value: unknown): value is string => typeof value === "string" && value.length <= maxUpstreamTurnStateLength && printable.test(value);

/** Tags an opaque upstream turn-state with its account route; a value it cannot carry gives nothing. */
export function wrapTurnState(value: unknown, scope: string): string | undefined {
  return valid(value) ? `${prefix(scope)}${Buffer.from(value).toString("base64url")}` : undefined;
}

/** Restores a turn-state wrapped for this route. Another route's, malformed, or oversized values give nothing. */
export function unwrapTurnState(value: unknown, scope: string): string | undefined {
  if (typeof value !== "string" || value.length > maxTurnStateLength || !value.startsWith(prefix(scope))) return;
  const payload = value.slice(prefix(scope).length);
  const original = Buffer.from(payload, "base64url").toString("utf8");
  return payload && Buffer.from(original).toString("base64url") === payload && valid(original) ? original : undefined;
}

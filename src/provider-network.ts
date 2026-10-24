/**
 * Classifies only a deliberately small set of transport failures. This walker never
 * reads inherited properties or accessors: exception text and locations can contain
 * request data, credentials, or private network topology.
 */
export const transientNetworkCodes = [
  "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
] as const;
export const diagnosticNetworkCodes = [
  "ECONNREFUSED", "ENOTFOUND", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
] as const;
export type ProviderNetworkCode = typeof transientNetworkCodes[number] | typeof diagnosticNetworkCodes[number];
export type ProviderNetworkStage = "connect" | "stream" | "unknown";
export type NetworkFailureKind = "transient" | "diagnostic" | "abort" | "unknown";
export interface NetworkFailure { kind: NetworkFailureKind; code?: ProviderNetworkCode }

const transient = new Set<string>(transientNetworkCodes);
const diagnostic = new Set<string>(diagnosticNetworkCodes);
const abortCodes = new Set(["ABORT_ERR", "ERR_ABORTED", "ERR_CANCELED"]);
const maxDepth = 4;
const maxAggregateErrors = 8;
const maxNodes = 24;
const unknown: NetworkFailure = { kind: "unknown" };
type Data = { state: "absent" | "unreadable" } | { state: "value"; value: unknown };

/** Own data properties only. A hostile or revoked Proxy is therefore unknown. */
function data(value: unknown, key: string): Data {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return { state: "absent" };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { state: "absent" };
    return Object.hasOwn(descriptor, "value") ? { state: "value", value: descriptor.value } : { state: "unreadable" };
  } catch { return { state: "unreadable" }; }
}
function object(value: unknown): value is object | Function {
  return !!value && (typeof value === "object" || typeof value === "function");
}
function genericFetchFailure(value: object | Function): boolean {
  // Compatibility for Node fetch's fixed wrapper. The exact static value is never retained.
  const message = data(value, "message");
  try { return value instanceof TypeError && message.state === "value" && message.value === "fetch failed"; } catch { return false; }
}
function codeFailure(code: unknown): NetworkFailure | undefined {
  if (typeof code !== "string") return;
  if (transient.has(code)) return { kind: "transient", code: code as ProviderNetworkCode };
  if (diagnostic.has(code)) return { kind: "diagnostic", code: code as ProviderNetworkCode };
  if (abortCodes.has(code)) return { kind: "abort" };
}
function merge(results: NetworkFailure[]): NetworkFailure {
  if (results.some(result => result.kind === "abort")) return { kind: "abort" };
  // Keep a specific permanent class if there is one, even beside malformed siblings.
  const permanent = results.find(result => result.kind === "diagnostic");
  if (permanent) return permanent;
  if (!results.length || results.some(result => result.kind === "unknown")) return unknown;
  let common = results[0]!.code;
  for (const result of results.slice(1)) if (result.code !== common) common = undefined;
  return { kind: "transient", ...(common ? { code: common } : {}) };
}
function aggregateFailure(errors: unknown, depth: number, state: { seen: Set<unknown>; nodes: number }): NetworkFailure {
  try { if (!Array.isArray(errors)) return unknown; } catch { return unknown; }
  const length = data(errors, "length");
  if (length.state !== "value" || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 1 || length.value > maxAggregateErrors) return unknown;
  const results: NetworkFailure[] = [];
  for (let index = 0; index < length.value; index++) {
    const item = data(errors, String(index));
    if (item.state !== "value") results.push(unknown);
    else results.push(classify(item.value, depth + 1, state));
  }
  return merge(results);
}
function classify(value: unknown, depth: number, state: { seen: Set<unknown>; nodes: number }): NetworkFailure {
  if (!object(value) || depth >= maxDepth || state.seen.has(value) || ++state.nodes > maxNodes) return unknown;
  state.seen.add(value);
  const results: NetworkFailure[] = [];
  const code = data(value, "code");
  if (code.state === "unreadable") results.push(unknown);
  else if (code.state === "value") results.push(codeFailure(code.value) ?? unknown);
  const cause = data(value, "cause");
  if (cause.state === "unreadable") results.push(unknown);
  else if (cause.state === "value" && cause.value !== undefined) results.push(classify(cause.value, depth + 1, state));
  const errors = data(value, "errors");
  if (errors.state === "unreadable") results.push(unknown);
  else if (errors.state === "value") results.push(aggregateFailure(errors.value, depth, state));
  if (!results.length) return genericFetchFailure(value) ? { kind: "diagnostic" } : unknown;
  return merge(results);
}

/** Bounded, cycle-safe classification for raw fetch and body-reader failures. */
export function classifyNetworkFailure(error: unknown): NetworkFailure {
  const result = classify(error, 0, { seen: new Set(), nodes: 0 });
  // Preserve Node fetch's generic connection diagnosis without granting recovery
  // to an unknown nested failure or weakening recursive aggregate vetoes.
  return result.kind === "unknown" && object(error) && genericFetchFailure(error)
    ? { kind: "diagnostic" } : result;
}

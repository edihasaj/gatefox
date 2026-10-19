import { createHash } from "node:crypto";
import type { ProviderConfig } from "../config.js";
import { declaredResponsesTools, normalizeResponsesToolChoice, normalizeResponsesTools } from "../protocol/request.js";
import type { ResponseToolIdentity, ResponsesRequest, ResponsesTool } from "../protocol/types.js";
import { ProviderError } from "./provider.js";

type Item = Record<string, unknown>;
type StrictFlag = { present: boolean; value?: unknown };
type Binding = { identity: ResponseToolIdentity; wireName: string; alias: string; strict: StrictFlag };

export interface GrokToolBridge {
  body: ResponsesRequest;
  /** Restores a provider wire name before the standard Responses call validator runs. */
  restoreItem(item: Item): Item;
  /** xAI emits a function call for a caller custom tool, so its completed JSON envelope must be exact. */
  validCustomEnvelope(identity: ResponseToolIdentity, arguments_: string): boolean;
}

const record = (value: unknown): Item | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Item : undefined;
const identityKey = (identity: ResponseToolIdentity): string => JSON.stringify([identity.type, identity.namespace || "", identity.name]);
const invalidRequest = () => new ProviderError("invalid_request", "Grok request contains an invalid caller tool", 400);
const invalidCall = () => new ProviderError("invalid_tool_call", "Provider returned a tool outside the caller's catalog");

/**
 * xAI Responses supports function tools, but not Codex namespaces or custom
 * grammars. This is deliberately limited to the official xAI and OpenCode
 * Grok routes; generic Responses-compatible services retain their native wire.
 */
export function isGrokResponsesRoute(provider: Pick<ProviderConfig, "type" | "baseUrl">, model: unknown): boolean {
  if (provider.type !== "responses-api" || typeof model !== "string" || !/^grok-/.test(model)) return false;
  let url: URL;
  try { url = new URL(provider.baseUrl || ""); } catch { return false; }
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:") return false;
  if (url.origin === "https://api.x.ai") return /^\/v1\/?$/.test(url.pathname);
  return url.origin === "https://opencode.ai" && /^\/inference(?:\/go)?\/openai\/v1\/?$/.test(url.pathname);
}

function wireName(identity: ResponseToolIdentity): string {
  // A full SHA-256 base64url digest has only ASCII identifier characters and is
  // stable independently of catalog order, while staying below xAI's 64-char cap.
  return `grok_${createHash("sha256").update(identityKey(identity)).digest("base64url")}`;
}

function strictFlags(tools: ResponsesTool[]): Map<string, StrictFlag> {
  const result = new Map<string, StrictFlag>();
  const add = (source: unknown, namespace?: string) => {
    const tool = record(source); if (!tool || tool.type !== "function") return;
    const nested = record(tool.function);
    const definition = nested || tool;
    if (typeof definition.name !== "string") return;
    const identity: ResponseToolIdentity = { type: "function", name: definition.name, ...(namespace ? { namespace } : {}) };
    const owner = Object.hasOwn(definition, "strict") ? definition : tool;
    result.set(identityKey(identity), Object.hasOwn(owner, "strict") ? { present: true, value: owner.strict } : { present: false });
  };
  for (const source of tools) {
    const namespace = record(source);
    if (namespace?.type !== "namespace") { add(source); continue; }
    if (!Array.isArray(namespace.tools)) continue;
    const prefix = namespace.name === "functions" ? undefined : typeof namespace.name === "string" ? namespace.name : undefined;
    for (const child of namespace.tools) add(child, prefix);
  }
  return result;
}

function replayBinding(bindings: Map<string, Binding>, item: Item, type: ResponseToolIdentity["type"]): Binding {
  if (typeof item.name !== "string" || !item.name) throw invalidRequest();
  const rawNamespace = item.namespace;
  if (rawNamespace !== undefined && typeof rawNamespace !== "string") throw invalidRequest();
  const namespace = rawNamespace === "functions" ? undefined : rawNamespace;
  const identity: ResponseToolIdentity = { type, name: item.name, ...(namespace ? { namespace } : {}) };
  // History may contain a tool the caller removed or changed since its previous
  // turn. It still has to reach xAI under the identity it had when issued; only
  // fresh provider calls are limited to the active catalog below.
  return bindings.get(identityKey(identity)) || { identity, wireName: wireName(identity), alias: namespace ? `${namespace}.${identity.name}` : identity.name, strict: { present: false } };
}

function replayItem(item: Item, bindings: Map<string, Binding>): Item | undefined {
  if (item.type === "additional_tools") return;
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const binding = replayBinding(bindings, item, item.type === "custom_tool_call" ? "custom" : "function");
    const { namespace: _namespace, name: _name, input, arguments: arguments_, ...rest } = item;
    if (item.type === "custom_tool_call") {
      if (typeof input !== "string") throw invalidRequest();
      return { ...rest, type: "function_call", name: binding.wireName, arguments: JSON.stringify({ input }) };
    }
    if (typeof arguments_ !== "string") throw invalidRequest();
    return { ...rest, type: "function_call", name: binding.wireName, arguments: arguments_ };
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    const { namespace: _namespace, name: _name, ...rest } = item;
    return { ...rest, type: "function_call_output" };
  }
  return item;
}

/** Translate the caller's function/custom namespace catalog to xAI's function-only Responses subset. */
export function grokToolBridge(provider: Pick<ProviderConfig, "type" | "baseUrl">, request: ResponsesRequest, body: ResponsesRequest): GrokToolBridge | undefined {
  if (!isGrokResponsesRoute(provider, request.model)) return;
  // Use the already copy-on-write outgoing body, so collaboration's plaintext
  // schema normalization remains effective without ever mutating the caller.
  const declared = declaredResponsesTools(body);
  const strict = strictFlags(declared);
  const bindings = new Map<string, Binding>();
  const identities = new Map<string, Binding>();
  const aliases = new Map<string, Binding>();
  const definitions = normalizeResponsesTools(declared);
  const wireTools = definitions.map(definition => {
    const identity = definition.function.responseTool!;
    const binding: Binding = { identity, wireName: wireName(identity), alias: definition.function.name, strict: strict.get(identityKey(identity)) || { present: false } };
    const collision = bindings.get(binding.wireName);
    if (collision && identityKey(collision.identity) !== identityKey(identity)) throw invalidRequest();
    bindings.set(binding.wireName, binding); identities.set(identityKey(identity), binding); aliases.set(binding.alias, binding);
    // `normalizeResponsesTools` supplies the shared custom grammar description
    // and its `{input: string}` schema. Replace only the local alias and private
    // responseTool metadata with xAI's function wire definition.
    const { responseTool: _responseTool, name: _alias, ...wireDefinition } = definition.function;
    const description = typeof wireDefinition.description === "string" ? wireDefinition.description : "";
    // The hash is a transport identifier, not a useful name to a model. Keep
    // the caller-visible alias in the prompt so existing instructions such as
    // `functions.exec_command` retain their meaning after flattening.
    return { type: "function" as const, name: binding.wireName, ...wireDefinition,
      description: `Caller tool identity: ${binding.alias}${description ? `\n${description}` : ""}`,
      ...(binding.strict.present ? { strict: binding.strict.value } : {}) };
  });
  let toolChoice = body.tool_choice;
  const normalizedChoice = normalizeResponsesToolChoice(body.tool_choice);
  if (typeof normalizedChoice === "object") {
    const binding = aliases.get(normalizedChoice.function.name);
    if (!binding) throw invalidRequest();
    toolChoice = { type: "function", name: binding.wireName };
  } else if (normalizedChoice !== undefined) toolChoice = normalizedChoice;
  const input = Array.isArray(body.input) ? body.input.flatMap(source => {
    const item = record(source); if (!item) return [source];
    const transformed = replayItem(item, identities);
    return transformed === undefined ? [] : [transformed];
  }) as ResponsesRequest["input"] : body.input;
  const bridged: ResponsesRequest = { ...body, tools: wireTools, ...(input !== body.input ? { input } : {}), ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}) };
  return {
    body: bridged,
    restoreItem(item): Item {
      if (item.type !== "function_call") return item;
      if (typeof item.name !== "string" || !item.name || item.namespace !== undefined) throw invalidCall();
      const binding = bindings.get(item.name); if (!binding) throw invalidCall();
      return { ...item, name: binding.identity.name, ...(binding.identity.namespace ? { namespace: binding.identity.namespace } : {}) };
    },
    validCustomEnvelope(identity, arguments_): boolean {
      if (identity.type !== "custom") return true;
      try {
        const value = JSON.parse(arguments_);
        return record(value) !== undefined && typeof (value as Item).input === "string" && Object.keys(value as Item).length === 1;
      } catch { return false; }
    },
  };
}

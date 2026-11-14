import { createHash } from "node:crypto";
import { declaredResponsesTools, normalizeResponsesToolChoice, normalizeResponsesTools } from "../protocol/request.js";
import type { ResponseToolIdentity, ResponsesRequest, ResponsesTool } from "../protocol/types.js";
import { ProviderError } from "./provider.js";
import { recordToolIdentityFallback, toolIdentityFailure, type ToolIdentityFallback } from "./tool-identity.js";

type Item = Record<string, unknown>;
type StrictFlag = { present: boolean; value?: unknown };
type Binding = { identity: ResponseToolIdentity; wireName: string; alias: string; strict: StrictFlag };

export interface ResponsesFunctionToolBridge {
  body: ResponsesRequest;
  /** Restores a provider wire name before the standard Responses call validator runs. */
  restoreItem(item: Item): Item;
}

const record = (value: unknown): Item | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Item : undefined;
const identityKey = (identity: ResponseToolIdentity): string => JSON.stringify([identity.type, identity.namespace || "", identity.name]);
const invalidRequest = () => new ProviderError("invalid_request", "Responses request contains an invalid caller tool", 400);

const functionsPrefix = "functions.";
// Wire names are ASCII base64url. Fold only A-Z, so a non-ASCII letter such as the Kelvin sign (which `toLowerCase` maps to `k`)
// can never stand in for a wire-name character.
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32));

/**
 * Some models return the caller-visible alias (`exec_command`, `functions.exec_command`, `namespace.name`) or a differently
 * cased wire name instead of the opaque wire name. Accept such a name only when it selects exactly one declared tool, so an
 * undeclared or ambiguous name still fails. There is deliberately no fuzzy or edit-distance matching.
 */
function fallbackBinding(name: string, bindings: Map<string, Binding>): { binding: Binding; kind: ToolIdentityFallback } | undefined {
  // Gather every way the name could select a tool before deciding, so one spelling can never win over another: a name that is
  // the alias of one tool and a case variant of another tool's wire name is ambiguous, and so is `functions.<alias>` against
  // a tool whose literal alias starts with `functions.`.
  const candidates = new Map<Binding, ToolIdentityFallback>();
  const lower = asciiLower(name);
  const stripped = name.startsWith(functionsPrefix) ? name.slice(functionsPrefix.length) : undefined;
  for (const binding of bindings.values()) {
    if (binding.alias === name) candidates.set(binding, binding.identity.namespace ? "namespaced_alias" : "alias");
    else if (stripped !== undefined && binding.alias === stripped) candidates.set(binding, "functions_prefix");
    else if (asciiLower(binding.wireName) === lower) candidates.set(binding, "wire_case");
  }
  if (candidates.size !== 1) return;
  const [[binding, kind]] = candidates;
  return { binding, kind };
}

/** A custom tool has exactly one caller-visible string; extra fields would be discarded. */
export function validCustomFunctionEnvelope(identity: ResponseToolIdentity, arguments_: string): boolean {
  if (identity.type !== "custom") return true;
  try {
    const value = JSON.parse(arguments_);
    return record(value) !== undefined && typeof (value as Item).input === "string" && Object.keys(value as Item).length === 1;
  } catch { return false; }
}

function wireName(identity: ResponseToolIdentity, prefix: "grok" | "or"): string {
  // A full SHA-256 base64url digest has only ASCII identifier characters and is
  // stable independently of catalog order, while staying below the providers' 64-character cap.
  return `${prefix}_${createHash("sha256").update(identityKey(identity)).digest("base64url")}`;
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

function replayBinding(bindings: Map<string, Binding>, item: Item, type: ResponseToolIdentity["type"], prefix: "grok" | "or"): Binding {
  if (typeof item.name !== "string" || !item.name) throw invalidRequest();
  const rawNamespace = item.namespace;
  if (rawNamespace !== undefined && typeof rawNamespace !== "string") throw invalidRequest();
  const namespace = rawNamespace === "functions" ? undefined : rawNamespace;
  const identity: ResponseToolIdentity = { type, name: item.name, ...(namespace ? { namespace } : {}) };
  // History may contain a tool the caller removed or changed since its previous
  // turn. It still has to reach the provider under the identity it had when issued; only
  // fresh provider calls are limited to the active catalog below.
  return bindings.get(identityKey(identity)) || { identity, wireName: wireName(identity, prefix), alias: namespace ? `${namespace}.${identity.name}` : identity.name, strict: { present: false } };
}

function replayItem(item: Item, bindings: Map<string, Binding>, prefix: "grok" | "or"): Item | undefined {
  if (item.type === "additional_tools") return;
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const binding = replayBinding(bindings, item, item.type === "custom_tool_call" ? "custom" : "function", prefix);
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

/** Translate tools only after a provider-specific route has selected the function-only wire. */
export function responsesFunctionTools(body: ResponsesRequest, prefix: "grok" | "or"): ResponsesFunctionToolBridge {
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
    const binding: Binding = { identity, wireName: wireName(identity, prefix), alias: definition.function.name, strict: strict.get(identityKey(identity)) || { present: false } };
    const collision = bindings.get(binding.wireName);
    if (collision && identityKey(collision.identity) !== identityKey(identity)) throw invalidRequest();
    bindings.set(binding.wireName, binding); identities.set(identityKey(identity), binding); aliases.set(binding.alias, binding);
    // `normalizeResponsesTools` supplies the shared custom grammar description
    // and its `{input: string}` schema. Replace only the local alias and private
    // responseTool metadata with the provider's function wire definition.
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
    const transformed = replayItem(item, identities, prefix);
    return transformed === undefined ? [] : [transformed];
  }) as ResponsesRequest["input"] : body.input;
  const bridged: ResponsesRequest = { ...body, tools: wireTools, ...(input !== body.input ? { input } : {}), ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}) };
  // A call is restored when it is added and again when it is done; count each call once. The id is the provider's own and is
  // not validated until a call is done, so only a normal-sized id is remembered and only up to the tool-call limit; beyond
  // either bound the call still runs but is not counted, which keeps this set small whatever the provider sends.
  const counted = new Set<string>();
  const maxCountedIdLength = 1024, maxCountedCalls = 1024;
  return {
    body: bridged,
    restoreItem(item): Item {
      if (item.type !== "function_call") return item;
      if (typeof item.name !== "string" || !item.name) throw toolIdentityFailure("missing_tool_name");
      if (item.namespace !== undefined) throw toolIdentityFailure("unexpected_tool_namespace");
      let binding = bindings.get(item.name);
      if (!binding) {
        const matched = fallbackBinding(item.name, bindings); if (!matched) throw toolIdentityFailure("unknown_wire_tool");
        binding = matched.binding;
        const key = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined;
        if (key === undefined) recordToolIdentityFallback(matched.kind);
        else if (key.length <= maxCountedIdLength && !counted.has(key) && counted.size < maxCountedCalls) { counted.add(key); recordToolIdentityFallback(matched.kind); }
      }
      return { ...item, name: binding.identity.name, ...(binding.identity.namespace ? { namespace: binding.identity.namespace } : {}) };
    },
  };
}

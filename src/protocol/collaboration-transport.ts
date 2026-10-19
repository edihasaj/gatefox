const plaintextTools = new Set(["spawn_agent", "send_message", "followup_task"]);

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

type NamespaceRewrite = { changed: boolean; tools: unknown[] };

/**
 * Collaboration messages are executed by the caller, so translated providers
 * must receive their arguments as ordinary JSON rather than Codex ciphertext.
 * The caller's request is never modified.
 */
function plaintextNamespace(tool: unknown, alias?: string): unknown {
  const namespace = object(tool);
  if (!namespace || namespace.type !== "namespace" || namespace.name !== "collaboration") return tool;
  if (!Array.isArray(namespace.tools)) return alias ? { ...namespace, name: alias } : tool;
  let changed = alias !== undefined;
  const tools = namespace.tools.map(candidate => {
    const functionTool = object(candidate);
    if (!functionTool || functionTool.type !== "function" || typeof functionTool.name !== "string" || !plaintextTools.has(functionTool.name)) return candidate;
    const parameters = object(functionTool.parameters);
    const properties = object(parameters?.properties);
    const message = object(properties?.message);
    if (!message || !Object.hasOwn(message, "encrypted")) return candidate;
    changed = true;
    const plaintextMessage = { ...message };
    delete plaintextMessage.encrypted;
    return { ...functionTool, parameters: { ...parameters, properties: { ...properties, message: plaintextMessage } } };
  });
  return changed ? { ...namespace, ...(alias ? { name: alias } : {}), tools } : tool;
}

function rewriteNamespaces(tools: unknown[], alias?: string): NamespaceRewrite {
  let changed = false;
  const rewritten = tools.map(tool => {
    const next = plaintextNamespace(tool, alias);
    changed ||= next !== tool;
    return next;
  });
  return { changed, tools: rewritten };
}

function declaredNamespaces(body: JsonObject): Set<string> {
  const names = new Set<string>();
  const add = (tools: unknown) => {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      const namespace = object(tool);
      if (namespace?.type === "namespace" && typeof namespace.name === "string") names.add(namespace.name);
    }
  };
  add(body.tools);
  if (Array.isArray(body.input)) for (const item of body.input) {
    const lite = object(item);
    if (lite?.type === "additional_tools") add(lite.tools);
  }
  return names;
}

function rewriteInput(input: unknown[], alias?: string): { changed: boolean; input: unknown[] } {
  let changed = false;
  const rewritten = input.map(item => {
    const value = object(item);
    if (!value) return item;
    let next: JsonObject = value;
    if (value.type === "additional_tools" && Array.isArray(value.tools)) {
      const tools = rewriteNamespaces(value.tools, alias);
      if (tools.changed) next = { ...next, tools: tools.tools };
    }
    // Only replayed calls use a namespace field. Do not transform arbitrary
    // application data which happens to contain the same string.
    if (alias && ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(String(value.type))
      && value.namespace === "collaboration") next = { ...next, namespace: alias };
    changed ||= next !== value;
    return next;
  });
  return { changed, input: rewritten };
}

function transport<T extends JsonObject>(body: T, alias?: string): T {
  let changed = false;
  let tools = body.tools;
  if (Array.isArray(tools)) {
    const rewritten = rewriteNamespaces(tools, alias);
    if (rewritten.changed) { changed = true; tools = rewritten.tools; }
  }
  let input = body.input;
  if (Array.isArray(input)) {
    const rewritten = rewriteInput(input, alias);
    if (rewritten.changed) { changed = true; input = rewritten.input; }
  }
  let toolChoice = body.tool_choice;
  const choice = object(toolChoice);
  if (alias && choice && (choice.type === "function" || choice.type === "custom") && typeof choice.name === "string" && choice.namespace === "collaboration") {
    changed = true;
    toolChoice = { ...choice, namespace: alias };
  }
  return changed ? { ...body, ...(tools !== body.tools ? { tools } : {}), ...(input !== body.input ? { input } : {}), ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}) } : body;
}

/** Copy an outgoing Responses body while clearing only collaboration message encryption metadata. */
export function plaintextCollaborationTransport<T extends JsonObject>(body: T): T {
  return transport(body);
}

/**
 * The subscription backend reserves `collaboration`. Give the caller's
 * declaration a private wire name without changing its executor identity.
 */
export function subscriptionCollaborationTransport<T extends JsonObject>(body: T): { body: T; alias?: string } {
  const namespaces = declaredNamespaces(body);
  if (!namespaces.has("collaboration")) return { body: transport(body) };
  let alias = "gateway_collaboration";
  while (namespaces.has(alias)) alias += "_";
  return { body: transport(body, alias), alias };
}

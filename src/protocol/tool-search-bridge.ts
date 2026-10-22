import type { ResponsesInputItem, ResponsesRequest, ResponsesTool } from "./types.js";
import { webSearchPresence } from "./request.js";
import { telemetry } from "../telemetry.js";

type Data = Record<string, unknown>;
const data = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const isSearch = (tool: unknown) => data(tool) && tool.type === "tool_search";
/** Tool kinds a search may load; anything else in its result is left out. */
const loadable = new Set(["function", "custom", "namespace"]);
const flatName = (tool: unknown): string | undefined => {
  if (!data(tool) || tool.type === "namespace") return undefined;
  if (typeof tool.name === "string") return tool.name;
  return data(tool.function) && typeof tool.function.name === "string" ? tool.function.name : undefined;
};
const maxOutputText = 4000;

/** How many search declarations, replayed calls and outputs a bridged request carried, and how many tools it loaded. */
export interface ToolSearchBridgeCounts { tools: number; calls: number; outputs: number; loaded: number }
export interface ToolSearchBridge { request: ResponsesRequest; name: string; counts: ToolSearchBridgeCounts }

/**
 * Rewrites Codex's client-run `tool_search` into tool types the ChatGPT backend accepts on a shared subscription, which
 * refuses the `tool_search` type itself (`subscription_sharing_unsupported_capability`). The search still runs in the
 * client: the gateway only changes how it travels.
 *
 * - The `tool_search` tool becomes an ordinary function named `name` where it was declared (top level, or inside a
 *   Responses lite `additional_tools` item). `name` avoids every flat tool name the request declares or loaded.
 * - A replayed `tool_search_call` becomes a `function_call` of that function; its output becomes a `function_call_output`
 *   naming the loaded tools, and the tools themselves are declared again: in a new `additional_tools` item right after the
 *   output on a lite request, so the prompt before that point is unchanged, or appended to the top-level tools otherwise.
 *   A tool already declared is not declared twice, and `defer_loading` is removed because the bridge loads it explicitly.
 *
 * Codex sends the whole history every turn, so nothing is stored between requests.
 */
export function bridgeToolSearch(request: ResponsesRequest): ToolSearchBridge {
  const input = Array.isArray(request.input) ? request.input as unknown[] : undefined;
  const tools = Array.isArray(request.tools) ? request.tools as unknown[] : [];
  const taken = new Set<string>();
  // Children of the Responses default namespace `functions` are called unqualified, exactly like top-level tools, so their
  // names are taken too; any other namespace's children are called with their namespace and cannot collide.
  const note = (tool: unknown) => {
    if (data(tool) && tool.type === "namespace") { if (tool.name === "functions" && Array.isArray(tool.tools)) tool.tools.forEach(note); return; }
    const value = flatName(tool); if (value) taken.add(value);
  };
  tools.forEach(note);
  for (const item of input ?? []) if (data(item) && (item.type === "additional_tools" || item.type === "tool_search_output") && Array.isArray(item.tools)) item.tools.forEach(note);
  let name = "tool_search"; while (taken.has(name)) name += "_";
  const counts: ToolSearchBridgeCounts = { tools: 0, calls: 0, outputs: 0, loaded: 0 };
  let declared = false;
  // The first declaration becomes the function; a repeated one would declare the same name twice upstream.
  const convert = (list: unknown[]): unknown[] => list.flatMap(tool => {
    if (!isSearch(tool)) return [tool];
    counts.tools++; if (declared) return [];
    declared = true; const source = tool as Data;
    return [{ type: "function", name, description: typeof source.description === "string" ? source.description : "Search for more tools.",
      parameters: data(source.parameters) ? source.parameters : { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }];
  });
  const top = convert(tools);
  // Every tool the request already declares, by name, or by namespace and name for a namespace's children.
  const keys = new Set<string>([name]);
  const remember = (tool: unknown) => {
    if (!data(tool)) return;
    if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) { for (const child of tool.tools) { const child_ = flatName(child); if (child_) keys.add(`${tool.name}.${child_}`); } return; }
    const value = flatName(tool); if (value) keys.add(value);
  };
  top.forEach(remember);
  for (const item of input ?? []) if (data(item) && item.type === "additional_tools" && Array.isArray(item.tools)) item.tools.forEach(remember);
  // The backend requires a role on every `additional_tools` item (Codex sends `developer`); a new one copies the request's own.
  const declaration = (input ?? []).find(item => data(item) && item.type === "additional_tools") as Data | undefined;
  const lite = declaration !== undefined;
  const role = typeof declaration?.role === "string" ? declaration.role : "developer";
  const plain = (tool: Data): Data => { const { defer_loading: _deferred, ...rest } = tool; return rest; };
  /** The newly loaded part of a search result, and the names of everything it returned. */
  const load = (returned: unknown): { fresh: Data[]; names: string[] } => {
    const fresh: Data[] = [], names: string[] = [];
    for (const tool of Array.isArray(returned) ? returned : []) {
      if (!data(tool) || !loadable.has(String(tool.type))) continue;
      if (tool.type === "namespace") {
        if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) continue;
        const children = (tool.tools as unknown[]).filter(child => data(child) && loadable.has(String(child.type)) && child.type !== "namespace" && flatName(child));
        for (const child of children) names.push(`${tool.name}.${flatName(child)}`);
        const kept = children.filter(child => !keys.has(`${tool.name}.${flatName(child)}`)).map(child => plain(child as Data));
        kept.forEach(child => keys.add(`${tool.name}.${flatName(child)}`));
        if (kept.length) fresh.push({ ...plain(tool), tools: kept });
        continue;
      }
      const value = flatName(tool); if (!value) continue;
      names.push(value);
      if (!keys.has(value)) { keys.add(value); fresh.push(plain(tool)); }
    }
    counts.loaded += fresh.reduce((sum, tool) => sum + (tool.type === "namespace" ? (tool.tools as unknown[]).length : 1), 0);
    return { fresh, names };
  };
  const appended: Data[] = []; let orphans = 0;
  const rewritten = input?.flatMap((item): unknown[] => {
    if (!data(item)) return [item];
    if (item.type === "additional_tools" && Array.isArray(item.tools)) return [{ ...item, tools: convert(item.tools) }];
    // A search item without its call id cannot be paired; it carries nothing the next step needs.
    if (item.type === "tool_search_call") {
      if (typeof item.call_id !== "string" || !item.call_id) { orphans++; return []; }
      counts.calls++;
      const args = item.arguments;
      return [{ type: "function_call", call_id: item.call_id, name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) }];
    }
    if (item.type === "tool_search_output") {
      if (typeof item.call_id !== "string" || !item.call_id) { orphans++; return []; }
      counts.outputs++;
      const { fresh, names } = load(item.tools);
      const text = names.length ? `Loaded tools: ${names.join(", ")}` : "No matching tools were found.";
      const output = { type: "function_call_output", call_id: item.call_id, output: text.length > maxOutputText ? `${text.slice(0, maxOutputText - 3)}...` : text };
      if (!fresh.length) return [output];
      if (lite) return [output, { type: "additional_tools", role, tools: fresh }];
      appended.push(...fresh); return [output];
    }
    return [item];
  });
  if (!counts.tools && !counts.calls && !counts.outputs && !orphans) return { request, name, counts };
  return { name, counts, request: { ...request, tools: [...top, ...appended] as ResponsesTool[], ...(rewritten ? { input: rewritten as ResponsesInputItem[] } : {}) } };
}

/**
 * An upstream call of the bridge function, returned to the client as the `tool_search_call` it stands for, so the client
 * runs the search. `undefined` for any other item. Invalid arguments fail like any other malformed tool call.
 */
export function bridgedSearchCall(item: Data, name: string | undefined, defaultNamespace: string): Data | undefined {
  if (!name || item.type !== "function_call" || item.name !== name || (item.namespace !== undefined && item.namespace !== defaultNamespace)) return undefined;
  if (typeof item.call_id !== "string" || !item.call_id || item.call_id.length > 1024 || typeof item.arguments !== "string") throw new BridgeCallError();
  let args: unknown;
  try { args = JSON.parse(item.arguments); } catch { throw new BridgeCallError(); }
  if (!data(args)) throw new BridgeCallError();
  return { type: "tool_search_call", call_id: item.call_id, status: "completed", execution: "client", arguments: args };
}
/** Thrown for a malformed bridge call; the provider maps it to its own invalid tool call error. */
export class BridgeCallError extends Error { constructor() { super("Provider returned an invalid tool search call"); } }

/**
 * The part of `loaded` that `declared` does not already have: a flat tool by name, and a namespace's children by namespace
 * and name (a namespace left with no new child is dropped). The request's own declaration always wins.
 */
export function missingTools(loaded: unknown[], declared: unknown[]): unknown[] {
  const keys = new Set<string>();
  for (const tool of declared) {
    if (data(tool) && tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) { for (const child of tool.tools) { const value = flatName(child); if (value) keys.add(`${tool.name}.${value}`); } continue; }
    const value = flatName(tool); if (value) keys.add(value);
  }
  return loaded.flatMap(tool => {
    if (!data(tool)) return [];
    if (tool.type !== "namespace") { const value = flatName(tool); if (!value || keys.has(value)) return []; keys.add(value); return [tool]; }
    if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) return [];
    const kept = (tool.tools as unknown[]).filter(child => { const value = flatName(child); if (!value || keys.has(`${tool.name}.${value}`)) return false; keys.add(`${tool.name}.${value}`); return true; });
    return kept.length ? [{ ...tool, tools: kept }] : [];
  });
}

/** The search tools and items a request carries, at the top level and in `additional_tools` items. Counts only. */
export function toolSearchPresence(request: ResponsesRequest): { tools: number; items: number } {
  let tools = Array.isArray(request.tools) ? (request.tools as unknown[]).filter(isSearch).length : 0, items = 0;
  if (Array.isArray(request.input)) for (const item of request.input as unknown[]) {
    if (!data(item)) continue;
    if (item.type === "tool_search_call" || item.type === "tool_search_output") items++;
    if (item.type === "additional_tools" && Array.isArray(item.tools)) tools += item.tools.filter(isSearch).length;
  }
  return { tools, items };
}

/**
 * Records what a route that runs neither hosted web search nor tool search dropped from a request: `web_search_dropped`
 * and `tool_search_dropped`, counts only, each once per request and only when something was dropped.
 */
export function reportDroppedSearch(request: ResponsesRequest, provider: string): void {
  const web = webSearchPresence(request), search = toolSearchPresence(request);
  if (web.tools || web.items) telemetry("web_search_dropped", { provider, tools: web.tools, items: web.items });
  if (search.tools || search.items) telemetry("tool_search_dropped", { provider, tools: search.tools, items: search.items });
}

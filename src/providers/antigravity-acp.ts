import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { acpObject } from "./acp-connection.js";
import type { AcpDriver, AcpPermission, AcpSessionLimits, AcpTestHooks } from "./acp-driver.js";
import { frameGeminiPrompt } from "./gemini-acp.js";
import { geminiAcpFailure } from "./gemini-live-session.js";

/**
 * The Antigravity CLI half of a live Gemini session (`agy acp`), observed with CLI 1.5.14 on a Google AI Ultra account.
 *
 * - `agy acp` has no model flag. The model and its thinking level are `session/set_config_option` choices made right
 *   after `session/new` (`model`: `gemini-4-neon`, ...; `thought_level`: `low`, `medium`, `high`, `xhigh`).
 * - The gateway's instructions travel as `_meta.antigravity.systemPrompt.append` on `session/new`, which the CLI
 *   advertises in `initialize`.
 * - The caller's tools are the gateway's `http` MCP server from `session/new`, which the CLI names `mcp_gateway_<tool>`.
 *   It caches their schemas under `$HOME/.gemini/antigravity-cli/mcp/gateway/` and the model sometimes reads one with
 *   its native `read_file` before calling the tool; that read of the gateway's own catalog is the one native action the
 *   gateway allows.
 * - Every native action asks first (`toolPermission: "strict"`, antigravity-home.ts) and announces itself `in_progress`
 *   before it asks, so an announcement alone proves nothing ran. A refused call ends `failed`; only `completed` proves
 *   the CLI ran a tool of its own.
 */
export const antigravityLimits: AcpSessionLimits = { startMs: 60000, callQuietMs: 400, maxDenied: 25 };
export const antigravityTestHooks: AcpTestHooks = {};
export const antigravityEfforts = ["low", "medium", "high", "xhigh"] as const;

const prefix = "mcp_gateway_";
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const roots = [...new Set([tmpdir(), (() => { try { return realpathSync(tmpdir()); } catch { return tmpdir(); } })()])].map(root => root.replace(/\/+$/, ""));
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A tool schema the CLI cached from the gateway's MCP server, inside a gateway session's disposable home. */
const schemaFile = new RegExp(`^(?:${roots.map(escape).join("|")})/gateway-gemini-live-[A-Za-z0-9]+/home/\\.gemini/antigravity-cli/mcp/gateway/[A-Za-z0-9_.-]+$`);

/** The tool a frame names, from the CLI's structured `name`; the display `title` is model-shaped text and never counts. */
function identify(params: Record<string, unknown>): { name?: string; input: Record<string, unknown>; status?: string } {
  const nested = params.toolCall;
  const call = nested !== undefined && nested !== null && typeof nested === "object" ? acpObject(nested) : params;
  return { name: text(call.name), input: acpObject(call.rawInput ?? call.args), status: text(call.status) };
}
const callerTool = (name: string | undefined, catalog: ReadonlySet<string>): boolean =>
  !!name && name.startsWith(prefix) && catalog.has(name.slice(prefix.length));
export function antigravitySchemaRead(name: string | undefined, input: Record<string, unknown>): boolean {
  const path = text(input.Path);
  return name === "read_file" && !!path && !path.split("/").includes("..") && schemaFile.test(path);
}

function choose(params: Record<string, unknown>, kind: "allow_once" | "reject_once"): AcpPermission {
  const options = (Array.isArray(params.options) ? params.options : []).map(acpObject);
  const pick = options.find(option => option.kind === kind && typeof option.optionId === "string");
  return { allowed: kind === "allow_once" && !!pick, result: pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } } };
}

/** Allows a caller tool of this session's catalog and a read of the gateway's own cached schemas, once; refuses everything else. */
export function antigravityPermission(params: Record<string, unknown>, catalog: ReadonlySet<string>): AcpPermission {
  const { name, input } = identify(params);
  return callerTool(name, catalog) || antigravitySchemaRead(name, input) ? choose(params, "allow_once") : choose(params, "reject_once");
}

/** Ends the session when the CLI reports that it ran a tool of its own, which only a failed permission layer allows. */
export function antigravityToolGuard(update: Record<string, unknown>, catalog: ReadonlySet<string>): string | undefined {
  const { name, input, status } = identify(update);
  if (status !== "completed" || name === undefined || callerTool(name, catalog) || antigravitySchemaRead(name, input)) return undefined;
  return "invalid_tool_call";
}

export const antigravityDriver: AcpDriver = {
  label: "Gemini",
  extensions: [],
  limits: antigravityLimits,
  hooks: antigravityTestHooks,
  // No approval or permission-skipping flag is ever passed: every permission goes through the gateway.
  args: () => ["acp", "--disable-telemetry"],
  sessionParams: system => ({ _meta: { antigravity: { systemPrompt: { append: system } } } }),
  sessionConfig: ({ model, effort }) => [{ configId: "model", value: model }, { configId: "mode", value: "default" },
    ...(effort ? [{ configId: "thought_level", value: effort }] : [])],
  mcpServers: url => [{ type: "http", name: "gateway", url, headers: [] }],
  permission: antigravityPermission,
  // The CLI runs a prompt that starts with `/` as one of its own commands (`/schedule`, `/teamwork`, ...).
  framePrompt: frameGeminiPrompt,
  guardUpdate: antigravityToolGuard,
  failure: geminiAcpFailure,
};

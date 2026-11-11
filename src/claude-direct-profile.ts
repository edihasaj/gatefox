/**
 * The Claude Desktop profile for a gateway that serves the app itself. Its rows come from the gateway's own
 * Anthropic model list, so the same command works against a local gateway and a forwarded one, and a row can
 * only name an ID that gateway resolves. Nothing here reads provider configuration or credentials.
 */
import { isAbsolute } from "node:path";
import { applyCredentialHelper, boundedMaxEffort, claudeDesktopProfileName, claudeDesktopProfileNames, bridgeRouteBase, existingModelMetadata, recordedCap, recordedNativeCap, variantEffortOrder,
  type CredentialHelper, type VariantEffort } from "./claude-desktop-profile.js";

/** Claude Desktop accepts at most this many rows in a profile's model list. */
const maxProfileModelRows = 200;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bridgeId = /^claude-opus-5\[hg-route-[0-9]{1,20}\]$/;
/** An `sshHostAllowlist` entry: a hostname, a `*.` wildcard or an IP address, as Claude Desktop matches them. */
const sshHostEntry = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$|^[0-9a-fA-F:.]{2,45}$/;
function fail(message: string): never { throw new Error(message); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Claude Desktop's own test for an endpoint an SSH host cannot reach: a literal loopback name or address, nothing resolved. */
export function isLoopbackEndpointHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::" || host === "0.0.0.0" || host === "::ffff:0:0"
    || /^127(\.\d{1,3}){1,3}$/.test(host) || /^::ffff:7f[0-9a-f]{2}:/.test(host);
}

/** The allowlist Claude Desktop reads, checked entry by entry. Matching ignores case, so entries are kept lower-case and unique. */
export function claudeSshHostAllowlist(hosts: string[]): string[] {
  const entries = [...new Set(hosts.map(host => host.trim().toLowerCase()))];
  if (!entries.length) fail("--ssh-host needs at least one host");
  for (const entry of entries) {
    if (entry === "*") fail("--ssh-host * would send the gateway token to any host; name each host instead");
    if (entry.length > 253 || !sshHostEntry.test(entry)) fail(`--ssh-host ${entry} is not a hostname, *.domain wildcard or IP address`);
  }
  return entries;
}

export interface ClaudeDirectListRow { id: string; displayName: string; alias?: string; native: boolean; efforts: VariantEffort[]; bridgeId?: string }

/** Reads a gateway's Anthropic model list. The list may come over a forward, so every field is checked. */
export function claudeDirectListRows(value: unknown): ClaudeDirectListRow[] {
  if (!record(value) || value.type !== "list" || !Array.isArray(value.data)) {
    fail("This gateway does not list Claude Desktop models; update it, or keep using the adapter profile");
  }
  const seen = new Set<string>();
  const rows = value.data.map((entry): ClaudeDirectListRow => {
    const row = record(entry) ? entry : fail("Gateway model list has an invalid row");
    const details = record(row.gatefox) ? row.gatefox : fail("Gateway model list rows carry no gatefox details; update the gateway");
    if (typeof row.id !== "string" || !modelId.test(row.id) || /gpt|qwen/i.test(row.id)) fail("Gateway model list has an ID Claude Desktop would refuse");
    if (typeof row.display_name !== "string" || !row.display_name.trim() || row.display_name.length > 256) fail(`Gateway model ${row.id} has no usable display name`);
    const efforts = Array.isArray(details.efforts) ? details.efforts : fail(`Gateway model ${row.id} has no effort list`);
    if (efforts.some(effort => !(variantEffortOrder as readonly unknown[]).includes(effort))) fail(`Gateway model ${row.id} lists an unknown effort`);
    if (details.bridge_id !== undefined && (typeof details.bridge_id !== "string" || !bridgeId.test(details.bridge_id))) fail(`Gateway model ${row.id} has an invalid bridge ID`);
    for (const id of [row.id, details.bridge_id]) if (typeof id === "string") { if (seen.has(id)) fail(`Gateway model ID ${id} is listed twice`); seen.add(id); }
    return { id: row.id, displayName: row.display_name, native: details.native === true, efforts: variantEffortOrder.filter(effort => efforts.includes(effort)),
      ...(typeof details.alias === "string" ? { alias: details.alias } : {}), ...(typeof details.bridge_id === "string" ? { bridgeId: details.bridge_id } : {}) };
  });
  if (!rows.length) fail("This gateway lists no models for Claude Desktop");
  return rows;
}

export interface ClaudeDirectProfileOptions {
  /** The gateway origin Claude Desktop connects to. */
  endpoint: string;
  tokenFile: string;
  credentialHelper?: CredentialHelper;
  /** Keep the opaque row ID and name the recognized model in `behavesAs`, for an app that reads it. */
  nativeModelMetadata?: boolean;
  /** The row listed first, by its ID, bridge ID or gateway alias. */
  defaultModel?: string;
  /**
   * SSH hosts Claude Desktop may start Code sessions on. Absent keeps the profile's own `sshHostAllowlist`. The remote host
   * calls the endpoint itself, so a list needs an endpoint that host can reach.
   */
  sshHosts?: string[];
}

const names = (row: ClaudeDirectListRow): string[] => [row.id, ...(row.bridgeId ? [row.bridgeId] : [])];

/** Builds the profile without reading or writing a file. Settings unrelated to the gateway are kept. */
export function buildClaudeDirectProfile(existingProfile: Record<string, unknown>, rows: ClaudeDirectListRow[], options: ClaudeDirectProfileOptions): Record<string, unknown> {
  if (!isAbsolute(options.tokenFile)) fail("Claude Desktop tokenFile must be an absolute path");
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { fail("Gateway endpoint must be a valid URL"); }
  if (endpoint.protocol !== "http:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") fail("Gateway endpoint must be a plain http:// origin");
  const sshHosts = options.sshHosts === undefined ? undefined : claudeSshHostAllowlist(options.sshHosts);
  if (sshHosts && isLoopbackEndpointHost(endpoint.hostname)) {
    fail("Claude Desktop refuses a loopback gateway for SSH sessions, because the remote host cannot reach it; use --tailnet so the profile names this Mac's Tailscale address");
  }
  if (rows.length > maxProfileModelRows) fail(`Claude Desktop allows at most ${maxProfileModelRows} model rows, but this gateway lists ${rows.length}; hide or remove models in the gateway`);
  const oldMetadata = existingModelMetadata(existingProfile);
  const previous = Array.isArray(existingProfile.inferenceModels) && record(existingProfile.inferenceModels[0]) ? existingProfile.inferenceModels[0].name : undefined;
  const first = options.defaultModel === undefined
    // Re-running keeps the model the profile already starts with, when the gateway still lists it.
    ? rows.find(row => typeof previous === "string" && names(row).includes(previous))
    : rows.find(row => names(row).includes(options.defaultModel!) || row.alias === options.defaultModel) ?? fail(`--model ${options.defaultModel} is not a model this gateway lists`);
  const ordered = first ? [first, ...rows.filter(row => row !== first)] : rows;
  const nativeMetadata = options.nativeModelMetadata === true;
  const entries = ordered.map(row => {
    if (row.native) {
      const prior = oldMetadata.get(row.id);
      const entry: Record<string, unknown> = { name: row.id, labelOverride: row.displayName };
      for (const key of ["anthropicFamilyTier", "isFamilyDefault"]) if (prior && Object.hasOwn(prior, key)) entry[key] = prior[key];
      const maxEffort = boundedMaxEffort(recordedCap(oldMetadata, row.id), row.efforts);
      return maxEffort === undefined ? entry : { ...entry, maxEffort };
    }
    if (!row.efforts.length || !row.bridgeId) return { name: row.id, labelOverride: row.displayName };
    // A cap set on this row, or on the row the other mode wrote for the same route, survives.
    const prior = nativeMetadata ? recordedNativeCap(oldMetadata, row.id) ?? recordedCap(oldMetadata, row.bridgeId) : recordedCap(oldMetadata, row.bridgeId) ?? recordedNativeCap(oldMetadata, row.id);
    const entry: Record<string, unknown> = { name: nativeMetadata ? row.id : row.bridgeId, labelOverride: row.displayName };
    const maxEffort = boundedMaxEffort(prior, row.efforts);
    if (maxEffort !== undefined) entry.maxEffort = maxEffort;
    if (nativeMetadata) entry.behavesAs = bridgeRouteBase;
    return entry;
  });
  const profile: Record<string, unknown> = structuredClone(existingProfile);
  // The app shows this name in its account menu. A profile still named Harness Gateway, or unnamed, becomes GateFox; a name the user chose is kept.
  if (profile.deploymentDisplayName === undefined || claudeDesktopProfileNames.includes(String(profile.deploymentDisplayName))) profile.deploymentDisplayName = claudeDesktopProfileName;
  profile.inferenceGatewayBaseUrl = endpoint.origin;
  profile.modelDiscoveryEnabled = false;
  profile.alwaysStartWithDefaultModel = true;
  profile.inferenceModels = entries;
  if (sshHosts) profile.sshHostAllowlist = sshHosts;
  applyCredentialHelper(profile, options.credentialHelper, options.tokenFile);
  return profile;
}

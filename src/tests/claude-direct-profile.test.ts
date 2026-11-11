import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gatewayToken, validateConfig } from "../config.js";
import { applyClaudeDesktopDirectProfile, claudeDesktopPaths, readSelectedClaudeDesktopProfile } from "../claude-desktop-files.js";
import { bridgeRouteName, stableRouteNumber } from "../claude-desktop-profile.js";
import { buildClaudeDirectProfile, claudeDirectListRows, type ClaudeDirectListRow } from "../claude-direct-profile.js";
import { claudeDirectModelList, claudeDirectSurface } from "../claude-direct.js";
import { startGateway } from "../server.js";
import type { Provider } from "../providers/provider.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const opaque = (alias: string) => `claude-hg-route-${stableRouteNumber(alias)}`;
const options = { endpoint: "http://127.0.0.1:3457", tokenFile: "/private/state/client-token" };
const rows: ClaudeDirectListRow[] = [
  { id: opaque("codex/gpt"), displayName: "Codex · GPT X", alias: "codex/gpt", native: false, efforts: ["low", "medium", "high"], bridgeId: bridgeRouteName("codex/gpt") },
  { id: "claude-fable-5-1", displayName: "Claude · Fable 5.1", alias: "claude/claude-fable-5-1", native: true, efforts: ["low", "high", "max"] },
  { id: opaque("qwen/flash"), displayName: "Local · Qwen", alias: "qwen/flash", native: false, efforts: [] },
];
const providers = (state: string) => [
  { id: "codex", type: "codex-subscription", label: "Codex", credentialFile: join(state, "unused"), models: { "codex/gpt": "gpt-x" }, modelMetadata: { "codex/gpt": { displayName: "GPT X", reasoningEfforts: ["low", "medium", "high"] } } },
  { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/claude-fable-5-1": "claude-fable-5-1" } },
  { id: "qwen", type: "chat-completions-api", label: "Local", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TEST_UNUSED_KEY", models: { "qwen/flash": "qwen-flash" } },
];

test("a direct profile points at the gateway and lists one row per model, in the gateway's order", () => {
  const existing = { retained: { kept: true }, inferenceGatewayBaseUrl: "http://127.0.0.1:3467", modelDiscoveryEnabled: true, inferenceModels: [{ name: "claude-fable-5-1", anthropicFamilyTier: "fable", isFamilyDefault: true, maxEffort: "high" }] };
  const before = structuredClone(existing);
  const profile = buildClaudeDirectProfile(existing, rows, { ...options, credentialHelper: { command: "/bin/gateway", args: ["token"] } });
  assert.deepEqual(existing, before);
  assert.deepEqual(profile.retained, { kept: true });
  assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:3457"); assert.equal(profile.modelDiscoveryEnabled, false); assert.equal(profile.alwaysStartWithDefaultModel, true);
  assert.equal(profile.inferenceCredentialHelper, "/bin/gateway"); assert.deepEqual(profile.inferenceCredentialHelperArgs, ["token", "--file", options.tokenFile]);
  // The model the profile already started with stays first, with its family fields and its lower cap.
  assert.deepEqual(profile.inferenceModels, [
    { name: "claude-fable-5-1", labelOverride: "Claude · Fable 5.1", anthropicFamilyTier: "fable", isFamilyDefault: true, maxEffort: "high" },
    { name: bridgeRouteName("codex/gpt"), labelOverride: "Codex · GPT X", maxEffort: "high" },
    { name: opaque("qwen/flash"), labelOverride: "Local · Qwen" },
  ]);
  assert.equal(JSON.stringify(profile.inferenceModels).match(/"name":"[^"]*(gpt|qwen)/i), null);
});

test("native metadata keeps opaque IDs, and a cap survives a change of mode in both directions", () => {
  const native = buildClaudeDirectProfile({}, rows, { ...options, nativeModelMetadata: true });
  assert.deepEqual((native.inferenceModels as unknown[])[0], { name: opaque("codex/gpt"), labelOverride: "Codex · GPT X", maxEffort: "high", behavesAs: "claude-opus-5" });
  assert.deepEqual((native.inferenceModels as unknown[])[2], { name: opaque("qwen/flash"), labelOverride: "Local · Qwen" });
  const capped = { inferenceModels: [{ name: bridgeRouteName("codex/gpt"), maxEffort: "low" }] };
  const migrated = buildClaudeDirectProfile(capped, rows, { ...options, nativeModelMetadata: true });
  assert.equal((migrated.inferenceModels as any[])[0].maxEffort, "low");
  assert.equal((buildClaudeDirectProfile(migrated, rows, options).inferenceModels as any[])[0].maxEffort, "low");
  // An old opaque row's automatic `high` was never a choice, so it caps nothing.
  const automatic = buildClaudeDirectProfile({ inferenceModels: [{ name: opaque("codex/gpt"), maxEffort: "low" }] }, rows, options);
  assert.equal((automatic.inferenceModels as any[])[0].maxEffort, "high");
});

test("the default model is chosen by ID, bridge ID or alias, and invalid input is refused", () => {
  for (const model of ["qwen/flash", opaque("qwen/flash")]) assert.equal((buildClaudeDirectProfile({}, rows, { ...options, defaultModel: model }).inferenceModels as any[])[0].name, opaque("qwen/flash"));
  assert.equal((buildClaudeDirectProfile({}, rows, { ...options, defaultModel: bridgeRouteName("codex/gpt") }).inferenceModels as any[])[0].labelOverride, "Codex · GPT X");
  assert.throws(() => buildClaudeDirectProfile({}, rows, { ...options, defaultModel: "missing" }), /not a model this gateway lists/);
  assert.throws(() => buildClaudeDirectProfile({}, rows, { ...options, endpoint: "http://127.0.0.1:3457/v1" }), /plain http:\/\/ origin/);
  assert.throws(() => buildClaudeDirectProfile({}, rows, { ...options, tokenFile: "relative" }), /absolute/);
  const many = Array.from({ length: 201 }, (_, index) => ({ ...rows[2]!, id: `claude-hg-route-${index}` }));
  assert.throws(() => buildClaudeDirectProfile({}, many, options), /at most 200 model rows, but this gateway lists 201/);
});

test("a model list is read strictly, and the gateway's own list round-trips", () => {
  const config = validateConfig({ version: 1, port: 3457, stateDirectory: "/tmp/claude-direct-profile-test", providers: providers("/tmp/claude-direct-profile-test") });
  const parsed = claudeDirectListRows(JSON.parse(JSON.stringify(claudeDirectModelList(claudeDirectSurface(config)))));
  assert.deepEqual(parsed.map(row => [row.id, row.alias, row.native, row.efforts, row.bridgeId]), [
    ["claude-fable-5-1", "claude/claude-fable-5-1", true, [], undefined],
    [opaque("codex/gpt"), "codex/gpt", false, ["low", "medium", "high"], bridgeRouteName("codex/gpt")], [opaque("qwen/flash"), "qwen/flash", false, [], undefined]]);
  const row = { id: "claude-hg-route-1", type: "model", display_name: "One", gatefox: { native: false, efforts: [] } };
  // An older gateway answers with its alias list, which is not a Claude Desktop list.
  assert.throws(() => claudeDirectListRows({ object: "list", data: [{ id: "codex/gpt", object: "model" }] }), /does not list Claude Desktop models/);
  assert.throws(() => claudeDirectListRows({ type: "list", data: [] }), /lists no models/);
  for (const [bad, message] of [
    [{ ...row, id: "claude-gpt-route" }, /would refuse/], [{ ...row, id: "codex/gpt" }, /would refuse/], [{ ...row, display_name: " " }, /display name/],
    [{ ...row, gatefox: undefined }, /gatefox details/], [{ ...row, gatefox: { efforts: ["ultra"] } }, /unknown effort/],
    [{ ...row, gatefox: { efforts: [], bridge_id: "claude-opus-5[x]" } }, /bridge ID/],
  ] as const) assert.throws(() => claudeDirectListRows({ type: "list", data: [bad] }), message);
  assert.throws(() => claudeDirectListRows({ type: "list", data: [row, row] }), /listed twice/);
});

async function home() {
  const root = await mkdtemp(join(tmpdir(), "gateway-claude-direct-cli-"));
  const paths = claudeDesktopPaths(join(root, "home"));
  await mkdir(paths.library, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.library, "_meta.json"), JSON.stringify({ appliedId: "gateway", entries: [{ id: "gateway", name: "GateFox" }] }), { mode: 0o600 });
  await writeFile(join(paths.library, "gateway.json"), JSON.stringify({ retained: true, inferenceGatewayBaseUrl: "http://127.0.0.1:3467" }), { mode: 0o600 });
  return { root, paths, home: join(root, "home") };
}

test("configure --direct reads a running gateway and writes only a candidate profile", async () => {
  const f = await home();
  const state = join(f.root, "state"); await mkdir(state, { mode: 0o700 });
  const provider: Provider = { async *infer() { yield { type: "done", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }; } };
  const server = await startGateway(validateConfig({ version: 1, port: 0, stateDirectory: state, providers: providers(state) }), () => provider, undefined, { onFailure() {} });
  try {
    const port = (server.address() as { port: number }).port;
    const token = await gatewayToken(state);
    const gatewayConfig = join(f.root, "gateway.json");
    await writeFile(gatewayConfig, JSON.stringify({ version: 1, port, stateDirectory: state, providers: providers(state) }), { mode: 0o600 });
    const source = await readFile(gatewayConfig, "utf8");
    const { stdout } = await run(process.execPath, [cli, "claude-desktop", "configure", "--direct", "--gateway-config", gatewayConfig, "--home", f.home, "--model", "claude-fable-5-1"]);
    const output = JSON.parse(stdout) as { candidate: { desktopProfilePath: string; adapterConfigPath?: string }; applied: boolean; direct: boolean; endpoint: string; models: number };
    assert.deepEqual([output.applied, output.direct, output.endpoint, output.models, output.candidate.adapterConfigPath], [false, true, `http://127.0.0.1:${port}`, 3, undefined]);
    const profile = JSON.parse(await readFile(output.candidate.desktopProfilePath, "utf8"));
    assert.equal(profile.retained, true); assert.equal(profile.inferenceGatewayBaseUrl, `http://127.0.0.1:${port}`);
    assert.deepEqual(profile.inferenceModels.map((row: any) => row.name), ["claude-fable-5-1", bridgeRouteName("codex/gpt"), opaque("qwen/flash")]);
    assert.deepEqual(profile.inferenceCredentialHelperArgs.slice(-3), ["token", "--file", join(state, "client-token")]);
    assert.equal(JSON.stringify(profile).includes(token), false, "the token is never written into the profile");
    // Every row is an ID that same gateway serves, and nothing but the candidate was written.
    for (const row of profile.inferenceModels) {
      const detail = await fetch(`http://127.0.0.1:${port}/v1/models/${encodeURIComponent(row.name)}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(detail.status, 200, row.name);
    }
    assert.equal(await readFile(gatewayConfig, "utf8"), source);
    assert.deepEqual(JSON.parse(await readFile(join(f.paths.library, "gateway.json"), "utf8")), { retained: true, inferenceGatewayBaseUrl: "http://127.0.0.1:3467" });
    assert.deepEqual(await readdir(join(f.paths.root, "alias-trial", "candidate")), ["desktop-profile.json"]);
    await assert.rejects(stat(f.paths.adapterRoot)); await assert.rejects(stat(f.paths.backupRoot));
    // The same rows over an explicit endpoint, as a forwarded gateway is named.
    const remote = JSON.parse((await run(process.execPath, [cli, "claude-desktop", "configure", "--direct", "--endpoint", `http://127.0.0.1:${port}/v1`, "--token-file", join(state, "client-token"), "--home", f.home, "--native-model-metadata"])).stdout);
    assert.equal(JSON.parse(await readFile(remote.candidate.desktopProfilePath, "utf8")).inferenceModels[0].behavesAs, "claude-opus-5");
    await assert.rejects(run(process.execPath, [cli, "claude-desktop", "configure", "--direct", "--gateway-config", gatewayConfig, "--home", f.home, "--port", "3467"]), /belong to the adapter profile/);
  } finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
});

test("a direct profile is applied alone, with a backup, and never while the app runs", async () => {
  const f = await home();
  const existing = await readSelectedClaudeDesktopProfile(f.paths.library);
  const profile = buildClaudeDirectProfile(existing.profile, rows, options);
  const apply = (appNotRunning: () => boolean) => applyClaudeDesktopDirectProfile({ library: f.paths.library, backupRoot: f.paths.backupRoot, profile, expectedProfile: existing, protectedPaths: [], appNotRunning });
  await assert.rejects(apply(() => false), /Quit Claude Desktop/);
  const applied = await apply(() => true);
  assert.equal(applied.desktopProfilePath, existing.profilePath); assert.equal("adapterConfigPath" in applied, false);
  const written = JSON.parse(await readFile(existing.profilePath, "utf8"));
  assert.equal(written.inferenceGatewayBaseUrl, "http://127.0.0.1:3457"); assert.equal(written.inferenceModels.length, 3);
  assert.deepEqual(JSON.parse(await readFile(join(applied.backupDirectory, "desktop-profile.json"), "utf8")), existing.profile);
  assert.deepEqual(await readdir(applied.backupDirectory), ["desktop-profile.json"]);
  await assert.rejects(stat(f.paths.adapterRoot));
  // The snapshot no longer matches, so a stale candidate cannot be applied over the new profile.
  await assert.rejects(apply(() => true), /selected profile changed/);
});

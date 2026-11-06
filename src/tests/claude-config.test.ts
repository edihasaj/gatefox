import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeSettings, quotePosixShellArg, remoteClaudeSettings } from "../claude-config.js";

const run = promisify(execFile);
const token = "a".repeat(32);

test("Claude settings normalize the SDK endpoint and reject unsafe endpoints", () => {
  const settings = JSON.parse(claudeSettings("codex/sol", "https://gateway.example/v1/", ["--file", "/tmp/client-token"])) as Record<string, unknown>;
  assert.equal((settings.env as Record<string, string>).ANTHROPIC_BASE_URL, "https://gateway.example");
  assert.equal(settings.model, "codex/sol");
  assert.equal(Object.hasOwn(settings, "permissions"), false);
  assert.equal(JSON.stringify(settings).includes(token), false);
  assert.throws(() => claudeSettings("codex/sol", "http://gateway.example/v1", []), /Endpoint requires HTTPS/);
  assert.throws(() => claudeSettings("codex/sol", "https://user:pass@gateway.example/v1", []), /Endpoint requires HTTPS/);
});

test("apiKeyHelper preserves each credential argv element through POSIX parsing", async () => {
  const values = ["--file", "/tmp/a path/'quote'\nnewline", "$(not-executed); & | < >"];
  const command = `set -- ${values.map(quotePosixShellArg).join(" ")}; printf '%s\\0' "$@"`;
  const { stdout } = await run("/bin/sh", ["-c", command]);
  assert.deepEqual(stdout.split("\0").slice(0, -1), values);

  const settings = JSON.parse(claudeSettings("codex/sol", "https://gateway.example/v1", values)) as { apiKeyHelper: string };
  for (const value of values) assert.ok(settings.apiKeyHelper.includes(quotePosixShellArg(value)));
});

async function remoteFixture(body: string, status = 200, headers: Record<string, string> = {}) {
  const requests: Array<{ authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization });
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { endpoint: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("remote Claude settings authenticate and validate the bounded public catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-config-"));
  const tokenFile = join(directory, "client-token");
  await writeFile(tokenFile, token, { mode: 0o600 }); await chmod(tokenFile, 0o600);
  const remote = await remoteFixture(JSON.stringify({ models: [{ slug: "codex/sol" }] }));
  try {
    const settings = JSON.parse(await remoteClaudeSettings("codex/sol", remote.endpoint, tokenFile)) as { env: { ANTHROPIC_BASE_URL: string }; apiKeyHelper: string };
    assert.equal(remote.requests[0].authorization, `Bearer ${token}`);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, remote.endpoint.slice(0, -3));
    assert.ok(settings.apiKeyHelper.includes("--file"));
    assert.equal(settings.apiKeyHelper.includes(token), false);
    await assert.rejects(remoteClaudeSettings("missing", remote.endpoint, tokenFile), /Selected model/);
  } finally { await remote.close(); }
});

test("remote Claude settings reject redirects, malformed catalogs, and catalogs over 1 MiB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-config-"));
  const tokenFile = join(directory, "client-token");
  await writeFile(tokenFile, token, { mode: 0o600 }); await chmod(tokenFile, 0o600);
  const malformed = await remoteFixture(JSON.stringify({ models: [{ slug: "same" }, { slug: "same" }] }));
  const oversized = await remoteFixture("x".repeat(1024 * 1024 + 1), 200, { "content-length": String(1024 * 1024 + 1) });
  const redirect = await remoteFixture("", 302, { location: "https://example.test/model-catalog" });
  try {
    await assert.rejects(remoteClaudeSettings("same", malformed.endpoint, tokenFile), /valid remote catalog/);
    await assert.rejects(remoteClaudeSettings("same", oversized.endpoint, tokenFile), /exceeds 1 MiB/);
    await assert.rejects(remoteClaudeSettings("same", redirect.endpoint, tokenFile));
  } finally { await Promise.all([malformed.close(), oversized.close(), redirect.close()]); }
});

const catalog = { models: [
  { slug: "codex/sol", display_name: "Codex · Sol", description: "account route codex", visibility: "list", context_window: 500000 },
  { slug: "codex/retired", display_name: "Codex · Retired", visibility: "hide", context_window: 272000 },
  { slug: "qwen/flash", display_name: "Qwen · Flash", visibility: "list", context_window: 32768 },
] };
const generated = (model: string) => JSON.parse(claudeSettings(model, "http://127.0.0.1:3457/v1", ["--file", "/tmp/client-token"], catalog)) as {
  env: Record<string, string>; modelPicker: { replaceBuiltInOptions: boolean; options: Array<{ model: string; label?: string; description?: string }> } };

test("Claude settings list what the gateway serves, because discovery drops non-Claude IDs", () => {
  const { modelPicker } = generated("codex/sol");
  assert.equal(modelPicker.replaceBuiltInOptions, true);
  assert.deepEqual(modelPicker.options, [{ model: "codex/sol", label: "Codex · Sol", description: "account route codex" }, { model: "qwen/flash", label: "Qwen · Flash" }]);
  assert.deepEqual(generated("codex/retired").modelPicker.options.map(row => row.model), ["codex/sol", "codex/retired", "qwen/flash"], "a hidden launch model stays selectable");
});

test("Claude settings declare a known context window and ask for hint headers", () => {
  assert.equal(generated("codex/sol").env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "500000");
  assert.equal(generated("codex/sol").env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "1");
  assert.equal(generated("qwen/flash").env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "the catalog's placeholder floor is not a real window");
  const bare = JSON.parse(claudeSettings("codex/sol", "http://127.0.0.1:3457/v1", [])) as Record<string, unknown>;
  assert.equal(bare.modelPicker, undefined);
  for (const context_window of ["500000", 1.5, -1]) {
    const hostile = JSON.parse(claudeSettings("m", "http://127.0.0.1:3457/v1", [], { models: [{ slug: "m", context_window }] })) as { env: Record<string, string> };
    assert.equal(hostile.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  }
});

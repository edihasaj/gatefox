import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.js", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-claude-desktop-cli-"));
  const home = join(root, "home");
  const library = join(home, "Library/Application Support/Claude-3p/configLibrary");
  const state = join(root, "gateway-state");
  await mkdir(library, { recursive: true, mode: 0o700 });
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(library, "_meta.json"), JSON.stringify({ appliedId: "gateway", entries: [{ id: "gateway", name: "Harness Gateway" }] }), { mode: 0o600 });
  await writeFile(join(library, "gateway.json"), JSON.stringify({ retained: true }), { mode: 0o600 });
  await writeFile(join(state, "client-token"), `${"a".repeat(32)}\n`, { mode: 0o600 });
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/model-catalog");
    assert.equal(request.headers.authorization, `Bearer ${"a".repeat(32)}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [
      { slug: "claude-fable-5-1", display_name: "Claude Fable" },
      { slug: "codex/gpt", display_name: "GPT" },
    ] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const gatewayConfig = join(root, "gateway-source.json");
  const source = {
    port, stateDirectory: state, providers: [
      { id: "claude", type: "claude-subscription", models: { "claude-fable-5-1": "claude-fable-5-1" } },
      { id: "codex", type: "codex-subscription", models: { "codex/gpt": "gpt" } },
    ],
  };
  await writeFile(gatewayConfig, JSON.stringify(source), { mode: 0o600 });
  return { root, home, library, server, gatewayConfig, source };
}

test("configure reads a metadata-only source and writes only an isolated candidate by default", async () => {
  const f = await fixture();
  try {
    const { stdout } = await run(process.execPath, [cli, "claude-desktop", "configure", "--gateway-config", f.gatewayConfig, "--home", f.home]);
    const output = JSON.parse(stdout) as { candidate: { desktopProfilePath: string; adapterConfigPath: string }; applied: boolean };
    assert.equal(output.applied, false);
    assert.match(output.candidate.desktopProfilePath, /Claude-3p\/alias-trial\/candidate\/desktop-profile\.json$/);
    const profile = JSON.parse(await readFile(output.candidate.desktopProfilePath, "utf8"));
    const adapter = JSON.parse(await readFile(output.candidate.adapterConfigPath, "utf8"));
    assert.equal(profile.retained, true);
    assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:3467");
    assert.equal(adapter.listenPort, 3467);
    assert.equal(adapter.models[0].id, "claude-fable-5-1");
    assert.equal(typeof profile.inferenceCredentialHelper, "string");
    assert.deepEqual(profile.inferenceCredentialHelperArgs.slice(-2), ["--file", join(f.root, "gateway-state/client-token")]);
    assert.equal(JSON.stringify({ profile, adapter }).includes("a".repeat(32)), false, "the token is never embedded in generated files");
    assert.deepEqual(JSON.parse(await readFile(f.gatewayConfig, "utf8")), f.source, "source configuration remains read-only");
    await assert.rejects(stat(join(f.home, "Library/Application Support/Claude-3p/desktop-adapter/config.json")));
    await assert.rejects(stat(join(f.home, "Library/Application Support/Claude-3p/setup-backups")));
  } finally {
    await new Promise<void>(resolveResult => f.server.close(() => resolveResult()));
  }
});

test("Claude Desktop help is handled before the ordinary gateway configuration parser", async () => {
  const { stdout } = await run(process.execPath, [cli, "claude-desktop", "--help"], { env: { ...process.env, GATEWAY_CONFIG: "/missing/gateway.json" } });
  assert.match(stdout, /claude-desktop configure/);
  assert.match(stdout, /--endpoint LOOPBACK_URL --token-file PATH/);
  assert.match(stdout, /loopback SSH forward/);
});

test("configure refuses non-loopback or HTTPS endpoints before writing a candidate", async () => {
  const f = await fixture();
  try {
    for (const endpoint of ["https://127.0.0.1:3468", "http://gateway.example.test:3468"]) {
      await assert.rejects(run(process.execPath, [
        cli, "claude-desktop", "configure", "--gateway-config", f.gatewayConfig, "--home", f.home,
        "--endpoint", endpoint, "--token-file", join(f.root, "gateway-state/client-token"),
      ]), /--endpoint must be an http:\/\/ loopback gateway origin/);
      await assert.rejects(stat(join(f.home, "Library/Application Support/Claude-3p/alias-trial/candidate")));
    }
  } finally {
    await new Promise<void>(resolveResult => f.server.close(() => resolveResult()));
  }
});

test("status without a config reads only this adapter's service", async () => {
  const { stdout } = await run(process.execPath, [cli, "claude-desktop", "status"]);
  const status = JSON.parse(stdout);
  assert.equal(status.service, "com.edihasaj.claude-desktop-adapter");
  assert.equal("token" in status, false);
});

test("serve loads the packaged adapter dynamically and closes on SIGTERM", async () => {
  const f = await fixture();
  const config = join(f.root, "adapter.json");
  await writeFile(config, JSON.stringify({
    listenPort: 0, upstream: `http://127.0.0.1:${(f.server.address() as { port: number }).port}`,
    tokenFile: join(f.root, "gateway-state/client-token"),
    models: [{ id: "claude-fable-5-1", upstream: "claude-fable-5-1", displayName: "Claude Fable" }],
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [cli, "claude-desktop", "serve", "--config", config], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    await new Promise<void>((resolveResult, reject) => {
      child.stderr!.on("data", data => {
        if (String(data).includes("Claude Desktop adapter listening")) resolveResult();
      });
      child.once("exit", code => reject(new Error(`adapter exited before listening (${code})`)));
    });
    child.kill("SIGTERM");
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>(resolveResult => f.server.close(() => resolveResult()));
  }
});

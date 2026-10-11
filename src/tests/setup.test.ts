import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, writePrivateJson, loadConfig } from "../config.js";
import { setupGateway, setupClient } from "../setup.js";
import { startGateway } from "../server.js";
import { tunnelArguments } from "../mac-tunnel.js";

test("installed setup migrates gateway registration and token without native files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-setup-")); const state = join(directory, "legacy"); const source = join(directory, "source.json"); const destination = join(directory, "installed/gateway.json");
  const registration = join(directory, "registration.json"); await writeFile(registration, '{"fixture":"gateway-registration"}', { mode: 0o600 });
  await writePrivateJson(source, { version: 1, port: 3457, stateDirectory: state, providers: [{ id: "codex", type: "codex-subscription", credentialFile: registration, models: { "codex/model": "model" } }] });
  const token = await gatewayToken(state); const result = await setupGateway(source, destination); assert.equal(result.nativeConfigUntouched, true);
  const config = await loadConfig(destination); assert.equal(await gatewayToken(config.stateDirectory), token);
  assert.notEqual(config.providers[0]!.credentialFile, registration); assert.equal(await readFile(config.providers[0]!.credentialFile!, "utf8"), await readFile(registration, "utf8"));
  assert.equal((await stat(config.providers[0]!.credentialFile!)).mode & 0o777, 0o600);
  await assert.rejects(setupGateway(source, destination), /already exists/);
});

test("SSH tunnel arguments constrain endpoints and keep forwards on loopback", () => {
  const args = tunnelArguments({ id: "fixture", host: "user@host", port: 3459, remotePort: 3457, reverse: true });
  assert.ok(args.includes("-R")); assert.ok(args.includes("127.0.0.1:3459:127.0.0.1:3457"));
  assert.throws(() => tunnelArguments({ id: "fixture", host: "host;command", port: 3459, remotePort: 3457 }), /SSH alias/);
  assert.throws(() => tunnelArguments({ id: "fixture", host: "host", port: 0, remotePort: 3457 }), /ports/);
});

test("remote setup stores only the client token and refuses an inference daemon", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-client-")); const token = await gatewayToken(join(directory, "host"));
  const destination = join(directory, "client/gateway.json");
  const result = await setupClient(destination, 3459, join(directory, "host/client-token")); assert.equal(result.providerCredentialsCopied, false);
  const config = await loadConfig(destination); assert.equal(config.clientOnly, true); assert.deepEqual(config.providers, []); assert.equal(await gatewayToken(config.stateDirectory), token);
  await assert.rejects(startGateway(config), /remote client configuration/);
});

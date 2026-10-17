import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startExecutionHost, executionHostHome, hostFailureReason } from "../execution-host.js";
import { gatewayEngineVersions, validateExecutionSdk } from "../execution-host-engine.js";
import { readOwner, sdkIdentity } from "../execution-host-storage.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import { nativeUnavailableReason, validateNativeEngine } from "../native-execution-host-sdk.js";
import { verifiedAppEngines } from "../native-engine-versions.js";
import type { GatewayConfig } from "../config.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

const app163 = "codex-cli 0.163.0-alpha.10.2", app162 = "codex-cli 0.162.0-alpha.17.2";
const repository = (path: string) => new URL(`../../${path}`, import.meta.url);

async function engine(directory: string, version: string): Promise<string> {
  const path = join(directory, `codex-${Math.random().toString(16).slice(2)}`);
  await writeFile(path, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0);}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  return path;
}

test("native sharing accepts the 0.163 and 0.162 app engines; gateway generations keep the gateway SDK pin", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-engine-versions-"));
  try {
    assert.deepEqual([...verifiedAppEngines], ["0.163.0-alpha.10.2", "0.162.0-alpha.17.2"]);
    assert.deepEqual([...gatewayEngineVersions], ["0.162.0-alpha.17.2"]);
    for (const version of [app163, app162]) await validateNativeEngine(await engine(directory, version));
    await validateExecutionSdk(await engine(directory, app162));
    // The gateway SDK pin did not move: an app's 0.163 engine never runs a gateway generation.
    await assert.rejects(validateExecutionSdk(await engine(directory, app163)), /requires the pinned Codex SDK version/);
    // Anything else, including a near miss, is refused with the reason native sharing reports as sdk_version.
    for (const version of ["codex-cli 0.164.0", "codex-cli 0.163.0-alpha.10", "codex-cli 0.163.0-alpha.10.2-dirty", "0.163.0-alpha.10.2", ""]) {
      const refusal = await validateNativeEngine(await engine(directory, version)).then(() => undefined, error => error as Error);
      assert.ok(refusal, `accepted ${JSON.stringify(version)}`);
      assert.equal(nativeUnavailableReason(refusal), "sdk_version");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a native-only host shares a verified 0.163 app engine and still refuses an unverified one", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-native-only-")); const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const configPath = join(directory, "gateway.json"); const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), clientOnly: true, providers: [] };
  const nativeSdkVerifier = async (path: string) => { const identity = await sdkIdentity(path); return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 }; };
  const home = executionHostHome(configPath, nativeHome);
  const options = (codex: string) => ({ config, configPath, nativeHome, codex, capabilities: ["native" as const], nativeSdkVerifier });
  try {
    const host = await startExecutionHost(options(await engine(directory, app163)));
    try { assert.deepEqual((await readOwner(join(home, "owner.json")))?.capabilities, ["native"]); }
    finally { await host.close(); }
    const refusal = await startExecutionHost(options(await engine(directory, "codex-cli 0.164.0"))).then(() => undefined, error => error as Error);
    assert.match(String(refusal?.message), /requires the pinned Codex SDK version/);
    assert.equal(hostFailureReason(refusal), "sdk_invalid");
  } finally {
    await rm(dirname(nativeHomeOwnerPath(nativeHome)), { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("the relay, its build receipt and the host verify the same app engines", async () => {
  // The relay's own list, in native-relay/src/cli_version.rs, is the one its binary enforces.
  const relay = await readFile(repository("native-relay/src/cli_version.rs"), "utf8");
  const block = /const VERIFIED_CLI_VERSIONS: \[&str; \d+\] = \[([^\]]*)\];/.exec(relay);
  assert.ok(block, "the relay names its verified CLI versions");
  assert.deepEqual([...block[1].matchAll(/"codex-cli ([^"]+)"/g)].map(match => match[1]), [...verifiedAppEngines]);
  // The relay links the newest verified engine's SDK, and its receipt says so.
  const sdk = await import(repository("scripts/native-relay-sdk.mjs").href) as { sdkCodexVersion: string; sdkRevision: string };
  assert.equal(sdk.sdkCodexVersion, verifiedAppEngines[0]);
  const notice = await readFile(repository("native-relay/NOTICE"), "utf8");
  assert.ok(notice.includes(sdk.sdkRevision) && notice.includes(`rust-v${sdk.sdkCodexVersion}`), "the relay NOTICE names the linked SDK");
});

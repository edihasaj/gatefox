import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startExecutionHost, executionHostHome } from "../execution-host.js";
import { gatewayEngineVersions, validateExecutionSdk } from "../execution-host-engine.js";
import { readOwner, sdkIdentity } from "../execution-host-storage.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import { nativeUnavailableReason, validateNativeEngine, verifyNativeSdk } from "../native-execution-host-sdk.js";
import { hostVerifiedAppEngines, relayAcceptedAppEngines } from "../native-engine-versions.js";
import type { GatewayConfig } from "../config.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

const app163 = "codex-cli 0.163.0-alpha.10.2", app162 = "codex-cli 0.162.0-alpha.17.2";
const repository = (path: string) => new URL(`../../${path}`, import.meta.url);
const installedApp = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

async function engine(directory: string, version: string): Promise<string> {
  const path = join(directory, `codex-${Math.random().toString(16).slice(2)}`);
  await writeFile(path, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0);}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  return path;
}
const refusalOf = (work: Promise<unknown>): Promise<Error | undefined> => work.then(() => undefined, error => error as Error);

test("the relay and native host accept the verified 0.163 and 0.162 app engines while gateway chats keep the gateway SDK pin", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-engine-versions-"));
  try {
    assert.deepEqual([...relayAcceptedAppEngines], ["0.163.0-alpha.10.2", "0.162.0-alpha.17.2"]);
    assert.deepEqual([...hostVerifiedAppEngines], ["0.163.0-alpha.10.2", "0.162.0-alpha.17.2"]);
    assert.equal(gatewayEngineVersions.includes("0.162.0-alpha.17.2"), true);
    await validateNativeEngine(await engine(directory, app163));
    await validateNativeEngine(await engine(directory, app162));
    await validateExecutionSdk(await engine(directory, app162));
    for (const version of ["codex-cli 0.164.0", "codex-cli 0.162.0-alpha.17", "codex-cli 0.162.0-alpha.17.2-dirty", "0.162.0-alpha.17.2", ""]) {
      const refusal = await refusalOf(validateNativeEngine(await engine(directory, version)));
      assert.ok(refusal, `the host accepted ${JSON.stringify(version)}`);
      assert.equal(nativeUnavailableReason(refusal), "sdk_version");
    }
    await assert.rejects(validateExecutionSdk(await engine(directory, app163)), /requires the pinned Codex SDK version/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a native-only host shares each verified app engine without requiring the gateway SDK pin", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-native-only-")); const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const configPath = join(directory, "gateway.json"); const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), clientOnly: true, providers: [] };
  const nativeSdkVerifier = async (path: string) => { await validateNativeEngine(path); const identity = await sdkIdentity(path); return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 }; };
  const home = executionHostHome(configPath, nativeHome);
  const options = (codex: string) => ({ config, configPath, nativeHome, codex, capabilities: ["native" as const], nativeSdkVerifier });
  try {
    for (const version of [app163, app162]) {
      const host = await startExecutionHost(options(await engine(directory, version)));
      try { assert.deepEqual((await readOwner(join(home, "owner.json")))?.capabilities, ["native"]); }
      finally { await host.close(); }
    }
  } finally {
    await rm(dirname(nativeHomeOwnerPath(nativeHome)), { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("verifyNativeSdk follows the app's launcher, checks the signature of the binary it loads, then its version", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  // The app's layout, with node standing in for the signed Mach-O: the launcher selects it, the signature step sees it, and
  // its --version (node's own) is no verified engine, so verification ends at the version step.
  const directory = await mkdtemp(join(tmpdir(), "gw-native-sdk-"));
  try {
    const bin = join(directory, "codex-cli/bin"), macos = join(directory, "codex-cli/CodexCLI.app/Contents/MacOS");
    await mkdir(bin, { recursive: true }); await mkdir(macos, { recursive: true });
    await writeFile(join(bin, "codex"), '#!/bin/sh\nexec "$(dirname "$0")/../CodexCLI.app/Contents/MacOS/codex" "$@"\n', { mode: 0o700 });
    await symlink(process.execPath, join(macos, "codex"));
    const seen: string[] = [];
    const version = await refusalOf(verifyNativeSdk(join(bin, "codex"), async executable => { seen.push(executable); }));
    assert.equal(seen.length, 1, "the signature step ran once");
    assert.equal(seen[0], (await sdkIdentity(process.execPath)).codex, "it checked the binary the launcher selects, not the launcher");
    assert.match(String(version?.message), /requires the pinned Codex SDK version/);
    assert.equal(nativeUnavailableReason(version), "sdk_version");
    // A refused signature stops before the version step, with its own reason.
    const signature = await refusalOf(verifyNativeSdk(join(bin, "codex"), async () => { throw new Error("unsigned"); }));
    assert.equal(nativeUnavailableReason(signature), "sdk_signature");
    // The default signature step is OpenAI's team: node is signed by someone else, or not at all.
    assert.equal(nativeUnavailableReason(await refusalOf(verifyNativeSdk(join(bin, "codex")))), "sdk_signature");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the installed ChatGPT engine is shared only when the host verified its version", { timeout: 30000 }, async t => {
  if (process.platform !== "darwin" || !await access(installedApp).then(() => true, () => false)) return void t.skip("no installed ChatGPT app");
  const version = execFileSync(installedApp, ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli /, "");
  const refusal = await refusalOf(verifyNativeSdk(installedApp));
  if (hostVerifiedAppEngines.includes(version)) assert.equal(refusal, undefined, `the host refused its verified engine ${version}`);
  else assert.equal(nativeUnavailableReason(refusal), "sdk_version", `the host shares the unverified engine ${version}`);
});

test("the relay's own list is the relay-accepted list, entry for entry", async () => {
  // The relay's list, in native-relay/src/cli_version.rs, is the one its binary enforces. Every quoted entry must be a full
  // `codex --version` line, so a bare version or a stray string in the array fails here rather than at the relay's start.
  const relay = await readFile(repository("native-relay/src/cli_version.rs"), "utf8");
  const block = /const VERIFIED_CLI_VERSIONS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(relay);
  assert.ok(block, "the relay names its verified CLI versions");
  const entries = [...block[2].matchAll(/"([^"]*)"/g)].map(match => match[1]);
  assert.equal(entries.length, Number(block[1]));
  assert.ok(entries.every(entry => entry.startsWith("codex-cli ")), "every relay entry is a full `codex --version` line");
  assert.deepEqual(entries.map(entry => entry.slice("codex-cli ".length)), [...relayAcceptedAppEngines]);
  // The relay links the newest accepted engine's SDK, and its receipt says so.
  const sdk = await import(repository("scripts/native-relay-sdk.mjs").href) as { sdkCodexVersion: string; sdkRevision: string };
  assert.equal(sdk.sdkCodexVersion, relayAcceptedAppEngines[0]);
  const notice = await readFile(repository("native-relay/NOTICE"), "utf8");
  assert.ok(notice.includes(sdk.sdkRevision) && notice.includes(`rust-v${sdk.sdkCodexVersion}`), "the relay NOTICE names the linked SDK");
});

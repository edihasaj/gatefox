import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFirstPartyLauncher, isMachO, nativeEngineExecutable, signedNativeEngineExecutable } from "../native-engine-path.js";
import { ExecutionHostClient } from "../execution-host-client.js";
import { executionHostHome, startExecutionHost } from "../execution-host.js";
import { readOwner, sdkIdentity } from "../execution-host-storage.js";
import { executionHostReady } from "../mac-shared-executors.js";
import { probeExecutionHost } from "../service-host-probe.js";
import type { ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { shortFolder } from "./short-folder.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The host homes stay in this file's own folder.
hostRunsInThisProcess(); // The stand-in host's receipt names this process: see src/tests/in-process-host.ts.

const launcherSource = '#!/bin/sh\nexec "$(dirname "$0")/../CodexCLI.app/Contents/MacOS/codex" "$@"\n';
const machO = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(64)]);

/** The ChatGPT app's layout: `codex-cli/bin/codex` is a shell launcher for the signed `CodexCLI.app` binary. */
async function appLayout(directory: string) {
  const bin = join(directory, "codex-cli/bin"), macos = join(directory, "codex-cli/CodexCLI.app/Contents/MacOS");
  await mkdir(bin, { recursive: true }); await mkdir(macos, { recursive: true });
  const launcher = join(bin, "codex"), signed = join(macos, "codex");
  await writeFile(launcher, launcherSource, { mode: 0o700 }); await writeFile(signed, machO, { mode: 0o700 });
  return { launcher, signed };
}

test("the header rules name a Mach-O and the first-party launcher, and nothing else", () => {
  for (const magic of ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]) assert.equal(isMachO(Buffer.from(magic, "hex")), true, magic);
  assert.equal(isMachO(Buffer.from("#!/bin")), false); assert.equal(isMachO(Buffer.alloc(0)), false);
  const header = Buffer.from(launcherSource);
  assert.equal(isFirstPartyLauncher("/app/codex-cli/bin/codex", header), true);
  assert.equal(isFirstPartyLauncher("/app/codex-cli/tools/codex", header), false, "only a file in a bin folder");
  assert.equal(isFirstPartyLauncher("/app/codex-cli/bin/other", header), false, "only a file named codex");
  assert.equal(isFirstPartyLauncher("/app/codex-cli/bin/codex", Buffer.from("#!/bin/sh\necho hi\n")), false, "only the known relative target");
  assert.equal(isFirstPartyLauncher("/app/codex-cli/bin/codex", Buffer.from(launcherSource.slice(2))), false, "only a script");
  assert.equal(isFirstPartyLauncher("/app/codex-cli/bin/codex", Buffer.from("#!/bin/sh\n# ../CodexCLI.app/Contents/MacOS/codex\n")), false, "only a script that execs it");
});

test("the app's launcher resolves to the signed engine it loads; every other file resolves to itself", async () => {
  const made = await shortFolder("gwe-");
  try {
    const { launcher, signed } = await appLayout(made.directory); const real = await realpath(signed);
    assert.equal(await nativeEngineExecutable(launcher), real, "the launcher names the binary it execs");
    assert.equal(await signedNativeEngineExecutable(launcher), real, "native SDK verification shares the same launcher resolver");
    assert.equal(await nativeEngineExecutable(signed), real, "a Mach-O is its own engine");
    const link = join(made.directory, "linked-codex"); await symlink(signed, link);
    assert.equal(await nativeEngineExecutable(link), real, "a symlink to the Mach-O");
    const launcherLink = join(made.directory, "linked-launcher"); await symlink(launcher, launcherLink);
    assert.equal(await nativeEngineExecutable(launcherLink), real, "a symlink to the launcher");
    // A script that is not the app's launcher never selects a binary.
    const elsewhere = join(made.directory, "tools"); await mkdir(elsewhere);
    const wrongPlace = join(elsewhere, "codex"); await writeFile(wrongPlace, launcherSource, { mode: 0o700 });
    assert.equal(await nativeEngineExecutable(wrongPlace), await realpath(wrongPlace), "launcher text outside a bin folder");
    const bin = join(made.directory, "other/bin"); await mkdir(bin, { recursive: true });
    const unrelated = join(bin, "codex"); await writeFile(unrelated, "#!/bin/sh\necho hi\n", { mode: 0o700 });
    assert.equal(await nativeEngineExecutable(unrelated), await realpath(unrelated), "a bin/codex script without the launcher text");
    await assert.rejects(signedNativeEngineExecutable(unrelated), /original signed Codex SDK/);
    // A launcher whose engine is gone, or a path that is gone, is an error and not a guess.
    const orphan = join(made.directory, "orphan/bin"); await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "codex"), launcherSource, { mode: 0o700 });
    await assert.rejects(nativeEngineExecutable(join(orphan, "codex")), { code: "ENOENT" });
    await assert.rejects(nativeEngineExecutable(join(made.directory, "absent")), { code: "ENOENT" });
  } finally { await made.remove(); }
});

/** A real shared-native host receives the launcher but records its separately verified signed engine. */
async function sharedHost() {
  const made = await shortFolder("gwl-"); const directory = made.directory;
  const configPath = join(directory, "gateway.json"); const nativeHome = join(directory, "native");
  await mkdir(nativeHome, { mode: 0o700 });
  const app = await appLayout(directory);
  const config = { version: 1 as const, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  const host = await startExecutionHost({ config, configPath, nativeHome, codex: app.launcher, capabilities: ["native"], nativeSdkVerifier: async () => {
    const identity = await sdkIdentity(app.signed); return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 };
  } });
  const home = executionHostHome(configPath, nativeHome); const owner = await readOwner(join(home, "owner.json"));
  assert.equal(owner?.codex, await realpath(app.launcher), "the host preserves its launcher identity");
  assert.equal(owner?.nativeSdkExecutable, await realpath(app.signed), "the receipt separately records the verified signed engine");
  const other = join(directory, "other-codex"); await writeFile(other, "#!/bin/sh\necho other\n", { mode: 0o700 });
  return { ...app, other, configPath, nativeHome, home, close: () => host.close(), remove: async () => { await host.close().catch(() => {}); await made.remove(); } };
}

test("the desktop adapter accepts the app's launcher for a host that recorded the signed engine, and still refuses another binary", { timeout: 30000 }, async () => {
  const f = await sharedHost(); const clients: ExecutionHostClient[] = [];
  const discover = async (codex: string) => { const client = await ExecutionHostClient.discover(f.configPath, f.nativeHome, codex, "native", true); assert.ok(client); clients.push(client!); return client!; };
  try {
    assert.deepEqual((await discover(f.launcher)).capabilities, ["native"], "the wrapper's bin/codex path no longer fails with an ownership mismatch");
    await discover(f.signed);
    await assert.rejects(ExecutionHostClient.discover(f.configPath, f.nativeHome, f.other, "native", true), /Shared executor ownership does not match this adapter/);
  } finally { for (const client of clients) client.close(); await f.remove(); }
});

test("the host probe and the service health check judge the launcher by the engine it loads", { timeout: 30000 }, async () => {
  const f = await sharedHost();
  try {
    const baseline = {};
    assert.equal(await probeExecutionHost({ home: f.home, pid: process.pid, codex: f.launcher }, baseline), undefined, "the launcher is not a changed engine");
    assert.equal(await probeExecutionHost({ home: f.home, pid: process.pid, codex: f.signed }, {}), undefined);
    assert.equal(await probeExecutionHost({ home: f.home, pid: process.pid, codex: f.other }, {}), "sdk_changed", "another binary is");
    const plan = (codex: string): ServicePlan => ({ version: 1, config: f.configPath, sharedNativeExecutor: true,
      components: [{ id: "native", kind: "native", command: process.execPath, args: ["--codex", codex, "--native-home", f.nativeHome], log: join(f.home, "native.log") }] });
    assert.equal(await executionHostReady(plan(f.launcher), process.pid), true, "the plan's launcher path is the host's engine");
    assert.equal(await executionHostReady(plan(f.signed), process.pid), true);
    assert.equal(await executionHostReady(plan(f.other), process.pid), false);
  } finally { await f.remove(); }
});

test("a legacy receipt that only hashes its launcher is restarted rather than trusting its signed target", { timeout: 30000 }, async () => {
  const f = await sharedHost();
  try {
    const receipt = join(f.home, "owner.json"); const old = JSON.parse(await readFile(receipt, "utf8")) as Record<string, unknown>;
    delete old.nativeSdkExecutable; delete old.nativeSdkSha256;
    await writePrivateJson(receipt, old);
    assert.equal(await probeExecutionHost({ home: f.home, pid: process.pid, codex: f.launcher }), "sdk_changed");
  } finally { await f.remove(); }
});

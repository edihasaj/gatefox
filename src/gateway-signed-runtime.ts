import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GatewaySdkRuntime } from "./gateway-sdk-runtime.js";

const execute = promisify(execFile);
const team = "T8J48M4QVY";
const appId = "com.edihasaj.harness-gateway.app";
const sdkId = "com.edihasaj.harness-gateway.gateway-sdk";
const runtimeSuffix = "/Contents/Resources/backend/runtime";
const requirement = (identifier: string) => `anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}" and identifier "${identifier}"`;

async function verifySignature(app: string, executable: string): Promise<void> {
  for (const [path, identifier, deep] of [[app, appId, true], [executable, sdkId, false]] as const) {
    await execute("/usr/bin/codesign", ["--verify", ...(deep ? ["--deep"] : []), "--strict", `-R=${requirement(identifier)}`, path],
      { timeout: 30_000, maxBuffer: 65536 });
  }
}

/** Use the installed signed derivative only when its signed receipt binds it to the already verified CLI build. */
export async function signedGatewayRuntime(root: string, original: GatewaySdkRuntime,
  verifyPackage: (directory: string) => Promise<GatewaySdkRuntime | undefined>,
  verify: (app: string, executable: string) => Promise<void> = verifySignature): Promise<GatewaySdkRuntime | undefined> {
  try {
    const target = await realpath(join(root, "app-runtime"));
    if (!target.endsWith(runtimeSuffix)) return;
    const app = target.slice(0, -runtimeSuffix.length);
    if (!app.endsWith(".app")) return;
    const directory = join(app, "Contents/Resources/backend/package");
    const receipt = join(directory, "gateway-sdk/build.json");
    const receiptBytes = await readFile(receipt);
    const metadata = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
    if (metadata.originalBinarySha256 !== original.binarySha256) return;
    const signed = await verifyPackage(directory);
    if (!signed || signed.codeModeHost !== original.codeModeHost) return;
    if (original.codeModeHost) {
      const source = JSON.parse(await readFile(join(dirname(original.executable), "build.json"), "utf8")) as Record<string, unknown>;
      if (metadata.originalCodeModeHostSha256 !== source.codeModeHostSha256) return;
    }
    await verify(app, signed.executable);
    const rechecked = await verifyPackage(directory);
    if (!rechecked || rechecked.binarySha256 !== signed.binarySha256 || rechecked.executable !== signed.executable
      || rechecked.codeModeHost !== signed.codeModeHost || !(await readFile(receipt)).equals(receiptBytes)) return;
    // The original hash is the release identity used by adapters and old hosts; the executable itself was verified above.
    return { ...signed, binarySha256: original.binarySha256, executableSha256: signed.binarySha256, identityExecutable: original.executable };
  } catch { return; }
}

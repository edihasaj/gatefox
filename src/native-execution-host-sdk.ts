import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { sdkIdentity } from "./execution-host-storage.js";
import { validateExecutionSdk } from "./execution-host-engine.js";

export interface NativeSdkIdentity { nativeSdkExecutable: string; nativeSdkSha256: string }
export type NativeSdkVerifier = (codex: string) => Promise<NativeSdkIdentity>;
const execute = promisify(execFile);
const macho = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

async function prefix(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try { const bytes = Buffer.alloc(32768); const read = await file.read(bytes, 0, bytes.length, 0); return bytes.subarray(0, read.bytesRead); }
  finally { await file.close(); }
}

/** Verify the loaded binary, rather than trusting an unchanged shell launcher. */
export async function verifyNativeSdk(codex: string): Promise<NativeSdkIdentity> {
  let executable = await realpath(codex); const header = await prefix(executable);
  if (!macho.has(header.subarray(0, 4).toString("hex"))) {
    // Only the first-party bundle's known relative launcher may select a binary.
    const source = header.toString("utf8");
    if (basename(executable) !== "codex" || basename(dirname(executable)) !== "bin" ||
      !source.startsWith("#!") || !source.includes("../CodexCLI.app/Contents/MacOS/codex") || !source.includes("exec")) throw new Error("Native execution requires the original signed Codex SDK");
    executable = await realpath(resolve(dirname(executable), "../CodexCLI.app/Contents/MacOS/codex"));
    if (!macho.has((await prefix(executable)).subarray(0, 4).toString("hex"))) throw new Error("Native execution requires the original signed Codex SDK");
  }
  if (process.platform !== "darwin") throw new Error("Native execution requires a verified macOS Codex SDK");
  const identity = await sdkIdentity(executable);
  try {
    await execute("/usr/bin/codesign", ["--verify", "--strict", executable], { timeout: 10000, maxBuffer: 65536 });
    const metadata = await execute("/usr/bin/codesign", ["-d", "--verbose=2", executable], { timeout: 10000, maxBuffer: 65536 });
    if (!/(?:^|\n)TeamIdentifier=2DC432GLL2(?:\r?\n|$)/.test(metadata.stderr)) throw new Error("Signature team differs");
  } catch { throw new Error("Native execution SDK signature verification failed"); }
  if ((await sdkIdentity(executable)).sdkSha256 !== identity.sdkSha256) throw new Error("Native execution SDK changed during signature verification");
  await validateExecutionSdk(identity.codex);
  return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sdkIdentity } from "./execution-host-storage.js";
import { validateExecutionSdk } from "./execution-host-engine.js";
import { hostVerifiedAppEngines } from "./native-engine-versions.js";
import { signedNativeEngineExecutable } from "./native-engine-path.js";

export interface NativeSdkIdentity { nativeSdkExecutable: string; nativeSdkSha256: string }
export type NativeSdkVerifier = (codex: string) => Promise<NativeSdkIdentity>;
const execute = promisify(execFile);

/** The app's own engine, not the gateway SDK: the host shares it only when this release verified it for sharing. */
export const validateNativeEngine = (codex: string): Promise<void> => validateExecutionSdk(codex, hostVerifiedAppEngines);

/** OpenAI's Developer ID signature on the loaded binary; it throws when the binary is unsigned, altered or signed by anyone else. */
export async function verifyOpenAiSignature(executable: string): Promise<void> {
  await execute("/usr/bin/codesign", ["--verify", "--strict", executable], { timeout: 10000, maxBuffer: 65536 });
  const metadata = await execute("/usr/bin/codesign", ["-d", "--verbose=2", executable], { timeout: 10000, maxBuffer: 65536 });
  if (!/(?:^|\n)TeamIdentifier=2DC432GLL2(?:\r?\n|$)/.test(metadata.stderr)) throw new Error("Signature team differs");
}

/** Verify the loaded binary, rather than trusting an unchanged shell launcher. Tests replace only the signature step. */
export async function verifyNativeSdk(codex: string, signature: (executable: string) => Promise<void> = verifyOpenAiSignature): Promise<NativeSdkIdentity> {
  const executable = await signedNativeEngineExecutable(codex);
  if (process.platform !== "darwin") throw new Error("Native execution requires a verified macOS Codex SDK");
  const identity = await sdkIdentity(executable);
  try { await signature(executable); } catch { throw new Error("Native execution SDK signature verification failed"); }
  if ((await sdkIdentity(executable)).sdkSha256 !== identity.sdkSha256) throw new Error("Native execution SDK changed during signature verification");
  await validateNativeEngine(identity.codex);
  return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 };
}

/** Fixed, privacy-safe reason for telemetry when native sharing cannot be offered. */
export function nativeUnavailableReason(error: unknown): "sdk_version" | "sdk_signature" | "other" {
  const message = error instanceof Error ? error.message : "";
  if (/requires the pinned Codex SDK version/.test(message)) return "sdk_version";
  if (/original signed Codex SDK|signature verification failed|SDK changed during signature verification/.test(message)) return "sdk_signature";
  return "other";
}

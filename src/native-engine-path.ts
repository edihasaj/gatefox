import { open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

// Node built-ins only: this module sits under the host client, the probe and the SDK check, so it must not import any of them.
const macho = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
const launcherTarget = "../CodexCLI.app/Contents/MacOS/codex";

/** Whether the first bytes of a file are a Mach-O (thin or universal) header. */
export function isMachO(header: Buffer): boolean {
  return macho.has(header.subarray(0, 4).toString("hex"));
}

/** Whether a file is the first-party bundle's `bin/codex` shell launcher: only that known relative launcher may select a binary. */
export function isFirstPartyLauncher(path: string, header: Buffer): boolean {
  const source = header.toString("utf8");
  return basename(path) === "codex" && basename(dirname(path)) === "bin" && source.startsWith("#!") && source.includes(launcherTarget) && source.includes("exec");
}

/** Up to the first 32 KiB of a file, enough for a Mach-O magic number or a launcher script. */
export async function readHeader(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try { const bytes = Buffer.alloc(32768); const read = await file.read(bytes, 0, bytes.length, 0); return bytes.subarray(0, read.bytesRead); }
  finally { await file.close(); }
}

/**
 * The binary an app-engine path loads. The ChatGPT app's `codex-cli/bin/codex` is a shell launcher that execs the signed
 * `CodexCLI.app` binary, and the shared host records that binary; resolving the launcher to it lets both sides name the same engine.
 * A Mach-O, a symlink to one, or any other file resolves to its own real path.
 */
export async function nativeEngineExecutable(codex: string): Promise<string> {
  const real = await realpath(codex);
  const header = await readHeader(real);
  if (isMachO(header)) return real;
  if (isFirstPartyLauncher(real, header)) return await realpath(resolve(dirname(real), launcherTarget));
  return real;
}

/** The native engine a host receipt owns. Older receipts have only `codex`; current native receipts record its verified engine. */
export async function nativeOwnerEngineExecutable(codex: string, nativeSdkExecutable?: string): Promise<string> {
  return nativeEngineExecutable(nativeSdkExecutable ?? codex);
}

/**
 * The signed app engine accepted by native sharing. Canonicalising a path is intentionally separate from
 * accepting it: callers that verify the native SDK must still reject a shell script or any other non-Mach-O file.
 */
export async function signedNativeEngineExecutable(codex: string): Promise<string> {
  const executable = await nativeEngineExecutable(codex);
  if (!isMachO(await readHeader(executable))) throw new Error("Native execution requires the original signed Codex SDK");
  return executable;
}

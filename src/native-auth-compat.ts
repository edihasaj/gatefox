import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const providers = ["gatefox", "subscription_gateway"] as const;
const ownFlags = ["-c", "--config"];
const valueFlags = [...ownFlags, "--enable", "--disable", "--profile", "-p", "--model", "-m", "--listen", "-C", "--cd", "--add-dir", "--sandbox", "-s", "--ask-for-approval", "-a"];

/** Reads a real private executable owned by this user without following a symlink. */
async function executableBytes(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || !(info.mode & 0o100) || (info.mode & 0o022) || info.nlink !== 1 || info.size > 65536) throw new Error("unsafe helper");
    const bytes = await file.readFile();
    if (bytes.length !== info.size) throw new Error("helper changed");
    return bytes;
  } finally { await file.close(); }
}

/** Proves the old and new spellings currently execute identical managed code for one installation. */
async function legacyAlias(command: string): Promise<string | undefined> {
  if (!isAbsolute(command) || basename(command) !== "gatefox") return;
  const legacy = resolve(dirname(command), "harness-gateway");
  try {
    const { managedInstallationForCommand } = await import("./app-runtime.js");
    const [current, previous] = await Promise.all([managedInstallationForCommand(command), managedInstallationForCommand(legacy)]);
    if (current.root !== previous.root || current.prefix !== previous.prefix) return;
    const [a, b] = await Promise.all([executableBytes(command), executableBytes(legacy)]);
    return a.equals(b) ? legacy : undefined;
  } catch { return; }
}

/**
 * Compatibility for the exact auth metadata change in 1.8.5. Endpoints, auth arguments, account selection, client settings
 * and cwd remain exact. A retained native writer can keep its original launch only when both command aliases are proven
 * identical, real installer-owned files for the same installation. Missing/duplicate/alternate flag shapes fail closed.
 */
export async function legacyNativeAuthArgs(args: string[]): Promise<string[] | undefined> {
  const fields = new Map<string, { index: number; value: unknown }>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    // Do not interpret values consumed by another option as configuration flags.
    if (!valueFlags.includes(flag)) {
      if (flag.startsWith("--config=") || flag.startsWith("-c=")) return;
      continue;
    }
    const value = args[++index];
    if (value === undefined) return;
    if (!ownFlags.includes(flag)) continue;
    const equals = value.indexOf("="); if (equals < 1) continue;
    const key = value.slice(0, equals).trim();
    if (!providers.some(id => key === `model_providers.${id}.auth.command` || key === `model_providers.${id}.auth.timeout_ms`)) continue;
    if (fields.has(key)) return;
    let parsed: unknown; try { parsed = JSON.parse(value.slice(equals + 1)); } catch { return; }
    fields.set(key, { index, value: parsed });
  }
  let command: string | undefined;
  for (const id of providers) {
    const c = fields.get(`model_providers.${id}.auth.command`), timeout = fields.get(`model_providers.${id}.auth.timeout_ms`);
    if (!c || !timeout || typeof c.value !== "string" || timeout.value !== 15000 || command !== undefined && command !== c.value) return;
    command = c.value;
  }
  const legacy = command && await legacyAlias(command); if (!legacy) return;
  const result = [...args];
  for (const id of providers) {
    const key = `model_providers.${id}.auth.command`, timeoutKey = `model_providers.${id}.auth.timeout_ms`;
    result[fields.get(key)!.index] = `${key}=${JSON.stringify(legacy)}`;
    result[fields.get(timeoutKey)!.index] = `${timeoutKey}=5000`;
  }
  return result;
}

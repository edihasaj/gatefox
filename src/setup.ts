import { readFile, access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig, writePrivateJson, gatewayToken, readPrivateCredential, readClientToken } from "./config.js";

/** Migrate only gateway-owned state; native Codex files are never read or copied. */
export async function setupGateway(source: string, destination: string, clientOnly = false): Promise<Record<string, unknown>> {
  if (resolve(source) === resolve(destination)) return { configured: true, config: destination };
  try { await access(destination); throw new Error("Gateway configuration already exists; use it or choose a new --config destination"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const config = await loadConfig(source); const state = resolve(dirname(destination), "state");
  if (clientOnly) { config.clientOnly = true; config.providers = []; }
  await mkdir(state, { recursive: true, mode: 0o700 });
  const copyPrivate = async (target: string, data: string) => {
    const { open } = await import("node:fs/promises"); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(target, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(target, "utf8") !== data) throw error;
      return;
    }
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  };
  for (const provider of config.providers) if (provider.credentialFile) {
    const target = resolve(state, "credentials", `${provider.id}.${provider.type === "codex-subscription" ? "json" : "token"}`);
    // Validate API credential ownership before copying it; subscription registration is our own file.
    if (provider.type !== "codex-subscription") await readPrivateCredential(provider.credentialFile);
    await copyPrivate(target, await readFile(provider.credentialFile, "utf8")); provider.credentialFile = target;
  }
  await copyPrivate(resolve(state, "client-token"), await gatewayToken(config.stateDirectory) + "\n");
  try { await writePrivateJson(resolve(state, "desktop-preferences.json"), JSON.parse(await readFile(resolve(config.stateDirectory, "desktop-preferences.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  config.stateDirectory = state; await writePrivateJson(destination, config);
  return { configured: true, config: destination, credentialsPreserved: true, nativeConfigUntouched: true };
}

export async function setupClient(destination: string, port: number, tokenFile: string): Promise<Record<string, unknown>> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Client port must be 1 through 65535");
  const token = await readClientToken(tokenFile);
  try { await access(destination); throw new Error("Gateway configuration already exists; refusing to replace it"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const state = resolve(dirname(destination), "state"); await mkdir(state, { recursive: true, mode: 0o700 });
  const { open } = await import("node:fs/promises"); const file = await open(resolve(state, "client-token"), "wx", 0o600);
  try { await file.writeFile(token + "\n"); } finally { await file.close(); }
  await writePrivateJson(destination, { version: 1, port, stateDirectory: state, providers: [], clientOnly: true });
  return { configured: true, clientOnly: true, config: destination, providerCredentialsCopied: false };
}

import { lstat, readFile, mkdir, open, rename, realpath, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { gatewayCommand } from "./command.js";
import { loadConfig } from "./config.js";
import { sshControlHome } from "./ssh-socket.js";

const marker = "# Managed by subscription-gateway SSH adapter";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function sshWrapper(configPath: string, original: string, bundled: string, helper = gatewayCommand()): string {
  const server = [helper.command, ...helper.args, "codex-shim", "--ssh", "--config", configPath, "--codex", bundled, "--"].map(quote).join(" ");
  return `#!/bin/sh\n${marker}\nskip_value=0\nfor argument do\n  if [ "$skip_value" = 1 ]; then skip_value=0; continue; fi\n  case "$argument" in\n    -c|--config|--enable|--disable|-p|--profile|-m|--model|-s|--sandbox|-a|--ask-for-approval|-C|--cd|--add-dir|-i|--image|--remote|--remote-auth-token-env|--local-provider|--linux-sandbox-pid-namespace) skip_value=1 ;;\n    -*) ;;\n    app-server) exec ${server} "$@" ;;\n    *) break ;;\n  esac\ndone\nexec ${quote(original)} "$@"\n`;
}
export async function macSsh(action: string, configPath: string, original?: string, app = "/Applications/ChatGPT.app"): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin" || !["register", "unregister", "status"].includes(action)) throw new Error("Choose gateway ssh register, unregister or status on macOS");
  const path = resolve(homedir(), ".local/bin/codex");
  let previous: string | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size > 65536) {
      if (action !== "register") return { registered: false, unmanagedCommandPreserved: true };
      throw new Error("An unmanaged codex command already exists; it was not replaced");
    }
    previous = await readFile(path, "utf8");
    if (!previous.startsWith("#!/bin/sh\n" + marker + "\n")) {
      if (action !== "register") return { registered: false, unmanagedCommandPreserved: true };
      throw new Error("An unmanaged codex command already exists; it was not replaced");
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (action === "status") return { registered: !!previous, command: path };
  if (action === "unregister") {
    if (previous) { const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true }); await rename(path, resolve(trash, `gateway-ssh-codex.${Date.now()}`)); }
    return { registered: false, nativeConfigUntouched: true };
  }
  if (!original || !isAbsolute(original) || resolve(original) === path) throw new Error("SSH registration requires --codex with the absolute original CLI path");
  const bundled = resolve(app, "Contents/Resources/codex-cli/bin/codex");
  for (const binary of [original, bundled]) { const info = await lstat(binary); if (!info.isFile() && !info.isSymbolicLink()) throw new Error("Original Codex command must be an executable file"); await access(binary, constants.X_OK); }
  if (await realpath(original) === path) throw new Error("Original Codex command points back to the SSH adapter");
  await loadConfig(configPath);
  const contents = sshWrapper(configPath, original, bundled);
  await mkdir(dirname(path), { recursive: true });
  if (!previous) {
    const file = await open(path, "wx", 0o700); try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
  } else if (previous !== contents) {
    const temporary = `${path}.${process.pid}.tmp`; const file = await open(temporary, "wx", 0o700);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); } await rename(temporary, path);
  }
  return { registered: true, command: path, controlHome: sshControlHome(configPath), originalCliPreserved: true, nativeConfigUntouched: true };
}

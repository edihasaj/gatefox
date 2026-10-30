import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * A gateway executor runs with `CODEX_HOME` set to a gateway-internal home (a desktop generation under the state directory,
 * or a host home under `~/.local/state/gw-*`), and every command a gateway chat runs inherits it. When such a command starts
 * ChatGPT (an agent restarting the app with `open -a ChatGPT`), the app passes that home to its engine launcher. The adapter
 * then looked for `models_cache.json` there, found none, and the app failed to start with "The native model catalog is
 * unavailable". A gateway-internal home is never the user's native home, so the wrapper and the adapter ignore it and fall
 * back to `~/.codex`, exactly as a launch from the Dock does. Any other `CODEX_HOME`, such as `gateway desktop --native-home`,
 * is kept.
 */
export const gatewayStateRoots = ["gw-exec", "gw-native", "gw-ssh", "gw-runtime"] as const;

export function gatewayInternalRoots(stateDirectory: string, home = homedir()): string[] {
  return [resolve(stateDirectory), ...gatewayStateRoots.map(name => resolve(home, ".local/state", name))];
}

const inside = (root: string, path: string): boolean => {
  const rest = relative(root, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
};

export function isGatewayInternalHome(value: string | undefined, stateDirectory: string, home = homedir()): boolean {
  if (!value) return false;
  const path = resolve(value);
  return gatewayInternalRoots(stateDirectory, home).some(root => inside(root, path));
}

/** Removes a gateway-internal `CODEX_HOME` from `env` in place; returns whether it did. */
export function dropGatewayCodexHome(env: NodeJS.ProcessEnv, stateDirectory: string, home = homedir()): boolean {
  if (!isGatewayInternalHome(env.CODEX_HOME, stateDirectory, home)) return false;
  delete env.CODEX_HOME;
  return true;
}

/** The same rule as a POSIX shell `case` for the desktop wrapper, which runs before any gateway code. */
export function wrapperHomeGuard(stateDirectory: string, home = homedir()): string {
  const quoted = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const patterns = gatewayInternalRoots(stateDirectory, home).flatMap(root => [quoted(root), quoted(root) + "/*"]).join("|");
  return `case "\${CODEX_HOME:-}" in ${patterns}) unset CODEX_HOME ;; esac\n`;
}

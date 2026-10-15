import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaunchctlExec } from "../mac-desktop.js";
import { writePrivateJson } from "../config.js";

export const FORCE = "CODEX_APP_SERVER_FORCE_CLI"; export const PATH_KEY = "CODEX_CLI_PATH";

/**
 * A macOS desktop fixture: a fake ChatGPT.app, a state directory, a config, and a launchctl seam that records
 * every call against a simulated GUI session. Nothing here reaches /bin/launchctl or the real login session.
 * `name` labels the temporary directory and the (unused) key environment variable so parallel files differ.
 */
export async function desktopFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `gateway-${name}-`));
  const home = join(root, "home"); const app = join(root, "ChatGPT.app"); const state = join(root, "state");
  const codex = join(app, "Contents/Resources/codex-cli/bin/codex");
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true, mode: 0o700 });
  await mkdir(join(app, "Contents/MacOS"), { recursive: true }); await mkdir(join(app, "Contents/Resources/codex-cli/bin"), { recursive: true });
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(app, "Contents/MacOS/ChatGPT"), ""); await writeFile(codex, "#!/bin/sh\necho native \"$@\"\n"); await chmod(codex, 0o700);
  const gateway = join(root, "gateway"); await writeFile(gateway, "#!/bin/sh\nexit 0\n"); await chmod(gateway, 0o700);
  const config = join(root, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: state, providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: `GATEWAY_${name.toUpperCase().replaceAll("-", "_")}_KEY`, models: { fixture: "upstream" } }] });
  const values = new Map<string, string>(); const calls: string[] = [];
  const exec: LaunchctlExec = async (file, args) => {
    assert.equal(file, "/bin/launchctl"); calls.push(args.join(" "));
    if (args[0] === "getenv") {
      const value = values.get(args[1]!); if (value === undefined) throw new Error("Command failed: /bin/launchctl getenv " + args[1]);
      return { stdout: value };
    }
    if (args[0] === "setenv") values.set(args[1]!, args[2]!);
    if (args[0] === "unsetenv") values.delete(args[1]!);
    if (args[0] === "print") throw new Error("Could not find service");
    return { stdout: "" };
  };
  const receipt = join(state, "desktop-registration.json");
  return { root, home, app, state, config, gateway, values, calls, exec, receipt };
}
export type DesktopFixture = Awaited<ReturnType<typeof desktopFixture>>;

/** Runs with HOME and the installed-command hints pointed at the fixture, then drops the fixture entirely. */
export async function inDesktopHome<T>(f: DesktopFixture, run: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND };
  process.env.HOME = f.home; process.env.GATEWAY_INSTALLED = "1"; process.env.GATEWAY_COMMAND = f.gateway;
  try { return await run(); } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.installed === undefined) delete process.env.GATEWAY_INSTALLED; else process.env.GATEWAY_INSTALLED = saved.installed;
    if (saved.command === undefined) delete process.env.GATEWAY_COMMAND; else process.env.GATEWAY_COMMAND = saved.command;
    await rm(f.root, { recursive: true, force: true });
  }
}

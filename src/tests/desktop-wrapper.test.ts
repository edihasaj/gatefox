import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";

test("the desktop wrapper adapts only app-server sessions and runs other Codex commands directly", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-wrapper-"));
  const app = join(root, "ChatGPT.app"); const codex = join(app, "Contents/Resources/codex-cli/bin/codex");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true }); await mkdir(join(app, "Contents/Resources/codex-cli/bin"), { recursive: true });
  await writeFile(join(app, "Contents/MacOS/ChatGPT"), ""); await writeFile(codex, "#!/bin/sh\necho native \"$@\"\n"); await chmod(codex, 0o700);
  const gateway = join(root, "gateway"); await writeFile(gateway, "#!/bin/sh\necho adapter \"$@\"\n"); await chmod(gateway, 0o700);
  const config = join(root, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: join(root, "state"), providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_WRAPPER_FIXTURE_KEY", models: { fixture: "upstream" } }] });
  await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
  const previous = { installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND };
  process.env.GATEWAY_INSTALLED = "1"; process.env.GATEWAY_COMMAND = gateway;
  try {
    const { wrapper } = await prepareDesktop(config, app);
    const run = (...args: string[]) => execFileSync(wrapper, args, { encoding: "utf8" }).trim();
    assert.equal(run("exec-server", "--listen", "unix://x"), "native exec-server --listen unix://x", "no adapter process for exec-server");
    assert.equal(run("--version"), "native --version");
    assert.match(run("-c", "features.code_mode_host=true", "app-server", "--listen", "stdio://"), /^adapter codex-shim --config .* -- -c features\.code_mode_host=true app-server --listen stdio:\/\/$/);
  } finally {
    if (previous.installed === undefined) delete process.env.GATEWAY_INSTALLED; else process.env.GATEWAY_INSTALLED = previous.installed;
    if (previous.command === undefined) delete process.env.GATEWAY_COMMAND; else process.env.GATEWAY_COMMAND = previous.command;
    await rm(root, { recursive: true, force: true });
  }
});

test("the desktop wrapper gives app-server the signed engine behind ChatGPT's launcher", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-wrapper-engine-"));
  const app = join(root, "ChatGPT.app"); const launcher = join(app, "Contents/Resources/codex-cli/bin/codex");
  const signed = join(app, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true }); await mkdir(dirname(launcher), { recursive: true }); await mkdir(dirname(signed), { recursive: true });
  await writeFile(join(app, "Contents/MacOS/ChatGPT"), "");
  await writeFile(launcher, '#!/bin/sh\nexec "$(dirname "$0")/../CodexCLI.app/Contents/MacOS/codex" "$@"\n', { mode: 0o700 });
  await writeFile(signed, '#!/bin/sh\necho native-signed "$@"\n', { mode: 0o700 });
  const gateway = join(root, "gateway"); await writeFile(gateway, "#!/bin/sh\necho adapter \"$@\"\n", { mode: 0o700 });
  const config = join(root, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: join(root, "state"), providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_WRAPPER_ENGINE_FIXTURE_KEY", models: { fixture: "upstream" } }] });
  await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
  const previous = { installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND };
  process.env.GATEWAY_INSTALLED = "1"; process.env.GATEWAY_COMMAND = gateway;
  try {
    const engine = await realpath(signed); const { wrapper } = await prepareDesktop(config, app); const content = await readFile(wrapper, "utf8");
    assert.ok(content.includes(`'--codex' '${engine}'`), "only app-server receives the signed engine path");
    const run = (...args: string[]) => execFileSync(wrapper, args, { encoding: "utf8" }).trim();
    assert.equal(run("app-server", "--listen", "stdio://").endsWith(`--codex ${engine} -- app-server --listen stdio://`), true);
    assert.equal(run("--version"), "native-signed --version", "non-app-server commands still enter ChatGPT's launcher");
  } finally {
    if (previous.installed === undefined) delete process.env.GATEWAY_INSTALLED; else process.env.GATEWAY_INSTALLED = previous.installed;
    if (previous.command === undefined) delete process.env.GATEWAY_COMMAND; else process.env.GATEWAY_COMMAND = previous.command;
    await rm(root, { recursive: true, force: true });
  }
});

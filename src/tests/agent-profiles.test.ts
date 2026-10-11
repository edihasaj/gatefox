import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupAgents, agentExecutorSettings } from "../agent-profiles.js";
import { gatewayEngineHome } from "../gateway-engine-home.js";
import type { GatewayConfig } from "../config.js";

test("gateway roles select offered models and stay out of the primary home", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-roles-")); const native = join(root, "native"); await mkdir(native);
  await writeFile(join(native, "config.toml"), 'model = "native"\n');
  const config: GatewayConfig = { version: 1, port: 3457, providers: [], stateDirectory: join(root, "state") };
  const catalog = ["codex/sol", "codex/astra", "qwen/local"].map(slug => ({ slug, supported_reasoning_levels: [{ effort: "high" }] }));
  await assert.rejects(setupAgents(config, catalog, { coordinator: "missing", verifier: "codex/astra", worker: "qwen/local" }), /offered/);
  await setupAgents(config, catalog, { coordinator: "codex/sol", verifier: "codex/astra", worker: "qwen/local" });
  const settings = await agentExecutorSettings(config, { agents: { max_concurrent_threads_per_session: 30 } });
  assert.deepEqual(settings.settings.agents, { max_concurrent_threads_per_session: 30, default_subagent_model: "qwen/local", default_subagent_reasoning_effort: "high" });
  const before = process.env.CODEX_HOME; process.env.CODEX_HOME = native;
  try {
    const home = await gatewayEngineHome(join(root, "generation"), settings.settings, settings.directory);
    assert.equal(await readlink(join(home, "agents")), settings.directory);
    assert.ok((await readFile(join(home, "agents/worker.toml"), "utf8")).includes('model = "qwen/local"'));
    assert.equal(await readFile(join(native, "config.toml"), "utf8"), 'model = "native"\n');
    await assert.rejects(readFile(join(native, "agents/worker.toml")), { code: "ENOENT" });
  } finally { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readlink, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayEngineHome } from "../gateway-engine-home.js";

test("private executor follows global AGENTS created later and never links native config or auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-instructions-")); const native = join(root, "native"); await mkdir(native);
  await writeFile(join(native, "config.toml"), 'model = "native"\n'); await writeFile(join(native, "auth.json"), "fake-primary-auth");
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = native;
  try {
    const home = await gatewayEngineHome(join(root, "state"), { model: "native", model_providers: { openai: { env_key: "NOT_COPIED" } }, forced_login_method: "chatgpt" });
    assert.equal(await readlink(join(home, "AGENTS.md")), join(native, "AGENTS.md"));
    await writeFile(join(native, "AGENTS.md"), "instructions-created-after-executor-start");
    assert.equal(await readFile(join(home, "AGENTS.md"), "utf8"), "instructions-created-after-executor-start");
    assert.equal(await readFile(join(native, "config.toml"), "utf8"), 'model = "native"\n');
    const copied = await readFile(join(home, "config.toml"), "utf8"); assert.ok(!copied.includes("NOT_COPIED")); assert.ok(!copied.includes("forced_login_method"));
    await assert.rejects(readlink(join(home, "config.toml"))); await assert.rejects(access(join(home, "auth.json")));
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test("gateway chats share the native hooks and saved prompts, so client hooks fire there too", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-hooks-")); const native = join(root, "native"); await mkdir(join(native, "prompts"), { recursive: true });
  await writeFile(join(native, "hooks.json"), '{"hooks":{}}'); await writeFile(join(native, "prompts", "review.md"), "Review prompt");
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = native;
  try {
    const home = await gatewayEngineHome(join(root, "state"), { model: "native" });
    assert.equal(await readlink(join(home, "hooks.json")), join(native, "hooks.json"));
    assert.equal(await readFile(join(home, "prompts", "review.md"), "utf8"), "Review prompt");
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

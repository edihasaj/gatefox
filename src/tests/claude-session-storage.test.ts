import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeCliArgs, claudeEnv } from "../providers/claude-control.js";
import { ClaudeSession, sweepSessionDirectories } from "../providers/claude-session.js";
import { installClaudeFixture, type ClaudeFixture } from "./claude-cli-fixture.js";

const base = () => join(tmpdir(), "gateway-claude-v2");
const key = `facefeed${process.pid.toString(16).padStart(8, "0")}`.padEnd(64, "0");

async function start(f: ClaudeFixture): Promise<{ session: ClaudeSession; directory: string; cwd: string }> {
  let directory = "";
  const options = {
    key, fingerprint: "fixture", window: "", env: claudeEnv(undefined, true), mcpCatalog: [], systemPrompt: "Test fixture.",
    // Also lets this test reproduce the legacy cleanup behavior on the old implementation.
    keyInUse: () => false, onClose: () => {},
    args: (mcpPath: string, systemPath: string) => {
      directory = dirname(mcpPath);
      return claudeCliArgs({ mcpPath, systemPath, model: "fixture", fast: false, thinkingDisplay: false });
    },
  };
  const session = await ClaudeSession.start(options, new AbortController().signal);
  const cwd = (await f.capture()).find(entry => entry.pid === session.pid && entry.start)?.cwd;
  assert.ok(cwd);
  return { session, directory, cwd };
}

test("late legacy cleanup cannot delete a replacement session's cwd or control files", async () => {
  const f = await installClaudeFixture();
  const legacy = join(tmpdir(), "gateway-claude", key.slice(0, 16));
  let replacement: Awaited<ReturnType<typeof start>> | undefined;
  try {
    await mkdir(join(legacy, "work"), { recursive: true, mode: 0o700 });
    // The old cleaner has already checked that only its work directory remains.
    assert.deepEqual(await readdir(legacy), ["work"]);
    replacement = await start(f);
    // An older runtime's startup sweep sees only the legacy root as well.
    for (const name of await readdir(legacy)) {
      if (name !== "work") await rm(join(legacy, name), { recursive: true, force: true });
    }
    // Its queued recursive removal resumes after the replacement has finished booting.
    await rm(legacy, { recursive: true, force: true });
    assert.equal((await lstat(replacement.cwd)).isDirectory(), true);
    assert.equal((await lstat(join(replacement.directory, "mcp.json"))).isFile(), true);
    assert.equal(await replacement.session.applyEffort("high"), true);
  } finally { await replacement?.session.close("closed", "test", true); await rm(legacy, { recursive: true, force: true }); await f.restore(); }
});

test("overlapping generations own separate working directories and remove only their own files", async () => {
  const f = await installClaudeFixture();
  const generations: Awaited<ReturnType<typeof start>>[] = [];
  try {
    generations.push(await start(f), await start(f));
    const [first, second] = generations;
    assert.notEqual(first.cwd, second.cwd);
    await writeFile(join(second.cwd, "owned"), "replacement");
    await first.session.close("closed", "test", true);
    await assert.rejects(lstat(first.directory), { code: "ENOENT" });
    await assert.rejects(lstat(first.cwd), { code: "ENOENT" });
    assert.equal((await lstat(join(second.cwd, "owned"))).isFile(), true);
    assert.equal(await second.session.applyEffort("high"), true);
    await second.session.close("closed", "test", true);
    await assert.rejects(lstat(second.cwd), { code: "ENOENT" });
  } finally { for (const generation of generations) await generation.session.close("closed", "test", true); await f.restore(); }
});

test("the sweep removes a dead flat generation and its cwd while keeping a live owner's files", async () => {
  const dead = join(base(), `${(2 ** 22 + 12345).toString(36)}-fixture`);
  const live = join(base(), `${process.pid.toString(36)}-fixture`);
  try {
    for (const directory of [dead, live]) {
      await mkdir(join(directory, "work"), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "work", "owned"), "fixture");
    }
    await sweepSessionDirectories();
    await assert.rejects(lstat(dead), { code: "ENOENT" });
    assert.equal((await lstat(join(live, "work", "owned"))).isFile(), true);
  } finally { for (const directory of [dead, live]) await rm(directory, { recursive: true, force: true }); }
});

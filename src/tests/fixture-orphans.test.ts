import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import { shortFolder } from "./short-folder.js";

// A scripted CLI that a stopped test run leaves behind would run for ever, writing into a folder that is gone. Each of them leaves
// when its parent does, whatever else keeps it running (a signal it ignores, a timer that never ends).
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pid: number) => { while (alive(pid)) await new Promise(resolve => setTimeout(resolve, 10)); };

/**
 * Starts `command` as the child of a process that this test then kills outright; resolves with the child's pid once the parent is gone.
 * The parent stays up, with the child's input open, until it is killed.
 */
async function orphan(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<number> {
  const script = `const { spawn } = require("node:child_process");
const child = spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, { stdio: ["pipe", "ignore", "ignore"], env: ${JSON.stringify(env)} });
${input ? `child.stdin.write(${JSON.stringify(input)});` : ""}
child.once("spawn", () => { console.log(child.pid); }); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  const [chunk] = await once(parent.stdout!, "data") as [Buffer]; const pid = Number(String(chunk).trim());
  assert.ok(alive(pid), "the CLI is running while its parent is");
  parent.kill("SIGKILL"); await once(parent, "exit");
  return pid;
}

test("the scripted Copilot CLI that ignores SIGTERM and its input's end leaves when its parent is gone", { skip: process.platform === "win32", timeout: 60000 }, async () => {
  let pid: number | undefined;
  try {
    pid = await orphan(process.execPath, [fileURLToPath(new URL("./copilot-live-fixture.js", import.meta.url))], { ...process.env, GATEWAY_COPILOT_LIVE_IGNORE_TERM: "1" });
    await gone(pid);
  } finally { if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL"); }
});

test("the scripted Claude CLI that streams until it is interrupted leaves when its parent is gone", { skip: process.platform === "win32", timeout: 60000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ slow: true }] }); const work = await shortFolder("gw-orphan-"); let pid: number | undefined;
  try {
    const system = join(work.directory, "system.txt"); const mcp = join(work.directory, "mcp.json");
    await writeFile(system, "system"); await writeFile(mcp, JSON.stringify({ mcpServers: {} }));
    // One user message starts a reply that never ends on its own.
    const user = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } }) + "\n";
    pid = await orphan(join(fixture.directory, "claude"), ["--system-prompt-file", system, "--mcp-config", mcp], { ...process.env }, user);
    await gone(pid);
  } finally { if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL"); await fixture.restore(); await work.remove(); }
});

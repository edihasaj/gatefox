import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { alive, harness, until } from "./copilot-live-harness.js";

// A gateway that exits (process.exit, or the end of its event loop) without closing what it started must still leave no
// Copilot CLI and no folder with a prompt log behind: a live session, a one-shot request, and a session still starting.
const child = `
const h = await import(${JSON.stringify(new URL("./copilot-live-harness.js", import.meta.url).href)});
const { readFile } = await import("node:fs/promises");
const log = async () => (await readFile(process.env.GATEWAY_COPILOT_LIVE_LOG, "utf8").catch(() => "")).split("\\n").filter(Boolean).map(line => JSON.parse(line));
const until = async check => { while (!(await check())) await new Promise(resolve => setTimeout(resolve, 15)); };
// A live session waiting for tool outputs.
await h.turn(h.adapter(), [h.user("go [tool]")]);
// A one-shot request that is still running.
void h.turn(h.adapter({ mode: "oneshot" }), [h.user("go [hang]")], { context: { threadId: "one-shot" } }).catch(() => {});
await until(async () => (await log()).filter(entry => entry.op === "session.sendMessages").length === 2);
// A live session whose CLI never answers session.create.
process.env.GATEWAY_COPILOT_LIVE_STALL = process.argv[1];
void h.turn(h.adapter(), [h.user("hello")], { context: { threadId: "starting" } }).catch(() => {});
await until(async () => (await log()).some(entry => entry.op === "stalled"));
process.exit(0);
`;

test("a gateway that exits without closing anything kills every Copilot CLI it started and removes their folders", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const exited = new Promise<number | null>(resolve => {
      const process_ = spawn(process.execPath, ["--input-type=module", "-e", child, h.stall], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
      process_.once("exit", code => resolve(code));
    });
    assert.equal(await exited, 0);
    const pids = await h.pids(); assert.equal(pids.length, 3, "a live CLI, a one-shot CLI and a starting CLI ran");
    assert.deepEqual(await h.liveDirs(), [], "every folder was removed before the process ended");
    for (const pid of pids) assert.ok(await until(() => !alive(pid)), `CLI ${pid} was killed with its gateway`);
  } finally { await h.restore(); }
});

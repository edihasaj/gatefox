import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayToken } from "../config.js";
import { readTelemetry } from "../telemetry.js";
import { readUsageLedger } from "../usage-ledger.js";
import { alive, harness, providerId, until, user } from "./copilot-live-harness.js";

// End to end through the real CLI: a one-shot Copilot request has reported a billed call and is stopped by SIGTERM, and its
// CLI ends too slowly for the request to end before the process leaves (the exit deadline, the drain
// plus 1.5 s). The process must still leave the request's ledger row and failure record behind.
test("serve leaves the ledger row of a request it stopped at shutdown, though its CLI was still ending when the process exited", { skip: process.platform === "win32", timeout: 40000 }, async () => {
  // The CLI ignores SIGTERM and answers `session.abort` too late: only the gateway's own bounds end it.
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_ABORT = "10000"; process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM = "1";
  const state = join(h.directory, "state"); const config = join(h.directory, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: 0, stateDirectory: state, providers: [{ id: providerId, type: "copilot-subscription", models: { alias: "fixture" }, copilotSessions: { mode: "oneshot" } }] }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../cli.js", import.meta.url)), "serve", "--config", config], {
    env: { ...process.env, GATEWAY_SHUTDOWN_DRAIN_MS: "100", GATEWAY_ERROR_REPORTS: "off", GATEWAY_TELEMETRY: "" }, stdio: ["ignore", "ignore", "pipe"] });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.stderr!.on("data", chunk => { const match = /Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(chunk)); if (match) resolve(Number(match[1])); });
      child.once("exit", code => reject(new Error(`server exited ${code}`)));
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${await gatewayToken(state)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "alias", input: [user("go [stall]")], stream: true }) });
    reader = response.body!.getReader();
    // The CLI reports a billed call (1e9 nano-AIU), then the text, then nothing: the server has taken the usage once the text is out.
    let seen = ""; const decoder = new TextDecoder();
    while (!seen.includes("partial")) { const { value, done } = await reader.read(); if (done) break; seen += decoder.decode(value); }
    assert.ok(seen.includes("partial"), "the request is streaming");
    // The stopped CLI never ends, so a process that waited for it would not exit at all (the test's timeout); it leaves at its exit deadline.
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0);
    const [row, ...rest] = (await readUsageLedger(state, 0)).filter(entry => entry.origin === "gateway");
    assert.equal(rest.length, 0);
    assert.deepEqual([row?.status, row?.inputTokens, row?.nanoAiu, row?.nanoAiuStatus], ["failed", 100, 1e9, "complete"], "the billed call is in the ledger");
    const telemetry = await readTelemetry(state, 0); const failed = telemetry.find(event => event.event === "request_failed");
    assert.ok(failed, "and the request's failure record is in telemetry"); assert.equal(failed.abortCause, "shutdown"); assert.equal(failed.nanoAiu, 1e9);
    // The drain writes its record only when it ends (after the 3 s usage wait), so a process that left earlier left by its deadline.
    assert.ok(!telemetry.some(event => event.event === "server_drain"), "the process left at the exit deadline, before the drain ended");
    for (const pid of await h.pids()) assert.ok(await until(() => !alive(pid)), `the CLI ${pid} did not outlive the gateway`);
  } finally {
    await reader?.cancel().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit").catch(() => {}); }
    await h.restore();
  }
});

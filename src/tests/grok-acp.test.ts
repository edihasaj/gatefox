import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpConnection, AcpError } from "../providers/grok-acp.js";
import { ProviderError } from "../providers/provider.js";
import { alive, until } from "./grok-live-harness.js";

function open(code: string, env: NodeJS.ProcessEnv = {}) {
  const closed: Array<{ reason: string; error?: ProviderError }> = [];
  const conn = new AcpConnection({ command: process.execPath, args: ["-e", code], cwd: tmpdir(), env: { ...process.env, ...env } },
    { notification() {}, request: () => ({}), closed: (reason, error) => { closed.push({ reason, error }); } });
  return { conn, closed };
}

test("kill() ends descendants even when the leader already exited", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join("/tmp", "gateway-test-acp-")); const pidFile = join(directory, "child.pid"); let child = 0;
  try {
    // The leader starts a child in its process group and exits at once.
    const { conn, closed } = open(`const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(process.env.PID_FILE, String(c.pid)); process.exit(0);`, { PID_FILE: pidFile });
    assert.ok(await until(() => closed.length > 0), "the leader exited");
    child = Number(await readFile(pidFile, "utf8"));
    assert.ok(child > 0 && alive(child), "the child outlived its leader");
    conn.kill();
    assert.ok(await until(() => !alive(child)), "kill() ended the child");
    conn.kill(); // idempotent
  } finally { if (child) try { process.kill(child, "SIGKILL"); } catch { /* Gone. */ } await rm(directory, { recursive: true, force: true }); }
});

for (const frame of ["null", "[]", "42", '"text"']) {
  test(`a ${frame} frame ends the connection with invalid_stream and kills the process`, { timeout: 20000 }, async () => {
    const { conn, closed } = open(`process.stdout.write(${JSON.stringify(frame + "\n")}); setInterval(() => {}, 1000);`);
    const pid = conn.pid!;
    await assert.rejects(conn.request("initialize", {}), (error: unknown) => error instanceof ProviderError && error.code === "invalid_stream" && error.status === 502);
    assert.equal(closed.length, 1); assert.equal(closed[0].reason, "failed"); assert.equal(closed[0].error?.code, "invalid_stream");
    assert.ok(await until(() => !alive(pid)), "the CLI is gone");
    await assert.rejects(conn.request("again", {}), (error: unknown) => error instanceof ProviderError);
  });
}

// Shapes that break the protocol. The first request a test sends has id 1; the frame answers it or arrives unprompted.
const shapes: Record<string, string> = {
  "error message is an object that throws when coerced": '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":{"toString":null}}}',
  "error message is a number": '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":7}}',
  "error message is missing": '{"jsonrpc":"2.0","id":1,"error":{"code":-32000}}',
  "error code is a string": '{"jsonrpc":"2.0","id":1,"error":{"code":"-32000","message":"x"}}',
  "error code is null": '{"jsonrpc":"2.0","id":1,"error":{"code":null,"message":"x"}}',
  "error code is an object": '{"jsonrpc":"2.0","id":1,"error":{"code":{"valueOf":null},"message":"x"}}',
  "error is a string": '{"jsonrpc":"2.0","id":1,"error":"boom"}',
  "error is an array": '{"jsonrpc":"2.0","id":1,"error":[]}',
  "error is a number": '{"jsonrpc":"2.0","id":1,"error":5}',
  "error is null": '{"jsonrpc":"2.0","id":1,"error":null}',
  "result is a string": '{"jsonrpc":"2.0","id":1,"result":"ok"}',
  "result is an array": '{"jsonrpc":"2.0","id":1,"result":[]}',
  "result is a number": '{"jsonrpc":"2.0","id":1,"result":1}',
  "result is null": '{"jsonrpc":"2.0","id":1,"result":null}',
  "response has neither result nor error": '{"jsonrpc":"2.0","id":1}',
  "response id is an object": '{"jsonrpc":"2.0","id":{"toString":null},"result":{}}',
  "response id is an array": '{"jsonrpc":"2.0","id":[1],"result":{}}',
  "response id is a boolean": '{"jsonrpc":"2.0","id":true,"result":{}}',
  "method is a number": '{"jsonrpc":"2.0","id":9,"method":5,"params":{}}',
  "method is an object": '{"jsonrpc":"2.0","method":{"toString":null},"params":{}}',
  "method is null": '{"jsonrpc":"2.0","id":9,"method":null}',
  "notification params is an array": '{"jsonrpc":"2.0","method":"session/update","params":[]}',
  "notification params is a string": '{"jsonrpc":"2.0","method":"session/update","params":"x"}',
  "request params is null": '{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":null}',
  "extension-looking notification params is null outside the _x.ai namespace": '{"jsonrpc":"2.0","method":"session/update","params":null}',
  "an _x.ai notification whose params is an array": '{"jsonrpc":"2.0","method":"_x.ai/session_state","params":[]}',
  "request id is an object": '{"jsonrpc":"2.0","id":{"a":1},"method":"session/request_permission","params":{}}',
};
const answerOnce = (frame: string) => `process.stdin.once("data", () => { process.stdout.write(${JSON.stringify(frame + "\n")}); }); setInterval(() => {}, 1000);`;

for (const [name, frame] of Object.entries(shapes)) {
  test(`shape fuzz: ${name} ends the connection with invalid_stream, kills the process and does not throw`, { timeout: 20000 }, async () => {
    const { conn, closed } = open(answerOnce(frame));
    const pid = conn.pid!;
    await assert.rejects(conn.request("initialize", {}), (error: unknown) => error instanceof ProviderError && error.code === "invalid_stream" && error.status === 502);
    assert.equal(closed.length, 1); assert.equal(closed[0].reason, "failed"); assert.equal(closed[0].error?.code, "invalid_stream");
    assert.ok(await until(() => !alive(pid)), "the CLI is gone");
  });
}

test("well-formed frames still work: an error response becomes an AcpError, a result resolves, and requests and notifications reach the handlers", { timeout: 20000 }, async () => {
  const seen: string[] = [];
  const script = `const lines = require("node:readline").createInterface({ input: process.stdin }); let n = 0;
    lines.on("line", () => { n++;
      if (n === 1) process.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}\\n{"jsonrpc":"2.0","id":"r1","method":"ping","params":{}}\\n{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"authentication required","data":{"code":"x"}}}\\n');
      else process.stdout.write('{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}\\n'); });`;
  const conn = new AcpConnection({ command: process.execPath, args: ["-e", script], cwd: tmpdir(), env: { ...process.env } },
    { notification: method => { seen.push(`n:${method}`); }, request: method => { seen.push(`r:${method}`); return { pong: true }; }, closed() {} });
  try {
    await assert.rejects(conn.request("a", {}), (error: unknown) => error instanceof AcpError && error.code === -32000 && error.message === "authentication required");
    assert.deepEqual((await conn.request("b", {})).stopReason, "end_turn");
    assert.deepEqual(seen, ["n:session/update", "r:ping"]);
  } finally { conn.kill(); }
});

test("`params: null` on an _x.ai/* notification or request is treated as absent: the connection stays up and the request is answered", { timeout: 20000 }, async () => {
  const seen: Array<{ kind: string; method: string; params: unknown }> = []; const closed: string[] = [];
  const script = `const lines = require("node:readline").createInterface({ input: process.stdin });
    lines.on("line", line => { const m = JSON.parse(line);
      if (m.method === "initialize") process.stdout.write('{"jsonrpc":"2.0","method":"_x.ai/session_state","params":null}\\n{"jsonrpc":"2.0","id":"r1","method":"_x.ai/ping","params":null}\\n');
      else if (m.id === "r1") process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"seen":' + JSON.stringify(JSON.stringify(m)) + '}}\\n'); });`;
  const conn = new AcpConnection({ command: process.execPath, args: ["-e", script], cwd: tmpdir(), env: { ...process.env } },
    { notification: (method, params) => { seen.push({ kind: "n", method, params }); }, request: (method, params) => { seen.push({ kind: "r", method, params }); return { pong: true }; }, closed: reason => { closed.push(reason); } });
  try {
    const answer = await conn.request("initialize", {});
    assert.deepEqual(seen, [{ kind: "n", method: "_x.ai/session_state", params: {} }, { kind: "r", method: "_x.ai/ping", params: {} }]);
    assert.deepEqual(JSON.parse(String(answer.seen)).result, { pong: true }, "the request got its answer");
    assert.deepEqual(closed, []);
  } finally { conn.kill(); }
});

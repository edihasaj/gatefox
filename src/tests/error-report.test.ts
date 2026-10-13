import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exceptionEvent, parseDsn, reportException, scrub, startErrorReports } from "../error-report.js";

test("DSNs require HTTPS except on loopback, and resolve to the store endpoint", () => {
  assert.deepEqual(parseDsn("https://abc123@errors.example.com/42"), { url: "https://errors.example.com/api/42/store/", auth: "Sentry sentry_version=7, sentry_client=harness-gateway/1, sentry_key=abc123" });
  assert.equal(parseDsn("http://abc@errors.example.com/42"), undefined);
  assert.equal(parseDsn("https://errors.example.com/42"), undefined);
  assert.ok(parseDsn("http://abc@127.0.0.1:9/7"));
});

test("scrubbing removes credentials, long secrets, home paths and URL paths", () => {
  const text = scrub("Bearer abcdef123 failed for sk-ant-api03-xyzxyzxyzxyz at /Users/edi/Projects/private/x.ts calling https://api.example.com/v1/responses?key=1 with " + "A".repeat(40));
  for (const leaked of ["abcdef123", "xyzxyz", "/Users/edi", "/v1/responses", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) assert.ok(!text.includes(leaked), leaked);
  assert.match(text, /\.\.\.\/x\.ts/); assert.match(text, /https:\/\/api\.example\.com/);
});

test("events carry only type, scrubbed message, frames and anonymous metadata", () => {
  const event = exceptionEvent(new TypeError("Cannot read token=abc of undefined"), "rpc:thread/start") as { exception: { values: Array<{ type: string; value: string; stacktrace: { frames: Array<Record<string, unknown>> } }> }; server_name: string; user?: unknown; request?: unknown };
  const value = event.exception.values[0];
  assert.equal(value.type, "TypeError"); assert.ok(!value.value.includes("abc"));
  assert.ok(value.stacktrace.frames.length > 0); assert.ok(value.stacktrace.frames.every(frame => !String(frame.filename).includes("/Users/")));
  assert.match(event.server_name, /^mac-[0-9a-f]{8}$|^unknown$/); assert.equal(event.user, undefined); assert.equal(event.request, undefined);
});

test("handled exceptions post in the background once, and a crash is spooled then delivered on the next start", async () => {
  const received: Array<{ auth?: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => { let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => { received.push({ auth: req.headers["x-sentry-auth"] as string, body: JSON.parse(body) }); res.writeHead(200); res.end("{}"); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const state = await mkdtemp(join(tmpdir(), "gateway-errors-"));
  try {
    await writeFile(join(state, "glitchtip.dsn"), `http://publickey@127.0.0.1:${(server.address() as { port: number }).port}/5`, { mode: 0o600 });
    startErrorReports(state, "test");
    const failure = new Error("unexpected internal state");
    reportException(failure, "unit"); reportException(failure, "unit");
    for (let i = 0; i < 100 && received.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(received.length, 1, "a repeat of the same failure is not resent"); assert.match(received[0].auth!, /sentry_key=publickey/);
    // A real crash: the child spools synchronously, Node still exits with the error.
    const script = `import { startErrorReports } from ${JSON.stringify(new URL("../error-report.js", import.meta.url).href)}; startErrorReports(${JSON.stringify(state)}, "child"); setTimeout(() => { throw new RangeError("child crash"); }, 10);`;
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" }), /child crash/);
    assert.equal((await readdir(join(state, "error-spool"))).length, 1);
    startErrorReports(state, "test");
    for (let i = 0; i < 100 && received.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const crash = received[1].body as { level: string; exception: { values: Array<{ type: string }> } };
    assert.equal(crash.level, "fatal"); assert.equal(crash.exception.values[0].type, "RangeError");
    for (let i = 0; i < 50 && (await readdir(join(state, "error-spool"))).length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await readdir(join(state, "error-spool"))).length, 0, "a delivered crash leaves the spool");
  } finally { server.close(); await rm(state, { recursive: true, force: true }); }
});

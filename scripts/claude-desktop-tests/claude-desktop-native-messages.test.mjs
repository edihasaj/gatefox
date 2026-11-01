import assert from "node:assert/strict";
import { spawn as nativeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { isNativeClassifierRequest, runNativeMessages } from "../claude-desktop-native-messages.mjs";

const nativeModel = "claude-sonnet-5";
const base = () => ({
  model: nativeModel, max_tokens: 64, stream: false,
  system: [{ type: "text", text: "Original system." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Original request." }] }],
  thinking: { type: "disabled" }, temperature: 1, stop_sequences: ["</severity>"],
  output_config: { effort: "low" }, tools: [], tool_choice: { type: "none" },
});

function line(value) { return `${JSON.stringify(value)}\n`; }

function successfulLines(model = nativeModel) {
  return [
    line({ type: "system", subtype: "init" }),
    line({ type: "stream_event", event: { type: "message_start", message: {
      id: "msg_real", type: "message", role: "assistant", model,
      usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 0 },
    } } }),
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "genuine " } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } } }),
    line({ type: "assistant", message: {
      id: "msg_real", type: "message", role: "assistant", model, content: [{ type: "text", text: "genuine answer" }],
    } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    line({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "stop_sequence", stop_sequence: "</severity>" },
      usage: { output_tokens: 4 } } }),
    line({ type: "stream_event", event: { type: "message_stop" } }),
    line({ type: "result", subtype: "success", is_error: false }),
  ];
}

function fixture({ lines = successfulLines(), code = 0, hang = false, chunks } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const call = { command, args, options, input: "" };
    calls.push(call);
    const child = new EventEmitter();
    child.pid = 999999;
    child.exitCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      call.signals ??= [];
      call.signals.push(signal);
      child.exitCode = null;
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    child.stdin.on("data", (chunk) => { call.input += chunk; });
    child.stdin.on("finish", () => {
      if (hang) return;
      const output = chunks ?? lines;
      for (const chunk of output) child.stdout.write(chunk);
      child.stdout.end();
      child.stderr.end();
      child.exitCode = code;
      queueMicrotask(() => child.emit("close", code, null));
    });
    return child;
  };
  return { spawn, calls };
}

async function rejects(promise, status) {
  await assert.rejects(promise, (error) => error instanceof Error && error.status === status && !/Original request|secret|argument/i.test(error.message));
}

test("returns only a complete native text message and preserves original controls in EXTRA_BODY", async () => {
  const lines = successfulLines();
  lines.splice(1, 0, line({ type: "rate_limit_event", status: "allowed_warning", overageStatus: "rejected" }));
  const fake = fixture({ chunks: lines.flatMap((entry) => [entry.slice(0, 7), entry.slice(7)]) });
  const result = await runNativeMessages(base(), nativeModel, {
    command: "/absolute/claude", authDirectory: "/absolute/claude-auth", spawn: fake.spawn,
    headers: { "x-claude-code-request-class": "auxiliary", "anthropic-beta": "caller-beta" },
  });
  assert.deepEqual(result, {
    id: "msg_real", type: "message", role: "assistant", model: nativeModel,
    content: [{ type: "text", text: "genuine answer" }],
    stop_reason: "stop_sequence", stop_sequence: "</severity>",
    usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 4 },
  });
  const [{ command, args, options }] = fake.calls;
  assert.equal(command, "/absolute/claude");
  for (const flag of ["--safe-mode", "--restricted", "--disable-slash-commands", "--print", "--no-session-persistence",
    "--include-partial-messages", "--verbose", "--permission-mode", "--permission-prompts", "--input-format", "--output-format"]) assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(args.indexOf("--input-format"), args.indexOf("--input-format") + 2), ["--input-format", "stream-json"]);
  assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), ["--output-format", "stream-json"]);
  assert.deepEqual(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 2), ["--max-turns", "1"]);
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.deepEqual(args.slice(args.indexOf("--mcp-config"), args.indexOf("--mcp-config") + 2), ["--mcp-config", '{"mcpServers":{}}']);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, "/absolute/claude-auth");
  assert.equal(options.env.CLAUDE_CODE_EFFORT_LEVEL, "unset");
  assert.equal(options.env.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal(options.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, "1");
  assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
  assert.equal(options.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "0");
  assert.equal(options.env.ANTHROPIC_CUSTOM_HEADERS, "x-claude-code-request-class: auxiliary");
  assert.equal(options.env.ANTHROPIC_BETAS, "caller-beta,auto-mode-classifier-2026-07-16");
  const body = JSON.parse(options.env.CLAUDE_CODE_EXTRA_BODY);
  assert.deepEqual(body.system, base().system);
  assert.deepEqual(body.messages, base().messages);
  assert.equal(body.model, nativeModel);
  assert.deepEqual(body.thinking, base().thinking);
  assert.equal(body.temperature, 1);
  assert.deepEqual(body.stop_sequences, ["</severity>"]);
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.deepEqual(body.tools, []);
  assert.deepEqual(body.tool_choice, { type: "none" });
  assert.equal("stream" in body, false);
  const carrier = JSON.parse(fake.calls[0].input);
  assert.equal(carrier.message.content[0].text, "Native Messages transport carrier.");
});

test("rejects partial success, refusals, process failure, tool calls, and mismatched native models", async () => {
  const partial = successfulLines().filter((entry) => !entry.includes('"message_stop"'));
  const refusal = [...successfulLines().slice(0, -1), line({ type: "result", subtype: "error_during_execution", is_error: true })];
  const tool = [
    successfulLines()[0],
    line({ type: "stream_event", event: { type: "message_start", message: {
      id: "msg_real", type: "message", role: "assistant", model: nativeModel, usage: { input_tokens: 1 },
    } } }),
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } } }),
  ];
  for (const scenario of [
    { lines: partial }, { lines: refusal }, { lines: [], code: 1 }, { lines: tool },
    { lines: successfulLines("claude-wrong") },
  ]) {
    const fake = fixture(scenario);
    await rejects(runNativeMessages(base(), nativeModel, { command: "/absolute/claude", spawn: fake.spawn }), 502);
  }
});

test("reports count-only native usage before a later stream failure and isolates observer failures", async () => {
  const observed = [];
  const fake = fixture({ lines: [successfulLines()[1], line({ type: "unexpected" })] });
  await rejects(runNativeMessages(base(), nativeModel, { command: "/absolute/claude", spawn: fake.spawn,
    observeCacheUsage: value => observed.push(value) }), 502);
  assert.ok(observed.length >= 1);
  assert.deepEqual(observed[0], { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 0 });
  assert.equal(Object.hasOwn(observed[0], "cache_creation_input_tokens"), false);
  const mismatched = [];
  await rejects(runNativeMessages(base(), nativeModel, { command: "/absolute/claude", spawn: fixture({ lines: successfulLines("claude-wrong") }).spawn,
    observeCacheUsage: value => mismatched.push(value) }), 502);
  assert.deepEqual(mismatched[0], observed[0]);
  await runNativeMessages(base(), nativeModel, { command: "/absolute/claude", spawn: fixture().spawn,
    observeCacheUsage: () => { throw Error("observer fixture"); } });
});

test("rejects oversized inputs before spawning and terminates only its owned child on timeout or cancellation", async () => {
  const oversized = fixture();
  await rejects(runNativeMessages({ ...base(), messages: [{ role: "user", content: "x".repeat(2048) }] }, nativeModel, {
    command: "/absolute/claude", maxRequestBytes: 64, spawn: oversized.spawn,
  }), 413);
  assert.equal(oversized.calls.length, 0);

  const outputOversize = fixture({ chunks: [Buffer.alloc(1024 * 1024 + 1, "x")] });
  await rejects(runNativeMessages(base(), nativeModel, { command: "/absolute/claude", spawn: outputOversize.spawn }), 502);
  assert.deepEqual(outputOversize.calls[0].signals, ["SIGTERM"]);

  const timeout = fixture({ hang: true });
  await rejects(runNativeMessages(base(), nativeModel, { command: "/absolute/claude", timeoutMs: 10, spawn: timeout.spawn }), 408);
  assert.deepEqual(timeout.calls[0].signals, ["SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(timeout.calls[0].signals, ["SIGTERM"]);

  const controller = new AbortController();
  const cancelled = fixture({ hang: true });
  const pending = runNativeMessages(base(), nativeModel, { command: "/absolute/claude", signal: controller.signal, spawn: cancelled.spawn });
  controller.abort();
  await rejects(pending, 408);
  assert.deepEqual(cancelled.calls[0].signals, ["SIGTERM"]);
});

test("rejects header escalation and accepts the native auxiliary request size on macOS", async () => {
  const invalid = fixture();
  await rejects(runNativeMessages(base(), nativeModel, {
    command: "/absolute/claude", spawn: invalid.spawn,
    headers: { authorization: "Bearer never-forward-this" },
  }), 400);
  assert.equal(invalid.calls.length, 0);

  const large = fixture();
  const payload = { ...base(), messages: [{ role: "user", content: "x".repeat(142 * 1024) }] };
  if (process.platform === "darwin") {
    await runNativeMessages(payload, nativeModel, {
      command: "/absolute/claude", spawn: large.spawn,
      headers: { "x-claude-code-request-class": "auxiliary" },
    });
    assert.ok(Buffer.byteLength(large.calls[0].options.env.CLAUDE_CODE_EXTRA_BODY) > 96 * 1024);
  } else {
    await rejects(runNativeMessages(payload, nativeModel, {
      command: "/absolute/claude", spawn: large.spawn,
      headers: { "x-claude-code-request-class": "auxiliary" },
    }), 413);
  }
});

test("recognizes only the observed native classifier wire profiles", () => {
  assert.equal(isNativeClassifierRequest(base()), true);
  assert.equal(isNativeClassifierRequest({ ...base(), thinking: { type: "enabled" } }), false);
  assert.equal(isNativeClassifierRequest({ ...base(), tools: [{ name: "nope" }] }), false);
  assert.equal(isNativeClassifierRequest({ ...base(), max_tokens: 64, stop_sequences: ["END"] }), false);
  assert.equal(isNativeClassifierRequest({ ...base(), max_tokens: 8192, stop_sequences: undefined }), false);
  const stageTwo = { ...base(), max_tokens: 8192 };
  delete stageTwo.stop_sequences;
  assert.equal(isNativeClassifierRequest(stageTwo), true);
});

const offlineBinary = process.env.CLAUDE_NATIVE_OFFLINE_BINARY;
test("round-trips an actual native CLI through an offline local Messages fixture", {
  skip: !offlineBinary || !fs.existsSync(offlineBinary),
}, async () => {
  let received;
  let receivedHeaders;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!req.url?.startsWith("/v1/messages")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    received = JSON.parse(Buffer.concat(chunks));
    receivedHeaders = req.headers;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (name, value) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
    event("message_start", { type: "message_start", message: {
      id: "msg_offline", type: "message", role: "assistant", model: nativeModel,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 },
    } });
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "<severity>3" } });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", { type: "message_delta", delta: { stop_reason: "stop_sequence", stop_sequence: "</severity>" },
      usage: { output_tokens: 3 } });
    event("message_stop", { type: "message_stop" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-messages-offline-"));
  try {
    const original = {
      ...base(),
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(142 * 1024) }] }],
    };
    const result = await runNativeMessages(original, nativeModel, {
      command: offlineBinary,
      authDirectory: path.join(home, "config"),
      timeoutMs: 15_000,
      headers: { "x-claude-code-request-class": "auxiliary" },
      spawn: (command, args, options) => nativeSpawn(command, args, {
        ...options,
        cwd: home,
        env: { ...options.env, HOME: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "offline-fixture" },
      }),
    });
    assert.deepEqual(result.content, [{ type: "text", text: "<severity>3" }]);
    assert.equal(received.model, original.model);
    assert.deepEqual(received.system, original.system);
    assert.deepEqual(received.messages, original.messages);
    assert.equal(received.max_tokens, original.max_tokens);
    assert.deepEqual(received.thinking, original.thinking);
    assert.equal(received.temperature, original.temperature);
    assert.deepEqual(received.stop_sequences, original.stop_sequences);
    assert.deepEqual(received.tools, []);
    assert.deepEqual(received.tool_choice, { type: "none" });
    assert.equal(receivedHeaders["x-claude-code-request-class"], "auxiliary");
    assert.match(receivedHeaders["anthropic-beta"], /auto-mode-classifier-2026-07-16/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

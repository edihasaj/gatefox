// Restricted one-shot Claude Messages runner for the native Auto classifier.
// It never exposes tools, forwards no partial verdict, and returns only a
// terminal native Messages response that agrees with the complete stream.

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_REQUEST_BYTES = 192 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_ENV_ARGV_BYTES = process.platform === "darwin" ? 512 * 1024 : 128 * 1024;
const MAX_ENV_VALUE_BYTES = process.platform === "darwin" ? 256 * 1024 : 128 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TERM_GRACE_MS = 250;
const EMPTY_MCP = '{"mcpServers":{}}';
const SETTINGS = '{"alwaysThinkingEnabled":false}';
const CARRIER_TEXT = "Native Messages transport carrier.";
const CLASSIFIER_BETA = "auto-mode-classifier-2026-07-16";
const ALLOWED_TOP_LEVEL = new Set([
  "model", "max_tokens", "messages", "system", "tools", "tool_choice",
  "temperature", "top_p", "stop_sequences", "stream", "thinking",
  "output_config", "metadata", "cache_control", "context_management",
]);

function failure(message, status) {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  return error;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function absolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw failure(`${name} must be an absolute path`, 400);
  return value;
}

export function isNativeClassifierRequest(payload) {
  if (!object(payload) || typeof payload.model !== "string" || !/^claude-[A-Za-z0-9._-]+$/.test(payload.model)
      || (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length !== 0))
      || (payload.stream !== undefined && payload.stream !== false)
      || !object(payload.thinking) || Object.keys(payload.thinking).length !== 1 || payload.thinking.type !== "disabled") {
    return false;
  }
  if (payload.tool_choice !== undefined && (!object(payload.tool_choice) || payload.tool_choice.type !== "none")) return false;
  if (payload.max_tokens === 64) {
    return Array.isArray(payload.stop_sequences) && payload.stop_sequences.length === 1
      && (payload.stop_sequences[0] === "</severity>" || payload.stop_sequences[0] === "</block>");
  }
  return payload.max_tokens === 8192 && !Object.hasOwn(payload, "stop_sequences");
}

/** The exact classifier shape that this runner will also accept. The gateway and its update check share this one rule. */
export function isSupportedClassifierRequest(payload) {
  if (!isNativeClassifierRequest(payload)) return false;
  try { requestBody(payload, payload.model); return true; } catch { return false; }
}

function requestBody(payload, nativeModel) {
  if (!object(payload)) throw failure("native Messages request must be an object", 400);
  for (const key of Object.keys(payload)) if (!ALLOWED_TOP_LEVEL.has(key)) throw failure("native Messages request contains an unsupported field", 400);
  if (payload.model !== nativeModel || typeof nativeModel !== "string" || !nativeModel) {
    throw failure("native Messages request model is not configured", 400);
  }
  if (!Number.isInteger(payload.max_tokens) || payload.max_tokens <= 0) throw failure("native Messages request max_tokens is invalid", 400);
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) throw failure("native Messages request messages are invalid", 400);
  if (payload.stream !== undefined && payload.stream !== false) throw failure("native Messages runner accepts only non-streaming requests", 400);
  if (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length !== 0)) {
    throw failure("native Messages runner does not permit tools", 400);
  }
  if (payload.tool_choice !== undefined && (!object(payload.tool_choice) || payload.tool_choice.type !== "none")) {
    throw failure("native Messages runner does not permit tool choice", 400);
  }
  if (payload.temperature !== undefined && (!nonNegative(payload.temperature) || payload.temperature > 1)) {
    throw failure("native Messages request temperature is invalid", 400);
  }
  if (payload.top_p !== undefined && (!nonNegative(payload.top_p) || payload.top_p > 1)) {
    throw failure("native Messages request top_p is invalid", 400);
  }
  if (payload.stop_sequences !== undefined && (!Array.isArray(payload.stop_sequences)
      || payload.stop_sequences.some((value) => typeof value !== "string" || !value))) {
    throw failure("native Messages request stop_sequences are invalid", 400);
  }
  // EXTRA_BODY is shallow/late in Claude Code. output_config must therefore be
  // carried as its complete original object, rather than merged field by field.
  const { stream: _stream, output_config, ...extra } = payload;
  return {
    ...extra,
    tools: [],
    tool_choice: { type: "none" },
    ...(output_config === undefined ? {} : { output_config }),
  };
}

function auxiliaryHeaders(headers) {
  if (headers === undefined) return undefined;
  if (!object(headers)) throw failure("native Messages headers are invalid", 400);
  let auxiliary = false;
  let beta;
  const seen = new Set();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (seen.has(normalized) || typeof value !== "string") throw failure("native Messages headers are invalid", 400);
    seen.add(normalized);
    if (normalized === "x-claude-code-request-class") {
      if (value !== "auxiliary") throw failure("native Messages request class is invalid", 400);
      auxiliary = true;
    } else if (normalized === "anthropic-beta") {
      if (!/^[A-Za-z0-9._-]+(?:[ \t]*,[ \t]*[A-Za-z0-9._-]+)*$/.test(value) || Buffer.byteLength(value) > 4096) {
        throw failure("native Messages beta header is invalid", 400);
      }
      beta = value;
    } else {
      throw failure("native Messages headers are not permitted", 400);
    }
  }
  if (beta !== undefined && !auxiliary) throw failure("native Messages beta header requires the auxiliary class", 400);
  if (!auxiliary) return undefined;
  return { betas: (beta ?? "").split(",").map((value) => value.trim()).filter(Boolean) };
}

function nativeEnvironment(authDirectory, extraBody, headers, classifier) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_")
        || name.startsWith("CLAUDE_AGENT_SDK_") || name === "CLAUDECODE"
        || name === "CLAUDE_CONFIG_DIR" || /(?:^|_)SESSION(?:_|$)/.test(name)) delete env[name];
  }
  if (authDirectory) env.CLAUDE_CONFIG_DIR = authDirectory;
  env.CLAUDE_CODE_EXTRA_BODY = extraBody;
  // Avoid CLI defaults silently injecting effort/context-management fields.
  env.CLAUDE_CODE_EFFORT_LEVEL = "unset";
  Object.assign(env, {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_PROACTIVITY: "1",
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_AUTO_MODE_SERVER: "0",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });
  if (headers) Object.assign(env, {
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: "0",
    ANTHROPIC_CUSTOM_HEADERS: "x-claude-code-request-class: auxiliary",
  });
  if (headers?.betas.length || classifier) {
    const betas = new Set(headers?.betas);
    if (classifier) betas.add(CLASSIFIER_BETA);
    env.ANTHROPIC_BETAS = [...betas].join(",");
  }
  return env;
}

function argv(nativeModel) {
  return [
    "--safe-mode", "--restricted", "--setting-sources", "", "--disable-slash-commands",
    "--print", "--tools", "", "--strict-mcp-config", "--mcp-config", EMPTY_MCP,
    "--no-session-persistence", "--max-turns", "1", "--input-format", "stream-json",
    "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--model", nativeModel, "--permission-mode", "manual", "--permission-prompts", "none",
    "--settings", SETTINGS,
  ];
}

function sizeOfEnvironment(command, args, env) {
  return Buffer.byteLength(command) + args.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0)
    + Object.entries(env).reduce((total, [key, value]) => total + Buffer.byteLength(`${key}=${value ?? ""}`) + 1, 0);
}

function usage(value) {
  if (!object(value)) return undefined;
  const output = {};
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    if (value[key] !== undefined) {
      if (!nonNegative(value[key])) return undefined;
      output[key] = value[key];
    }
  }
  return output;
}

class NativeMessage {
  constructor(nativeModel, stopSequences) {
    this.nativeModel = nativeModel;
    this.stopSequences = new Set(stopSequences ?? []);
    this.blocks = new Map();
    this.text = "";
  }

  accept(value) {
    if (!object(value)) throw failure("native Claude stream is malformed", 502);
    if (value.is_error === true || value.type === "error" || value.subtype === "refusal") {
      throw failure("native Claude request was refused", 502);
    }
    if (value.type === "assistant") return this.assistant(value);
    if (value.type === "stream_event") return this.event(value.event);
    if (value.type === "result") {
      if (!this.stopped) throw failure("native Claude result arrived before message stop", 502);
      if (this.result) throw failure("native Claude stream has multiple terminal results", 502);
      this.result = value;
      return;
    }
    if (value.type === "system" || value.type === "command_lifecycle" || value.type === "rate_limit_event") return;
    throw failure("native Claude stream has an unexpected record", 502);
  }

  event(event) {
    if (!object(event) || typeof event.type !== "string") throw failure("native Claude stream is malformed", 502);
    if (event.type === "message_start") {
      if (this.started || !object(event.message) || typeof event.message.id !== "string" || event.message.model !== this.nativeModel) {
        throw failure("native Claude stream model is invalid", 502);
      }
      if (event.message.type !== "message" || event.message.role !== "assistant") {
        throw failure("native Claude stream start is invalid", 502);
      }
      const startUsage = usage(event.message.usage);
      if (!startUsage) throw failure("native Claude stream usage is invalid", 502);
      this.started = event.message;
      this.startUsage = startUsage;
      return;
    }
    if (!this.started) throw failure("native Claude stream started out of order", 502);
    if (event.type === "content_block_start") {
      if (this.delta || this.stopped || !Number.isInteger(event.index) || !object(event.content_block)
          || event.content_block.type !== "text" || typeof event.content_block.text !== "string" || this.blocks.has(event.index)
          || [...this.blocks.values()].some((block) => !block.stopped)) {
        throw failure("native Claude stream contains an unsupported content block", 502);
      }
      this.blocks.set(event.index, { text: event.content_block.text, stopped: false });
      this.text += event.content_block.text;
      if (Buffer.byteLength(this.text) > MAX_STDOUT_BYTES) throw failure("native Claude response is too large", 502);
      return;
    }
    if (event.type === "content_block_delta") {
      const block = this.blocks.get(event.index);
      if (!block || block.stopped || !object(event.delta) || event.delta.type !== "text_delta" || typeof event.delta.text !== "string") {
        throw failure("native Claude stream contains an unsupported delta", 502);
      }
      block.text += event.delta.text;
      this.text += event.delta.text;
      if (Buffer.byteLength(this.text) > MAX_STDOUT_BYTES) throw failure("native Claude response is too large", 502);
      return;
    }
    if (event.type === "content_block_stop") {
      const block = this.blocks.get(event.index);
      if (!block || block.stopped) throw failure("native Claude stream has inconsistent block stops", 502);
      block.stopped = true;
      return;
    }
    if (event.type === "message_delta") {
      if (this.delta || [...this.blocks.values()].some((block) => !block.stopped) || !object(event.delta)) {
        throw failure("native Claude stream stopped out of order", 502);
      }
      const stopReason = event.delta.stop_reason;
      if (!["end_turn", "stop_sequence"].includes(stopReason)
          || (stopReason === "stop_sequence" && typeof event.delta.stop_sequence !== "string")
          || (stopReason === "stop_sequence" && !this.stopSequences.has(event.delta.stop_sequence))
          || (stopReason === "end_turn" && event.delta.stop_sequence !== undefined && event.delta.stop_sequence !== null)) {
        throw failure(stopReason === "max_tokens" ? "native Claude response was truncated" : "native Claude stream stop reason is invalid", 502);
      }
      const finalUsage = usage(event.usage);
      if (!finalUsage) throw failure("native Claude stream usage is invalid", 502);
      this.delta = { stopReason, stopSequence: stopReason === "stop_sequence" ? event.delta.stop_sequence : null, usage: finalUsage };
      return;
    }
    if (event.type === "message_stop") {
      if (!this.delta || this.stopped) throw failure("native Claude stream has inconsistent message stop", 502);
      this.stopped = true;
      return;
    }
    throw failure("native Claude stream contains an unsupported event", 502);
  }

  assistant(value) {
    if (!this.started || !object(value.message) || value.message.id !== this.started.id
        || value.message.model !== this.nativeModel || value.message.type !== "message"
        || value.message.role !== "assistant" || !Array.isArray(value.message.content)) {
      throw failure("native Claude assistant record is invalid", 502);
    }
    const text = value.message.content.map((block) => {
      if (!object(block) || block.type !== "text" || typeof block.text !== "string") throw failure("native Claude response contains non-text content", 502);
      return block.text;
    }).join("");
    this.assistantText = (this.assistantText ?? "") + text;
  }

  completed(exitCode) {
    if (exitCode !== 0 || !this.started || !this.delta || !this.stopped || !this.result
        || this.result.subtype !== "success" || this.result.is_error !== false || this.assistantText !== this.text) {
      throw failure("native Claude request did not complete", 502);
    }
    const content = [...this.blocks.values()].map((block) => ({ type: "text", text: block.text }));
    if (content.map((block) => block.text).join("") !== this.assistantText) {
      throw failure("native Claude response content is inconsistent", 502);
    }
    return {
      id: this.started.id,
      type: "message",
      role: "assistant",
      model: this.nativeModel,
      content,
      stop_reason: this.delta.stopReason,
      stop_sequence: this.delta.stopSequence,
      usage: { ...this.startUsage, ...this.delta.usage },
    };
  }
}

function terminate(child) {
  if (!child) return;
  try {
    if (Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { try { child.kill("SIGTERM"); } catch { /* owned child is already gone */ } }
  return setTimeout(() => {
    try {
      if (Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { try { child.kill("SIGKILL"); } catch { /* owned child is already gone */ } }
  }, TERM_GRACE_MS);
}

/**
 * Runs one restricted native Claude request and returns only a fully completed
 * Anthropic Message. `spawn` is injectable for deterministic stream fixtures.
 */
export async function runNativeMessages(payload, nativeModel, options = {}) {
  const command = absolute(options.command, "command");
  if (options.authDirectory !== undefined) absolute(options.authDirectory, "authDirectory");
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRequestBytes)
      || maxRequestBytes <= 0 || maxRequestBytes > MAX_REQUEST_BYTES) {
    throw failure("native Messages runner options are invalid", 400);
  }
  const headers = auxiliaryHeaders(options.headers);
  const classifier = headers !== undefined && isNativeClassifierRequest(payload);
  let body;
  try { body = JSON.stringify(requestBody(payload, nativeModel)); }
  catch (error) {
    if (error?.status) throw error;
    throw failure("native Messages request is invalid", 400);
  }
  if (Buffer.byteLength(body) > maxRequestBytes) throw failure("native Messages request is too large", 413);
  const args = argv(nativeModel);
  const env = nativeEnvironment(options.authDirectory, body, headers, classifier);
  if (Buffer.byteLength(`CLAUDE_CODE_EXTRA_BODY=${body}`) > MAX_ENV_VALUE_BYTES) {
    throw failure("native Messages request is too large for this platform", 413);
  }
  if (sizeOfEnvironment(command, args, env) > MAX_ENV_ARGV_BYTES) throw failure("native Messages request is too large", 413);
  if (options.signal?.aborted) throw failure("native Claude request was cancelled", 408);

  const start = options.spawn ?? nodeSpawn;
  let child;
  try {
    child = start(command, args, { detached: true, env, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    throw failure("native Claude process could not start", 502);
  }
  const message = new NativeMessage(nativeModel, payload.stop_sequences);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let settled = false;
  let closing = false;
  let terminalError;
  let hardStop;
  let timeout;
  let abort;

  return await new Promise((resolve, reject) => {
    const settle = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(hardStop);
      options.signal?.removeEventListener("abort", abort);
      if (error) return reject(error);
      try { resolve(message.completed(code)); } catch (failure) { reject(failure); }
    };
    const stop = (error) => {
      if (settled || terminalError) return;
      terminalError = error;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (closing) settle(terminalError);
      else hardStop = terminate(child);
    };
    const consume = (line) => {
      if (!line) return;
      let value;
      try { value = JSON.parse(line); } catch { stop(failure("native Claude stream is malformed", 502)); return; }
      if (value?.type === "stream_event" && value.event?.type === "message_start") {
        const raw = value.event.message?.usage;
        const counts = object(raw) ? Object.fromEntries(["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
          .filter(key => nonNegative(raw[key])).map(key => [key, raw[key]])) : undefined;
        if (counts) try { options.observeCacheUsage?.(counts); } catch { /* Preserve measured input even if validation fails. */ }
      }
      try { message.accept(value); } catch (error) { stop(error); }
      if (message.startUsage) {
        try { options.observeCacheUsage?.({ ...message.startUsage, ...message.delta?.usage }); } catch { /* Count observation never changes the native verdict. */ }
      }
    };
    child.stdout.on("data", (chunk) => {
      if (settled || terminalError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return stop(failure("native Claude response is too large", 502));
      pending += decoder.write(chunk);
      let lineEnd;
      while (!settled && (lineEnd = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, lineEnd).replace(/\r$/, "");
        pending = pending.slice(lineEnd + 1);
        consume(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!settled && !terminalError && (stderrBytes += chunk.length) > MAX_STDERR_BYTES) stop(failure("native Claude process failed", 502));
    });
    child.stdout.on("error", () => stop(failure("native Claude process failed", 502)));
    child.stderr.on("error", () => stop(failure("native Claude process failed", 502)));
    child.once("error", () => stop(failure("native Claude process failed", 502)));
    child.stdin.on("error", () => stop(failure("native Claude process failed", 502)));
    child.once("close", (code) => {
      closing = true;
      if (!terminalError) {
        pending += decoder.end();
        if (pending.trim()) consume(pending.trim());
      }
      settle(terminalError, code);
    });
    timeout = setTimeout(() => stop(failure("native Claude request timed out", 408)), timeoutMs);
    abort = () => stop(failure("native Claude request was cancelled", 408));
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      child.stdin.end(JSON.stringify({
        type: "user", session_id: "", parent_tool_use_id: null, uuid: randomUUID(),
        // EXTRA_BODY replaces this carrier message late; it is never an instruction.
        message: { role: "user", content: [{ type: "text", text: CARRIER_TEXT }] },
      }) + "\n");
    } catch { stop(failure("native Claude process failed", 502)); }
  });
}

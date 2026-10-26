#!/usr/bin/env node
// Claude Desktop's loopback-only compatibility adapter. Node builtins only.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isNativeClassifierRequest } from "./claude-desktop-native-messages.mjs";
import {
  normalizeOptionalToolResponse,
  prepareOptionalToolArguments,
  SseResponseRewriter,
} from "./claude-desktop-optional-tools.mjs";

export const MAX_BODY_BYTES = 64 * 1024 * 1024;
const HOST = "127.0.0.1";
const CREATED_AT = "2026-01-01T00:00:00Z";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
// Claude Desktop shows its native effort slider for a recognized model ID, so a secondary route
// with reasoning levels is exposed as `claude-opus-5[hg-route-<decimal>]`. Nothing else may use
// brackets: the app normalizes the trailing bracket away and would then merge unrelated rows.
const BRIDGE_MODEL_ID = /^claude-opus-5\[hg-route-[0-9]{1,20}\]$/;
/** The native model ID the app sees once it drops the opaque bridge suffix. */
const BRIDGE_BASE_ID = "claude-opus-5";
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);
const REQUEST_DROP = new Set(["host", "authorization", "x-api-key", ...HOP_HEADERS]);

function invalid(message) { throw new Error(`invalid config: ${message}`); }

function absolutePath(value, name) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) invalid(`${name} must be an absolute file path`);
  return value;
}

function loopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  return parts.length === 4 && Number(parts[0]) === 127
    && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("root must be a JSON object");
  if (!Number.isInteger(raw.listenPort) || raw.listenPort < 0 || raw.listenPort > 65535) {
    invalid("listenPort must be an integer from 0 to 65535");
  }
  let upstream;
  if (typeof raw.upstream !== "string") invalid("upstream must be an http:// loopback URL");
  try { upstream = new URL(raw.upstream); } catch { invalid("upstream must be an http:// loopback URL"); }
  if (upstream.protocol !== "http:" || !loopback(upstream.hostname) || upstream.username || upstream.password
      || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    invalid("upstream must be a credential-free http:// loopback origin");
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) invalid("models must be a non-empty array");
  const modelIndex = new Map();
  const models = raw.models.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`models[${index}] must be an object`);
    if (typeof value.id !== "string" || !(MODEL_ID.test(value.id) || BRIDGE_MODEL_ID.test(value.id))) {
      invalid(`models[${index}].id is invalid`);
    }
    if (modelIndex.has(value.id)) invalid(`duplicate model id '${value.id}'`);
    if (typeof value.upstream !== "string" || !value.upstream || /\s/.test(value.upstream)) {
      invalid(`models[${index}].upstream must be a non-empty model name`);
    }
    if (typeof value.displayName !== "string" || !value.displayName.trim()) invalid(`models[${index}].displayName is required`);
    if (value.contextWindow !== undefined && (!Number.isInteger(value.contextWindow) || value.contextWindow <= 0)) {
      invalid(`models[${index}].contextWindow must be a positive integer`);
    }
    if (value.preserveOptionalToolArguments !== undefined && typeof value.preserveOptionalToolArguments !== "boolean") {
      invalid(`models[${index}].preserveOptionalToolArguments must be a boolean`);
    }
    if (value.reasoningEffort !== undefined && !EFFORT_ORDER.includes(value.reasoningEffort)) invalid(`models[${index}].reasoningEffort is invalid`);
    let supportedEfforts;
    if (value.supportedEfforts !== undefined) {
      if (!Array.isArray(value.supportedEfforts) || value.supportedEfforts.length === 0
          || value.supportedEfforts.some(effort => !EFFORT_ORDER.includes(effort))
          || new Set(value.supportedEfforts).size !== value.supportedEfforts.length) {
        invalid(`models[${index}].supportedEfforts must be a non-empty array of unique supported efforts`);
      }
      supportedEfforts = EFFORT_ORDER.filter(effort => value.supportedEfforts.includes(effort));
    }
    if (value.serviceTier !== undefined && (typeof value.serviceTier !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/.test(value.serviceTier))) invalid(`models[${index}].serviceTier is invalid`);
    const model = { id: value.id, upstream: value.upstream, displayName: value.displayName,
      ...(value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow }),
      ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
      ...(supportedEfforts === undefined ? {} : { supportedEfforts }),
      ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier }),
      ...(value.preserveOptionalToolArguments === true ? { preserveOptionalToolArguments: true } : {}) };
    modelIndex.set(model.id, model);
    return model;
  });
  return {
    listenPort: raw.listenPort,
    upstream: upstream.origin,
    // WHATWG URL keeps IPv6 brackets in hostname; Node's http.request expects
    // the raw address in its hostname option.
    upstreamTarget: { hostname: upstream.hostname.replace(/^\[|\]$/g, ""), port: Number(upstream.port) || 80 },
    tokenFile: absolutePath(raw.tokenFile, "tokenFile"),
    models, modelIndex,
    ...(raw.auditFile === undefined ? {} : { auditFile: absolutePath(raw.auditFile, "auditFile") }),
  };
}

export function loadConfig(configPath) {
  absolutePath(configPath, "--config");
  try { return validateConfig(JSON.parse(fs.readFileSync(configPath, "utf8"))); }
  catch (failure) {
    if (failure.message.startsWith("invalid config:")) throw failure;
    throw new Error(`cannot read config '${configPath}': ${failure.message}`);
  }
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(body.length) });
  res.end(body);
}

function sendError(res, status, type, message) {
  if (res.headersSent) res.destroy();
  else sendJson(res, status, { type: "error", error: { type, message } });
}

function oneHeader(value) {
  if (value === undefined) return undefined;
  return Array.isArray(value) || String(value).includes(",") ? null : String(value);
}

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authentication(req, tokenFile) {
  const authorization = oneHeader(req.headers.authorization);
  const apiKey = oneHeader(req.headers["x-api-key"]);
  if (authorization === null || apiKey === null) return { error: [401, "authentication_error", "multiple credential headers are not accepted"] };
  let bearer;
  if (authorization !== undefined) {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim());
    if (!match) return { error: [401, "authentication_error", "authorization must use Bearer credentials"] };
    bearer = match[1];
  }
  if (bearer !== undefined && apiKey !== undefined && !equal(bearer, apiKey)) {
    return { error: [401, "authentication_error", "conflicting credentials"] };
  }
  const received = bearer ?? apiKey;
  if (received === undefined) return { error: [401, "authentication_error", "missing credentials"] };
  let expected;
  try { expected = fs.readFileSync(tokenFile, "utf8").trim(); }
  catch { return { error: [503, "authentication_error", "adapter authentication is unavailable"] }; }
  return expected && equal(received, expected)
    ? { token: expected }
    : { error: [401, "authentication_error", "invalid credentials"] };
}

function modelObject(model) {
  return { id: model.id, type: "model", display_name: model.displayName, created_at: CREATED_AT,
    ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }) };
}

/** The highest supported effort below the requested one, else the lowest supported effort. */
function clampEffort(requested, supported) {
  if (supported.includes(requested)) return requested;
  const rank = EFFORT_ORDER.indexOf(requested);
  if (rank < 0) return supported[0];
  const below = supported.filter(effort => EFFORT_ORDER.indexOf(effort) < rank);
  return below.length > 0 ? below[below.length - 1] : supported[0];
}

/**
 * A bridge row shows the app's own slider, whose options come from Claude's signed catalog and can
 * exceed what this route supports. Clamp every effort the client sent, including the efforts kept
 * in the history of a tool continuation, without adding one the client never chose.
 */
function clampPayloadEfforts(payload, supported) {
  if (payload.output_config && typeof payload.output_config === "object" && !Array.isArray(payload.output_config)
      && typeof payload.output_config.effort === "string") {
    payload.output_config = { ...payload.output_config, effort: clampEffort(payload.output_config.effort, supported) };
  }
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map(message =>
      message?.role === "system" && typeof message.output_config?.effort === "string"
        ? { ...message, output_config: { ...message.output_config, effort: clampEffort(message.output_config.effort, supported) } }
        : message);
  }
}

function copyHeaders(headers, excluded) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !excluded.has(name.toLowerCase())) output[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return output;
}

function writeAudit(config, record) {
  if (!config.auditFile) return;
  const row = JSON.stringify({
    timestamp: new Date().toISOString(), requestID: record.requestID,
    exposedModel: record.exposedModel ?? null, upstreamModel: record.upstreamModel ?? null,
    status: record.status ?? 0, observedUpstreamResponseModel: record.responseModel ?? null,
  });
  try { fs.appendFileSync(config.auditFile, `${row}\n`, { mode: 0o600 }); } catch { /* audit must be non-invasive */ }
}

function observedModel(value, model) {
  return value === model.upstream || value === model.id ? value : "unexpected";
}

function relay(upstream, res, model, record, optionalTools) {
  const headers = copyHeaders(upstream.headers, HOP_HEADERS);
  const contentType = String(upstream.headers["content-type"] ?? "").toLowerCase();
  record.status = upstream.statusCode ?? 502;
  if (contentType.includes("text/event-stream")) {
    res.writeHead(record.status, headers);
    const stream = new SseResponseRewriter({ upstreamModel: model.upstream, exposedModel: model.id, plans: optionalTools,
      observeModel: (seen) => {
      record.responseModel = observedModel(seen, model);
      } });
    const failed = () => { if (!res.writableEnded) res.destroy(); };
    upstream.on("error", failed);
    upstream.on("aborted", failed);
    stream.on("error", () => { upstream.destroy(); failed(); });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.pipe(stream).pipe(res);
    return;
  }
  const chunks = [];
  let size = 0;
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    upstream.destroy();
    if (res.headersSent) res.destroy();
    else sendError(res, 502, "api_error", "upstream response failed");
  };
  upstream.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail();
    else chunks.push(chunk);
  });
  upstream.on("error", fail);
  upstream.on("aborted", fail);
  upstream.on("end", () => {
    if (failed) return;
    let body = Buffer.concat(chunks);
    let rewritten = false;
    if (contentType.includes("json") && body.length) {
      try {
        let response = JSON.parse(body);
        if (response && typeof response === "object" && !Array.isArray(response) && typeof response.model === "string") {
          record.responseModel = observedModel(response.model, model);
          if (response.model === model.upstream) {
            response.model = model.id;
            rewritten = true;
          }
        }
        if (optionalTools.size) {
          const normalized = normalizeOptionalToolResponse(response, optionalTools);
          rewritten ||= normalized !== response;
          response = normalized;
        }
        if (rewritten) body = Buffer.from(JSON.stringify(response));
      } catch { /* send a non-JSON upstream reply unchanged */ }
    }
    if (rewritten) delete headers["content-length"];
    else headers["content-length"] = String(body.length);
    res.writeHead(record.status, headers);
    res.end(body);
  });
}

function readRequest(req, res, receive) {
  const chunks = [];
  let bytes = 0;
  let complete = false;
  req.on("data", (chunk) => {
    if (complete) return;
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      complete = true;
      sendError(res, 413, "request_too_large", "request body exceeds the 64MiB limit");
      req.destroy();
    } else chunks.push(chunk);
  });
  req.on("error", () => {
    if (!complete) {
      complete = true;
      sendError(res, 400, "invalid_request_error", "request body could not be read");
    }
  });
  req.on("end", () => { if (!complete) receive(Buffer.concat(chunks)); });
}

function forward(req, res, config, route, token, record) {
  readRequest(req, res, (body) => {
    let payload;
    try { payload = JSON.parse(body); } catch {
      sendError(res, 400, "invalid_request_error", "request body must be valid JSON");
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.model !== "string" || !payload.model) {
      sendError(res, 400, "invalid_request_error", "request body must be an object with a model");
      return;
    }
    const model = config.modelIndex.get(payload.model);
    if (!model) {
      sendError(res, 400, "invalid_request_error", `model '${payload.model.slice(0, 128)}' is not served by this adapter`);
      return;
    }
    record.exposedModel = model.id;
    record.upstreamModel = model.upstream;
    // The app normalizes a bridge row by dropping its bracketed suffix, so its auxiliary review
    // arrives naming that ID. The shared predicate recognizes native IDs only, and a bridge ID is
    // never a native model, so ask it about the ID the app itself sees. The route and the
    // upstream request are unchanged, and an auxiliary review keeps its own generation controls.
    const auxiliaryReview = isNativeClassifierRequest(
      BRIDGE_MODEL_ID.test(model.id) ? { ...payload, model: BRIDGE_BASE_ID } : payload);
    payload.model = model.upstream;
    // Selecting a variant explicitly selects these controls, including across
    // tool continuations whose historical system messages retain older efforts.
    if (!auxiliaryReview && model.reasoningEffort !== undefined) {
      payload.output_config = { ...payload.output_config, effort: model.reasoningEffort };
      // Unknown aliases can inherit the client's no-thinking default. An explicit
      // effort selection enables adaptive thinking; fixed budgets still fail closed.
      if (payload.thinking?.type === "disabled" && Object.keys(payload.thinking).length === 1) payload.thinking = { type: "adaptive" };
      if (Array.isArray(payload.messages)) payload.messages = payload.messages.map(message =>
        message?.role === "system" && message.output_config?.effort !== undefined
          ? { ...message, output_config: { ...message.output_config, effort: model.reasoningEffort } } : message);
    } else if (!auxiliaryReview && model.supportedEfforts !== undefined) {
      // The slider offers the options from Claude's signed catalog, not this route's levels.
      clampPayloadEfforts(payload, model.supportedEfforts);
    }
    if (!auxiliaryReview && model.serviceTier !== undefined) payload.service_tier = model.serviceTier;
    const optional = model.preserveOptionalToolArguments
      ? prepareOptionalToolArguments(payload)
      : { payload, plans: new Map() };
    const outbound = Buffer.from(JSON.stringify(optional.payload));
    const headers = copyHeaders(req.headers, REQUEST_DROP);
    headers.authorization = `Bearer ${token}`;
    headers["content-length"] = String(outbound.length);
    const upstream = http.request({ ...config.upstreamTarget, method: "POST", path: route, headers },
      (reply) => relay(reply, res, model, record, optional.plans));
    upstream.on("error", () => {
      if (!res.headersSent) sendError(res, 502, "api_error", "upstream request failed");
      else res.destroy();
    });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end(outbound);
  });
}

export function createHandler(config) {
  return (req, res) => {
    let target;
    try { target = new URL(req.url, "http://127.0.0.1"); } catch {
      sendError(res, 400, "invalid_request_error", "malformed request URL");
      return;
    }
    const record = { requestID: randomUUID() };
    res.once("finish", () => {
      record.status ??= res.statusCode;
      writeAudit(config, record);
    });
    const auth = authentication(req, config.tokenFile);
    if (auth.error) return sendError(res, ...auth.error);
    const route = target.pathname;
    if (req.method === "GET" && route === "/health") return sendJson(res, 200, { status: "ok", models: config.models.length });
    if (req.method === "GET" && route === "/v1/models") {
      return sendJson(res, 200, { type: "list", data: config.models.map(modelObject), has_more: false });
    }
    if (req.method === "GET" && route.startsWith("/v1/models/")) {
      let id;
      try { id = decodeURIComponent(route.slice("/v1/models/".length)); } catch {
        return sendError(res, 400, "invalid_request_error", "malformed model id");
      }
      if (!id || id.includes("/")) return sendError(res, 404, "not_found_error", "unknown route");
      const model = config.modelIndex.get(id);
      return model
        ? sendJson(res, 200, modelObject(model))
        : sendError(res, 404, "not_found_error", `unknown model '${id.slice(0, 120)}'`);
    }
    if (route === "/v1/messages" || route === "/v1/messages/count_tokens") {
      if (req.method !== "POST") return sendError(res, 405, "invalid_request_error", "message endpoints only accept POST");
      return forward(req, res, config, `${route}${target.search}`, auth.token, record);
    }
    return sendError(res, 404, "not_found_error", "unknown route");
  };
}

export async function startAdapter(options = {}) {
  const config = options.config === undefined ? loadConfig(options.configPath) : validateConfig(options.config);
  // This is the sole intentional filesystem side effect: an opted-in audit
  // destination receives a private parent directory before any request is served.
  if (config.auditFile) fs.mkdirSync(path.dirname(config.auditFile), { recursive: true, mode: 0o700 });
  const server = http.createServer(createHandler(config));
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, HOST, resolve);
  });
  return {
    server, config, port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: node claude-desktop-adapter.mjs --config <absolute-config.json>");
  } else {
    try {
      if (args.length !== 2 || args[0] !== "--config") invalid("exactly one '--config <absolute path>' argument is required");
      const adapter = await startAdapter({ configPath: args[1] });
      process.stderr.write(`claude-desktop-adapter listening on 127.0.0.1:${adapter.port}\n`);
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => adapter.close().then(() => process.exit(0)));
    } catch (failure) {
      process.stderr.write(`claude-desktop-adapter: ${failure.message}\n`);
      process.exitCode = 1;
    }
  }
}

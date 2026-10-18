// Opt-in JSON Schema compatibility for gateways that materialize optional
// function arguments. It deliberately supports only plain object properties
// and array items; $ref and schema compositions are left untouched.

import { Transform } from "node:stream";

export const MAX_TOOL_ARGUMENT_BYTES = 8 * 1024 * 1024;

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isKnownNonNullable(schema) {
  if (!plainObject(schema) || schema.nullable === true) return false;
  if ("$ref" in schema || "anyOf" in schema || "oneOf" in schema || "allOf" in schema || "not" in schema) return false;
  if (Array.isArray(schema.type)) return !schema.type.includes("null");
  if (typeof schema.type === "string") return schema.type !== "null";
  if (Array.isArray(schema.enum)) return !schema.enum.includes(null);
  return "const" in schema && schema.const !== null;
}

function makeNullable(schema) {
  return { anyOf: [schema, { type: "null" }] };
}

function transformSchema(schema) {
  if (!plainObject(schema)) return { schema, plan: undefined };
  if ("$ref" in schema || "anyOf" in schema || "oneOf" in schema || "allOf" in schema || "not" in schema) {
    return { schema, plan: undefined };
  }
  const output = { ...schema };
  let plan;
  if ((schema.type === "object" || ("type" in schema === false && plainObject(schema.properties)))
      && plainObject(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : []);
    const properties = {};
    const children = new Map();
    const introduced = new Set();
    for (const [name, value] of Object.entries(schema.properties)) {
      const child = transformSchema(value);
      properties[name] = child.schema;
      if (child.plan) children.set(name, child.plan);
      if (!required.has(name) && isKnownNonNullable(value)) {
        properties[name] = makeNullable(child.schema);
        introduced.add(name);
      }
    }
    output.properties = properties;
    if (introduced.size || children.size) plan = { introduced, children };
  }
  if (schema.type === "array" && "items" in schema) {
    const item = transformSchema(schema.items);
    output.items = item.schema;
    if (item.plan) plan = { ...(plan ?? {}), item: item.plan };
  }
  return { schema: output, plan };
}

function normalizeValue(value, plan) {
  if (!plan) return value;
  if (Array.isArray(value)) {
    if (!plan.item) return value;
    let changed = false;
    const result = value.map((item) => {
      const normalized = normalizeValue(item, plan.item);
      changed ||= normalized !== item;
      return normalized;
    });
    return changed ? result : value;
  }
  if (!plainObject(value)) return value;
  let changed = false;
  const result = { ...value };
  for (const name of plan.introduced ?? []) {
    if (result[name] === null) {
      delete result[name];
      changed = true;
    }
  }
  for (const [name, child] of plan.children ?? []) {
    if (name in result && result[name] !== null) {
      const normalized = normalizeValue(result[name], child);
      if (normalized !== result[name]) {
        result[name] = normalized;
        changed = true;
      }
    }
  }
  return changed ? result : value;
}

export function prepareOptionalToolArguments(payload) {
  if (!plainObject(payload) || !Array.isArray(payload.tools)) return { payload, plans: new Map() };
  let changed = false;
  const plans = new Map();
  const tools = payload.tools.map((tool) => {
    if (!plainObject(tool) || typeof tool.name !== "string" || !plainObject(tool.input_schema)) return tool;
    const transformed = transformSchema(tool.input_schema);
    if (!transformed.plan) return tool;
    changed = true;
    plans.set(tool.name, transformed.plan);
    return { ...tool, input_schema: transformed.schema };
  });
  return { payload: changed ? { ...payload, tools } : payload, plans };
}

function normalizeToolUse(block, plans) {
  if (!plainObject(block) || block.type !== "tool_use" || typeof block.name !== "string" || !("input" in block)) return block;
  const input = normalizeValue(block.input, plans.get(block.name));
  return input === block.input ? block : { ...block, input };
}

export function normalizeOptionalToolResponse(response, plans) {
  if (!plans.size || !plainObject(response) || !Array.isArray(response.content)) return response;
  let changed = false;
  const content = response.content.map((block) => {
    const normalized = normalizeToolUse(block, plans);
    changed ||= normalized !== block;
    return normalized;
  });
  return changed ? { ...response, content } : response;
}

function eventBoundary(buffer) {
  const crlf = buffer.indexOf(Buffer.from("\r\n\r\n"));
  const lf = buffer.indexOf(Buffer.from("\n\n"));
  if (crlf < 0 && lf < 0) return -1;
  return lf < 0 || (crlf >= 0 && crlf < lf) ? crlf + 4 : lf + 2;
}

function parseEvent(event) {
  const text = event.toString("utf8");
  const newline = text.includes("\r\n\r\n") ? "\r\n" : "\n";
  const lines = text.split(newline);
  const data = lines.filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^[ \t]/, "")).join("\n");
  try { return { lines, newline, value: JSON.parse(data) }; } catch { return undefined; }
}

function replaceData(parsed, value, eventName) {
  let data = false;
  return Buffer.from(parsed.lines.map((line) => {
    if (eventName && line.startsWith("event:")) return `event: ${eventName}`;
    if (!line.startsWith("data:")) return line;
    if (data) return null;
    data = true;
    return `data: ${JSON.stringify(value)}`;
  }).filter((line) => line !== null).join(parsed.newline));
}

// Rewrites alias models and, when configured, buffers one tool_use JSON input
// per content-block index until its stop event. Invalid partial JSON is
// released unchanged with its original stop event; an oversized buffer fails.
export class SseResponseRewriter extends Transform {
  #event = [];
  #bytes = 0;
  #blocks = new Map();

  constructor({ upstreamModel, exposedModel, plans, observeModel }) {
    super();
    this.upstreamModel = upstreamModel;
    this.exposedModel = exposedModel;
    this.plans = plans;
    this.observeModel = observeModel;
  }

  _transform(chunk, _encoding, done) {
    this.#event.push(chunk);
    this.#bytes += chunk.length;
    try {
      this.#drain(false);
      if (this.#bytes > MAX_TOOL_ARGUMENT_BYTES) throw new Error("upstream SSE event exceeds adapter limit");
      done();
    } catch (error) { done(error); }
  }

  _flush(done) {
    try { this.#drain(true); done(); } catch (error) { done(error); }
  }

  #drain(final) {
    let source = Buffer.concat(this.#event);
    let boundary;
    while ((boundary = eventBoundary(source)) !== -1) {
      const event = source.subarray(0, boundary);
      source = source.subarray(boundary);
      if (event.length > MAX_TOOL_ARGUMENT_BYTES) throw new Error("upstream SSE event exceeds adapter limit");
      for (const output of this.#rewrite(event)) this.push(output);
    }
    this.#event = source.length ? [source] : [];
    this.#bytes = source.length;
    if (final && source.length) for (const output of this.#rewrite(source)) this.push(output);
  }

  #rewrite(event) {
    const parsed = parseEvent(event);
    if (!parsed || !plainObject(parsed.value)) return [event];
    const value = parsed.value;
    if (value.type === "message_start" && typeof value.message?.model === "string") {
      this.observeModel(value.message.model);
      if (value.message.model === this.upstreamModel) {
        value.message.model = this.exposedModel;
        return [replaceData(parsed, value)];
      }
      return [event];
    }
    if (!this.plans.size) return [event];
    if (value.type === "content_block_start" && value.content_block?.type === "tool_use") {
      const plan = this.plans.get(value.content_block.name);
      if (plan) this.#blocks.set(value.index, { plan, raw: [], bytes: 0 });
      return [event];
    }
    const block = this.#blocks.get(value.index);
    if (!block) return [event];
    if (value.type === "content_block_delta" && value.delta?.type === "input_json_delta"
        && typeof value.delta.partial_json === "string") {
      block.raw.push(event);
      block.bytes += event.length;
      if (block.bytes > MAX_TOOL_ARGUMENT_BYTES) throw new Error("tool input JSON exceeds adapter limit");
      return [];
    }
    if (value.type !== "content_block_stop") return [event];
    this.#blocks.delete(value.index);
    const fragments = block.raw.map(parseEvent);
    const text = fragments.map((part) => part?.value?.delta?.partial_json).join("");
    if (!fragments.length || fragments.some((part) => !part) || Buffer.byteLength(text) > MAX_TOOL_ARGUMENT_BYTES) return [...block.raw, event];
    let input;
    try { input = JSON.parse(text); } catch { return [...block.raw, event]; }
    const normalized = normalizeValue(input, block.plan);
    const first = fragments[0];
    const delta = {
      ...first.value,
      type: "content_block_delta",
      index: value.index,
      delta: { ...first.value.delta, type: "input_json_delta", partial_json: JSON.stringify(normalized) },
    };
    return [replaceData(first, delta, "content_block_delta"), event];
  }
}

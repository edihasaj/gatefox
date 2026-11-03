import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { GrokMcpServer } from "../providers/grok-mcp-http.js";
import { grokPermission } from "../providers/grok-acp.js";

const tools = [{ name: "tool_a", description: "A", inputSchema: { type: "object", properties: {} } }];
function post(url: string, body: unknown, options: { host?: string; method?: string } = {}): Promise<{ status: number; body: Record<string, any> | undefined }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const call = request({ host: target.hostname, port: target.port, path: target.pathname, method: options.method ?? "POST", headers: { "content-type": "application/json", ...(options.host ? { host: options.host } : {}) } }, response => {
      let text = ""; response.on("data", piece => { text += piece; }); response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
    });
    call.on("error", reject); call.end(JSON.stringify(body));
  });
}

test("the loopback MCP endpoint answers lists, holds a call open until answered, and refuses wrong paths, hosts and methods", async () => {
  let release: ((text: string) => void) | undefined; const calls: string[] = [];
  const server = new GrokMcpServer(tools, { call: (name, args) => { calls.push(`${name}:${JSON.stringify(args)}`); return new Promise(resolve => { release = resolve; }); } });
  const url = await server.listen();
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{48}$/);
    assert.equal((await post(url.replace(/\/mcp\/.*/, "/mcp/wrong"), {})).status, 404);
    assert.equal((await post(url, {}, { host: "evil.example:80" })).status, 404);
    assert.equal((await post(url, {}, { method: "PUT" })).status, 405);
    assert.equal((await post(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    assert.equal((await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).body?.result.protocolVersion, "2025-03-26");
    assert.deepEqual((await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).body?.result.tools, tools);
    assert.equal((await post(url, { jsonrpc: "2.0", id: 3, method: "server/discover" })).body?.error.code, -32601);
    assert.equal((await post(url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "unknown_tool", arguments: {} } })).body?.error.code, -32602);
    let settled = false;
    const held = post(url, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "tool_a", arguments: { x: 1 } } }).then(reply => { settled = true; return reply; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(settled, false, "the call stays open while nobody answered");
    release!("done");
    assert.deepEqual((await held).body?.result, { content: [{ type: "text", text: "done" }] });
    assert.deepEqual(calls, ['tool_a:{"x":1}']);
  } finally { await server.close(); }
});

test("permissions allow_once only a gateway use_tool from the catalog (or search_tool) and never pick allow_always", () => {
  const options = [{ optionId: "aa", kind: "allow_always" }, { optionId: "a", kind: "allow_once" }, { optionId: "ra", kind: "reject_always" }, { optionId: "r", kind: "reject_once" }];
  const catalog = new Set(["tool_a"]); const ask = (rawInput: unknown, opts = options) => grokPermission({ toolCall: { rawInput }, options: opts }, catalog);
  assert.deepEqual(ask({ variant: "UseTool", tool_name: "gateway__tool_a" }), { allowed: true, result: { outcome: { outcome: "selected", optionId: "a" } } });
  assert.equal(ask({ variant: "SearchTool" }).allowed, true);
  for (const denied of [{ variant: "UseTool", tool_name: "gateway__tool_b" }, { variant: "UseTool", tool_name: "other__tool_a" }, { variant: "UseTool", tool_name: "tool_a" },
    { variant: "RunTerminalCommand", command: "touch x" }, { tool_name: "gateway__tool_a" }, undefined, "gateway__tool_a"]) {
    assert.deepEqual(ask(denied), { allowed: false, result: { outcome: { outcome: "selected", optionId: "r" } } }, JSON.stringify(denied));
  }
  assert.deepEqual(ask({ variant: "UseTool", tool_name: "gateway__tool_a" }, [{ optionId: "aa", kind: "allow_always" }]).result, { outcome: { outcome: "cancelled" } }, "no allow_once means cancelled, never allow_always");
  assert.deepEqual(ask({ variant: "Bash" }, [{ optionId: "ra", kind: "reject_always" }]).result, { outcome: { outcome: "selected", optionId: "ra" } }, "a reject is still a reject");
  assert.deepEqual(ask({ variant: "Bash" }, []).result, { outcome: { outcome: "cancelled" } });
});

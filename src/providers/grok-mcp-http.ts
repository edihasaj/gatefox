import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ClaudeMcpTool } from "./claude-control.js";

/** The gateway-side half of one live Grok session's tool calls. */
export interface McpToolHost {
  /**
   * A `tools/call` for a catalog tool. The returned promise settles when the caller's output is known, which can be
   * minutes later; `abandoned` aborts if Grok drops the connection first. A rejection is answered as a tool error.
   */
  call(name: string, args: Record<string, unknown>, abandoned: AbortSignal): Promise<string>;
  /** Any `tools/call` reached the endpoint, valid or not: a model that ran made it. */
  seen?(): void;
}
const maxBody = 8 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * One loopback MCP endpoint per session (Streamable HTTP, JSON responses only), on a random port behind an unguessable
 * path token. It lists the caller's tools and holds each `tools/call` open until the host answers. It runs nothing itself.
 */
export class GrokMcpServer {
  private readonly server: Server; private readonly token = randomBytes(24).toString("hex");
  private readonly open = new Set<ServerResponse>();
  private port = 0;
  constructor(private readonly tools: ClaudeMcpTool[], private readonly host: McpToolHost) {
    this.server = createServer((request, response) => this.handle(request, response));
  }

  /** Starts listening on 127.0.0.1 and returns the endpoint URL. */
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
    this.port = (this.server.address() as { port: number }).port;
    return `http://127.0.0.1:${this.port}/mcp/${this.token}`;
  }

  /** Ends every open call and stops listening. */
  close(): Promise<void> {
    for (const response of this.open) { try { response.destroy(); } catch { /* Already gone. */ } }
    this.open.clear();
    return new Promise(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }

  private reply(response: ServerResponse, status: number, body?: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    // The token path and the exact loopback Host header keep other local processes and rebinding pages out.
    if (request.url !== `/mcp/${this.token}` || request.headers.host !== `127.0.0.1:${this.port}`) return this.reply(response, 404);
    if (request.method !== "POST") return this.reply(response, 405);
    const chunks: Buffer[] = []; let size = 0; let refused = false;
    request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBody) { refused = true; this.reply(response, 413); request.destroy(); } else chunks.push(chunk); });
    request.on("end", () => { if (!refused) void this.dispatch(Buffer.concat(chunks).toString("utf8"), response); });
  }

  private async dispatch(body: string, response: ServerResponse): Promise<void> {
    let message: Record<string, unknown>;
    try { message = object(JSON.parse(body)); } catch { return this.reply(response, 400); }
    const id = message.id;
    // Any tool call, even one without a usable id, is a sign that inference already ran, so a later
    // first-prompt sign-in failure must not release the conversation for a replay.
    if (message.method === "tools/call") this.host.seen?.();
    // Notifications (and responses) need no answer.
    if (id === undefined || id === null || typeof message.method !== "string") return this.reply(response, 202);
    const result = (value: unknown) => this.reply(response, 200, { jsonrpc: "2.0", id, result: value });
    const failure = (code: number, text: string) => this.reply(response, 200, { jsonrpc: "2.0", id, error: { code, message: text } });
    const params = object(message.params);
    if (message.method === "initialize") result({ protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "gateway", version: "1" } });
    else if (message.method === "ping") result({});
    else if (message.method === "tools/list") result({ tools: this.tools });
    else if (message.method === "tools/call") await this.call(params, response, result, failure);
    // `server/discover` and anything else this server does not offer: a plain "method not found".
    else failure(-32601, "Method not found");
  }

  private async call(params: Record<string, unknown>, response: ServerResponse, result: (value: unknown) => void, failure: (code: number, text: string) => void): Promise<void> {
    this.host.seen?.();
    const name = params.name; const args = params.arguments ?? {};
    if (typeof name !== "string" || !this.tools.some(tool => tool.name === name)) return failure(-32602, "Unknown tool");
    if (!args || typeof args !== "object" || Array.isArray(args)) return failure(-32602, "Invalid arguments");
    const abandoned = new AbortController();
    this.open.add(response);
    response.on("close", () => { this.open.delete(response); if (!response.writableEnded) abandoned.abort(); });
    try { result({ content: [{ type: "text", text: await this.host.call(name, args as Record<string, unknown>, abandoned.signal) }] }); }
    catch { result({ content: [{ type: "text", text: "The caller could not run this tool." }], isError: true }); }
  }
}

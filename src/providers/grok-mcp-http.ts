/**
 * One live Grok session's caller-tool endpoint. The loopback MCP HTTP endpoint is provider-neutral and lives in
 * acp-mcp-http.ts, shared with the Gemini provider; this module keeps the Grok name for its callers.
 */
export { AcpMcpServer as GrokMcpServer, type McpToolHost } from "./acp-mcp-http.js";

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** One scripted model reply. Calls name caller tools; the fixture maps them to the gateway's MCP names. */
export interface FixtureReply {
  /** A thinking block streamed before the text. */
  thinking?: string;
  text?: string;
  calls?: Array<{ tool: string; input: Record<string, unknown> }>;
  /** Streams text until interrupted. */
  slow?: boolean;
  /** Streams a gateway tool_use block until interrupted. */
  slowTool?: string;
  /** Starts a tool_use block for this non-gateway tool, then waits. */
  foreign?: string;
}
export interface FixtureScenario { replies: FixtureReply[]; exitAtSpawn?: boolean; perTurnEffort?: boolean; /** Never starts the MCP server, so no relay hello arrives. */ noMcp?: boolean }
export interface FixtureEntry {
  pid: number; start?: string; advisorOff?: boolean; toolSearchOff?: boolean; mcpPid?: number; mcpTools?: number; maxResult?: number;
  control?: string; effort?: string; user?: number; heads?: string[]; toolResult?: string; exit?: string;
}

/**
 * A fake `claude` on PATH for live-session tests. It answers the initialize, interrupt,
 * apply_flag_settings and end_session control requests, reads user messages, plays the
 * scenario's replies as stream-json events (including the housekeeping lines the real CLI
 * prints between requests), drives the gateway MCP server it finds in --mcp-config with
 * tools/call carrying claudecode/toolUseId, and logs what it saw to a capture file.
 * Without the live environment it behaves like a one-shot CLI and exits after a result.
 */
async function fixtureMain(): Promise<void> {
  type Json = Record<string, any>; // Fixture input is trusted test data.
  const fs = await import("node:fs"); const { spawn } = await import("node:child_process"); const readline = await import("node:readline");
  const env = process.env; const scenarioPath = env.CLAUDE_FIXTURE_SCENARIO!;
  const log = (entry: Json) => fs.appendFileSync(env.CLAUDE_FIXTURE_CAPTURE!, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
  const out = (message: Json) => { process.stdout.write(JSON.stringify(message) + "\n"); };
  const live = env.DISABLE_AUTO_COMPACT === "1"; const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8")) as Json;
  log({ start: live ? "live" : "oneshot", advisorOff: env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL === "1", toolSearchOff: env.ENABLE_TOOL_SEARCH === "false" });
  if (live && scenario.exitAtSpawn) process.exit(3);
  const nextReply = (): Json => {
    const current = JSON.parse(fs.readFileSync(scenarioPath, "utf8")) as Json; const reply = current.replies.shift() ?? { text: "ok" };
    fs.writeFileSync(scenarioPath, JSON.stringify(current)); return reply;
  };
  const argv = process.argv.slice(2); const servers = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers || {};
  const names = new Map<string, string>(); const waiting = new Map<number, (message: Json) => void>(); let rpc = 0;
  let mcp: import("node:child_process").ChildProcessWithoutNullStreams | undefined;
  const call = (method: string, params: Json) => new Promise<Json>(resolve => { const id = ++rpc; waiting.set(id, resolve); mcp!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  if (servers.gateway && !(live && scenario.noMcp)) {
    mcp = spawn(servers.gateway.command, servers.gateway.args, { stdio: ["pipe", "pipe", "pipe"] }); log({ mcpPid: mcp.pid });
    readline.createInterface({ input: mcp.stdout }).on("line", line => { const message = JSON.parse(line) as Json; waiting.get(message.id)?.(message); waiting.delete(message.id); });
    await call("initialize", { protocolVersion: "2025-06-18" });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await call("tools/list", {})).result.tools as Json[];
    for (const tool of tools) { const caller = /^Caller tool (\S+)\./.exec(tool.description)?.[1]; if (caller) names.set(caller, tool.name); }
    log({ mcpTools: tools.length, maxResult: tools[0]?._meta?.["anthropic/maxResultSizeChars"] });
  }
  const usage = (output: number) => ({ input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: output });
  const event = (value: Json) => out({ type: "stream_event", event: value });
  let counter = 0; let active: { interrupt(): void } | undefined;
  const interrupted = (id: string, partial: string, timer: NodeJS.Timeout) => () => {
    clearInterval(timer); active = undefined;
    if (partial) out({ type: "assistant", message: { id, content: [{ type: "text", text: partial }] } });
    out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    event({ type: "content_block_stop", index: 0 }); event({ type: "message_delta", delta: { stop_reason: null }, usage: usage(1) }); event({ type: "message_stop" });
    out({ type: "result", subtype: "error_during_execution", is_error: true, usage: usage(1) });
  };
  const play = async (reply: Json): Promise<void> => {
    const id = `msg_${process.pid}_${++counter}`;
    event({ type: "message_start", message: { id, usage: usage(1) } });
    if (reply.foreign) { event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_foreign", name: reply.foreign, input: {} } }); return; }
    if (reply.slow) {
      let partial = ""; event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      const timer = setInterval(() => { partial += "more "; event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "more " } }); }, 15);
      active = { interrupt: () => interrupted(id, partial, timer)() }; return;
    }
    if (reply.slowTool) {
      event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_slow", name: `mcp__gateway__${names.get(reply.slowTool)}`, input: {} } });
      const timer = setInterval(() => event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: " " } }), 15);
      active = { interrupt: interrupted(id, "", timer) }; return;
    }
    let index = 0;
    if (reply.thinking) {
      event({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      event({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: reply.thinking } }); event({ type: "content_block_stop", index: index++ });
    }
    if (reply.text) {
      event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of [reply.text.slice(0, 2), reply.text.slice(2)]) if (piece) event({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
      out({ type: "assistant", message: { id, content: [{ type: "text", text: reply.text }] } }); event({ type: "content_block_stop", index: index++ });
    }
    const calls = ((reply.calls || []) as Json[]).map((entry, n) => ({ id: `toolu_${process.pid}_${counter}_${n}`, name: `mcp__gateway__${names.get(entry.tool) ?? entry.tool}`, input: entry.input }));
    for (const entry of calls) {
      event({ type: "content_block_start", index, content_block: { type: "tool_use", id: entry.id, name: entry.name, input: {} } });
      event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(entry.input) } });
      out({ type: "assistant", message: { id, content: [{ type: "tool_use", id: entry.id, name: entry.name, input: entry.input }] } }); event({ type: "content_block_stop", index: index++ });
    }
    event({ type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn" }, usage: usage(7) });
    // The real CLI keeps printing housekeeping lines after a tool turn's request has ended.
    await new Promise(resolve => setTimeout(resolve, 20));
    event({ type: "message_stop" }); out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 4000000000 } });
    if (!calls.length) {
      out({ type: "result", subtype: "success", is_error: false, result: reply.text ?? "", usage: usage(7), modelUsage: {} });
      if (!live) process.exit(0);
      return;
    }
    out({ type: "tool_progress", tool_use_id: calls[0].id, elapsed_time_seconds: 30 });
    for (const entry of calls) {
      const response = await call("tools/call", { name: entry.name.replace("mcp__gateway__", ""), arguments: entry.input, _meta: { "claudecode/toolUseId": entry.id, progressToken: entry.id } });
      log({ toolResult: (response.result.content as Json[]).map(part => part.type === "text" ? part.text : `[${part.type} ${part.mimeType}]`).join("") });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: entry.id }] } });
    }
    out({ type: "system", subtype: "status", status: null });
    await play(nextReply());
  };
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", line => {
    const message = JSON.parse(line) as Json;
    if (message.type === "control_request") {
      const subtype = message.request.subtype as string;
      log({ control: subtype, ...(subtype === "apply_flag_settings" ? { effort: message.request.settings?.effortLevel } : {}) });
      out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      if (subtype === "interrupt") active?.interrupt();
      if (subtype === "end_session") { log({ exit: "end_session" }); mcp?.kill(); process.exit(0); }
    } else if (message.type === "user") {
      const content = message.message.content as Json[];
      log({ user: content.length, heads: content.map(block => block.type === "text" ? String(block.text).split("\n")[0] : block.type) });
      out({ type: "system", subtype: "init", per_turn_effort_active: scenario.perTurnEffort ?? true, fast_mode_state: "off" });
      void play(nextReply());
    }
  });
  lines.on("close", () => { if (live) { log({ exit: "stdin" }); mcp?.kill(); process.exit(0); } });
}

export interface ClaudeFixture {
  directory: string;
  setScenario(scenario: FixtureScenario): Promise<void>;
  capture(): Promise<FixtureEntry[]>;
  restore(): Promise<void>;
}

/** Installs the fixture as `claude` on PATH, with its scenario and capture files in a fresh directory. */
export async function installClaudeFixture(scenario: FixtureScenario = { replies: [] }): Promise<ClaudeFixture> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-live-"));
  const scenarioPath = join(directory, "scenario.json"); const capturePath = join(directory, "capture.jsonl");
  await writeFile(join(directory, "claude"), `#!${process.execPath}\n(${fixtureMain.toString()})();\n`); await chmod(join(directory, "claude"), 0o700);
  await writeFile(scenarioPath, JSON.stringify(scenario)); await writeFile(capturePath, "");
  const previous = { PATH: process.env.PATH, scenario: process.env.CLAUDE_FIXTURE_SCENARIO, capture: process.env.CLAUDE_FIXTURE_CAPTURE };
  process.env.PATH = directory + delimiter + process.env.PATH; process.env.CLAUDE_FIXTURE_SCENARIO = scenarioPath; process.env.CLAUDE_FIXTURE_CAPTURE = capturePath;
  const put = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  return {
    directory,
    setScenario: value => writeFile(scenarioPath, JSON.stringify(value)),
    capture: async () => (await readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as FixtureEntry),
    restore: async () => { put("PATH", previous.PATH); put("CLAUDE_FIXTURE_SCENARIO", previous.scenario); put("CLAUDE_FIXTURE_CAPTURE", previous.capture); await rm(directory, { recursive: true, force: true }); },
  };
}

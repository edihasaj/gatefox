// A fake `gemini` executable for tests: `gemini --acp` speaking ACP, plus the MCP client a real Gemini CLI would be.
// The prompt text picks the scenario with its last [tag]. Nothing here runs inference.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createInterface } from "node:readline";

const log = (entry: Record<string, unknown>) => { if (process.env.GATEWAY_TEST_GEMINI_LOG) appendFileSync(process.env.GATEWAY_TEST_GEMINI_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
const args = process.argv.slice(2);
const home = process.env.GEMINI_CLI_HOME;
// The gateway's own non-secret switches, which it must set; anything else in these families is a leaked credential.
const owned = new Set(["GEMINI_CLI_HOME", "GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GEMINI_CLI_SYSTEM_DEFAULTS_PATH", "GEMINI_FORCE_FILE_STORAGE", "GEMINI_CLI_NO_RELAUNCH", "GEMINI_SYSTEM_MD"]);
// What the CLI can see of the caller's credentials: a real gateway must have removed every one of these.
const leaked = Object.keys(process.env).filter(name => !owned.has(name) && (name.startsWith("GOOGLE_") || name.startsWith("VERTEX") || name.startsWith("GEMINI_"))).sort();
// Booleans only: the gateway's off-switches must be on, and a prompt must never reach the CLI shaped like one of its commands.
const flags = { fileStorage: process.env.GEMINI_FORCE_FILE_STORAGE === "true", noRelaunch: process.env.GEMINI_CLI_NO_RELAUNCH === "true",
  // Both system-scope paths must be set and point at nothing: a system document would outrank the managed settings,
  // and the CLI refuses one it did not create as unowned by root. The gateway closes that scope by naming absent files.
  systemScopeClosed: !!process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH && !existsSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH)
    && !!process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH && !existsSync(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH),
  policy: home ? existsSync(`${home}/.gemini/policies/gateway.toml`) : false,
  systemMd: !!process.env.GEMINI_SYSTEM_MD && existsSync(process.env.GEMINI_SYSTEM_MD),
  encryptedStorage: process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE === undefined, noBrowser: process.env.NO_BROWSER === undefined };
// What the CLI sees that decides whether it opens a browser: these must all have been removed by the gateway.
const browserEnv = { ci: process.env.CI !== undefined, ssh: process.env.SSH_CONNECTION !== undefined, browser: process.env.BROWSER !== undefined, debian: process.env.DEBIAN_FRONTEND !== undefined };
const modeOf = (path: string) => { try { return statSync(path).mode & 0o777; } catch { return undefined; } };
log({ op: "spawn", args, home, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()).length, cwdMode: modeOf(process.cwd()), homeMode: home ? modeOf(home) : undefined,
  credMode: home ? modeOf(`${home}/.gemini/oauth_creds.json`) : undefined, opener: (process.env.PATH ?? "").split(":")[0], browserEnv, leaked, flags, credential: home ? existsSync(`${home}/.gemini/oauth_creds.json`) : false,
  settings: home && existsSync(`${home}/.gemini/settings.json`) ? readFileSync(`${home}/.gemini/settings.json`, "utf8") : undefined });
if (process.env.GATEWAY_TEST_GEMINI_DIE_ON_START) process.exit(3);
/**
 * The real CLI runs `open` by name. The fixture only ever runs the stand-in the gateway put first on PATH, so a gateway that
 * forgot it would show up as a missing marker in the test rather than as a browser opening on the machine running the suite.
 */
const openBrowser = (url: string) => {
  const opener = `${(process.env.PATH ?? "").split(":")[0]}/open`;
  if (!existsSync(opener) || !readFileSync(opener, "utf8").includes("Written by the gateway")) { log({ op: "no-stand-in" }); return; }
  spawnSync(opener, [url]);
};
const writeCredentials = (credentials: Record<string, unknown>) => {
  const file = `${home}/.gemini/oauth_creds.json`; writeFileSync(`${file}.tmp`, JSON.stringify(credentials), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
};
// The real CLI records every conversation in its home (`tmp/<project>/chats/session-*.jsonl`, `history/`) and cannot be told
// not to: the fixture does the same, so a test can see whether the gateway let that reach its persistent home.
if (home) {
  mkdirSync(`${home}/.gemini/tmp/proj/chats`, { recursive: true }); writeFileSync(`${home}/.gemini/tmp/proj/chats/session-1.jsonl`, '{"canary":"TRANSCRIPT_CANARY"}\n');
  mkdirSync(`${home}/.gemini/history/proj`, { recursive: true });
}
// The CLI refreshes an expired access token while it runs and saves it back to the home it was given.
if (home && args.length && process.env.GATEWAY_TEST_GEMINI_REFRESH) {
  writeCredentials({ ...JSON.parse(readFileSync(`${home}/.gemini/oauth_creds.json`, "utf8")), access_token: process.env.GATEWAY_TEST_GEMINI_REFRESH });
}
let mcpUrl = ""; let sessionId = ""; let nextId = 1000; let promptId = 0;
const waiting = new Map<number, (message: Record<string, any>) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
const send = (message: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (value: Record<string, unknown>) => send({ method: "session/update", params: { sessionId, update: value } });
const chunk = (text: string, kind = "agent_message_chunk") => update({ sessionUpdate: kind, content: { type: "text", text } });
/** One permission request for a tool of the gateway MCP server, shaped the way a CLI announces an MCP tool call. */
const ask = (toolCall: Record<string, unknown>, title: string) => new Promise<Record<string, any>>(resolve => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const id = nextId++; waiting.set(id, resolve);
  send({ id, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: `t${id}`, title, ...toolCall },
    options: [{ optionId: "a", kind: "allow_once", name: "Allow" }, { optionId: "aa", kind: "allow_always", name: "Always" }, { optionId: "r", kind: "reject_once", name: "Reject" }] } });
});
const gatewayCall = (toolName: string) => ask({ kind: "other", title: toolName, rawInput: { tool_name: toolName }, _meta: { server: "gateway" } }, toolName);
const nativeCall = (command: string) => ask({ kind: "execute", title: command, rawInput: { command } }, command);
/** The fields the 0.70.0 CLI puts on a call of the gateway server: its own `_meta` says whose tool this is. */
const mcpMeta = (toolName: string) => ({ "gemini-cli": { mcp: { server_name: "gateway", tool_name: toolName } } });
const mcp = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, any>>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const url = new URL(mcpUrl); const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
  const call = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json" } }, response => {
    let text = ""; response.on("data", piece => { text += piece; }); response.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
  });
  call.on("error", reject); call.end(body);
});
/** Posts a raw JSON-RPC body and waits only for the response to end (a 202 has no body). */
const mcpRaw = (frame: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
  const url = new URL(mcpUrl);
  const call = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json" } }, response => {
    response.resume(); response.on("end", () => resolve());
  });
  call.on("error", reject); call.end(JSON.stringify({ jsonrpc: "2.0", ...frame }));
});
const selected = (reply: Record<string, any>) => reply.result?.outcome?.outcome === "selected" ? String(reply.result.outcome.optionId) : "cancelled"; // eslint-disable-line @typescript-eslint/no-explicit-any

async function useGateway(toolName: string, input: Record<string, unknown>): Promise<string> {
  update({ sessionUpdate: "tool_call", toolCallId: "u", title: toolName, status: "pending" });
  const outcome = selected(await gatewayCall(toolName));
  log({ op: "permission", server: "gateway", tool: toolName, outcome });
  if (outcome !== "a") return `denied:${outcome}`;
  const reply = await mcp("tools/call", { name: toolName, arguments: input });
  log({ op: "result", text: reply.result?.content?.[0]?.text, isError: reply.result?.isError, error: reply.error?.message });
  return String(reply.result?.content?.[0]?.text ?? `error:${reply.error?.message}`);
}

/** The same loop, shaped the way a CLI shapes a real MCP call, with a display title of the test's choosing. */
async function useAsMcp(toolName: string, displayTitle: string, input: Record<string, unknown>): Promise<string> {
  const toolCall = { kind: "other", title: displayTitle, rawInput: { tool_name: toolName }, _meta: mcpMeta(toolName) };
  update({ sessionUpdate: "tool_call", toolCallId: "u", ...toolCall, status: "in_progress" });
  const outcome = selected(await ask(toolCall, displayTitle));
  log({ op: "permission", server: "gateway", tool: toolName, displayTitle, outcome });
  if (outcome !== "a") return `denied:${outcome}`;
  const reply = await mcp("tools/call", { name: toolName, arguments: input });
  log({ op: "result", text: reply.result?.content?.[0]?.text, isError: reply.result?.isError, error: reply.error?.message });
  return String(reply.result?.content?.[0]?.text ?? `error:${reply.error?.message}`);
}

async function prompt(text: string): Promise<string> {
  const tag = [...text.matchAll(/\[(\w+)\]/g)].at(-1)?.[1] ?? "plain";
  // Booleans and a length only: the prompt itself is caller content and is never written to the log. `commandShaped`
  // is what the gateway's framing exists to prevent — the real CLI runs such a prompt as its own command.
  log({ op: "prompt", tag, chars: text.length, commandShaped: /^[/$]/.test(text) });
  if (tag === "crash") { chunk("partial"); process.exit(1); }
  if (tag === "stall") { chunk("started"); await new Promise(() => {}); }
  // Frames that are valid JSON but not an object, and shape faults: the gateway must end the connection, not crash.
  const frames: Record<string, string> = { nullframe: "null", arrayframe: "[]", numframe: "42",
    badmsg: `{"jsonrpc":"2.0","id":${promptId},"error":{"code":-32000,"message":{"toString":null}}}`,
    badcode: `{"jsonrpc":"2.0","id":${promptId},"error":{"code":"x","message":"y"}}`,
    badresult: `{"jsonrpc":"2.0","id":${promptId},"result":"done"}` };
  if (tag in frames) { process.stdout.write(frames[tag] + "\n"); await new Promise(() => {}); }
  if (tag === "auth") throw new Error("authentication required");
  // A first prompt that shows a sign of inference and then fails with a rejected sign-in: the work may have been charged.
  if (tag === "authtool") { update({ sessionUpdate: "tool_call", toolCallId: "s1", title: "lookup", kind: "other", status: "completed" }); throw new Error("authentication required"); }
  if (tag === "authperm") { await nativeCall("touch x"); throw new Error("authentication required"); }
  if (tag === "authmcp") { await mcp("tools/call", { name: "unlisted", arguments: {} }); throw new Error("authentication required"); }
  if (tag === "authsetup") { update({ sessionUpdate: "available_commands_update", availableCommands: [] }); update({ sessionUpdate: "current_mode_update", currentModeId: "default" }); throw new Error("authentication required"); }
  // A stop reason that is provider-controlled text: it must reach neither telemetry nor a message.
  if (tag === "stopcanary") { chunk("x"); return "CANARY_STOP_REASON_4711"; }
  if (tag === "plain") { chunk(`answer to ${tag}`); return "end_turn"; }
  if (tag === "think") { chunk("thinking about it", "agent_thought_chunk"); chunk(`answer to ${tag}`); return "end_turn"; }
  const listed = await mcp("tools/list");
  const names: string[] = (listed.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  log({ op: "listed", names, discover: (await mcp("server/discover")).error?.code });
  if (tag === "native") {
    const outcome = selected(await nativeCall("touch native-ran"));
    log({ op: "permission", kind: "execute", outcome });
    if (outcome === "a") writeFileSync("native-ran", "ran"); // a fail-open CLI would run it
    chunk(`native:${outcome}`); return "end_turn";
  }
  if (tag === "foreign") {
    // A tool the gateway does not host: it must never be allowed, whatever it is named.
    const outcome = selected(await ask({ kind: "other", title: "lookup", rawInput: { tool_name: "lookup" }, _meta: { server: "somewhere_else" } }, "lookup"));
    log({ op: "permission", server: "somewhere_else", outcome });
    chunk(`foreign:${outcome}`); return "end_turn";
  }
  // The CLI's bundled default policies let some built-ins run with no permission request at all: the gateway must end a
  // session that announces one, rather than let the provider execute a tool of its own.
  if (tag === "nativeauto") {
    update({ sessionUpdate: "tool_call", toolCallId: "n1", title: "cat /etc/passwd", kind: "execute", status: "in_progress", rawInput: { command: "cat /etc/passwd" } });
    chunk("read it"); return "end_turn";
  }
  if (tag === "builtinauto") {
    update({ sessionUpdate: "tool_call", toolCallId: "n2", title: "grep_search", status: "in_progress", rawInput: { pattern: "secret" } });
    chunk("searched"); return "end_turn";
  }
  // The CLI's own search tool announced under its own name, with no gateway MCP identity to mistake it for a caller
  // tool and a display title that says nothing of it: only the structured name can catch it.
  if (tag === "builtinnonmcp") {
    update({ sessionUpdate: "tool_call", toolCallId: "b1", title: "Searching the project", name: "grep_search", kind: "other", status: "in_progress", rawInput: { pattern: "secret" } });
    chunk("searched"); return "end_turn";
  }
  // A caller tool that happens to be named like a built-in: identified by the CLI's own MCP fields as the caller's
  // tool, it must run normally rather than be taken for the built-in it shares a name with.
  if (tag === "builtinname") {
    const name = names.find(candidate => candidate.includes("grep_search")) ?? names[0];
    chunk("Searching the project. ");
    chunk(`builtinname:${await useAsMcp(name, "grep_search", { pattern: "needle" })}`); return "end_turn";
  }
  if (tag === "foreignauto") {
    update({ sessionUpdate: "tool_call", toolCallId: "n3", title: "lookup", status: "in_progress", rawInput: { tool_name: "lookup" }, _meta: { server: "somewhere_else" } });
    chunk("asked elsewhere"); return "end_turn";
  }
  if (tag === "unknown") { chunk(`unknown:${await useGateway("tool_not_in_catalog", {})}`); return "end_turn"; }
  if (tag === "clientrequest") {
    // A client request the gateway does not serve must be answered, never left waiting.
    const id = nextId++; const reply = await new Promise<Record<string, any>>(resolve => { waiting.set(id, resolve); // eslint-disable-line @typescript-eslint/no-explicit-any
      send({ id, method: "fs/read_text_file", params: { sessionId, path: "x" } }); });
    log({ op: "clientrequest", code: reply.error?.code });
    chunk(`fs:${reply.error?.code ?? "answered"}`); return "end_turn";
  }
  if (tag === "tool") {
    chunk("Looking it up. ");
    chunk(`got:${await useGateway(names[0], { id: "7" })}`); return "end_turn";
  }
  if (tag === "twice") {
    chunk(`first:${await useGateway(names[0], { id: "1" })}|`);
    chunk(`second:${await useGateway(names[0], { id: "2" })}`); return "end_turn";
  }
  if (tag === "parallel") {
    const [one, two] = await Promise.all([useGateway(names[0], { id: "a" }), useGateway(names[0], { id: "b" })]);
    chunk(`both:${one},${two}`); return "end_turn";
  }
  chunk(`unhandled ${tag}`); return "end_turn";
}

/**
 * `gemini` with no arguments, the way the gateway's sign-in runs it. Like the real CLI without a terminal, it asks for consent
 * on stdout and reads the answer from stdin (a closed stdin ends the process with status 0 and no credential); it then runs the
 * browser opener by name with the sign-in URL and prints no URL of its own. The scenario is `GATEWAY_TEST_GEMINI_LOGIN`.
 */
async function login(): Promise<void> {
  const scenario = process.env.GATEWAY_TEST_GEMINI_LOGIN ?? "ok";
  process.stdout.write("\nOpening authentication page in your browser. Do you want to continue? [Y/n]: ");
  const answer = await new Promise<string>(resolve => createInterface({ input: process.stdin }).once("line", resolve));
  const yes = ["y", ""].includes(answer.trim().toLowerCase());
  log({ op: "consent", yes });
  if (!yes || scenario === "exit0") process.exit(0);
  const url = scenario === "foreignurl" ? "https://evil.example/o/oauth2/v2/auth?x=1" : "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1&state=s";
  openBrowser(url);
  if (scenario === "nourl") { /* a CLI that never asks for a browser */ }
  await new Promise(resolve => setTimeout(resolve, 250));
  if (scenario === "norefresh") writeCredentials({ access_token: "login-access" });
  else writeCredentials({ access_token: "login-access", refresh_token: "login-refresh" });
  if (scenario === "creds-exit1") process.exit(1);
  // Like the real callback handler: the tokens are saved first, then the account is fetched and cached, and only then is the
  // browser redirected to the success page. A gateway that ends the CLI on the credential alone cuts the last two off.
  if (scenario !== "noaccount") {
    await new Promise(resolve => setTimeout(resolve, 600));
    writeFileSync(`${process.env.GEMINI_CLI_HOME}/.gemini/google_accounts.json`, JSON.stringify({ active: "user@example.com", old: [] }), { mode: 0o600 });
    log({ op: "browser-answered" });
  }
  setInterval(() => {}, 1000); // a CLI that has signed in goes on running; the gateway must end it
}
if ((process.env.GATEWAY_TEST_GEMINI_BROWSER || process.env.GATEWAY_TEST_GEMINI_HANG) && args.length) {
  // A sign-in that cannot refresh: the CLI asks for a browser by running the opener, then never answers `initialize`.
  // `GATEWAY_TEST_GEMINI_HANG` is the same silence without the opener: a CLI that is still booting.
  if (process.env.GATEWAY_TEST_GEMINI_BROWSER) { openBrowser("https://accounts.google.com/o/oauth2/v2/auth?x=1"); log({ op: "browser-asked" }); }
  setInterval(() => {}, 1000);
} else if (!args.length) void login();
else {
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (message.method === undefined) { waiting.get(message.id)?.(message); waiting.delete(message.id); return; }
  const reply = (result: Record<string, unknown>) => send({ id: message.id, result });
  if (message.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  if (message.method === "session/new") {
    mcpUrl = message.params.mcpServers[0].url; sessionId = "fixture-session";
    log({ op: "new", servers: message.params.mcpServers.map((server: Record<string, unknown>) => ({ type: server.type, name: server.name })), cwd: message.params.cwd });
    return reply({ sessionId });
  }
  if (message.method === "session/prompt") {
    const text = String(message.params.prompt?.[0]?.text ?? ""); promptId = message.id;
    void prompt(text).then(stopReason => reply({ stopReason }),
      () => send({ id: message.id, error: { code: -32000, message: "authentication required" } }));
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
lines.on("close", () => process.exit(0));
}
// A test whose parent is gone must not leave a fixture behind.
setInterval(() => { try { process.kill(process.ppid, 0); } catch { process.exit(0); } }, 1000).unref();

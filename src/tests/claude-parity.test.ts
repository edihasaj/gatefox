import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { discoverClaudeModels, readClaudeModels } from "../providers/claude-models.js";
import { gatewaySystemPrompt } from "../providers/claude-control.js";
import { ledgerEntries } from "../providers/claude-ledger.js";
import { loadDiscoveredModels, modelCatalog } from "../catalog.js";
import { loadConfig, validateConfig, writePrivateJson, type ProviderConfig } from "../config.js";
import { refreshModelMetadata } from "../model-refresh.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { InferenceEvent, ResponsesInputItem } from "../protocol/types.js";
import type { ClaudeLimit } from "../providers/claude-usage.js";

const drain = async (events: AsyncIterable<InferenceEvent>) => { const result: InferenceEvent[] = []; for await (const event of events) result.push(event); return result; };
const message = (role: "user" | "assistant" | "developer" | "system", text: string): ResponsesInputItem =>
  ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] }) as ResponsesInputItem;
const levels = ["low", "medium", "high", "xhigh", "max"];
const native = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: levels },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", supportsEffort: true, supportedEffortLevels: levels },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", supportsEffort: true, supportedEffortLevels: levels },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
];

// A metadata-only CLI: it exits 8 on anything but initialize, apply_flag_settings and get_settings, such as a user message.
// Like the real CLI, an inherited CLAUDE_CODE_EFFORT_LEVEL overrides every model's applied effort.
const workerScript = (applied: Record<string, string | null>, settings = true) => `
  import {createInterface} from 'node:readline';
  const applied=${JSON.stringify(applied)};let model='claude-opus-5-5';
  const answer=(m,response,subtype='success')=>console.log(JSON.stringify({type:'control_response',response:{subtype,request_id:m.request_id,response}}));
  for await(const line of createInterface({input:process.stdin})){
    const m=JSON.parse(line);const subtype=m.type==='control_request'?m.request.subtype:undefined;
    if(subtype==='initialize')answer(m,{models:${JSON.stringify(native)}});
    else if(subtype==='apply_flag_settings'){model=m.request.settings.model;answer(m,{});}
    else if(subtype==='get_settings'){if(${settings})answer(m,{applied:{model,effort:process.env.CLAUDE_CODE_EFFORT_LEVEL??applied[model]??null}});else answer(m,undefined,'error');}
    else process.exit(8);
  }`;
const discoveryWorker = (applied: Record<string, string | null>, settings = true) =>
  spawn(process.execPath, ["--input-type=module", "-e", workerScript(applied, settings)], { stdio: ["pipe", "pipe", "pipe"] });

test("each Claude row defaults to the CLI's own effort for that model, and to medium when the CLI gives none", async () => {
  const child = discoveryWorker({ "claude-opus-5-5": "xhigh", "claude-fable-5-1": "turbo" });
  const models = await readClaudeModels(child);
  assert.notEqual(child.exitCode, 8, "only metadata control requests reach the CLI");
  assert.deepEqual(models.map(entry => [entry.model, entry.metadata.defaultReasoningEffort]),
    [["claude-opus-5-5", "xhigh"], ["claude-fable-5-1", undefined], ["claude-sonnet-5-5", undefined], ["claude-haiku-4-5-20251001", undefined]], "never an invented or unsupported level");
  const provider: ProviderConfig = { id: "claude", type: "claude-subscription", models: { placeholder: "none" } };
  loadDiscoveredModels(provider, models);
  const config = validateConfig({ version: 1, port: 0, stateDirectory: ".", providers: [provider] });
  assert.deepEqual(modelCatalog(config).models.map(row => [row.slug, row.default_reasoning_level]),
    [["claude/claude-opus-5-5", "xhigh"], ["claude/claude-fable-5-1", "medium"], ["claude/claude-sonnet-5-5", "medium"], ["claude/claude-haiku-4-5-20251001", null]]);
  // A stored default the model no longer supports falls back too; an unknown name never loads.
  provider.modelMetadata!["claude/claude-sonnet-5-5"] = { ...provider.modelMetadata!["claude/claude-sonnet-5-5"], reasoningEfforts: ["low", "medium"], defaultReasoningEffort: "xhigh" };
  assert.equal(modelCatalog(validateConfig({ version: 1, port: 0, stateDirectory: ".", providers: [provider] })).models[2].default_reasoning_level, "medium");
  provider.modelMetadata!["claude/claude-sonnet-5-5"].defaultReasoningEffort = "turbo";
  assert.throws(() => validateConfig({ version: 1, port: 0, stateDirectory: ".", providers: [provider] }), /default reasoning effort/);
});

test("a CLI without get_settings still yields its catalog, with medium defaults", async () => {
  const models = await readClaudeModels(discoveryWorker({}, false));
  assert.equal(models.length, 4); assert.ok(models.every(entry => entry.metadata.defaultReasoningEffort === undefined));
});

test("a refresh whose CLI gives no default clears the stored one, so the row returns to medium", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-refresh-")); const path = join(directory, "gateway.json");
  await writePrivateJson(path, { version: 1, port: 0, stateDirectory: directory, providers: [{ id: "claude", type: "claude-subscription", models: { opus: "claude-opus-5-5" } }] });
  const saved = async () => ((await loadConfig(path)).providers[0].modelMetadata?.opus.defaultReasoningEffort);
  try {
    await refreshModelMetadata(path, () => readClaudeModels(discoveryWorker({ "claude-opus-5-5": "high" })));
    assert.equal(await saved(), "high");
    // get_settings fails, as when it times out or a later CLI drops it.
    assert.deepEqual(await refreshModelMetadata(path, () => readClaudeModels(discoveryWorker({}, false))), ["claude"]);
    assert.equal(await saved(), undefined);
    assert.equal(modelCatalog(await loadConfig(path)).models[0].default_reasoning_level, "medium");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("discovery reads the model defaults, not an effort the gateway's host shell exported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-defaults-"));
  await writeFile(join(directory, "claude"), `#!${process.execPath}\n${workerScript({ "claude-opus-5-5": "medium", "claude-fable-5-1": "high", "claude-sonnet-5-5": "medium" })}\n`);
  await chmod(join(directory, "claude"), 0o700);
  const previous = { PATH: process.env.PATH, CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL };
  Object.assign(process.env, { PATH: directory + delimiter + process.env.PATH, CLAUDE_CODE_EFFORT_LEVEL: "low" });
  try {
    const models = await discoverClaudeModels({ id: "claude", type: "claude-subscription", models: { alias: "claude-opus-5-5" } });
    assert.deepEqual(models.map(entry => entry.metadata.defaultReasoningEffort), ["medium", "high", "medium", undefined]);
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(directory, { recursive: true, force: true });
  }
});

test("leading caller instructions become the system prompt; later developer messages and lone instructions stay in the history", async () => {
  const f = await installClaudeFixture();
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } });
    const description = "d".repeat(5000);
    const tools = [{ type: "function" as const, name: "long_tool", description, parameters: { type: "object", properties: {} } }];
    // A gateway started from a Claude Code shell must not hand that session's variables to one-shot CLIs either.
    const host = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
    Object.assign(process.env, { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" });
    await drain(adapter.infer({ model: "fixture", instructions: "Base rules", tools,
      input: [message("developer", "Dev A"), message("system", "Sys B"), message("user", "Hello"), message("developer", "Later dev"), message("user", "Again")] }, new AbortController().signal))
      .finally(() => { for (const [name, value] of Object.entries(host)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
    await drain(adapter.infer({ model: "fixture", instructions: "Base rules", input: [message("developer", "Only dev")] }, new AbortController().signal));
    const capture = await f.capture(); const [first, second] = capture.filter(entry => entry.start); const [a, b] = capture.filter(entry => entry.user !== undefined);
    assert.equal(first.system, `${gatewaySystemPrompt}\n\nBase rules\n\nDev A\n\nSys B`);
    assert.deepEqual(a.heads?.slice(1), ["<<item 1 user>>", "<<item 2 developer>>", "<<item 3 user>>"], "the rest of the history renders as before, numbered from its first message");
    assert.equal(second.system, gatewaySystemPrompt);
    assert.deepEqual(b.heads?.slice(1), ["<<item 1 system>>", "<<item 2 developer>>"]);
    // One-shot CLIs declare only the gateway's tools, and caller descriptions reach the model whole.
    assert.deepEqual([first.advisorOff, first.toolSearchOff, first.descriptionLimit, second.descriptionLimit], [true, true, String(`Caller tool long_tool. ${description}`.length), "2048"]);
    assert.deepEqual(first.claudeVars, ["CLAUDE_CODE_DISABLE_ADVISOR_TOOL", "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH"], "only the gateway's own Claude Code variables");
  } finally { await f.restore(); }
});

test("a live session reseeds when the leading instructions change, and continues with a later developer message", async () => {
  const f = await installClaudeFixture({ replies: [{ text: "ok" }, { text: "two" }, { text: "three" }] });
  configureTelemetry(f.directory, "test"); const since = Date.now();
  try {
    const adapter = new ClaudeSubscription({ id: `claude-b3-${process.pid}`, type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: "live" } });
    const context = { threadId: "thread-b3" }; const first = [message("developer", "Dev A"), message("user", "one")];
    await drain(adapter.infer({ model: "fixture", input: first }, new AbortController().signal, context));
    const second = [...first, message("assistant", "ok"), message("developer", "Later dev"), message("user", "two")];
    await drain(adapter.infer({ model: "fixture", input: second }, new AbortController().signal, context));
    await drain(adapter.infer({ model: "fixture", input: [message("developer", "Dev B"), ...second.slice(1)] }, new AbortController().signal, context));
    const capture = await f.capture(); const starts = capture.filter(entry => entry.start === "live"); const users = capture.filter(entry => entry.user !== undefined);
    assert.deepEqual(starts.map(entry => entry.system), [`${gatewaySystemPrompt}\n\nDev A`, `${gatewaySystemPrompt}\n\nDev B`]);
    assert.deepEqual(users[1].heads, ["<<item 3 developer>>", "<<item 4 user>>"], "the continued turn sends only its new items");
    await flushTelemetry();
    const sessions = (await readTelemetry(f.directory, since)).filter(entry => entry.event === "claude_session" && entry.outcome !== "closed");
    assert.deepEqual(sessions.map(entry => [entry.outcome, entry.missReason]), [["spawned", undefined], ["continued", undefined], ["reseeded", "fingerprint_changed"]]);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await f.restore(); }
});

test("the ledger skips the messages that moved into the system prompt", () => {
  const request = { model: "m", instructions: "Base", input: [message("developer", "Dev"), message("user", "Hi"), message("developer", "Later")] };
  const { entries, messages } = ledgerEntries(request, [], 2);
  assert.equal(messages, 2); assert.deepEqual(entries.map(entry => [entry.kind, entry.first, entry.count]), [["m", 0, 1], ["m", 1, 1]]);
});

// A one-shot CLI that finishes a text turn, prints its rate limit (unless told not to), then prints the result: with the turn when
// GATEWAY_FIXTURE_RESULT_MS is 0 (all lines in one run, so none can be cut off by the gateway's stop), never when it is "hold" (the
// CLI then stays until it is stopped), or after that many ms. It records the pid of each CLI, and a line in `results` for each result it printed.
async function slowResultFixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-endturn-"));
  const script = `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';for await(const _ of process.stdin){}appendFileSync(${JSON.stringify(join(directory, "pids"))},process.pid+'\\n');
const parent=process.ppid;const watch=setInterval(()=>{try{process.kill(parent,0)}catch{process.exit(0)}},100);if(process.env.GATEWAY_FIXTURE_RESULT_MS!=='hold')watch.unref();
const out=value=>console.log(JSON.stringify(value));const event=value=>out({type:'stream_event',event:value});const stop=process.env.GATEWAY_FIXTURE_STOP||'end_turn';
event({type:'message_start',message:{id:'msg_1',usage:{input_tokens:3,cache_read_input_tokens:50,cache_creation_input_tokens:7,output_tokens:1}}});
event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hi'}});
event({type:'content_block_stop',index:0});event({type:'message_delta',delta:{stop_reason:stop},usage:{output_tokens:5}});event({type:'message_stop'});
if(!process.env.GATEWAY_FIXTURE_NO_LIMIT)out({type:'rate_limit_event',rate_limit_info:{status:'allowed_warning',rateLimitType:'five_hour',resetsAt:4000000000}});
const ms=process.env.GATEWAY_FIXTURE_RESULT_MS||'0';const result=()=>{appendFileSync(${JSON.stringify(join(directory, "results"))},'x\\n');out(stop==='end_turn'?{type:'result',subtype:'success',is_error:false,result:'Hi',modelUsage:{fixture:{contextWindow:300000}}}:{type:'result',subtype:'error_max_turns',is_error:true});process.exit(0);};
if(ms==='0')result();else if(ms!=='hold')setTimeout(result,Number(ms));\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = process.env.PATH; process.env.PATH = directory + delimiter + process.env.PATH;
  return { directory, pids: async () => (await readFile(join(directory, "pids"), "utf8")).trim().split("\n").map(Number),
    results: async () => (await readFile(join(directory, "results"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length,
    restore: async () => {
      if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
      for (const name of ["GATEWAY_FIXTURE_STOP", "GATEWAY_FIXTURE_NO_LIMIT", "GATEWAY_FIXTURE_RESULT_MS"]) delete process.env[name];
      await rm(directory, { recursive: true, force: true });
    } };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Waits for the process to be gone, however long that takes: a CLI that is never stopped fails the test by its timeout. */
async function gone(pid: number): Promise<boolean> {
  while (alive(pid)) await new Promise(resolve => setTimeout(resolve, 10));
  return true;
}

test("a one-shot text turn ends at its end_turn delta with that usage, keeping a prompt rate limit and result window, without waiting for a slow result", { timeout: 30000 }, async () => {
  const f = await slowResultFixture();
  try {
    const limits: ClaudeLimit[] = []; const windows: Array<[string, number]> = [];
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } }, async limit => { limits.push(limit); }, (model, window) => { windows.push([model, window]); });
    // A CLI that never prints its result ("hold") cannot be waited for: a build that does hangs until the test's timeout. One that
    // prints it with the turn (0) is read to the end of what it printed.
    for (const [noLimit, resultMs] of [[false, "hold"], [true, "hold"], [false, "0"]] as const) {
      process.env.GATEWAY_FIXTURE_RESULT_MS = resultMs; if (noLimit) process.env.GATEWAY_FIXTURE_NO_LIMIT = "1"; else delete process.env.GATEWAY_FIXTURE_NO_LIMIT;
      const events: InferenceEvent[] = [];
      for await (const event of adapter.infer({ model: "fixture", input: "hello" }, new AbortController().signal)) events.push(event);
      assert.equal(await f.results(), resultMs === "hold" ? 0 : 1, `${resultMs}: ${resultMs === "hold" ? "the CLI printed no result, and the request ended" : "the CLI printed its result"}`);
      assert.deepEqual(events, [{ type: "text", text: "Hi" }, { type: "done", usage: { input_tokens: 60, output_tokens: 5, total_tokens: 65, input_tokens_details: { cached_tokens: 50, cache_creation_tokens: 7 } }, accounting: { cacheWriteTokens: 7 } }]);
    }
    assert.deepEqual(limits.map(limit => limit.status), ["allowed_warning", "allowed_warning"], "the rate limit printed right after the turn is kept");
    assert.deepEqual(windows, [["fixture", 300000]], "a result that follows promptly still reports its window");
    // Codex closes the connection at response.completed: that abort ends the request quietly and is no interruption.
    configureTelemetry(f.directory, "test"); const since = Date.now(); const controller = new AbortController();
    for await (const event of adapter.infer({ model: "fixture", input: "hello" }, controller.signal)) if (event.type === "done") controller.abort();
    await flushTelemetry();
    const cli = (await readTelemetry(f.directory, since)).filter(entry => entry.event === "claude_cli");
    assert.deepEqual(cli.map(entry => [entry.result, entry.aborted, entry.interrupted]), [["end_turn", false, false]]);
    for (const pid of await f.pids()) assert.ok(await gone(pid), "the CLI is stopped");
    // Any other stop still waits for the result and keeps its classification.
    process.env.GATEWAY_FIXTURE_STOP = "max_tokens";
    await assert.rejects(drain(adapter.infer({ model: "fixture", input: "hello" }, new AbortController().signal)), { code: "inference_failed", upstream: { code: "unknown", event: "claude.result", subtype: "error_max_turns" } });
  } finally { await f.restore(); }
});

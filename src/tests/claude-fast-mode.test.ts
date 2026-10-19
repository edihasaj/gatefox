import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ClaudeSubscription, claudeFastMode } from "../providers/claude.js";
import { claudeFastTier, nativeClaudeModels } from "../providers/claude-models.js";
import { modelCatalog } from "../catalog.js";
import type { ProviderConfig } from "../config.js";
import type { InferenceEvent } from "../protocol/types.js";

const drain = async (events: AsyncIterable<InferenceEvent>) => { const result: InferenceEvent[] = []; for await (const event of events) result.push(event); return result; };

test("Claude rows that support fast mode offer Codex's Fast tier; others clear it", () => {
  const [opus, haiku] = nativeClaudeModels([
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsFastMode: true },
    { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" },
  ]);
  assert.deepEqual(opus.metadata.serviceTiers, [claudeFastTier]);
  assert.deepEqual(opus.metadata.additionalSpeedTiers, ["fast"]);
  assert.equal(opus.metadata.defaultServiceTier, null, "new chats start at Standard");
  assert.deepEqual(haiku.metadata.serviceTiers, []);
  const catalog = modelCatalog({ version: 1, port: 0, stateDirectory: ".", providers: [
    { id: "claude", type: "claude-subscription", models: { opus: "claude-opus-5-5" }, modelMetadata: { opus: opus.metadata } },
  ] });
  assert.deepEqual(catalog.models[0].service_tiers, [claudeFastTier], "the served catalog carries Fast to every client Mac");
});

test("Fast maps to Claude fast mode only for models that offer it", () => {
  const config: ProviderConfig = { id: "claude", type: "claude-subscription", models: { opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" },
    modelMetadata: { opus: { serviceTiers: [claudeFastTier] }, haiku: { serviceTiers: [] } } };
  for (const tier of [undefined, null, "auto", "default"] as const) assert.equal(claudeFastMode(config, { model: "claude-opus-5-5", input: "x", service_tier: tier }), false);
  assert.equal(claudeFastMode(config, { model: "claude-opus-5-5", input: "x", service_tier: "priority" }), true);
  assert.equal(claudeFastMode(config, { model: "claude-opus-5-5", input: "x", service_tier: "fast" }), true);
  assert.throws(() => claudeFastMode(config, { model: "claude-haiku-5-5", input: "x", service_tier: "priority" }), /does not offer Fast/);
  // Claude has no flex processing, so Flex is served as Standard rather than rejected.
  for (const model of ["claude-opus-5-5", "claude-haiku-5-5"]) assert.equal(claudeFastMode(config, { model, input: "x", service_tier: "flex" }), false, model);
  assert.throws(() => claudeFastMode(config, { model: "claude-opus-5-5", input: "x", service_tier: "scale" }), /service tier/);
});

test("A Flex request runs Claude as Standard: the CLI gets no fast mode setting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-flex-"));
  const capture = join(directory, "argv.jsonl");
  // The fixture answers one stream-json turn and records the argv each CLI was started with.
  const script = `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';for await(const _ of process.stdin){}appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');
const out=value=>console.log(JSON.stringify(value));const event=value=>out({type:'stream_event',event:value});
out({type:'system',subtype:'init',fast_mode_state:'on'});event({type:'message_start',message:{id:'msg_1',usage:{input_tokens:1,output_tokens:1}}});
event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ok'}});
event({type:'content_block_stop',index:0});event({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}});event({type:'message_stop'});
out({type:'result',is_error:false,subtype:'success',result:'ok',fast_mode_state:'on',usage:{input_tokens:1,output_tokens:1}});\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = process.env.PATH; process.env.PATH = directory + delimiter + process.env.PATH;
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { opus: "claude-opus-5-5" }, modelMetadata: { opus: { serviceTiers: [claudeFastTier] } } });
    const run = async (request: Record<string, unknown>) => (await drain(adapter.infer({ model: "claude-opus-5-5", input: "x", ...request }, new AbortController().signal))).at(-1);
    // A Flex turn that even reports fast mode on still reports Standard, because the gateway never asked for it.
    assert.equal((await run({ service_tier: "flex" }) as { serviceTier?: string }).serviceTier, undefined);
    assert.equal((await run({ service_tier: "flex", reasoning: { effort: "high" } }) as { serviceTier?: string }).serviceTier, undefined);
    const [standard, withEffort] = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.equal(standard.includes("--settings"), false, "a Flex turn with no effort writes no settings at all");
    assert.deepEqual(JSON.parse(withEffort[withEffort.indexOf("--settings") + 1]), { alwaysThinkingEnabled: true }, "an effort's settings carry thinking only, never fastMode");
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(directory, { recursive: true, force: true }); }
});

test("Claude fast mode is enabled through settings and the served tier follows the CLI's state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-fast-"));
  const capture = join(directory, "argv.jsonl"); const state = join(directory, "state");
  // The fixture streams a text turn and reports the fast mode states written to `state` ("init result") on its init and
  // result lines, like the CLI: a refused or throttled fast request drops to standard speed with no line in between.
  const script = `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';for await(const _ of process.stdin){}appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');
const [init,result=init]=readFileSync(${JSON.stringify(state)},'utf8').split(' ');const out=value=>console.log(JSON.stringify(value));const event=value=>out({type:'stream_event',event:value});
out({type:'system',subtype:'init',fast_mode_state:init});event({type:'message_start',message:{id:'msg_1',usage:{input_tokens:1,output_tokens:1}}});
event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ok'}});
event({type:'content_block_stop',index:0});event({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}});event({type:'message_stop'});
out({type:'result',is_error:false,subtype:'success',result:'ok',fast_mode_state:result,usage:{input_tokens:1,output_tokens:1}});\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = process.env.PATH; process.env.PATH = directory + delimiter + process.env.PATH;
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { opus: "claude-opus-5-5" }, modelMetadata: { opus: { serviceTiers: [claudeFastTier] } } });
    const run = async (fastState: string, request: Record<string, unknown>) => { await writeFile(state, fastState); return (await drain(adapter.infer({ model: "claude-opus-5-5", input: "x", ...request }, new AbortController().signal))).at(-1); };
    assert.equal((await run("on", { service_tier: "priority", reasoning: { effort: "high" } }) as { serviceTier?: string }).serviceTier, "priority");
    assert.equal((await run("on cooldown", { service_tier: "priority" }) as { serviceTier?: string }).serviceTier, "default", "a fast turn that fell back after init reports Standard");
    assert.equal((await run("cooldown", { service_tier: "priority" }) as { serviceTier?: string }).serviceTier, "default", "a refused fast turn reports Standard");
    assert.equal((await run("off", {}) as { serviceTier?: string }).serviceTier, undefined);
    const [withEffort, fastOnly, , standard] = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.deepEqual(JSON.parse(withEffort[withEffort.indexOf("--settings") + 1]), { alwaysThinkingEnabled: true, fastMode: true });
    assert.deepEqual(JSON.parse(fastOnly[fastOnly.indexOf("--settings") + 1]), { fastMode: true });
    assert.equal(standard.includes("--settings"), false);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(directory, { recursive: true, force: true }); }
});

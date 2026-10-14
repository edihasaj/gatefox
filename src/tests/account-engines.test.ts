import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { object, type Message } from "../app-server-connection.js";
import { AccountEngines, accountEngineArgs, type AccountConnection } from "../account-engines.js";
import { acquireAccountLease, processStartedAt } from "../account-lease.js";
import { emailHash, identityPath, nativeIdentityPath } from "../account-login.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { accountDirectory, accountHomePath } from "../account-engine-home.js";
import { loadConfig } from "../config.js";

/** A throwaway home with a fake signed app-server that answers RPC and records every spawn. Nothing real is touched. */
async function fixture(spec: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gateway-engines-")));
  const state = join(root, "state"); const nativeHome = join(root, "native");
  await mkdir(state, { mode: 0o700 }); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(root, "fake.json"), JSON.stringify({ accounts: {}, ...spec }));
  const log = join(root, "calls.jsonl");
  const codex = join(root, "codex");
  await writeFile(codex, `#!/usr/bin/env node
const fs=require('node:fs');
const spec=JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "fake.json"))},'utf8'));
const a=process.argv.slice(2);
const provider=((a.find(x=>x.startsWith('model_provider='))||'').slice(15)).replace(/^"|"$/g,'');
const id=provider.replace(/^account_/,'');
const acct=spec.accounts[id]||{};
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({a,home:process.env.CODEX_HOME,rc:process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED,envKeys:Object.keys(process.env).filter(k=>/^(OPENAI_|CODEX_ACCESS_TOKEN|CODEX_AUTH)/.test(k))})+'\\n');
const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const models=acct.models||[{model:"gpt-6.1-sol",displayName:"GPT 6.1 Sol",supportedReasoningEfforts:[{reasoningEffort:"ultra",description:"u"}],serviceTiers:[{id:"priority"}],multiAgentVersion:"v2",inputModalities:["text"]}];
let threads=0;
require('node:readline').createInterface({input:process.stdin}).on('line',l=>{
  let m;try{m=JSON.parse(l);}catch{return;}
  if(m.id!==undefined&&m.method===undefined){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({reply:m})+'\\n');return;}
  if(m.method===undefined||m.id===undefined)return;
  const ok=r=>out({id:m.id,result:r});
  if(m.method==='initialize')return ok({userAgent:'fake'});
  if(m.method==='account/read')return ok(acct.notLoggedIn?{account:null}:{account:{type:'chatgpt',email:acct.email||'second@account.test',planType:'pro'}});
  if(m.method==='model/list'){const size=2;let page=0;if(typeof m.params?.cursor==='string')page=Number(m.params.cursor.split(':')[1]||0);
    const data=models.slice(page*size,page*size+size);const has=page*size+size<models.length;
    return ok({data,nextCursor:has?'p:'+(page+1):null,firstPageCursor:null});}
  if(m.method==='account/rateLimits/read')return ok({rateLimits:{},rateLimitsByLimitId:{codex:{limitId:'codex',limitName:'codex',primary:{usedPercent:42,windowDurationMins:300,resetsAt:1790000000},secondary:{usedPercent:8,windowDurationMins:10080},credits:{hasCredits:true,balance:'0.0'},planType:'pro',rateLimitReachedType:null,unauthorizedEmail:'x@secret.test'}},usedPercent:1,account:'hidden'});
  if(m.method==='thread/start'){threads++;return ok({modelProvider:'account_'+id,thread:{id:'t'+threads,modelProvider:'account_'+id,model:acct.slug||'gpt-6.1-sol'}});}
  if(m.method==='thread/delete')return ok({});
  if(m.method==='trigger/account-request'){
    out({id:'srv-9',method:'account/chatgptAuthTokens/refresh',params:{}});
    out({method:'account/updated',params:{}});
    out({method:'account/rateLimits/updated',params:{limitId:'codex',primary:{usedPercent:90,windowDurationMins:300,resetsAt:1790000099},credits:{hasCredits:true},planType:'pro',secret:'never-log'}});
    return ok({});}
  if(m.method==='trigger/crash'){ok({});setTimeout(()=>process.exit(3),10);return;}
  out({id:m.id,error:{code:-32601,message:'fake has no handler'}});
});
`, { mode: 0o700 }); await chmod(codex, 0o700);
  const config = { version: 1, port: 1, stateDirectory: state, providers: [{ id: "base", type: "claude-subscription", models: { "base/m": "m" } }],
    maxConcurrent: 4, timeoutMs: 60000, ...(extra.accountEngines ? { accountEngines: extra.accountEngines } : {}) } as GatewayConfig;
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Message);
  return { root, state, nativeHome, codex, config, calls, spec: async (value: Record<string, unknown>) => writeFile(join(root, "fake.json"), JSON.stringify({ accounts: {}, ...value })) };
}
const enginesFor = (f: Awaited<ReturnType<typeof fixture>>, options: Partial<import("../account-engines.js").AccountEngineOptions> = {}) =>
  new AccountEngines(f.config, { codex: f.codex, nativeHome: f.nativeHome, baseArgs: ["app-server", "--listen", "stdio://"],
    nativeRequest: async () => ({ config: {} }), version: "9.9.9", ...options });
const signIn = async (f: Awaited<ReturnType<typeof fixture>>, id: string, email = "second@account.test") => {
  await writePrivateJson(identityPath(f.state, id), { version: 1, emailSha256: emailHash(email) });
};
const settleStatus = async (engines: AccountEngines, id: string, want: (status: string) => boolean) => {
  for (let attempt = 0; attempt < 200; attempt++) { if (want(engines.status(id))) return engines.status(id); await new Promise(done => setTimeout(done, 10)); }
  return engines.status(id);
};

test("two accounts get separate engines, homes, leases and args; the native home is untouched", async () => {
  const f = await fixture({ accounts: { codex: { email: "second@account.test" }, codex3: { email: "third@account.test", models: [{ model: "gpt-6.1-terra", displayName: "Terra" }, { model: "gpt-6.1-sol", displayName: "Sol" }, { model: "gpt-6.1-cyber", displayName: "Cyber" }] } } },
    { accountEngines: [{ id: "codex", label: "Codex 2" }, { id: "codex3" }] });
  await signIn(f, "codex"); await signIn(f, "codex3", "third@account.test");
  await writePrivateJson(nativeIdentityPath(f.state), { version: 1, emailSha256: emailHash("main@account.test") });
  const engines = enginesFor(f);
  try {
    assert.equal(await engines.ensure("codex"), "ready");
    assert.equal(await engines.ensure("codex3"), "ready");
    const routes = engines.routes();
    assert.deepEqual([...routes.get("codex")!.slugs], ["gpt-6.1-sol"]);
    assert.deepEqual([...routes.get("codex3")!.slugs].sort(), ["gpt-6.1-cyber", "gpt-6.1-sol", "gpt-6.1-terra"]);
    assert.equal(engines.label("codex"), "Codex 2"); assert.equal(engines.label("codex3"), "codex3");
    const spawns = (await f.calls()).filter(call => Array.isArray(call.a));
    assert.equal(spawns.length, 2);
    for (const [id, home] of [["codex", accountHomePath(f.state, "codex")], ["codex3", accountHomePath(f.state, "codex3")]] as const) {
      const spawn = spawns.find(entry => entry.home === home);
      assert.ok(spawn, `spawn for ${id} with its own CODEX_HOME`);
      const joined = (spawn!.a as string[]).join(" ");
      assert.ok(joined.includes(`model_provider=${JSON.stringify(`account_${id}`)}`));
      assert.ok(joined.includes(`model_providers.account_${id}.base_url=${JSON.stringify("https://chatgpt.com/backend-api/codex")}`));
      assert.ok(joined.includes(`model_providers.account_${id}.wire_api=${JSON.stringify("responses")}`));
      assert.ok(joined.includes(`model_providers.account_${id}.requires_openai_auth=true`)); assert.ok(joined.includes(`model_providers.account_${id}.supports_websockets=true`));
      assert.ok(joined.includes("features.memories=false")); assert.ok(joined.includes('cli_auth_credentials_store="file"'));
      assert.ok(!joined.includes("model_catalog_json"));
      assert.equal(spawn!.rc, "1"); assert.deepEqual(spawn!.envKeys, []);
      assert.ok(await readFile(join(accountDirectory(f.state, id), "engine.lease"), "utf8"));
      const persisted = JSON.parse(await readFile(join(accountDirectory(f.state, id), "public-models.json"), "utf8"));
      assert.equal(persisted.version, 1); assert.ok(persisted.data.length >= 1);
    }
    assert.notEqual(accountHomePath(f.state, "codex"), accountHomePath(f.state, "codex3"));
    assert.ok((await readFile(join(f.nativeHome, "config.toml")).catch(() => "") + "").length === 0);
  } finally { await engines.stop(); }
  for (const id of ["codex", "codex3"]) await assert.rejects(readFile(join(accountDirectory(f.state, id), "engine.lease")), { code: "ENOENT" });
});

test("args strip profiles, never register the gateway chat provider, and keep the pinned workspace", () => {
  const args = accountEngineArgs(["app-server", "--listen", "stdio://", "-p", "work", "--profile", "old", "--profile=x"], "codex", "1.2.3", "ws_9").join(" ");
  assert.ok(!/(-p|--profile)/.test(args));
  assert.ok(args.includes('model_provider="account_codex"'));
  assert.ok(args.includes('model_providers.account_codex.http_headers.version="1.2.3"'));
  assert.ok(args.includes('forced_chatgpt_workspace_id="ws_9"'));
  assert.ok(args.includes("requires_openai_auth=true") && args.includes("supports_standalone_web_search=true"));
  assert.ok(!args.includes("subscription" + "_gateway"));
});

test("lazy start, health, and the idle reap restart the engine on the next chat", async () => {
  const f = await fixture({ accounts: { codex: {} } }, { accountEngines: [{ id: "codex" }] });
  await signIn(f, "codex");
  const engines = enginesFor(f, { idleTimeoutMs: 40 });
  try {
    assert.equal(engines.status("codex"), "idle"); assert.equal(engines.status("absent"), "not_configured");
    assert.equal(await engines.ensure("codex"), "ready");
    assert.ok(await engines.request("codex", "thread/start", {}));
    assert.equal(engines.threadOwner("t1"), "codex");
    // A bound thread keeps the engine alive past the idle window.
    await new Promise(done => setTimeout(done, 120));
    assert.equal(engines.status("codex"), "ready");
    await engines.request("codex", "thread/delete", { threadId: "t1" });
    assert.equal(await settleStatus(engines, "codex", status => status === "idle"), "idle");
    assert.equal(engines.threadOwner("t1"), undefined);
    assert.equal(await engines.ensure("codex"), "ready");
    assert.equal((await f.calls()).filter(call => Array.isArray(call.a)).length, 2);
    // A crashed child degrades to failed through the health check.
    await engines.request("codex", "trigger/crash", {}).catch(() => {});
    assert.equal(await settleStatus(engines, "codex", status => status === "failed" || status === "idle"), "failed");
    assert.equal(engines.engine("codex"), undefined);
  } finally { await engines.stop(); }
});

test("identity refusals: no login, a wrong saved identity, and account 1's email", async () => {
  const f = await fixture({ accounts: { codex: { email: "second@account.test" } } }, { accountEngines: [{ id: "codex" }] });
  const engines = enginesFor(f, { startBackoffMs: 0 });
  try {
    assert.equal(await engines.ensure("codex"), "not_logged_in"); // no identity.json yet
    await writePrivateJson(identityPath(f.state, "codex"), { version: 1, emailSha256: emailHash("someone-else@account.test") });
    assert.equal(await engines.ensure("codex"), "identity_mismatch");
    assert.match(String(await engines.request("codex", "thread/start", {}).catch((error: Error) => error.message)), /logout codex and gateway account login codex on this Mac/);
  } finally { await engines.stop(); }
  const f2 = await fixture({ accounts: { codex: { email: "main@account.test" } } }, { accountEngines: [{ id: "codex" }] });
  await writePrivateJson(identityPath(f2.state, "codex"), { version: 1, emailSha256: emailHash("main@account.test") });
  await writePrivateJson(nativeIdentityPath(f2.state), { version: 1, emailSha256: emailHash("main@account.test") });
  const sameAsNative = enginesFor(f2);
  try { assert.equal(await sameAsNative.ensure("codex"), "identity_mismatch"); } finally { await sameAsNative.stop(); }
  const f3 = await fixture({ accounts: { codex: { email: "main@account.test" } } }, { accountEngines: [{ id: "codex", workspaceId: "ws_2" }] });
  await writePrivateJson(identityPath(f3.state, "codex"), { version: 1, emailSha256: emailHash("main@account.test"), workspaceId: "ws_2" });
  await writePrivateJson(nativeIdentityPath(f3.state), { version: 1, emailSha256: emailHash("main@account.test") });
  const workspaceOnly = enginesFor(f3);
  try { assert.equal(await workspaceOnly.ensure("codex"), "ready"); } finally { await workspaceOnly.stop(); }
});

test("an account not logged in fails closed with an actionable -32001", async () => {
  const f = await fixture({ accounts: { codex: { notLoggedIn: true } } }, { accountEngines: [{ id: "codex" }] });
  await signIn(f, "codex");
  const engines = enginesFor(f, { startBackoffMs: 0 });
  try {
    assert.equal(await engines.ensure("codex"), "not_logged_in");
    await assert.rejects(engines.request("codex", "thread/start", {}), (error: Error & { code?: number }) => {
      assert.equal(error.code, -32001);
      assert.match(error.message, /Account codex is not signed in on this Mac\. Run gateway account login codex on this Mac/);
      return true;
    });
  } finally { await engines.stop(); }
});

test("a lease held by another live connection reports busy_elsewhere", async () => {
  const f = await fixture({ accounts: { codex: {} } }, { accountEngines: [{ id: "codex" }] });
  await signIn(f, "codex");
  await writePrivateJson(join(accountDirectory(f.state, "codex"), "engine.lease"),
    { version: 1, pid: process.pid, startedAt: processStartedAt(), acquiredAt: Date.now(), holder: "connection", nonce: "a".repeat(24) });
  const engines = enginesFor(f);
  try { assert.equal(await engines.ensure("codex"), "busy_elsewhere"); assert.equal((await f.calls()).filter(call => Array.isArray(call.a)).length, 0); }
  finally { await engines.stop(); }
});
test("an engine owned by a real lease elsewhere never starts a second process", async () => {
  const f = await fixture({ accounts: { codex: {} } }, { accountEngines: [{ id: "codex" }] });
  await signIn(f, "codex");
  const holder = await acquireAccountLease(f.state, "codex", "host");
  assert.ok(holder);
  const engines = enginesFor(f);
  try { assert.equal(await engines.ensure("codex"), "busy_elsewhere"); await holder(); }
  finally { await engines.stop(); }
});

test("account server requests get a local error; account notifications are dropped and the meter is captured", async () => {
  const f = await fixture({ accounts: { codex: {} } }, { accountEngines: [{ id: "codex" }] });
  await signIn(f, "codex");
  const forwarded: Array<{ id: string; message: Message }> = [];
  const engines = enginesFor(f, { forward: async (id, message) => { forwarded.push({ id, message }); } });
  try {
    assert.equal(await engines.ensure("codex"), "ready");
    await engines.request("codex", "trigger/account-request", {});
    await settleStatus(engines, "codex", () => true);
    await new Promise(done => setTimeout(done, 30));
    const replies = (await f.calls()).filter(call => call.reply) as Array<{ reply: Message }>;
    const refused = replies.find(entry => (entry.reply as Message).id === "srv-9");
    assert.ok(refused);
    assert.equal(object(object(refused!.reply).error).code, -32601);
    assert.equal(forwarded.filter(entry => entry.message.method === "account/updated").length, 0);
    assert.equal(forwarded.filter(entry => String(entry.message.method).startsWith("account/")).length, 0);
    const usage = JSON.parse(await readFile(join(accountDirectory(f.state, "codex"), "usage.json"), "utf8"));
    const serialized = JSON.stringify(usage);
    assert.equal(usage.version, 1); assert.ok(serialized.includes("\"90\"") || serialized.includes("90"));
    assert.ok(!/never-log|secret|hasCredits|pro/.test(serialized));
    const snapshot = await engines.usage("codex");
    assert.ok(snapshot && snapshot.limits.some(limit => limit.limitId === "codex" && limit.primary?.usedPercent === 42));
    assert.ok(!JSON.stringify(snapshot).includes("x@secret.test"));
  } finally { await engines.stop(); }
  const persisted = await engines.usage("codex");
  assert.equal(persisted?.id, "codex"); assert.equal(persisted?.label, "codex");
});

test("a stopped engine answers usage from the persisted snapshot only while it is fresh", async () => {
  const f = await fixture({ accounts: { codex: {} } }, { accountEngines: [{ id: "codex" }] });
  await signIn(f, "codex");
  const engines = enginesFor(f);
  await engines.stop();
  const directory = accountDirectory(f.state, "codex");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writePrivateJson(join(directory, "usage.json"), { version: 1, observedAt: Math.floor(Date.now() / 1000) - 60, limits: [{ limitId: "codex", primary: { usedPercent: 7 } }] });
  const restored = await engines.usage("codex");
  assert.deepEqual(restored?.limits.map(limit => limit.limitId), ["codex"]);
  assert.equal(restored?.label, "codex");
  await writePrivateJson(join(directory, "usage.json"), { version: 1, observedAt: Math.floor(Date.now() / 1000) - 87000, limits: [] });
  assert.equal(await engines.usage("codex"), undefined);
});

test("recordNativeIdentity stores only a hash and rewrites it only on change", async () => {
  const f = await fixture();
  const engines = enginesFor(f);
  let value: Message = { account: { type: "chatgpt", email: " Main@Account.test " } };
  await engines.recordNativeIdentity(async () => value);
  const first = JSON.parse(await readFile(nativeIdentityPath(f.state), "utf8"));
  assert.deepEqual(first, { version: 1, emailSha256: emailHash("main@account.test") });
  await engines.recordNativeIdentity(async () => { throw new Error("account/read failed"); });
  assert.deepEqual(JSON.parse(await readFile(nativeIdentityPath(f.state), "utf8")), first);
  value = { account: { type: "chatgpt", email: "other@account.test" } };
  await engines.recordNativeIdentity(async () => value);
  assert.equal(JSON.parse(await readFile(nativeIdentityPath(f.state), "utf8")).emailSha256, emailHash("other@account.test"));
  await engines.stop();
});

test("the gateway's own build is refused and a socket host is preferred when present", async () => {
  const f = await fixture({ accounts: { codex: {} } }, { accountEngines: [{ id: "codex" }] });
  await signIn(f, "codex");
  const gatewaySdk = enginesFor(f, { codex: join(f.root, "gateway-sdk", "gateway-codex") });
  try { assert.equal(await gatewaySdk.ensure("codex"), "failed"); } finally { await gatewaySdk.stop(); }
  const injected = enginesFor(f, {
    spawn: () => { throw new Error("must not spawn when the host owns the engine"); },
  });
  // The host seam only activates once A3 ships account-engine-host.js; with it absent the lease path runs.
  const status = await injected.ensure("codex").catch(() => "failed" as const);
  assert.ok(["busy_elsewhere", "failed"].includes(status));
  await injected.stop();
});

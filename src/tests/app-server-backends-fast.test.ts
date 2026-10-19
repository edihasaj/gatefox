import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppServerBackends } from "../app-server-backends.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { modelCatalog } from "../catalog.js";
import { shimFiles } from "./shim-fixture.js";

async function fixture(priority: boolean) {
  const f = await shimFiles();
  const nativeConfig = 'model = "native"\n[features]\nfast_mode = false\n';
  await writeFile(join(f.nativeHome, "config.toml"), nativeConfig, { mode: 0o600 });
  await writeFile(join(f.nativeHome, "agent-policy.json"), JSON.stringify({ features: { fast_mode: false } }), { mode: 0o600 });
  if (priority) f.value.providers[0].modelMetadata = { "claude/model": { serviceTiers: [{ id: "priority", name: "Fast", description: "Priority route" }], defaultServiceTier: null } };
  f.setCatalog(modelCatalog(f.value));
  let source = await readFile(f.backend, "utf8");
  source = source.replace("const send=m=>", `for(let i=0;i<process.argv.length;i++)if((process.argv[i]==='--enable'||process.argv[i]==='--disable')&&process.argv[i+1]==='fast_mode'){overrides['features.fast_mode']=process.argv[i]==='--enable';i++;}
const send=m=>`)
    .replace("if(m.method==='model/list')", `if(m.method==='factory/info')send({id:m.id,result:{fastMode:overrides['features.fast_mode']??false,stepModelSwitching:overrides['features.step_model_switching']===true}});
 else if(m.method==='turn/start'&&m.params.factoryProbe)send({id:m.id,result:{wireServiceTier:overrides['features.fast_mode']===true?m.params.serviceTier??null:null,effort:m.params.effort,approvalPolicy:m.params.approvalPolicy,sandboxPolicy:m.params.sandboxPolicy}});
 else if(m.method==='model/list')`);
  await writeFile(f.backend, source, { mode: 0o700 });
  const catalog = new DesktopCatalog(f.value, [{ slug: "native" }], join(f.directory, "desktop.json"));
  const backend = new AppServerBackends(f.backend, ["app-server", "--listen", "stdio://", "-c", "features.fast_mode=false", "--disable", "fast_mode"], f.value, { features: { fast_mode: false }, service_tier: null }, {}, catalog, async () => {}, () => {});
  await backend.request("initialize", { clientInfo: { name: "fast-mode-fixture", version: "1" } }); backend.notify({ method: "initialized" });
  return { ...f, nativeConfig, backend, async clean() { await backend.stop(); f.close(); } };
}

test("per-connection priority executors enable fast mode without changing native flags, standard default or request controls", { timeout: 10000 }, async () => {
  const f = await fixture(true);
  try {
    assert.deepEqual(await f.backend.native.request("factory/info", {}), { fastMode: false, stepModelSwitching: false });
    const started = await f.backend.request("thread/start", { model: "claude/model", modelProvider: "subscription_gateway" }, { engine: "gateway" });
    const id = (started.thread as { id: string }).id;
    assert.equal(started.serviceTier, null);
    assert.deepEqual(await f.backend.request("factory/info", { threadId: id }), { fastMode: true, stepModelSwitching: true });
    const request = { threadId: id, factoryProbe: true, serviceTier: "priority", effort: "max", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } };
    assert.deepEqual(await f.backend.request("turn/start", request), { wireServiceTier: "priority", effort: "max", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
    assert.equal((await f.backend.request("turn/start", { ...request, serviceTier: null })).wireServiceTier, null);
    assert.deepEqual(await f.backend.native.request("factory/info", {}), { fastMode: false, stepModelSwitching: false });
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), f.nativeConfig);
  } finally { await f.clean(); }
});

test("per-connection executors without declared priority preserve fast-mode disabling", { timeout: 10000 }, async () => {
  const f = await fixture(false);
  try {
    const started = await f.backend.request("thread/start", { model: "claude/model", modelProvider: "subscription_gateway" }, { engine: "gateway" });
    const id = (started.thread as { id: string }).id;
    assert.equal(started.serviceTier, null);
    assert.deepEqual(await f.backend.request("factory/info", { threadId: id }), { fastMode: false, stepModelSwitching: true });
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), f.nativeConfig);
  } finally { await f.clean(); }
});

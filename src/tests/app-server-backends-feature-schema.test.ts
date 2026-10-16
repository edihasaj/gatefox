import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { AppServerBackends } from "../app-server-backends.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { modelCatalog } from "../catalog.js";
import { shimFiles } from "./shim-fixture.js";
import { join } from "node:path";

const table = { "features.async_compaction": { enabled: true, threshold: 3 } };

async function fixture() {
  const f = await shimFiles();
  f.setCatalog(modelCatalog(f.value));
  // The fake engine remembers the last thread config and the -c overrides it was started with.
  const source = (await readFile(f.backend, "utf8")).replace("if(m.method==='model/list')", `if(m.params&&m.params.config)globalThis.lastConfig=m.params.config;
 if(m.method==='probe/features')send({id:m.id,result:{config:globalThis.lastConfig??null,overrides}});
 else if(m.method==='model/list')`);
  await writeFile(f.backend, source, { mode: 0o700 });
  const catalog = new DesktopCatalog(f.value, [{ slug: "native" }], join(f.directory, "desktop.json"));
  const args = ["app-server", "--listen", "stdio://", "-c", 'features.async_compaction={"enabled":true}'];
  const backend = new AppServerBackends(f.backend, args, f.value, {}, {}, catalog, async () => {}, () => {});
  await backend.request("initialize", { clientInfo: { name: "feature-schema-fixture", version: "1" } }); backend.notify({ method: "initialized" });
  return { ...f, backend, async clean() { await backend.stop(); f.close(); } };
}

test("a gateway chat's resume config is trimmed to the pinned SDK schema before it reaches the gateway engine", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const started = await f.backend.request("thread/start", { model: "claude/model", modelProvider: "subscription_gateway" });
    const id = (started.thread as { id: string }).id;
    await f.backend.request("thread/resume", { threadId: id, config: table });
    const seen = await f.backend.request("probe/features", { threadId: id });
    assert.deepEqual(seen.config, { "features.async_compaction": true });
    // The desktop's launch flag is trimmed for the gateway SDK only.
    assert.equal((seen.overrides as Record<string, unknown>)["features.async_compaction"], true);
  } finally { await f.clean(); }
});

test("a native chat's resume config and the native launch flags reach the native engine unchanged", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const started = await f.backend.request("thread/start", { model: "native" });
    const id = (started.thread as { id: string }).id;
    await f.backend.request("thread/resume", { threadId: id, config: table });
    const seen = await f.backend.native.request("probe/features", {});
    assert.deepEqual(seen.config, table);
    assert.deepEqual((seen.overrides as Record<string, unknown>)["features.async_compaction"], { enabled: true });
  } finally { await f.clean(); }
});

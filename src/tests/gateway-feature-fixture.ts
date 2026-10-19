import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppServerBackends } from "../app-server-backends.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { modelCatalog } from "../catalog.js";
import { shimFiles } from "./shim-fixture.js";

/**
 * The engine hook added to the fake SDK shared by the feature tests. Every thread request with a `config` is logged
 * (`probe/log`), `probe/features` returns the last config and the `-c` overrides the engine started with, and the
 * config key `fail.mode` makes a request fail:
 * - `always`: every call fails with the SDK's configuration error, numbered by call (`attempt 1`, `attempt 2`).
 * - `until-boolean`: fails while any `features` value is not a boolean, like the SDK does for a table it does not know.
 * - `other`: fails with an unrelated -32600 error.
 * - `wrong-code`: fails with the configuration message but another code.
 * - `other-path`: fails with the configuration error for a path that is not a feature path.
 * - `cloud`: fails with the configuration error marked as an unavailable cloud configuration bundle.
 */
const hook = `if(m.params&&m.params.config)globalThis.lastConfig=m.params.config;
 if(['thread/start','thread/resume','thread/fork'].includes(m.method)&&m.params&&m.params.config){
  (globalThis.log??=[]).push({method:m.method,config:m.params.config});
  const c=m.params.config;const mode=c['fail.mode'];
  const nonBoolean=Object.entries(c).some(([k,v])=>k==='features'?(v&&typeof v==='object'&&Object.values(v).some(x=>typeof x!=='boolean')):k.startsWith('features.')&&typeof v!=='boolean');
  const failure='failed to load configuration: attempt '+globalThis.log.length;
  if(mode==='always'||(mode==='until-boolean'&&nonBoolean)){send({id:m.id,error:{code:-32600,message:failure+'\\nin \`features\`\\n'}});return;}
  if(mode==='other'){send({id:m.id,error:{code:-32600,message:'Unknown fixture thread'}});return;}
  if(mode==='wrong-code'){send({id:m.id,error:{code:-32000,message:failure+'\\nin \`features\`\\n'}});return;}
  if(mode==='other-path'){send({id:m.id,error:{code:-32600,message:failure+'\\nin \`model_providers\`\\n'}});return;}
  if(mode==='cloud'){send({id:m.id,error:{code:-32600,message:failure+'\\nin \`features\`\\n',data:{reason:'cloudConfigBundle'}}});return;}
 }
 if(m.method==='probe/log'){send({id:m.id,result:{log:globalThis.log??[]}});return;}
 if(m.method==='probe/features'){send({id:m.id,result:{config:globalThis.lastConfig??null,overrides}});return;}
 `;

export async function featureFixture(args = ["app-server", "--listen", "stdio://", "-c", 'features.async_compaction={"enabled":true}'], settings: Record<string, unknown> = {}) {
  const f = await shimFiles();
  f.setCatalog(modelCatalog(f.value));
  const source = (await readFile(f.backend, "utf8")).replace("if(m.method==='model/list')", hook + "if(m.method==='model/list')");
  await writeFile(f.backend, source, { mode: 0o700 });
  const catalog = new DesktopCatalog(f.value, [{ slug: "native" }], join(f.directory, "desktop.json"));
  const backend = new AppServerBackends(f.backend, args, f.value, settings, {}, catalog, async () => {}, () => {});
  await backend.request("initialize", { clientInfo: { name: "feature-schema-fixture", version: "1" } }); backend.notify({ method: "initialized" });
  return { ...f, backend, catalog, async clean() { await backend.stop(); f.close(); } };
}

/** Start a gateway chat and return its id. */
export async function startGatewayChat(backend: AppServerBackends): Promise<string> {
  const started = await backend.request("thread/start", { model: "claude/model", modelProvider: "subscription_gateway" }, { engine: "gateway" });
  return (started.thread as { id: string }).id;
}

interface EngineView { requests: number; threads: Set<string>; compaction?: { before: (...args: unknown[]) => Promise<unknown>; after: (...args: unknown[]) => Promise<unknown> } }
/** The loaded gateway engine that owns a chat, for counter assertions. */
export function engineOf(backend: AppServerBackends, id: string): EngineView {
  const engine = (backend as unknown as { engines: EngineView[] }).engines.find(value => value.threads.has(id));
  if (!engine) throw new Error("No gateway engine holds this chat");
  return engine;
}

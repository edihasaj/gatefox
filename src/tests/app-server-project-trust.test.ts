import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { object, type Message } from "../app-server-connection.js";
import type { NativeRpcConnection } from "../shared-native-connection.js";

async function fixture(trustAllProjects?: boolean) {
  const root = await mkdtemp(join(tmpdir(), "gw-project-trust-"));
  const calls: Array<{ method: string; params: Message }> = [];
  const projects: Record<string, Message> = {};
  const config: Message = { projects, approval_policy: "on-request", sandbox_mode: "read-only" };
  let revision = 0;
  let finish!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const native: NativeRpcConnection = {
    closed: false, drained: Promise.resolve(), exited: new Promise(resolve => { finish = resolve; }),
    send() {}, stop() { finish({ code: 0, signal: null }); },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "config/read") return structuredClone({ config, layers: [{ name: { type: "user", file: join(root, "config.toml") }, version: String(revision), config }] });
      if (method === "project/list") return { data: [{ roots: [{ path: join(root, "registered") }] }], nextCursor: null };
      if (method === "config/batchWrite") {
        assert.equal(params.expectedVersion, String(revision));
        for (const edit of params.edits as Message[]) {
          const key = String(edit.keyPath);
          const path = JSON.parse(key.slice("projects.".length, -".trust_level".length)) as string;
          projects[path] = { ...projects[path], trust_level: edit.value };
        }
        revision++; return { status: "ok" };
      }
      if (method === "thread/start") return { thread: { id: "fixture-chat", cwd: params.cwd }, modelProvider: "openai" };
      return {};
    },
  };
  const catalog = { current: () => ({ models: [], revision: "fixture" }), nativeSlugs: new Set() } as unknown as DesktopCatalog;
  const adapter = new AppServerBackends("unused", [], { version: 1, port: 1234, clientOnly: true, providers: [], stateDirectory: join(root, "state"), trustAllProjects }, {}, {}, catalog, async () => {}, () => {}, undefined, () => native);
  return { adapter, root, calls, config, projects, async close() { await adapter.stop(); await rm(root, { recursive: true, force: true }); } };
}

for (const enabled of [undefined, false]) test(`backend keeps project trust native when opt-in is ${enabled}`, async () => {
  const f = await fixture(enabled);
  try {
    const params = { cwd: join(f.root, "new-folder"), includeLayers: true };
    const result = await f.adapter.request("config/read", params);
    assert.deepEqual(result.config, f.config);
    assert.deepEqual(f.calls, [{ method: "config/read", params }]);
    assert.deepEqual(f.projects, {});
  } finally { await f.close(); }
});

test("opted-in backend persists registered and newly requested roots through its real native RPC boundary", async () => {
  const f = await fixture(true);
  try {
    const cwd = join(f.root, "brand-new-folder");
    const result = await f.adapter.request("config/read", { cwd, includeLayers: true });
    assert.deepEqual(object(result.config).projects, {
      [join(f.root, "registered")]: { trust_level: "trusted" }, [cwd]: { trust_level: "trusted" },
    });
    assert.deepEqual(object(result.config).projects, object((result.layers as Message[])[0].config).projects);
    const start = { cwd: join(f.root, "another-new-folder"), approvalPolicy: "on-request", sandbox: "read-only" };
    await f.adapter.request("thread/start", start);
    assert.deepEqual(f.calls.find(c => c.method === "thread/start")?.params, start);
    assert.equal(f.projects[String(start.cwd)].trust_level, "trusted");
    assert.equal(f.config.approval_policy, "on-request");
    assert.equal(f.config.sandbox_mode, "read-only");
    assert(f.calls.some(c => c.method === "config/batchWrite"));
  } finally { await f.close(); }
});

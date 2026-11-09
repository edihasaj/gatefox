import test from "node:test";
import assert from "node:assert/strict";
import { gatewayCommand } from "../command.js";
import { nativeProviderRow, providerOverrides, publishNativeProvider, withdrawNativeProvider, type NativeProviderDeps } from "../native-provider-row.js";
import { uninstallResult } from "../uninstall.js";

type Edit = { keyPath: string; value: unknown };

/** A native configuration that applies batch writes the way the engine does for these dotted keys. */
function nativeConfig(initial: Record<string, unknown> = {}, options: { failOpen?: boolean } = {}) {
  const state = { config: structuredClone(initial), version: "v1", writes: [] as Edit[], opened: 0, closed: 0 };
  const deps: NativeProviderDeps = {
    nativeHome: () => "/home/.codex",
    open: async () => {
      state.opened++;
      if (options.failOpen) throw new Error("engine unavailable");
      return {
        read: async () => ({ version: state.version, config: structuredClone(state.config), file: "/home/.codex/config.toml" }),
        write: async (edits: Edit[], expected: string) => {
          assert.equal(expected, state.version, "writes against the version it read");
          for (const edit of edits) {
            state.writes.push(edit);
            const [table, id] = edit.keyPath.split(".");
            const providers = { ...(state.config[table!] as Record<string, unknown> | undefined) };
            if (edit.value === null) delete providers[id!]; else providers[id!] = edit.value;
            state.config[table!] = providers;
          }
          state.version = "v" + (Number(state.version.slice(1)) + 1);
        },
        close: async () => { state.closed++; },
      };
    },
  };
  return { state, deps };
}

test("the published row is exactly the provider the adapter registers with -c", () => {
  const row = nativeProviderRow(3457, "/state/gateway.json");
  const helper = gatewayCommand();
  assert.deepEqual(providerOverrides(row), {
    name: "GateFox", base_url: "http://127.0.0.1:3457/v1", wire_api: "responses", requires_openai_auth: false,
    supports_websockets: false, request_max_retries: 2, stream_idle_timeout_ms: 90000,
    "auth.command": helper.command, "auth.args": [...helper.args, "token", "--config", "/state/gateway.json"], "auth.timeout_ms": 15000, "auth.refresh_interval_ms": 300000,
  });
});

test("registration publishes the gateway row so saved gateway chats open in any engine, and keeps other providers", async () => {
  const { state, deps } = nativeConfig({ model_provider: "openai", model_providers: { openrouter: { name: "OpenRouter" } } });
  assert.equal(await publishNativeProvider(3457, "/state/gateway.json", "/Applications/ChatGPT.app", deps), "written");
  const providers = state.config.model_providers as Record<string, unknown>;
  // One row under each gateway id: `gatefox` for chats since 1.8.0, `subscription_gateway` for older ones.
  assert.deepEqual(providers.gatefox, nativeProviderRow(3457, "/state/gateway.json"));
  assert.deepEqual(providers.subscription_gateway, nativeProviderRow(3457, "/state/gateway.json"));
  assert.deepEqual(providers.openrouter, { name: "OpenRouter" });
  assert.equal(state.config.model_provider, "openai", "new native chats keep their own provider");
  assert.deepEqual(state.writes.map(edit => edit.keyPath), ["model_providers.gatefox", "model_providers.subscription_gateway"], "only the rows are written");
  assert.equal(state.closed, state.opened, "the engine is always closed");
});

test("a current row is not rewritten, and a changed port or config path refreshes it", async () => {
  const current = nativeProviderRow(3457, "/state/gateway.json");
  const { state, deps } = nativeConfig({ model_providers: { gatefox: current, subscription_gateway: current } });
  assert.equal(await publishNativeProvider(3457, "/state/gateway.json", "/app", deps), "current");
  assert.equal(state.writes.length, 0);
  assert.equal(await publishNativeProvider(3460, "/state/gateway.json", "/app", deps), "written");
  for (const id of ["gatefox", "subscription_gateway"]) assert.equal((state.config.model_providers as Record<string, { base_url: string }>)[id]!.base_url, "http://127.0.0.1:3460/v1");
  // A Mac upgraded from 1.7.x holds only the old row: the publish adds the `gatefox` one and leaves the current row alone.
  const upgraded = nativeConfig({ model_providers: { subscription_gateway: { ...current, name: "Harness Gateway" } } });
  assert.equal(await publishNativeProvider(3457, "/state/gateway.json", "/app", upgraded.deps), "written");
  assert.deepEqual((upgraded.state.config.model_providers as Record<string, unknown>).gatefox, current);
  assert.deepEqual((upgraded.state.config.model_providers as Record<string, unknown>).subscription_gateway, current, "an old Harness Gateway row is the gateway's own and is refreshed");
});

test("a row of the same id that the gateway did not write is left alone", async () => {
  const foreign = { name: "Someone else", base_url: "https://example.test/v1" };
  const { state, deps } = nativeConfig({ model_providers: { subscription_gateway: foreign } });
  assert.equal(await publishNativeProvider(3457, "/state/gateway.json", "/app", deps), "foreign");
  assert.equal(await withdrawNativeProvider("/app", deps), "foreign");
  assert.equal(state.writes.length, 0);
  assert.deepEqual((state.config.model_providers as Record<string, unknown>).subscription_gateway, foreign);
  // A foreign row under the new id stops the publish too, so the two ids never point at different gateways.
  const other = nativeConfig({ model_providers: { gatefox: foreign } });
  assert.equal(await publishNativeProvider(3457, "/state/gateway.json", "/app", other.deps), "foreign");
  assert.equal(other.state.writes.length, 0);
});

test("an unavailable engine or a missing port never fails registration", async () => {
  const { deps } = nativeConfig({}, { failOpen: true });
  assert.equal(await publishNativeProvider(3457, "/state/gateway.json", "/app", deps), "failed");
  const untouched = nativeConfig();
  assert.equal(await publishNativeProvider(undefined, "/state/gateway.json", "/app", untouched.deps), "skipped");
  assert.equal(untouched.state.opened, 0);
});

test("uninstall removes only the gateway's own row and reports it", async () => {
  const row = nativeProviderRow(3457, "/state/gateway.json");
  const { state, deps } = nativeConfig({ model_providers: { gatefox: row, subscription_gateway: row, openrouter: { name: "OpenRouter" } } });
  assert.equal(await withdrawNativeProvider("/app", deps), "removed");
  assert.deepEqual(state.config.model_providers, { openrouter: { name: "OpenRouter" } });
  assert.equal(await withdrawNativeProvider("/app", deps), "absent");
  assert.deepEqual(uninstallResult({}, "removed"), { uninstalled: true, installationMovedToTrash: true, credentialsPreserved: true, nativeConfigUntouched: false, nativeProvider: "removed" });
  assert.equal(uninstallResult({}).nativeConfigUntouched, true);
});

test("desktop registration publishes the row after setting the launch path, and reports what it did", { skip: process.platform !== "darwin" }, async () => {
  const { macDesktop } = await import("../mac-desktop.js");
  const { desktopFixture, inDesktopHome } = await import("./desktop-fixture.js");
  const { loadConfig } = await import("../config.js");
  const f = await desktopFixture("native-provider-row");
  await inDesktopHome(f, async () => {
    const calls: Array<[number | undefined, string, string]> = [];
    const order: string[] = [];
    const exec: typeof f.exec = async (file, args) => { if (args[0] === "setenv") order.push("setenv"); return await f.exec(file, args); };
    const result = await macDesktop("register", f.config, f.app, false, exec, async (port, configPath, app) => { order.push("publish"); calls.push([port, configPath, app]); return "written"; });
    assert.deepEqual(calls, [[(await loadConfig(f.config)).port, f.config, f.app]]);
    assert.ok(order.includes("setenv") && order.lastIndexOf("setenv") < order.indexOf("publish"), "the launch path is set first");
    assert.equal(result.nativeProvider, "written");
    assert.equal(result.nativeConfigUntouched, false);
    const again = await macDesktop("register", f.config, f.app, true, exec, async () => "current");
    assert.equal(again.nativeProvider, "current");
    assert.equal(again.nativeConfigUntouched, true);
  });
});

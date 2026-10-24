import assert from "node:assert/strict";
import test from "node:test";
import { hostAutoLatestMaintenance, type MaintenanceHostDependencies } from "../model-auto-latest/hosting.js";
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const state = { failure: true, starts: [] as string[], stops: 0, cancelled: 0, retry: undefined as (() => void) | undefined };
  const deps: MaintenanceHostDependencies = { retire: async () => state.failure ? { scheduled: false, reason: "launchctl_failed" } : { scheduled: false },
    start: (_path, owner) => { state.starts.push(owner); return { stop: async () => { state.stops++; } }; },
    retry: run => { state.retry = run; return () => { state.cancelled++; state.retry = undefined; }; } };
  return { state, deps };
}
test("a failed legacy cleanup retries in the same runtime and later starts exactly one maintenance owner", async () => {
  const f = fixture(); const host = hostAutoLatestMaintenance("/fixture.json", "server", f.deps); await settle();
  assert.deepEqual(f.state.starts, []); assert.ok(f.state.retry);
  f.state.failure = false; f.state.retry!(); await settle(); assert.deepEqual(f.state.starts, ["server"]);
  f.state.retry!(); await settle(); assert.deepEqual(f.state.starts, ["server"]);
  await host.stop(); assert.equal(f.state.stops, 1);
});
test("stopping while cleanup is in flight never starts a late owner or retry", async () => {
  const f = fixture(); let release!: () => void;
  f.deps.retire = () => new Promise(resolve => { release = () => resolve({ scheduled: false }); });
  const host = hostAutoLatestMaintenance("/fixture.json", "service", f.deps); const stopping = host.stop(); release(); await stopping; await settle();
  assert.deepEqual(f.state.starts, []); assert.equal(f.state.retry, undefined);
});
test("stopping cancels a pending cleanup retry", async () => {
  const f = fixture(); const host = hostAutoLatestMaintenance("/fixture.json", "service", f.deps); await settle();
  await host.stop(); assert.equal(f.state.retry, undefined); assert.equal(f.state.cancelled, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { resolveManagedRequest } from "../server-managed-routing.js";
import { AvailabilityService } from "../availability/service.js";
import { ManagedRouter } from "../managed-routing.js";
import { managedFixture, managedRequest } from "./managed-routing-fixture.js";

test("cancellation interrupts managed availability waiting before any route pin or provider call", async () => {
  const controller = new AbortController();
  const availability = new AvailabilityService({ probe: () => new Promise(() => {}), accountEmail: async () => undefined, balance: async () => undefined });
  const config = managedFixture("/unused");
  let reports = 0;
  const pending = resolveManagedRequest({ config, request: managedRequest(), context: { threadId: "cancelled" },
    router: new ManagedRouter("/unused"), availability, signal: controller.signal, report: () => { reports++; return {}; } });
  controller.abort(new Error("cancelled managed selection"));
  try { await assert.rejects(pending, /cancelled managed selection/); assert.equal(reports, 0); } finally { availability.stop(); }
});
test("fixed aliases never start managed availability collection", async () => {
  const availability = new AvailabilityService();
  const result = await resolveManagedRequest({ config: managedFixture("/unused"), request: { ...managedRequest(), model: "sub/sol" }, context: {},
    router: new ManagedRouter("/unused"), availability, signal: new AbortController().signal, report: () => { throw Error("unexpected report"); } });
  assert.equal(result, undefined); assert.equal(availability.collecting, false);
});
test("inherited object property names are ordinary missing aliases, not managed routes", async () => {
  const availability = new AvailabilityService();
  for (const model of ["constructor", "toString", "__proto__"]) {
    const result = await resolveManagedRequest({ config: managedFixture("/unused"), request: { ...managedRequest(), model }, context: {},
      router: new ManagedRouter("/unused"), availability, signal: new AbortController().signal, report: () => { throw Error("unexpected report"); } });
    assert.equal(result, undefined);
    assert.equal(await new ManagedRouter("/unused").resolve(managedFixture("/unused"), { ...managedRequest(), model }, {}, {}), undefined);
  }
  assert.equal(availability.collecting, false);
});

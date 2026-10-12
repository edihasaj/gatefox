import test from "node:test";
import assert from "node:assert/strict";
import { ensureLaunchAgent } from "../mac-launch-agent.js";
import { tunnelArguments } from "../mac-tunnel.js";

function launchdFixture(disabled: boolean, loaded: boolean) {
  const state = { disabled, loaded, pid: loaded ? 1234 : undefined as number | undefined, launches: loaded ? 1 : 0 };
  const run = async (args: string[]) => {
    if (args[0] === "enable") state.disabled = false;
    else if (args[0] === "bootstrap") {
      if (state.disabled) throw new Error("launchd refuses disabled jobs");
      if (state.loaded) throw new Error("launchd refuses duplicate registrations");
      state.loaded = true; state.pid = 2345; state.launches++;
    } else throw new Error("The fixture rejects stopping or replacing a live job");
  };
  return { state, run };
}

test("explicit registration recovers persisted disabled jobs before bootstrap", async () => {
  const fixture = launchdFixture(true, false);
  await ensureLaunchAgent("gui/501", "com.edihasaj.subscription-gateway.tunnel.fixture", "/private/fixture.plist", false, fixture.run);
  assert.equal(fixture.state.disabled, false); assert.equal(fixture.state.loaded, true); assert.equal(fixture.state.launches, 1);
});

test("enabling an already loaded registration preserves its process and avoids duplicate bootstrap", async () => {
  const fixture = launchdFixture(true, true); const pid = fixture.state.pid;
  await ensureLaunchAgent("gui/501", "com.edihasaj.subscription-gateway.desktop", "/private/fixture.plist", true, fixture.run);
  assert.equal(fixture.state.disabled, false); assert.equal(fixture.state.pid, pid); assert.equal(fixture.state.launches, 1);
});

test("an enable failure never attempts to start an unauthorized job", async () => {
  const fixture = launchdFixture(true, false);
  await assert.rejects(ensureLaunchAgent("gui/501", "com.edihasaj.subscription-gateway.tunnel.fixture", "/private/fixture.plist", false, async args => {
    if (args[0] === "enable") throw new Error("launchd refused authorization"); return fixture.run(args);
  }), /refused authorization/);
  assert.equal(fixture.state.loaded, false); assert.equal(fixture.state.launches, 0);
});

test("new tunnel jobs bound initial network attempts and retain loopback-only forwarding", () => {
  const args = tunnelArguments({ id: "fixture", host: "user@host", port: 3459, remotePort: 3457, reverse: true });
  const options = args.flatMap((arg, index) => arg === "-o" ? [args[index + 1]] : []);
  assert.ok(options.includes("ConnectTimeout=10")); assert.ok(options.includes("ConnectionAttempts=1"));
  assert.equal(args[args.indexOf("-R") + 1], "127.0.0.1:3459:127.0.0.1:3457");
  assert.ok(options.includes("ExitOnForwardFailure=yes")); assert.ok(options.includes("ServerAliveInterval=15")); assert.ok(options.includes("ServerAliveCountMax=3"));
});

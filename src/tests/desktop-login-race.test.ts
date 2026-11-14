import test from "node:test";
import assert from "node:assert/strict";
import { etimeSeconds, recoverDesktopLoginRace, type LoginRaceDeps } from "../desktop-login-race.js";

const app = "/Applications/ChatGPT.app";
const main = `${app}/Contents/MacOS/ChatGPT`;
const stock = `${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled`;
const shim = "/Users/u/.local/share/gatefox/app-runtime/bin/node /Users/u/.local/share/gatefox/current/package/dist/cli.js codex-shim --config /x -- app-server";

function fake(rows: string, ages: string, options: { quits?: boolean } = {}) {
  const calls: string[] = []; let running = true;
  const deps: LoginRaceDeps = {
    exec: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "/bin/ps") return args[0] === "-axo" ? rows : ages;
      return "";
    },
    kill: (pid, signal) => {
      if (signal === 0) { if (!running) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return; }
      calls.push(`kill ${pid} ${signal}`); if (options.quits !== false) running = false;
    },
    sleep: async () => {},
  };
  return { deps, calls };
}

test("etime values parse in every ps form", () => {
  assert.equal(etimeSeconds("00:13"), 13);
  assert.equal(etimeSeconds("01:02:03"), 3723);
  assert.equal(etimeSeconds("2-00:00:01"), 172801);
  assert.equal(etimeSeconds("soon"), undefined);
});

test("a brand-new ChatGPT on its stock engine is quit normally and reopened through the gateway", async () => {
  const f = fake(`100 1 ${main}\n101 100 ${stock}\n`, "100 00:13\n101 00:11\n");
  assert.equal(await recoverDesktopLoginRace(app, f.deps), "relaunched");
  assert.deepEqual(f.calls.filter(call => !call.startsWith("/bin/ps")), ["kill 100 SIGTERM", `/usr/bin/open ${app}`]);
});

test("an app that has been open longer than the login window is left alone", async () => {
  const f = fake(`100 1 ${main}\n101 100 ${stock}\n`, "100 05:00\n101 04:58\n");
  assert.equal(await recoverDesktopLoginRace(app, f.deps), "too_old");
  assert.ok(!f.calls.some(call => call.startsWith("kill") || call.startsWith("/usr/bin/open")));
});

test("an app already on the gateway, or no app at all, is never touched", async () => {
  for (const rows of [`100 1 ${main}\n101 100 ${shim}\n`, `100 1 ${main}\n101 100 ${shim}\n102 100 ${stock}\n`, "", `100 1 ${main}\n`]) {
    const f = fake(rows, "100 00:05\n101 00:05\n102 00:05\n");
    assert.equal(await recoverDesktopLoginRace(app, f.deps), "none");
    assert.ok(!f.calls.some(call => call.startsWith("kill") || call.startsWith("/usr/bin/open")));
  }
});

test("an app that does not quit is never force-killed or opened a second time", async () => {
  const f = fake(`100 1 ${main}\n101 100 ${stock}\n`, "100 00:13\n101 00:11\n", { quits: false });
  assert.equal(await recoverDesktopLoginRace(app, f.deps), "quit_timeout");
  assert.deepEqual(f.calls.filter(call => call.startsWith("kill")), ["kill 100 SIGTERM"]);
  assert.ok(!f.calls.some(call => call.startsWith("/usr/bin/open")));
});

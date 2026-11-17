import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installPublishedApp, setupLocal, type SetupLocalDeps } from "../setup-local.js";

function deps(overrides: Partial<SetupLocalDeps> = {}): { deps: Partial<SetupLocalDeps>; calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args].join(" ")); return {}; };
  return { calls, deps: {
    chatGptRunning: async () => false, service: record("service"), register: record("register"), consolidate: record("consolidate"),
    findApp: async () => undefined, installApp: async version => { calls.push(`install ${version}`); return "/Users/x/Applications/GateFox.app"; },
    openApp: record("open"), requireDesktopApp: async () => {}, version: async () => "9.9.9",
    config: async () => ({ providers: [{}], stateDirectory: "/state" }), unified: async () => false, ...overrides,
  } };
}

test("a new Mac gets the service, the desktop adapter, one startup job and the app, in that order", async () => {
  const { deps: d, calls } = deps();
  const result = await setupLocal("/c.json", "/Applications/ChatGPT.app", d);
  assert.deepEqual(calls, ["service /c.json", "register /c.json /Applications/ChatGPT.app", "consolidate /c.json", "install 9.9.9", "open /Users/x/Applications/GateFox.app"]);
  assert.equal(result.ready, true);
});

test("an already unified Mac only gets the missing app opened", async () => {
  const { deps: d, calls } = deps({ unified: async () => true, findApp: async () => "/Applications/GateFox.app", chatGptRunning: async () => true });
  await setupLocal("/c.json", "/Applications/ChatGPT.app", d);
  assert.deepEqual(calls, ["open /Applications/GateFox.app"]);
});

test("a running ChatGPT, a client-only Mac or no accounts stop before any change", async () => {
  for (const [override, message] of [[{ chatGptRunning: async () => true }, /Quit ChatGPT/], [{ config: async () => ({ clientOnly: true, providers: [{}], stateDirectory: "/s" }) }, /another Mac's gateway/],
    [{ config: async () => ({ providers: [], stateDirectory: "/s" }) }, /Connect an account first/], [{ requireDesktopApp: async () => { throw new Error("chat app without Codex"); } }, /without Codex/]] as const) {
    const { deps: d, calls } = deps(override as Partial<SetupLocalDeps>);
    await assert.rejects(setupLocal("/c.json", "/Applications/ChatGPT.app", d), message);
    assert.deepEqual(calls, []);
  }
});

test("the published app is rejected when its download does not match SHA256SUMS", async () => {
  const zip = Buffer.from("app"); const good = createHash("sha256").update(zip).digest("hex"); let verified = false;
  const download = (sum: string) => async (url: string) => url.endsWith("SHA256SUMS") ? Buffer.from(`${sum}  GateFox-1.2.3-macos-arm64.zip\n`) : zip;
  await assert.rejects(installPublishedApp("1.2.3", async () => { verified = true; }, download("0".repeat(64))), /does not match its published checksum/);
  await assert.rejects(installPublishedApp("1.2.3", async () => { verified = true; }, async () => Buffer.from(`${good}  other.zip\n`)), /lists no checksum/);
  await assert.rejects(installPublishedApp("dev", async () => { verified = true; }), /no release version/);
  assert.equal(verified, false);
});

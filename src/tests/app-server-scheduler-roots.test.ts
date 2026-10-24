import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerRouter } from "../app-server-router.js";
import { translateGatewaySchedulerRoots } from "../app-server-scheduler-roots.js";
import type { GatewayConfig } from "../config.js";

type ObjectValue = Record<string, unknown>;
const roots = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value));
  return value;
};

const schedulerParams = (): ObjectValue => ({
  cwd: "/fixture/work",
  runtimeWorkspaceRoots: ["~", "/fixture/automation", "relative", "~/child"],
  sandboxPolicy: {
    type: "dangerFullAccess",
    writableRoots: ["~", "/fixture/automation", "relative", "~/child"],
    networkAccess: true,
  },
  model: "fixture/gateway",
  permissions: { approval: "never" },
  approvalPolicy: "never",
});

test("only the exact scheduler home root uses the user home, not CODEX_HOME", () => {
  const params = schedulerParams();
  const translated = translateGatewaySchedulerRoots(
    "turn/start",
    params,
    "/fixture/user-home",
  );
  assert.deepEqual(translated.runtimeWorkspaceRoots, [
    "/fixture/user-home",
    "/fixture/automation",
    "relative",
    "~/child",
  ]);
  assert.deepEqual((translated.sandboxPolicy as ObjectValue).writableRoots, [
    "/fixture/user-home",
    "/fixture/automation",
    "relative",
    "~/child",
  ]);
  assert.equal(translated.cwd, params.cwd);
  assert.deepEqual(translated.model, params.model);
  assert.deepEqual(translated.permissions, params.permissions);
  assert.deepEqual(translated.approvalPolicy, params.approvalPolicy);
  assert.equal((translated.sandboxPolicy as ObjectValue).networkAccess, true);
});

test("relative and process-shaped requests remain untouched", () => {
  const relative = {
    cwd: "~",
    runtimeWorkspaceRoots: ["relative", ".", "..", "~/child"],
    sandboxPolicy: { writableRoots: ["relative", "~/child"] },
  };
  assert.equal(
    translateGatewaySchedulerRoots("turn/start", relative, "/fixture/home"),
    relative,
  );
  const processParams = schedulerParams();
  assert.equal(
    translateGatewaySchedulerRoots("process/spawn", processParams, "/fixture/home"),
    processParams,
  );
});

test("only gateway start and turn requests translate scheduler roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-scheduler-roots-"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const config: GatewayConfig = {
    version: 1,
    port: 3457,
    stateDirectory: directory,
    providers: [
      {
        id: "fixture",
        type: "claude-subscription",
        models: { "fixture/gateway": "fixture" },
      },
    ],
  };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const router = new AppServerRouter(config, async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") {
      return {
        thread: { id: "gateway-thread" },
        model: "fixture/gateway",
        modelProvider: "subscription_gateway",
      };
    }
    if (method === "turn/start") return { turn: { id: "turn" } };
    return { status: "ok" };
  });
  await router.initialize();

  const started: ObjectValue = {
    ...schedulerParams(),
    modelProvider: "subscription_gateway",
  };
  await router.request("thread/start", started);
  const start = calls.at(-1)!.params;
  assert.equal(roots(start.runtimeWorkspaceRoots)[0], homedir());
  assert.equal(roots((start.sandboxPolicy as ObjectValue).writableRoots)[0], homedir());
  assert.equal(start.cwd, started.cwd);
  assert.deepEqual(start.permissions, started.permissions);

  await router.request("turn/start", {
    ...schedulerParams(),
    threadId: "gateway-thread",
  });
  const turn = calls.at(-1)!.params;
  assert.equal(roots(turn.runtimeWorkspaceRoots)[0], homedir());
  assert.equal(roots((turn.sandboxPolicy as ObjectValue).writableRoots)[0], homedir());

  await router.request("thread/start", {
    ...schedulerParams(),
    model: "native",
  });
  const native = calls.at(-1)!.params;
  assert.equal(roots(native.runtimeWorkspaceRoots)[0], "~");
  assert.equal(roots((native.sandboxPolicy as ObjectValue).writableRoots)[0], "~");
});

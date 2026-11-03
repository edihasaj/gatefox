import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { grokLimits, grokTestHooks } from "../providers/grok-live-session.js";
import { GrokMcpServer } from "../providers/grok-mcp-http.js";
import { ProviderError } from "../providers/provider.js";
import { adapter, alive, harness, live, until, user, turn, outputFor } from "./grok-live-harness.js";

const rejected = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as ProviderError);
const refusal = (error: ProviderError | undefined, reason: RegExp) => {
  assert.ok(error instanceof ProviderError, "a ProviderError"); assert.equal(error.status, 400); assert.equal(error.upstream?.code, "session_continuity_unavailable"); assert.match(error.message, reason);
};
const gone = async (h: Awaited<ReturnType<typeof harness>>, pids: number[]) => until(async () => live().sessions().length === 0 && (await h.liveDirs()).length === 0 && pids.every(pid => !alive(pid)));
const listening = (url: string) => new Promise<boolean>(resolve => {
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port) }, () => { socket.destroy(); resolve(true); });
  socket.on("error", () => resolve(false));
});

test("the original request again is refused after park expiry, after tool-wait expiry and after a crash, and no second CLI starts", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter();
    grokLimits.parkMs = 150;
    const parked = [user("start [plain]")];
    await turn(provider, parked, { context: { threadId: "parked" } });
    assert.ok(await gone(h, await h.pids()), "parked session reaped");
    refusal(await rejected(turn(provider, parked, { context: { threadId: "parked" } })), /parked/);
    delete grokLimits.parkMs;

    grokLimits.toolWaitMs = 150;
    const waiting = [user("start [tool]")];
    await turn(provider, waiting, { context: { threadId: "waiting" } });
    assert.ok(await gone(h, await h.pids()), "tool wait reaped");
    refusal(await rejected(turn(provider, waiting, { context: { threadId: "waiting" } })), /tool_wait_expired/);
    delete grokLimits.toolWaitMs;

    // A crash is a final refusal (not a retryable 502), and repeating the request is refused too.
    const crash = [user("go [crash]")];
    refusal(await rejected(turn(provider, crash, { context: { threadId: "crash" } })), /session_dead/);
    assert.ok(await gone(h, await h.pids()));
    refusal(await rejected(turn(provider, crash, { context: { threadId: "crash" } })), /session_dead/);

    assert.equal((await h.pids()).length, 3, "one process per conversation; no refusal started another");
    const refused = (await h.sessions()).filter(entry => entry.outcome === "refused").map(entry => entry.missReason);
    assert.deepEqual(refused, ["parked", "tool_wait_expired", "session_dead"]);
  } finally { await h.restore(); }
});

test("a sign-in failure stays a 401 and the corrected retry is not refused as a replay", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const request = [user("go [auth]")];
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await rejected(turn(provider, request, { context: { threadId: "auth" } }));
      assert.ok(error instanceof ProviderError && error.status === 401 && error.code === "authentication", `attempt ${attempt}: ${error?.code}`);
      assert.ok(await gone(h, await h.pids()));
    }
    assert.equal((await h.pids()).length, 2, "signing in and retrying starts a CLI again");
  } finally { await h.restore(); }
});

test("a tool-loop request that fails after the first answer is final too", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first);
    process.kill((await h.pids()).at(-1)!, "SIGKILL");
    assert.ok(await until(() => live().sessions().length === 0));
    refusal(await rejected(turn(provider, first)), /session_dead/);
    refusal(await rejected(turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")])), /session_dead/);
    assert.equal((await h.pids()).length, 1);
  } finally { await h.restore(); }
});

for (const stage of ["directory", "listen"] as const) {
  test(`cancelling while startup acquires the ${stage} leaves no endpoint, folder or process`, { timeout: 30000 }, async () => {
    const h = await harness();
    const original = GrokMcpServer.prototype.listen; const urls: string[] = [];
    GrokMcpServer.prototype.listen = async function (this: GrokMcpServer) { const url = await original.call(this); urls.push(url); return url; };
    try {
      const controller = new AbortController();
      grokTestHooks.boot = at => { if (at === stage) controller.abort(); };
      const error = await rejected(turn(adapter(), [user("go [plain]")], { controller }));
      assert.ok(error instanceof ProviderError && error.code === "cancelled", `cancelled, got ${error?.code}`);
      assert.deepEqual(await h.liveDirs(), [], "folder removed");
      assert.deepEqual(await h.pids(), [], "no CLI was started");
      assert.equal(live().sessions().length, 0);
      if (stage === "listen") {
        assert.equal(urls.length, 1, "the endpoint had been opened");
        assert.equal(await listening(urls[0]), false, "and was closed");
      } else assert.deepEqual(urls, [], "startup stopped before opening an endpoint");
    } finally { delete grokTestHooks.boot; GrokMcpServer.prototype.listen = original; await h.restore(); }
  });
}

for (const [tag, frame] of [["nullframe", "null"], ["arrayframe", "[]"], ["numframe", "42"], ["badmsg", "an error with a non-string message"], ["badcode", "an error with a non-numeric code"], ["badresult", "a non-object result"]] as const) {
  test(`a malformed frame (${frame}) from the CLI fails the request cleanly and the gateway process survives`, { timeout: 30000 }, async () => {
    const h = await harness();
    try {
      const error = await rejected(turn(adapter(), [user(`go [${tag}]`)], { context: { threadId: tag } }));
      assert.ok(error instanceof ProviderError, `a ProviderError, got ${error}`);
      assert.equal(error.status, 400); assert.equal(error.upstream?.code, "session_continuity_unavailable");
      assert.ok(await gone(h, await h.pids()), "the CLI is gone");
      assert.ok((await h.sessions()).some(entry => entry.outcome === "crashed" && entry.missReason === "invalid_frame"));
    } finally { await h.restore(); }
  });
}

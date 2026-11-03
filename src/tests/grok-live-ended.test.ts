import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { grokEndedFile, grokEndedLimits } from "../providers/grok-ended-store.js";
import { grokLimits } from "../providers/grok-live-session.js";
import { fixedReason, grokEndReasons, grokStopReason, grokStopReasons } from "../providers/grok-reasons.js";
import { ProviderError } from "../providers/provider.js";
import { readTelemetry } from "../telemetry.js";
import { adapter, alive, callIds, harness, live, outputFor, sleep, turn, until, user } from "./grok-live-harness.js";

const run = promisify(execFile);
const rejected = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as ProviderError);
const refusal = (error: ProviderError | undefined, reason: RegExp) => {
  assert.ok(error instanceof ProviderError, `a ProviderError, got ${error}`); assert.equal(error.status, 400); assert.equal(error.upstream?.code, "session_continuity_unavailable"); assert.match(error.message, reason);
};
const gone = async (h: Awaited<ReturnType<typeof harness>>, pids: number[]) => until(async () => live().sessions().length === 0 && (await h.liveDirs()).length === 0 && pids.every(pid => !alive(pid)));
const store = async (h: Awaited<ReturnType<typeof harness>>) => JSON.parse(await readFile(join(h.home, grokEndedFile), "utf8")) as { version: number; entries: Record<string, { at: number; reason: string }> };
const defaults = { ...grokEndedLimits };
const reset = () => { Object.assign(grokEndedLimits, defaults); delete grokLimits.parkMs; };

test("a sign-in failure on an established session stays a 401 but keeps an ended record: retrying the original seed starts no second CLI", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [plain]")];
    const a = await turn(provider, first);
    const second = [...first, ...a.output, user("again [auth]")];
    const error = await rejected(turn(provider, second));
    assert.ok(error instanceof ProviderError && error.status === 401 && error.code === "authentication", `a 401, got ${error?.code}`);
    assert.ok(await gone(h, await h.pids()));
    refusal(await rejected(turn(provider, first)), /session_dead/);
    refusal(await rejected(turn(provider, second)), /session_dead/);
    assert.equal((await h.pids()).length, 1, "no second CLI started");
    assert.equal(Object.values((await store(h)).entries)[0].reason, "session_dead");
  } finally { await h.restore(); }
});

test("a sign-in failure after a tool call on the first prompt is not a clean first prompt: the record is kept", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first);
    assert.equal(callIds(a.output).length, 1);
    process.kill((await h.pids()).at(-1)!, "SIGKILL");
    assert.ok(await gone(h, await h.pids()));
    refusal(await rejected(turn(provider, first)), /session_dead/);
    assert.equal((await h.pids()).length, 1);
  } finally { await h.restore(); }
});

test("the ended-record store is persisted privately (hashes only), survives a restart and refuses the original request of an ended conversation", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const seed = [user("secret-seed-text [tool]")]; const context = { threadId: "secret-thread-name" };
    await turn(provider, seed, { context });
    // Gateway shutdown closes the live session; its conversation must stay closed for a process that starts afterwards.
    await live().stop();
    const file = join(h.home, grokEndedFile);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes("secret"), "no content in the store");
    const saved = await store(h); const [key] = Object.keys(saved.entries);
    assert.equal(saved.version, 1); assert.equal(Object.keys(saved.entries).length, 1);
    assert.match(key, /^[0-9a-f]{64}$/); assert.equal(saved.entries[key].reason, "stopped");
    // A new process reading the store: a separate node process sees the closed conversation.
    const module = new URL("../providers/grok-ended-store.js", import.meta.url).href;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `const { GrokEndedStore } = await import(${JSON.stringify(module)}); process.stdout.write(String(await GrokEndedStore.forHome(process.argv[1]).lookup(process.argv[2])));`, h.home, key]);
    assert.equal(stdout, "stopped");
    // And so does a fresh registry in this process (no in-memory copy is kept across stop()).
    refusal(await rejected(turn(provider, seed, { context })), /stopped/);
    assert.equal((await h.pids()).length, 1, "the restart started no second CLI");
    assert.ok((await h.sessions()).some(entry => entry.outcome === "refused" && entry.missReason === "stopped"));
    // Another conversation is not affected.
    assert.match((await turn(provider, [user("other [plain]")], { context: { threadId: "other" } })).text, /answer to plain/);
  } finally { await h.restore(); }
});

test("a session whose gateway died without closing it is recorded as live and refused after the restart", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const seed = [user("start [tool]")];
    await turn(provider, seed);
    const file = join(h.home, grokEndedFile); const copy = join(h.directory, "while-live.json");
    assert.equal(Object.values((await store(h)).entries)[0].reason, "live");
    await copyFile(file, copy);
    await live().stop();
    await copyFile(copy, file); // the file as a gateway that was killed would have left it
    refusal(await rejected(turn(provider, seed)), /session_lost/);
    assert.equal((await h.pids()).length, 1);
  } finally { await h.restore(); }
});

test("a full store never evicts: a new conversation is refused and every closed one stays closed", { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    grokEndedLimits.maxEntries = 3; grokLimits.parkMs = 100;
    const provider = adapter();
    for (let index = 0; index < 3; index++) {
      await turn(provider, [user(`start${index} [plain]`)], { context: { threadId: `c${index}` } });
      assert.ok(await until(async () => Object.values((await store(h)).entries).filter(entry => entry.reason === "parked").length === index + 1), "ended and recorded");
    }
    refusal(await rejected(turn(provider, [user("new [plain]")], { context: { threadId: "c3" } })), /ended_store_full/);
    for (let index = 0; index < 3; index++) refusal(await rejected(turn(provider, [user(`start${index} [plain]`)], { context: { threadId: `c${index}` } })), /parked/);
    assert.equal((await h.pids()).length, 3, "no CLI started after saturation");
    assert.ok((await h.sessions()).some(entry => entry.outcome === "refused" && entry.missReason === "ended_store_full"));
  } finally { reset(); await h.restore(); }
});

test("only entries older than the expiry leave the store, and a conversation whose record expired may start again", { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    grokEndedLimits.maxEntries = 2; grokLimits.parkMs = 100;
    const provider = adapter(); const seed = [user("start0 [plain]")];
    await turn(provider, seed, { context: { threadId: "c0" } });
    await turn(provider, [user("start1 [plain]")], { context: { threadId: "c1" } });
    assert.ok(await until(async () => Object.values((await store(h)).entries).filter(entry => entry.reason === "parked").length === 2));
    refusal(await rejected(turn(provider, [user("start2 [plain]")], { context: { threadId: "c2" } })), /ended_store_full/);
    refusal(await rejected(turn(provider, seed, { context: { threadId: "c0" } })), /parked/);
    grokEndedLimits.expiryMs = 300; await sleep(450);
    // Expired entries are removed when a conversation needs the room, and an expired record no longer refuses.
    assert.match((await turn(provider, [user("start2 [plain]")], { context: { threadId: "c2" } })).text, /answer to plain/);
    assert.ok(Object.keys((await store(h)).entries).length <= 2);
    assert.match((await turn(provider, seed, { context: { threadId: "c0" } })).text, /answer to plain/);
  } finally { reset(); await h.restore(); }
});

test("a store that cannot be read or written refuses a new conversation with a fixed code, and recovers when it can", { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const file = join(h.home, grokEndedFile);
    await turn(provider, [user("first [plain]")], { context: { threadId: "ok" } });
    await live().stop();
    // Unreadable (corrupt) store.
    await writeFile(file, "{not json", { mode: 0o600 });
    refusal(await rejected(turn(provider, [user("a [plain]")], { context: { threadId: "a" } })), /ended_store_unavailable/);
    // A conversation with history still gets its own, more precise refusal.
    const history = [user("a [plain]"), { type: "message" as const, role: "assistant" as const, content: [{ type: "output_text" as const, text: "hi" }] }, user("again [plain]")];
    refusal(await rejected(turn(provider, history, { context: { threadId: "a" } })), /session_missing/);
    assert.equal((await h.pids()).length, 1, "nothing started");
    // Wrong shape and wrong key are corrupt as well.
    await writeFile(file, JSON.stringify({ version: 1, entries: { "not-a-hash": { at: 1, reason: "parked" } } }), { mode: 0o600 });
    await live().stop();
    refusal(await rejected(turn(provider, [user("a [plain]")], { context: { threadId: "a" } })), /ended_store_unavailable/);
    await writeFile(file, JSON.stringify({ version: 1, entries: {} }), { mode: 0o600 });
    await live().stop();
    // Unwritable store: the conversation is not started and nothing is left recorded.
    await chmod(h.home, 0o500);
    try { refusal(await rejected(turn(provider, [user("b [plain]")], { context: { threadId: "b" } })), /ended_store_unavailable/); } finally { await chmod(h.home, 0o700); }
    assert.equal((await h.pids()).length, 1, "no CLI was started");
    assert.deepEqual(Object.keys((await store(h)).entries), [], "nothing recorded");
    assert.match((await turn(provider, [user("b [plain]")], { context: { threadId: "b" } })).text, /answer to plain/);
  } finally { reset(); await chmod(h.home, 0o700).catch(() => {}); await h.restore(); }
});

test("a stop reason from the CLI is mapped to a fixed code and never reaches telemetry or a message", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    for (const known of grokStopReasons) assert.equal(grokStopReason(known), known);
    for (const odd of ["CANARY", "", undefined, null, 5, {}, ["end_turn"], { toString: null }, "end_turn "]) assert.equal(grokStopReason(odd), "unknown");
    assert.equal(fixedReason("CANARY"), "other"); assert.equal(fixedReason({ toString: null }), "other"); assert.equal(fixedReason("parked"), "parked");
    const provider = adapter();
    const error = await rejected(turn(provider, [user("go [stopcanary]")], { context: { threadId: "canary" } }));
    refusal(error, /session_dead/);
    assert.ok(!JSON.stringify(error).includes("CANARY") && !error!.message.includes("CANARY"));
    assert.ok(await gone(h, await h.pids()));
    refusal(await rejected(turn(provider, [user("go [stopcanary]")], { context: { threadId: "canary" } })), /session_dead/);
    await live().stop();
    const { flushTelemetry } = await import("../telemetry.js"); await flushTelemetry();
    const events = await readTelemetry(h.directory, 0);
    assert.ok(events.some(entry => entry.event === "grok_session" && entry.outcome === "crashed"), "the crash is recorded");
    assert.ok(!JSON.stringify(events).includes("CANARY"), "the canary appears in no telemetry event");
    // Every reason that was logged is one of the fixed codes.
    const known = new Set<string>(grokEndReasons);
    for (const entry of events.filter(event => event.event === "grok_session")) if (typeof entry.missReason === "string") assert.ok(known.has(entry.missReason), `fixed missReason, got ${entry.missReason}`);
    assert.ok(await readFile(join(h.home, grokEndedFile), "utf8").then(text => !text.includes("CANARY")));
  } finally { await h.restore(); }
});

// A first prompt whose sign-in failure follows any sign of inference may have been charged: its reservation stays.
for (const tag of ["authtool", "authupdate", "authinfo", "authusage", "authperm", "authmcp", "authmcpnoid", "authmcpnull"]) {
  test(`a first-prompt sign-in failure after a sign of inference [${tag}] keeps the reservation and a retry starts no CLI`, { timeout: 30000 }, async () => {
    const h = await harness();
    try {
      const provider = adapter(); const request = [user(`go [${tag}]`)];
      const error = await rejected(turn(provider, request));
      assert.ok(error instanceof ProviderError && error.status === 401 && error.code === "authentication", `a 401, got ${error?.code}`);
      assert.ok(await gone(h, await h.pids()));
      assert.equal(Object.values((await store(h)).entries)[0]?.reason, "session_dead", "the reservation stays");
      refusal(await rejected(turn(provider, request)), /session_dead/);
      assert.equal((await h.pids()).length, 1, "no second CLI started");
    } finally { await h.restore(); }
  });
}

test("setup-only notifications before a first-prompt sign-in failure still release the reservation", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const request = [user("go [authsetup]")];
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await rejected(turn(provider, request));
      assert.ok(error instanceof ProviderError && error.status === 401, `attempt ${attempt}: ${error?.code}`);
      assert.ok(await gone(h, await h.pids()));
    }
    assert.equal((await h.pids()).length, 2, "the retry started a CLI");
    assert.deepEqual(Object.keys((await store(h)).entries), []);
  } finally { await h.restore(); }
});

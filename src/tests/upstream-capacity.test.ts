import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { ProviderConfig } from "../config.js";
import {
  combineCapacitySnapshots, discoveredCapacityCeiling, parseCapacitySnapshot, probeUpstreamCapacity,
  UpstreamCapacityWatcher, type UpstreamCapacityFact,
} from "../upstream-capacity.js";

process.env.CAPACITY_TEST_KEY = "capacity-secret";
const second = 1_000;
const nowMs = Date.parse("2026-10-29T10:00:00Z");
const fresh = Math.floor(nowMs / second);
const configured = ["qwen/flash", "qwen/pro"];

const snapshot = (models: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ object: "inference_capacity", version: 1, complete: true, observed_at: fresh, models, ...extra });
const parse = (value: unknown, models: readonly string[] = configured, at = nowMs): UpstreamCapacityFact | undefined => parseCapacitySnapshot(value, models, at);

test("a complete snapshot gives the tightest configured model, clamped to what the gateway will admit", () => {
  const fact = parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 10 }, { id: "qwen/pro", max_concurrent_requests: 30 }]));
  assert.deepEqual(fact, { limit: 10, observedAt: fresh * second });
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 500 }, { id: "qwen/pro", max_concurrent_requests: 4096 }]))!.limit, discoveredCapacityCeiling);
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 0 }]))!.limit, 0, "a farm with no slots says so");
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 10 }, { id: "qwen/pro", max_concurrent_requests: 30 }]), ["qwen/pro"])!.limit, 30, "only the models this gateway routes");
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 10 }]), ["qwen/flash", "qwen/flash"])!.limit, 10, "a duplicated alias is one model");
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 10 }]), []), undefined, "no configured model is no claim");
});

test("a model a complete snapshot omits is a model with no slots, not an unknown one", () => {
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 40 }]))!.limit, 0, "qwen/pro is absent from a complete snapshot");
  assert.equal(parse(snapshot([]))!.limit, 0, "an empty complete snapshot claims nothing for anyone");
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 40 }], { complete: false })), undefined, "an incomplete snapshot proves nothing");
});

test("a snapshot outside its freshness window is refused", () => {
  const at = (observed_at: number) => parse(snapshot(configured.map(id => ({ id, max_concurrent_requests: 8 })), { observed_at }));
  assert.equal(at(fresh - 30)!.limit, 8, "30 s is the edge");
  assert.equal(at(fresh - 31), undefined, "stale");
  assert.equal(at(fresh + 5)!.limit, 8, "5 s of skew is allowed");
  assert.equal(at(fresh + 6), undefined, "from the future");
  assert.equal(at(-1), undefined, "a negative reading");
  assert.equal(at(Number.NaN), undefined);
  assert.equal(at(Number.POSITIVE_INFINITY), undefined);
  assert.deepEqual(at(fresh + .25), { limit: 8, observedAt: nowMs + 250 }, "Python's fractional timestamps are accepted");
});

test("a snapshot that breaks the contract is refused rather than half-trusted", () => {
  const ok = [{ id: "qwen/flash", max_concurrent_requests: 10 }];
  assert.equal(parse(snapshot(ok, { object: "capacity" })), undefined);
  assert.equal(parse(snapshot(ok, { object: undefined })), undefined);
  assert.equal(parse(snapshot(ok, { version: 2 })), undefined);
  assert.equal(parse(snapshot(ok, { version: 1.5 })), undefined, "a non-integer version");
  assert.equal(parse({ ...snapshot(ok), models: {} }), undefined, "models must be an array");
  assert.equal(parse(snapshot([{ id: "qwen/flash" }])), undefined, "a model with no capacity");
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 2.5 }])), undefined, "a fractional capacity");
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: -1 }])), undefined, "negative capacity");
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 4097 }])), undefined, "above the source bound");
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: true }])), undefined, "a boolean capacity");
  for (const id of ["", " qwen", "qwen flash", "-qwen", "qwen\n", "x".repeat(129)]) {
    assert.equal(parse(snapshot([{ id, max_concurrent_requests: 10 }])), undefined, `id ${JSON.stringify(id)} is not a model id`);
  }
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 10 }, { id: "qwen/flash", max_concurrent_requests: 3 }]))
    , undefined, "two rows for one model cannot both be true");
  assert.equal(parse(snapshot([{ id: "qwen/flash", max_concurrent_requests: 10 }, { id: "qwen/flash", max_concurrent_requests: 10 }])), undefined, "even equal duplicates");
  assert.equal(parse(snapshot(Array.from({ length: 129 }, (_, i) => ({ id: `m${i}`, max_concurrent_requests: 5 }))), ["m0"]), undefined, "over 128 models");
  assert.equal(parse(snapshot([{ id: "m0", max_concurrent_requests: 5 }, "nope"] as unknown as never[], ), ["m0"]), undefined, "a non-object row");
  assert.equal(parse("not json", configured, nowMs), undefined);
  assert.equal(parse(null, configured, nowMs), undefined);
  assert.equal(parse([{ id: "qwen/flash", max_concurrent_requests: 10 }], configured, nowMs), undefined, "an array is not a snapshot");
});

test("replicas of one farm give the tightest snapshot and are never added", () => {
  const at = (limit: number, observedAt: number): UpstreamCapacityFact => ({ limit, observedAt });
  assert.deepEqual(combineCapacitySnapshots([at(10, nowMs), at(4, nowMs - 1000)]), { limit: 4, observedAt: nowMs - 1000 }, "min, not sum");
  assert.deepEqual(combineCapacitySnapshots([at(6, nowMs)]), { limit: 6, observedAt: nowMs });
  assert.deepEqual(combineCapacitySnapshots([at(0, nowMs), at(20, nowMs)]), { limit: 0, observedAt: nowMs }, "one idle router closes the farm");
  assert.equal(combineCapacitySnapshots([]), undefined, "no answering router is no fact");
});

const provider = (extra: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: "CAPACITY_TEST_KEY", models: { "qwen/flash": "qwen/flash", "qwen/pro": "qwen/pro" }, ...extra });

interface Listener { server: Server; requests: Array<{ method?: string; url?: string; headers: NodeJS.Dict<string | string[]> }>; port: number; close: () => void }

async function listen(body: unknown | (() => unknown), status = 200): Promise<Listener> {
  const requests: Listener["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "function" ? JSON.stringify((body as () => unknown)()) : JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, requests, port: (server.address() as { port: number }).port, close: () => { server.closeAllConnections(); server.close(); } };
}

test("the loopback read is a GET carrying only the credential, and the tightest model wins", async () => {
  const target = await listen(snapshot([{ id: "qwen/flash", max_concurrent_requests: 7 }, { id: "qwen/pro", max_concurrent_requests: 25 }]));
  try {
    const fact = await probeUpstreamCapacity(provider({ baseUrl: `http://127.0.0.1:${target.port}/v1` }), { now: () => nowMs });
    assert.deepEqual(fact, { limit: 7, observedAt: fresh * second });
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0].method, "GET");
    assert.equal(target.requests[0].url, "/v1/capacity");
    assert.equal(target.requests[0].headers.authorization, "Bearer capacity-secret");
    assert.equal(target.requests[0].headers.cookie, undefined);
  } finally { target.close(); }
});

test("a remote provider, a provider without a credential and a broken URL are never contacted", async () => {
  let contacted = 0;
  const fakeFetch: typeof globalThis.fetch = async () => { contacted++; return new Response("{}", { status: 200 }); };
  const seams = { now: () => nowMs, fetch: fakeFetch };
  assert.equal(await probeUpstreamCapacity(provider({ baseUrl: "https://openrouter.ai/api/v1" }), seams), undefined);
  assert.equal(await probeUpstreamCapacity(provider({ type: "responses-api", baseUrl: "https://api.openai.com/v1" }), seams), undefined);
  assert.equal(await probeUpstreamCapacity(provider({ type: "codex-subscription", baseUrl: undefined }), seams), undefined);
  assert.equal(await probeUpstreamCapacity(provider({ baseUrl: "not a url" }), seams), undefined);
  assert.equal(await probeUpstreamCapacity(provider({ apiKeyEnv: "CAPACITY_TEST_KEY_MISSING" }), seams), undefined);
  assert.equal(await probeUpstreamCapacity(provider({ models: {} }), seams), undefined);
  assert.equal(contacted, 0, "nothing left the process");
});

test("an unusable answer yields no fact instead of a guessed one", async () => {
  const closed = await listen(snapshot([{ id: "qwen/flash", max_concurrent_requests: 9 }]), 503);
  const denied = await listen(snapshot([{ id: "qwen/flash", max_concurrent_requests: 9 }]), 401);
  const junk = await listen("this is not json" as unknown as never);
  const stale = await listen(snapshot([{ id: "qwen/flash", max_concurrent_requests: 9 }], { observed_at: fresh - 60 }));
  const huge = { server: createServer((_req, res) => { res.writeHead(200); res.end(Buffer.alloc(65_537, 0x20)); }), port: 0 } as { server: Server; port: number };
  huge.server.listen(0, "127.0.0.1"); await once(huge.server, "listening");
  huge.port = (huge.server.address() as { port: number }).port;
  try {
    for (const target of [closed, denied, junk, stale, huge as unknown as Listener]) {
      const base = `http://127.0.0.1:${target.port}/v1`;
      assert.equal(await probeUpstreamCapacity(provider({ baseUrl: base }), { now: () => nowMs }), undefined, `port ${target.port}`);
    }
  } finally { for (const target of [closed, denied, junk, stale]) target.close(); huge.server.closeAllConnections(); huge.server.close(); }
});

test("a redirect is not followed, so the credential cannot travel to another host", async () => {
  const follower = await listen(snapshot([{ id: "qwen/flash", max_concurrent_requests: 9 }]));
  const redirect = { server: createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${follower.port}/v1/capacity` }); res.end(); }), port: 0 } as { server: Server; port: number };
  redirect.server.listen(0, "127.0.0.1"); await once(redirect.server, "listening");
  redirect.port = (redirect.server.address() as { port: number }).port;
  try {
    assert.equal(await probeUpstreamCapacity(provider({ baseUrl: `http://127.0.0.1:${redirect.port}/v1` }), { now: () => nowMs }), undefined);
    assert.equal(follower.requests.length, 0, "the redirected host was never asked");
  } finally { follower.close(); redirect.server.closeAllConnections(); redirect.server.close(); }
});

test("a tailnet farm is min across its routers and is never summed", async () => {
  const fast = await listen(snapshot([{ id: "qwen/flash", max_concurrent_requests: 10 }, { id: "qwen/pro", max_concurrent_requests: 40 }]));
  const slow = await listen(snapshot([{ id: "qwen/flash", max_concurrent_requests: 4 }, { id: "qwen/pro", max_concurrent_requests: 40 }]));
  const ports: Record<string, number> = { "100.64.10.57": fast.port, "100.64.10.24": slow.port };
  const dialed: string[] = [];
  try {
    const seams = {
      now: () => nowMs,
      resolve: async () => ["100.64.10.57", "100.64.10.24"],
      dial: (address: string) => { dialed.push(address); return { host: "127.0.0.1", port: ports[address] }; },
    };
    const fact = await probeUpstreamCapacity(provider({ tailnet: true, baseUrl: "http://farm.example:4000/v1" }), seams);
    assert.deepEqual(fact, { limit: 4, observedAt: fresh * second }, "the tightest router governs");
    assert.deepEqual(dialed.sort(), ["100.64.10.24", "100.64.10.57"]);
    assert.equal(fast.requests.length, 1); assert.equal(slow.requests.length, 1);
    assert.ok(fast.requests.every(request => request.headers.authorization === "Bearer capacity-secret"));
  } finally { fast.close(); slow.close(); }
});

test("a tailnet provider that answers nowhere, or only off-tailnet, gives no fact", async () => {
  const target = await listen(snapshot([{ id: "qwen/flash", max_concurrent_requests: 10 }]));
  try {
    const dead = { now: () => nowMs, resolve: async () => ["100.64.10.57"], dial: () => ({ host: "127.0.0.1", port: target.port }) };
    assert.equal(await probeUpstreamCapacity(provider({ tailnet: true, baseUrl: "http://farm.example:4000/v1" }), { ...dead, dial: () => ({ host: "127.0.0.1", port: 1 }) }), undefined);
    assert.equal(await probeUpstreamCapacity(provider({ tailnet: true, baseUrl: "http://farm.example:4000/v1" }), { now: () => nowMs, resolve: async () => [] }), undefined);
    assert.equal(await probeUpstreamCapacity(provider({ tailnet: true, baseUrl: "http://farm.example:4000/v1" }), { ...dead, resolve: async () => ["203.0.113.5"] }), undefined, "a public address is refused");
    assert.equal(target.requests.length, 0, "the bearer never left");
  } finally { target.close(); }
});

test("a resolver that never answers is cut off by the probe deadline", async () => {
  const started = Date.now();
  const fact = await probeUpstreamCapacity(provider({ tailnet: true, baseUrl: "http://farm.example:4000/v1" }),
    { now: () => nowMs, resolve: () => new Promise<string[]>(() => {}) }, 200);
  assert.equal(fact, undefined);
  assert.ok(Date.now() - started < 1500, `bounded, took ${Date.now() - started} ms`);
});

test("refused public IP literals neither connect nor leave an unhandled deadline rejection", async () => {
  let dialed = 0;
  for (const baseUrl of ["http://203.0.113.5:4000/v1", "http://[2001:db8::1]:4000/v1"]) {
    const fact = await probeUpstreamCapacity(provider({ tailnet: true, baseUrl }), {
      dial: () => { dialed++; return { host: "127.0.0.1", port: 1 }; },
    });
    assert.equal(fact, undefined);
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(dialed, 0);
});

test("a rejected HTTP response never waits for stalled body cancellation", { timeout: 1500 }, async () => {
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({
    cancel: () => new Promise<void>(() => {}),
  }), { status: 503 });
  const began = Date.now();
  assert.equal(await probeUpstreamCapacity(provider(), { fetch }, 30), undefined);
  assert.ok(Date.now() - began < 1000);
});

test("a stalled fetch or response body is bounded by the same deadline", async () => {
  const hungFetch: typeof globalThis.fetch = () => new Promise<Response>(() => {});
  for (const fetch of [hungFetch, (async () => new Response(new ReadableStream<Uint8Array>({ start() {}, cancel() {} }))) as typeof globalThis.fetch]) {
    const began = Date.now();
    assert.equal(await probeUpstreamCapacity(provider(), { now: () => nowMs, fetch }, 30), undefined);
    assert.ok(Date.now() - began < 1000);
  }
});

const key = (models: string[]): string => JSON.stringify([...models].sort());
const replica = (limit: number, models: string[] = configured): UpstreamCapacityFact => ({ limit, observedAt: nowMs });
const opted = (extra: Partial<ProviderConfig> = {}): ProviderConfig => provider({ capacityDiscovery: true, models: Object.fromEntries(configured.map(m => [m, m])), ...extra });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

test("a provider nobody opted in starts no timer and makes no call", async () => {
  let calls = 0;
  const watcher = new UpstreamCapacityWatcher(() => { calls++; }, { probe: async () => { calls++; return replica(4); }, now: () => nowMs, intervalMs: 5 });
  watcher.configure([provider(), provider({ id: "other" })]);
  await sleep(40);
  assert.equal(calls, 0, "no callback and no probe for an opted-out provider");
  assert.deepEqual(watcher.tracking, []);
  watcher.retire();
});

test("an opted-in provider is collected at once and again on the schedule", async () => {
  let clock = nowMs;
  const seen: Array<[string, UpstreamCapacityFact | undefined]> = [];
  const calls: string[] = [];
  const watcher = new UpstreamCapacityWatcher((id, fact) => seen.push([id, fact]),
    { probe: async providerArg => { calls.push(providerArg.id); return replica(5); }, now: () => clock, intervalMs: 10 });
  watcher.configure([opted(), provider({ id: "off" })]);
  assert.deepEqual(watcher.tracking, ["qwen"]);
  await sleep(30);
  assert.deepEqual(calls, ["qwen"], "one initial collection, and none for the opted-out provider");
  assert.deepEqual([...seen], [["qwen", replica(5)]]);
  clock += 10;
  await sleep(40);
  assert.ok(calls.length >= 2, `refreshed on the schedule (${calls.length} calls)`);
  watcher.retire();
});

test("one collection per provider at a time, and the first result still lands", async () => {
  let clock = nowMs;
  let release: (() => void) | undefined;
  let calls = 0;
  const watcher = new UpstreamCapacityWatcher(() => {}, {
    probe: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return replica(3); },
    now: () => clock, intervalMs: 5,
  });
  watcher.configure([opted()]);
  await sleep(30);
  assert.equal(calls, 1, "a slow farm is not stacked behind itself");
  clock += 10;
  release?.();
  await sleep(20);
  assert.equal(calls, 2, "the next round starts once the slow one finishes");
  watcher.retire();
});

test("a slow answer for a removed, disabled or rebound provider never applies", async () => {
  const releases = new Map<string, () => void>();
  const applied: Array<[string, UpstreamCapacityFact | undefined]> = [];
  const watcher = new UpstreamCapacityWatcher((id, fact) => applied.push([id, fact]), {
    probe: async provider => { await new Promise<void>(resolve => { releases.set(provider.id, resolve); }); return replica(9); },
    now: () => nowMs, intervalMs: 60_000,
  });
  watcher.configure([opted()]);
  await sleep(10);
  assert.equal(applied.length, 0, "the probe is still in flight");

  watcher.configure([provider({ id: "gone", capacityDiscovery: true })]);
  assert.deepEqual(applied.filter(([id]) => id === "qwen"), [["qwen", undefined]], "a removed provider is cleared at once");

  releases.get("qwen")?.();
  await sleep(20);
  assert.equal(applied.filter(([id]) => id === "qwen").length, 1, "the in-flight answer was dropped");

  // Rebind to another server: the old fact goes immediately, and the new server's own answer is what arrives.
  applied.length = 0;
  const reboundReleases: Array<() => void> = [];
  const rebound = new UpstreamCapacityWatcher((id, fact) => applied.push([id, fact]), {
    probe: async () => { await new Promise<void>(resolve => { reboundReleases.push(resolve); }); return replica(11); },
    now: () => nowMs, intervalMs: 60_000,
  });
  rebound.configure([opted()]);
  await sleep(10);
  rebound.configure([opted({ baseUrl: "http://127.0.0.1:4100/v1" })]);
  assert.deepEqual([...applied], [["qwen", undefined]], "moving the provider to another server clears its capacity at once");
  reboundReleases[0]?.();
  await sleep(20);
  assert.deepEqual([...applied], [["qwen", undefined]], "the answer to the old server stayed dropped");
  reboundReleases[1]?.();
  await sleep(10);
  assert.deepEqual(applied.at(-1), ["qwen", replica(11)], "only the new server's answer applies");

  // Opting out clears the fact and stops collecting.
  applied.length = 0;
  const stopped = new UpstreamCapacityWatcher((id, fact) => applied.push([id, fact]), { probe: async () => replica(2), now: () => nowMs, intervalMs: 10 });
  stopped.configure([opted()]);
  await sleep(20);
  assert.deepEqual(applied.at(-1), ["qwen", replica(2)]);
  stopped.configure([provider()]);
  assert.deepEqual(applied.at(-1), ["qwen", undefined], "capacityDiscovery: false clears it at once");
  assert.deepEqual(stopped.tracking, []);
  const before = applied.length;
  await sleep(40);
  assert.equal(applied.length, before, "no timer keeps running for an opted-out provider");
  for (const w of [watcher, rebound, stopped]) w.retire();
});

test("a probe that fails falls back at once, and retiring ends the watcher", async () => {
  const applied: Array<[string, UpstreamCapacityFact | undefined]> = [];
  let mode = "fail";
  let clock = nowMs;
  const watcher = new UpstreamCapacityWatcher((id, fact) => applied.push([id, fact]), {
    probe: async () => { if (mode === "throw") throw new Error("transport exploded"); return mode === "fail" ? undefined : replica(6); },
    now: () => clock, intervalMs: 10,
  });
  watcher.configure([opted()]);
  await sleep(20);
  assert.deepEqual(applied.at(-1), ["qwen", undefined], "a failed round falls back immediately");
  mode = "ok";
  clock += 20;
  await sleep(30);
  assert.deepEqual(applied.at(-1), ["qwen", replica(6)], "and recovers on a later round");
  mode = "throw";
  clock += 20;
  await sleep(30);
  assert.deepEqual(applied.at(-1), ["qwen", undefined], "a throwing probe is the same as no fact");
  watcher.retire();
  const before = applied.length;
  await sleep(40);
  assert.equal(applied.length, before, "retiring stops the timer and every later callback");
});

test("a nearly stale observation expires before the next collection", async () => {
  const applied: Array<UpstreamCapacityFact | undefined> = [];
  const watcher = new UpstreamCapacityWatcher((_id, fact) => applied.push(fact), {
    intervalMs: 60_000, probe: async () => ({ limit: 20, observedAt: Date.now() - 29_950 }),
  });
  try {
    watcher.configure([opted()]);
    await sleep(10); assert.equal(applied.at(-1)?.limit, 20);
    await sleep(80); assert.equal(applied.at(-1), undefined);
  } finally { watcher.retire(); }
});

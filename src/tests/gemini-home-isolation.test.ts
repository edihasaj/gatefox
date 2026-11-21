import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError } from "../providers/provider.js";
import { adapter, alive, callIds, harness, live, outputFor, sleep, turn, until, user, type Harness } from "./gemini-live-harness.js";

const rejected = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as ProviderError);
const credentialFile = (h: Harness) => join(h.home, ".gemini/oauth_creds.json");
const credentials = async (h: Harness) => JSON.parse(await readFile(credentialFile(h), "utf8")) as Record<string, string>;
/** Every path below `directory`, relative to it. */
async function tree(directory: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(prefix, entry.name); out.push(path);
    if (entry.isDirectory()) out.push(...await tree(join(directory, entry.name), path));
  }
  return out;
}
const recorded = (paths: string[]) => paths.filter(path => /(^|\/)(tmp|history)(\/|$)/.test(path));
const gone = async (h: Harness) => { assert.ok(await until(async () => (await h.liveDirs()).length === 0), "every session folder, and the CLI home inside it, is removed"); };

test("the CLI runs in a disposable home, so its transcripts never reach the persistent one", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const result = await turn(adapter(), [user("a prompt that must not persist [plain]")]);
    assert.equal(result.text, "answer to plain");
    const spawn = (await h.log()).find(entry => entry.op === "spawn")!;
    assert.notEqual(spawn.home, h.home, "the CLI was not given the persistent home");
    assert.ok(String(spawn.home).startsWith(h.scratch), "its home is inside the session's own folder");
    assert.equal(spawn.homeMode, 0o700, "private");
    assert.equal(spawn.credMode, 0o600, "the copied sign-in is 0600");
    assert.equal(spawn.credential, true, "the copy carries the sign-in");
    assert.match(spawn.settings, /"selectedType": "oauth-personal"/, "the managed settings are in the disposable home");
    // The fixture records a transcript in whatever home it has, exactly as the real CLI does.
    assert.deepEqual(recorded(await tree(h.home)), [], "nothing the CLI recorded reached the persistent home: no tmp/, no history/");
    assert.equal(spawn.flags.policy, true, "the policy file is in the disposable home");
    await live().stop();
    await gone(h);
    assert.deepEqual(recorded(await tree(h.home)), [], "nor does anything arrive when the session ends");
    assert.deepEqual(await readdir(h.scratch), [], "the transcript went with the disposable home");
  } finally { await h.restore(); }
});

test("the CLI cannot be pushed into the browser-less code prompt, and every opener is a stand-in", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    await turn(adapter(), [user("start [plain]")]);
    const spawn = (await h.log()).find(entry => entry.op === "spawn")!;
    // The test process sets CI, SSH_CONNECTION, BROWSER and DEBIAN_FRONTEND, each of which makes the real CLI skip the browser
    // and read a code from stdin — which for an ACP session is the protocol stream.
    assert.deepEqual(spawn.browserEnv, { ci: false, ssh: false, browser: false, debian: false });
    assert.ok(String(spawn.opener).startsWith(h.scratch) && String(spawn.opener).endsWith("/bin"), "the first PATH entry holds the stand-in openers");
    assert.equal(spawn.flags.noBrowser, true, "NO_BROWSER stays unset: it would print a code prompt into the protocol stream");
  } finally { await h.restore(); }
});

test("a sign-in the CLI refreshed is copied back atomically, and an unchanged one is left alone", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const original = await readFile(credentialFile(h), "utf8");
    await turn(adapter(), [user("start [plain]")]);
    await live().stop(); await gone(h);
    assert.equal(await readFile(credentialFile(h), "utf8"), original, "an unchanged credential is not rewritten");

    process.env.GATEWAY_TEST_GEMINI_REFRESH = "refreshed-access";
    await turn(adapter(), [user("again [plain]")], { context: { threadId: "refresh" } });
    assert.equal((await credentials(h)).access_token, "test-access", "while the session runs, the persistent copy is untouched");
    await live().stop(); await gone(h);
    const after = await credentials(h);
    assert.equal(after.access_token, "refreshed-access", "the refreshed token was carried back");
    assert.equal(after.refresh_token, "test-refresh");
    assert.equal((await stat(credentialFile(h))).mode & 0o777, 0o600);
    const files = await readdir(join(h.home, ".gemini"));
    assert.deepEqual(files.filter(name => name.endsWith(".tmp") || name.endsWith(".lock")), [], "no temporary or lock file is left behind");
    assert.deepEqual(recorded(await tree(h.home)), []);
  } finally { await h.restore(); }
});

test("a newer sign-in made while the session ran is not overwritten by its refresh", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    process.env.GATEWAY_TEST_GEMINI_REFRESH = "stale-refresh";
    await turn(adapter(), [user("start [plain]")], { context: { threadId: "race" } });
    await writeFile(credentialFile(h), JSON.stringify({ access_token: "newer-login", refresh_token: "newer-refresh" }), { mode: 0o600 });
    await live().stop(); await gone(h);
    assert.deepEqual(await credentials(h), { access_token: "newer-login", refresh_token: "newer-refresh" }, "the sign-in somebody else made wins");
  } finally { await h.restore(); }
});

test("a credential the CLI left unusable never replaces a good one", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const original = await readFile(credentialFile(h), "utf8");
    await turn(adapter(), [user("start [plain]")], { context: { threadId: "broken" } });
    // Whatever the CLI wrote into its own copy, a credential that no longer carries both tokens is not carried back.
    const spawn = (await h.log()).find(entry => entry.op === "spawn")!;
    await writeFile(join(String(spawn.home), ".gemini/oauth_creds.json"), JSON.stringify({ access_token: "only-access" }), { mode: 0o600 });
    await live().stop(); await gone(h);
    assert.equal(await readFile(credentialFile(h), "utf8"), original);
  } finally { await h.restore(); }
});

test("a sign-in that cannot refresh fails with 401 before any browser opens, and the retry after signing in works", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    process.env.GATEWAY_TEST_GEMINI_BROWSER = "1";
    const started = Date.now();
    const error = await rejected(turn(adapter(), [user("start [plain]")], { context: { threadId: "browser" } }));
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "authentication");
    assert.equal(error.upstream?.code, "authentication_failed");
    assert.match(error.message, /gateway login gemini/);
    assert.doesNotMatch(error.message, /google\.com|http/i, "a fixed message: the sign-in URL the CLI asked for never reaches the caller");
    assert.ok(Date.now() - started < 15000, "the stand-in's marker ends startup at once instead of waiting out the CLI's own timeout");
    const log = await h.log();
    // The 401 itself is the proof that the CLI asked for a browser and that the stand-in caught it: only the stand-in's marker produces it.
    // The fixture's own log of that moment is not asserted, because startup may kill the CLI before it is written.
    assert.ok(!log.some(entry => entry.op === "no-stand-in"), "the opener the CLI ran was the gateway's stand-in, so no browser opened");
    for (const pid of await h.pids()) assert.ok(await until(() => !alive(pid)), "the waiting CLI was killed");
    await gone(h);
    assert.equal((await credentials(h)).refresh_token, "test-refresh", "a failed start does not touch the saved sign-in");
    // The conversation was never served, so signing in again and repeating the request must work.
    delete process.env.GATEWAY_TEST_GEMINI_BROWSER;
    const retry = await turn(adapter(), [user("start [plain]")], { context: { threadId: "browser" } });
    assert.equal(retry.text, "answer to plain");
  } finally { await h.restore(); }
});

test("anonymous requests do not leak the session pool: six in a row succeed at max 4 and none is retained", { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "live", max: 4 });
    for (let index = 0; index < 6; index++) {
      const result = await turn(provider, [user(`anonymous ${index} [plain]`)], { context: {} });
      assert.equal(result.text, "answer to plain", `anonymous request ${index} was served, not refused as capacity`);
    }
    assert.ok(await until(() => live().sessions().length === 0), "no anonymous session is retained once its turn is complete");
    assert.equal((await h.pids()).length, 6, "each turn had its own process");
    for (const pid of await h.pids()) assert.ok(await until(() => !alive(pid)), "and each process ended with its turn");
    await gone(h);
    assert.ok(!(await h.sessions()).some(entry => entry.missReason === "capacity"));
  } finally { await h.restore(); }
});

test("an anonymous turn that ends in tool calls cannot be continued: the continuation is refused as session_missing", { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first, { context: {} });
    assert.equal(callIds(a.output).length, 1, "the tool call is handed over");
    assert.ok(await until(() => live().sessions().length === 0), "its session is closed, not parked for the continuation");
    const error = await rejected(turn(provider, [...first, ...a.output, ...outputFor(a.output, "ok")], { context: {} }));
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 400);
    assert.equal(error.upstream?.code, "session_continuity_unavailable");
    assert.match(error.message, /session_missing/);
    await sleep(50);
    assert.equal((await h.pids()).length, 1, "the refusal started no process");
    await gone(h);
  } finally { await h.restore(); }
});

test("a named conversation still parks its session, so the change is limited to anonymous requests", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    await turn(adapter(), [user("start [plain]")]);
    assert.equal(live().sessions().length, 1, "a conversation with an id keeps its process for the next request");
  } finally { await h.restore(); }
});

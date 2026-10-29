import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProviderError } from "../providers/provider.js";
import { folderRemoval, openCopilot, stopCopilotClientsNow } from "../providers/copilot-client.js";
import { copilotRun } from "../providers/copilot.js";
import { copilotPrompts } from "../providers/copilot-render.js";
import { sessionLimits } from "../providers/copilot-live-session.js";
import type { ResponsesInputItem } from "../protocol/types.js";
import { adapter, alive, harness, live, providerId, sleep, turn, until, type Harness } from "./copilot-live-harness.js";
import { shortFolder } from "./short-folder.js";

// A request cancelled while its images are written into the CLI's private folder: the folder goes with the CLI, and nothing writes
// into it, recreates it, or fails the process afterwards. One-shot compaction requests always carry images, so this is not rare.
// The tests hold one image write in flight with a named pipe in the image's place (the write blocks until the test reads), so the
// order of cancellation, teardown and write is exact: no test measures time, and the few waits that show something did NOT happen
// can only make a build that is wrong fail, never a correct one.
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const picture = (bytes: number) => `data:image/png;base64,${Buffer.concat([signature, Buffer.alloc(bytes, 7)]).toString("base64")}`;
/** The images share one data URL (one string, not one per image), so a request with many of them stays small in memory; each is still decoded and written on its own. */
const withImages = (count: number, bytes: number): ResponsesInputItem[] => { const url = picture(bytes); return [{ type: "message", role: "user", content: [{ type: "input_text", text: "look" },
  ...Array.from({ length: count }, () => ({ type: "input_image" as const, image_url: url }))] }]; };
const exists = (path: string) => stat(path).then(() => true, () => false);
const config = { id: providerId, type: "copilot-subscription" as const, models: { alias: "fixture" } };
const modes = ["oneshot", "live"] as const;

/** Collects the unhandled rejections of this process while a test runs. */
function watchRejections() {
  const seen: string[] = []; const listener = (error: unknown) => { seen.push(error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 120) : "non-error"); };
  process.on("unhandledRejection", listener);
  return { seen, stop: () => { process.off("unhandledRejection", listener); } };
}
/** Lets rejections that nobody handled reach the process's event. */
const settle = async () => { for (let round = 0; round < 3; round++) await new Promise(resolve => setImmediate(resolve)); };
const release = (path: string) => writeFile(path, "x");

/**
 * Holds the first image's write in flight. The CLI's answer to `session.create` is held (CREATE_GATE, set by the test before the request
 * starts) until the pipe is in place, so the request has not started to render; `go` lets it render, and `writing` is true once the request's write has put bytes into the
 * pipe (the image is larger than a pipe holds, so the write stays blocked until `drain`).
 */
async function heldWrite(h: Harness) {
  const created = join(h.directory, "create-gate");
  assert.ok(await until(async () => (await h.liveDirs()).length === 1), "the CLI has a folder");
  const folder = join(h.parent, (await h.liveDirs())[0]); const images = join(folder, "images"); const path = join(images, "conversation-message-1-part-2.png");
  await mkdir(images, { mode: 0o700 }); await promisify(execFile)("mkfifo", [path]);
  const reader = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const read = async (): Promise<number | undefined> => reader.read(Buffer.alloc(65536), 0, 65536, null).then(result => result.bytesRead, () => undefined);
  let closed = false;
  return { folder, images, go: () => release(created),
    writing: async () => (await read() ?? 0) > 0,
    /** Reads until the writer has closed the pipe: the write ended. */
    async drain() { while ((await read()) !== 0) await sleep(1); },
    /**
     * For a test that ends, however it ends: reads whatever is written until `close`. A write that stays blocked would keep a thread
     * of the process, which then cannot exit; a failed assertion must fail the test, never hang the run.
     */
    keepDraining() { void (async () => { while (!closed) { await read(); await sleep(2); } })(); },
    async close() { closed = true; await reader.close(); } };
}
type Held = Awaited<ReturnType<typeof heldWrite>>;

for (const mode of modes) {
  test(`a ${mode} request cancelled while an image is being written writes no further image`, { skip: process.platform === "win32", timeout: 60000 }, async () => {
    const h = await harness(); const rejections = watchRejections(); const limit = sessionLimits.abortMs;
    // The CLI answers session.abort only when the test lets it, so the folder is still there when the write ends. The create gate
    // is set before the request starts, and the request's CLI waits on it.
    const abort = join(h.directory, "abort-gate"); process.env.GATEWAY_COPILOT_LIVE_ABORT_GATE = abort; sessionLimits.abortMs = 600000;
    process.env.GATEWAY_COPILOT_LIVE_CREATE_GATE = join(h.directory, "create-gate");
    let held: Held | undefined; let running: Promise<unknown> | undefined;
    try {
      const controller = new AbortController();
      running = turn(adapter({ mode }), withImages(3, 500_000), { controller }).then(() => undefined, error => error as unknown);
      const pipe = held = await heldWrite(h); await pipe.go();
      assert.ok(await until(() => pipe.writing()), "the first image is being written");
      controller.abort(); await pipe.drain();
      // The write has ended; a build that does not stop writes the other two at once. This waits for that for a while: a build
      // that writes nothing more passes however long the wait is.
      assert.equal(await until(async () => (await readdir(pipe.images)).length > 1, 500), false, "no further image was written");
      assert.deepEqual(await readdir(pipe.images), ["conversation-message-1-part-2.png"]);
      await release(abort);
      const error = await running; assert.ok(error instanceof ProviderError && error.code === "cancelled", `the request ends as cancelled: ${String(error)}`);
      assert.ok(await until(() => live().sessions().length === 0), "the session is gone");
      assert.deepEqual(await h.liveDirs(), [], "and its folder");
      await settle(); assert.deepEqual(rejections.seen, [], "no rejection went unhandled");
    } finally {
      // A failed assertion must not leave the CLI waiting for a gate, or a write blocked on the pipe: everything is let go, so that it ends.
      sessionLimits.abortMs = limit; rejections.stop(); held?.keepDraining(); await release(abort); await release(join(h.directory, "create-gate"));
      await running; await h.restore(); await held?.close();
    }
  });

  test(`a ${mode} request cancelled while an image is being written keeps the CLI's folder until that write has ended`, { skip: process.platform === "win32", timeout: 60000 }, async () => {
    const h = await harness(); const rejections = watchRejections();
    process.env.GATEWAY_COPILOT_LIVE_CREATE_GATE = join(h.directory, "create-gate");
    let held: Held | undefined; let running: Promise<unknown> | undefined;
    try {
      const controller = new AbortController();
      running = turn(adapter({ mode }), withImages(3, 500_000), { controller }).then(() => undefined, error => error as unknown);
      const pipe = held = await heldWrite(h); await pipe.go();
      assert.ok(await until(() => pipe.writing()), "the first image is being written");
      controller.abort();
      assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "abort")), "the CLI was told to abort");
      // The CLI answers at once and is then killed and its folder removed - but not while a write is still going into it. A build
      // that removes the folder early fails here (this waits a while for that; a correct build passes however long it waits).
      await sleep(500);
      assert.equal(await exists(pipe.folder), true, "the folder is still there while the write is in flight");
      await pipe.drain();
      const error = await running; assert.ok(error instanceof ProviderError && error.code === "cancelled", `the request ends as cancelled: ${String(error)}`);
      assert.ok(await until(() => live().sessions().length === 0), "the session is gone");
      const [pid] = await h.pids(); assert.ok(pid !== undefined && !alive(pid), "the CLI is gone");
      assert.deepEqual(await h.liveDirs(), [], "and its folder, once the write ended");
      await settle(); assert.deepEqual(rejections.seen, [], "no rejection went unhandled");
    } finally { rejections.stop(); held?.keepDraining(); await release(join(h.directory, "create-gate")); await running; await h.restore(); await held?.close(); }
  });

  test(`a ${mode} request cancelled in the middle of many images ends cancelled, with no folder left and no unhandled rejection`, { timeout: 60000 }, async () => {
    // The CLI never answers session.abort, so its folder is removed at the abort limit: while a great many images are being written.
    const h = await harness(); const rejections = watchRejections(); const limit = sessionLimits.abortMs;
    process.env.GATEWAY_COPILOT_LIVE_SLOW_ABORT = "600000"; sessionLimits.abortMs = 30;
    try {
      const controller = new AbortController();
      const running = turn(adapter({ mode }), withImages(600, 500_000), { controller }).then(() => undefined, error => error as unknown);
      const writing = async () => { for (const name of await h.liveDirs()) if (await exists(join(h.parent, name, "images"))) return true; return false; };
      assert.ok(await until(writing), "the images are being written");
      controller.abort();
      const error = await running; assert.ok(error instanceof ProviderError && error.code === "cancelled", `the request ends as cancelled: ${String(error)}`);
      assert.ok(await until(() => live().sessions().length === 0), "the session is gone");
      const [pid] = await h.pids(); assert.ok(pid !== undefined && !alive(pid), "the CLI is gone");
      assert.deepEqual(await h.liveDirs(), [], "no CLI folder is left, and none was recreated by the writes that were under way");
      assert.ok(!(await h.log()).some(entry => entry.op === "session.sendMessages"), "nothing was sent after the images");
      await settle(); assert.deepEqual(rejections.seen, [], "no rejection went unhandled");
    } finally { sessionLimits.abortMs = limit; rejections.stop(); await h.restore(); }
  });
}

test("a live session that dies while its images are being written serves the request one-shot, not as a cancellation nobody asked for", { skip: process.platform === "win32", timeout: 60000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_CREATE_GATE = join(h.directory, "create-gate");
  let held: Held | undefined; let running: Promise<unknown> | undefined;
  try {
    running = turn(adapter({ mode: "live" }), withImages(3, 500_000)).then(result => result, error => error as unknown);
    const pipe = held = await heldWrite(h); await pipe.go();
    assert.ok(await until(() => pipe.writing()), "the first image is being written");
    // The live CLI dies under the write. The session's end, not a cancellation, is why the rendering stops, and it is the request's error.
    const [pid] = await h.pids(); process.kill(pid, "SIGKILL");
    await pipe.drain();
    const result = await running;
    assert.ok(!(result instanceof Error), `the request was served: ${String(result)}`);
    assert.match((result as { text: string }).text, /^answer/);
    assert.ok((await h.sessions()).some(entry => entry.outcome === "fallback" && entry.missReason === "stream_failed"), "by the one-shot path, after the live session failed");
    assert.deepEqual((await h.pids()).length, 2, "a live CLI and a one-shot CLI");
  } finally { held?.keepDraining(); await release(join(h.directory, "create-gate")); await running; await h.restore(); await held?.close(); }
});

test("staging an image into a folder that was removed fails and recreates nothing", async () => {
  const folder = await shortFolder("gw-stage-");
  try {
    const gone = join(folder.directory, "removed");
    const run = copilotRun({ ...config, copilotSessions: { mode: "oneshot" } }, { model: "fixture", input: withImages(2, 1000) }, new AbortController().signal);
    await assert.rejects(copilotPrompts(run.conversation, run.images, 0, undefined, gone, run.native), error => error instanceof ProviderError && error.code === "cli_failed");
    assert.equal(await exists(gone), false, "the folder was not created again");
    // A folder that exists gets its images folder, and staging into it twice (the folder is already there the second time) works.
    const there = join(folder.directory, "there"); await mkdir(there);
    const [first] = await copilotPrompts(run.conversation, run.images, 0, undefined, there, run.native);
    assert.equal(first.attachments?.length, 2); assert.deepEqual((await readdir(join(there, "images"))).sort(), ["conversation-message-1-part-2.png", "conversation-message-1-part-3.png"]);
  } finally { await folder.remove(); }
});

test("a request that is already over renders no image", async () => {
  const folder = await shortFolder("gw-stage-");
  try {
    const run = copilotRun(config, { model: "fixture", input: withImages(2, 1000) }, new AbortController().signal);
    await assert.rejects(copilotPrompts(run.conversation, run.images, 0, undefined, folder.directory, run.native, () => true), error => error instanceof ProviderError && error.code === "cancelled");
    assert.deepEqual(await readdir(folder.directory), [], "nothing was written");
  } finally { await folder.remove(); }
});

test("closing a CLI whose folder cannot be removed neither rejects nor forgets the folder: the exit handler removes it", { skip: process.platform === "win32" || process.getuid?.() === 0, timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const client = await openCopilot(config);
    // A folder the owner cannot empty: rm fails with EACCES, which it does not retry.
    const locked = join(client.directory, "locked"); await mkdir(locked); await writeFile(join(locked, "file"), "x"); await chmod(locked, 0o500);
    await client.close(undefined, true);
    assert.equal(await exists(client.directory), true, "the folder is still there");
    await chmod(locked, 0o700); stopCopilotClientsNow();
    assert.equal(await exists(client.directory), false, "and the exit handler removed it");
  } finally { await h.restore(); }
});

test("closing a CLI removes its folder with retries, so a removal that runs into something busy is tried again", { timeout: 30000 }, async () => {
  // The retries are Node's, driven by the options the removal is given: this pins the options. (The next test shows the retries working.)
  const h = await harness(); const real = folderRemoval.remove; const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  folderRemoval.remove = (async (path: Parameters<typeof rm>[0], options?: Parameters<typeof rm>[1]) => { calls.push({ path: String(path), options: { ...options } }); return real(path, options); }) as typeof rm;
  try {
    const client = await openCopilot(config); await client.close(undefined, true);
    assert.equal(calls.length, 1, "the folder was removed once"); assert.equal(calls[0].path, client.directory);
    assert.deepEqual([calls[0].options.recursive, calls[0].options.force], [true, true]);
    assert.ok(Number(calls[0].options.maxRetries) >= 3 && Number(calls[0].options.retryDelay) >= 25, `with retries: ${JSON.stringify(calls[0].options)}`);
    assert.equal(await exists(client.directory), false);
  } finally { folderRemoval.remove = real; stopCopilotClientsNow(); await h.restore(); }
});

test("closing a CLI keeps retrying the removal of its folder for as long as something blocks it, and removes it once that is gone", { skip: process.platform !== "darwin" || process.getuid?.() === 0, timeout: 60000 }, async () => {
  // A file with the user-immutable flag cannot be removed (EPERM, which Node retries), whatever the timing: it stands for a busy folder.
  // The retry delay is stretched so that clearing the flag, which is what the test waits for, has seconds to spare, never milliseconds.
  const h = await harness(); const delay = folderRemoval.delayMs; folderRemoval.delayMs = 400; const run = promisify(execFile);
  let blocked: string | undefined;
  try {
    const client = await openCopilot(config); const folder = join(client.directory, "blocked"); await mkdir(folder); blocked = join(folder, "file"); await writeFile(blocked, "x");
    await run("chflags", ["uchg", blocked]);
    let settled = false; const closing = client.close(undefined, true).then(() => { settled = true; });
    // The removal takes everything else away and runs into the file; it has not given up while the file is there.
    assert.ok(await until(async () => (await readdir(client.directory)).join() === "blocked"), "everything but the blocked file was removed");
    await sleep(600);
    assert.equal(settled, false, "the close waits, retrying, while the folder is blocked");
    await run("chflags", ["nouchg", blocked]); blocked = undefined;
    await closing;
    assert.equal(await exists(client.directory), false, "the folder was removed once nothing blocked it");
  } finally {
    folderRemoval.delayMs = delay; if (blocked) await run("chflags", ["nouchg", blocked]).catch(() => {});
    stopCopilotClientsNow(); await h.restore();
  }
});

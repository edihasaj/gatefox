import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageQueuedInput, withStagedQueueInput } from "../queued-attachments.js";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import type { GatewayConfig } from "../config.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-queued-"));
  const state = join(root, "state"); await mkdir(state, { mode: 0o700 });
  const source = async (name: string, content: string | Buffer) => { const path = join(root, name); await writeFile(path, content); return path; };
  const copies = () => readdir(join(state, "queued-attachments")).catch(() => [] as string[]);
  return { root, state, source, copies };
}

test("attached local images and audio are copied privately with their order and extension kept", async () => {
  const f = await fixture();
  const image = await f.source("shot.png", "image-bytes"); const audio = await f.source("note.m4a", "audio-bytes");
  const params = { threadId: "t", clientUserMessageId: "m", input: [{ type: "text", text: "hi" }, { type: "localImage", path: image, detail: "high" }, { type: "mention", name: "x", path: "/abs" },
    { type: "localAudio", path: audio }, { type: "localImage", path: "relative.png" }] };
  const staged = await stageQueuedInput(f.state, params);
  const input = staged.params.input as Array<Record<string, unknown>>;
  assert.deepEqual(input.map(item => item.type), ["text", "localImage", "mention", "localAudio", "localImage"]);
  assert.equal(input[1].detail, "high"); assert.equal(input[2].path, "/abs"); assert.equal(input[4].path, "relative.png", "a relative path is left for the SDK to judge");
  assert.match(String(input[1].path), /queued-attachments\/[0-9a-f-]+\.png$/); assert.match(String(input[3].path), /\.m4a$/);
  assert.equal(await readFile(String(input[1].path), "utf8"), "image-bytes"); assert.equal(await readFile(String(input[3].path), "utf8"), "audio-bytes");
  assert.equal((await stat(join(f.state, "queued-attachments"))).mode & 0o777, 0o700);
  assert.equal((await stat(String(input[1].path))).mode & 0o777, 0o600);
  assert.equal(params.input[1].path, image, "the caller's request is not mutated");
  await staged.release();
  assert.deepEqual(await f.copies(), [], "release removes every copy");
});

test("a request without local media is returned untouched and creates nothing", async () => {
  const f = await fixture();
  const params = { threadId: "t", input: [{ type: "text", text: "hi" }] };
  const staged = await stageQueuedInput(f.state, params);
  assert.equal(staged.params, params);
  assert.deepEqual(await f.copies(), []);
});

test("a source the adapter cannot read is forwarded unchanged and leaves no copy", async () => {
  const f = await fixture();
  const locked = await f.source("locked.png", "x"); await chmod(locked, 0o000);
  const missing = join(f.root, "missing.png");
  const staged = await stageQueuedInput(f.state, { input: [{ type: "localImage", path: locked }, { type: "localImage", path: missing }, { type: "localImage", path: f.root }] });
  try {
    const input = staged.params.input as Array<Record<string, unknown>>;
    assert.equal(input[1].path, missing); assert.equal(input[2].path, f.root, "a directory is not copied");
    // A privileged test run can read a mode 000 file, so only the other runs expect it unchanged.
    if (process.getuid?.() !== 0) { assert.equal(input[0].path, locked); assert.deepEqual(await f.copies(), []); }
  } finally { await chmod(locked, 0o600); await staged.release(); }
});

test("an oversized source is copied only to one byte past the limit so the SDK's own size error applies", async () => {
  const f = await fixture();
  const big = await f.source("big.png", Buffer.alloc(100, 1));
  const staged = await stageQueuedInput(f.state, { input: [{ type: "localImage", path: big }] }, { localImage: 10, localAudio: 10 });
  const copy = String((staged.params.input as Array<Record<string, unknown>>)[0].path);
  assert.equal((await stat(copy)).size, 11);
  await staged.release();
});

test("an error naming a staged copy is mapped back to the file the user attached", async () => {
  const f = await fixture();
  const image = await f.source("shot.png", "x");
  const staged = await stageQueuedInput(f.state, { input: [{ type: "localImage", path: image }] });
  const copy = String((staged.params.input as Array<Record<string, unknown>>)[0].path);
  const error = staged.restore(new Error(`image input is invalid: ${copy}`)) as Error;
  assert.equal(error.message, `image input is invalid: ${image}`);
  await staged.release();
});

test("a queue call forwarded to a shared native SDK is staged and cleaned up by the backend", async () => {
  const f = await fixture();
  const image = await f.source("shot.png", "image-bytes");
  const forwarded: Array<Record<string, unknown>> = [];
  // A shared original-native SDK is a service-owned process: it is not granted the app's file access.
  const native = { shared: true, closed: false, exited: new Promise<never>(() => {}), drained: Promise.resolve(), ready: Promise.resolve(),
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return { thread: { id: params.threadId, modelProvider: "openai" } };
      if (method !== "thread/queue/add") return {};
      const input = params.input as Array<Record<string, unknown>>; forwarded.push(input[0]);
      return { readPath: String(input[0].path), size: (await readFile(String(input[0].path))).length };
    },
    send() {}, stop() {} };
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: f.state, providers: [] };
  const backends = new AppServerBackends("codex", ["app-server"], config, {}, {}, {} as DesktopCatalog, async () => {}, () => {}, undefined, () => native);
  const result = await backends.request("thread/queue/add", { threadId: "native-chat", clientUserMessageId: "m1", input: [{ type: "localImage", path: image }] });
  assert.match(String(result.readPath), new RegExp(`queued-attachments\\/[0-9a-f-]+\\.png$`));
  assert.equal(result.size, 11, "the shared SDK read the copy's own bytes");
  assert.equal(forwarded.length, 1); assert.equal(String(forwarded[0].type), "localImage");
  assert.equal(await readFile(image, "utf8"), "image-bytes", "the attached file is never moved or edited");
  assert.deepEqual(await f.copies(), [], "the copy does not outlive the call");
});

test("copies older than ten minutes left by a crash are removed on the first stage", async () => {
  const f = await fixture();
  const directory = join(f.state, "queued-attachments"); await mkdir(directory, { mode: 0o700 });
  const stale = join(directory, "old.png"); const fresh = join(directory, "new.png");
  await writeFile(stale, "x"); await writeFile(fresh, "x");
  const old = new Date(Date.now() - 11 * 60 * 1000); await utimes(stale, old, old);
  const image = await f.source("shot.png", "x");
  const staged = await stageQueuedInput(f.state, { input: [{ type: "localImage", path: image }] });
  assert.ok(!(await f.copies()).includes("old.png")); assert.ok((await f.copies()).includes("new.png"));
  await staged.release();
});

test("only queue methods are staged, and copies are removed even when the call fails", async () => {
  const f = await fixture();
  const image = await f.source("shot.png", "x");
  const params = { input: [{ type: "localImage", path: image }] };
  let seen: unknown;
  await withStagedQueueInput(f.state, "turn/start", params, async value => { seen = value; return {}; });
  assert.equal(seen, params, "turn/start is forwarded as is");
  await assert.rejects(withStagedQueueInput(f.state, "thread/queue/add", params, async value => {
    assert.notEqual((value.input as Array<Record<string, unknown>>)[0].path, image);
    throw new Error("sdk failed");
  }), /sdk failed/);
  assert.deepEqual(await f.copies(), []);
});

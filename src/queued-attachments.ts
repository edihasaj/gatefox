import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

type Message = Record<string, unknown>;
export interface StagedInput { params: Message; restore: (error: unknown) => unknown; release: () => Promise<void> }
export interface MediaLimits { localImage: number; localAudio: number }

/** Queue methods whose SDK reads attached local files while enqueueing, not at turn time. */
export const queuedInputMethods = new Set(["thread/queue/add", "thread/queue/update"]);
// The SDK's own bounds (MAX_PROMPT_IMAGE_INPUT_BYTES and MAX_PROMPT_AUDIO_INPUT_BYTES).
const defaultLimits: MediaLimits = { localImage: 1024 * 1024 * 1024, localAudio: 50 * 1024 * 1024 };
const staleMs = 10 * 60 * 1000;
const directoryName = "queued-attachments";
const swept = new Set<string>();
const object = (value: unknown): Message => value && typeof value === "object" && !Array.isArray(value) ? value as Message : {};

/** Copy at most limit+1 bytes: an oversized source stays oversized, so the SDK's own size error still applies. */
async function copyBounded(source: string, target: string, limit: number): Promise<void> {
  let remaining = limit + 1;
  const bound = new Transform({ transform(chunk: Buffer, _encoding, done) {
    if (remaining <= 0) { done(); return; }
    const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    remaining -= part.length; done(null, part);
  } });
  await pipeline(createReadStream(source), bound, createWriteStream(target, { flags: "wx", mode: 0o600 }));
}

/** A crash can leave copies behind; remove any older than a queue call could plausibly take. */
async function sweep(directory: string): Promise<void> {
  if (swept.has(directory)) return;
  swept.add(directory);
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const path = resolve(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && Date.now() - info.mtimeMs > staleMs) await unlink(path).catch(() => {});
  }
}

/**
 * macOS grants file access to the desktop app, not to the service that owns shared
 * executors. The adapter runs under the app, so it copies each attached local image or
 * audio file into the gateway's private state directory, where the executor can read it.
 * A source the adapter cannot read either is left untouched, so the SDK reports its own error.
 * Paths and file contents are never logged.
 */
export async function stageQueuedInput(stateDirectory: string, params: Message, limits: MediaLimits = defaultLimits): Promise<StagedInput> {
  const input = Array.isArray(params.input) ? params.input : undefined;
  const staged = new Map<string, string>();
  const release = async () => { await Promise.all([...staged.keys()].map(path => unlink(path).catch(() => {}))); staged.clear(); };
  const restore = (error: unknown): unknown => {
    if (!(error instanceof Error) || !staged.size) return error;
    let message = error.message;
    for (const [copy, original] of staged) message = message.split(copy).join(original);
    if (message !== error.message) error.message = message;
    return error;
  };
  if (!input || !input.some(item => ["localImage", "localAudio"].includes(String(object(item).type)))) return { params, restore, release };
  const directory = resolve(stateDirectory, directoryName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await sweep(directory);
  const rewritten: unknown[] = [];
  try {
    for (const item of input) {
      const entry = object(item); const type = String(entry.type);
      const limit = type === "localImage" ? limits.localImage : type === "localAudio" ? limits.localAudio : undefined;
      const source = entry.path;
      if (limit === undefined || typeof source !== "string" || !isAbsolute(source)) { rewritten.push(item); continue; }
      const target = resolve(directory, randomUUID() + extname(source));
      try {
        // Only regular files are copied; a pipe or device could block the adapter.
        if (!(await stat(source)).isFile()) throw new Error("not a regular file");
        await copyBounded(source, target, limit);
      }
      catch {
        // An unreadable source (or a failed copy) is forwarded as is for the SDK to judge.
        await unlink(target).catch(() => {});
        rewritten.push(item); continue;
      }
      staged.set(target, source); rewritten.push({ ...entry, path: target });
    }
  } catch (error) { await release(); throw error; }
  return { params: { ...params, input: rewritten }, restore, release };
}

/** Run a forwarded queue call with its local attachments staged, and always remove the copies. */
export async function withStagedQueueInput(stateDirectory: string, method: string, params: Message, send: (params: Message) => Promise<Message>): Promise<Message> {
  if (!queuedInputMethods.has(method)) return send(params);
  const staged = await stageQueuedInput(stateDirectory, params);
  try { return await send(staged.params); }
  catch (error) { throw staged.restore(error); }
  finally { await staged.release(); }
}

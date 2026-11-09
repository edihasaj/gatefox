import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

/** The provider id chats saved before 1.8.0 carry, and the one GateFox records since. */
export const legacyChatProvider = "subscription_gateway";
export const gatefoxChatProvider = "gatefox";

export interface ChatMigrateOptions {
  codexHome?: string;
  apply?: boolean;
  /** Moves migrated chats back to the old id. */
  revert?: boolean;
  /** Processes that hold the chat store; apply refuses while any runs. */
  busy?: () => Promise<string[]>;
  now?: () => Date;
}
export interface ChatMigrateResult {
  codexHome: string; from: string; to: string; applied: boolean;
  chats: number; rolloutsToRewrite: number; rolloutsRewritten: number; rolloutsAlreadyMoved: number; rolloutsMissing: number;
  skipped: Array<{ id: string; reason: string }>; databaseBackup?: string;
}
interface Row { id: string; rollout_path: string }
interface Statement { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown }
interface Database { prepare(sql: string): Statement; exec(sql: string): void; close(): void }

const marker = (provider: string) => `"model_provider":${JSON.stringify(provider)}`;
const maxFirstLine = 4 * 1024 * 1024;

/** ChatGPT, every Codex app-server and the GateFox service read or write the chat store. */
async function defaultBusy(): Promise<string[]> {
  const { stdout } = await promisify(execFile)("/bin/ps", ["-axo", "pid=,command="], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split("\n").map(line => line.trim()).filter(line =>
    /ChatGPT\.app\/Contents\/MacOS\/ChatGPT( |$)|\bapp-server\b|dist\/cli\.js (daemon|serve|codex-shim)\b/.test(line))
    .map(line => line.slice(0, 160));
}

async function openDatabase(path: string, readOnly: boolean): Promise<Database> {
  const { DatabaseSync } = await import("node:sqlite") as unknown as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database };
  return new DatabaseSync(path, { readOnly });
}

/** The first line of a rollout and the bytes it occupies with its newline, without reading the rest of a large file. */
async function firstLine(path: string): Promise<{ line: string; bytes: number }> {
  const file = await open(path, "r");
  try {
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024); const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      const slice = buffer.subarray(0, bytesRead), newline = slice.indexOf(10);
      if (newline >= 0) { chunks.push(slice.subarray(0, newline)); return { line: Buffer.concat(chunks).toString("utf8"), bytes: total + newline + 1 }; }
      chunks.push(slice); total += bytesRead;
      if (total > maxFirstLine) throw new Error("first line too large");
    }
    return { line: Buffer.concat(chunks).toString("utf8"), bytes: total };
  } finally { await file.close(); }
}

/** The first line of a zstd-compressed rollout, decompressing only as far as its newline. */
async function firstCompressedLine(path: string): Promise<string> {
  const input = createReadStream(path), output = input.pipe(createZstdDecompress());
  const chunks: Buffer[] = []; let total = 0;
  try {
    for await (const chunk of output as AsyncIterable<Buffer>) {
      const newline = chunk.indexOf(10);
      if (newline >= 0) { chunks.push(chunk.subarray(0, newline)); break; }
      chunks.push(chunk); total += chunk.length;
      if (total > maxFirstLine) throw new Error("first line too large");
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { input.destroy(); output.destroy(); }
}

/** Replaces the first line once and passes every later byte through unchanged. */
function firstLineReplacer(line: string): Transform {
  let pending: Buffer[] = [], done = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (done) return callback(null, chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) { pending.push(chunk); return callback(); }
      done = true; pending = [];
      callback(null, Buffer.concat([Buffer.from(line + "\n"), chunk.subarray(newline + 1)]));
    },
    flush(callback) { callback(done ? null : new Error("rollout has no complete first line")); },
  });
}

type Plan = { kind: "rewrite"; line: string; bytes: number; file: string; compressed: boolean } | { kind: "moved" } | { kind: "missing" } | { kind: "skip"; reason: string };
async function planRollout(path: string, from: string, to: string): Promise<Plan> {
  // The engine compresses older rollouts to `<path>.zst` and keeps the recorded path.
  let file = path, info = await lstat(path).catch(() => undefined), compressed = false;
  if (!info) { file = `${path}.zst`; info = await lstat(file).catch(() => undefined); compressed = true; }
  if (!info) return { kind: "missing" };
  if (!info.isFile()) return { kind: "skip", reason: "rollout is not a regular file" };
  const read = compressed ? await firstCompressedLine(file).then(line => ({ line, bytes: 0 }), () => undefined) : await firstLine(file).catch(() => undefined);
  if (!read) return { kind: "skip", reason: "rollout is unreadable" };
  let meta: { type?: unknown; payload?: { model_provider?: unknown } } | undefined;
  try { meta = JSON.parse(read.line); } catch { return { kind: "skip", reason: "first line is not JSON" }; }
  if (meta?.type !== "session_meta") return { kind: "skip", reason: "first line is not session_meta" };
  const provider = meta.payload?.model_provider;
  if (provider === to) return { kind: "moved" };
  if (provider !== from || read.line.split(marker(from)).length !== 2) return { kind: "skip", reason: "session_meta names another provider" };
  return { kind: "rewrite", line: read.line.replace(marker(from), marker(to)), bytes: read.bytes, file, compressed };
}

/** Writes the new first line and the unchanged rest beside the rollout, then replaces it only if it did not change meanwhile. */
async function rewriteRollout(plan: Extract<Plan, { kind: "rewrite" }>): Promise<boolean> {
  const path = plan.file, before = await stat(path), temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.gatefox`);
  try {
    const output = createWriteStream(temporary, { flags: "wx", mode: before.mode & 0o777 });
    if (plan.compressed) await pipeline(createReadStream(path), createZstdDecompress(), firstLineReplacer(plan.line), createZstdCompress(), output);
    else { output.write(plan.line + "\n"); await pipeline(createReadStream(path, { start: plan.bytes }) as Readable, output); }
    await chmod(temporary, before.mode & 0o777);
    const after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) return false;
    await rename(temporary, path);
    return true;
  } finally { await unlink(temporary).catch(() => undefined); }
}

/**
 * Moves saved chats from `subscription_gateway` to `gatefox` (or back with `revert`). Rollouts change first, then the
 * database in one transaction after a full copy of it, so an interrupted run is finished by running it again. A dry run
 * changes nothing. Apply needs ChatGPT and the GateFox service stopped, and the target provider row in config.toml.
 */
export async function migrateChats(options: ChatMigrateOptions = {}): Promise<ChatMigrateResult> {
  const codexHome = resolve(options.codexHome ?? join(homedir(), ".codex"));
  const [from, to] = options.revert ? [gatefoxChatProvider, legacyChatProvider] : [legacyChatProvider, gatefoxChatProvider];
  const result: ChatMigrateResult = { codexHome, from, to, applied: false, chats: 0, rolloutsToRewrite: 0, rolloutsRewritten: 0, rolloutsAlreadyMoved: 0, rolloutsMissing: 0, skipped: [] };
  if (options.apply) {
    const config = await readFile(join(codexHome, "config.toml"), "utf8").catch(() => "");
    if (!config.split("\n").some(line => line.trim() === `[model_providers.${to}]`)) throw new Error(`config.toml has no [model_providers.${to}] row; run gateway desktop register first`);
    const busy = await (options.busy ?? defaultBusy)();
    if (busy.length) throw new Error(`Quit ChatGPT and stop the GateFox service first; still running:\n${busy.join("\n")}`);
  }
  const database = await openDatabase(join(codexHome, "state_5.sqlite"), !options.apply);
  try {
    const rows = database.prepare("SELECT id, rollout_path FROM threads WHERE model_provider = ?").all(from) as Row[];
    result.chats = rows.length;
    const ready: string[] = [];
    for (const row of rows) {
      const plan = await planRollout(row.rollout_path, from, to);
      if (plan.kind === "skip") { result.skipped.push({ id: row.id, reason: plan.reason }); continue; }
      if (plan.kind === "missing") { result.rolloutsMissing++; ready.push(row.id); continue; }
      if (plan.kind === "moved") { result.rolloutsAlreadyMoved++; ready.push(row.id); continue; }
      result.rolloutsToRewrite++;
      if (!options.apply) continue;
      if (await rewriteRollout(plan)) { result.rolloutsRewritten++; ready.push(row.id); }
      else result.skipped.push({ id: row.id, reason: "rollout changed during the rewrite; run again" });
    }
    if (!options.apply) return result;
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    result.databaseBackup = join(codexHome, `state_5.sqlite.before-gatefox-chats-${stamp}`);
    database.prepare("VACUUM INTO ?").run(result.databaseBackup);
    const update = database.prepare("UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?");
    database.exec("BEGIN IMMEDIATE");
    try { for (const id of ready) update.run(to, id, from); database.exec("COMMIT"); }
    catch (error) { database.exec("ROLLBACK"); throw error; }
    result.applied = true;
    return result;
  } finally { database.close(); }
}

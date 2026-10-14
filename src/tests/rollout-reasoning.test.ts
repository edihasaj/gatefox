import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRolloutReasoning } from "../rollout-reasoning.js";

const id = "0194f-chat";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollout-"));
  const native = join(root, "native"); const sessions = join(native, "sessions"); const archived = join(native, "archived_sessions");
  await mkdir(sessions, { recursive: true, mode: 0o700 }); await mkdir(archived, { mode: 0o700 });
  const file = async (name: string, lines: Array<string | Buffer>, directory = sessions) => {
    const path = join(directory, name);
    await writeFile(path, lines.map(line => typeof line === "string" ? line + "\n" : line).join("")); return path;
  };
  const read = (path: unknown, threadId = id, home = native) => readRolloutReasoning(path, threadId, home);
  return { root, native, sessions, archived, file, read };
}
const context = (payload: Record<string, unknown>) => JSON.stringify({ type: "turn_context", payload });

test("the newest reasoning record wins, and later unknowns keep earlier levels", async () => {
  const f = await fixture();
  assert.deepEqual(await f.read(await f.file(`rollout-2026-10-13-${id}.jsonl`, [
    context({ effort: "low" }), context({ model: "gpt-x", effort: "max", summary: "detailed" }), context({ effort: null }), context({ summary: null }),
  ])), { effort: "max", summary: "detailed", model: "gpt-x" });
  assert.deepEqual(await f.read(await f.file(`rollout-b-${id}.jsonl`, [context({ effort: "high" }), context({ effort: null })])), { effort: "high" });
  assert.equal(await f.read(await f.file(`rollout-c-${id}.jsonl`, [context({ effort: null })])), undefined, "a null effort records nothing");
  assert.equal(await f.read(await f.file(`rollout-d-${id}.jsonl`, [])), undefined, "an empty rollout carries nothing");
  assert.equal(await f.read(await f.file(`rollout-e-${id}.jsonl`, [context({ effort: "low" })]), "different-chat"), undefined, "a rollout belongs to the chat named in it");
});

test("effort arrives from settings fields and the collaboration mode that carries it", async () => {
  const f = await fixture();
  assert.deepEqual(await f.read(await f.file(`rollout-f-${id}.jsonl`, [context({ reasoning_effort: "xhigh" })])), { effort: "xhigh" });
  assert.deepEqual(await f.read(await f.file(`rollout-g-${id}.jsonl`, [context({ model: "gpt-y", collaboration_mode: { settings: { reasoning_effort: "medium" } } })])), { effort: "medium", model: "gpt-y" });
  const applied = JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: id, thread_settings: { reasoning_effort: "high", reasoning_summary: "concise", model: "gpt-z" } } });
  assert.deepEqual(await f.read(await f.file(`rollout-h-${id}.jsonl`, [applied])), { effort: "high", summary: "concise", model: "gpt-z" });
});

test("settings copied from another chat id are not this chat's reasoning", async () => {
  const f = await fixture();
  const applied = JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "0194f-parent", thread_settings: { effort: "ultra" } } });
  assert.equal(await f.read(await f.file(`rollout-i-${id}.jsonl`, [applied])), undefined);
  assert.deepEqual(await f.read(await f.file(`rollout-j-${id}.jsonl`, [applied, context({ effort: "low" })])), { effort: "low" });
});

test("only marker lines are parsed, including across a filler line larger than one chunk", async () => {
  const f = await fixture();
  const filler = `{"type":"event_msg","payload":{"type":"token_count","info":{"total":${"9".repeat(300 * 1024)}}}}`;
  assert.ok(!filler.includes("turn_context") && !filler.includes("thread_settings_applied"), "the filler carries no scan marker");
  assert.deepEqual(await f.read(await f.file(`rollout-k-${id}.jsonl`, [context({ effort: "medium" }), filler, filler])), { effort: "medium" });
  assert.deepEqual(await f.read(await f.file(`rollout-l-${id}.jsonl`, [filler, context({ effort: "low" }), filler])), { effort: "low" });
  assert.deepEqual(await f.read(await f.file(`rollout-m-${id}.jsonl`, [context({ effort: "high" }), `{"turn_context torn`])), { effort: "high" }, "a torn marker line is skipped, not parsed");
  assert.deepEqual(await readRolloutReasoning(await f.file(`rollout-n-${id}.jsonl`, [context({ effort: "low" }), context({ effort: "max" })]), id, f.native, { chunk: 4096 }), { effort: "max" }, "a small chunk still reaches the end");
});

test("rollout files outside the session homes and oversized rollouts are refused", async () => {
  const f = await fixture();
  assert.equal(await f.read(await f.file(`rollout-p-${id}.jsonl`, [context({ effort: "max" })], f.native)), undefined, "only session directories are sources");
  assert.deepEqual(await f.read(await f.file(`rollout-q-${id}.jsonl`, [context({ effort: "max" })], f.archived)), { effort: "max" }, "archived sessions still count as the chat's own");
  assert.equal(await f.read(await f.file(`notes-${id}.jsonl`, [context({ effort: "max" })])), undefined, "the name must identify a rollout");
  assert.equal(await f.read(join(f.sessions, `rollout-r-${id}.jsonl`)), undefined, "a missing file is not an error");
  assert.equal(await f.read(42), undefined);
  const outside = await f.file(`rollout-s-${id}.jsonl`, [context({ effort: "max" })], f.root);
  await symlink(outside, join(f.sessions, `rollout-t-${id}.jsonl`));
  assert.equal(await f.read(join(f.sessions, `rollout-t-${id}.jsonl`)), undefined, "a symlink out of the session home is refused");
  const real = await mkdtemp(join(tmpdir(), "gateway-rollout-home-")); const link = join(f.root, "executor-home"); await symlink(real, link);
  await mkdir(join(real, "sessions"), { recursive: true });
  assert.deepEqual(await f.read(await f.file(`rollout-u-${id}.jsonl`, [context({ effort: "low" })], join(real, "sessions")), id, link), { effort: "low" }, "an executor home that is itself a symlink resolves");
  assert.equal(await f.read(await f.file(`rollout-v-${id}.jsonl`, [Buffer.concat([Buffer.from("x".repeat(16 * 1024 * 1024))])]), id, f.native), undefined, "a rollout past the 16 MiB cap is skipped");
});

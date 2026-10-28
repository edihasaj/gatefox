import test from "node:test";
import assert from "node:assert/strict";
import { ProjectTrustPolicy } from "../project-trust-policy.js";
import { object, type Message } from "../app-server-connection.js";
import { parseKeyPath } from "../app-server-config-writes-key-path.js";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture() {
  const calls: Array<{ method: string; params: Message }> = [];
  const config: Message = { projects: {}, sandbox_mode: "read-only", approval_policy: "on-request" };
  const state = { version: 0, conflict: 0, failed: false, overridden: false, verifyFails: false, userAvailable: true };
  const roots = ["/registered/one", "/registered/two"];
  const raw = async (method: string, params: Message): Promise<Message> => {
    calls.push({ method, params });
    if (method === "config/read") return structuredClone({ config, layers: state.userAvailable ? [{ name: { type: "user", file: "/native/config.toml" }, version: String(state.version), config }] : [] });
    if (method === "project/list") return { data: [{ roots: [{ path: params.cursor ? roots[1] : roots[0] }] }], nextCursor: params.cursor ? null : "next" };
    if (method === "config/batchWrite") {
      if (state.failed) throw new Error("fixture-write-failed");
      if (state.conflict-- > 0) throw Object.assign(new Error("version conflict"), { data: { config_write_error_code: "configVersionConflict" } });
      assert.equal(params.expectedVersion, String(state.version));
      if (state.overridden) return { status: "okOverridden" };
      for (const edit of params.edits as Message[]) {
        const key = parseKeyPath(String(edit.keyPath)); assert(key); assert.equal(key[0], "projects"); assert.equal(key[2], "trust_level");
        if (!state.verifyFails) object(config.projects)[key[1]] = { ...object(object(config.projects)[key[1]]), trust_level: edit.value };
      }
      state.version++; return { status: "ok" };
    }
    if (method === "thread/read") return { thread: { cwd: "/saved/project" } };
    return {};
  };
  return { calls, config, state, raw, policy: new ProjectTrustPolicy(raw) };
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c.method === "config/batchWrite");

test("config reads persist paginated registered roots and a newly selected cwd, returning genuine layers", async () => {
  const f = fixture();
  const result = await f.policy.request("config/read", { cwd: "/new/project", includeLayers: true });
  const projects = object(object(result.config).projects);
  for (const path of ["/registered/one", "/registered/two", "/new/project"]) assert.equal(object(projects[path]).trust_level, "trusted");
  assert.deepEqual(projects, object(object((result.layers as Message[])[0].config).projects));
  assert.equal(writes(f).length, 1);
  assert.equal(object(result.config).approval_policy, "on-request"); assert.equal(object(result.config).sandbox_mode, "read-only");
  await f.policy.request("config/read", { cwd: "/new/project" }); assert.equal(writes(f).length, 1);
});

test("a previously untrusted folder follows the operator's all-projects choice without dropping other project keys", async () => {
  const f = fixture(); object(f.config.projects)["/new/project"] = { trust_level: "untrusted", unrelated: true };
  await f.policy.request("thread/start", { cwd: "/new/project" });
  assert.deepEqual(object(f.config.projects)["/new/project"], { trust_level: "trusted", unrelated: true });
});

for (const method of ["project/create", "project/import", "project/update", "project/move", "project/read"]) test(`${method} trusts the actual returned roots and preserves its response`, async () => {
  const f = fixture(); const result = { project: { roots: [{ path: "/new/project" }] }, extra: "retained" };
  assert.equal(await f.policy.request(method, { caller: "unchanged" }, async () => result), result);
  assert.equal(object(object(f.config.projects)["/new/project"]).trust_level, "trusted");
});

for (const method of ["thread/resume", "thread/fork"]) test(`${method} uses the saved cwd when the caller supplied none`, async () => {
  const f = fixture(); const params = { threadId: "saved", approvalPolicy: "never", sandbox: "read-only" };
  const result = { original: true };
  assert.equal(await f.policy.request(method, params, async () => { assert.equal(object(object(f.config.projects)["/saved/project"]).trust_level, "trusted"); return result; }), result);
  assert.equal(f.calls[0].method, "thread/read"); assert.deepEqual(params, { threadId: "saved", approvalPolicy: "never", sandbox: "read-only" });
});

test("prediction forks and unrelated methods issue no trust calls", async () => {
  const f = fixture(); const result = {};
  await f.policy.request("thread/fork", { threadId: "saved", experimentalPredictionMode: true }, async () => result);
  await f.policy.request("turn/start", { threadId: "saved" }, async () => result);
  assert.equal(f.calls.length, 0);
});

test("quoted folder paths round-trip through the engine key parser", async () => {
  const f = fixture(); const path = '/work/a.b/"quoted"/back\\slash';
  await f.policy.request("thread/start", { cwd: path });
  assert.equal(object(object(f.config.projects)[path]).trust_level, "trusted");
});

test("version conflicts re-read the native layer, while other errors are never retried", async () => {
  const f = fixture(); f.state.conflict = 2;
  await f.policy.request("thread/start", { cwd: "/new/project" }); assert.equal(writes(f).length, 3);
  const failed = fixture(); failed.state.failed = true;
  await assert.rejects(failed.policy.request("thread/start", { cwd: "/new/project" }), /fixture-write-failed/);
  assert.equal(writes(failed).length, 1);
  failed.state.failed = false; await failed.policy.request("thread/start", { cwd: "/new/project" });
});

for (const flag of ["overridden", "verifyFails", "userAvailable"] as const) test(`cannot claim trust when ${flag} prevents native persistence`, async () => {
  const f = fixture(); f.state[flag] = flag !== "userAvailable";
  let sent = false;
  await assert.rejects(f.policy.request("thread/start", { cwd: "/new/project" }, async () => { sent = true; return {}; }));
  assert.equal(sent, false);
});

test("invalid or oversized paths fail before writing or loading", async () => {
  for (const cwd of ["relative", "/with\nnewline", "/" + "x".repeat(4096)]) {
    const f = fixture(); await assert.rejects(f.policy.request("thread/start", { cwd })); assert.equal(f.calls.length, 0);
  }
});

test("concurrent trust changes serialize without overwriting another caller's folder", async () => {
  const f = fixture(); await Promise.all(["/one", "/two"].map(cwd => f.policy.request("thread/start", { cwd })));
  assert.equal(object(object(f.config.projects)["/one"]).trust_level, "trusted");
  assert.equal(object(object(f.config.projects)["/two"]).trust_level, "trusted");
  assert.equal(writes(f).length, 2);
});

test("an untrusted canonical folder cannot override trust through a selected alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "trust-alias-"));
  try {
    const original = join(root, "original"); const alias = join(root, "alias");
    await mkdir(original); await symlink(original, alias);
    const canonical = await realpath(original); const f = fixture();
    object(f.config.projects)[canonical] = { trust_level: "untrusted" };
    await f.policy.request("thread/start", { cwd: alias });
    for (const path of [alias, canonical]) assert.equal(object(object(f.config.projects)[path]).trust_level, "trusted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a start with no cwd trusts the authoritative default before loading and keeps caller params intact", async () => {
  const f = fixture(); const policy = new ProjectTrustPolicy(f.raw, "/engine/default"); const params = { sandbox: "read-only" };
  await policy.request("thread/start", params, async () => {
    assert.equal(object(object(f.config.projects)["/engine/default"]).trust_level, "trusted");
    assert.deepEqual(params, { sandbox: "read-only" }); return {};
  });
  let sent = false;
  await assert.rejects(f.policy.request("thread/start", {}, async () => { sent = true; return {}; }), /default folder is unavailable/);
  assert.equal(sent, false);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, lstat, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePrivateDirectory, mutateConfig, readSnapshot, writeOwnedJson } from "../app-management/storage.js";

async function workspace(): Promise<string> { return mkdtemp(join(tmpdir(), "harness-storage-")); }

function validRaw(): Record<string, unknown> {
  return {
    version: 1, port: 8123, stateDirectory: ".state", preservedUnknown: { enabled: true },
    providers: [{ id: "codex", type: "codex-subscription", models: { default: "gpt-5" }, credentialFile: "credentials/placeholder.json" }],
  };
}

async function privateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

test("reads valid raw config without changing unknown fields", async () => {
  const directory = await workspace(); const path = join(directory, "gateway.json");
  await privateJson(path, validRaw());
  const snapshot = await readSnapshot(path);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.raw.preservedUnknown, { enabled: true });
  assert.equal(snapshot.config.providers[0]?.credentialFile, join(directory, "credentials/placeholder.json"));
});

test("refuses stale revisions and an exclusive new destination that already exists", async () => {
  const directory = await workspace(); const path = join(directory, "gateway.json");
  await privateJson(path, validRaw());
  await assert.rejects(mutateConfig(path, "stale", async snapshot => snapshot!.raw), { code: "configuration_changed" });
  await assert.rejects(mutateConfig(path, undefined, async () => validRaw()), { code: "configuration_changed" });
  await assert.rejects(writeOwnedJson(path, validRaw(), true), { code: "configuration_changed" });
});

test("does not write a no-op mutation", async () => {
  const directory = await workspace(); const path = join(directory, "gateway.json");
  await privateJson(path, validRaw());
  const before = await readFile(path); const beforeInfo = await lstat(path);
  const snapshot = await readSnapshot(path);
  assert.ok(snapshot);
  await mutateConfig(path, snapshot.revision, async current => current!.raw);
  assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), createHash("sha256").update(before).digest("hex"));
  assert.equal((await lstat(path)).mtimeMs, beforeInfo.mtimeMs);
});

test("refuses a symlink and does not disclose invalid JSON", async () => {
  const directory = await workspace(); const target = join(directory, "target.json"); const link = join(directory, "gateway.json");
  await privateJson(target, validRaw()); await symlink(target, link);
  await assert.rejects(readSnapshot(link), { code: "unsafe_path" });
  const invalid = join(directory, "invalid.json"); const secret = "do-not-disclose-this";
  await writeFile(invalid, `{${secret}`, { mode: 0o600 });
  await assert.rejects(readSnapshot(invalid), error => {
    assert.equal((error as { code?: string }).code, "invalid_configuration");
    assert.doesNotMatch((error as Error).message, new RegExp(secret));
    return true;
  });
  await assert.rejects(writeOwnedJson(link, validRaw()), { code: "unsafe_path" });
});

test("new files and backups are private", async () => {
  const directory = await workspace(); const path = join(directory, "gateway.json");
  const initial = await mutateConfig(path, undefined, async () => validRaw());
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  await mutateConfig(path, initial.revision, async current => ({ ...current!.raw, port: 8124 }));
  const backups = await readdir(join(directory, "app-backups"));
  assert.equal(backups.length, 1);
  assert.equal((await lstat(join(directory, "app-backups", backups[0]!))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(directory, "app-backups"))).mode & 0o777, 0o700);
});

test("rejects symlink ancestors before touching configuration, cache, or backup targets", async () => {
  const directory = await workspace(); const outside = await workspace();
  const marker = join(outside, "OUTSIDE.json"); await writeFile(marker, "OUTSIDE\n", { mode: 0o644 }); await chmod(marker, 0o644);
  const markerMode = (await lstat(marker)).mode & 0o777;

  const linkedParent = join(directory, "linked-parent"); await symlink(outside, linkedParent);
  await assert.rejects(mutateConfig(join(linkedParent, "gateway.json"), undefined, async () => validRaw()), { code: "unsafe_path" });
  assert.equal(await readFile(marker, "utf8"), "OUTSIDE\n");
  assert.equal((await lstat(marker)).mode & 0o777, markerMode);

  const cacheDirectory = join(directory, "app-cache"); await symlink(outside, cacheDirectory);
  await assert.rejects(writeOwnedJson(join(cacheDirectory, "catalog.json"), { version: 1 }), { code: "unsafe_path" });
  assert.equal(await readFile(marker, "utf8"), "OUTSIDE\n");
  assert.equal((await lstat(marker)).mode & 0o777, markerMode);

  const configPath = join(directory, "gateway.json"); await privateJson(configPath, validRaw());
  const snapshot = await readSnapshot(configPath); assert.ok(snapshot);
  await symlink(outside, join(directory, "app-backups"));
  await assert.rejects(mutateConfig(configPath, snapshot.revision, async current => ({ ...current!.raw, port: 8124 })), { code: "unsafe_path" });
  assert.equal(await readFile(marker, "utf8"), "OUTSIDE\n");
  assert.equal((await lstat(marker)).mode & 0o777, markerMode);
  assert.deepEqual((await readSnapshot(configPath))!.raw, validRaw());
});

test("does not chmod an existing configuration parent for an invalid revision", async () => {
  const directory = await workspace(); const path = join(directory, "gateway.json");
  await privateJson(path, validRaw()); await chmod(directory, 0o755);
  await assert.rejects(mutateConfig(path, "stale", async current => current!.raw), { code: "configuration_changed" });
  assert.equal((await lstat(directory)).mode & 0o777, 0o755);
});

test("replaces an owned 0644 configuration with a private file", async () => {
  const directory = await workspace(); const path = join(directory, "gateway.json");
  await privateJson(path, validRaw()); await chmod(path, 0o644);
  const snapshot = await readSnapshot(path); assert.ok(snapshot);
  const saved = await mutateConfig(path, snapshot.revision, async current => ({ ...current!.raw, port: 8124 }));
  assert.equal(saved.raw.port, 8124);
  assert.deepEqual(saved.raw.preservedUnknown, { enabled: true });
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test("allows the standard temporary-directory alias and creates private directories", async () => {
  const directory = await workspace(); const path = join(directory, "gateway.json");
  await privateJson(path, validRaw());
  assert.ok(await readSnapshot(path));
  const privateDirectory = join(directory, "app-state", "credentials");
  await ensurePrivateDirectory(privateDirectory);
  assert.equal((await lstat(join(directory, "app-state"))).mode & 0o777, 0o700);
  assert.equal((await lstat(privateDirectory)).mode & 0o777, 0o700);
});

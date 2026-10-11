import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPrivateFileLock } from "../private-file-lock.js";

test("private preference locks recover a dead writer and release after a failed update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  await writeFile(`${path}.lock`, "2147483647", { mode: 0o600 });
  await assert.rejects(withPrivateFileLock(path, async () => { throw new Error("failed update"); }), /failed update/);
  await assert.rejects(access(`${path}.lock`));
  assert.equal(await withPrivateFileLock(path, async () => "recovered"), "recovered");
  await assert.rejects(access(`${path}.lock`));
});

test("private preference locks reject occupied symlinks without changing their targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-preference-lock-")); const path = join(directory, "preferences");
  const target = join(directory, "unrelated"); await writeFile(target, "leave unchanged"); await symlink(target, `${path}.lock`);
  await assert.rejects(withPrivateFileLock(path, async () => "unused"), /lock is invalid/);
  assert.equal(await readFile(target, "utf8"), "leave unchanged");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { executionHostIdentity } from "../execution-host-attestation.js";

test("host attestation uses the running release receipt, never current", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-attestation-"));
  const release = join(root, "releases", "0.6.1"); const packageDirectory = join(release, "package");
  try {
    await mkdir(join(packageDirectory, "dist"), { recursive: true, mode: 0o700 });
    await writeFile(join(packageDirectory, "release.json"), JSON.stringify({ version: "0.6.1", source: "a".repeat(40) }), { mode: 0o600 });
    await symlink("releases/0.6.1", join(root, "current"));
    const moduleUrl = pathToFileURL(join(packageDirectory, "dist", "execution-host-attestation.js")).href;
    assert.deepEqual(await executionHostIdentity(123, moduleUrl), {
      hostPid: process.pid, startedAtMs: 123, runningRelease: "0.6.1", sourceCommit: "a".repeat(40),
    });
    await writeFile(join(packageDirectory, "release.json"), JSON.stringify({ version: "0.6.0", source: "a".repeat(40) }), { mode: 0o600 });
    assert.equal(await executionHostIdentity(123, moduleUrl), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

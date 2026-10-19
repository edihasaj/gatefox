import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyClaudeDesktopProfile, readSelectedClaudeDesktopProfile, writeClaudeDesktopCandidate } from "../claude-desktop-files.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-claude-desktop-"));
  const library = join(root, "library"); const adapterRoot = join(root, "adapter"); const backupRoot = join(root, "backups");
  await writeFile(join(root, ".keep"), "");
  await mkdir(library);
  await writeFile(join(library, "_meta.json"), JSON.stringify({ appliedId: "gateway", entries: [{ id: "gateway", name: "Harness Gateway" }] }));
  await writeFile(join(library, "gateway.json"), JSON.stringify({ preserved: true }), { mode: 0o600 });
  return { root, library, adapterRoot, backupRoot };
}
const adapterConfig = { listenPort: 3467, endpoint: "http://127.0.0.1:3457", upstream: "http://127.0.0.1:3457", tokenFile: "/private/token", auditFile: "/private/audit", models: [] };

test("reads only the unique active Harness Gateway profile and writes private candidates", async () => {
  const f = await fixture();
  const selected = await readSelectedClaudeDesktopProfile(f.library);
  assert.equal(selected.profile.preserved, true);
  const candidate = await writeClaudeDesktopCandidate(join(f.root, "candidate"), { test: true }, adapterConfig);
  assert.equal((await lstat(candidate.desktopProfilePath)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(f.root, "candidate"))).mode & 0o777, 0o700);
  await writeFile(join(f.library, "_meta.json"), JSON.stringify({ appliedId: "wrong", entries: [{ id: "gateway", name: "Harness Gateway" }] }));
  await assert.rejects(readSelectedClaudeDesktopProfile(f.library), /appliedId/);
});

test("refuses traversal and symlink-selected profiles before a write", async () => {
  const f = await fixture();
  await writeFile(join(f.library, "_meta.json"), JSON.stringify({ appliedId: "../outside", entries: [{ id: "../outside", name: "Harness Gateway" }] }));
  await assert.rejects(readSelectedClaudeDesktopProfile(f.library), /safe filename/);
  await writeFile(join(f.library, "_meta.json"), JSON.stringify({ appliedId: "gateway", entries: [{ id: "gateway", name: "Harness Gateway" }] }));
  const outside = join(f.root, "outside.json"); await writeFile(outside, "{}"); await rename(join(f.library, "gateway.json"), join(f.library, "original.json")); await symlink(outside, join(f.library, "gateway.json"));
  await assert.rejects(readSelectedClaudeDesktopProfile(f.library), /unsafe/);
});

test("rolls the first write back when the second write fails", async () => {
  const f = await fixture();
  const expectedProfile = await readSelectedClaudeDesktopProfile(f.library);
  let writes = 0;
  await assert.rejects(applyClaudeDesktopProfile({
    library: f.library, adapterRoot: f.adapterRoot, backupRoot: f.backupRoot, profile: { changed: true }, adapterConfig,
    expectedProfile,
    protectedPaths: [join(f.root, "protected.json")], appNotRunning: () => true,
    replace: async (from, to) => { writes++; if (writes === 2) throw new Error("second write failed"); await rename(from, to); },
  }), /previous files were restored/);
  assert.deepEqual(JSON.parse(await readFile(join(f.library, "gateway.json"), "utf8")), { preserved: true });
});

test("checks protected paths before writing and refuses a running app", async () => {
  const f = await fixture(); const protectedPath = join(f.root, "protected.json");
  await writeFile(protectedPath, "protected"); await chmod(protectedPath, 0o600);
  const expectedProfile = await readSelectedClaudeDesktopProfile(f.library);
  await assert.rejects(applyClaudeDesktopProfile({
    library: f.library, adapterRoot: f.adapterRoot, backupRoot: f.backupRoot, profile: { changed: true }, adapterConfig,
    expectedProfile,
    protectedPaths: [protectedPath], appNotRunning: () => false,
  }), /Quit Claude Desktop/);
  assert.equal(await readFile(join(f.library, "gateway.json"), "utf8"), JSON.stringify({ preserved: true }));
});

test("detects a protected-path change before replacing either selected file", async () => {
  const f = await fixture(); const protectedPath = join(f.root, "protected.json");
  await writeFile(protectedPath, "before");
  const expectedProfile = await readSelectedClaudeDesktopProfile(f.library);
  const profile = { changed: { toJSON: () => { writeFileSync(protectedPath, "after"); return true; } } };
  await assert.rejects(applyClaudeDesktopProfile({
    library: f.library, adapterRoot: f.adapterRoot, backupRoot: f.backupRoot, profile, adapterConfig,
    expectedProfile,
    protectedPaths: [protectedPath], appNotRunning: () => true,
  }), /Protected configuration changed unexpectedly/);
  assert.deepEqual(JSON.parse(await readFile(join(f.library, "gateway.json"), "utf8")), { preserved: true });
});

test("refuses an apply when the active Harness Gateway profile changes after candidate generation", async () => {
  const f = await fixture();
  const expectedProfile = await readSelectedClaudeDesktopProfile(f.library);
  await writeClaudeDesktopCandidate(join(f.root, "candidate"), { changed: true }, adapterConfig);
  await writeFile(join(f.library, "second.json"), JSON.stringify({ secondProfile: "keep me" }));
  await writeFile(join(f.library, "_meta.json"), JSON.stringify({ appliedId: "second", entries: [{ id: "second", name: "Harness Gateway" }] }));
  await assert.rejects(applyClaudeDesktopProfile({
    library: f.library, adapterRoot: f.adapterRoot, backupRoot: f.backupRoot, profile: { changed: true }, adapterConfig,
    expectedProfile, protectedPaths: [], appNotRunning: () => true,
  }), /selected profile changed/);
  assert.deepEqual(JSON.parse(await readFile(join(f.library, "second.json"), "utf8")), { secondProfile: "keep me" });
  assert.deepEqual(JSON.parse(await readFile(join(f.library, "gateway.json"), "utf8")), { preserved: true });
});

test("refuses an apply when the selected profile gains an unrelated field after candidate generation", async () => {
  const f = await fixture();
  const expectedProfile = await readSelectedClaudeDesktopProfile(f.library);
  await writeClaudeDesktopCandidate(join(f.root, "candidate"), { changed: true }, adapterConfig);
  await writeFile(join(f.library, "gateway.json"), JSON.stringify({ preserved: true, userChanged: "keep me" }));
  await assert.rejects(applyClaudeDesktopProfile({
    library: f.library, adapterRoot: f.adapterRoot, backupRoot: f.backupRoot, profile: { changed: true }, adapterConfig,
    expectedProfile, protectedPaths: [], appNotRunning: () => true,
  }), /selected profile changed/);
  assert.deepEqual(JSON.parse(await readFile(join(f.library, "gateway.json"), "utf8")), { preserved: true, userChanged: "keep me" });
});

test("rechecks the selected profile immediately before replacing it", async () => {
  const f = await fixture();
  const expectedProfile = await readSelectedClaudeDesktopProfile(f.library);
  const profile = {
    changed: {
      toJSON: () => {
        writeFileSync(join(f.library, "gateway.json"), JSON.stringify({ preserved: true, userChangedDuringApply: "keep me" }));
        return true;
      },
    },
  };
  await assert.rejects(applyClaudeDesktopProfile({
    library: f.library, adapterRoot: f.adapterRoot, backupRoot: f.backupRoot, profile, adapterConfig,
    expectedProfile, protectedPaths: [], appNotRunning: () => true,
  }), /selected profile changed/);
  assert.deepEqual(JSON.parse(await readFile(join(f.library, "gateway.json"), "utf8")), { preserved: true, userChangedDuringApply: "keep me" });
});

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, rm, stat, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError } from "../providers/provider.js";
import { copilotParent, ensureCopilotParent, legacyAgeMs, processStart, sweepCopilotDirectories } from "../providers/copilot-directories.js";
import { createGatewayHandler } from "../server.js";
import { harness } from "./copilot-live-harness.js";

// The startup sweep removes the prompt-log folders of gateways that no longer run. It reads only the dedicated parent
// folder; the OS temp folder itself, which can hold hundreds of thousands of entries, is read only for older releases'
// folders, once a week.
const exists = (path: string) => stat(path).then(() => true, () => false);
const posix = { skip: typeof process.getuid !== "function", timeout: 30000 };
const week = 7 * 24 * 3600 * 1000;
const backdate = async (path: string, ms: number) => { const old = new Date(Date.now() - ms); await utimes(path, old, old); };

test("a dead gateway's folders, live or one-shot, are swept; a living gateway's folders and unrelated ones stay", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const b36 = (value: number) => value.toString(36);
    const parent = (await processStart(process.ppid))!; const own = (await processStart(process.pid))!;
    assert.ok(parent && own, "ps reports when a process started");
    const names = {
      deadLive: `gateway-copilot-live-zzzzzz-${b36(parent)}-abc123`, deadRun: "gateway-copilot-run-zzzzzz-abc123",
      livingLive: `gateway-copilot-live-${b36(process.ppid)}-${b36(parent)}-abc123`, livingRun: `gateway-copilot-run-${b36(process.ppid)}-${b36(parent)}-abc123`,
      // A name from before the start time joined it: a living pid is trusted.
      livingPidOnly: `gateway-copilot-run-${b36(process.ppid)}-abc123`,
      // The pid lives, but it is another process now: the folder's owner started an hour before it.
      reusedLive: `gateway-copilot-live-${b36(process.ppid)}-${b36(parent - 3600)}-abc123`, reusedOwn: `gateway-copilot-run-${b36(process.pid)}-${b36(own - 3600)}-abc123`,
      own: `gateway-copilot-run-${b36(process.pid)}-${b36(own)}-abc123`, unrelated: "gateway-copilot-harness-abc123",
    };
    await ensureCopilotParent(h.scratch);
    for (const name of Object.values(names)) await mkdir(join(h.parent, name));
    // Folders of releases before the parent sit in the temp folder itself.
    const top = { legacyFresh: "gateway-copilot-abc123", legacyOld: "gateway-copilot-OLD123", deadOwned: "gateway-copilot-run-zzzzzz-abc123" };
    for (const name of Object.values(top)) await mkdir(join(h.scratch, name));
    await backdate(join(h.scratch, top.legacyOld), 3 * 3600 * 1000);
    await sweepCopilotDirectories(h.scratch);
    for (const name of [names.deadLive, names.deadRun, names.reusedLive, names.reusedOwn]) assert.equal(await exists(join(h.parent, name)), false, `${name} belongs to nobody and holds a prompt log`);
    for (const name of [names.livingLive, names.livingRun, names.livingPidOnly, names.own, names.unrelated]) assert.equal(await exists(join(h.parent, name)), true, `${name} stays`);
    assert.equal(await exists(join(h.scratch, top.legacyOld)), false, "an old release's abandoned folder is removed");
    assert.equal(await exists(join(h.scratch, top.legacyFresh)), true, "a legacy folder younger than any request can run stays");
    assert.equal(await exists(join(h.scratch, top.deadOwned)), true, "the temp folder itself is searched for older releases' names only");
    // A symlink with a dead owner's name (one the sweep matches) is not followed or removed: only real directories are the gateway's.
    const link = join(h.parent, "gateway-copilot-run-zzzzzz-link12");
    const target = join(h.scratch, "target"); await mkdir(target); await symlink(target, link);
    await sweepCopilotDirectories(h.scratch);
    assert.equal(await lstat(link).then(info => info.isSymbolicLink(), () => false), true); assert.equal(await exists(target), true);
    // A legacy folder is swept only once it is older than any request can run.
    await rm(join(h.parent, ".legacy-scan")); legacyAgeMs.value = 0; try { await sweepCopilotDirectories(h.scratch); } finally { legacyAgeMs.value = 2 * 3600 * 1000; }
    assert.equal(await exists(join(h.scratch, top.legacyFresh)), false);
  } finally { await h.restore(); }
});

test("the sweep reads the temp folder itself once, then again only after a week", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const marker = join(h.parent, ".legacy-scan");
    assert.equal(await exists(h.parent), false, "a gateway that has not run Copilot has no parent yet");
    await mkdir(join(h.scratch, "gateway-copilot-AAA111")); await backdate(join(h.scratch, "gateway-copilot-AAA111"), 3 * 3600 * 1000);
    await sweepCopilotDirectories(h.scratch);
    assert.equal(await exists(join(h.scratch, "gateway-copilot-AAA111")), false, "the first sweep reads the temp folder");
    assert.equal((await stat(h.parent)).mode & 0o777, 0o700); assert.equal(await exists(marker), true, "and remembers it did");
    // Within the week the temp folder is not read: an abandoned old folder there stays.
    await mkdir(join(h.scratch, "gateway-copilot-BBB222")); await backdate(join(h.scratch, "gateway-copilot-BBB222"), 3 * 3600 * 1000);
    await sweepCopilotDirectories(h.scratch);
    assert.equal(await exists(join(h.scratch, "gateway-copilot-BBB222")), true, "the temp folder is not read again so soon");
    await backdate(marker, week + 60000); await sweepCopilotDirectories(h.scratch);
    assert.equal(await exists(join(h.scratch, "gateway-copilot-BBB222")), false, "a week later it is");
    assert.ok((Date.now() - (await stat(marker)).mtimeMs) < 60000, "and the week starts over");
  } finally { await h.restore(); }
});

test("the sweep never removes a folder another user owns, even one whose owner is dead", posix, async () => {
  const h = await harness();
  try {
    // Another uid, as in a shared temp folder: the same folders look foreign.
    const stranger = process.getuid!() + 1; const dead = "gateway-copilot-run-zzzzzz-abc123"; const old = "gateway-copilot-OLD123";
    await ensureCopilotParent(h.scratch); await mkdir(join(h.parent, dead)); await mkdir(join(h.scratch, old)); await backdate(join(h.scratch, old), 3 * 3600 * 1000);
    await sweepCopilotDirectories(h.scratch, stranger);
    assert.equal(await exists(join(h.parent, dead)), true, "a dead owner's folder in the parent is not ours to remove");
    assert.equal(await exists(join(h.scratch, old)), true, "nor an old release's folder in the temp folder");
    await rm(join(h.parent, ".legacy-scan"), { force: true }); await sweepCopilotDirectories(h.scratch);
    assert.equal(await exists(join(h.parent, dead)), false); assert.equal(await exists(join(h.scratch, old)), false, "they are ours for the real owner");
  } finally { await h.restore(); }
});

test("the dedicated parent is private and real: it is made 0700, and a symlink in its place is refused", posix, async () => {
  const h = await harness();
  try {
    await mkdir(h.parent, { mode: 0o755 }); await chmod(h.parent, 0o755);
    assert.equal(await ensureCopilotParent(h.scratch), h.parent); assert.equal((await stat(h.parent)).mode & 0o777, 0o700, "a parent with open permissions is closed");
    await rm(h.parent, { recursive: true }); const elsewhere = join(h.scratch, "elsewhere"); await mkdir(elsewhere); await symlink(elsewhere, copilotParent(h.scratch));
    await assert.rejects(ensureCopilotParent(h.scratch), error => error instanceof ProviderError && error.code === "cli_failed");
    assert.deepEqual(await readdir(elsewhere), [], "nothing was put in the folder it points to");
  } finally { await h.restore(); }
});

test("starting the gateway sweeps a dead gateway's folders before any Copilot request, whatever the mode", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    await ensureCopilotParent(h.scratch);
    const dead = [join(h.parent, "gateway-copilot-live-zzzzzz-abc123"), join(h.parent, "gateway-copilot-run-zzzzzz-abc123")];
    for (const path of dead) { await mkdir(join(path, "session-state"), { recursive: true }); }
    await createGatewayHandler({ version: 1, port: 0, stateDirectory: join(h.directory, "state"), providers: [{ id: "c", type: "copilot-subscription", models: { a: "x" }, copilotSessions: { mode: "oneshot" } }] });
    for (const path of dead) assert.equal(await exists(path), false, "removed at startup, with no Copilot request made");
    assert.deepEqual(await h.pids(), [], "no CLI was started for it");
  } finally { await h.restore(); }
});

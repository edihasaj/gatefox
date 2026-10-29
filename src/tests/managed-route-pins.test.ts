import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ManagedRoutePins, type ManagedRoutePin } from "../managed-route-pins.js";

const exec = promisify(execFile);
const hex = (c: string) => c.repeat(64);
const pin = (alias = "sub/sol", patch: Partial<ManagedRoutePin> = {}): ManagedRoutePin => ({ schema: "managed-route-pin.v1", alias, providerId: "sub",
  upstreamModel: "gpt-6.1-sol", bindingFingerprint: hex("a"), policyFingerprint: hex("b"), ...patch });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const key = "worker-thread:secret-looking-raw-key";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "managed-pins-"));
  chmodSync(root, 0o700);
  const state = join(root, "state");
  const directory = join(state, "managed-route-pins"), file = join(directory, `${sha(key)}.json`);
  return { root, state, directory, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function save(state: string, value: ManagedRoutePin, name = key) {
  await new ManagedRoutePins(state).withPin(name, async (_, write) => { await write(value); });
}
async function refused(state: string, name = key) {
  let called = false;
  await assert.rejects(new ManagedRoutePins(state).withPin(name, async () => { called = true; }), /unsafe or unreadable/);
  assert.equal(called, false, "the callback must not run on unverifiable state");
}

test("construction does no filesystem I/O", async () => {
  const f = fixture();
  try {
    new ManagedRoutePins("/unused");
    new ManagedRoutePins(f.state);
    assert.equal(existsSync("/unused"), false);
    assert.equal(existsSync(f.state), false);
  } finally { f.cleanup(); }
});

test("a saved pin survives reopening and the store is private", async () => {
  const f = fixture();
  try {
    await new ManagedRoutePins(f.state).withPin(key, async (existing, write) => { assert.equal(existing, undefined); await write(pin()); });
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(statSync(f.file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.directory), [`${sha(key)}.json`], "no temporary file remains");
    const raw = readFileSync(f.file, "utf8");
    assert.ok(raw.length <= 4096 && !raw.includes(key) && !raw.includes("secret-looking"));
    assert.deepEqual(JSON.parse(raw), pin());
    await new ManagedRoutePins(f.state).withPin(key, async existing => { assert.deepEqual(existing, pin()); });
    await new ManagedRoutePins(f.state).withPin("another-key", async existing => { assert.equal(existing, undefined); });
  } finally { f.cleanup(); }
});

test("an identical save is idempotent and a different pin conflicts without overwriting", async () => {
  const f = fixture();
  try {
    await save(f.state, pin());
    await save(f.state, pin());
    await assert.rejects(save(f.state, pin("sub2/sonnet", { providerId: "sub2" })), /conflicts/);
    await new ManagedRoutePins(f.state).withPin(key, async existing => { assert.deepEqual(existing, pin()); });
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), pin());
    assert.deepEqual(readdirSync(f.directory), [`${sha(key)}.json`]);
  } finally { f.cleanup(); }
});

test("callers for one key are serialized across instances and see the first save", async () => {
  const f = fixture();
  try {
    const events: string[] = [];
    const a = new ManagedRoutePins(f.state), b = new ManagedRoutePins(f.state);
    const first = a.withPin(key, async (existing, write) => {
      events.push(`a:start:${existing === undefined}`);
      await new Promise(resolve => setTimeout(resolve, 60));
      await write(pin());
      events.push("a:end");
    });
    const second = b.withPin(key, async existing => { events.push(`b:start:${existing?.alias}`); });
    const other = b.withPin("independent", async () => { events.push("other"); });
    await Promise.all([first, second, other]);
    assert.deepEqual(events.filter(e => e !== "other"), ["a:start:true", "a:end", "b:start:sub/sol"]);
    assert.ok(events.indexOf("other") < events.indexOf("a:end"), "other keys are not blocked");
    await assert.rejects(new ManagedRoutePins(f.state).withPin(key, async () => { throw new Error("run failed"); }), /run failed/);
    await new ManagedRoutePins(f.state).withPin(key, async existing => { assert.equal(existing?.alias, "sub/sol"); });
  } finally { f.cleanup(); }
});

test("concurrent saves of different pins in one process leave one winner", async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([save(f.state, pin("sub/sol")), save(f.state, pin("sub2/sonnet", { providerId: "sub2" })), save(f.state, pin("sub/sol"))]);
    assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.equal(JSON.parse(readFileSync(f.file, "utf8")).alias, "sub/sol");
  } finally { f.cleanup(); }
});

test("separate processes racing to pin one key never overwrite each other", async () => {
  const f = fixture();
  try {
    const module = pathToFileURL(join(import.meta.dirname, "..", "managed-route-pins.js")).href;
    const start = Date.now() + 600;
    const script = `const { ManagedRoutePins } = await import(${JSON.stringify(module)});
      const [state, key, alias, start] = process.argv.slice(1);
      const pin = { schema: "managed-route-pin.v1", alias, providerId: "p", upstreamModel: "m", bindingFingerprint: "a".repeat(64), policyFingerprint: "b".repeat(64) };
      let outcome = "saved";
      try { await new ManagedRoutePins(state).withPin(key, async (existing, save) => { if (existing) { outcome = "existing:" + existing.alias; return; } while (Date.now() < Number(start)); await save(pin); }); }
      catch (error) { outcome = String(error.message).includes("conflicts") ? "conflict" : "error:" + error.message; }
      console.log(outcome);`;
    const run = (alias: string) => exec(process.execPath, ["--input-type=module", "-e", script, f.state, key, alias, String(start)]).then(r => r.stdout.trim());
    const outcomes = await Promise.all([run("sub/sol"), run("sub2/sonnet")]);
    assert.deepEqual([...outcomes].sort(), ["conflict", "saved"], outcomes.join(","));
    const winner = JSON.parse(readFileSync(f.file, "utf8")).alias;
    assert.ok(["sub/sol", "sub2/sonnet"].includes(winner));
    assert.equal(outcomes[winner === "sub/sol" ? 0 : 1], "saved");
    assert.deepEqual(readdirSync(f.directory), [`${sha(key)}.json`], "losing temporaries are removed");
  } finally { f.cleanup(); }
});

test("unsafe state directories and files are refused, never assumed absent", async () => {
  const f = fixture();
  try {
    await save(f.state, pin());
    chmodSync(f.file, 0o644);
    await refused(f.state);
    chmodSync(f.file, 0o640);
    await refused(f.state);
    chmodSync(f.file, 0o600);
    chmodSync(f.directory, 0o755);
    await refused(f.state);
    chmodSync(f.directory, 0o700);
    chmodSync(f.state, 0o755);
    await refused(f.state);
    chmodSync(f.state, 0o700);
    await new ManagedRoutePins(f.state).withPin(key, async existing => { assert.equal(existing?.alias, "sub/sol"); });
  } finally { f.cleanup(); }
});

test("symlinked state, directory or pin file is refused", async () => {
  const f = fixture();
  try {
    await save(f.state, pin());
    const copy = join(f.root, "copy.json");
    writeFileSync(copy, readFileSync(f.file), { mode: 0o600 });
    rmSync(f.file);
    symlinkSync(copy, f.file);
    await refused(f.state);
    rmSync(f.file);
    rmSync(f.directory, { recursive: true });
    const elsewhere = join(f.root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, f.directory);
    await refused(f.state);
    assert.deepEqual(readdirSync(elsewhere), [], "nothing is written through a symlink");
    const link = join(f.root, "state-link");
    symlinkSync(f.state, link);
    await refused(link);
  } finally { f.cleanup(); }
});

test("corrupt, oversized or wrongly shaped pin files are refused and left in place", async () => {
  const f = fixture();
  try {
    await save(f.state, pin());
    const bodies: unknown[] = ["", "{", "[]", "null", JSON.stringify({ ...pin(), schema: "managed-route-pin.v2" }), JSON.stringify({ ...pin(), extra: 1 }),
      JSON.stringify({ ...pin(), alias: undefined }), JSON.stringify({ ...pin(), alias: 7 }), JSON.stringify({ ...pin(), alias: "" }), JSON.stringify({ ...pin(), alias: "x".repeat(257) }),
      JSON.stringify({ ...pin(), bindingFingerprint: "A".repeat(64) }), JSON.stringify({ ...pin(), policyFingerprint: "b".repeat(63) }),
      JSON.stringify({ ...pin(), upstreamModel: "x".repeat(5000) })];
    for (const body of bodies) {
      writeFileSync(f.file, body as string, { mode: 0o600 });
      chmodSync(f.file, 0o600);
      await refused(f.state);
      assert.equal(readFileSync(f.file, "utf8"), body);
    }
  } finally { f.cleanup(); }
});

test("a save with an invalid pin is refused and writes nothing", async () => {
  const f = fixture();
  try {
    for (const bad of [pin("", {}), pin("a", { bindingFingerprint: "xyz" }), { ...pin(), extra: true }, { ...pin(), schema: "other" }, null] as unknown[]) {
      await assert.rejects(save(f.state, bad as ManagedRoutePin), /unsafe or unreadable/);
    }
    assert.deepEqual(readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});

test("an empty key or relative state directory is refused before any I/O", async () => {
  await assert.rejects(new ManagedRoutePins("relative-state").withPin(key, async () => 1), /unsafe or unreadable/);
  assert.equal(existsSync("relative-state"), false);
  const f = fixture();
  try { await assert.rejects(new ManagedRoutePins(f.state).withPin("", async () => 1), /unsafe or unreadable/); assert.equal(existsSync(f.state), false); } finally { f.cleanup(); }
});

test("a non-regular FIFO pin refuses without blocking the Gateway event loop", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  try {
    mkdirSync(f.directory, { recursive: true, mode: 0o700 });
    await exec("mkfifo", ["-m", "600", f.file], { timeout: 2000 });
    const module = pathToFileURL(join(import.meta.dirname, "../managed-route-pins.js")).href;
    const code = `import {ManagedRoutePins} from ${JSON.stringify(module)};try {await new ManagedRoutePins(${JSON.stringify(f.state)}).withPin(${JSON.stringify(key)},async()=>{});process.exit(2);}catch {console.log('refused');}`;
    const result = await exec(process.execPath, ["--input-type=module", "-e", code], { timeout: 3000 });
    assert.equal(result.stdout.trim(), "refused");
  } finally { f.cleanup(); }
});

test("store creation and existing pins cannot admit work before directory durability succeeds", async () => {
  const f = fixture();
  const module = pathToFileURL(join(import.meta.dirname, "../managed-route-pins.js")).href;
  async function refusal(target: string) {
    const code = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {resolve} from 'node:path';const opened=new Map(),open=fs.openSync,sync=fs.fsyncSync;fs.openSync=(...args)=>{const fd=open(...args);opened.set(fd,resolve(String(args[0])));return fd;};fs.fsyncSync=fd=>{if(opened.get(fd)===${JSON.stringify(target)})throw Error('fixture sync failure');return sync(fd);};syncBuiltinESMExports();const {ManagedRoutePins}=await import(${JSON.stringify(module)});let called=false,rejected=false;try{await new ManagedRoutePins(${JSON.stringify(f.state)}).withPin(${JSON.stringify(key)},async()=>{called=true;});}catch{rejected=true;}console.log(JSON.stringify({called,rejected}));`;
    const result = await exec(process.execPath, ["--input-type=module", "-e", code], { timeout: 3000 });
    assert.deepEqual(JSON.parse(result.stdout), { called: false, rejected: true });
  }
  try {
    await refusal(f.state);
    assert.equal(existsSync(f.file), false);
    await save(f.state, pin());
    await refusal(f.directory);
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), pin());
  } finally { f.cleanup(); }
});

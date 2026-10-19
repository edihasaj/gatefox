import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shortFolder } from "./short-folder.js";

// The cleanup of a SIGKILLed end-to-end check (scripts/e2e-reaper.mjs), tried on a fake home and a fake SDK folder of this test's own.
const reaper = fileURLToPath(new URL("../../scripts/e2e-reaper.mjs", import.meta.url));
const exists = (path: string) => lstat(path).then(() => true, () => false);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => Promise<boolean> | boolean, ms: number) => { const end = Date.now() + ms; while (!await check()) { if (Date.now() > end) return false; await new Promise(done => setTimeout(done, 25)); } return true; };

/** A socket file nothing serves any more, as a SIGKILLed listener leaves it. */
async function deadSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1],()=>console.log('ready'))", path], { stdio: ["ignore", "pipe", "ignore"] });
  await once(child.stdout!, "data"); await chmod(path, 0o600); const exited = once(child, "close"); child.kill("SIGKILL"); await exited;
}

/** A module that records every signal the reaper it is loaded into sends, as "<target> <signal>" lines in `file`. */
async function killRecorder(directory: string): Promise<{ file: string; env: NodeJS.ProcessEnv }> {
  const file = join(directory, "signals.txt"); const hook = join(directory, "record-kill.mjs");
  await writeFile(hook, `import { appendFileSync } from "node:fs";\nconst kill = process.kill.bind(process);\nprocess.kill = (pid, signal) => { try { appendFileSync(${JSON.stringify(file)}, pid + " " + (signal ?? 0) + "\\n", { mode: 0o600 }); } catch { /* The test's own file. */ } return kill(pid, signal); };\n`);
  // The reaper is started by the check, so the record reaches it through the check's own environment.
  const nodeOptions = [process.env.NODE_OPTIONS, `--import ${pathToFileURL(hook).href}`].filter(Boolean).join(" ");
  return { file, env: { NODE_OPTIONS: nodeOptions } };
}
/** Every "<target> <signal>" line a reaper wrote, or nothing at all when it never called process.kill. */
const signalsOf = (file: string) => readFile(file, "utf8").then(text => text.split("\n").map(line => line.trim()).filter(Boolean), () => [] as string[]);

/** A stand-in for the check: it starts the reaper as the check does, starts one group it lists, and waits to be killed. */
async function check(home: string, sdk: string, env?: NodeJS.ProcessEnv) {
  const script = `const {spawn}=require('node:child_process');const {appendFileSync}=require('node:fs');
const reaper=spawn(process.execPath,[process.argv[1],String(process.pid),process.argv[2],process.argv[3]],{detached:true,stdio:'ignore'});reaper.unref();
const group=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});group.unref();appendFileSync(process.argv[2]+'/.groups',group.pid+'\\n');
console.log(JSON.stringify({reaper:reaper.pid,group:group.pid}));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", script, reaper, home, sdk], { stdio: ["ignore", "pipe", "ignore"], env: env ? { ...process.env, ...env } : process.env });
  const [line] = await once(child.stdout!, "data") as [Buffer];
  return { child, ...JSON.parse(line.toString()) as { reaper: number; group: number } };
}

test("a reaper cleans up after a SIGKILLed check, and leaves what is served or was never this run's", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const folder = await shortFolder("gwk-"); const home = join(folder.directory, "h"); const sdk = join(folder.directory, "s"); const servers: Server[] = [];
  let started: Awaited<ReturnType<typeof check>> | undefined;
  try {
    await mkdir(join(home, ".local/state/gw-exec/x"), { recursive: true, mode: 0o700 }); await mkdir(sdk, { mode: 0o700 });
    const [stale, served, foreign] = ["a", "b", "c"].map(digit => join(sdk, digit.repeat(64)));
    await deadSocket(stale); await writeFile(stale + ".lock", "", { mode: 0o600 });
    const server = createServer(); servers.push(server); server.listen(served); await once(server, "listening"); await writeFile(served + ".lock", "", { mode: 0o600 });
    await deadSocket(foreign); // Never linked from this run's home: not the reaper's to judge.
    await symlink(stale, join(home, ".local/state/gw-exec/x/host.sock")); await symlink(served, join(home, ".local/state/gw-exec/x/e-0000000000000000.sock"));
    started = await check(home, sdk);
    assert.ok(alive(started.group), "the listed group runs");
    await new Promise(done => setTimeout(done, 700)); // The reaper has noted the links at least once.
    const exited = once(started.child, "close"); started.child.kill("SIGKILL"); await exited;
    assert.ok(await until(() => !alive(started!.reaper), 20000), "the reaper finished");
    assert.equal(alive(started.group), false, "the listed group was killed");
    assert.equal(await exists(stale), false, "the stale socket of this run's link is gone"); assert.equal(await exists(stale + ".lock"), false, "with its lock");
    assert.equal(await exists(served), true, "a served socket stays"); assert.equal(await exists(served + ".lock"), true, "with its lock");
    assert.equal(await exists(foreign), true, "a socket no link of this run names stays");
    assert.equal(await exists(home), false, "the fake home is gone");
  } finally {
    if (started) for (const pid of [started.reaper, started.group]) { try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ } }
    for (const server of servers) await new Promise<void>(done => server.close(() => done()));
    await folder.remove();
  }
});

test("a reaper told the check ended normally does nothing", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const folder = await shortFolder("gwk-"); const home = join(folder.directory, "h"); const sdk = join(folder.directory, "s");
  let started: Awaited<ReturnType<typeof check>> | undefined;
  try {
    await mkdir(home, { mode: 0o700 }); await mkdir(sdk, { mode: 0o700 });
    const stale = join(sdk, "d".repeat(64)); await deadSocket(stale); await symlink(stale, join(home, "host.sock"));
    started = await check(home, sdk); await new Promise(done => setTimeout(done, 700));
    process.kill(started.reaper, "SIGTERM"); assert.ok(await until(() => !alive(started!.reaper), 10000));
    const exited = once(started.child, "close"); started.child.kill("SIGKILL"); await exited;
    assert.equal(await exists(stale), true); assert.equal(await exists(home), true); assert.equal(alive(started.group), true, "the check's own exit kills its groups");
    assert.equal((await readFile(join(home, ".groups"), "utf8")).trim(), String(started.group));
  } finally {
    if (started) for (const pid of [started.reaper, started.group]) { try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ } }
    await folder.remove();
  }
});

test("a reaper never signals a listed group that ended first, whatever its pid became", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const folder = await shortFolder("gwk-"); const home = join(folder.directory, "h"); const sdk = join(folder.directory, "s");
  let started: Awaited<ReturnType<typeof check>> | undefined;
  try {
    await mkdir(home, { mode: 0o700 }); await mkdir(sdk, { mode: 0o700 });
    const recorder = await killRecorder(folder.directory);
    started = await check(home, sdk, recorder.env);
    // A group that ends on its own while the check still lists it: the reaper can only ever find its group empty, and its pid by
    // another process's, so a SIGKILL of it would be a SIGKILL of something this run never started.
    const doomed = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
    if (!doomed.pid) throw new Error("The short-lived group did not start");
    const doomedPid = doomed.pid;
    await appendFile(join(home, ".groups"), doomedPid + "\n", { mode: 0o600 });
    await once(doomed, "exit");
    assert.ok(await until(() => !alive(-doomedPid), 5000), "the listed group is empty");
    await new Promise(done => setTimeout(done, 700)); // The reaper has noted the listed group at least once.
    const exited = once(started.child, "close"); started.child.kill("SIGKILL"); await exited;
    assert.ok(await until(() => !alive(started!.reaper), 20000), "the reaper ended");
    const signals = await signalsOf(recorder.file);
    assert.ok(!signals.includes(`${-doomedPid} SIGKILL`), `the ended group is never signalled: ${signals.join(" ")}`);
    assert.ok(signals.includes(`${-started.group} SIGKILL`), "a group that still runs is killed, so the recording works");
  } finally {
    if (started) for (const pid of [started.reaper, started.group]) { try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ } }
    await folder.remove();
  }
});

test("a reaper leaves a group the check announced gone, even while it still runs", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const folder = await shortFolder("gwk-"); const home = join(folder.directory, "h"); const sdk = join(folder.directory, "s");
  let started: Awaited<ReturnType<typeof check>> | undefined;
  try {
    await mkdir(home, { mode: 0o700 }); await mkdir(sdk, { mode: 0o700 });
    started = await check(home, sdk);
    assert.ok(alive(started.group), "the listed group runs");
    await appendFile(join(home, ".groups"), `-${started.group}\n`, { mode: 0o600 }); // The check's own notice, as startGroup writes it.
    await new Promise(done => setTimeout(done, 700)); // The reaper has noted the notice at least once.
    const exited = once(started.child, "close"); started.child.kill("SIGKILL"); await exited;
    assert.ok(await until(() => !alive(started!.reaper), 20000), "the reaper ended");
    assert.equal(await exists(home), false, "the reaper ran its cleanup");
    assert.ok(alive(started.group), "the announced group is left alone");
  } finally {
    if (started) for (const pid of [started.reaper, started.group]) { try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ } }
    await folder.remove();
  }
});

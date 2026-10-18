import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const run = promisify(execFile);
const apple = { skip: process.platform !== "darwin" || process.arch !== "arm64" ? "the installer only runs on an Apple Silicon Mac" : false };
const marker = "# Managed by subscription-gateway installer";

/** A release folder the real installer accepts (fake package, the running node as its runtime), an isolated prefix and an isolated HOME. */
async function layout() {
  const root = await mkdtemp(join(tmpdir(), "gateway-install-"));
  const source = join(root, "release"); const prefix = join(root, "prefix"); const home = join(root, "home");
  await mkdir(join(source, "package/dist"), { recursive: true }); await mkdir(join(source, "runtime/bin"), { recursive: true }); await mkdir(home); await mkdir(join(prefix, "bin"), { recursive: true });
  await writeFile(join(source, "package/dist/cli.js"), "console.log(`${process.env.GATEWAY_INSTALLED}:${process.env.GATEWAY_COMMAND}`);\n");
  await symlink(process.execPath, join(source, "runtime/bin/node"));
  await copyFile(new URL("../../scripts/install.sh", import.meta.url), join(source, "install")); await chmod(join(source, "install"), 0o755);
  /** Makes the release folder carry this version (a different version is a different release to the installer). */
  const publish = async (version: string) => {
    await writeFile(join(source, "package/package.json"), JSON.stringify({ name: "@edihasaj/harness-gateway", version }));
    const sums = await run("/usr/bin/shasum", ["-a", "256", "package/package.json", "package/dist/cli.js"], { cwd: source });
    await writeFile(join(source, "checksums.txt"), sums.stdout);
  };
  await publish("9.9.9");
  const install = (args: string[] = []) => run("/bin/sh", [join(source, "install"), "--prefix", prefix, ...args], { cwd: source, env: { ...process.env, HOME: home } })
    .then(result => ({ code: 0, stderr: result.stderr }), (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }));
  const bin = (name: string) => join(prefix, "bin", name);
  return { root, source, prefix, home, install, bin, publish, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const managedFile = `#!/bin/sh\n${marker}\nexec echo old\n`;

test("the installer writes harness-gateway and gateway as two managed launchers that both export the harness-gateway path", apple, async () => {
  const l = await layout();
  try {
    assert.equal((await l.install()).code, 0);
    const [harness, legacy] = await Promise.all([readFile(l.bin("harness-gateway"), "utf8"), readFile(l.bin("gateway"), "utf8")]);
    assert.equal(harness, legacy, "the same contents");
    assert.ok(harness.includes(marker + "\n"));
    assert.ok(harness.includes(`GATEWAY_COMMAND='${l.bin("harness-gateway")}' GATEWAY_INSTALLED=1 exec `), "both name harness-gateway");
    for (const name of ["harness-gateway", "gateway"]) {
      const info = await lstat(l.bin(name));
      assert.ok(info.isFile() && !info.isSymbolicLink(), name + " is a real file");
      assert.equal(info.mode & 0o777, 0o700);
      const { stdout } = await run(l.bin(name), []);
      assert.equal(stdout.trim(), `1:${l.bin("harness-gateway")}`, name + " runs the release with GATEWAY_COMMAND at harness-gateway");
    }
    assert.equal((await l.install()).code, 0, "installing again is allowed");
    assert.equal(await readFile(l.bin("harness-gateway"), "utf8"), harness);
  } finally { await l.cleanup(); }
});

test("an older install's harness-gateway link to gateway is replaced by the launcher file", apple, async () => {
  const l = await layout();
  try {
    await writeFile(l.bin("gateway"), managedFile, { mode: 0o700 }); await symlink("gateway", l.bin("harness-gateway"));
    assert.equal((await l.install()).code, 0);
    assert.equal((await lstat(l.bin("harness-gateway"))).isSymbolicLink(), false, "no longer a link");
    assert.ok((await readFile(l.bin("harness-gateway"), "utf8")).includes("# App runtime is registered by Harness Gateway."), "and the canonical managed launcher");
    assert.equal(await readFile(l.bin("gateway"), "utf8"), await readFile(l.bin("harness-gateway"), "utf8"));
  } finally { await l.cleanup(); }
});

test("a foreign harness-gateway or gateway is never touched, and the installer stops", apple, async () => {
  const foreign = "#!/bin/sh\necho mine\n";
  const cases: Array<[string, (l: Awaited<ReturnType<typeof layout>>) => Promise<void>, RegExp]> = [
    ["a foreign harness-gateway file", async l => { await writeFile(l.bin("harness-gateway"), foreign, { mode: 0o755 }); }, /harness-gateway command is occupied/],
    ["a foreign link named harness-gateway", async l => { await writeFile(l.bin("other"), foreign); await symlink("other", l.bin("harness-gateway")); }, /harness-gateway command is occupied/],
    ["a harness-gateway link to gateway when gateway is not ours", async l => { await writeFile(l.bin("gateway"), foreign, { mode: 0o755 }); await symlink("gateway", l.bin("harness-gateway")); }, /harness-gateway command is occupied/],
    ["a foreign gateway file", async l => { await writeFile(l.bin("gateway"), foreign, { mode: 0o755 }); }, /gateway command is occupied/],
  ];
  for (const [name, seed, message] of cases) {
    const l = await layout();
    try {
      await seed(l);
      const before = await Promise.all(["gateway", "harness-gateway", "other"].map(async file => lstat(l.bin(file)).then(async info => info.isSymbolicLink() ? "link:" + await readlink(l.bin(file)) : await readFile(l.bin(file), "utf8"), () => undefined)));
      const result = await l.install();
      assert.equal(result.code, 2, name); assert.match(result.stderr, message, name);
      const after = await Promise.all(["gateway", "harness-gateway", "other"].map(async file => lstat(l.bin(file)).then(async info => info.isSymbolicLink() ? "link:" + await readlink(l.bin(file)) : await readFile(l.bin(file), "utf8"), () => undefined)));
      assert.deepEqual(after, before, name + ": nothing was changed");
      assert.equal(await lstat(l.bin("gateway.new")).then(() => true, () => false), false, name + ": no staged file is left");
    } finally { await l.cleanup(); }
  }
});

test("an occupied staging name, including a link, refuses without writing through it", apple, async () => {
  const l = await layout();
  try {
    const victim = join(l.root, "victim"); await writeFile(victim, "keep me\n", { mode: 0o644 });
    await symlink(victim, l.bin("harness-gateway.new")); await symlink(victim, l.bin("gateway.new"));
    assert.equal((await l.install()).code, 1);
    assert.equal(await readFile(victim, "utf8"), "keep me\n", "the file behind the link is untouched");
    assert.equal((await lstat(victim)).mode & 0o777, 0o644, "and not made executable");
    assert.equal(await lstat(l.bin("gateway")).then(() => true, () => false), false, "no wrapper is published");
    assert.equal(await lstat(l.bin("gateway.new")).then(() => true, () => false), true, "the occupied staging name is left alone");
  } finally { await l.cleanup(); }
});

test("installing the same version again keeps the last different release as previous-release", apple, async () => {
  const l = await layout();
  try {
    const previous = join(l.prefix, "share/subscription-gateway/previous-release");
    const none = () => readFile(previous, "utf8").then(() => false, () => true);
    await l.publish("1.0.0"); assert.equal((await l.install()).code, 0);
    assert.equal(await none(), true, "a first install has no previous release");
    await l.publish("2.0.0"); assert.equal((await l.install()).code, 0);
    assert.equal((await readFile(previous, "utf8")).trim(), "releases/1.0.0");
    assert.deepEqual(await readFile(l.bin("gateway")), await readFile(l.bin("harness-gateway")), "both regular aliases remain canonical after an update");
    assert.equal((await l.install()).code, 0, "the same version again");
    assert.equal((await readFile(previous, "utf8")).trim(), "releases/1.0.0", "still the last different release");
    await l.publish("1.0.0"); assert.equal((await l.install()).code, 0);
    assert.equal((await readFile(previous, "utf8")).trim(), "releases/2.0.0", "switching back records the release it left");
  } finally { await l.cleanup(); }
});

test("a previous-release link to a release directory is atomically replaced, never followed", apple, async () => {
  const l = await layout();
  try {
    const root = join(l.prefix, "share/subscription-gateway"), previous = join(root, "previous-release");
    await l.publish("1.0.0"); assert.equal((await l.install()).code, 0);
    await symlink("releases/1.0.0", previous);
    await l.publish("2.0.0"); assert.equal((await l.install()).code, 0);
    const info = await lstat(previous);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal((await readFile(previous, "utf8")).trim(), "releases/1.0.0");
    assert.equal((await readdir(join(root, "releases", "1.0.0"))).some(name => name.startsWith("previous-release.new-")), false);
  } finally { await l.cleanup(); }
});

test("a transaction nonce records receipts before each real installer publication", apple, async () => {
  const l = await layout();
  try {
    await l.publish("1.0.0"); assert.equal((await l.install()).code, 0);
    await l.publish("2.0.0");
    const root = join(l.prefix, "share/subscription-gateway"), save = async (path: string) => {
      const info = await lstat(path).catch(() => undefined);
      if (!info) return { kind: "none" };
      const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path);
      return { kind: info.isSymbolicLink() ? "link" : "file", ...(info.isSymbolicLink() ? { target: await readlink(path) } : { bytes: bytes.toString("base64") }),
        receipt: { dev: info.dev, ino: info.ino, mode: info.mode & 0o777, size: info.size, digest: createHash("sha256").update(bytes).digest("hex") } };
    };
    const nonce = randomUUID(), before = { current: await save(join(root, "current")), previous: await save(join(root, "previous-release")),
      wrappers: { gateway: await save(l.bin("gateway")), "harness-gateway": await save(l.bin("harness-gateway")), "subscription-gateway": await save(l.bin("subscription-gateway")) } };
    await writeFile(join(root, "app-update-transaction.json"), JSON.stringify({ schema: 1, root, prefix: l.prefix, app: join(l.root, "Harness Gateway.app"),
      version: "2.0.0", team: "ABCDE12345", nonce, phase: "installing", before }), { mode: 0o600 });
    assert.equal((await l.install(["--update-transaction", nonce])).code, 0);
    const journal = JSON.parse(await readFile(join(root, "app-update-transaction.json"), "utf8"));
    assert.deepEqual(Object.keys(journal.installer.outputs).sort(), ["current", "gateway", "harness-gateway", "previous"]);
  } finally { await l.cleanup(); }
});

test("an active runtime publisher lock refuses an installer update without replacing wrappers", apple, async () => {
  const l = await layout();
  try {
    assert.equal((await l.install()).code, 0); const before = await readFile(l.bin("gateway"));
    await mkdir(join(l.prefix, "share/subscription-gateway/.gateway-installation-lock"), { mode: 0o700 });
    const result = await l.install(); assert.equal(result.code, 75); assert.match(result.stderr, /installation is busy/i);
    assert.deepEqual(await readFile(l.bin("gateway")), before);
  } finally { await l.cleanup(); }
});

test("TERM exits through cleanup without publishing wrappers after a controlled installer pause", apple, async () => {
  const l = await layout();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const sdk = join(l.source, "package/gateway-sdk"); const ready = join(l.home, "paused"); await mkdir(sdk);
    await writeFile(join(sdk, "gateway-codex"), `#!/bin/sh\nprintf ready > "$HOME/paused"\nwhile :; do sleep 1; done\n`, { mode: 0o755 }); await l.publish("9.9.8");
    const installer = spawn("/bin/sh", [join(l.source, "install"), "--prefix", l.prefix], { cwd: l.source, env: { ...process.env, HOME: l.home }, detached: true, stdio: "ignore" }); child = installer;
    const deadline = Date.now() + 5000; let handshake = "";
    while (Date.now() < deadline) {
      handshake = await readFile(ready, "utf8").catch(() => "");
      if (handshake === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(handshake, "ready"); process.kill(-installer.pid!, "SIGTERM");
    const code = await new Promise<number | null>(resolve => installer.once("close", resolve)); assert.equal(code, 143);
    child = undefined;
    await assert.rejects(lstat(l.bin("gateway"))); await assert.rejects(lstat(l.bin("harness-gateway")));
    await assert.rejects(lstat(join(l.prefix, "share/subscription-gateway/.gateway-installation-lock")));
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await l.cleanup();
  }
});

test("the installer runs gateway-codex --version once before current switches, and skips it when the file is missing", apple, async () => {
  const l = await layout();
  try {
    const calls = join(l.home, "prewarm-calls"); const current = join(l.prefix, "share/subscription-gateway/current");
    assert.equal((await l.install()).code, 0, "no gateway-sdk in the release");
    assert.equal(await readFile(calls, "utf8").then(() => true, () => false), false, "nothing was run");
    const sdk = join(l.source, "package/gateway-sdk"); await mkdir(sdk);
    // The stub records its arguments and whether current already pointed at the new release.
    await writeFile(join(sdk, "gateway-codex"), `#!/bin/sh\nprintf '%s|%s\\n' "$*" "$(readlink '${current}' 2>/dev/null)" >> "$HOME/prewarm-calls"\n`, { mode: 0o755 });
    await l.publish("9.9.8"); assert.equal((await l.install()).code, 0);
    assert.equal(await readFile(calls, "utf8"), "--version|releases/9.9.9\n", "one call, while current still named the old release");
    assert.equal(await readlink(current), "releases/9.9.8");
  } finally { await l.cleanup(); }
});

test("a gateway-codex that fails does not stop the install, and the failure is reported on stderr", apple, async () => {
  const l = await layout();
  try {
    const sdk = join(l.source, "package/gateway-sdk"); await mkdir(sdk);
    await writeFile(join(sdk, "gateway-codex"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const result = await l.install();
    assert.equal(result.code, 0); assert.match(result.stderr, /did not pre-warm/);
    assert.equal(await readlink(join(l.prefix, "share/subscription-gateway/current")), "releases/9.9.9");
  } finally { await l.cleanup(); }
});

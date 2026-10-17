import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const apple = { skip: process.platform !== "darwin" || process.arch !== "arm64" ? "the installer only runs on an Apple Silicon Mac" : false };
const marker = "# Managed by subscription-gateway installer";

/** A release folder the real installer accepts (fake package, the running node as its runtime), an isolated prefix and an isolated HOME. */
async function layout() {
  const root = await mkdtemp(join(tmpdir(), "gateway-install-"));
  const source = join(root, "release"); const prefix = join(root, "prefix"); const home = join(root, "home");
  await mkdir(join(source, "package/dist"), { recursive: true }); await mkdir(join(source, "runtime/bin"), { recursive: true }); await mkdir(home); await mkdir(join(prefix, "bin"), { recursive: true });
  await writeFile(join(source, "package/package.json"), JSON.stringify({ name: "@edihasaj/harness-gateway", version: "9.9.9" }));
  await writeFile(join(source, "package/dist/cli.js"), "console.log(`${process.env.GATEWAY_INSTALLED}:${process.env.GATEWAY_COMMAND}`);\n");
  await symlink(process.execPath, join(source, "runtime/bin/node"));
  await copyFile(new URL("../../scripts/install.sh", import.meta.url), join(source, "install")); await chmod(join(source, "install"), 0o755);
  const sums = await run("/usr/bin/shasum", ["-a", "256", "package/package.json", "package/dist/cli.js"], { cwd: source });
  await writeFile(join(source, "checksums.txt"), sums.stdout);
  const install = () => run("/bin/sh", [join(source, "install"), "--prefix", prefix], { cwd: source, env: { ...process.env, HOME: home } })
    .then(result => ({ code: 0, stderr: result.stderr }), (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }));
  const bin = (name: string) => join(prefix, "bin", name);
  return { root, prefix, home, install, bin, cleanup: () => rm(root, { recursive: true, force: true }) };
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
    assert.ok((await readFile(l.bin("harness-gateway"), "utf8")).includes("exec '"), "and the new launcher");
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

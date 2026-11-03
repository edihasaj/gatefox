import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installedReleaseRuntime, preparationFiles } from "../installed-release-runtime.js";
import { shortFolder } from "./short-folder.js";

const sha = "d".repeat(64);
/** A managed layout: the running release 1.1.8 and the installed release 1.1.9 whose verifier is `body`. */
async function fixture(body: string, installed = "1.1.9") {
  const made = await shortFolder("gwir-");
  for (const version of ["1.1.8", "1.1.9"]) {
    await mkdir(join(made.directory, "releases", version, "package", "dist"), { recursive: true, mode: 0o700 });
    await writeFile(join(made.directory, "releases", version, ".gateway-release"), version + "\n", { mode: 0o600 });
    for (const name of preparationFiles) await writeFile(join(made.directory, "releases", version, "package", "dist", name), `// ${name}\n`, { mode: 0o600 });
  }
  const module = join(made.directory, "releases/1.1.9/package/dist/gateway-sdk-runtime.js");
  await writeFile(module, body, { mode: 0o600 });
  await symlink(`releases/${installed}`, join(made.directory, "current"));
  const source = pathToFileURL(join(made.directory, "releases/1.1.8/package/dist/installed-release-runtime.js")).href;
  return { ...made, module, source };
}
const verifier = (extra = "") => `export async function gatewaySdkRuntime(dir){${extra}return {executable: dir + "/gateway-sdk/gateway-codex", binarySha256: ${JSON.stringify(sha)}, selectedModelCompaction: true, executorIdentity: true, codeModeHost: false, dir};}`;

test("the installed release's own verifier answers for its own package, and the release stays retained", async () => {
  const f = await fixture(verifier());
  try {
    const loaded = await installedReleaseRuntime("1.1.9", f.source);
    assert.equal(loaded?.release, "1.1.9");
    assert.equal(loaded?.runtime.binarySha256, sha);
    assert.equal((loaded?.runtime as unknown as { dir: string }).dir, join(await realpath(f.directory), "releases/1.1.9/package"), "verified against the installed package, never the running one");
    assert.equal(loaded?.lease.releaseName, "1.1.9");
    loaded?.lease.release();
  } finally { await f.remove(); }
});

test("only the release current names, and only a safe module that answers with a runtime", async () => {
  const f = await fixture(verifier());
  try { assert.equal(await installedReleaseRuntime("1.1.7", f.source), undefined, "a release that is not installed"); } finally { await f.remove(); }
  const g = await fixture(verifier(), "1.1.8");
  try { assert.equal(await installedReleaseRuntime("1.1.9", g.source), undefined, "nothing newer is installed"); } finally { await g.remove(); }
  const h = await fixture(verifier());
  try { await chmod(h.module, 0o666); assert.equal(await installedReleaseRuntime("1.1.9", h.source), undefined, "a writable module"); } finally { await h.remove(); }
  const i = await fixture(verifier());
  try {
    await unlink(i.module); await writeFile(join(i.directory, "elsewhere.js"), verifier(), { mode: 0o600 });
    await symlink(join(i.directory, "elsewhere.js"), i.module);
    assert.equal(await installedReleaseRuntime("1.1.9", i.source), undefined, "a module linked out of the release");
  } finally { await i.remove(); }
  const j = await fixture("export async function gatewaySdkRuntime(){return undefined;}");
  try { assert.equal(await installedReleaseRuntime("1.1.9", j.source), undefined, "a verifier that rejects its SDK"); } finally { await j.remove(); }
  const k = await fixture(verifier("throw new Error('damaged');"));
  try { assert.equal(await installedReleaseRuntime("1.1.9", k.source), undefined, "a verifier that throws"); } finally { await k.remove(); }
  for (const name of preparationFiles) {
    const m = await fixture(verifier());
    try {
      await writeFile(join(m.directory, "releases/1.1.9/package/dist", name), `// ${name} changed\n`, { mode: 0o600 });
      assert.equal(await installedReleaseRuntime("1.1.9", m.source), undefined, `a release whose ${name} differs prepares settings differently`);
    } finally { await m.remove(); }
  }
});

test("a checkout never loads another release's verifier", async () => {
  assert.equal(await installedReleaseRuntime("1.1.9"), undefined);
});

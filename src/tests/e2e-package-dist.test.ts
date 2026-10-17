import test from "node:test";
import assert from "node:assert/strict";

const { launcherCli, quotedWords, resolveDistDirectory } = await import(new URL("../../scripts/e2e-package-dist.mjs", import.meta.url).href) as {
  launcherCli: (text: string) => string | undefined; quotedWords: (text: string) => string[];
  resolveDistDirectory: (options: { package?: string; gateway?: string; fallback: string; exists: (path: string) => boolean; readText: (path: string) => string | undefined }) => { directory: string; source: string };
};

const launcher = (root: string) => `#!/bin/sh\n# Managed by subscription-gateway installer\nGATEWAY_COMMAND='/p/bin/harness-gateway' GATEWAY_INSTALLED=1 exec '${root}/current/runtime/bin/node' '${root}/current/package/dist/cli.js' "$@"\n`;
const root = "/p/share/subscription-gateway";
/** A fake file system: `files` are paths that exist, `texts` the readable ones. */
const fake = (files: string[], texts: Record<string, string> = {}) => ({ exists: (path: string) => files.includes(path), readText: (path: string) => texts[path] });
const dist = (folder: string) => [`${folder}/dist/execution-host.js`, `${folder}/dist/config.js`];
const fallback = "/checkout/dist";

test("an explicit --package wins over the gateway and loads from its dist", () => {
  const result = resolveDistDirectory({ package: "/pkg", gateway: "/p/bin/harness-gateway", fallback, ...fake([...dist("/pkg"), ...dist(`${root}/current/package`)], { "/p/bin/harness-gateway": launcher(root) }) });
  assert.deepEqual(result, { directory: "/pkg/dist", source: "package" });
});

test("an explicit --package without the host files is an error, never a silent fallback", () => {
  assert.throws(() => resolveDistDirectory({ package: "/pkg", gateway: "/g", fallback, ...fake(["/pkg/dist/config.js"]) }), /--package has no dist\/execution-host\.js: \/pkg/);
});

test("without --package the installed launcher's current/package is used", () => {
  const result = resolveDistDirectory({ gateway: "/p/bin/harness-gateway", fallback, ...fake(dist(`${root}/current/package`), { "/p/bin/harness-gateway": launcher(root) }) });
  assert.deepEqual(result, { directory: `${root}/current/package/dist`, source: "launcher" });
});

test("a launcher path with a quote is decoded", () => {
  const odd = "/it's here/share/subscription-gateway";
  const text = launcher(odd.replaceAll("'", "'\\''"));
  assert.equal(launcherCli(text), `${odd}/current/package/dist/cli.js`);
  assert.deepEqual(quotedWords("a 'b c' 'd'\\''e'"), ["b c", "d'e"]);
});

test("a dist/cli.js path locates its package as e2e-compaction-switch does", () => {
  const result = resolveDistDirectory({ gateway: "/pkg/dist/cli.js", fallback, ...fake(dist("/pkg")) });
  assert.deepEqual(result, { directory: "/pkg/dist", source: "gateway-path" });
});

test("a launcher that is not readable falls back to the install layout beside the prefix", () => {
  const result = resolveDistDirectory({ gateway: "/p/bin/harness-gateway", fallback, ...fake(dist(`${root}/current/package`)) });
  assert.deepEqual(result, { directory: `${root}/current/package/dist`, source: "install-layout" });
});

test("a package missing one of the files is skipped, and the checkout dist is the last resort", () => {
  const partial = fake([`${root}/current/package/dist/config.js`], { "/p/bin/harness-gateway": launcher(root) });
  assert.deepEqual(resolveDistDirectory({ gateway: "/p/bin/harness-gateway", fallback, ...partial }), { directory: fallback, source: "checkout" });
  assert.deepEqual(resolveDistDirectory({ fallback, ...fake([]) }), { directory: fallback, source: "checkout" });
});

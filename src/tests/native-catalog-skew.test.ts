import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { prepareNativeCatalog } from "../native-catalog.js";
import { shimFiles } from "./shim-fixture.js";

// The fixture engine lists `native`. A cache written by another Codex version may lack it.
const skewed = (extra: object = {}) => JSON.stringify({ identity: "excluded-native-cache-identity", client_version: "0.164.0", etag: "e", fetched_at: "t", models: [{ slug: "other", priority: 3 }], ...extra });

test("a cache from another Codex version that lacks an engine model still prepares the catalog", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await shimFiles({ serve: false });
  const write = process.stderr.write.bind(process.stderr); let diagnostics = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { diagnostics += chunk.toString(); return true; }) as typeof process.stderr.write;
  try {
    await writeFile(f.catalog, skewed());
    const prepared = await prepareNativeCatalog(f.backend, ["app-server"], f.value);
    assert.deepEqual(prepared.native, [{ slug: "other", priority: 3 }]);
    const combined = JSON.parse(await readFile(prepared.path, "utf8"));
    assert.deepEqual(combined.models.map((model: { slug: string }) => model.slug), ["other", "claude/model"]);
    for (const key of ["identity", "etag", "client_version", "fetched_at"]) assert.equal(combined[key], undefined);
    assert.ok(diagnostics.includes("gateway: the native model cache lacks 1 model(s) the engine lists; gateway chats start without native metadata for them\n"));
  } finally { process.stderr.write = write; f.close(); }
});

test("an alias equal to an engine model the cache lacks is still refused", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await shimFiles({ serve: false });
  try {
    await writeFile(f.catalog, skewed());
    f.value.providers = [{ id: "claude", type: "claude-subscription", models: { native: "model" } }];
    await assert.rejects(prepareNativeCatalog(f.backend, ["app-server"], f.value), /collides with a native model ID/);
  } finally { f.close(); }
});

test("a structurally invalid cache stays fatal", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await shimFiles({ serve: false });
  try {
    for (const cache of [{ models: [{ slug: "a" }, { slug: "a" }] }, { models: [{ slug: 1 }] }, { models: "none" }]) {
      await writeFile(f.catalog, JSON.stringify(cache));
      await assert.rejects(prepareNativeCatalog(f.backend, ["app-server"], f.value), /Native (cache does not match|model catalog has no)/);
    }
  } finally { f.close(); }
});

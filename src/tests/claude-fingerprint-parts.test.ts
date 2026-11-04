import test from "node:test";
import assert from "node:assert/strict";
import { fingerprintChange, fingerprintParts } from "../providers/claude-fingerprint-parts.js";

const tool = (name: string, description = "d") => ({ name, description, inputSchema: { type: "object" } });
const parts = (overrides: Partial<{ model: string; effort: string; fast: boolean; instructionsDigest: string; mcpCatalog: ReturnType<typeof tool>[] }> = {}) =>
  fingerprintParts({ model: "m", effort: "low", fast: false, instructionsDigest: "i", mcpCatalog: [tool("a"), tool("b")], ...overrides });

test("a fingerprint reseed names each changed part and counts tool changes, never names", () => {
  assert.deepEqual(fingerprintChange(parts(), parts({ instructionsDigest: "j" })), { changed: "instructions" });
  assert.deepEqual(fingerprintChange(parts(), parts({ mcpCatalog: [tool("a", "new"), tool("c")] })), { changed: "tools", toolsAdded: 1, toolsRemoved: 1, toolsEdited: 1 });
  assert.deepEqual(fingerprintChange(parts(), parts({ model: "n", fast: true, effort: undefined })), { changed: "model,thinking,fast" });
  assert.deepEqual(fingerprintChange(parts(), parts()), { changed: "contract" });
  assert.deepEqual(fingerprintChange(undefined, parts()), { changed: "unknown" });
  const text = JSON.stringify(fingerprintChange(parts(), parts({ mcpCatalog: [tool("secret_tool_name")] })));
  assert.equal(text.includes("secret_tool_name"), false);
});

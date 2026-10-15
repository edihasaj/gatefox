import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A test that starts a fixture Copilot CLI and waits for it can hang for as long as the runner lets it (a teardown that never
// ends once held a whole file for over 90 s and orphaned a CLI). Every async test of a file that starts one has its own timeout.
const sources = fileURLToPath(new URL("../../src/tests/", import.meta.url));

test("every async test of a file that starts a fixture Copilot CLI has its own timeout", { skip: !existsSync(sources) }, () => {
  const starts = /copilot-live-harness|copilot-fixture-cli/;
  const missing: string[] = [];
  for (const name of readdirSync(sources).filter(entry => entry.endsWith(".test.ts"))) {
    const text = readFileSync(`${sources}${name}`, "utf8"); if (!starts.test(text)) continue;
    text.split("\n").forEach((line, index) => { if (/\btest\(/.test(line) && /\basync\b/.test(line) && !/timeout|posix/.test(line)) missing.push(`${name}:${index + 1}`); });
  }
  assert.deepEqual(missing, [], "add { timeout: 30000 } to these tests");
});

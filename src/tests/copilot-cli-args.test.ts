import assert from "node:assert/strict";
import test from "node:test";
import { copilotCliArgs } from "../providers/copilot-rpc.js";

const base = ["--headless", "--stdio", "--no-auto-update", "--disable-builtin-mcps", "--no-custom-instructions"];

test("a CLI of unknown version keeps --no-remote, so a newer one refuses instead of starting without the guarantee", () => {
  assert.deepEqual(copilotCliArgs("/log"), [...base, "--no-remote", "--no-remote-export", "--log-dir", "/log"]);
  for (const version of ["", "latest", "1.0", "1.0.103-beta", "v1.0.105"]) {
    assert.ok(copilotCliArgs("/log", version).includes("--no-remote"), version);
  }
});

test("verified versions before 1.0.103 keep --no-remote", () => {
  for (const version of ["1.0.98", "1.0.102", "0.9.200"]) {
    assert.deepEqual(copilotCliArgs("/log", version), [...base, "--no-remote", "--no-remote-export", "--log-dir", "/log"], version);
  }
});

test("verified versions from 1.0.103 omit the retired --no-remote and keep every other confinement flag", () => {
  for (const version of ["1.0.103", "1.0.105", "1.1.0", "2.0.0"]) {
    assert.deepEqual(copilotCliArgs("/log", version), [...base, "--no-remote-export", "--log-dir", "/log"], version);
  }
});

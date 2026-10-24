import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appServerSessionShellGuard, isAppServerSession } from "../codex-invocation.js";

test("leading diagnostics bypass sessions but consumed flag-like data stays data", () => {
  const cases: [string[], boolean][] = [
    ...["-h", "--help", "-V", "--version"].map(flag => [[flag, "app-server"], false] as [string[], boolean]),
    [["-c", "--help", "app-server"], true],
    [["--config=--version", "app-server"], true],
    [["-c", "literal=--help", "app-server"], true],
    [["app-server", "generate-internal-json-schema"], false],
    [["app-server", "future-tooling-command"], false],
    [["app-server", "--startup-client-info", "--print-not-a-command"], true],
  ];
  const shell = appServerSessionShellGuard() + '\nif gateway_app_server_session "$@"; then printf session; else printf native; fi\n';
  for (const [args, expected] of cases) {
    assert.equal(isAppServerSession(args), expected);
    assert.equal(execFileSync("/bin/sh", ["-c", shell, "fixture", ...args], { encoding: "utf8" }), expected ? "session" : "native");
  }
});

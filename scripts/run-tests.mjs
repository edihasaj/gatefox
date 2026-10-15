#!/usr/bin/env node
// Runs the compiled test suite under a private temp folder, so that no test touches the real one.
//
// Several tests start gateways and fixture Copilot CLIs. Their startup sweep and their folders live under
// `<TMPDIR>/harness-gateway-copilot-<uid>`, and a test that wrote there would delete a running gateway's leftovers or leave
// a marker that makes an installed release skip its first scan. The runner creates one private folder, points TMPDIR at it
// for the whole suite, and removes it afterwards, whatever the outcome. Arguments name test files (default: every
// `dist/tests/*.test.js`); GATEWAY_TEST_TMPDIR tells the isolation test what the suite was given.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsFolder = join(root, "dist", "tests");
const requested = process.argv.slice(2);
const files = requested.length ? requested : readdirSync(testsFolder).filter(name => name.endsWith(".test.js")).sort().map(name => join(testsFolder, name));
if (!files.length) { process.stderr.write("No compiled tests found; run npm run build first.\n"); process.exit(2); }

// The path is short on purpose: tests put Unix sockets deep under this folder, and a socket path cannot exceed 104 bytes on
// macOS, where the user's temp folder alone is 48. So on Unix the folder lives in /tmp, not in the user's temp folder.
const folder = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "gwt-"));
const remove = () => { try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Best effort; it is one folder under the temp folder. */ } };
const child = spawn(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit", env: { ...process.env, TMPDIR: folder, TEMP: folder, TMP: folder, GATEWAY_TEST_TMPDIR: folder } });
// A stopped runner stops the suite and still removes its folder.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { child.kill(signal); setTimeout(() => child.kill("SIGKILL"), 10000).unref(); });
child.once("error", error => { process.stderr.write(`Could not start the test run: ${error.message}\n`); remove(); process.exit(2); });
child.once("exit", (code, signal) => { remove(); process.exit(code ?? (signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1)); });

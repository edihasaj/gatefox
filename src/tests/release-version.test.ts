import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

type ReleaseVersion = { nextReleaseVersion: (version: string) => string; releaseVersionProblem: (version: string) => string | undefined };
const script = new URL("../../scripts/release-version.mjs", import.meta.url);
const { nextReleaseVersion, releaseVersionProblem } = (await import(script.href)) as unknown as ReleaseVersion;
const declared = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

test("next release version rolls minor and patch at 9, then advances the major", () => {
  for (const [from, to] of [["0.2.36", "0.3.0"], ["0.3.0", "0.3.1"], ["0.3.8", "0.3.9"], ["0.3.9", "0.4.0"], ["0.9.9", "1.0.0"], ["1.0.9", "1.1.0"], ["1.9.8", "1.9.9"], ["1.9.9", "2.0.0"], ["1.10.0", "2.0.0"]]) assert.equal(nextReleaseVersion(from), to);
});
test("next release version rejects malformed versions", () => {
  for (const version of ["1.2", "v0.3.0"]) assert.throws(() => nextReleaseVersion(version), /Invalid release version/);
});
test("release version problem accepts only canonical versions", () => {
  for (const version of ["0.3.0", "0.3.9", "1.0.0", "1.9.9"]) assert.equal(releaseVersionProblem(version), undefined);
  for (const version of ["0.3.10", "0.2.36", "0.10.0", "1.10.0", "1.2", "v0.3.0"]) assert.match(String(releaseVersionProblem(version)), /minor and patch top out at 9/);
});

test("the script still runs when Node starts it through a symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-release-"));
  const link = join(directory, "release-version.mjs");
  try {
    symlinkSync(fileURLToPath(script), link);
    const check = spawnSync(process.execPath, [link, "--check"], { encoding: "utf8" });
    assert.equal(check.stderr, "", "starting through a symlink must not crash");
    assert.ok(check.stdout.trim(), "the entry point must be recognised through a symlink, not skipped");
    const problem = releaseVersionProblem(declared);
    if (problem) {
      assert.equal(check.status, 1, `--check must fail while package.json is ${declared}: ${check.stdout}`);
      assert.match(check.stdout, /Invalid release version/);
    } else {
      assert.equal(check.status, 0, check.stdout);
      assert.equal(check.stdout.trim(), "ok");
    }
    const next = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout.trim(), nextReleaseVersion(declared), `the next version after ${declared}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

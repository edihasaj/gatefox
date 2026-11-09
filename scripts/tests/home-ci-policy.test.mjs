// Guards .github/workflows/home-ci.yml, which runs on a self-hosted runner from a public repository.
// The runner control (edihasaj/home-runners) is the real gate; this keeps the workflow from inviting
// untrusted runs or leaking anything into public logs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const text = await readFile(path.join(root, ".github/workflows/home-ci.yml"), "utf8");
const body = text.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n");

test("only the owner's pushes to main or production and manual runs trigger it", () => {
  const on = /^on:\n((?: {2}.*\n)+)/m.exec(body)?.[1] ?? "";
  const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map(match => match[1]);
  assert.deepEqual(triggers, ["push", "workflow_dispatch"]);
  assert.match(on, /^ {4}branches: \[main, production\]$/m);
  assert.doesNotMatch(on, /tags:|paths-ignore|branches-ignore/);
  assert.doesNotMatch(body, /pull_request|issue_comment|workflow_run|repository_dispatch|schedule/);
  assert.match(body, /github\.repository == 'edihasaj\/gatefox'/);
  assert.match(body, /github\.actor == 'edihasaj'/);
  assert.match(body, /github\.triggering_actor == 'edihasaj'/);
});

test("every job runs on the isolated public home runner, never a private pool or a hosted runner", () => {
  const runsOn = [...body.matchAll(/^\s+runs-on:\s*(.+)$/gm)].map(match => match[1].trim());
  assert.ok(runsOn.length > 0);
  for (const value of runsOn) assert.equal(value, "[self-hosted, home-public-linux]");
});

test("read-only token, no secrets, no stored credentials and no environment dumps in public logs", () => {
  assert.match(body, /^permissions:\n {2}contents: read\n(?! )/m);
  assert.doesNotMatch(body, /secrets\.|\bwrite\b|id-token/);
  assert.match(body, /persist-credentials: false/);
  assert.doesNotMatch(body, /\b(printenv|env\s*$|set -x|ifconfig|ip addr|hostname|uname -a|cat \/etc)/m);
  for (const use of body.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(use[1], /@[0-9a-f]{40}$/, `pin ${use[1]} to a commit`);
});

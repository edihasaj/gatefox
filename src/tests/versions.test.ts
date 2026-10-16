import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyRole, commandRelease, formatHuman, parseLsofTxt, parsePs, runVersions, versionsCommand, type VersionsExecutors } from "../versions.js";

const uid = 501;
const root = "/opt/gw";
const installed = "0.4.2";
const node = "/usr/local/bin/node";
const release = (version: string, file = "cli.js") => `${root}/releases/${version}/package/dist/${file}`;
const current = (file = "cli.js") => `${root}/current/package/dist/${file}`;
// Nothing is installed here, so a checkout run cannot fall back to the default install root.
const missingRoot = resolve("/nonexistent", "gateway-install");
const start = (day: number, second: number) => `Mon Oct ${String(day).padStart(2)} 09:14:${String(second).padStart(2, "0")} 2026`;

/** One `ps -axo pid,uid,lstart,command` row, with the header that real `ps` prints first. */
function psLine(pid: number, owner: number, command: string, day = 12, second = 1): string {
  return `${String(pid).padStart(5)} ${String(owner).padStart(3)} ${start(day, second)} ${command}`;
}
const mapped = (...paths: string[]) => [`p${paths.length}`, ...paths.flatMap(path => ["ftxt", `n${path}`])].join("\n");

const psOut = [
  "  PID   UID                      STARTED COMMAND",
  psLine(401, uid, `${node} ${release(installed)} daemon --config /c.json`),
  psLine(402, uid, `${node} ${release(installed)} serve --port 4317`),
  psLine(403, uid, `${node} ${current()} codex-shim --config /c.json --codex /Codex.app/Contents/Resources/codex -- -- app-server`, 12, 2),
  psLine(404, uid, `${node} ${current()} codex-shim --ssh --config /c.json --codex /codex -- -- app-server --listen unix://${root}/state/ssh/app.sock`, 12, 3),
  psLine(405, uid, `${node} ${current()} codex-shim --ssh --config /c.json --codex /codex -- -- app-server proxy --url wss://host`, 12, 4),
  psLine(406, uid, `${node} ${release(installed)} executor-host --config /c.json --codex /codex --native-home /nh`, 12, 5),
  psLine(407, uid, `${root}/releases/0.4.1/package/gateway-sdk/gateway-codex app-server`, 12, 6),
  psLine(408, uid, `${root}/releases/0.4.1/package/native/gateway-native-relay --socket /tmp/n.sock`, 12, 7),
  psLine(409, uid, `${node} ${release(installed)} tunnel install --tunnel-id home --port 443 --remote-port 4317`, 12, 8),
  psLine(410, uid, `${node} ${current()} token --config /c.json`, 12, 9),
  psLine(411, 0, `${node} ${root}/releases/0.3.0/package/dist/cli.js daemon`),
  "  PID   UID                      STARTED COMMAND",
].join("\n");

const lsofFor: Record<number, string> = {
  401: mapped(release(installed)),
  402: mapped(release(installed)),
  // Started through `current`, so it loaded the release that was installed at the time, not this one.
  403: mapped(`${root}/releases/0.4.1/package/dist/cli.js`),
  404: mapped(release(installed)),
  405: mapped(release(installed)),
  407: "",
  408: mapped(`${root}/releases/0.4.1/package/native/gateway-native-relay`),
  409: mapped(release(installed)),
};
const readableLsof = async (pid: number) => {
  if (pid === 406) throw new Error("lsof: no access");
  return lsofFor[pid] ?? "";
};
const fleet = (): VersionsExecutors => ({ ps: async () => psOut, lsof: readableLsof, uid, root, installed, health: async () => undefined });

test("ps rows keep the pid, owner, start instant, and full command", () => {
  const [row] = parsePs(psOut);
  assert.equal(row!.pid, 401);
  assert.equal(row!.uid, uid);
  assert.equal(row!.command, `${node} ${release(installed)} daemon --config /c.json`);
  // `lstart` is local wall-clock time; the instant it names survives the round trip.
  assert.equal(new Date(row!.startedAt).getTime(), new Date(2026, 9, 12, 9, 14, 1).getTime());
  assert.match(row!.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(parsePs("").length, 0);
  assert.equal(parsePs("nonsense\npython3 train.py").length, 0);
});

test("each gateway subcommand and helper binary gets its own role", () => {
  const cases: [string, string][] = [
    [`${node} ${current()} daemon`, "service"],
    [`${node} ${current()} serve --port 4317`, "inference"],
    [`${node} ${current()} tunnel install --tunnel-id home`, "tunnel"],
    [`${node} ${current()} executor-host --config /c.json`, "executor-host"],
    [`${node} ${current()} codex-shim --config /c.json -- -- app-server`, "desktop-adapter"],
    [`${node} ${current()} codex-shim --ssh --config /c.json -- -- app-server --listen unix:///s/a.sock`, "ssh-listener"],
    [`${node} ${current()} codex-shim --ssh --config /c.json -- -- app-server`, "ssh-listener"],
    [`${node} ${current()} codex-shim --ssh --config /c.json -- -- app-server proxy`, "ssh-proxy"],
    [`${root}/releases/0.4.1/package/gateway-sdk/gateway-codex app-server`, "gateway-engine"],
    [`${root}/releases/0.4.1/package/native/gateway-native-relay --socket /n`, "native-relay"],
    [`${node} ${current()} token --config /c.json`, "other"],
    ["nginx -g daemon off;", "other"],
  ];
  for (const [command, role] of cases) assert.equal(classifyRole(command), role, command);
});

test("lsof names the release a process mapped, or unknown when it cannot", () => {
  assert.equal(parseLsofTxt(mapped(release("0.4.1"))), "0.4.1");
  assert.equal(parseLsofTxt("p401\nftxt\n/usr/lib/dyld"), "unknown");
  assert.equal(parseLsofTxt(""), "unknown");
  assert.equal(parseLsofTxt("lsof: operation not permitted"), "unknown");
});

test("the command line names a release only for this install", () => {
  assert.equal(commandRelease(`${node} ${release("0.4.1")} daemon`, root, installed), "0.4.1");
  // `current` was the installed release the moment the process started.
  assert.equal(commandRelease(`${node} ${current()} daemon`, root, installed), installed);
  assert.equal(commandRelease(`${node} ${current()} daemon`, root, undefined), "unknown");
  assert.equal(commandRelease(`${node} /elsewhere/releases/9.9.9/package/dist/cli.js daemon`, root, installed), undefined);
  // A checkout has no install root, so a gateway command without a release is one.
  assert.equal(commandRelease("/Users/dev/gw/dist/cli.js daemon", undefined, undefined), "checkout");
  assert.equal(commandRelease(`${root}/releases/0.4.0/package/dist/cli.js serve`, undefined, undefined), "0.4.0");
  assert.equal(commandRelease("/usr/bin/vim notes.txt", undefined, undefined), undefined);
});

test("versions reports the release each process loaded, not the one current names", async () => {
  const result = await runVersions(fleet());
  assert.deepEqual(result.processes.map(row => row.role),
    ["desktop-adapter", "executor-host", "gateway-engine", "inference", "native-relay", "other", "service", "ssh-listener", "ssh-proxy", "tunnel"]);
  const byRole = Object.fromEntries(result.processes.map(row => [row.role, row]));
  assert.equal(byRole["service"]!.release, installed);
  assert.equal(byRole["desktop-adapter"]!.release, "0.4.1", "the current-path process is pinned to what lsof shows");
  assert.equal(byRole["executor-host"]!.release, installed, "an unreadable lsof falls back to the command line");
  assert.equal(byRole["gateway-engine"]!.release, "0.4.1");
  assert.equal(byRole["ssh-listener"]!.role, "ssh-listener");
  assert.equal(byRole["tunnel"]!.pid, 409);
  assert.equal(result.installed, installed);
  assert.equal(result.lagging, 3);
  assert.ok(!result.processes.some(row => row.pid === 411), "another user's gateway is not ours to report");
  assert.ok(result.processes.every(row => row.startedAt.endsWith("Z")));
});

test("an unreadable current link leaves the release unknown and lagging", async () => {
  const result = await runVersions({ ps: async () => psLine(401, uid, `${node} ${current()} daemon`), lsof: async () => { throw new Error("lsof: no access"); }, uid, root, installed: undefined });
  assert.deepEqual(result.processes, [{ role: "service", pid: 401, startedAt: result.processes[0]!.startedAt, release: "unknown" }]);
  assert.equal(result.lagging, 1);
});

test("a checkout run reports every gateway it started as checkout", async () => {
  const result = await runVersions({
    ps: async () => [psLine(501, uid, "/Users/dev/gw/dist/cli.js daemon"), psLine(502, uid, `${node} ${release(installed)} serve`), psLine(503, uid, "/usr/bin/vim notes.txt")].join("\n"),
    lsof: async () => "", uid, fallbackRoot: missingRoot, health: async () => undefined, configPort: async () => undefined,
  });
  assert.deepEqual(result.processes.map(row => `${row.role}@${row.release}`), ["inference@0.4.2", "service@checkout"]);
  assert.equal(result.installed, null);
  assert.equal(result.lagging, 2);
});

test("the human report names the installed release and who is behind", () => {
  const all = { installed, processes: [{ role: "service" as const, pid: 401, startedAt: "2026-10-12T07:14:01.000Z", release: installed }], lagging: 0 };
  assert.equal(formatHuman(all), `installed ${installed}\n\n  service  401  2026-10-12 07:14  ${installed}\n\nall on ${installed}\n`);
  const behind = { installed, processes: [...all.processes, { role: "native-relay" as const, pid: 408, startedAt: "2026-10-12T07:14:07.000Z", release: "0.4.1" },
    { role: "gateway-engine" as const, pid: 407, startedAt: "2026-10-12T07:14:06.000Z", release: "0.4.1" }], lagging: 2 };
  // Columns line up on the widest role and pid, and the summary names each stale pair once.
  assert.deepEqual(formatHuman(behind).split("\n"), [
    "installed 0.4.2", "",
    "  service         401  2026-10-12 07:14  0.4.2",
    "  native-relay    408  2026-10-12 07:14  0.4.1",
    "  gateway-engine  407  2026-10-12 07:14  0.4.1",
    "", "2 lagging: native-relay@0.4.1 gateway-engine@0.4.1", "",
  ]);
  assert.match(formatHuman({ installed: null, processes: [], lagging: 0 }), /no gateway processes running\n$/);
});

test("--json prints the result and --check only fails the run when something lags", async () => {
  const printed: string[] = [];
  const plain = await versionsCommand([], { ...fleet(), stdout: text => printed.push(text), stderr: () => {} });
  assert.equal(plain, 0, "without --check a lagging fleet still succeeds");
  assert.match(printed.at(-1)!, /3 lagging: desktop-adapter@0\.4\.1 gateway-engine@0\.4\.1 native-relay@0\.4\.1\n$/);

  printed.length = 0;
  const json = await versionsCommand(["--json"], { ...fleet(), stdout: text => printed.push(text), stderr: () => {} });
  assert.equal(json, 0);
  const parsed = JSON.parse(printed.at(-1)!);
  assert.equal(parsed.installed, installed);
  assert.equal(parsed.lagging, 3);
  assert.equal(parsed.processes.length, 10);

  assert.equal(await versionsCommand(["--check"], { ...fleet(), stdout: () => {}, stderr: () => {} }), 1);
  const onTime = { ps: async () => psLine(401, uid, `${node} ${release(installed)} daemon`), lsof: async () => mapped(release(installed)), uid, root, installed };
  assert.equal(await versionsCommand(["--check"], { ...onTime, stdout: () => {}, stderr: () => {} }), 0);
  const err: string[] = [];
  assert.equal(await versionsCommand(["--watch"], { ...fleet(), stdout: () => {}, stderr: text => err.push(text) }), 2);
  assert.match(err.join(""), /Usage: gateway versions/);
});

test("a checkout run falls back to the default install root", async () => {
  const fallback = await mkdtemp(join(tmpdir(), "gateway-versions-"));
  try {
    await mkdir(join(fallback, "releases/9.9.9"), { recursive: true });
    await symlink("releases/9.9.9", join(fallback, "current"));
    const result = await runVersions({
      ps: async () => [
        psLine(601, uid, "/Users/dev/gw/dist/cli.js daemon"),
        psLine(602, uid, `${node} ${fallback}/current/package/dist/cli.js executor-host --config /c.json`, 12, 2),
      ].join("\n"),
      // The checkout process maps nothing of ours, so only the command line can name its release.
      lsof: async () => "", uid, fallbackRoot: fallback,
    });
    assert.equal(result.installed, "9.9.9", "the fallback current link names the installed release");
    assert.deepEqual(result.processes.map(row => `${row.role}@${row.release}`), ["executor-host@9.9.9", "service@checkout"]);
    assert.equal(result.lagging, 1);
  } finally { await rm(fallback, { recursive: true, force: true }); }
});

test("a run with neither release named reports installed null and fails --check with 2", async () => {
  const deps: VersionsExecutors = {
    ps: async () => psLine(601, uid, "/Users/dev/gw/dist/cli.js daemon"), lsof: async () => "", uid, fallbackRoot: missingRoot,
  };
  const result = await runVersions(deps);
  assert.equal(result.installed, null);
  assert.deepEqual(result.processes.map(row => row.release), ["checkout"]);
  const printed: string[] = [];
  const err: string[] = [];
  assert.equal(await versionsCommand(["--json", "--check"], { ...deps, stdout: text => printed.push(text), stderr: text => err.push(text) }), 2,
    "nothing to compare against is a broken check, not a lagging process");
  assert.equal(JSON.parse(printed.at(-1)!).installed, null, "--json always carries the key");
  assert.match(err.join(""), /no installed release/);
  assert.equal(await versionsCommand([], { ...deps, stdout: () => {}, stderr: () => {} }), 0, "the report itself still succeeds");
});

test("an inference process that upgraded in place is judged by its health header", async () => {
  const seen: number[] = [];
  const result = await runVersions({
    ps: async () => psLine(701, uid, `${node} ${current()} serve --port 4317`),
    // The node runtime it started from is still mapped, so lsof alone would call it stale.
    lsof: async () => mapped(release("0.4.1")),
    uid, root, installed,
    health: async (port) => { seen.push(port); return installed; },
  });
  assert.deepEqual(seen, [4317]);
  assert.deepEqual(result.processes.map(row => `${row.role}@${row.release}`), ["inference@0.4.2"]);
  assert.equal(result.lagging, 0, "the release it answers with is the release it serves");
});

test("an inference process with no header falls back to its mapped release", async () => {
  const asked: string[] = [];
  const result = await runVersions({
    ps: async () => psLine(701, uid, `${node} ${current()} serve --config /c.json`),
    lsof: async () => mapped(release("0.4.1")),
    uid, root, installed,
    health: async () => { throw new Error("ECONNREFUSED"); },
    configPort: async (path) => { asked.push(path); return 4400; },
  });
  assert.deepEqual(asked, ["/c.json"], "without --port the configuration names the port");
  assert.deepEqual(result.processes.map(row => `${row.role}@${row.release}`), ["inference@0.4.1"]);
  assert.equal(result.lagging, 1);
});

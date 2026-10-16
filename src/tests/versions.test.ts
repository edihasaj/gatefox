import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCommand, formatHuman, formatStart, installedRelease, parseListenPorts, parseLsofTxt, parsePs, runVersions, versionsCommand,
  type InstallScope, type VersionsCommandDeps, type VersionsExecutors } from "../versions.js";

const uid = 501;
const root = "/opt/gw";
const installed = "0.4.2";
const node = "/usr/local/bin/node";
const scope: InstallScope = { roots: [root], installed };
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
/** What `lsof -a -p <pid> -iTCP -sTCP:LISTEN -P -n -Fn` prints for one loopback listener. */
const listening = (...names: string[]) => ["p402", ...names.flatMap(name => ["f12u", `n${name}`])].join("\n");

const psOut = [
  "  PID   UID                      STARTED COMMAND",
  psLine(401, uid, `${node} ${release(installed)} daemon --config /c.json`),
  psLine(402, uid, `${node} ${release(installed)} serve --config /c.json`),
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
const fleet = (extra: Partial<VersionsCommandDeps> = {}): VersionsCommandDeps =>
  ({ ps: async () => psOut, lsof: readableLsof, sockets: async () => "", uid, root, installed, health: async () => undefined, ...extra });

/** The same instant as the local clock the human report prints. */
function localStart(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

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
    [`${node} ${release(installed)} serve --config /c.json`, "inference"],
    [`${node} ${current()} tunnel install --tunnel-id home`, "tunnel"],
    [`${node} ${current()} executor-host --config /c.json`, "executor-host"],
    [`${node} ${current()} codex-shim --config /c.json -- -- app-server`, "desktop-adapter"],
    [`${node} ${current()} codex-shim --ssh --config /c.json -- -- app-server --listen unix:///s/a.sock`, "ssh-listener"],
    [`${node} ${current()} codex-shim --ssh --config /c.json -- -- app-server`, "ssh-listener"],
    [`${node} ${current()} codex-shim --ssh --config /c.json -- -- app-server proxy`, "ssh-proxy"],
    [`${root}/releases/0.4.1/package/gateway-sdk/gateway-codex app-server`, "gateway-engine"],
    [`${root}/releases/0.4.1/package/native/gateway-native-relay --socket /n`, "native-relay"],
    // The two binaries are also recognized through the `current` link.
    [`${root}/current/package/native/gateway-native-relay --daemon`, "native-relay"],
    [`${root}/current/package/gateway-sdk/gateway-codex app-server`, "gateway-engine"],
    [`${node} ${current()} token --config /c.json`, "other"],
    [`${node} ${current()} daemon`, "service"],
    // A node interpreter named by a path with spaces is still just argv[0].
    [`/opt/Node Tools/bin/node ${current()} daemon`, "service"],
    // Only argv[0] and argv[1] are read, so these name no component at all.
    ["/bin/zsh -c echo hello", "none"],
    ["nginx -g daemon off;", "none"],
  ];
  for (const [command, role] of cases) {
    const found = classifyCommand(command, scope);
    assert.equal(found ? found.role : "none", role, command);
  }
});

test("a command line is judged by the program it runs, not by what it mentions", () => {
  // A1 and A2: these all name our paths, or a path shaped like ours, without running them.
  const ignored = [
    // A shell wrapper whose quoted script mentions the service command and a release folder.
    `/bin/zsh -c node ${release("0.4.2")} daemon --config /c.json`,
    // A wrapper started for the inference server on a release path.
    `/bin/zsh -c exec node ${current()} serve --port 4317`,
    // A shell running a script that only greps our command line out of a log.
    `/bin/sh -c grep 'gateway releases/0.4.2/package/dist/cli.js serve' /tmp/log`,
    // Another product that happens to keep its builds under a `releases/` folder.
    "/opt/app/releases/2024.1/bin/server --port 8080",
    // A relative script inside a wrapper: no install root is named at all.
    "/bin/zsh -c cd /app && node dist/cli.js serve",
    // Our path used as an argument rather than as the program.
    `${node} /usr/local/bin/other-tool ${current()} daemon`,
    // A helper binary named by a wrapper rather than executed by it.
    `/bin/zsh -c ${root}/releases/0.4.1/package/gateway-sdk/gateway-codex app-server`,
  ];
  for (const command of ignored) assert.equal(classifyCommand(command, scope), undefined, command);
});

test("the release comes from the entry path's position, and `current` from the installed link", () => {
  assert.deepEqual(classifyCommand(`${node} ${release("0.4.1")} daemon`, scope), { role: "service", release: "0.4.1" });
  // `current` was the installed release the moment the process started.
  assert.deepEqual(classifyCommand(`${node} ${current()} daemon`, scope), { role: "service", release: installed });
  assert.deepEqual(classifyCommand(`${node} ${current()} daemon`, { roots: [root] }), { role: "service", release: "unknown" });
  assert.equal(classifyCommand(`${node} /elsewhere/releases/9.9.9/package/dist/cli.js daemon`, scope), undefined);
  // The script can also be argv[0] itself, when it carries its shebang.
  assert.deepEqual(classifyCommand(`${current()} daemon`, scope), { role: "service", release: installed });
  // A checkout run also accepts the script of the checkout it started from.
  const checkout = { roots: [], checkoutCli: ["/Users/dev/gw/dist/cli.js"] };
  assert.deepEqual(classifyCommand(`/usr/bin/node /Users/dev/gw/dist/cli.js daemon`, checkout), { role: "service", release: "checkout" });
  assert.deepEqual(classifyCommand(`/Users/dev/gw/dist/cli.js serve`, checkout), { role: "inference", release: "checkout" });
  assert.equal(classifyCommand("/usr/bin/vim notes.txt", checkout), undefined);
  // A release path under another root is still not ours in a checkout run.
  assert.equal(classifyCommand(`${node} ${release("0.4.0")} serve`, checkout), undefined);
  // A second path later in the line is an argument; the entry the kernel started is the one that counts.
  assert.deepEqual(classifyCommand(`${node} ${current()} daemon --helper /elsewhere/releases/9.9.9/package/dist/cli.js`, scope),
    { role: "service", release: installed });
});

test("a command line is matched in both forms of the install root", async () => {
  const base = await mkdtemp(join(tmpdir(), "gateway-versions-root-"));
  try {
    const real = await realpath(base);
    const other = join(base, "linked");
    await mkdir(join(real, "releases/1.2.3/package/dist"), { recursive: true });
    await symlink("releases/1.2.3", join(real, "current"));
    await symlink(real, other);
    const lexical = `${other}/current/package/dist/cli.js`;
    const resolved = `${real}/releases/1.2.3/package/dist/cli.js`;
    assert.deepEqual(installedRelease(other), "1.2.3", "the link is read through either form of the root");
    for (const written of [lexical, resolved]) {
      // The run is rooted at the linked form; a command may name it resolved, or as written.
      assert.deepEqual(classifyCommand(`${node} ${written} daemon`, { roots: [other, real], installed: "1.2.3" }),
        { role: "service", release: "1.2.3" }, written);
      const result = await runVersions({ ps: async () => psLine(801, uid, `${node} ${written} daemon`), lsof: async () => { throw new Error("lsof: no access"); },
        sockets: async () => "", uid, root: other, installed: "1.2.3" });
      assert.deepEqual(result.processes.map(row => `${row.role}@${row.release}`), ["service@1.2.3"], written);
      // A run rooted at the resolved form still reads its own `current` link.
      assert.equal(installedRelease(real), "1.2.3");
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("lsof names the release a process mapped, or unknown when it cannot", () => {
  assert.equal(parseLsofTxt(mapped(release("0.4.1"))), "0.4.1");
  assert.equal(parseLsofTxt("p401\nftxt\n/usr/lib/dyld"), "unknown");
  assert.equal(parseLsofTxt(""), "unknown");
  assert.equal(parseLsofTxt("lsof: operation not permitted"), "unknown");
});

test("the inference port comes from the process's own listening socket", () => {
  assert.deepEqual(parseListenPorts(listening("127.0.0.1:4317")), [4317]);
  // A port named in the arguments is never read; only these sockets are dialed.
  assert.deepEqual(parseListenPorts(listening("127.0.0.1:3457", "127.0.0.1:3457", "localhost:4400")), [3457, 4400]);
  assert.deepEqual(parseListenPorts(listening("[::1]:4317", "*:9999", "10.0.0.5:8080", "/tmp/x.sock")), []);
  assert.deepEqual(parseListenPorts(""), []);
  assert.deepEqual(parseListenPorts("lsof: no such process"), []);
});

test("an inference process is asked on each socket it listens on, however it was started", async () => {
  const seen: number[] = [];
  const result = await runVersions(fleet({
    // A real launch: a configuration path with spaces, and no `--port` anywhere.
    ps: async () => psLine(701, uid, `${node} ${current()} serve --config /Users/edi/My Gateway/gateway.json`),
    lsof: async () => mapped(release("0.4.1")),
    sockets: async () => listening("*:9999", "127.0.0.1:4400", "127.0.0.1:4317"),
    health: async port => { seen.push(port); return port === 4400 ? installed : undefined },
  }));
  assert.deepEqual(seen, [4317, 4400], "each loopback socket is asked, lowest first, from the process not its arguments");
  assert.deepEqual(result.processes.map(row => `${row.role}@${row.release}`), ["inference@0.4.2"]);
  assert.equal(result.lagging, 0, "the release it answers with is the release it serves");
});

test("an inference process that answers nowhere is judged by what it mapped", async () => {
  const asked: number[] = [];
  const result = await runVersions(fleet({
    // A stale `--port` in the arguments names nothing: the socket of the process does.
    ps: async () => psLine(701, uid, `${node} ${current()} serve --port 9999`),
    // The node runtime it started from is still mapped, so `lsof` alone names the older release.
    lsof: async () => mapped(release("0.4.1")),
    sockets: async (pid) => { asked.push(pid); return listening("127.0.0.1:4317") },
    health: async () => { throw new Error("ECONNREFUSED") },
  }));
  assert.deepEqual(asked, [701], "the sockets asked are the ones this pid holds");
  assert.deepEqual(result.processes.map(row => `${row.role}@${row.release}`), ["inference@0.4.1"]);
  assert.equal(result.lagging, 1);
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

test("the report never names this process, only the ones it is watching", async () => {
  const result = await runVersions(fleet({ ps: async () => psLine(process.pid, uid, `${node} ${current()} daemon`) }));
  assert.deepEqual(result.processes, [], "a `versions` run is not a gateway that can lag");
  const pair = await runVersions(fleet({
    ps: async () => [psLine(process.pid, uid, `${node} ${current()} daemon`), psLine(401, uid, `${node} ${release(installed)} daemon`)].join("\n"),
  }));
  assert.deepEqual(pair.processes.map(row => row.pid), [401]);
});

test("an unreadable current link leaves the release unknown and lagging", async () => {
  const result = await runVersions({ ps: async () => psLine(401, uid, `${node} ${current()} daemon`), lsof: async () => { throw new Error("lsof: no access"); },
    sockets: async () => "", uid, root, installed: undefined });
  assert.deepEqual(result.processes, [{ role: "service", pid: 401, startedAt: result.processes[0]!.startedAt, release: "unknown" }]);
  assert.equal(result.lagging, 1);
});

test("a checkout run reports every gateway it started as checkout", async () => {
  const result = await runVersions({
    ps: async () => [psLine(501, uid, `${node} /Users/dev/gw/dist/cli.js daemon`), psLine(502, uid, `${node} ${release(installed)} serve`),
      psLine(503, uid, "/usr/bin/vim notes.txt")].join("\n"),
    lsof: async () => "", sockets: async () => "", uid, fallbackRoot: missingRoot,
    checkoutCli: "/Users/dev/gw/dist/cli.js", health: async () => undefined,
  });
  assert.deepEqual(result.processes.map(row => `${row.role}@${row.release}`), ["service@checkout"]);
  assert.equal(result.installed, null);
  assert.equal(result.lagging, 1);
});

test("the human report shows local start times and names who is behind", () => {
  const started = "2026-10-12T07:14:01.000Z";
  const all = { installed, processes: [{ role: "service" as const, pid: 401, startedAt: started, release: installed }], lagging: 0 };
  assert.equal(formatHuman(all), `installed ${installed}\n\n  service  401  ${localStart(started)}  ${installed}\n\nall on ${installed}\n`);
  const behind = { installed, processes: [...all.processes, { role: "native-relay" as const, pid: 408, startedAt: "2026-10-12T07:14:07.000Z", release: "0.4.1" },
    { role: "gateway-engine" as const, pid: 407, startedAt: "2026-10-12T07:14:06.000Z", release: "0.4.1" }], lagging: 2 };
  // Columns line up on the widest role and pid, and the summary names each stale pair once.
  assert.deepEqual(formatHuman(behind).split("\n"), [
    "installed 0.4.2", "",
    `  service         401  ${localStart(started)}  0.4.2`,
    `  native-relay    408  ${localStart("2026-10-12T07:14:07.000Z")}  0.4.1`,
    `  gateway-engine  407  ${localStart("2026-10-12T07:14:06.000Z")}  0.4.1`,
    "", "2 lagging: native-relay@0.4.1 gateway-engine@0.4.1", "",
  ]);
  assert.match(formatHuman({ installed: null, processes: [], lagging: 0 }), /no gateway processes running\n$/);
});

test("a start time prints on the reader's own clock, in any zone", () => {
  // `lstart` is local wall-clock time, and the report must give it back as the same wall clock.
  for (const hour of [0, 9, 23]) {
    const iso = new Date(2026, 9, 12, hour, 14, 1).toISOString();
    assert.equal(formatStart(iso), `2026-10-12 ${String(hour).padStart(2, "0")}:14`);
    // A machine set to UTC cannot tell the two apart; everywhere else the UTC text must be wrong.
    if (new Date(2026, 9, 12).getTimezoneOffset() !== 0) assert.notEqual(formatStart(iso), `${iso.slice(0, 10)} ${iso.slice(11, 16)}`);
  }
});

test("--json prints the result and --check only fails the run when something lags", async () => {
  const printed: string[] = [];
  const plain = await versionsCommand([], fleet({ stdout: text => printed.push(text), stderr: () => {} }));
  assert.equal(plain, 0, "without --check a lagging fleet still succeeds");
  assert.match(printed.at(-1)!, /3 lagging: desktop-adapter@0\.4\.1 gateway-engine@0\.4\.1 native-relay@0\.4\.1\n$/);

  printed.length = 0;
  const json = await versionsCommand(["--json"], fleet({ stdout: text => printed.push(text), stderr: () => {} }));
  assert.equal(json, 0);
  const parsed = JSON.parse(printed.at(-1)!);
  assert.equal(parsed.installed, installed);
  assert.equal(parsed.lagging, 3);
  assert.equal(parsed.processes.length, 10);
  assert.ok(parsed.processes.every((row: { startedAt: string }) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.startedAt)),
    "the JSON keeps the UTC instant the report only displays locally");

  assert.equal(await versionsCommand(["--check"], fleet({ stdout: () => {}, stderr: () => {} })), 1);
  const onTime = { ps: async () => psLine(401, uid, `${node} ${release(installed)} daemon`), lsof: async () => mapped(release(installed)),
    sockets: async () => "", uid, root, installed };
  assert.equal(await versionsCommand(["--check"], { ...onTime, stdout: () => {}, stderr: () => {} }), 0);
  const err: string[] = [];
  assert.equal(await versionsCommand(["--watch"], fleet({ stdout: () => {}, stderr: text => err.push(text) })), 2);
  assert.match(err.join(""), /Usage: gateway versions/);
});

test("a process list ps cannot read is a broken run, not an empty fleet", async () => {
  const err: string[] = [];
  const out: string[] = [];
  const code = await versionsCommand(["--json"], { ps: async () => { throw new Error("ps: operation not permitted"); }, stdout: t => out.push(t), stderr: t => err.push(t) });
  assert.equal(code, 2);
  assert.deepEqual(out, [], "nothing half-read is printed");
  assert.match(err.join(""), /could not read the process list/);
});

test("help asks for nothing and exits clean", async () => {
  for (const flag of ["--help", "-h"]) {
    const out: string[] = [];
    const err: string[] = [];
    const asked: number[] = [];
    const code = await versionsCommand([flag], fleet({
      stdout: text => out.push(text), stderr: text => err.push(text),
      ps: async () => { asked.push(1); return psOut },
    }));
    assert.equal(code, 0, flag);
    assert.deepEqual(out, ["Usage: gateway versions [--json] [--check]\n"], flag);
    assert.deepEqual(err, [], flag);
    assert.deepEqual(asked, [], "help answers from the flag alone");
  }
});

test("a checkout run falls back to the default install root", async () => {
  const fallback = await mkdtemp(join(tmpdir(), "gateway-versions-"));
  try {
    await mkdir(join(fallback, "releases/9.9.9/package/dist"), { recursive: true });
    await symlink("releases/9.9.9", join(fallback, "current"));
    const checkoutCli = join(await realpath(fallback), "checkout", "dist", "cli.js");
    const result = await runVersions({
      ps: async () => [
        psLine(601, uid, `${node} ${checkoutCli} daemon`),
        psLine(602, uid, `${node} ${fallback}/releases/9.9.9/package/dist/cli.js executor-host --config /c.json`, 12, 2),
        // A loose run only reads the tree it fell back to, and only where the program sits.
        psLine(603, uid, "/opt/app/releases/2024.1/bin/server --port 8080"),
        psLine(604, uid, `/bin/zsh -c node ${fallback}/releases/9.9.9/package/dist/cli.js daemon`),
      ].join("\n"),
      // The checkout process maps nothing of ours, so only the command line can name its release.
      lsof: async () => "", sockets: async () => "", uid, fallbackRoot: fallback, checkoutCli,
    });
    assert.equal(result.installed, "9.9.9", "the fallback current link names the installed release");
    assert.deepEqual(result.processes.map(row => `${row.role}@${row.release}`), ["executor-host@9.9.9", "service@checkout"]);
    assert.equal(result.lagging, 1);
  } finally { await rm(fallback, { recursive: true, force: true }); }
});

test("a run with neither release named reports installed null and fails --check with 2", async () => {
  const deps: VersionsExecutors = {
    ps: async () => psLine(601, uid, `${node} ${fileURLToPath(new URL("../cli.js", import.meta.url))} daemon`), lsof: async () => "", sockets: async () => "",
    uid, fallbackRoot: missingRoot,
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

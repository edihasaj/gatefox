import test from "node:test";
import assert from "node:assert/strict";
import { desktopFindings, parseProcessTable, stockEngineReason } from "../health-desktop.js";
import { runHealth, type HealthDeps } from "../health.js";
import type { Exec } from "../health-types.js";

const app = "/Applications/ChatGPT.app";
const install = "/Users/edi/.local/share/harness-gateway";
const engine = `${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
const receipt = JSON.stringify({ wrapper: "/Users/edi/.local/state/harness-gateway/codex-wrapper" });

const main = (pid: number) => `${pid} 1 ${app}/Contents/MacOS/ChatGPT`;
/** The helpers every ChatGPT has, which say nothing about the engine. */
const helpers = (pid: number) => [
  `${pid + 1} ${pid} ${app}/Contents/Frameworks/Codex (Service).app/Contents/MacOS/Codex (Service) --type=utility`,
  `${pid + 2} ${pid} ${app}/Contents/Frameworks/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer`,
  `${pid + 3} ${pid} ${engine} --listen stdio:// exec-server`,
];
const gatewayed = (pid: number) => `${pid + 9} ${pid} ${install}/current/runtime/bin/node ${install}/current/package/dist/cli.js codex-shim --stdio`;
const stock = (pid: number) => `${pid + 9} ${pid} ${engine} -c features.plugins=false app-server --listen stdio://`;
const table = (...lines: string[]) => lines.join("\n") + "\n";

/** The injected command seam: only `ps` with the three columns is answered, and every call is kept. */
function seam(out: string) {
  const calls: Array<[string, string[]]> = [];
  const exec: Exec = async (command, args) => { calls.push([command, args]); if (command !== "/bin/ps") throw new Error("only ps is expected"); return out; };
  return { exec, calls };
}
const files = (contents: Record<string, string>) => async (path: string) => { if (path in contents) return contents[path]!; throw new Error("ENOENT"); };
const registered = files({ "/state/desktop-registration.json": receipt });

test("ps rows keep pid, ppid and the command, and skip what is not a row", () => {
  assert.deepEqual(parseProcessTable(" 12   1 /bin/zsh -l\nnot a row\n\n 13 12 /usr/bin/true a b\n"),
    [{ pid: 12, ppid: 1, command: "/bin/zsh -l" }, { pid: 13, ppid: 12, command: "/usr/bin/true a b" }]);
});

test("a registered ChatGPT on its stock engine warns, and reads only the process table", async () => {
  const ps = seam(table(main(500), ...helpers(500), stock(500)));
  assert.deepEqual(await desktopFindings("/state", app, { readFile: registered, exec: ps.exec }), [{ level: "warn", reason: stockEngineReason }]);
  assert.match(stockEngineReason, /quit and reopen ChatGPT to use gateway chats/);
  assert.deepEqual(ps.calls, [["/bin/ps", ["-axo", "pid=,ppid=,command="]]]);
  // The exact arguments are the guard: `ps e` would print another process's environment, and these never ask for it.
});

test("a gatewayed ChatGPT, or one still starting, says nothing", async () => {
  for (const rows of [[main(500), ...helpers(500), gatewayed(500)], [main(500), ...helpers(500)]]) {
    assert.deepEqual(await desktopFindings("/state", app, { readFile: registered, exec: seam(table(...rows)).exec }), []);
  }
  // The exec-server child is the engine too, but it is not the app-server, so alone it is no verdict.
  assert.deepEqual(await desktopFindings("/state", app, { readFile: registered, exec: seam(table(main(500), helpers(500)[2]!)).exec }), []);
});

test("a stock engine under another process, or a lookalike, is not ChatGPT's", async () => {
  const other = [`900 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT-helper`, `901 777 ${engine} app-server`, stock(5000)];
  assert.deepEqual(await desktopFindings("/state", app, { readFile: registered, exec: seam(table(...other)).exec }), [{ level: "info", reason: "ChatGPT not running" }]);
  // One main process running the gateway's engine is enough, whatever else is on the table.
  assert.deepEqual(await desktopFindings("/state", app, { readFile: registered, exec: seam(table(main(500), stock(500), main(700), gatewayed(700))).exec }), []);
});

test("a gatewayed ChatGPT beside an unrelated stock engine reports nothing, and a trailing slash on the app path is ignored", async () => {
  // The stock engine is another process's child (ppid 777 is not ChatGPT), so it says nothing about this app.
  const rows = table(main(500), ...helpers(500), gatewayed(500), `901 777 ${engine} app-server --listen stdio://`);
  assert.deepEqual(await desktopFindings("/state", app, { readFile: registered, exec: seam(rows).exec }), []);
  assert.deepEqual(await desktopFindings("/state", `${app}/`, { readFile: registered, exec: seam(rows).exec }), []);
  const slashed = seam(table(main(500), ...helpers(500), stock(500)));
  assert.deepEqual(await desktopFindings("/state", `${app}/`, { readFile: registered, exec: slashed.exec }), [{ level: "warn", reason: stockEngineReason }]);
});

test("ChatGPT not running is info, and no registration asks for nothing", async () => {
  assert.deepEqual(await desktopFindings("/state", app, { readFile: registered, exec: seam(table("1 0 /sbin/launchd")).exec }), [{ level: "info", reason: "ChatGPT not running" }]);
  for (const contents of [{} as Record<string, string>,{ "/state/desktop-registration.json": "{}" }, { "/state/desktop-registration.json": JSON.stringify({ wrapper: "" }) }, { "/state/desktop-registration.json": "not json" }]) {
    const ps = seam(table(main(500), stock(500)));
    assert.deepEqual(await desktopFindings("/state", app, { readFile: files(contents), exec: ps.exec }), []);
    assert.equal(ps.calls.length, 0, "no registration, no process table");
  }
});

/** The whole run, on injected readers only. */
function run(deps: Partial<HealthDeps>) {
  return runHealth({ stateDirectory: "/state", port: 3457 }, {
    now: () => Date.parse("2026-10-17T07:37:00Z"), exists: async () => false, state: async () => undefined, writeState: async () => {}, readPlan: async () => undefined,
    readStatus: async () => ({ installed: true, published: true, components: [{ kind: "inference", state: "running" }] }),
    versions: async () => ({ installed: "0.4.4", lagging: 0, processes: [] }), telemetry: async () => [],
    probe: async () => ({ state: "answered", status: 200, release: "0.4.4", bodyStatus: "ok" }), ...deps,
  });
}

test("the stock engine moves the verdict to warn, and nothing else on the report", async () => {
  const stockReport = await run({ readFile: registered, exec: seam(table(main(500), ...helpers(500), stock(500))).exec });
  assert.equal(stockReport.verdict, "warn");
  assert.deepEqual(stockReport.findings.filter(finding => finding.level === "warn"), [{ level: "warn", reason: stockEngineReason }]);
  const gatewayReport = await run({ readFile: registered, exec: seam(table(main(500), ...helpers(500), gatewayed(500))).exec });
  assert.equal(gatewayReport.verdict, "ok");
  const idle = await run({ readFile: registered, exec: seam(table("1 0 /sbin/launchd")).exec });
  assert.equal(idle.verdict, "ok");
  assert.ok(idle.findings.some(finding => finding.level === "info" && finding.reason === "ChatGPT not running"));
  // A process table that cannot be read is a degraded section, never a failed run.
  const broken = await run({ readFile: registered, exec: async () => { throw new Error("ps failed"); } });
  assert.equal(broken.verdict, "warn");
  assert.ok(broken.findings.some(finding => finding.reason === "desktop unreadable"));
  assert.equal(JSON.stringify(stockReport).includes("codex-wrapper"), false);
});

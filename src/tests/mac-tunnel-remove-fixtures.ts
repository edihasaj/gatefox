import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { after } from "node:test";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTunnelComponent, type TunnelRemoveSeams } from "../mac-tunnel-remove.js";
import type { SshResolver } from "../mac-tunnel-ssh.js";
import { readServicePlan, servicePlanPath, type ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";

const roots = new Set<string>();
/** A private temporary directory that is removed by `removeRoot`, or at the end of the test file at the latest. */
export async function tempRoot(prefix: string): Promise<string> { const root = await mkdtemp(join(tmpdir(), prefix)); roots.add(root); return root; }
export async function removeRoot(root: string): Promise<void> { roots.delete(root); await rm(root, { recursive: true, force: true }); }
/** Removes every root still registered; a test that never calls its fixture's stop() leaves nothing behind. */
export async function removeAllRoots(): Promise<void> { await Promise.all([...roots].map(removeRoot)); }
after(removeAllRoots);

/** An ssh_config file in its own removable directory. */
export async function sshConfigFile(...lines: string[]): Promise<string> {
  const path = join(await tempRoot("gw-tunnel-ssh-"), "ssh_config");
  await writeFile(path, lines.join("\n") + "\n"); return path;
}

const bind = async (server: { once(event: "error", cb: () => void): unknown; listen(port: number, host: string, cb: () => void): unknown }): Promise<boolean> =>
  new Promise(done => { server.once("error", () => done(false)); server.listen(0, "127.0.0.1", () => done(true)); });

/** A port with nothing behind it; sandboxes that forbid sockets get a random one. */
export async function unusedPort(): Promise<number> {
  const server = createNetServer();
  if (await bind(server)) { const port = (server.address() as { port: number }).port; await new Promise(done => server.close(done)); return port; }
  return 41000 + Math.floor(Math.random() * 1000);
}

export interface Health { port: number; stop(): Promise<void> }
/** The gateway's /health listener. `null` means no inference listener answers at all. */
export async function health(body: Record<string, unknown> | null): Promise<Health> {
  if (body === null) return { port: await unusedPort(), stop: async () => {} };
  const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); });
  if (await bind(server)) return { port: (server.address() as { port: number }).port, stop: () => new Promise(done => server.close(() => done())) };
  const port = await unusedPort(); const real = globalThis.fetch;
  globalThis.fetch = (input, init) => new URL(String(input)).port === String(port)
    ? Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })) : real(input as never, init as never);
  return { port, stop: async () => { globalThis.fetch = real; } };
}

export const none = async () => "";
export const running = async () => "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n";
export const forward = "127.0.0.1:18301:127.0.0.1:18300";
export const sparkArgs = (...forwards: string[]) => ["-N", "-T", ...forwards, "qwen-spark"];
export const ids = (plan: ServicePlan | undefined) => plan!.components.map(component => component.id);
export const noBackups = async (state: string) => assert.ok(!(await readdir(state)).includes("service-backups"), "nothing was backed up");
export const api = (baseUrl: string) => ({ id: "spark_api", type: "responses-api", baseUrl, apiKeyEnv: "SPARK_API_KEY", models: { spark: "spark" } });

/** A plan with inference, the tunnel under test, and a reverse tunnel that must survive. */
export async function fixture(answer: Record<string, unknown> | null, provider?: Record<string, unknown>, forwards = ["-L", forward]) {
  const root = await tempRoot("gw-tunnel-remove-"); const state = join(root, "state"); await mkdir(state, { recursive: true, mode: 0o700 });
  const listener = await health(answer); const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: listener.port, stateDirectory: state,
    providers: [{ id: "claude", type: "claude-subscription", models: { claude: "claude" } }, ...(provider ? [provider] : [])] }));
  const tunnel = (id: string, args: string[]) => ({ id, kind: "tunnel" as const, command: "/usr/bin/ssh", args, log: join(state, `${id}.log`) });
  const plan: ServicePlan = { version: 1, config, sharedExecutors: true, components: [
    { id: "inference", kind: "inference", command: "/bin/true", args: [], log: join(state, "inference.log") },
    { id: "desktop", kind: "desktop", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", args: ["--app", "/Applications/ChatGPT.app"], log: join(state, "desktop.log") },
    tunnel("tunnel-spark", sparkArgs(...forwards)),
    tunnel("tunnel-studio", ["-N", "-T", "-R", "3459:127.0.0.1:3457", "mac-studio"]),
  ] };
  await writePrivateJson(servicePlanPath(state), plan);
  return { root, state, plan, stop: async () => { await listener.stop(); await removeRoot(root); } };
}

/** A plan whose tunnels stand alone: no inference component and no local listener to probe. */
export async function transportFixture(port: number, clientOnly: boolean, forwards = ["-L", `127.0.0.1:${port}:127.0.0.1:18300`], only = false, hostLast = true) {
  const root = await tempRoot("gw-tunnel-remove-"); const state = join(root, "state"); await mkdir(state, { recursive: true, mode: 0o700 });
  const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify(clientOnly
    ? { version: 1, port, stateDirectory: state, providers: [], clientOnly: true }
    : { version: 1, port, stateDirectory: state, providers: [{ id: "claude", type: "claude-subscription", models: { claude: "claude" } }] }));
  const tunnel = (id: string, args: string[]) => ({ id, kind: "tunnel" as const, command: "/usr/bin/ssh", args, log: join(state, `${id}.log`) });
  const spark = tunnel("tunnel-spark", hostLast ? sparkArgs(...forwards) : ["-N", "-T", ...forwards]);
  const components = only ? [spark] : [
    { id: "desktop", kind: "desktop" as const, command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", args: ["--app", "/Applications/ChatGPT.app"], log: join(state, "desktop.log") },
    spark,
    tunnel("tunnel-studio", ["-N", "-T", "-R", "3459:127.0.0.1:3457", "mac-studio"]),
  ];
  const plan: ServicePlan = { version: 1, config, sharedExecutors: !only, components };
  await writePrivateJson(servicePlanPath(state), plan);
  return { root, state, plan, stop: () => removeRoot(root) };
}

/** ssh resolves nothing beyond the tunnel's own arguments: no ssh_config forwards and no GatewayPorts. */
export const noSsh: SshResolver = async () => ({ listeners: [], declared: false, gatewayPorts: false });
/** Pass `{}` as the seams to use the real `/usr/bin/ssh -G`. */
export const remove = async (state: string, id: string, listProcesses = none, seams: TunnelRemoveSeams = { resolveSsh: noSsh }) =>
  removeTunnelComponent(state, (await readServicePlan(state))!, id, listProcesses, seams);

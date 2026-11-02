import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processStartMs } from "./boot-identity.js";
import { readRegularFile, atomicWrite } from "./service-claude-io.js";
import type { ServiceComponent } from "./service-plan.js";
import { isClaudeComponent } from "./service-claude-activity.js";
import { staleForwardCleanup, serviceTunnelArguments } from "./service-tunnel.js";

interface RemoteOwner { pid: number; start: string; peer: string }
interface Receipt { version: 1; definition: string; clientPid: number; clientStart: number; owner: RemoteOwner }
export interface OwnedForwardDeps {
  run(file: string, args: string[], environment?: Record<string, string>): Promise<string>;
  start(pid: number): Promise<number | undefined>;
  alive(pid: number): boolean | undefined;
  wait(): Promise<void>;
}
const execute = promisify(execFile);
const defaults: OwnedForwardDeps = {
  run: async (file, args, environment) => (await execute(file, args, { timeout: 10000, maxBuffer: 65536, env: { ...process.env, ...environment } })).stdout,
  start: processStartMs,
  alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; } },
  wait: () => delay(250),
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const peerPattern = /^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
const validOwner = (value: unknown): value is RemoteOwner => {
  if (!value || typeof value !== "object") return false;
  const v = value as RemoteOwner;
  return Number.isSafeInteger(v.pid) && v.pid > 1 && v.pid < 2147483648 && typeof v.start === "string" && /^[A-Za-z0-9 :+-]{8,80}$/.test(v.start)
    && typeof v.peer === "string" && peerPattern.test(v.peer);
};

/** The remote command can signal only a same-user sshd with the saved start stamp, listener and TCP peer. */
export const ownedForwardProgram = `import os,sys,json,base64,subprocess,signal,shutil
v=json.loads(base64.urlsafe_b64decode(sys.argv[1]+'='*(-len(sys.argv[1])%4)))
port=int(v['port']);assert 0<port<65536
lsof=shutil.which('lsof') or '/usr/sbin/lsof'
def run(args):
 r=subprocess.run(args,capture_output=True,text=True,timeout=5,env={**os.environ,'LC_ALL':'C'})
 if r.returncode not in (0,1):raise RuntimeError('probe_failed')
 return r.stdout
def owner():
 rows=run([lsof,'-nP','-a','-u',str(os.getuid()),'-iTCP@127.0.0.1:'+str(port),'-sTCP:LISTEN','-Fp'])
 pids=set(int(x[1:]) for x in rows.splitlines() if x.startswith('p'))
 if len(pids)!=1:return None
 pid=pids.pop();info=run(['ps','-p',str(pid),'-o','uid=,comm=']).strip().split(None,1)
 if len(info)!=2 or int(info[0])!=os.getuid() or info[1].split(':')[0].split('/')[-1] not in ('sshd','sshd-session'):return None
 peers=run([lsof,'-nP','-a','-p',str(pid),'-iTCP','-sTCP:ESTABLISHED','-Fn'])
 expected=v['peer']
 if not any(x.startswith('n') and x[1:].endswith('->'+expected) for x in peers.splitlines()):return None
 stamp=run(['ps','-p',str(pid),'-o','lstart=']).strip()
 return {'pid':pid,'start':stamp,'peer':expected} if stamp else None
found=owner()
if v['action']=='probe':print(json.dumps(found))
elif v['action']=='clear':
 expected=v['owner']
 if found and found==expected and owner()==expected:os.kill(found['pid'],signal.SIGTERM);print('1')
 else:print('0')
else:raise RuntimeError('action')
`;

function specification(component: ServiceComponent): { port: number; command: string[]; definition: string } | undefined {
  if (component.command !== "/usr/bin/ssh" || component.kind !== "tunnel" || !isClaudeComponent(component)) return;
  const index = component.args.indexOf("-R");
  const match = /^(?:127\.0\.0\.1|localhost):(\d{1,5}):127\.0\.0\.1:\d{1,5}$/.exec(component.args[index + 1] ?? "");
  const cleanup = index >= 0 ? staleForwardCleanup(component.args) : undefined;
  const port = Number(match?.[1]);
  if (!cleanup || !match || port < 1 || port > 65535) return;
  return { port, command: serviceTunnelArguments(cleanup.slice(0, -1)), definition: hash([component.command, component.args]) };
}
const receiptPath = (state: string, component: ServiceComponent) => join(state, "services", `forward-owner-${hash(component.id).slice(0, 16)}.json`);
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export function ownedForwardArguments(command: string[], action: "probe" | "clear", port: number, peer: string, owner?: RemoteOwner): string[] {
  const encoded = Buffer.from(JSON.stringify({ action, port, peer, ...(owner ? { owner } : {}) })).toString("base64url");
  return [...command, `python3 -c ${quote(ownedForwardProgram)} ${quote(encoded)}`];
}

/** Capture an already-connected owned child. Never signal or change a running connection. */
export async function rememberOwnedForward(component: ServiceComponent, pid: number, state: string, deps = defaults): Promise<boolean> {
  const spec = specification(component); if (!spec) return false;
  try {
    const started = await deps.start(pid); if (started === undefined) return false;
    let peer: string | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await deps.start(pid) !== started) return false;
      const sockets = await deps.run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-u", String(process.getuid?.()), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"]).catch(() => "");
      const links = sockets.split("\n").filter(line => /^n[^\n]+->[^\n]+:22$/.test(line));
      if (links.length === 1) { const local = links[0].slice(1).split("->")[0]; if (peerPattern.test(local)) peer = local; }
      if (peer) break;
      await deps.wait();
    }
    if (!peer) return false;
    const owner: unknown = JSON.parse(await deps.run(component.command, ownedForwardArguments(spec.command, "probe", spec.port, peer), component.environment));
    if (!validOwner(owner) || owner.peer !== peer || await deps.start(pid) !== started) return false;
    const receipt: Receipt = { version: 1, definition: spec.definition, clientPid: pid, clientStart: started, owner };
    await mkdir(join(state, "services"), { recursive: true, mode: 0o700 });
    await atomicWrite(receiptPath(state, component), JSON.stringify(receipt) + "\n"); return true;
  } catch { return false; }
}

/** A missing/changed receipt or a live original client never authorizes remote cleanup. */
export async function clearOwnedForward(component: ServiceComponent, state: string, deps = defaults): Promise<number> {
  const spec = specification(component); if (!spec) return 0;
  try {
    const file = await readRegularFile(receiptPath(state, component), 8192, true); if (!file) return 0;
    const receipt = JSON.parse(file.bytes.toString("utf8")) as Receipt;
    if (receipt.version !== 1 || receipt.definition !== spec.definition || !validOwner(receipt.owner)
      || !Number.isSafeInteger(receipt.clientPid) || receipt.clientPid < 2 || !Number.isFinite(receipt.clientStart)) return 0;
    const started = await deps.start(receipt.clientPid);
    if (started === receipt.clientStart || started === undefined && deps.alive(receipt.clientPid) !== false) return 0;
    const result = await deps.run(component.command, ownedForwardArguments(spec.command, "clear", spec.port, receipt.owner.peer, receipt.owner), component.environment);
    return result.trim() === "1" ? 1 : 0;
  } catch { return 0; }
}

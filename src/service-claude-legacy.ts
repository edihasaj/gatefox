import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { ServiceComponent } from "./service-plan.js";
import type { Plist } from "./service-claude-io.js";

/** Pure translation of the four exact legacy Claude LaunchAgents into app-owned service components. */
export const claudeAdapterMarker = "<!-- Managed by harness-gateway Claude Desktop adapter -->";
export const defaultLaunchPath = "/usr/bin:/bin:/usr/sbin:/sbin";
/** The private, app-owned destination of a migrated component's output; the supervisor creates it mode 0600. */
export const claudeLogPath = (state: string, componentId: string): string => join(state, "services", `${componentId}.log`);
export type LegacyKind = "adapter" | "inference" | "tunnel";
export interface LegacySpec { label: string; kind: LegacyKind; componentId: string; forward?: "-L" | "-R" }
export const legacySpecs: readonly LegacySpec[] = [
  { label: "com.edihasaj.claude-desktop-adapter", kind: "adapter", componentId: "claude-adapter" },
  { label: "com.edihasaj.claude-inference", kind: "inference", componentId: "claude-inference" },
  { label: "com.edihasaj.claude-inference-tunnel", kind: "tunnel", componentId: "claude-inference-tunnel", forward: "-L" },
  { label: "com.edihasaj.claude-inference-studio", kind: "tunnel", componentId: "claude-inference-studio", forward: "-R" },
];

/** A check that answered no: nothing was changed and the work may be tried again later. */
export class ClaudeRefusal extends Error {
  constructor(readonly reason: string, message?: string) { super(message ?? `Claude consolidation refused: ${reason}`); }
}
/** Legacy jobs may be retired and cannot be proven restorable; the service must stop instead of pretending to be normal. */
export class ClaudeRetirementError extends Error {}

export interface ParsedLegacy { spec: LegacySpec; component: ServiceComponent; argv: string[]; pins: string[] }
export interface LegacyContext { home: string; appNode: string; state: string }

const shape = (message: string) => new ClaudeRefusal("legacy_shape", `Legacy Claude job rejected: ${message}`);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value);
const normal = (value: unknown): value is string => text(value) && isAbsolute(value) && resolve(value) === value;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function launchPath(environment: unknown): string | undefined {
  if (environment === undefined) return undefined;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw shape("environment");
  const entries = Object.entries(environment as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]![0] !== "PATH" || !text(entries[0]![1])) throw shape("only PATH may be set");
  const value = entries[0]![1] as string;
  if (!value.split(":").every(entry => normal(entry))) throw shape("PATH entries must be absolute");
  return value;
}

function validPort(value: string): number {
  const port = Number(value);
  if (!/^\d{1,5}$/.test(value) || port < 1 || port > 65535) throw shape("port");
  return port;
}

function checkForward(spec: string | undefined): void {
  // An omitted bind address can become a wildcard through ssh configuration, so the bind must be explicit loopback.
  const match = /^(?:127\.0\.0\.1|localhost):(\d{1,5}):(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(spec ?? "");
  if (!match) throw shape("forward must be explicit loopback to loopback");
  if (validPort(match[1]!) !== 3468 || validPort(match[2]!) !== 3468) throw shape("forward must use fixed loopback port 3468 on both ends");
}

/** The only ssh options a legacy tunnel may carry, each with its one permitted value shape. Multiplexing, persistence and remote commands stay off. */
const sshOptionValues: Record<string, RegExp> = {
  BatchMode: /^yes$/, RequestTTY: /^no$/, RemoteCommand: /^none$/, ControlMaster: /^no$/, ControlPath: /^none$/,
  ExitOnForwardFailure: /^yes$/, ConnectTimeout: /^\d{1,3}$/, ServerAliveInterval: /^\d{1,4}$/, ServerAliveCountMax: /^\d{1,3}$/,
};
const requiredSshOptions = ["RequestTTY", "RemoteCommand", "ControlMaster", "ControlPath"];
function checkSshOption(value: string | undefined, seen: Set<string>): void {
  const match = /^([A-Za-z]+)(?:=|\s+)(\S+)$/.exec(value ?? "");
  const rule = match ? sshOptionValues[match[1]!] : undefined;
  if (!match || !rule || !rule.test(match[2]!) || seen.has(match[1]!)) throw shape("ssh option");
  seen.add(match[1]!);
}

/** Only a quiet port forward is accepted; anything that could run a command or hop through a proxy is refused. */
function checkTunnel(args: string[], direction: "-L" | "-R" | undefined): void {
  if (args[0] !== "/usr/bin/ssh") throw shape("tunnel command");
  if (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.at(-1)!)) throw shape("tunnel host");
  let quiet = 0; let terminal = 0; let forwards = 0; const options = new Set<string>();
  for (let index = 1; index < args.length - 1; index++) {
    const arg = args[index]!;
    if (arg === "-N") quiet++;
    else if (arg === "-T") terminal++;
    else if (["-n", "-q", "-4", "-6", "-x"].includes(arg)) continue;
    else if (arg === "-L" || arg === "-R") { if (arg !== direction) throw shape("forward direction"); checkForward(args[++index]); forwards++; }
    else if (arg === "-o") checkSshOption(args[++index], options);
    else if (arg === "-i") { if (!normal(args[++index])) throw shape("ssh identity"); }
    else if (arg === "-p") validPort(args[++index] ?? "");
    else if (arg === "-l") { if (!/^[A-Za-z0-9._-]+$/.test(args[++index] ?? "")) throw shape("ssh user"); }
    else throw shape("unexpected ssh argument");
  }
  if (quiet !== 1 || terminal !== 1 || forwards !== 1) throw shape("tunnel must be -N -T with one forward");
  if (!requiredSshOptions.every(name => options.has(name))) throw shape("tunnel must disable remote commands and connection sharing");
}

/** Validates one legacy plist exactly and returns the component that replaces it. Throws ClaudeRefusal when anything is unknown. */
export function parseLegacyJob(spec: LegacySpec, bytes: Buffer, plist: Plist, context: LegacyContext): ParsedLegacy {
  const allowed = ["Label", "ProgramArguments", "EnvironmentVariables", "RunAtLoad", "KeepAlive", "ThrottleInterval", "StandardOutPath", "StandardErrorPath", ...(spec.kind === "tunnel" ? [] : ["WorkingDirectory"])];
  if (Object.keys(plist).some(key => !allowed.includes(key))) throw shape("unknown key");
  if (plist.Label !== spec.label || plist.RunAtLoad !== true || plist.KeepAlive !== true) throw shape("lifecycle");
  const throttle = plist.ThrottleInterval;
  if (throttle !== undefined && (typeof throttle !== "number" || !Number.isInteger(throttle) || throttle < 1 || throttle > 3600)) throw shape("throttle interval");
  const args = plist.ProgramArguments;
  if (!Array.isArray(args) || args.length < 2 || args.length > 40 || !args.every(text)) throw shape("arguments");
  const log = plist.StandardOutPath;
  // Recognize both deployed inference log names without accepting arbitrary files beside the private runtime.
  const inferenceLogs = new Set(["service.log", "inference.log"].map(name => join(context.home, "Library", "Application Support", "Claude-3p", "inference", name)));
  const legacyLogAllowed = (value: string): boolean => value.startsWith(join(context.home, "Library", "Logs") + sep) || spec.kind === "inference" && inferenceLogs.has(value);
  if (!normal(log) || log !== plist.StandardErrorPath || !legacyLogAllowed(log)) throw shape("log path");
  // Legacy logs are often world-readable, which the supervisor refuses. They are kept untouched; the component writes a new private log.
  const output = claudeLogPath(context.state, spec.componentId);
  const path = launchPath(plist.EnvironmentVariables);
  const argv = args as string[];

  if (spec.kind === "tunnel") {
    checkTunnel(argv, spec.forward);
    return { spec, argv, pins: [], component: { id: spec.componentId, kind: "tunnel", command: "/usr/bin/ssh", args: argv.slice(1), ...(path ? { environment: { PATH: path } } : {}), log: output } };
  }

  if (spec.kind === "adapter" && !bytes.toString("utf8").includes(claudeAdapterMarker)) throw shape("missing adapter marker");
  const adapter = spec.kind === "adapter";
  const directory = join(context.home, "Library", "Application Support", "Claude-3p", adapter ? "desktop-adapter" : "inference");
  const script = new RegExp(`^${escapeRegExp(directory)}/releases/[0-9a-f]{20}/package/dist/cli\\.js$`);
  const configs = adapter ? [join(directory, "config.json")] : [join(directory, "gateway.json"), join(directory, "native-messages.json")];
  const tail = adapter ? ["claude-desktop", "serve", "--config", configs[0]!]
    : ["claude-desktop", "inference", "--gateway-config", configs[0]!, "--native-config", configs[1]!];
  if (argv.length !== 2 + tail.length || !normal(argv[0]) || basename(argv[0]) !== "node" || !script.test(argv[1]!) || tail.some((value, index) => argv[2 + index] !== value)) throw shape("pinned runtime arguments");
  if (plist.WorkingDirectory !== directory) throw shape("working directory");
  const bin = join(context.appNode, "..");
  return {
    spec, argv, pins: [argv[1]!, ...configs],
    component: { id: spec.componentId, kind: adapter ? "claude-adapter" : "claude-inference", command: context.appNode, args: argv.slice(1),
      environment: { PATH: `${bin}:${path ?? defaultLaunchPath}` }, workingDirectory: directory, log: output },
  };
}

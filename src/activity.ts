import { hostname, homedir } from "node:os";
import { resolve } from "node:path";
import { object, type Message } from "./app-server-connection.js";
import { executionHostHome, readOwnerRecord, receiptPidAlive, sameSocketIdentity, socketIdentity, type SocketIdentity } from "./execution-host-storage.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { parentOf } from "./gateway-chat-classifier.js";
import { threadFacts } from "./chat-identity.js";
import { errorClass } from "./turn-telemetry.js";
import { activityId, recordedActivity, type ActivityRow, type ActivityTurn } from "./activity-history.js";

export interface ActivityReport {
  version: 1;
  hostname: string;
  checkedAt: string;
  coverage: "available" | "partial" | "unavailable";
  hasMore: boolean;
  rows: ActivityRow[];
}
export interface ActivitySource { socketPath: string; socket?: SocketIdentity; native?: boolean }
export interface ActivityConnection {
  request(method: string, params: Message, timeoutMs?: number): Promise<Message>;
  send(message: Message): void;
  stop(): void;
}
export interface ActivityOptions {
  nativeHome?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Read-only dependency seams, never supplied by management requests. */
  sources?: () => Promise<ActivitySource[]>;
  verify?: (source: ActivitySource) => Promise<boolean>;
  connection?: (source: ActivitySource) => ActivityConnection;
  history?: () => Promise<{ rows: ActivityRow[]; partial: boolean }>;
}
const maxSources = 16, maxThreads = 64, maxRows = 32;
const isoSeconds = (value: unknown): string | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 253402300800 ? new Date(value * 1000).toISOString() : undefined;
const label = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120) : undefined;

async function ownedSources(configPath: string, nativeHome: string): Promise<ActivitySource[]> {
  const home = executionHostHome(configPath, nativeHome), { owner, mtimeMs } = await readOwnerRecord(resolve(home, "owner.json"));
  if (!owner || owner.state !== "running" || owner.configPath !== resolve(configPath) || owner.nativeHome !== resolve(nativeHome) ||
      !await receiptPidAlive(owner, mtimeMs)) return [];
  const sources: ActivitySource[] = [];
  if (owner.native?.socketPath === resolve(home, "native.sock")) sources.push({ ...owner.native, native: true });
  for (const generation of owner.generations) {
    if (generation.socketPath !== resolve(home, `e-${generation.revision.slice(0, 16)}.sock`)) throw Error("Invalid activity source");
    sources.push(generation);
  }
  return sources;
}
async function verified(source: ActivitySource): Promise<boolean> {
  const actual = await socketIdentity(source.socketPath);
  return !!actual && !!source.socket && sameSocketIdentity(actual, source.socket);
}

/** Observe existing execution only. Never starts an engine, resumes a chat, acknowledges a receipt or executes a tool. */
export async function readActivity(configPath: string, stateDirectory: string, options: ActivityOptions = {}): Promise<ActivityReport> {
  const checkedAt = new Date().toISOString(), rows = new Map<string, ActivityRow>(), connections: ActivityConnection[] = [];
  const report: ActivityReport = { version: 1, hostname: hostname().split(".")[0]!, checkedAt, coverage: "unavailable", hasMore: false, rows: [] };
  let closed = false, partial = false, observed = false;
  const current = () => !closed && !options.signal?.aborted;
  const check = options.verify ?? verified;
  const make = options.connection ?? (source => new SocketAppServerConnection(source.socketPath, async () => {}));
  const alive = async (source: ActivitySource) => current() && await check(source) && current();
  const work = async () => {
    const history = await (options.history?.() ?? recordedActivity(stateDirectory));
    if (!current()) return;
    for (const row of history.rows) rows.set(row.threadId, row);
    partial ||= history.partial;
    // A CLI invoked by an agent inherits that executor's private CODEX_HOME.
    // It is not the execution host's original native home. Never discover or
    // create another home from the caller's execution environment.
    const all = await (options.sources?.() ?? ownedSources(configPath, options.nativeHome ?? resolve(homedir(), ".codex")));
    if (!current()) return;
    if (all.length > maxSources) partial = report.hasMore = true;
    const sources: Array<{ source: ActivitySource; connection: ActivityConnection; ids: Set<string> }> = [];
    await Promise.all(all.slice(0, maxSources).map(async source => {
      if (!current()) return;
      try {
        if (!await alive(source)) { partial = true; return; }
        const connection = make(source); connections.push(connection);
        await connection.request("initialize", { clientInfo: { name: "gateway_activity_readonly", version: "1" }, capabilities: { experimentalApi: true } }, 2000);
        if (!await alive(source)) { partial = true; return; }
        connection.send({ method: "initialized", params: {} });
        const ids = new Set<string>(), cursors = new Set<string>(); let cursor: string | undefined;
        for (let page = 0; page < 4; page++) {
          const result = await connection.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) }, 2000);
          if (!current()) return;
          if (!Array.isArray(result.data) || result.data.some(id => !activityId(id))) throw Error("Invalid activity list");
          for (const id of result.data) ids.add(id);
          if (result.nextCursor == null) break;
          if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw Error("Invalid activity cursor");
          cursor = result.nextCursor; cursors.add(cursor);
          if (page === 3) partial = report.hasMore = true;
        }
        if (!await alive(source)) { partial = true; return; }
        sources.push({ source, connection, ids }); observed = true;
      } catch { partial = true; }
    }));
    if (!current() || !sources.length) return;
    const fallback = sources.find(value => value.source.native) ?? sources[0]!;
    const candidates = new Map<string, Message>();
    // Live ownership is sampled before saved history, so old pages cannot
    // deterministically starve a known loaded executor.
    for (const source of sources) for (const id of source.ids) candidates.set(id, {});
    try {
      const saved = await fallback.connection.request("thread/list", { limit: 50, modelProviders: [] }, 2000);
      if (!current()) return;
      if (!Array.isArray(saved.data)) throw Error("Invalid saved activity list");
      for (const raw of saved.data) { const row = object(raw); if (activityId(row.id) && !candidates.has(row.id)) candidates.set(row.id, row); }
      if (saved.nextCursor != null) report.hasMore = true;
    } catch { partial = true; }
    if (!current()) return;
    for (const id of rows.keys()) if (!candidates.has(id)) candidates.set(id, {});
    if (candidates.size > maxThreads) partial = report.hasMore = true;
    const selected = [...candidates].slice(0, maxThreads); let index = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (current() && index < selected.length) {
        const [id] = selected[index++]!;
        if (!rows.has(id)) rows.set(id, { threadId: id, state: "unknown", source: "sdk", observedAt: checkedAt });
        const owners = sources.filter(value => value.ids.has(id));
        const target = owners[0] ?? fallback;
        try {
          if (owners.length > 1 || !await alive(target.source)) throw Error("Activity ownership unavailable");
          const metadata = await target.connection.request("thread/read", { threadId: id, includeTurns: false }, 2000);
          if (!current()) return;
          const thread = object(metadata.thread);
          if (thread.id !== id) throw Error("Activity identity mismatch");
          const page = await target.connection.request("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, 2000);
          if (!current()) return;
          if (!Array.isArray(page.data) || !await alive(target.source)) throw Error("Activity state unavailable");
          const after = object((await target.connection.request("thread/read", { threadId: id, includeTurns: false }, 2000)).thread);
          if (after.id !== id || !await alive(target.source)) throw Error("Activity state changed");
          const tail = object(page.data[0]), runtime = object(after.status).type;
          let turn: ActivityTurn | undefined;
          if (activityId(tail.id) && ["inProgress", "completed", "failed", "interrupted"].includes(String(tail.status))) {
            const message = object(tail.error).message;
            turn = { id: tail.id, status: tail.status as ActivityTurn["status"], completedAt: isoSeconds(tail.completedAt),
              ...(typeof message === "string" ? { errorClass: errorClass(message) } : {}) };
          }
          const changed = thread.updatedAt !== after.updatedAt;
          const flags = Array.isArray(object(after.status).activeFlags) ? object(after.status).activeFlags as unknown[] : [];
          const waitingFor = runtime === "active" && flags.includes("waitingOnApproval") ? "approval"
            : runtime === "active" && flags.includes("waitingOnUserInput") ? "input" : undefined;
          // Persisted inProgress history outlives a crashed owner. Only the
          // final live runtime observation establishes present liveness.
          const state = waitingFor ? "waiting" : runtime === "active" ? "running"
            : !changed && ["idle", "notLoaded", "systemError"].includes(String(runtime)) && turn && turn.status !== "inProgress" ? turn.status : "unknown";
          if (!current()) return;
          rows.set(id, { threadId: id, name: label(thread.name), model: label(thread.model), isSubagent: !!parentOf(threadFacts(thread) ?? {}),
            state, ...(waitingFor ? { waitingFor } : {}), source: "sdk", observedAt: new Date().toISOString(), ...(turn ? { turn } : {}) });
        } catch { partial = true; }
      }
    }));
  };
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    const deadline = new Promise<void>(done => { timer = setTimeout(() => { partial = true; closed = true; done(); }, options.timeoutMs ?? 5000); });
    const cancelled = new Promise<void>(done => { abort = () => { partial = true; closed = true; done(); }; options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort(); });
    await Promise.race([work().catch(() => { partial = true; }), deadline, cancelled]);
  } finally {
    closed = true; clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort);
    for (const connection of connections) connection.stop();
  }
  report.coverage = !observed ? "unavailable" : partial ? "partial" : "available";
  const rank = (row: ActivityRow) => row.state === "waiting" ? 2 : row.state === "running" ? 1 : 0;
  const allRows = [...rows.values()].sort((a, b) => rank(b) - rank(a) ||
    Date.parse(b.turn?.completedAt ?? b.observedAt) - Date.parse(a.turn?.completedAt ?? a.observedAt));
  report.hasMore ||= allRows.length > maxRows;
  report.rows = allRows.slice(0, maxRows);
  return report;
}

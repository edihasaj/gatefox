import type { Message } from "./app-server-connection.js";

const sourcePageLimit = 100;
const snapshotLimit = 512;
const gatewaySourceLimit = 4;

export interface RuntimeMetadataConnection {
  readonly closed: boolean;
  request(method: string, params: Message): Promise<Message>;
}

export interface RuntimeMetadataSource {
  connection: RuntimeMetadataConnection;
  /** Verifies the borrowed SDK remains this backend's live, private owner. */
  current(): boolean;
}

type Owner = RuntimeMetadataSource;
type Snapshot = { ids: string[]; owners: Map<string, Owner> };

function object(value: unknown): Message | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Message : undefined; }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function resultId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const row = object(value); const id = row?.id ?? row?.threadId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Read-only metadata facade over this adapter's native SDK and locally owned,
 * private gateway SDKs. It never starts, resumes, closes, or binds a chat.
 */
export class AdapterRuntimeMetadata {
  private snapshot?: Snapshot;
  private enumerationFlight?: Promise<Snapshot>;

  constructor(private readonly native: () => RuntimeMetadataSource | undefined, private readonly privateGateways: () => RuntimeMetadataSource[],
    private readonly now: () => number = Date.now) {}

  async request(method: string, params: Message): Promise<Message> {
    if (method === "thread/loaded/list") return this.loadedList(params);
    if (method === "thread/read") return this.read(params);
    throw new Error("Invalid runtime metadata request");
  }

  private async loadedList(params: Message): Promise<Message> {
    const requested = params.limit;
    if (requested !== undefined && (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1)) throw new Error("Invalid runtime metadata list limit");
    const limit = Math.min(sourcePageLimit, Math.floor(typeof requested === "number" ? requested : sourcePageLimit));
    const requestedCursor = params.cursor;
    let snapshot: Snapshot;
    let start = 0;
    if (requestedCursor === undefined || requestedCursor === null) {
      snapshot = await this.enumerate();
    } else {
      if (typeof requestedCursor !== "string" || !requestedCursor || !this.snapshot) throw new Error("Invalid runtime metadata list cursor");
      snapshot = this.snapshot;
      const previous = snapshot.ids.indexOf(requestedCursor);
      if (previous < 0) throw new Error("Invalid runtime metadata list cursor");
      start = previous + 1;
    }
    const data = snapshot.ids.slice(start, start + limit);
    return { data, nextCursor: start + data.length < snapshot.ids.length ? data.at(-1) : null };
  }

  private async read(params: Message): Promise<Message> {
    const id = params.threadId;
    if (!validId(id) || !this.snapshot) throw new Error("Unknown runtime metadata thread");
    const owner = this.snapshot.owners.get(id);
    if (!owner || !owner.current() || owner.connection.closed) throw new Error("Unknown runtime metadata thread");
    const result = await owner.connection.request("thread/read", { threadId: id, includeTurns: false });
    if (!owner.current() || owner.connection.closed) throw new Error("Unknown runtime metadata thread");
    return result;
  }

  private async enumerate(): Promise<Snapshot> {
    if (!this.enumerationFlight) {
      const flight = this.enumerateNow();
      this.enumerationFlight = flight;
      void flight.then(snapshot => { this.snapshot = snapshot; }, () => {}).finally(() => {
        if (this.enumerationFlight === flight) this.enumerationFlight = undefined;
      });
    }
    return this.enumerationFlight;
  }

  private async enumerateNow(): Promise<Snapshot> {
    const deadline = this.now() + 1000;
    const native = this.native(); const gateways = this.privateGateways();
    if (!native || !native.current() || native.connection.closed || gateways.length > gatewaySourceLimit || gateways.some(source => !source.current() || source.connection.closed)) {
      throw new Error("Runtime metadata owners are unavailable");
    }
    const owners = new Map<string, Owner>();
    for (const source of [native, ...gateways]) await this.addSource(source, owners, deadline);
    return { ids: [...owners.keys()].sort(), owners };
  }

  private async addSource(source: RuntimeMetadataSource, owners: Map<string, Owner>, deadline: number): Promise<void> {
    const cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < snapshotLimit; page++) {
      if (this.now() >= deadline) throw new Error("Runtime metadata enumeration timed out");
      if (!source.current() || source.connection.closed) throw new Error("Runtime metadata owner is unavailable");
      const result = await source.connection.request("thread/loaded/list", { limit: sourcePageLimit, ...(cursor ? { cursor } : {}) });
      if (this.now() >= deadline) throw new Error("Runtime metadata enumeration timed out");
      if (!source.current() || source.connection.closed) throw new Error("Runtime metadata owner is unavailable");
      const data = Array.isArray(result.data) ? result.data : undefined;
      if (!data || data.length > sourcePageLimit) throw new Error("Runtime metadata list is invalid");
      for (const row of data) {
        const id = resultId(row);
        if (!validId(id) || owners.has(id)) throw new Error("Runtime metadata list has duplicate or invalid thread");
        if (owners.size >= snapshotLimit) throw new Error("Runtime metadata snapshot exceeds 512 threads");
        owners.set(id, source);
      }
      const next = result.nextCursor;
      if (next === null || next === undefined) return;
      if (typeof next !== "string" || !next || cursors.has(next)) throw new Error("Runtime metadata list cursor is invalid");
      cursors.add(next); cursor = next;
    }
    throw new Error("Runtime metadata list did not complete");
  }
}

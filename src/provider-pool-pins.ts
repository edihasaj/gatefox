import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { writePrivateJson } from "./config.js";

/**
 * Which pool member holds each conversation's prompt cache. Losing this costs a cold prefill (minutes for a long chat), so
 * it survives a restart, and handler generations of one process share it through a process-wide map. Only hashes of the
 * conversation identifier and member IDs are stored. An unreadable file means no pins, never a failed request.
 */
interface Pin { member: string; at: number }
interface Shared { pins: Map<string, Pin>; cooling: Map<string, number>; timer?: NodeJS.Timeout; writes: Promise<void> }

const symbol = Symbol.for("harness-gateway.provider-pool.v1");
export const maximumPins = 4096;
export const pinLifetimeMs = 7 * 86_400_000;
const maximumFileBytes = 2 * 1024 * 1024;
const refreshPinMs = 3_600_000;
const hashPattern = /^[0-9a-f]{64}$/;
const memberPattern = /^[a-z][a-z0-9_-]*$/;

const pinPath = (stateDirectory: string, pool: string): string => join(resolve(stateDirectory), `provider-pool-${pool}.json`);
function load(path: string): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > maximumFileBytes) return pins;
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; pins?: unknown };
    if (value?.version !== 1 || !value.pins || typeof value.pins !== "object" || Array.isArray(value.pins)) return pins;
    for (const [key, entry] of Object.entries(value.pins)) {
      if (!hashPattern.test(key) || !Array.isArray(entry) || typeof entry[0] !== "string" || !memberPattern.test(entry[0]) || !Number.isSafeInteger(entry[1])) continue;
      pins.set(key, { member: entry[0], at: entry[1] as number });
    }
  } catch { /* No pins: the next request chooses again. */ }
  return pins;
}

export class ProviderPoolPins {
  private readonly shared: Shared;
  private readonly path: string;
  constructor(stateDirectory: string, private readonly pool: string, private readonly now: () => number = Date.now, private readonly saveAfterMs = 250) {
    this.path = pinPath(stateDirectory, pool);
    const holder = globalThis as unknown as Record<symbol, Map<string, Shared> | undefined>;
    const all = holder[symbol] ??= new Map();
    let shared = all.get(this.path);
    if (!shared) all.set(this.path, shared = { pins: load(this.path), cooling: new Map(), writes: Promise.resolve() });
    this.shared = shared;
  }
  key(identity: string): string { return createHash("sha256").update(JSON.stringify([this.pool, identity])).digest("hex"); }
  get(key: string): string | undefined {
    const pin = this.shared.pins.get(key);
    if (!pin) return;
    const now = this.now();
    if (now - pin.at > pinLifetimeMs) { this.shared.pins.delete(key); return; }
    // Most recently used last, so the bound below drops the conversation idle for longest.
    this.shared.pins.delete(key); this.shared.pins.set(key, pin);
    if (now - pin.at > refreshPinMs) { pin.at = now; this.save(); }
    return pin.member;
  }
  set(key: string, member: string): void {
    const same = this.shared.pins.get(key)?.member === member;
    this.shared.pins.delete(key); this.shared.pins.set(key, { member, at: this.now() });
    while (this.shared.pins.size > maximumPins) this.shared.pins.delete(this.shared.pins.keys().next().value!);
    if (!same) this.save();
  }
  /** A member that just refused a connection is not offered new conversations for a short while; pinned ones still try it first. */
  cool(member: string, untilMs: number): void { this.shared.cooling.set(member, untilMs); }
  warm(member: string): void { this.shared.cooling.delete(member); }
  cooling(member: string): boolean { return (this.shared.cooling.get(member) ?? 0) > this.now(); }
  /** Settles once every assignment made so far is on disk, or its write failed. */
  async flush(): Promise<void> { if (this.shared.timer) { clearTimeout(this.shared.timer); this.shared.timer = undefined; this.write(); } await this.shared.writes; }
  private save(): void {
    if (this.shared.timer) return;
    this.shared.timer = setTimeout(() => { this.shared.timer = undefined; this.write(); }, this.saveAfterMs); this.shared.timer.unref();
  }
  private write(): void {
    const shared = this.shared; const path = this.path;
    shared.writes = shared.writes.then(() => writePrivateJson(path, { version: 1, pins: Object.fromEntries([...shared.pins].map(([key, pin]) => [key, [pin.member, pin.at]])) })).catch(() => {});
  }
}
/** Tests drop the in-process copy to prove what a restart reads back. */
export function forgetProviderPoolPins(stateDirectory: string, pool: string): void {
  (globalThis as unknown as Record<symbol, Map<string, Shared> | undefined>)[symbol]?.delete(pinPath(stateDirectory, pool));
}

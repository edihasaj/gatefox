import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "../config.js";
import type { ObservedProviderUsage } from "../provider-usage.js";
import type { AvailabilityService, LoadReader } from "./service.js";

export const availabilityPath = "/v1/availability";
/** The longest a request may wait for a cold gateway's first collection round (`?wait=MS`). */
export const maximumWaitMs = 5000;

function waitMs(target: string | undefined): number | undefined {
  let raw: string | null;
  try { raw = new URL(target || "/", "http://127.0.0.1").searchParams.get("wait"); } catch { return; }
  if (raw === null) return 0;
  if (!/^[0-9]{1,5}$/.test(raw)) return;
  return Math.min(Number(raw), maximumWaitMs);
}

/** `GET /v1/availability[?wait=MS]`: this gateway's current availability facts. Reads the in-memory snapshot only. */
export async function serveAvailability(req: IncomingMessage, res: ServerResponse, service: AvailabilityService, config: GatewayConfig,
  load: LoadReader, usage: ObservedProviderUsage[], hidden: ReadonlySet<string>): Promise<void> {
  const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  const wait = waitMs(req.url);
  if (wait === undefined) { send(400, { error: { code: "invalid_request", message: "wait must be milliseconds from 0 through 5000" } }); return; }
  const warming = service.touch(config);
  if (wait > 0) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([warming, new Promise<void>(resolve => { timer = setTimeout(resolve, wait); timer.unref(); })]);
    clearTimeout(timer);
  }
  send(200, service.report(config, load, usage, hidden));
}

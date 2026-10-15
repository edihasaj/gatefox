/**
 * Decides whether the desktop's follow-up "default speed" write may be saved.
 *
 * The desktop applies a speed pick inside a chat with `thread/settings/update` and
 * then writes the same tier to `config/batchWrite service_tier`, which makes it the
 * default for every new chat. For gateway models the adapter never lets Fast become
 * a new-chat default, so it remembers the last pick just long enough to tell a
 * chat pick from a draft, Settings or banner pick. Pure: no I/O, no logging.
 */
export const tierPickWindowMs = 10_000;

export type TierPick = { source: "gateway-chat" | "native-chat"; fast: boolean; atMs: number };

export class ChatTierPicks {
  private last?: TierPick;
  record(source: TierPick["source"], tier: unknown, atMs = Date.now()): void {
    this.last = { source, fast: tier === "priority" || tier === "fast", atMs };
  }
  clear(): void { this.last = undefined; }
  /** Returns the pick if it is recent, and always consumes it. */
  take(atMs = Date.now()): TierPick | undefined {
    const pick = this.last; this.last = undefined;
    return pick && atMs - pick.atMs <= tierPickWindowMs ? pick : undefined;
  }
}

/** Only for Fast default writes; Standard writes always persist. */
export function fastDefaultDecision(pick: TierPick | undefined, defaultIsGateway: boolean): "reject" | "accept-unsaved" | "save" {
  if (pick?.fast && (pick.source === "gateway-chat" || defaultIsGateway)) return "reject";
  return defaultIsGateway ? "accept-unsaved" : "save";
}

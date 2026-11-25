/**
 * Whether a pool member still answers at all. A frozen machine accepts connections and never replies, so a request sees
 * neither a refusal nor an error; only its missing probes tell. Losing a member costs its conversations a cold prefill, so a
 * member counts as lost only after several probes in a row went unanswered while another member kept answering. An outage
 * of this Mac's own network fails every probe and therefore loses nobody.
 */
export class PoolReach {
  private readonly rows = new Map<string, { hits: number; misses: number }>();
  constructor(private readonly missesNeeded = 3, private readonly hitsNeeded = 2) {}
  hit(id: string): void { this.rows.set(id, { hits: (this.rows.get(id)?.hits ?? 0) + 1, misses: 0 }); }
  miss(id: string): void { this.rows.set(id, { hits: 0, misses: (this.rows.get(id)?.misses ?? 0) + 1 }); }
  forget(keep: ReadonlySet<string>): void { for (const id of this.rows.keys()) if (!keep.has(id)) this.rows.delete(id); }
  lost(id: string, members: readonly string[]): boolean {
    return (this.rows.get(id)?.misses ?? 0) >= this.missesNeeded && members.some(other => other !== id && (this.rows.get(other)?.hits ?? 0) >= this.hitsNeeded);
  }
}

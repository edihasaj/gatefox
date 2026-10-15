/** A set of ids that forgets the one added longest ago instead of growing past its limit. */
export class BoundedIdSet {
  private readonly ids = new Set<string>();
  constructor(private readonly limit: number) {}
  add(id: string): void {
    this.ids.delete(id); this.ids.add(id);
    while (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as string);
  }
  has(id: string): boolean { return this.ids.has(id); }
  delete(id: string): void { this.ids.delete(id); }
  get size(): number { return this.ids.size; }
}

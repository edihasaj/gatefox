import type { OpenAITool, ResponsesRequest } from "../protocol/types.js";
import { ledgerEntries, type LedgerEntry, type LedgerState } from "./claude-ledger.js";

/** Recover only an adopted session whose exact prefix used the former summary-to-assistant conversion. */
export function copilotContinuationLedger(session: { reasoningLedgerVersion?: number; ledger: LedgerState }, request: ResponsesRequest,
  catalog: OpenAITool[], leading: number, entries: LedgerEntry[]): LedgerState {
  const saved = session.ledger;
  if (session.reasoningLedgerVersion !== undefined || saved.partial !== undefined || !saved.items.length || !Array.isArray(request.input)
    || saved.items.every((digest, index) => entries[index]?.digest === digest)) return saved;
  // Summaries already present when the old request began were assistant text;
  // summaries emitted by that request were absent from its echo ledger. The
  // chronological boundary can be before or after the pending calls. Probe the
  // newest boundaries only, once per adopted session, with a fixed work bound.
  const boundaries = request.input.flatMap((item, index) => item.type === "reasoning" ? [index] : []).reverse().slice(0, 64);
  for (const through of [request.input.length, ...boundaries]) {
    const input = request.input.map((item, index) => item.type === "reasoning" && index < through
      ? { type: "message" as const, role: "assistant" as const, content: (item.summary ?? []).map(part => part.text).join("\n") } : item);
    const legacy = ledgerEntries({ ...request, input }, catalog, leading);
    if (!saved.items.every((digest, index) => legacy.entries[index]?.digest === digest)) continue;
    // Both projections retain rendered positions. The next entry bounds the
    // exact saved prefix, including skipped summaries inside an assistant run.
    const boundary = legacy.entries[saved.items.length]?.first ?? legacy.messages;
    return { items: entries.filter(entry => entry.first < boundary).map(entry => entry.digest) };
  }
  return saved;
}

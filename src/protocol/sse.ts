import type { WireEvent } from "./types.js";
import { ProviderError } from "../providers/provider.js";

// Malformed upstream frames are provider protocol failures, not gateway exceptions.
const invalidStream = (message: string) => new ProviderError("invalid_stream", message, 502);
const truncatedStream = () => new ProviderError("incomplete", "Provider stream ended with an incomplete frame", 502,
  { code: "truncated_frame", event: "eof" });

export async function* readEvents(body: AsyncIterable<Uint8Array>, format: "responses" | "chat" = "responses"): AsyncGenerator<WireEvent> {
  const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "";
  const parse = (frame: string): WireEvent | null => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return null;
    if (data === "[DONE]") return format === "chat" ? { type: "chat.done" } : null;
    let event: WireEvent;
    try { event = JSON.parse(data) as WireEvent; } catch { throw invalidStream("Provider stream event is not JSON"); }
    if (format === "chat") {
      if (!event || typeof event !== "object" || (!Array.isArray(event.choices) && !event.error)) throw invalidStream("Invalid chat stream event");
      return { ...event, type: event.error ? "error" : "chat.chunk" };
    }
    if (!event || typeof event.type !== "string") throw invalidStream("Invalid provider stream event");
    return event;
  };
  for await (const bytes of body) {
    try { buffer += decoder.decode(bytes, { stream: true }); }
    catch { throw invalidStream("Provider stream contains invalid UTF-8"); }
    if (buffer.length > 8 * 1024 * 1024) throw new ProviderError("output_too_large", "Provider stream frame exceeds 8 MiB", 502);
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index); buffer = buffer.slice(separator.index + separator[0].length);
      const event = parse(frame); if (event) yield event;
    }
  }
  try { buffer += decoder.decode(); } catch { throw truncatedStream(); }
  if (buffer.trim()) throw truncatedStream();
}

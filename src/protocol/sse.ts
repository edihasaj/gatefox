import type { WireEvent } from "./types.js";

export async function* readEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<WireEvent> {
  const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "";
  const parse = (frame: string): WireEvent | null => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return null;
    const event = JSON.parse(data) as WireEvent;
    if (!event || typeof event.type !== "string") throw new Error("Invalid provider stream event");
    return event;
  };
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    if (buffer.length > 8 * 1024 * 1024) throw new Error("Provider stream frame exceeds 8 MiB");
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index); buffer = buffer.slice(separator.index + separator[0].length);
      const event = parse(frame); if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new Error("Provider stream ended with an incomplete frame");
}

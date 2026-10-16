import type { Message } from "./app-server-connection.js";
import { inlineFields, record } from "./codex-feature-compat.js";

/** A TOML key path split into segments; bare segments split on dots, quoted ones stay whole. */
export interface KeyPath { segments: string[]; starts: number[]; ends: number[]; stop: number }

/**
 * Read a TOML dotted key from the start of `text`. With `toEquals` it must be followed by `=` (a `-c` override);
 * otherwise it must span the whole text (a config map key). Returns undefined for anything that is not a plain key.
 */
export function parseKey(text: string, toEquals: boolean): KeyPath | undefined {
  const path: KeyPath = { segments: [], starts: [], ends: [], stop: 0 };
  let index = 0;
  const space = () => { while (text[index] === " " || text[index] === "\t") index++; };
  for (;;) {
    space(); const start = index; const quote = text[index];
    if (quote === '"') {
      index++;
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      if (index >= text.length) return;
      index++;
      try { path.segments.push(JSON.parse(text.slice(start, index)) as string); } catch { return; }
    } else if (quote === "'") {
      const close = text.indexOf("'", index + 1); if (close < 0) return;
      index = close + 1; path.segments.push(text.slice(start + 1, close));
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(index)); if (!bare) return;
      index += bare[0].length; path.segments.push(bare[0]);
    }
    path.starts.push(start); path.ends.push(index); space();
    if (text[index] === ".") { index++; continue; }
    break;
  }
  path.stop = index;
  return (toEquals ? text[index] === "=" : index === text.length) ? path : undefined;
}

/** Text of a TOML value this module does not interpret; kept verbatim. */
export class Raw { constructor(readonly text: string) {} }
export const isTable = (value: unknown): value is Message => record(value) && !(value instanceof Raw);

/** Own-property assignment that also holds for a key such as `__proto__`. */
export function put(target: Message, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function setPath(target: Message, segments: string[], value: unknown): void {
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (isTable(next)) { current = next; continue; }
    const created: Message = {}; put(current, segment, created); current = created;
  }
  put(current, segments[segments.length - 1], value);
}

/** Inline TOML: booleans and inline tables are read (bare dotted keys expand to nested tables); the rest stays Raw. */
function readInline(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const fields = inlineFields(trimmed); if (!fields) return new Raw(trimmed);
  const result: Message = {};
  for (const field of fields) {
    const path = parseKey(field.rawKey, false); if (!path) return new Raw(trimmed);
    setPath(result, path.segments, readInline(field.value));
  }
  return result;
}

/** A `-c` value is JSON, else inline TOML. Anything unreadable is Raw, which a feature entry treats as invalid. */
export function readValue(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { /* Inline TOML is read below. */ }
  return readInline(raw);
}

export const keyText = (segment: string) => /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);

/** Render a value as TOML. The SDK parses every `-c` value as TOML, so tables are never written as JSON. */
export function writeInline(value: unknown): string {
  if (value instanceof Raw) return value.text;
  if (Array.isArray(value)) return `[${value.map(writeInline).join(", ")}]`;
  if (!isTable(value)) return JSON.stringify(value);
  const entries = Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined).map(([key, entry]) => `${keyText(key)} = ${writeInline(entry)}`);
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}

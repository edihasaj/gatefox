/**
 * The Codex app-server splits a configuration `keyPath` into segments before it applies an
 * edit (config_manager_service.rs `parse_key_path`). Segments are dot-separated; a segment may
 * open with `"` to carry separators literally, and inside quotes a `\` escapes the next
 * character. Bare segments stay permissive, so names like `sample@catalog` remain valid.
 *
 * The adapter guards keyPath rules on the parsed segments, never on the raw string, so a
 * quoted spelling of a refused key cannot slip past. A path the engine itself would reject is
 * the caller's error, and the adapter refuses it rather than guessing at a meaning.
 */

/** The segments of a keyPath the engine accepts, or undefined for one it rejects. */
// Rust's `str::trim` uses the Unicode White_Space property, which excludes the BOM (U+FEFF) that
// JavaScript's `trim()` removes; U+0085 is whitespace for both. Only an all-whitespace path is empty.
const whitespaceOnly = /^\p{White_Space}*$/u;

export const parseKeyPath = (path: unknown): string[] | undefined => {
  if (typeof path !== "string" || whitespaceOnly.test(path)) return undefined;
  const segments: string[] = [];
  let segment = "";
  let quoted = false;
  // Match Rust's `chars()`: iterate code points, not UTF-16 units.
  const chars = [...path];
  for (let index = 0; index < chars.length; index++) {
    const ch = chars[index]!;
    if (ch === '"' && segment === "" && !quoted) quoted = true;
    else if (ch === '"' && quoted) quoted = false;
    else if (ch === "\\" && quoted) {
      // Quoted segments may escape punctuation that would otherwise parse, such as `.` or `"`.
      const escaped = chars[++index];
      if (escaped === undefined) return undefined; // unterminated escape
      segment += escaped;
    }
    else if (ch === "." && !quoted) {
      if (segment === "") return undefined; // empty segment
      segments.push(segment); segment = "";
    }
    else if (ch === '"') return undefined; // a quote that can neither open nor close a segment
    else segment += ch;
  }
  if (quoted) return undefined; // unterminated quoted segment
  if (segment === "") return undefined; // empty last segment
  segments.push(segment);
  return segments;
};

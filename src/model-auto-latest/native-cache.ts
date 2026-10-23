import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { releasedAtMetadata } from "./metadata.js";
import type { CatalogRow } from "./types.js";

const maximumBytes = 16 * 1024 * 1024;
const maximumRows = 4096;
const slug = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * The visible public rows of the native Codex model cache. It is read-only and bounded: no native engine is started and
 * nothing here writes the cache, credentials or configuration. The file is opened without blocking (a FIFO is refused after
 * the type check) and read at most its stated size plus one byte. An unreadable, oversize, growing, malformed or
 * over-long (more than 4096 rows) file yields undefined, never a partial catalog.
 */
export async function readNativeCatalog(home?: string): Promise<CatalogRow[] | undefined> {
  const path = resolve(home ?? process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "models_cache.json");
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return undefined; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumBytes || (process.platform !== "win32" && info.uid !== process.getuid?.())) return undefined;
    const buffer = Buffer.alloc(info.size + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(buffer.subarray(0, length).toString("utf8")); } catch { return undefined; }
    const models = parsed && typeof parsed === "object" ? (parsed as { models?: unknown }).models : undefined;
    if (!Array.isArray(models) || models.length > maximumRows) return undefined;
    const rows = new Map<string, CatalogRow>();
    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const row = model as Record<string, unknown>;
      if (typeof row.slug !== "string" || !slug.test(row.slug) || row.visibility !== "list" || rows.has(row.slug)) continue;
      const dated = releasedAtMetadata(row);
      rows.set(row.slug, { id: row.slug, label: typeof row.display_name === "string" && row.display_name.length <= 256 ? row.display_name : row.slug, ...(dated.releasedAt !== undefined ? { metadata: dated } : {}) });
    }
    return [...rows.values()];
  } finally { await file.close(); }
}

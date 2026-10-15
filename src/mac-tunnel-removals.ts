import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * What this command remembers about the removals it made. An entry is valid only for the
 * exact service-plan file its removal left behind (content, inode and timestamps), so a
 * restored backup, a hand edit, a re-created plan or a plan from another consolidation
 * never makes an id look removed. A later removal by this command carries the entries
 * that were valid forward to the plan it writes.
 */
export interface Removal { id: string; backup: string; removedAt: string; plan: string }

export const removalsPath = (state: string) => resolve(state, "service-backups", "tunnel-removals.json");

/** A key that changes with the file's content and with any rewrite of it: another inode or other timestamps. */
export function planKey(text: string, info: { ino: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return [createHash("sha256").update(text).digest("hex"), info.ino, info.mtimeNs, info.ctimeNs].join(":");
}

/** The plan file's text and its key. */
export async function readPlanFile(path: string): Promise<{ text: string; key: string }> {
  const info = await stat(path, { bigint: true }); const text = await readFile(path, "utf8");
  return { text, key: planKey(text, info) };
}

/** Throws when the record exists but cannot be read; a missing record is empty. */
export async function readRemovals(state: string): Promise<Removal[]> {
  let text: string;
  try { text = await readFile(removalsPath(state), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  let value: { removals?: unknown }; try { value = JSON.parse(text); } catch { return []; }
  return Array.isArray(value?.removals) ? value.removals.filter((entry): entry is Removal => typeof entry?.id === "string" && typeof entry?.plan === "string") : [];
}

/** Removals still valid for the plan on disk. An unreadable record or plan is no record: the caller then refuses as unknown. */
export async function removalsForCurrentPlan(state: string, planPath: string): Promise<Removal[]> {
  try { const { key } = await readPlanFile(planPath); return (await readRemovals(state)).filter(entry => entry.plan === key); }
  catch { return []; }
}

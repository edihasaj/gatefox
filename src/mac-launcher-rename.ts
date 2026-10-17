import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isManagedLauncher, launcherName, legacyLauncherName } from "./command.js";

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const unxml = (value: string) => value.replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const firstProgram = /(<key>ProgramArguments<\/key>\s*<array>\s*<string>)([^<]*)(<\/string>)/;

/**
 * Names the managed harness-gateway launcher as the program of one managed LaunchAgent file, in place. macOS names a
 * background item after ProgramArguments[0], and an already-unified service still names `.../bin/gateway`. The file is
 * rewritten only when it carries the gateway's management marker, is a regular file (never a link), and its first argument
 * is a managed `gateway` launcher whose sibling `harness-gateway` is a managed launcher too; nothing else in it changes.
 * The write is atomic and keeps the label. Nothing is booted out or restarted: launchd reads the file at the next load.
 * Returns whether it rewrote the file.
 */
export async function renameLauncherInPlist(path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return false;
  if (!info.isFile()) return false;
  const text = await readFile(path, "utf8");
  if (!text.includes("<!-- Managed by subscription-gateway")) return false;
  const match = firstProgram.exec(text); if (!match) return false;
  const program = unxml(match[2]!);
  if (basename(program) !== legacyLauncherName || !isManagedLauncher(program)) return false;
  const replacement = resolve(dirname(program), launcherName);
  if (!isManagedLauncher(replacement)) return false;
  const next = text.replace(firstProgram, (_all, open: string, _old, close: string) => `${open}${xml(replacement)}${close}`);
  const temporary = `${path}.${process.pid}.rename`;
  // `wx`: a file or link planted at the temporary name is refused, never written through.
  try { await writeFile(temporary, next, { mode: info.mode & 0o777, flag: "wx" }); await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  return true;
}

/** The service plist and, where one exists, the standalone desktop login plist, each renamed independently. */
export async function renameLaunchers(service: string, desktop: string): Promise<{ programRewritten: boolean; desktopRewritten: boolean; failed?: true }> {
  const result = { programRewritten: false, desktopRewritten: false } as { programRewritten: boolean; desktopRewritten: boolean; failed?: true };
  // One file's failure never stops the other or the service from starting; the next install tries again.
  try { result.programRewritten = await renameLauncherInPlist(service); } catch { result.failed = true; }
  try { result.desktopRewritten = await renameLauncherInPlist(desktop); } catch { result.failed = true; }
  return result;
}

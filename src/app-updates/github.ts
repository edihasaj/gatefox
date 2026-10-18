import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { updateRepository, type Command, type CommandResult, type Release, type ReleaseAsset } from "./types.js";

const githubPaths = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
const outputLimit = 1024 * 1024;
const owner = process.getuid?.();
const macAdminGroup = 80;
const homebrewCellars = new Set(["/opt/homebrew/Cellar", "/usr/local/Cellar"]);

function trustedHomebrewCellar(path: string, info: Awaited<ReturnType<typeof lstat>>): boolean {
  return homebrewCellars.has(path) && info.isDirectory() && !info.isSymbolicLink() &&
    info.uid === owner && info.gid === macAdminGroup && process.getgroups?.().includes(macAdminGroup) === true &&
    (Number(info.mode) & 0o777) === 0o775;
}
async function protectedExecutable(path: string): Promise<boolean> {
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink() || (info.uid !== 0 && info.uid !== owner) ||
      !!(info.mode & 0o022) && !trustedHomebrewCellar(current, info) ||
      current !== path && !info.isDirectory() || current === path && !info.isFile()) return false;
  }
  return true;
}

function fixedGh(): Promise<string> {
  return (async () => {
    for (const path of githubPaths) {
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && !info.isSymbolicLink() && await protectedExecutable(path)) return path;
      // Homebrew's stable launcher is a link into its versioned Cellar. Accept
      // only that fixed prefix after resolving it; PATH is never consulted.
      if (info?.isSymbolicLink()) {
        const target = await realpath(path).catch(() => "");
        if (/^\/(?:opt\/homebrew|usr\/local)\/Cellar\/gh\/[^/]+\/bin\/gh$/.test(target)) {
          if (await protectedExecutable(target)) return target;
        }
      }
    }
    throw Object.assign(new Error("GitHub command unavailable"), { code: "auth_required" });
  })();
}

/** A fixed-path child runner. It drops child output as soon as it exceeds the small protocol limit. */
export const runCommand: Command = async (file, args, options = {}): Promise<CommandResult> => new Promise((resolveResult, reject) => {
  if (options.signal?.aborted) { reject(Object.assign(new Error("cancelled"), { code: "cancelled" })); return; }
  const grouped = process.platform !== "win32";
  const child = spawn(file, args, { detached: grouped, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GITHUB_PROMPT: "disabled", GH_HOST: "github.com" } });
  let done = false; let stopped = false; let size = 0; const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  const finish = (result: CommandResult) => { if (!done) { done = true; resolveResult(result); } };
  const signalGroup = (signal: NodeJS.Signals) => {
    try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* The owned group already exited. */ }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; signalGroup("SIGTERM");
    setTimeout(() => { if (child.exitCode === null) signalGroup("SIGKILL"); }, 250).unref();
  };
  const timeout = setTimeout(stop, options.timeoutMs ?? 30_000);
  const accept = (into: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length;
    if (size > (options.stdoutLimit ?? outputLimit)) { stop(); return; }
    into.push(chunk);
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", accept(stdout)); child.stderr.on("data", accept(stderr));
  child.once("error", error => { clearTimeout(timeout); options.signal?.removeEventListener("abort", stop); if (!done) reject(error); });
  child.once("close", code => {
    clearTimeout(timeout); options.signal?.removeEventListener("abort", stop);
    finish({ code: stopped ? 124 : code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
  });
});

function releases(value: unknown): Release[] {
  if (!Array.isArray(value)) throw new Error("invalid release list");
  return value.flatMap(row => {
    const release = row as Partial<Release>;
    if (typeof release.tag_name !== "string" || !Array.isArray(release.assets)) return [];
    const assets = release.assets.flatMap(asset => {
      const value = asset as Partial<ReleaseAsset>;
      return typeof value.id === "number" && Number.isInteger(value.id) && value.id > 0 &&
        typeof value.name === "string" && typeof value.size === "number" && Number.isInteger(value.size) && value.size >= 0
        ? [{ id: value.id, name: value.name, size: value.size }] : [];
    });
    return [{ tag_name: release.tag_name, draft: release.draft === true, prerelease: release.prerelease === true, assets }];
  });
}

export async function githubReleases(command: Command = runCommand): Promise<Release[]> {
  const gh = await fixedGh();
  const result = await command(gh, ["api", `repos/${updateRepository}/releases`, "--hostname", "github.com", "--method", "GET"], { timeoutMs: 30_000, stdoutLimit: outputLimit });
  if (result.code !== 0) {
    // This is a fixed private repository: GitHub intentionally returns 404 to
    // unauthenticated callers, so it has the same recovery as an expired token.
    if (/authentication|required|login|HTTP (?:401|403|404)/i.test(result.stderr)) throw Object.assign(new Error("GitHub authentication required"), { code: "auth_required" });
    throw new Error("GitHub release lookup failed");
  }
  try { return releases(JSON.parse(result.stdout)); } catch { throw new Error("GitHub release lookup failed"); }
}

/** Saves an asset without ever collecting its bytes in this process or exposing child output. */
export async function githubDownload(asset: ReleaseAsset, destination: string, command: Command = runCommand, signal?: AbortSignal): Promise<void> {
  if (!Number.isInteger(asset.id) || asset.id < 1) throw new Error("invalid asset");
  if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
  // Test seams use their command runner; production streams directly into a
  // private exclusive file because `gh api` has no output-file option.
  if (command !== runCommand) {
    const result = await command(await fixedGh(), ["api", `repos/${updateRepository}/releases/assets/${asset.id}`, "--hostname", "github.com", "-H", "Accept: application/octet-stream"],
      { timeoutMs: 120_000, stdoutLimit: 1_500 * 1024 * 1024, signal });
    if (result.code !== 0) throw new Error("GitHub asset download failed");
    return;
  }
  const gh = await fixedGh();
  const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const grouped = process.platform !== "win32";
    const child = spawn(gh, ["api", `repos/${updateRepository}/releases/assets/${asset.id}`, "--hostname", "github.com", "-H", "Accept: application/octet-stream"],
      { detached: grouped, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GITHUB_PROMPT: "disabled", GH_HOST: "github.com" } });
    let total = 0; let stopped = false;
    const signalGroup = (signal: NodeJS.Signals) => {
      try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* The owned group already exited. */ }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true; signalGroup("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) signalGroup("SIGKILL"); }, 250).unref();
    };
    const timer = setTimeout(stop, 120_000); signal?.addEventListener("abort", stop, { once: true });
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      done(total > 1_500 * 1024 * 1024 ? new Error("asset too large") : undefined, chunk);
    } });
    const streamed = pipeline(child.stdout, limiter, file.createWriteStream({ autoClose: true }));
    const exited = new Promise<void>((resolveResult, reject) => {
      child.once("error", reject); child.once("close", code => code === 0 && !stopped ? resolveResult() : reject(new Error("GitHub asset download failed")));
    });
    try { await Promise.all([streamed, exited]); } catch (error) { stop(); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
  } catch (error) { await unlink(destination).catch(() => undefined); throw error; }
  finally { await file.close().catch(() => undefined); }
}

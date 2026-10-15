import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { macDesktop } from "../mac-desktop.js";
import { prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";
import { FORCE, inDesktopHome, PATH_KEY, desktopFixture, type DesktopFixture as Fixture } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };
const fixture = () => desktopFixture("status-write-free");

/**
 * `gateway desktop status` is the one desktop command an operator runs while unsure, so it must be safe to run
 * at any time: two `launchctl getenv` reads, no write to the session, and no write to the receipt, the state
 * directory, or the LaunchAgents directory. Every shape below is seeded first, then answered once, and the
 * fixture's exec seam plus directory listings prove the answer cost nothing.
 */
type Receipt = "none" | "empty" | "current wrapper" | "older wrapper";
type Session = "own wrapper" | "stale own wrapper" | "foreign path" | "unset";

/** An older wrapper the shared rule accepts in this state directory but the current receipt no longer names. */
const olderWrapper = (f: Fixture) => join(f.state, "desktop-wrapper-89fafe006c5dc3e4");

/** Seeds one receipt shape over one session shape, and returns what the receipt names, if anything. */
async function seed(f: Fixture, receipt: Receipt, session: Session): Promise<string | undefined> {
  const { wrapper } = await prepareDesktop(f.config, f.app);
  // Both own paths are real, regular files owned by this user, the way a live or retired registration leaves them.
  await writeFile(olderWrapper(f), "#!/bin/sh\nexec /gone/older-codex \"$@\"\n"); await chmod(olderWrapper(f), 0o700);
  const named = receipt === "current wrapper" ? wrapper : receipt === "older wrapper" ? olderWrapper(f) : undefined;
  if (named !== undefined) await writePrivateJson(f.receipt, { wrapper: named, registeredAt: new Date().toISOString() });
  else if (receipt === "empty") await writePrivateJson(f.receipt, {});
  const cliPath = session === "own wrapper" ? wrapper
    : session === "stale own wrapper" ? olderWrapper(f)
      : session === "foreign path" ? join(f.root, "other", "desktop-wrapper-0123456789abcdef") : undefined;
  if (cliPath !== undefined) f.values.set(PATH_KEY, cliPath);
  f.values.set(FORCE, "1");
  return named;
}

const listing = async (directory: string) => (await readdir(directory)).sort();
const launchAgents = (f: Fixture) => join(f.home, "Library/LaunchAgents");
/** The receipt as it sits on disk, or nothing where it was never written or unregister cleared it. */
const bytes = async (path: string) => readFile(path).catch(error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
});

test("status answers every receipt and session shape with two getenvs and no write at all", mac, async () => {
  for (const receipt of ["none", "empty", "current wrapper", "older wrapper"] as const) {
    for (const session of ["own wrapper", "stale own wrapper", "foreign path", "unset"] as const) {
      const name = `receipt=${receipt} CODEX_CLI_PATH=${session}`;
      const f = await fixture();
      await inDesktopHome(f, async () => {
        const named = await seed(f, receipt, session);
        const [beforeReceipt, beforeState, beforeAgents] = [await bytes(f.receipt), await listing(f.state), await listing(launchAgents(f))];
        const status = await macDesktop("status", f.config, f.app, false, f.exec);

        assert.deepEqual(f.calls, [`getenv ${PATH_KEY}`, `getenv ${FORCE}`], name + ": the two reads, in that order, and nothing else");
        assert.deepStrictEqual(await bytes(f.receipt), beforeReceipt, name + ": the receipt bytes are untouched, absent still if it was absent");
        assert.deepEqual(await listing(f.state), beforeState, name + ": nothing appeared in or left the state directory");
        assert.deepEqual(await listing(launchAgents(f)), beforeAgents, name + ": status never writes a desktop LaunchAgent");

        assert.equal(status.registered, named !== undefined, name);
        assert.equal(status.activeForFutureLaunches, named !== undefined && f.values.get(PATH_KEY) === named, name);
        assert.equal(status.forceCliSet, true, name + ": the seeded 1 is reported, and the session still holds it");
        assert.equal(f.values.get(FORCE), "1", name + ": status never clears what register and unregister would");
        assert.equal(JSON.stringify(status).includes("desktop-wrapper"), false, name + ": no path reaches the output");
      });
    }
  }
});

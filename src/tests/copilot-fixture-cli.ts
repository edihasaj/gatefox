import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs the scripted one-shot CLI (copilot-fixture.ts) as `copilot` on PATH and points the temp folder at a private one, so
 * the folders the gateway makes for it, and the sweep that reads them, never reach the real temp folder. `restore` undoes both.
 */
export async function fixtureCli(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix)); const scratch = join(directory, "tmp"); await mkdir(scratch);
  // Preserve module resolution when the fixture is launched as an executable.
  const fixture = fileURLToPath(new URL("./copilot-fixture.js", import.meta.url));
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await writeFile(join(directory, "copilot"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`); await chmod(join(directory, "copilot"), 0o700);
  const names = ["PATH", "TMPDIR", "GATEWAY_COPILOT_FIXTURE_MODE", "GATEWAY_COPILOT_FIXTURE_RECEIPT"]; const previous = names.map(name => process.env[name]);
  process.env.PATH = directory + delimiter + process.env.PATH; process.env.TMPDIR = scratch; process.env.GATEWAY_COPILOT_FIXTURE_RECEIPT = join(directory, "receipt.json");
  return {
    directory, scratch, receipt: join(directory, "receipt.json"),
    mode: (value: string | undefined) => { if (value === undefined) delete process.env.GATEWAY_COPILOT_FIXTURE_MODE; else process.env.GATEWAY_COPILOT_FIXTURE_MODE = value; },
    restore: async () => {
      names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeErrorMessage } from "./error-message.js";
import { retainCliEntryPoint } from "./release-retention.js";

// Keep the immutable cli.js entrypoint visible to retention even when dispatch imports cli-main.js.
retainCliEntryPoint(import.meta.url);

/** Token helpers run inside a client's short authentication deadline, so they never load provider or service code. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "token" && !argv.some(arg => ["--help", "-h", "--version"].includes(arg))) {
    const { tokenCommand } = await import("./token-command.js");
    await tokenCommand(argv.slice(1));
    return;
  }
  const command = await import("./cli-main.js");
  await command.main(argv);
}

/** SyntaxError becomes a fixed string so JSON file contents never enter terminal diagnostics. */
export function cliFailureMessage(error: unknown): string {
  return safeErrorMessage(error, "Command failed");
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`gateway: ${cliFailureMessage(error)}\n`); process.exitCode = 2; });
}

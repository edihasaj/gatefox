import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gatewayToken, loadConfig, readClientToken } from "./config.js";
import { configPath } from "./paths.js";

/** Authentication's minimal CLI: configuration validation and private token checks, without provider startup imports. */
export async function tokenCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: { config: { type: "string" }, file: { type: "string" } } });
  if (positionals.length) throw new Error("Use gatefox token [--config PATH | --file PATH]");
  if (values.file && values.config) throw new Error("--file is only valid for token without --config");
  const token = values.file ? await readClientToken(resolve(values.file))
    : await gatewayToken((await loadConfig(await configPath(values.config))).stateDirectory);
  process.stdout.write(token + "\n");
}

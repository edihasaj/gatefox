import { parseArgs } from "node:util";
import { join } from "node:path";
import { loadConfig, readClientToken } from "./config.js";
import { configPath } from "./paths.js";
import { claudeRecoveryPath, type ClaudeHold } from "./claude-session-recovery.js";

export async function claudeSessionsCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    config: { type: "string" }, json: { type: "boolean" }, apply: { type: "boolean" }, "thread-key": { type: "string" },
    "legacy-catalog": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { process.stdout.write("gatefox claude-sessions [status|recover] [--thread-key KEY --apply] [--legacy-catalog] [--config PATH] [--json]\nRecovery starts no inference. Only a later caller request can continue the saved chat.\n"); return; }
  const action = positionals[0] ?? "status";
  if (positionals.length > 1 || !["status", "recover"].includes(action) || values.apply && action !== "recover") throw new Error("Use gatefox claude-sessions status|recover --help");
  if (action === "recover" && !/^[a-f0-9]{8}$/.test(values["thread-key"] ?? "")) throw new Error("Recovery requires one exact --thread-key from status");
  const config = await loadConfig(await configPath(values.config));
  const token = await readClientToken(join(config.stateDirectory, "client-token"));
  const url = `http://127.0.0.1:${config.port}${claudeRecoveryPath}`;
  const request = async (body?: unknown) => {
    const result = await fetch(url, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!result.ok) throw new Error(`Session recovery returned HTTP ${result.status}; refresh status`);
    return result.json();
  };
  const status = await request() as { holds: ClaudeHold[] };
  if (action === "status") { process.stdout.write(JSON.stringify(status, null, 2) + "\n"); return; }
  const matches = status.holds.filter(hold => hold.threadKey === values["thread-key"]);
  if (matches.length !== 1 || matches[0].active || matches[0].reason !== "crashed") throw new Error("Select exactly one stopped crash hold from status");
  const recovery = { threadKey: matches[0].threadKey, revision: matches[0].revision, since: matches[0].since, toolNameMode: values["legacy-catalog"] ? "legacy" : "readable" };
  process.stdout.write(JSON.stringify(values.apply ? await request(recovery) : { apply: false, ...recovery, inferenceStarted: false }, null, 2) + "\n");
}

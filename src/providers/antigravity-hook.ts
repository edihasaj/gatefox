import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The `PreToolUse` hook of every Antigravity session home. Antigravity CLI 1.5.14 asks the gateway before file and shell
 * actions, but `search_web` and `invoke_subagent` run without asking, so the permission answer alone cannot keep native
 * tools off. The CLI runs this hook before every tool call and a denied call never starts. A hook that crashes or cannot
 * be started also blocks the call (observed with 1.5.14), so a broken hook stops the caller's tools too.
 *
 * `allow` only passes the call on to the CLI's normal permission request, which the gateway then judges against the
 * session's catalog (antigravity-acp.ts). The script stands alone because it must outlive a gateway update.
 */
const script = `import { readFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";
let decision = "deny";
try {
  const { name, args } = JSON.parse(readFileSync(0, "utf8")).toolCall;
  if (/^mcp_gateway_[A-Za-z0-9_.-]+$/.test(name)) decision = "allow";
  if (name === "read_file" || name === "view_file") {
    const path = args.Path ?? args.AbsolutePath;
    if (realpathSync(path).startsWith(realpathSync(process.argv[2]) + sep)) decision = "allow";
  }
} catch {}
process.stdout.write(JSON.stringify({ decision, reason: "Only the caller's tools on the gateway MCP server are available." }));
`;

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Writes the hook into a session's configuration folder. `schemas` is where the CLI caches the gateway's tool schemas. */
export async function writeAntigravityHook(configDirectory: string, schemas: string): Promise<void> {
  const file = join(configDirectory, "gateway-hook.mjs");
  await writeFile(file, script, { mode: 0o600, flag: "wx" });
  const command = [process.execPath, file, schemas].map(quote).join(" ");
  const hooks = { gateway: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 10 }] }] } };
  await writeFile(join(configDirectory, "hooks.json"), `${JSON.stringify(hooks)}\n`, { mode: 0o600, flag: "wx" });
}

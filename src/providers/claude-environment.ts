/**
 * Keep the native CLI on its subscription login, even when API exports exist. Host Claude Code
 * session variables (a gateway started from a Claude Code shell) are dropped too: they make a live
 * CLI act between requests, a desktop entrypoint adds a post-turn summary request to every turn, and
 * CLAUDE_CODE_EFFORT_LEVEL would replace the per-model default effort that discovery reads.
 */
export function claudeEnvironment(authDirectory?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_") || name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_") || name.startsWith("CLAUDE_AGENT_SDK_")) delete env[name];
  }
  // Gateway-managed installations are promoted only after their compatibility
  // gate passes. Do not let a CLI replace that verified tree mid-session.
  env.DISABLE_AUTOUPDATER = "1";
  if (authDirectory) env.CLAUDE_CONFIG_DIR = authDirectory;
  return env;
}

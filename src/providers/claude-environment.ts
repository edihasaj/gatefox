/** Keep the native CLI on its subscription login, even when API exports exist. */
export function claudeEnvironment(authDirectory?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_") || ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].includes(name)) delete env[name];
  }
  if (authDirectory) env.CLAUDE_CONFIG_DIR = authDirectory;
  return env;
}

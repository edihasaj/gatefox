import { randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { ProviderError } from "./provider.js";

/**
 * The gateway's private Gemini home. The Gemini CLI selects it with `GEMINI_CLI_HOME` and keeps its own files under
 * `<home>/.gemini/`: the credential at `oauth_creds.json` and the settings at `settings.json`. Nothing here is ever
 * read from a personal `~/.gemini`, and no API key reaches the CLI: `geminiEnv` removes every Google and Vertex
 * credential variable before the CLI starts.
 */
async function executable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return true; } catch { return false; } }

/**
 * PATH first, then the locations a Node installer or Homebrew puts the CLI in, which a launchd PATH usually lacks:
 * the gateway service runs without the npm-global bin on its PATH.
 */
export async function geminiCommand(): Promise<string> {
  for (const directory of (process.env.PATH || "").split(delimiter)) if (directory && await executable(join(directory, "gemini"))) return join(directory, "gemini");
  const home = homedir();
  for (const fallback of [join(home, ".local/share/node/current/bin/gemini"), "/opt/homebrew/bin/gemini", join(home, ".local/bin/gemini")]) {
    if (await executable(fallback)) return fallback;
  }
  throw new ProviderError("cli_failed", "The Gemini CLI is not installed; install Gemini CLI and sign in for the gateway", 502);
}

/** The CLI's own folder inside the gateway's home, where it keeps the credential and its settings. */
export const geminiCliDir = (home: string): string => join(home, ".gemini");
/** The credential file the CLI writes on a successful Google sign-in. */
export const geminiCredentialFile = (home: string): string => join(geminiCliDir(home), "oauth_creds.json");
/** The settings file the gateway owns. */
export const geminiSettingsFile = (home: string): string => join(geminiCliDir(home), "settings.json");
/** The folder the CLI loads its own policy files from, which is where the gateway's policy lives. */
export const geminiPoliciesDir = (home: string): string => join(geminiCliDir(home), "policies");
/** The gateway's policy file, written into that folder. */
export const geminiPolicyFile = (home: string): string => join(geminiPoliciesDir(home), "gateway.toml");
/**
 * The two system-scope settings paths, each pointed at a name the gateway never creates.
 *
 * The CLI ranks system settings above the home's own `settings.json` and system defaults above those, so the
 * machine-wide `/Library/Application Support/GeminiCli` scope would outrank anything the gateway writes. Each variable
 * replaces its path outright rather than adding to it, so naming a file that does not exist closes that scope entirely:
 * the CLI loads a system document only when the file is there, and it refuses one that is not root-owned, which a file
 * inside this private home can never be. What is left is `<home>/.gemini/settings.json` — the user scope, which the
 * gateway rewrites before every spawn — as the only settings document the CLI acts on.
 */
export const geminiSystemSettingsFile = (home: string): string => join(geminiCliDir(home), "gateway-system-settings.disabled");
export const geminiSystemDefaultsFile = (home: string): string => join(geminiCliDir(home), "gateway-system-defaults.disabled");
/** The system settings document an earlier build of this provider wrote, which must not survive as a system file. */
const legacySystemSettingsFile = (home: string): string => join(geminiCliDir(home), "gateway-managed-settings.json");

/** The pinned backstop model; a session always names its own with `-m`, so `auto` never routes the caller's turn. */
export const geminiDefaultModel = "gemini-3.1-pro-preview";

/**
 * Every built-in the CLI offers. Its bundled default policies allow several of these (`read_file`, `grep_search`,
 * `glob`, `list_directory`, `google_web_search`, `codebase_investigator`, `cli_help`, `get_internal_docs`, the tracker
 * tools, and `invoke_agent`) *without* a permission request, so they are each named in `tools.exclude`; a wildcard is
 * not usable because it would also deny the caller tools of the gateway MCP server.
 */
export const geminiBuiltInTools = [
  "read_file", "write_file", "replace", "read_many_files", "glob", "grep_search", "list_directory", "shell", "run_shell_command",
  "google_web_search", "web_fetch", "codebase_investigator", "cli_help", "get_internal_docs", "write_todos",
  "invoke_agent", "ask_user", "update_topic", "activate_skill", "enter_plan_mode", "exit_plan_mode",
  "list_mcp_resources", "read_mcp_resource", "tracker_create_task", "tracker_get_task", "tracker_update_task",
  "tracker_list_tasks", "tracker_add_dependency", "tracker_visualize_tasks", "tracker_visualize", "complete_task", "list_background_processes", "read_background_output",
] as const;

/**
 * The managed settings.json, written by the gateway and the only settings the CLI reads: it keeps the CLI an inference
 * backend with no MCP servers of its own (the gateway passes exactly one per session), no telemetry, and no personal
 * model choice that could silently replace the caller's.
 */
export function geminiManagedSettings(): Record<string, unknown> {
  return {
    // The gateway hands the CLI exactly one MCP server per session in `session/new`; a settings entry would add tools
    // the caller never declared, and the client — not the provider — executes tools.
    mcpServers: {},
    // Auth is the Google sign-in in the gateway's home, pinned so an ambient credential or an ADC shortcut cannot answer
    // for the subscription, and always-allow / YOLO are closed so nothing runs without asking the gateway.
    security: { auth: { selectedType: "oauth-personal", enforcedType: "oauth-personal", useExternal: false },
      disableYoloMode: true, disableAlwaysAllow: true, enablePermanentToolApproval: false, autoAddToPolicyByDefault: false,
      toolSandboxing: false, enableConseca: false, folderTrust: { enabled: true }, environmentVariableRedaction: { enabled: false } },
    privacy: { usageStatisticsEnabled: false },
    // `target` is left out on purpose: the schema names real backends only (`local`, `gcp`), so `"none"` is refused as
    // invalid configuration. `enabled: false` is what keeps telemetry off.
    telemetry: { enabled: false, logPrompts: false },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false, enableNotifications: false,
      checkpointing: { enabled: false }, plan: { enabled: false }, topicUpdateNarration: false, devtools: false,
      // Turns are not retained: the gateway holds the conversation, and the CLI's own chat files would copy prompts to disk.
      sessionRetention: { enabled: false } },
    // `exclude` is what actually keeps a built-in out of the session: the CLI drops an excluded tool from its registry
    // (so the model is never offered it) as well as denying it. The policy file repeats these names because it is also
    // the only thing that outranks the CLI's bundled default policies, which *allow* several of them with no permission
    // request at all, and it denies `*` besides, so a built-in this list has not caught yet is denied too.
    tools: { exclude: [...geminiBuiltInTools], allowed: [], useRipgrep: false },
    // `mcp.allowed` is left out on purpose: the CLI turns every entry into an ALLOW rule for `mcp_<server>_*`, which
    // would run the gateway's tools with no `session/request_permission` at all. `mcp.serverCommand` is left out too —
    // it lets the CLI spawn a server process of its own — and `excluded` is empty because no server is excluded: the
    // session's one server is named by the gateway itself.
    mcp: { excluded: [] },
    context: { includeDirectories: [], loadMemoryFromIncludeDirectories: false, discoveryMaxDirs: 0, includeDirectoryTree: false,
      fileFiltering: { enableFileWatcher: false } },
    experimental: { enableAgents: false, autoMemory: false, taskTracker: false, contextManagement: false, topicUpdateNarration: false,
      directWebFetch: false, gemma: false, voiceMode: false, worktrees: false, extensionManagement: false, extensionRegistry: false,
      extensionReloading: false, modelSteering: false, gemmaModelRouter: { enabled: false, autoStartServer: false },
      adk: { agentSessionInteractiveEnabled: false, agentSessionSubagentEnabled: false } },
    extensions: { disabled: [] },
    skills: { enabled: false, disabled: [] },
    hooksConfig: { enabled: false },
    hooks: { BeforeTool: [], AfterTool: [], BeforeAgent: [], AfterAgent: [], SessionStart: [], SessionEnd: [], Notification: [],
      PreCompress: [], BeforeModel: [], AfterModel: [], BeforeToolSelection: [] },
    ide: { enabled: false },
    advanced: { autoConfigureMemory: false, ignoreLocalEnv: true },
    model: { name: geminiDefaultModel, maxSessionTurns: -1 },
    billing: { overageStrategy: "never" },
    admin: { secureModeEnabled: true, mcp: { enabled: true }, extensions: { enabled: false }, skills: { enabled: false } },
  };
}

/** Why a denied tool was denied; the CLI hands this back to the model instead of running anything. */
const policyDenyMessage = "The gateway's Gemini session runs no tools of its own; the client runs the caller's tools.";

/**
 * The gateway's policy file, in the TOML the CLI loads from `<home>/.gemini/policies` at its user tier.
 *
 * This is what closes the CLI's bundled default policies, which ALLOW several built-ins (`read_file`, `grep_search`,
 * `glob`, `list_directory`, `google_web_search`, `codebase_investigator`, the tracker tools and, in `agents.toml`,
 * `invoke_agent`) *with no permission request at all*. A rule's rank is its tier — user is 4, above workspace,
 * extension and default — plus `priority`/1000, so every rule here outranks those bundled allows and the rules the
 * CLI derives from settings, whose highest is `tools.exclude` at 4.4.
 *
 * `mcp_gateway_*` is answered first and on its own, because a deny-all rule would otherwise swallow the caller's tools
 * as well: the CLI names a tool of the session's one MCP server `mcp_gateway_<tool>`, and the pattern that matches
 * exactly those is told to ask the user — which, over ACP, means asking the gateway. Everything else is denied, named
 * built-ins first and any other tool by `*`, so a built-in this list has not caught is denied too. Nothing here ever
 * answers `allow`: the gateway's permission reply is the only thing that lets a tool run.
 */
export function geminiManagedPolicy(): string {
  const rule = (toolName: string | string[], decision: "ask_user" | "deny", priority: number, note?: string): string =>
    `[[rule]]\ntoolName = ${JSON.stringify(toolName)}\ndecision = ${JSON.stringify(decision)}\npriority = ${priority}\n` +
    (note ? `denyMessage = ${JSON.stringify(note)}\n` : "");
  const header = ["# Written by the gateway, which rewrites this file before every Gemini session; edit nothing here.",
    "# The caller's tools arrive as mcp_gateway_<tool> from the session's one MCP server and are run by the client, so",
    "# no CLI-native tool may run and every caller tool call must go through the gateway's permission answer."].join("\n");
  return [header, rule("mcp_gateway_*", "ask_user", 999).trimEnd(), rule([...geminiBuiltInTools], "deny", 900, policyDenyMessage).trimEnd(),
    rule("*", "deny", 800, policyDenyMessage).trimEnd()].join("\n\n") + "\n";
}

/** The top-level settings keys the gateway owns; anything else the CLI wrote itself is kept. */
const managedKeys = Object.keys(geminiManagedSettings());

/** Keeps every setting the CLI wrote itself and replaces the managed ones. Unparsable existing JSON starts from the managed document. */
export function mergeGeminiSettings(existing: string): string {
  let kept: Record<string, unknown> = {};
  if (existing.trim()) {
    try {
      const decoded: unknown = JSON.parse(existing);
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) kept = Object.fromEntries(Object.entries(decoded as Record<string, unknown>).filter(([key]) => !managedKeys.includes(key)));
    } catch { /* A file the gateway cannot read is rewritten whole rather than merged. */ }
  }
  return `${JSON.stringify({ ...kept, ...geminiManagedSettings() }, null, 2)}\n`;
}

/**
 * Whether the gateway's private home holds a usable Google sign-in. The file must parse and carry both tokens: the CLI
 * writes other shapes (an empty or partial file, or an imported keychain record) that would otherwise be spawned against
 * and only fail once a session had already started. Presence alone is not a sign-in.
 */
export async function hasGeminiLogin(home: string | undefined): Promise<boolean> {
  if (!home) return false;
  let decoded: unknown;
  try { decoded = JSON.parse(await readFile(geminiCredentialFile(home), "utf8")); } catch { return false; }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return false;
  const creds = decoded as Record<string, unknown>;
  return typeof creds.access_token === "string" && creds.access_token.length > 0
    && typeof creds.refresh_token === "string" && creds.refresh_token.length > 0;
}

/**
 * The CLI loads `<home>/.env` and `<home>/.gemini/.env` as environment before it reads any setting, and an auth variable
 * in either (an API key) would win over the subscription. The gateway never writes one, and it refuses to start the CLI
 * while one exists rather than deleting a file it did not create.
 */
export async function assertNoGeminiEnvFiles(home: string): Promise<void> {
  for (const path of [join(home, ".env"), join(geminiCliDir(home), ".env")]) {
    const present = await lstat(path).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; });
    if (present) throw new ProviderError("invalid_request", "The gateway's Gemini home must not contain a .env file; remove it so the CLI cannot load environment from it", 400);
  }
}

/**
 * Creates or repairs the private home, keeps it 0700 and owned by this user, and writes settings.json atomically and
 * only when it changed. `requireLogin: false` prepares a home for `gemini login` itself, which runs before the
 * credential exists.
 */
export async function ensureGeminiHome(home: string, options: { requireLogin?: boolean } = {}): Promise<void> {
  // An existing non-directory is left for the checks below to refuse rather than failing here with EEXIST.
  await mkdir(home, { recursive: true, mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new ProviderError("invalid_request", "The gateway's Gemini home must be a private directory owned by this user", 400);
  }
  if (info.mode & 0o077) await chmod(home, 0o700);
  await assertNoGeminiEnvFiles(home);
  const directory = geminiCliDir(home);
  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const dirInfo = await lstat(directory);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || (process.getuid && dirInfo.uid !== process.getuid())) {
    throw new ProviderError("invalid_request", "The gateway's Gemini CLI folder must be a private directory owned by this user", 400);
  }
  if (dirInfo.mode & 0o077) await chmod(directory, 0o700);
  // The managed document is the home's own settings, merged with anything the CLI wrote for itself. Nothing is written
  // at a system-scope path: both are pinned to names that must not exist (see geminiSystemSettingsFile), so the
  // machine-wide scope cannot outrank this file and the CLI has no system document to refuse.
  await writeManaged(geminiSettingsFile(home), directory, mergeGeminiSettings(await readFile(geminiSettingsFile(home), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error;
  })));
  const policies = geminiPoliciesDir(home);
  await mkdir(policies, { recursive: true, mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const policyInfo = await lstat(policies);
  if (!policyInfo.isDirectory() || policyInfo.isSymbolicLink() || (process.getuid && policyInfo.uid !== process.getuid())) {
    throw new ProviderError("invalid_request", "The gateway's Gemini policy folder must be a private directory owned by this user", 400);
  }
  if (policyInfo.mode & 0o077) await chmod(policies, 0o700);
  await writeManaged(geminiPolicyFile(home), policies, geminiManagedPolicy());
  for (const path of [geminiSystemSettingsFile(home), geminiSystemDefaultsFile(home), legacySystemSettingsFile(home)]) {
    await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
  if (options.requireLogin === false) return;
  if (!await hasGeminiLogin(home)) {
    throw new ProviderError("authentication", "Gemini is not signed in for the gateway. Run `gateway login gemini`, or the Gemini CLI's Google sign-in with GEMINI_CLI_HOME set to the gateway's Gemini home.", 401,
      { code: "authentication_failed", event: "gemini.result" });
  }
}

/** Writes `text` at `path` atomically with mode 0600, and only when the file does not already hold it. */
export async function writeGeminiPrivateFile(path: string, text: string): Promise<void> { await writeManaged(path, dirname(path), text); }
async function writeManaged(path: string, directory: string, text: string): Promise<void> {
  if (await readFile(path, "utf8").catch(() => undefined) === text) return;
  const temporary = join(directory, `${path.slice(path.lastIndexOf("/") + 1)}.${randomBytes(6).toString("hex")}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/**
 * The environment the CLI runs with. Every Google, Vertex and Gemini variable of the caller is removed first so an
 * API key is never used, and then only what the gateway needs is set: the private home, and the off switches that keep
 * the CLI from updating or reporting on its own.
 *
 * `shimDir` is a folder holding stand-ins for the browser opener (see gemini-browser-shim.ts), put first on PATH. The CLI
 * opens its sign-in page by running `open` (`xdg-open` on Linux) by name, so a process that must never open a browser
 * gets a stand-in that only records the attempt. For the same reason the variables that make the CLI skip the browser
 * (`CI`, `SSH_CONNECTION`, ...) are removed: it would then print a code prompt on stdout and read the answer from stdin,
 * which for an ACP session is the protocol stream.
 */
export function geminiEnv(home: string, options: { shimDir?: string } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GEMINI_") || name.startsWith("GOOGLE_") || name.startsWith("VERTEX") || name.startsWith("OTEL_")
      || ambient.has(name)) delete env[name];
  }
  if (options.shimDir) {
    env.PATH = env.PATH ? `${options.shimDir}${delimiter}${env.PATH}` : options.shimDir;
    // On Linux the CLI only tries a browser when a display is configured; the stand-in opener makes any value harmless.
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.MIR_SOCKET) env.DISPLAY = ":0";
  }
  // An ambient `GEMINI_API_KEY` otherwise wins silently and bills the API instead of the subscription; ADC, a base URL
  // override, an auth-type override and a forced model do the same. `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` and
  // `NO_BROWSER` are deliberately left absent (see the note above): the first moves the credential out of the home into
  // the macOS keychain, the second makes a signed-out CLI print an interactive code prompt into the protocol stream.
  return { ...env, GEMINI_CLI_HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: geminiSystemSettingsFile(home),
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: geminiSystemDefaultsFile(home),
    GEMINI_FORCE_FILE_STORAGE: "true", GEMINI_CLI_NO_RELAUNCH: "true" };
}

/**
 * Variables outside the `GEMINI_`/`GOOGLE_`/`VERTEX`/`OTEL_` families that still change what the CLI is: an ADC or
 * cloud-shell boot that rewrites the sign-in type, a sandbox that moves the CLI's runtime directory, test modes that
 * turn folder trust off, telemetry defaults, and the browser suppression that is unsafe inside a session process.
 */
const ambient = new Set(["CLOUD_SHELL", "SANDBOX", "VITEST", "NO_BROWSER", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
  // The CLI skips the browser (and reads a code from stdin instead) when any of these is set: `shouldAttemptBrowserLaunch`.
  "CI", "DEBIAN_FRONTEND", "BROWSER", "SSH_CONNECTION"]);

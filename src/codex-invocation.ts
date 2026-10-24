/**
 * The small part of Codex CLI syntax that matters before the gateway is allowed to
 * touch its own configuration. Keep this intentionally conservative: an unknown
 * app-server option is a session option, not a reason to launch a native command.
 */
const leadingValueOptions = [
  "-c", "--config", "--enable", "--disable", "-p", "--profile", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "-i", "--image", "--remote", "--remote-auth-token-env", "--local-provider", "--linux-sandbox-pid-namespace",
];

// These are the value-taking app-server options in engine 0.164. Keep startup
// options exact: values must never be mistaken for a diagnostic or tooling command.
const appServerValueOptions = [
  "-c", "--config", "--enable", "--disable", "--code-mode-host", "--listen", "--ws-auth", "--ws-token-file", "--ws-token-sha256", "--ws-shared-secret-file", "--ws-issuer", "--ws-audience", "--ws-max-clock-skew-seconds",
  "--startup-client-info", "--cloud-skills-snapshot",
];

const appServerBooleanOptions = new Set(["--startup-sign-out", "--strict-config", "--stdio", "--remote-control", "--managed-daemon", "--analytics-default-enabled"]);

const leadingValues = new Set(leadingValueOptions);
const appServerValues = new Set(appServerValueOptions);

const isAssigned = (argument: string, options: string[]) => options.some(option => argument.startsWith(option + "="));

/** Returns the top-level app-server position, never an option value or text after `--`. */
export function appServerIndex(args: string[]): number {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") return -1;
    if (leadingValues.has(argument)) { index++; continue; }
    if (["-h", "--help", "-V", "--version"].includes(argument)) return -1;
    if (isAssigned(argument, leadingValueOptions) || argument.startsWith("-")) continue;
    return argument === "app-server" ? index : -1;
  }
  return -1;
}

/**
 * Whether this invocation is a long-lived stdio/private-Unix session that the
 * adapter owns. Explicit help/version, the reserved diagnostic `--print-*`
 * family, and unconsumed app-server subcommands stay on the original CLI.
 */
export function isAppServerSession(args: string[]): boolean {
  const appIndex = appServerIndex(args);
  if (appIndex < 0) return false;
  let unknownOption = false;
  for (let index = appIndex + 1; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") return true;
    if (appServerValues.has(argument)) { index++; continue; }
    if (isAssigned(argument, appServerValueOptions)) continue;
    if (unknownOption) return true;
    if (argument === "-h" || argument === "--help" || argument === "-V" || argument === "--version" || (argument.startsWith("--print-") && argument.length > "--print-".length)) return false;
    if (appServerBooleanOptions.has(argument)) continue;
    if (argument.startsWith("-")) { unknownOption = true; continue; }
    return false;
  }
  return true;
}

/**
 * POSIX-shell equivalent of isAppServerSession. The generated desktop wrapper
 * must make the same decision before it invokes the shim, so a one-shot never
 * even has a chance to load gateway state.
 */
export function appServerSessionShellGuard(): string {
  const leading = leadingValueOptions.join("|");
  const leadingAssigned = leadingValueOptions.map(option => option + "=*").join("|");
  const appValues = appServerValueOptions.join("|");
  const appAssigned = appServerValueOptions.map(option => option + "=*").join("|");
  const appBooleans = [...appServerBooleanOptions].join("|");
  return `gateway_app_server_session() {
  gateway_seen_app_server=0
  gateway_skip_value=0
  gateway_unknown_option=0
  for gateway_argument do
    if [ "$gateway_seen_app_server" = 0 ]; then
      if [ "$gateway_skip_value" = 1 ]; then gateway_skip_value=0; continue; fi
      case "$gateway_argument" in
        --) return 1 ;;
        ${leading}) gateway_skip_value=1 ;;
        -h|--help|-V|--version) return 1 ;;
        ${leadingAssigned}|-*) ;;
        app-server) gateway_seen_app_server=1 ;;
        *) return 1 ;;
      esac
      continue
    fi
    if [ "$gateway_skip_value" = 1 ]; then gateway_skip_value=0; continue; fi
    if [ "$gateway_unknown_option" = 1 ]; then return 0; fi
    case "$gateway_argument" in
      --) return 0 ;;
      ${appValues}) gateway_skip_value=1 ;;
      ${appAssigned}) ;;
      -h|--help|-V|--version|--print-?*) return 1 ;;
      ${appBooleans}) ;;
      -*) gateway_unknown_option=1 ;;
      *) return 1 ;;
    esac
  done
  if [ "$gateway_seen_app_server" = 1 ]; then return 0; fi
  return 1
}
`;
}

/** The ssh options that take an argument (the rest of the cluster or the next word); one list for every parser of tunnel arguments. */
export const sshOptionsWithArgument = "BbcDEeFIiJLlmOoPpQRSWw";

/** Add outage defaults to new managed SSH children without changing explicit options. */
export function serviceTunnelArguments(args: readonly string[]): string[] {
  const supplied = new Set<string>(); const withValue = sshOptionsWithArgument;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]; if (arg === "--" || !arg.startsWith("-") || arg === "-") break;
    for (let position = 1; position < arg.length; position++) {
      const flag = arg[position];
      if (!withValue.includes(flag)) continue;
      const value = arg.slice(position + 1) || args[++index] || "";
      if (flag === "o") {
        const option = value.match(/^\s*(ConnectTimeout|ConnectionAttempts)(?:\s*=|\s+)/i)?.[1];
        if (option) supplied.add(option.toLowerCase());
      }
      break;
    }
  }
  const defaults = [["connecttimeout", "ConnectTimeout=10"], ["connectionattempts", "ConnectionAttempts=1"]]
    .filter(([key]) => !supplied.has(key)).flatMap(([, value]) => ["-o", value]);
  return [...defaults, ...args];
}

/**
 * A reverse tunnel's remote port can outlive an unclean drop (sleep, network change):
 * the remote sshd keeps listening until its TCP keepalive notices, by default hours
 * later, and every reconnect fails. Before reconnecting, this command frees that port
 * on the remote, killing only sshd session processes of the same user that hold it.
 * Our previous tunnel process has already exited when it runs.
 */
export function staleForwardCleanup(args: readonly string[]): string[] | undefined {
  const index = args.indexOf("-R"); if (index < 0) return;
  const port = /^(?:127\.0\.0\.1:|localhost:)?(\d{1,5}):/.exec(args[index + 1] || "")?.[1];
  const host = args[args.length - 1];
  if (!port || !host || host.startsWith("-")) return;
  const options: string[] = [];
  for (let position = 0; position < args.length - 1; position++) {
    const arg = args[position];
    if (arg === "-N" || arg === "-T") continue;
    if (arg === "-R" || arg === "-L") { position++; continue; }
    if (arg === "-o") { const value = args[++position] || ""; if (!/^(RemoteCommand|ExitOnForwardFailure)\b/i.test(value)) options.push("-o", value); continue; }
    options.push(arg);
  }
  const script = `n=0; for p in $(lsof -nP -t -iTCP@127.0.0.1:${port} -sTCP:LISTEN 2>/dev/null); do case "$(ps -o comm= -p "$p")" in *sshd*) kill "$p" 2>/dev/null && n=$((n+1));; esac; done; echo "$n"`;
  return [...options, "-o", "RemoteCommand=none", host, script];
}

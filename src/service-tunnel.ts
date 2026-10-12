/** Add outage defaults to new managed SSH children without changing explicit options. */
export function serviceTunnelArguments(args: readonly string[]): string[] {
  const supplied = new Set<string>(); const withValue = "BbcDEeFIiJLlmOoPpQRSWw";
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

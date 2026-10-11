import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function gatewayCommand(): { command: string; args: string[] } {
  return process.env.GATEWAY_INSTALLED === "1" && process.env.GATEWAY_COMMAND
    ? { command: resolve(process.env.GATEWAY_COMMAND), args: [] }
    : { command: process.execPath, args: [fileURLToPath(new URL("./cli.js", import.meta.url))] };
}

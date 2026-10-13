import type { Message } from "./app-server-connection.js";

const analyticsDefault = "--analytics-default-enabled";
const legacyMismatch = "Native execution startup settings differ; existing ownership was preserved";
const codeModeHost = "features.code_mode_host=true";
const mismatch = (error: unknown): error is Error => error instanceof Error && (error as Error & { code?: number }).code === -32000 && error.message === legacyMismatch;

function alternateCodeModeArgs(args: string[]): string[] | undefined {
  const result: string[] = []; let present = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (["-c", "--config"].includes(arg) && args[index + 1] === codeModeHost) { present = true; index++; continue; }
    // Conflicting or differently expressed settings retain their strict checks.
    if (arg.includes("features.code_mode_host") || (["--enable", "--disable"].includes(arg) && args[index + 1] === "code_mode_host") || arg.includes("=code_mode_host")) return;
    result.push(arg);
  }
  return present ? result : ["-c", codeModeHost, ...result];
}

function alternateAnalyticsArgs(args: string[]): string[] {
  if (args.includes(analyticsDefault)) return args.filter(arg => arg !== analyticsDefault);
  const index = args.indexOf("app-server");
  return [...args.slice(0, index + 1), analyticsDefault, ...args.slice(index + 1)];
}

/** Rolling upgrades can attach to an older host without restarting its writer. */
export async function acquireNativeCompatible(request: (params: Message) => Promise<Message>, args: string[], cwd: string,
  codeModeAlreadyEnabled: () => Promise<boolean> = async () => false): Promise<Message> {
  try { return await request({ args, cwd }); }
  catch (error) {
    // This exact refusal proves the host already has an owner. Retry only its
    // analytics default; settings, cwd, and the existing writer stay unchanged.
    if (!mismatch(error)) throw error;
    let last = error;
    try { return await request({ args: alternateAnalyticsArgs(args), cwd }); }
    catch (error) { if (!mismatch(error)) throw error; last = error; }
    const alternate = alternateCodeModeArgs(args);
    if (!alternate || !await codeModeAlreadyEnabled()) throw last;
    // The signed SDK must prove that this is a redundant enabled setting.
    // Changing a disabled feature, another setting, or cwd is never permitted.
    for (const compatible of [alternate, alternateAnalyticsArgs(alternate)]) {
      try { return await request({ args: compatible, cwd }); }
      catch (error) { if (!mismatch(error)) throw error; last = error; }
    }
    throw last;
  }
}

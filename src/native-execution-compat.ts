import type { Message } from "./app-server-connection.js";

const analyticsDefault = "--analytics-default-enabled";
const legacyMismatch = "Native execution startup settings differ; existing ownership was preserved";

/** Rolling upgrades can attach to an older host without restarting its writer. */
export async function acquireNativeCompatible(request: (params: Message) => Promise<Message>, args: string[], cwd: string): Promise<Message> {
  try { return await request({ args, cwd }); }
  catch (error) {
    // This exact refusal proves the host already has an owner. Retry only its
    // analytics default; settings, cwd, and the existing writer stay unchanged.
    if (!(error instanceof Error) || (error as Error & { code?: number }).code !== -32000 || error.message !== legacyMismatch) throw error;
    const compatible = args.includes(analyticsDefault) ? args.filter(arg => arg !== analyticsDefault) : [...args, analyticsDefault];
    return request({ args: compatible, cwd });
  }
}

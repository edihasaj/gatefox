import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { LiveConfig } from "./live-config.js";
import { adoptGatewayHandler, createGatewayHandler, startGateway, type GatewayServer } from "./server.js";
import { refreshModelMetadata } from "./model-refresh.js";
import { configureTelemetry, telemetry } from "./telemetry.js";
import { startErrorReports } from "./error-report.js";
import { releaseState, watchForUpgrade } from "./self-update.js";

/** Releases that agree on this number can take over a running server in place. */
export const serveRuntimeVersion = 1;
export interface ServeRuntime { version: number; stop(): void }

/**
 * Starts (or, given `server`, takes over) the inference server's request handling and
 * its timers. After an install, the installed release's runtime takes over the same
 * socket: new requests use the new code at once, running requests finish on the old.
 */
export async function startServeRuntime(configPath: string, port?: number, server?: GatewayServer, previous?: ServeRuntime): Promise<{ server: GatewayServer; runtime: ServeRuntime }> {
  const config = await loadConfig(configPath); if (port) config.port = port;
  configureTelemetry(config.stateDirectory, "server"); startErrorReports(config.stateDirectory, "server");
  const live = new LiveConfig(configPath, config, port);
  const gateway = server ? adoptGatewayHandler(server, await createGatewayHandler(config, undefined, () => live.current())) : await startGateway(config, undefined, () => live.current());
  previous?.stop();
  // Model metadata follows each provider's own catalog: shortly after start, then every six hours.
  const refresh = () => { void refreshModelMetadata(configPath).then(updated => { if (updated.length) telemetry("model_metadata_refreshed", { providers: updated.join(",") }); }).catch(() => {}); };
  const first = setTimeout(refresh, 60_000); first.unref(); const every = setInterval(refresh, 6 * 60 * 60_000); every.unref();
  let runtime: ServeRuntime;
  const stopWatching = watchForUpgrade("server", () => true, async () => {
    const next = await installedServeRuntime();
    if (next?.serveRuntimeVersion === serveRuntimeVersion) {
      await next.startServeRuntime(configPath, port, gateway, runtime);
      telemetry("server_hot_swap", { from: releaseState()?.running, to: releaseState()?.installed });
      return true;
    }
    // A release that cannot take over in place restarts the process at an idle moment.
    return gateway.restartWhenIdle(() => process.exit(0));
  });
  runtime = { version: serveRuntimeVersion, stop: () => { clearTimeout(first); clearInterval(every); stopWatching(); } };
  return { server: gateway, runtime };
}

type RuntimeModule = { serveRuntimeVersion?: number; startServeRuntime: typeof startServeRuntime };
async function installedServeRuntime(): Promise<RuntimeModule | undefined> {
  try {
    const releases = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const file = realpathSync(resolve(releases, "../current/package/dist/serve-runtime.js"));
    return await import(pathToFileURL(file).href) as RuntimeModule;
  } catch { return; }
}

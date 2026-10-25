import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type GatewayConfig } from "./config.js";
import { LiveConfig } from "./live-config.js";
import { adoptGatewayHandler, createGatewayHandler, type GatewayHandler, type GatewayServer } from "./server.js";
import { refreshModelMetadata } from "./model-refresh.js";
import { configureTelemetry, telemetry } from "./telemetry.js";
import { startErrorReports } from "./error-report.js";
import { releaseState, watchForUpgrade } from "./self-update.js";
import { retainRunningRelease, type ReleaseLease } from "./release-retention.js";
import { hostAutoLatestMaintenance } from "./model-auto-latest/hosting.js";
import { refreshApiModeCatalog } from "./desktop-api-mode.js";

/** Releases that agree on this number can take over a running server in place. */
export const serveRuntimeVersion = 1;
export interface ServeRuntime { version: number; stop(): void | Promise<void> }

/**
 * Starts (or, given `server`, takes over) the inference server's request handling and
 * its timers. After an install, the installed release's runtime takes over the same
 * socket: new requests use the new code at once, running requests finish on the old.
 */
export async function startServeRuntime(configPath: string, port?: number, server?: GatewayServer, previous?: ServeRuntime, lease: ReleaseLease = retainRunningRelease()): Promise<{ server: GatewayServer; runtime: ServeRuntime }> {
 try {
  const config = await loadConfig(configPath); if (port) config.port = port;
  configureTelemetry(config.stateDirectory, "server"); startErrorReports(config.stateDirectory, "server");
  // API mode's model list lives in a file the app's own engine reads, so it follows every configuration this service
  // adopts. No timer and no background item of its own: the hook runs on the apply that is already happening, and only
  // at all while the API mode receipt exists.
  const live = new LiveConfig(configPath, config, port, applied => { void refreshApiModeCatalog(applied); });
  const options = { configRejection: () => live.rejection };
  const handler: GatewayHandler = await createGatewayHandler(config, undefined, () => live.current(), options);
  let gateway: GatewayServer;
  if (server) gateway = adoptGatewayHandler(server, handler);
  else {
    const listener = createServer(); listener.requestTimeout = 30000; gateway = adoptGatewayHandler(listener, handler);
    await new Promise<void>((done, fail) => { listener.once("error", fail); listener.listen(config.port, "127.0.0.1", () => { listener.off("error", fail); done(); }); });
  }
  await previous?.stop();
  // The existing app-owned service tree hosts model maintenance. Never register another background item.
  const maintenance = hostAutoLatestMaintenance(configPath, "server");
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
  let stopped = false; let stopping: Promise<void> | undefined;
  const releaseWhenDrained = () => {
    if (!stopped) return;
    // This runtime's handler can still finish a request after a newer handler took
    // over the socket. Retain its release until that generation alone is idle.
    if (handler.isIdle()) { lease.release(); return; }
    const timer = setTimeout(releaseWhenDrained, 100); timer.unref();
  };
  runtime = { version: serveRuntimeVersion, stop: () => {
    if (stopped) return stopping;
    stopped = true; gateway.off("close", onClose); clearTimeout(first); clearInterval(every); stopWatching(); releaseWhenDrained();
    return stopping = Promise.resolve(maintenance.stop());
  } };
  const onClose = () => { void runtime.stop(); };
  gateway.once("close", onClose);
  return { server: gateway, runtime };
 } catch (error) {
   lease.release();
   throw error;
 }
}

type RuntimeModule = { serveRuntimeVersion?: number; startServeRuntime: typeof startServeRuntime };
async function installedServeRuntime(): Promise<RuntimeModule | undefined> {
  try {
    const releases = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const file = realpathSync(resolve(releases, "../current/package/dist/serve-runtime.js"));
    return await import(pathToFileURL(file).href) as RuntimeModule;
  } catch { return; }
}

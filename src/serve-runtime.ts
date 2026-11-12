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
import { reconcileTailnetListener, type TailnetTls } from "./tailnet-listener.js";
import { fetchTailnetCertificate } from "./tailnet-tls.js";

/** How often an enabled tailnet listener picks up a Tailscale address that appeared or left, for example after login. */
const tailnetRefreshMs = 30_000;
/** Tailscale renews the certificate well before it expires; asking twice a day picks the renewal up in time. */
const certificateRefreshMs = 12 * 60 * 60_000;
/** After a failed fetch (Tailscale logged out, HTTPS certificates off), wait this long before asking again. */
const certificateRetryMs = 5 * 60_000;

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
  // The tailnet socket follows the configuration this runtime adopts, including a live edit, and this Mac's addresses.
  let tailnetEnabled = config.tailnetListener === true; let tailnetTarget: GatewayServer | undefined;
  let stateDirectory = config.stateDirectory; let tailnetTls: TailnetTls | undefined;
  let certificateDue = 0; let certificateValidTo = 0; let tailnetSyncing: Promise<void> | undefined;
  const certificate = async () => {
    const now = Date.now();
    if (now < certificateDue && (!tailnetTls || certificateValidTo - now > certificateRefreshMs)) return;
    const fetched = await fetchTailnetCertificate(stateDirectory);
    if (fetched) { tailnetTls = { cert: fetched.cert, key: fetched.key }; certificateValidTo = fetched.validTo; certificateDue = now + certificateRefreshMs; }
    else {
      certificateDue = now + certificateRetryMs;
      // An expired pair is never served.
      if (certificateValidTo <= now) tailnetTls = undefined;
      telemetry("tailnet_listener", { state: "certificate_unavailable" });
    }
  };
  const syncTailnet = (): Promise<void> => tailnetSyncing ??= (async () => {
    try {
      if (!tailnetTarget) return;
      if (tailnetEnabled) await certificate();
      if (tailnetTarget) await reconcileTailnetListener(tailnetTarget, tailnetEnabled, { tls: tailnetTls });
    } catch { /* The next tick retries; the loopback listener is unaffected. */ } finally { tailnetSyncing = undefined; }
  })();
  // API mode's model list lives in a file the app's own engine reads, so it follows every configuration this service
  // adopts. No timer and no background item of its own: the hook runs on the apply that is already happening, and only
  // at all while the API mode receipt exists.
  const live = new LiveConfig(configPath, config, port, applied => {
    void refreshApiModeCatalog(applied);
    tailnetEnabled = applied.tailnetListener === true; stateDirectory = applied.stateDirectory; void syncTailnet();
  });
  const options = { configRejection: () => live.rejection };
  const handler: GatewayHandler = await createGatewayHandler(config, undefined, () => live.current(), options);
  let gateway: GatewayServer;
  if (server) gateway = adoptGatewayHandler(server, handler);
  else {
    const listener = createServer(); listener.requestTimeout = 30000; gateway = adoptGatewayHandler(listener, handler);
    await new Promise<void>((done, fail) => { listener.once("error", fail); listener.listen(config.port, "127.0.0.1", () => { listener.off("error", fail); done(); }); });
  }
  await previous?.stop();
  // The certificate may take a moment to fetch; the loopback listener already serves meanwhile.
  tailnetTarget = gateway; void syncTailnet();
  const tailnetTimer = setInterval(() => { void syncTailnet(); }, tailnetRefreshMs); tailnetTimer.unref();
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
    // The tailnet sockets stay with the process: the runtime that takes over reconciles them, and the server's close ends them.
    stopped = true; tailnetTarget = undefined; gateway.off("close", onClose); clearTimeout(first); clearInterval(every); clearInterval(tailnetTimer); stopWatching(); releaseWhenDrained();
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

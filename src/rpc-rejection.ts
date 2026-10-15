/**
 * Names why a client request was refused, from a fixed list, so `rpc_error` telemetry is
 * diagnosable without recording the error text. Engine refusals use the pinned Codex SDK's
 * own messages (signed SDK 0.162.0-alpha.17.2); anything unrecognized is `other`.
 */
const engineRejections: ReadonlyArray<readonly [string, RegExp]> = [
  // A path parameter that is not absolute, such as the desktop's projectless `~` sentinel.
  ["relative_path", /AbsolutePathBuf deserialized without a base path/],
  ["experimental_api", /requires experimentalApi capability$/],
  ["prediction_fork_overrides", /^`experimentalPredictionMode` cannot be combined with configuration overrides$/],
  ["prediction_fork_parent", /^`experimentalPredictionMode` requires/],
  ["no_active_process", /^no active process for process handle /],
  ["process_not_running", /^process .* is no longer running$/],
  ["duplicate_process_handle", /^duplicate active process handle: /],
  ["spawn_failed", /^failed to spawn process: /],
  ["rollout_not_found", /^no rollout found for thread id /],
  ["thread_not_loaded", /^thread not loaded: /],
  ["thread_not_persisted", /^thread is not persisted and cannot be deleted: /],
  ["engine_closed", /^Codex app-server (is closed|exited|socket closed)$|^The gateway executor (connection was lost|exited)/],
  ["engine_timeout", /^Codex app-server request timed out$/],
  ["invalid_params", /^Invalid request: /],
];

/** The values `rpcRejection` can return; telemetry never carries anything else. */
export const rpcRejections: ReadonlySet<string> = new Set(["adapter_routing", "unknown_method", "other", ...engineRejections.map(([name]) => name)]);

export function rpcRejection(method: string, error: unknown, routing = false): string {
  if (routing) return "adapter_routing";
  const failure = error as { code?: unknown; message?: unknown } | undefined;
  const message = typeof failure?.message === "string" ? failure.message : "";
  // The SDK names an unknown method as an unknown request variant.
  if (failure?.code === -32601 || message.startsWith(`Invalid request: unknown variant \`${method}\``)) return "unknown_method";
  return engineRejections.find(([, pattern]) => pattern.test(message))?.[0] ?? "other";
}

/**
 * Names why a client request was refused, from a fixed list, so `rpc_error` telemetry is
 * diagnosable without recording the error text. Engine refusals use the pinned Codex SDK's
 * own messages (signed SDK 0.162.0-alpha.17.2); anything unrecognized is `other`.
 */
// A matches any method and code; the guarded names below are read only where the pinned SDK's
// message format was verified against the binary, so the same OS text elsewhere stays `other`.
type Guard = (method: string, code: unknown) => boolean;
const any: Guard = () => true;

const engineRejections: ReadonlyArray<readonly [string, RegExp, Guard]> = [
  // A path parameter that is not absolute, such as the desktop's projectless `~` sentinel.
  ["relative_path", /AbsolutePathBuf deserialized without a base path/, any],
  // The file-read APIs answer -32603 with the OS text alone and no path. An absent path is a
  // native expected miss — the desktop probes files a remote host simply does not have — so it
  // gets a name and stops counting as an unclassified refusal. Permission denied is named the
  // same way but is not a benign miss: it is an actionable access problem (a missing grant or
  // TCC permission on that machine). Neither name changes a health verdict: the watchdog's
  // refused-session count covers only thread/start, thread/resume, thread/fork and turn/start,
  // so these were never counted there; both stay visible in the diagnostics problem list.
  // The names are read only for the methods below, where the message format was verified
  // against the pinned binary; the same OS text elsewhere stays `other`.
  ["file_not_found", /^No such file or directory \(os error 2\)$/, (method, code) => fsReadMethods.has(method) && code === -32603],
  ["path_permission_denied", /^Permission denied \(os error 13\)$/, (method, code) => fsReadMethods.has(method) && code === -32603],
  ["experimental_api", /requires experimentalApi capability$/, any],
  ["prediction_fork_overrides", /^`experimentalPredictionMode` cannot be combined with configuration overrides$/, any],
  ["prediction_fork_parent", /^`experimentalPredictionMode` requires/, any],
  ["no_active_process", /^no active process for process handle /, any],
  ["process_not_running", /^process .* is no longer running$/, any],
  ["duplicate_process_handle", /^duplicate active process handle: /, any],
  // The SDK's spawn text names the OS cause but not whether the working directory or the
  // program was missing; both arrive as "failed to spawn process: No such file or directory
  // (os error 2)", so the split is recorded without any path.
  ["spawn_path_missing", /^failed to spawn process: No such file or directory \(os error 2\)$/, (method, code) => method === "process/spawn" && code === -32603],
  ["spawn_permission_denied", /^failed to spawn process: Permission denied \(os error 13\)$/, (method, code) => method === "process/spawn" && code === -32603],
  ["spawn_failed", /^failed to spawn process: /, any],
  ["rollout_not_found", /^no rollout found for thread id /, any],
  ["thread_not_loaded", /^thread not loaded: /, any],
  ["thread_not_persisted", /^thread is not persisted and cannot be deleted: /, any],
  ["engine_closed", /^Codex app-server (is closed|exited|socket closed)$|^The gateway executor (connection was lost|exited)/, any],
  ["engine_timeout", /^Codex app-server request timed out$/, any],
  ["invalid_params", /^Invalid request: /, any],
];

/** The values `rpcRejection` can return; telemetry never carries anything else. */
export const rpcRejections: ReadonlySet<string> = new Set(["adapter_routing", "unknown_method", "other", ...engineRejections.map(([name]) => name)]);

// The file APIs whose -32603 was verified against the pinned binary to carry the OS text alone:
// they answer with the plain io error, no path and no prefix. `fs/remove` succeeds on a path
// that is already absent, and writes/copies remain outside this read-only classification; a request to
// any other method that fails with the same OS text (a routing path that walked into a missing
// directory, say) stays `other` for review.
const fsReadMethods = new Set(["fs/readFile", "fs/readDirectory", "fs/getMetadata"]);

export function rpcRejection(method: string, error: unknown, routing = false): string {
  if (routing) return "adapter_routing";
  const failure = error as { code?: unknown; message?: unknown } | undefined;
  const message = typeof failure?.message === "string" ? failure.message : "";
  // The SDK names an unknown method as an unknown request variant.
  if (failure?.code === -32601 || message.startsWith(`Invalid request: unknown variant \`${method}\``)) return "unknown_method";
  return engineRejections.find(([, pattern, guard]) => guard(method, failure?.code) && pattern.test(message))?.[0] ?? "other";
}

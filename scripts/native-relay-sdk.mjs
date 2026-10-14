import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gatewaySdkLockSha256, repairGatewaySdkLock } from './gateway-sdk-lock.mjs';
import { sdkPatches } from './native-relay-sdk-patches.mjs';

export { sdkPatches };
export const sdkRevision = '740e5af33c71225640e0c1c1555c514c2c93ab74';
export const sdkArchiveSha256 = '25747823ea4ec852a146cbbe75d805b8df19190ca5b3fb21052d8e1cb75f2f83';
export const sdkOverlay = 'native-relay/sdk-overlay';
const lockPath = 'codex-rs/Cargo.lock';
const manifestName = '.gateway-materialized.json';

/** Tests that must run and pass in the patched SDK; a filtered-out name fails the gate. */
export const requiredSdkTests = [
  'transport::remote_control::client_tracker::tests::cancelled_outbound_task_emits_connection_closed',
  'transport::remote_control::client_tracker::tests::shutdown_cancels_blocked_outbound_forwarding',
  'transport::remote_control::client_tracker::tests::incoming_message_timeout_does_not_advance_seq_id',
  'transport::remote_control::tests::remote_control_transport_manages_virtual_clients_and_routes_messages',
  'transport::remote_control::tests::remote_control_transport_clears_outgoing_buffer_when_backend_acks',
  'gateway_counters::tests::hash_id_is_stable_short_hex_and_hides_its_input',
  'gateway_counters::tests::reset_switch_requires_a_regular_file',
  'gateway_counters::tests::counters_and_outbound_gauge_only_grow_their_maximum',
  ...['app_side_cancel_drains_writer_then_sends_unknown_pong', 'dropped_writer_is_an_app_side_end',
    'client_closed_sends_no_unknown_pong', 'idle_sweep_sends_no_unknown_pong', 'tracker_shutdown_sends_no_unknown_pong',
    'sdk_root_shutdown_sends_no_unknown_pong', 'failed_initialize_forward_sends_no_unknown_pong',
    'reinitialize_same_stream_keeps_replacement_open', 'stream_end_is_bounded_when_server_queue_full',
  ].map(name => `transport::remote_control::gateway_stream_end_tests::${name}`),
  'transport::remote_control::tests::gateway_wire_tests::relay_stream_end_reaches_backend_after_last_reply_and_client_close_does_not',
  'transport::remote_control::tests::gateway_wire_tests::reinitialized_stream_accepts_its_chunked_messages_again',
  'transport::remote_control::gateway_observability_tests::replayed_seq_is_dropped_and_counted',
  'transport::remote_control::gateway_observability_tests::unknown_stream_message_is_counted',
  ...['contiguous_messages_pings_and_close_leave_no_hole', 'missing_seq_turns_stale_after_15s',
    'chunk_assembly_defers_staleness', 'pings_without_seq_are_counted_not_filled', 'late_fill_after_stale_is_reported',
    'reset_switch_allows_one_reset_per_stream_per_10_minutes', 'late_seq_is_still_deduped_and_counted',
    'log_only_never_cancels', 'reset_switch_resets_once_via_unknown_pong',
  ].map(name => `transport::remote_control::gateway_inbound_tests::${name}`),
];
/** The pinned upstream remote-control suite has 140 tests; with ours the gate runs at least this many. */
export const minimumSdkTests = 165;
/** libtest filters: the remote-control suite plus the crate-root gateway counters. */
export const sdkTestFilters = ['transport::remote_control::', 'gateway_counters::'];

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const sdkPatchDigest = () => digest(JSON.stringify(sdkPatches));

/** Apply every patch for `file`. Each anchor must occur exactly `count` (default 1) times. */
export function applyPatches(text, file, patches = sdkPatches) {
  for (const { original, replacement, count = 1 } of patches.filter(patch => patch.file === file)) {
    const parts = text.split(original);
    if (parts.length - 1 !== count) {
      throw Error(`SDK source anchor occurs ${parts.length - 1} times, expected ${count}: ${file}`);
    }
    text = parts.join(replacement);
  }
  return text;
}

/** Overlays may only add files: refuse any path the pinned archive already contains. */
export function checkOverlayPaths(paths, archiveEntries, archiveRoot) {
  const listed = new Set(archiveEntries.map(entry => entry.replace(/\/$/, '')));
  for (const path of paths) {
    if (!path.startsWith('codex-rs/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error(`Unsafe SDK overlay path: ${path}`);
    }
    if (listed.has(`${archiveRoot}/${path}`)) throw Error(`SDK overlay would replace an upstream file: ${path}`);
  }
}

function overlayFiles(directory, relative = '') {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const key = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...overlayFiles(join(directory, entry.name), key));
    else if (entry.isFile()) files.push(key);
    else throw Error(`Unsupported SDK overlay entry: ${key}`);
  }
  return files;
}

function writeIfChanged(path, bytes) {
  if (existsSync(path) && readFileSync(path).equals(bytes)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** Extract once, then rewrite patched and overlay files from pristine bytes on every build.
 * Unchanged files keep their bytes and mtimes, so cargo only rebuilds what changed.
 */
export function materializeSdk({ archive, sdk, root, overlay = sdkOverlay }) {
  if (!existsSync(join(sdk, '.gateway-revision'))) {
    if (existsSync(sdk)) throw Error('Refusing an unrecognized SDK checkout');
    mkdirSync(sdk); execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', sdk]);
    writeFileSync(join(sdk, '.gateway-revision'), sdkRevision);
  }
  if (readFileSync(join(sdk, '.gateway-revision'), 'utf8') !== sdkRevision) throw Error('Codex SDK revision mismatch');
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  const archiveRoot = entries.find(entry => !entry.startsWith('pax_global_header'))?.split('/')[0];
  if (!archiveRoot) throw Error('Pinned SDK archive has no root directory');
  const patched = [...new Set(sdkPatches.map(patch => patch.file))].sort();
  const pristine = join(root, 'pristine');
  mkdirSync(pristine, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', pristine,
    ...[...patched, lockPath].map(path => `${archiveRoot}/${path}`)]);
  for (const file of patched) {
    writeIfChanged(join(sdk, file), Buffer.from(applyPatches(readFileSync(join(pristine, file), 'utf8'), file)));
  }
  const lock = join(sdk, lockPath);
  if (!existsSync(lock) || digest(readFileSync(lock)) !== gatewaySdkLockSha256) {
    writeFileSync(lock, readFileSync(join(pristine, lockPath)));
    repairGatewaySdkLock(lock);
  }
  const overlays = overlayFiles(overlay);
  checkOverlayPaths(overlays, entries, archiveRoot);
  for (const file of overlays) writeIfChanged(join(sdk, file), readFileSync(join(overlay, file)));
  const files = [...patched, lockPath, ...overlays].sort();
  const manifestPath = join(sdk, manifestName);
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const stale = (previous.files || []).filter(file => !files.includes(file));
    if (stale.length) throw Error(`SDK file ${stale[0]} is no longer produced; move .state/native-relay-build/sdk to Trash and rebuild`);
  }
  writeIfChanged(manifestPath, Buffer.from(JSON.stringify({ revision: sdkRevision, patchDigest: sdkPatchDigest(), files }, null, 2)));
  return { archiveRoot, files };
}

/** Cargo arguments for the patched SDK remote-control suite (run with cwd <sdk>/codex-rs). */
export function sdkTestArguments({ sdk, target, dev }) {
  return ['test', '--locked', ...(dev ? [] : ['--release']), '--manifest-path', join(sdk, 'codex-rs/Cargo.toml'),
    '-p', 'codex-app-server-transport', '--lib', '--target-dir', target, '--', ...sdkTestFilters];
}

/** Require a clean libtest summary, a minimum test count and every required test reported as `ok`. */
export function checkSdkTestOutput(output, required = requiredSdkTests, minimum = minimumSdkTests) {
  const summary = /test result: ok\. (\d+) passed; 0 failed;/.exec(output);
  if (!summary) throw Error('Patched SDK tests did not report 0 failed');
  if (Number(summary[1]) < minimum) throw Error(`Patched SDK gate ran ${summary[1]} tests, expected at least ${minimum}`);
  const missing = required.filter(name => !output.includes(`test ${name} ... ok`));
  if (missing.length) throw Error(`Required SDK tests did not pass: ${missing.join(', ')}`);
  return Number(summary[1]);
}

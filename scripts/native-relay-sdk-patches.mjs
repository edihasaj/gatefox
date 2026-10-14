// String patches applied to pristine pinned SDK sources. Each `original` must occur exactly
// `count` times (default 1). New logic lives in native-relay/sdk-overlay; patches only call it.
const transport = 'codex-rs/app-server-transport/src/';
const remote = `${transport}transport/remote_control/`;

const existing = [
  { file: `${transport}outgoing_message.rs`, original: 'pub enum OutgoingMessage {',
    replacement: 'pub enum OutgoingMessage {\n    /// Gateway: preserve arbitrary app-server JSON envelopes.\n    Passthrough(serde_json::Value),' },
  { file: `${remote}mod.rs`, original: 'pub struct RemoteControlStartConfig {',
    replacement: 'pub struct RemoteControlStartConfig {\n    pub server_name: Option<String>,' },
  { file: `${remote}controller.rs`, original: 'let server_name = gethostname().to_string_lossy().trim().to_string();',
    replacement: 'let server_name = self.config.server_name.clone().unwrap_or_else(|| gethostname().to_string_lossy().trim().to_string());' },
  { file: `${remote}controller.rs`, original: 'server_name: gethostname().to_string_lossy().trim().to_string(),',
    replacement: 'server_name: config.server_name.clone().unwrap_or_else(|| gethostname().to_string_lossy().trim().to_string()),' },
  { file: `${remote}websocket.rs`, original: '    info!(\n        "creating new remote control enrollment:',
    replacement: '    if enrollment.is_none() || matches!(selection, RemoteControlEnrollmentSelection::ReplaceExisting) {\n        return Err(io::Error::new(ErrorKind::NotFound, "Gateway requires the existing native machine registration"));\n    }\n    info!(\n        "creating new remote control enrollment:' },
];

// The server-name field above has no default, so upstream test initializers name it as `None`,
// which keeps their original hostname behaviour.
// Upstream unit tests also enroll new mock machines. The relay binary is never built with
// cfg(test), so it keeps the existing-registration guard; only the SDK's own test build skips it.
const testCompatibility = [
  { file: `${remote}tests.rs`, count: 19, original: 'RemoteControlStartConfig {\n            remote_control_url',
    replacement: 'RemoteControlStartConfig {\n            server_name: None,\n            remote_control_url' },
  { file: `${remote}tests/retry_tests.rs`, count: 2, original: 'RemoteControlStartConfig {\n            remote_control_url',
    replacement: 'RemoteControlStartConfig {\n            server_name: None,\n            remote_control_url' },
  { file: `${remote}websocket.rs`,
    original: '    if enrollment.is_none() || matches!(selection, RemoteControlEnrollmentSelection::ReplaceExisting) {',
    replacement: '    if !cfg!(test) && (enrollment.is_none() || matches!(selection, RemoteControlEnrollmentSelection::ReplaceExisting)) {' },
];

// Process-global counters and hashed ids, readable by the relay.
const counters = [
  { file: `${transport}lib.rs`, original: 'mod transport;\n', replacement: 'mod transport;\npub mod gateway_counters;\n' },
];

// F1: an app-side stream end sends Pong { Unknown } after the stream's queued replies.
const tracker = `${remote}client_tracker.rs`;
const upstreamOutboundBody = [
  '        loop {',
  '            let (event, write_complete_tx) = tokio::select! {',
  '                _ = disconnect_token.cancelled() => {',
  '                    break;',
  '                }',
  '                queued_message = writer_rx.recv() => {',
  '                    let Some(queued_message) = queued_message else {',
  '                        break;',
  '                    };',
  '                    let event = ServerEvent::ServerMessage {',
  '                        message: Box::new(queued_message.message),',
  '                    };',
  '                    (event, queued_message.write_complete_tx)',
  '                }',
  '                changed = status_rx.changed() => {',
  '                    if changed.is_err() {',
  '                        break;',
  '                    }',
  '                    let event = ServerEvent::Pong { status: status_rx.borrow().clone() };',
  '                    (event, None)',
  '                }',
  '            };',
  '            let send_result = tokio::select! {',
  '                _ = disconnect_token.cancelled() => {',
  '                    break;',
  '                }',
  '                send_result = server_event_tx.send(QueuedServerEnvelope {',
  '                    event,',
  '                    client_id: client_id.clone(),',
  '                    stream_id: stream_id.clone(),',
  '                    write_complete_tx,',
  '                }) => send_result,',
  '            };',
  '            if send_result.is_err() {',
  '                break;',
  '            }',
  '        }',
  '        (client_id, stream_id)',
  '    }',
].join('\n');
const streamEnd = [
  { file: `${remote}mod.rs`, original: 'mod websocket;\n',
    replacement: 'mod websocket;\nmod gateway_stream_end;\n#[cfg(test)]\nmod gateway_stream_end_tests;\n' },
  { file: `${remote}tests.rs`, original: '#[path = "tests/retry_tests.rs"]\nmod retry_tests;\n',
    replacement: '#[path = "tests/retry_tests.rs"]\nmod retry_tests;\n#[path = "tests/gateway_wire_tests.rs"]\nmod gateway_wire_tests;\n' },
  { file: tracker, original: 'use tracing::warn;\n',
    replacement: 'use tracing::warn;\nuse super::gateway_stream_end;\nuse super::gateway_stream_end::StreamEnd;\n\n#[path = "gateway_tracker_hooks.rs"]\nmod gateway_tracker_hooks;\n' },
  { file: tracker, original: '    last_inbound_seq_id: Option<u64>,\n    status_tx: watch::Sender<PongStatus>,\n}\n',
    replacement: '    last_inbound_seq_id: Option<u64>,\n    status_tx: watch::Sender<PongStatus>,\n    stream_end: StreamEnd,\n    outbound_task: tokio::task::Id,\n}\n' },
  { file: tracker, original: '        while let Some(join_result) = self.join_set.join_next().await {\n            let Ok(client_key) = join_result else {\n                continue;\n            };\n            return Some(client_key);\n        }\n        futures::future::pending().await\n',
    replacement: '        self.gateway_bookkeep().await\n' },
  { file: tracker, original: '                self.join_set.spawn(Self::run_client_outbound(\n',
    replacement: '                let stream_end = StreamEnd::new(connection_id, &self.shutdown_token);\n                let outbound_task = self.join_set.spawn(Self::run_client_outbound(\n' },
  { file: tracker, original: '                    disconnect_token.clone(),\n                ));\n',
    replacement: '                    disconnect_token.clone(),\n                    stream_end.clone(),\n                )).id();\n' },
  { file: tracker, original: '                        last_inbound_seq_id: None,\n                        status_tx,\n',
    replacement: '                        last_inbound_seq_id: None,\n                        status_tx,\n                        stream_end,\n                        outbound_task,\n' },
  { file: tracker, original: '        mut writer_rx: mpsc::Receiver<QueuedOutgoingMessage>,\n        mut status_rx: watch::Receiver<PongStatus>,\n        disconnect_token: CancellationToken,\n    ) -> (ClientId, StreamId) {\n',
    replacement: '        writer_rx: mpsc::Receiver<QueuedOutgoingMessage>,\n        status_rx: watch::Receiver<PongStatus>,\n        disconnect_token: CancellationToken,\n        stream_end: StreamEnd,\n    ) -> (ClientId, StreamId) {\n' },
  { file: tracker, original: upstreamOutboundBody,
    replacement: '        gateway_stream_end::run_client_outbound(\n            client_id,\n            stream_id,\n            server_event_tx,\n            writer_rx,\n            status_rx,\n            disconnect_token,\n            stream_end,\n        )\n        .await\n    }' },
  { file: tracker, original: '        let client = self.clients.remove(client_key)?;\n',
    replacement: '        let client = self.clients.remove(client_key)?;\n        client.stream_end.mark_tracker_close();\n' },
];

export const sdkPatches = [...existing, ...testCompatibility, ...counters, ...streamEnd];

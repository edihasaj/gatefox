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

// Overlay modules: process-global counters and hashed ids at the crate root (readable by the
// relay), stream-end and tracker logic plus their tests under remote_control.
const remoteModules = ['mod gateway_stream_end;', 'mod gateway_inbound;'];
const remoteTestModules = ['gateway_stream_end_tests', 'gateway_observability_tests', 'gateway_inbound_tests'];
const modules = [
  { file: `${transport}lib.rs`, original: 'mod transport;\n', replacement: 'mod transport;\npub mod gateway_counters;\n' },
  { file: `${remote}mod.rs`, original: 'mod websocket;\n',
    replacement: ['mod websocket;', ...remoteModules, ...remoteTestModules.flatMap(name => ['#[cfg(test)]', `mod ${name};`]), ''].join('\n') },
  { file: `${remote}tests.rs`, original: '#[path = "tests/retry_tests.rs"]\nmod retry_tests;\n',
    replacement: '#[path = "tests/retry_tests.rs"]\nmod retry_tests;\n#[path = "tests/gateway_wire_tests.rs"]\nmod gateway_wire_tests;\n' },
];

// F1: an app-side stream end sends Pong { Unknown } after the stream's queued replies.
const tracker = `${remote}client_tracker.rs`;
const websocket = `${remote}websocket.rs`;
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
  { file: tracker, original: 'use tracing::warn;\n',
    replacement: 'use tracing::warn;\nuse super::gateway_inbound;\nuse super::gateway_stream_end;\nuse super::gateway_stream_end::StreamEnd;\n\n#[path = "gateway_tracker_hooks.rs"]\nmod gateway_tracker_hooks;\n' },
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
  // The predecessor no longer clears a re-initialized stream's chunk state, so do it here.
  { file: websocket, original: '            let delivered_client_envelope = client_envelope.clone();\n',
    replacement: '            if let Some((client_id, stream_id)) = client_tracker.gateway_reinitialized_key(&client_envelope) {\n                let mut websocket_state = state.lock().await;\n                websocket_state\n                    .client_segment_reassembler\n                    .invalidate_stream(&client_id, &stream_id);\n                websocket_state.invalidate_client_message_stream(&client_id, &stream_id);\n            }\n            let delivered_client_envelope = client_envelope.clone();\n' },
  { file: tracker, original: '        let client = self.clients.remove(client_key)?;\n',
    replacement: '        let client = self.clients.remove(client_key)?;\n        client.stream_end.mark_tracker_close();\n' },
];

// F2: counters for silent SDK drops and the outbound gate, plus disconnect error kinds.
const count = name => `crate::gateway_counters::add(crate::gateway_counters::Counter::${name}, 1);`;
const unacked = '        crate::gateway_counters::set_outbound_unacked(*self.used_tx.borrow());\n';
const observability = [
  { file: websocket, original: '        self.used_tx.send_modify(|used| *used += 1);\n',
    replacement: `        self.used_tx.send_modify(|used| *used += 1);\n${unacked}` },
  { file: websocket, original: '        if buffer.is_empty() {\n            self.buffer_by_stream.remove(&key);\n        }\n',
    replacement: `        if buffer.is_empty() {\n            self.buffer_by_stream.remove(&key);\n        }\n${unacked}` },
  { file: websocket, original: '                .is_some_and(|last_seq_id| last_seq_id >= seq_id)\n        {\n            return ClientSegmentObservation::Dropped;\n',
    replacement: `                .is_some_and(|last_seq_id| last_seq_id >= seq_id)\n        {\n            ${count('InboundChunkDedupeDrop')}\n            return ClientSegmentObservation::Dropped;\n` },
  { file: websocket, original: 'warn!("remote control websocket writer disconnected, err: {err}");',
    replacement: 'warn!(error_kind = ?err.kind(), "remote control websocket writer disconnected, err: {err}");' },
  { file: websocket, original: 'warn!("remote control websocket reader disconnected, err: {err}");',
    replacement: 'warn!(error_kind = ?err.kind(), "remote control websocket reader disconnected, err: {err}");' },
  { file: tracker, original: '                    && !is_initialize\n                {\n                    return Ok(());\n',
    replacement: '                    && !is_initialize\n                {\n                    self.gateway_dedupe_dropped(&client_key, seq_id, gateway_fill);\n                    return Ok(());\n' },
  { file: tracker, original: '                if !is_initialize {\n                    return Ok(());\n                }\n',
    replacement: '                if !is_initialize {\n                    self.gateway_unknown_stream_dropped(&client_key);\n                    return Ok(());\n                }\n' },
  { file: tracker, original: '                let server_event_tx = self.server_event_tx.clone();\n                tokio::spawn(async move {\n',
    replacement: `                ${count('UnknownStreamPing')}\n                let server_event_tx = self.server_event_tx.clone();\n                tokio::spawn(async move {\n` },
];

// F3: log-only detection of client sequence numbers the host never received.
const inbound = [
  { file: tracker, original: '    shutdown_token: CancellationToken,\n}\n',
    replacement: '    shutdown_token: CancellationToken,\n    pub(super) gateway_inbound: gateway_inbound::GatewayInbound,\n}\n' },
  { file: tracker, original: '            shutdown_token: shutdown_token.child_token(),\n        }\n',
    replacement: '            shutdown_token: shutdown_token.child_token(),\n            gateway_inbound: Default::default(),\n        }\n' },
  { file: tracker, original: '        let client_key = (client_id.clone(), stream_id.clone());\n        match event {\n',
    replacement: '        let client_key = (client_id.clone(), stream_id.clone());\n        let gateway_fill =\n            self.gateway_observe(&client_key, &event, seq_id, is_legacy_stream_id, is_initialize);\n        match event {\n' },
  { file: tracker, original: '                if is_legacy_stream_id {\n                    self.legacy_stream_ids.insert(client_id.clone(), stream_id);\n                }\n',
    replacement: '                if !is_legacy_stream_id {\n                    self.gateway_inbound.start(&client_key, connection_id, seq_id);\n                }\n                if is_legacy_stream_id {\n                    self.legacy_stream_ids.insert(client_id.clone(), stream_id);\n                }\n' },
  { file: tracker, original: '        let now = Instant::now();\n        let expired_client_ids',
    replacement: '        let now = Instant::now();\n        self.gateway_evaluate_all(now);\n        let expired_client_ids' },
  { file: tracker, original: '        client.stream_end.mark_tracker_close();\n',
    replacement: '        client.stream_end.mark_tracker_close();\n        self.gateway_inbound.forget(client_key);\n' },
  { file: websocket, original: '                ClientSegmentObservation::Pending | ClientSegmentObservation::Dropped => continue,\n',
    replacement: '                ClientSegmentObservation::Pending => {\n                    client_tracker.gateway_chunk_pending(client_message_key.as_ref());\n                    continue;\n                }\n                ClientSegmentObservation::Dropped => continue,\n' },
];

export const sdkPatches = [...existing, ...testCompatibility, ...modules, ...streamEnd, ...observability, ...inbound];

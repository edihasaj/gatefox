//! Fixed labels for the pinned SDK's remote-control log messages (Codex 740e5af; the transport crate
//! of 4ebc485, rust-v0.163.0-alpha.10.2, is byte-identical, so every label still matches).
//! The message text is matched by prefix and never printed. After an SDK bump, unmatched
//! warnings print as `unlisted` with their callsite only: readability is lost, safety is not.

/// (message prefix, label). The longest matching prefix wins.
pub const LABELS: &[(&str, &str)] = &[
    // websocket.rs
    ("dropping oversized segmented remote-control client envelope", "rc_client_envelope_oversized"),
    ("remote control websocket status changed", "rc_status_changed"),
    ("remote control websocket environment changed", "rc_environment_changed"),
    ("app-server remote control websocket loop started", "rc_loop_started"),
    ("app-server remote control websocket loop stopped before client name was ready", "rc_loop_stopped_before_client_name"),
    ("starting app-server remote control websocket connection cycle", "rc_cycle_starting"),
    ("app-server remote control websocket connection cycle ended", "rc_cycle_ended"),
    ("app-server remote control websocket loop exited", "rc_loop_exited"),
    ("remote control preference cannot be resolved because the URL is invalid", "rc_preference_url_invalid"),
    ("waiting to resolve remote control preference until authentication is available", "rc_preference_waiting_for_auth"),
    ("failed to resolve persisted remote control preference; retrying", "rc_preference_resolve_failed"),
    ("remote control is enabled but the URL is invalid", "rc_enabled_url_invalid"),
    ("connecting to app-server remote control websocket", "rc_connecting"),
    ("connected to app-server remote control websocket", "rc_connected"),
    ("failed to connect to app-server remote control websocket", "rc_connect_failed"),
    ("retrying app-server remote control websocket after auth changed", "rc_retry_after_auth_change"),
    ("timed out waiting for remote control connection workers to stop; aborting", "rc_workers_stop_timeout"),
    ("remote control websocket writer disconnected", "rc_writer_disconnected"),
    ("remote control websocket writer was stopped", "rc_writer_stopped"),
    ("failed to serialize remote-control server event", "rc_server_event_serialize_failed"),
    ("failed to split remote-control server event", "rc_server_event_split_failed"),
    ("remote control websocket reader disconnected", "rc_reader_disconnected"),
    ("remote control websocket reader was stopped", "rc_reader_stopped"),
    ("failed to deserialize remote-control client event", "rc_client_event_invalid"),
    ("dropping unsupported binary remote-control websocket message", "rc_binary_message_dropped"),
    ("remote control websocket returned HTTP 404; replacing stale enrollment", "rc_websocket_404_stale_enrollment"),
    ("remote control websocket returned unrecognized HTTP 404", "rc_websocket_404_unrecognized"),
    ("refreshing remote control server token", "rc_token_refresh"),
    ("remote control server refresh returned HTTP 404; replacing stale enrollment", "rc_refresh_404_stale_enrollment"),
    ("creating new remote control enrollment", "rc_enrollment_creating"),
    ("created new remote control enrollment", "rc_enrollment_created"),
    // client_tracker.rs
    ("remote control transport event receiver dropped", "rc_transport_event_receiver_dropped"),
    ("timed out forwarding remote control transport event", "rc_transport_event_timeout"),
    ("remote control transport event forwarding task failed", "rc_transport_event_task_failed"),
    ("forwarding remote control connection closed transport event", "rc_connection_closed_forwarding"),
    // controller.rs
    ("remote control websocket task panicked", "rc_websocket_task_panicked"),
    // enroll.rs
    ("failed to load persisted remote control enrollment", "rc_enrollment_load_failed"),
    ("reusing persisted remote control enrollment", "rc_enrollment_reused"),
    ("no persisted remote control enrollment found", "rc_enrollment_missing"),
    ("persisted remote control enrollment", "rc_enrollment_persisted"),
    ("cleared persisted remote control enrollment", "rc_enrollment_cleared"),
    // server_api.rs
    ("remote control server token refresh failed; deferring new requests", "rc_token_refresh_failed"),
    ("proactive remote control server token refresh failed", "rc_token_refresh_failed_proactive"),
    // auth.rs
    ("remote control auth recovery succeeded", "rc_auth_recovery_succeeded"),
    ("remote control auth recovery failed", "rc_auth_recovery_failed"),
    // segment.rs
    ("dropping segmented remote-control client envelope without seq_id", "rc_segment_without_seq"),
    ("dropping segmented remote-control client envelope without stream_id", "rc_segment_without_stream"),
    ("dropping invalid segmented remote-control client envelope", "rc_segment_invalid"),
    ("resetting segmented remote-control client envelope after stream change", "rc_segment_reset_stream_change"),
    ("dropping segmented remote-control client envelope without assembly", "rc_segment_without_assembly"),
    ("resetting segmented remote-control client envelope after metadata mismatch", "rc_segment_reset_metadata"),
    ("dropping out-of-order segmented remote-control client envelope", "rc_segment_out_of_order"),
    ("dropping reassembled remote-control client envelope with mismatched size", "rc_segment_size_mismatch"),
    ("dropping invalid reassembled remote-control client envelope", "rc_segment_reassembled_invalid"),
    ("dropping segmented remote-control client envelope after size overflow", "rc_segment_size_overflow"),
    ("dropping segmented remote-control client envelope with invalid base64", "rc_segment_invalid_base64"),
    ("dropping remote-control server envelope that exceeds reassembled size limit", "rc_server_envelope_too_large"),
    ("dropping remote-control server envelope that cannot fit within segment size limit", "rc_server_envelope_unsegmentable"),
    // mod.rs
    ("remote control cannot be enabled because sqlite state db is unavailable", "rc_state_db_unavailable"),
    ("remote control enable requested", "rc_enable_requested"),
    ("remote control disable requested", "rc_disable_requested"),
    ("remote control handle status changed", "rc_handle_status_changed"),
];

/// INFO lines that are printed: connection lifecycle only. Other INFO lines carry URLs,
/// account, server or environment identifiers in their text and stay silent.
pub const LIFECYCLE: &[&str] = &[
    "rc_loop_started",
    "rc_cycle_starting",
    "rc_connecting",
    "rc_connected",
    "rc_cycle_ended",
    "rc_status_changed",
    "rc_retry_after_auth_change",
    "rc_loop_exited",
    "rc_token_refresh",
    "rc_websocket_404_stale_enrollment",
    "rc_refresh_404_stale_enrollment",
];

/// Structured SDK fields that may be printed (after sanitizing). Everything else, including
/// URLs, headers, bodies and account, server, environment or installation ids, is dropped.
/// `error` is never kept as text: the collector classifies it and pushes the two names below,
/// which reach the record as `errorClass` and `httpStatus`.
pub const FIELDS: &[&str] = &[
    "reconnect_attempt",
    "reconnect_delay",
    "current_status",
    "previous_status",
    "next_status",
    "connection_end_reason",
    "desired_state",
    "initial_desired_state",
    "error_kind",
    "transport_event",
    "timeout",
    "shutdown_timeout",
    "remaining_workers",
    "subscribe_cursor_present",
    "has_enrollment",
    "shutdown_requested",
    "refresh_delay",
    "response_status",
    "connection_id",
    "error_class",
    "http_status",
];

/// Identifier fields that are printed only as per-process hashes.
pub const HASHED: &[&str] = &["client_id", "stream_id"];

pub fn label_for(message: &str) -> Option<&'static str> {
    LABELS
        .iter()
        .filter(|(prefix, _)| message.starts_with(prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, label)| *label)
}

use crate::{SessionEntry, cancel_queue_error, relay_counters};
use codex_app_server_transport::ConnectionId;
use serde_json::Value;
use std::{collections::HashMap, sync::atomic::Ordering};

/// Hands a client request to its relay session, or counts it when no session exists.
pub fn deliver(
    sessions: &HashMap<ConnectionId, SessionEntry>,
    connection_id: ConnectionId,
    message: Value,
) {
    match sessions.get(&connection_id) {
        Some(session) => cancel_queue_error(
            connection_id,
            "session_queue_failed",
            session.writer.try_send(message),
            &session.stop,
        ),
        None => {
            relay_counters::NO_SESSION_DROPS.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// The interactive notice for a new remote client. A daemon writes nothing to stdout, which
/// shares its log file with the stderr records.
pub fn connected_notice(daemon: bool) -> Option<&'static [u8]> {
    (!daemon).then_some(b"{\"event\":\"remote-client-connected\"}\n")
}

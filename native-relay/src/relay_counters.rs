use crate::diagnostics;
use codex_app_server_transport::gateway_counters;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

/// Client requests for a connection with no relay session (the SDK delivered, nobody listened).
pub static NO_SESSION_DROPS: AtomicU64 = AtomicU64::new(0);
/// Remote streams refused with an unknown pong while the relay was shutting down.
pub static SHUTDOWN_REFUSED_STREAMS: AtomicU64 = AtomicU64::new(0);

/// Process-wide transport counters: the patched SDK's plus the relay's own. Counts only.
pub fn transport_json() -> Value {
    let mut value =
        serde_json::to_value(gateway_counters::snapshot()).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "noSessionDrops".into(),
            json!(NO_SESSION_DROPS.load(Ordering::Relaxed)),
        );
        object.insert(
            "shutdownRefusedStreams".into(),
            json!(SHUTDOWN_REFUSED_STREAMS.load(Ordering::Relaxed)),
        );
        object.insert(
            "inboundGapResetMode".into(),
            json!(gateway_counters::inbound_reset_enabled()),
        );
    }
    value
}

/// A `transport_activity` record when the counters changed since the last one, so quiet
/// periods without sessions still show transport changes.
pub fn activity_record(last: &mut Value) -> Option<Value> {
    let transport = transport_json();
    if &transport == last {
        return None;
    }
    *last = transport.clone();
    Some(json!({"scope":"native_relay", "timestampMs":diagnostics::now_ms(),
        "event":"transport_activity", "transport":transport}))
}

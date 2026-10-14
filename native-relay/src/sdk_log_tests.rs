use crate::sdk_log::{RateLimiter, SdkLogLayer, sanitize};
use codex_app_server_transport::gateway_counters::hash_id;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tracing_subscriber::layer::SubscriberExt;

fn capture(events: impl FnOnce()) -> Vec<Value> {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let layer = SdkLogLayer::new(Arc::new(move |record| sink.lock().unwrap().push(record)));
    tracing::subscriber::with_default(tracing_subscriber::registry().with(layer), events);
    let lines = lines.lock().unwrap().clone();
    lines
}

#[test]
fn never_prints_message_text_or_raw_ids() {
    let lines = capture(|| {
        tracing::warn!(
            target: "codex_app_server_transport::transport::remote_control::websocket",
            client_id = "raw-client-id",
            error = "Bearer secret",
            "failed to deserialize remote-control client event: invalid type: string \"prompt text\""
        );
    });
    assert_eq!(lines.len(), 1);
    let line = &lines[0];
    assert_eq!(line["label"], "rc_client_event_invalid");
    assert_eq!(line["level"], "warn");
    assert_eq!(line["scope"], "native_relay_sdk");
    assert_eq!(line["clientId"], Value::from(hash_id("raw-client-id")));
    let text = line.to_string();
    for private in ["raw-client-id", "secret", "Bearer", "prompt text", "deserialize"] {
        assert!(!text.contains(private), "{private} leaked into {text}");
    }
}

#[test]
fn info_lifecycle_allowlist() {
    let lines = capture(|| {
        tracing::info!(
            target: "codex_app_server_transport::transport::remote_control::websocket",
            websocket_url = %"wss://chatgpt.com/backend-api/private",
            installation_id = %"11111111-1111-4111-8111-111111111111",
            server_id = ?Some("srv_private"),
            subscribe_cursor_present = true,
            response_headers = %"set-cookie: private",
            "connected to app-server remote control websocket"
        );
        tracing::info!(
            target: "codex_app_server_transport::transport::remote_control",
            installation_id = %"11111111-1111-4111-8111-111111111111",
            "remote control enable requested"
        );
        tracing::warn!(target: "codex_core::client", "private core warning");
        tracing::info!(
            target: "codex_app_server_transport::transport::remote_control::enroll",
            "reusing persisted remote control enrollment: websocket_url=wss://private, account_id=acct"
        );
    });
    assert_eq!(lines.len(), 1, "{lines:?}");
    let line = lines[0].as_object().unwrap();
    assert_eq!(line["label"], "rc_connected");
    assert_eq!(line["subscribeCursorPresent"], true);
    let mut keys: Vec<_> = line.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["event", "label", "level", "scope", "subscribeCursorPresent", "timestampMs"]
    );
    assert!(!lines[0].to_string().contains("private"));
}

#[test]
fn unlisted_warnings_print_only_their_callsite_and_safe_fields() {
    let lines = capture(|| {
        tracing::warn!(
            target: "codex_app_server_transport::transport::remote_control::websocket",
            error_kind = ?std::io::ErrorKind::TimedOut,
            reconnect_delay = ?Duration::from_millis(1500),
            desired_state = %"a value with / slashes and a token",
            "a future SDK warning about account acct_private"
        );
    });
    assert_eq!(lines.len(), 1);
    let line = &lines[0];
    assert_eq!(line["label"], "unlisted");
    assert!(line["callsite"].as_str().unwrap().starts_with("sdk_log_tests.rs:"));
    assert_eq!(line["errorKind"], "TimedOut");
    assert_eq!(line["reconnectDelay"], "1.5s");
    assert_eq!(line["desiredState"], "redacted");
    assert!(!line.to_string().contains("acct_private"));
}

#[test]
fn gateway_events_keep_their_hashed_fields() {
    let lines = capture(|| {
        tracing::info!(
            target: "gateway_remote_control",
            gateway_event = "stream_end_notified",
            connection = 4_u64,
            client = %"0123456789ab",
            reason = "cancelled",
            drain_dropped = 0_u64,
        );
    });
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["label"], "stream_end_notified");
    assert_eq!(lines[0]["connection"], 4);
    assert_eq!(lines[0]["client"], "0123456789ab");
    assert_eq!(lines[0]["drainDropped"], 0);
}

#[test]
fn rate_limit_reports_suppressed() {
    let mut limiter = RateLimiter::default();
    let start = Instant::now();
    for _ in 0..20 {
        assert_eq!(limiter.admit("rc_reader_disconnected", start), Some(0));
    }
    for _ in 0..5 {
        assert_eq!(limiter.admit("rc_reader_disconnected", start), None);
    }
    assert_eq!(limiter.admit("rc_writer_disconnected", start), Some(0));
    assert_eq!(
        limiter.admit("rc_reader_disconnected", start + Duration::from_secs(60)),
        Some(5)
    );
    let lines = capture(|| {
        for _ in 0..25 {
            tracing::warn!(
                target: "codex_app_server_transport::transport::remote_control::websocket",
                "remote control websocket reader was stopped"
            );
        }
    });
    assert_eq!(lines.len(), 20);
}

#[test]
fn sanitizer_keeps_only_short_plain_values() {
    assert_eq!(sanitize("Enabled { persistence_preference: Some(true) }"), "Enabled { persistence_preference: Some(true) }");
    assert_eq!(sanitize("404 Not Found"), "404 Not Found");
    assert_eq!(sanitize("wss://host/path"), "redacted");
    assert_eq!(sanitize("\"quoted\""), "redacted");
    assert_eq!(sanitize(&"a".repeat(81)), "redacted");
}

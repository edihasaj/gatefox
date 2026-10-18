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

/// The websocket target logs connect failures; only the class markers in `error` are kept.
const ERROR_TARGET: &str = "codex_app_server_transport::transport::remote_control::websocket";
const PRIVATE: &[&str] = &[
    "wss://",
    "https://",
    "chatgpt.com",
    "request-id",
    "cf-ray",
    "Bearer",
    "req_9f3a",
    "srv_1a2b",
    "env_3c4d",
];

/// One SDK warning whose `error` field is a Display value (the shape the SDK logs),
/// with the leak checks every class must pass.
fn error_line(error: &str) -> Value {
    let lines = capture(|| {
        tracing::warn!(
            target: ERROR_TARGET,
            error = %error,
            "failed to connect to app-server remote control websocket"
        );
    });
    assert_eq!(lines.len(), 1, "{lines:?}");
    let line = lines[0].clone();
    assert_eq!(line["label"], "rc_connect_failed");
    assert!(line.get("error").is_none(), "the raw error field was kept: {line}");
    for private in PRIVATE {
        assert!(!line.to_string().contains(private), "{private} leaked into {line}");
    }
    line
}

fn class(line: &Value, expected: &str) {
    assert_eq!(line["errorClass"], expected, "{line}");
}

#[test]
fn classifies_websocket_http_error_with_its_status() {
    let line = error_line(
        "failed to connect app-server remote control websocket `wss://chatgpt.com/backend-api/wham/remote/control/server`: HTTP error: 409 Conflict, request-id: req_9f3a, cf-ray: srv_1a2b",
    );
    class(&line, "ws_http");
    assert_eq!(line["httpStatus"], 409);
}

#[test]
fn classifies_websocket_auth_failure_as_a_string_field() {
    let lines = capture(|| {
        tracing::warn!(
            target: ERROR_TARGET,
            error = "remote control websocket auth failed with HTTP 401 Unauthorized; refreshing server token before reconnect, request-id: req_9f3a",
            "failed to connect to app-server remote control websocket"
        );
    });
    assert_eq!(lines.len(), 1, "{lines:?}");
    let line = lines[0].clone();
    class(&line, "ws_auth");
    assert_eq!(line["httpStatus"], 401);
    for private in PRIVATE {
        assert!(!line.to_string().contains(private), "{private} leaked into {line}");
    }
}

#[test]
fn classifies_websocket_tls_failure() {
    let line = error_line(
        "failed to connect app-server remote control websocket `wss://chatgpt.com/backend-api/wham/remote/control/server`: TLS error: invalid peer certificate: Expired, request-id: req_9f3a",
    );
    class(&line, "ws_tls");
    assert!(line.get("httpStatus").is_none(), "{line}");
}

#[test]
fn classifies_websocket_io_failure() {
    let line = error_line(
        "failed to connect app-server remote control websocket `wss://chatgpt.com/backend-api/wham`: IO error: Connection reset by peer (os error 54), cf-ray: srv_1a2b",
    );
    class(&line, "ws_io");
}

#[test]
fn classifies_websocket_dns_failure_before_the_io_class() {
    let line = error_line(
        "failed to connect app-server remote control websocket `wss://chatgpt.com/backend-api/wham`: IO error: dns error: failed to lookup address information: nodename nor servname provided",
    );
    class(&line, "ws_dns");
}

#[test]
fn classifies_websocket_protocol_failure() {
    let line = error_line(
        "failed to connect app-server remote control websocket `wss://chatgpt.com/backend-api/wham`: WebSocket protocol error: HandshakeNotFinished, request-id: req_9f3a",
    );
    class(&line, "ws_protocol");
}

#[test]
fn classifies_server_refresh_http_failure_before_auth_recovery() {
    let line = error_line(
        "remote control server refresh failed at `https://chatgpt.com/backend-api/wham/remote/control/server/refresh`: HTTP 429 Too Many Requests, request-id: req_9f3a, cf-ray: srv_1a2b, body: slow down; retrying after auth recovery",
    );
    class(&line, "refresh_http");
    assert_eq!(line["httpStatus"], 429);
}

#[test]
fn classifies_server_refresh_transport_failure() {
    let line = error_line(
        "failed to refresh remote control server at `https://chatgpt.com/backend-api/wham/remote/control/server/refresh`: error sending request for url, request-id: req_9f3a",
    );
    class(&line, "refresh_transport");
}

#[test]
fn classifies_server_refresh_parse_failure() {
    let line = error_line(
        "failed to parse remote control server refresh response from `https://chatgpt.com/backend-api/wham`: HTTP 200 OK, request-id: req_9f3a, body: {\"ok\": true}, decode error: missing field `server_id` at line 1 column 9",
    );
    class(&line, "refresh_parse");
    assert!(line.get("httpStatus").is_none(), "a parse failure keeps no status: {line}");
}

#[test]
fn classifies_mismatched_refresh_enrollment() {
    let line = error_line(
        "remote control server refresh returned mismatched enrollment: expected server_id=srv_1a2b, environment_id=env_3c4d; got server_id=srv_9z8y, environment_id=env_7x6w",
    );
    class(&line, "refresh_mismatch");
}

#[test]
fn classifies_auth_recovery_retry() {
    let line = error_line(
        "remote control server enrollment failed at `https://chatgpt.com/backend-api/wham/enroll`: HTTP 401 Unauthorized, request-id: req_9f3a; retrying after auth recovery",
    );
    class(&line, "auth_recovery");
    assert!(line.get("httpStatus").is_none(), "{line}");
}

#[test]
fn classifies_an_unrecognized_failure_as_unclassified() {
    let line = error_line("authorizer rejected Bearer req_9f3a for wss://chatgpt.com/backend-api");
    class(&line, "unclassified");
    assert!(line.get("httpStatus").is_none(), "{line}");
}

#[test]
fn keeps_no_status_unless_exactly_three_usable_digits_are_named() {
    let connect = "failed to connect app-server remote control websocket `{}`: HTTP error: {status} Conflict, request-id: req_9f3a";
    for (status, kept) in [("4017", None), ("99", None), ("600", None), ("409", Some(409_u64))] {
        let line = error_line(&connect.replace("{}", "wss://chatgpt.com/backend-api/wham").replace("{status}", status));
        class(&line, "ws_http");
        assert_eq!(line.get("httpStatus").and_then(Value::as_u64), kept, "{status} -> {line}");
    }
}

#[test]
fn an_over_long_error_is_classified_without_its_text() {
    // The class marker is read from the kept prefix; the 4 KiB of body after it is never printed.
    let body = format!("Bearer srv_1a2b {}", "wss://chatgpt.com/".repeat(200));
    let line = error_line(&format!(
        "failed to connect app-server remote control websocket `wss://chatgpt.com/backend-api/wham`: HTTP error: 503 Service Unavailable, request-id: req_9f3a, body: {body}"
    ));
    class(&line, "ws_http");
    assert_eq!(line["httpStatus"], 503);
}

#[test]
fn a_gateway_error_field_keeps_the_sanitizer_and_no_class() {
    let lines = capture(|| {
        tracing::info!(
            target: "gateway_remote_control",
            gateway_event = "stream_end_notified",
            error = "connection closed cleanly",
        );
    });
    assert_eq!(lines.len(), 1);
    let line = lines[0].clone();
    assert_eq!(line["error"], "connection closed cleanly");
    assert!(line.get("errorClass").is_none(), "{line}");
}

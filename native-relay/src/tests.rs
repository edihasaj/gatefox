use crate::{
    control::network_guard,
    frames::{FrameReader, MAX_FRAME},
};
use serde_json::json;
use tokio::io::{AsyncWriteExt, BufReader};

#[tokio::test]
async fn fragmented_frames_survive_cancelled_reads() {
    let (mut write, read) = tokio::io::duplex(128);
    let mut frames = FrameReader::new(BufReader::new(read));
    write.write_all(b"{\"id\":").await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), frames.next())
            .await
            .is_err()
    );
    write.write_all(b"7}\n{\"id\":8}\n").await.unwrap();
    assert_eq!(frames.next().await.unwrap().unwrap(), b"{\"id\":7}");
    assert_eq!(frames.next().await.unwrap().unwrap(), b"{\"id\":8}");
}

#[tokio::test]
async fn truncated_and_oversized_frames_fail() {
    let mut frames = FrameReader::new(BufReader::new(&b"{\"id\":1}"[..]));
    assert!(frames.next().await.is_err());
    let bytes = vec![b'x'; MAX_FRAME + 1];
    let mut frames = FrameReader::new(BufReader::new(bytes.as_slice()));
    assert!(frames.next().await.is_err());
}

#[test]
fn remote_clients_cannot_use_host_biometric_operations() {
    for method in [
        "userVerification/enroll",
        "userVerification/delete",
        "userVerification/verify",
    ] {
        let response =
            network_guard(&json!({"id":"opaque-id","method":method,"params":{}})).unwrap();
        assert_eq!(response["id"], "opaque-id");
        assert_eq!(response["error"]["data"]["type"], "unavailable");
    }
    assert!(network_guard(&json!({"id":1,"method":"userVerification/status"})).is_none());
    assert!(network_guard(&json!({"id":1,"method":"turn/steer"})).is_none());
}

#[test]
fn raw_envelopes_preserve_future_fields_and_request_ids() {
    let expected = json!({"id":"opaque-id","result":{"future_field":[1,2,3]}});
    let actual = serde_json::to_value(codex_app_server_transport::OutgoingMessage::Passthrough(
        expected.clone(),
    ))
    .unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn daemon_mode_never_prints_client_connected() {
    assert_eq!(crate::routing::connected_notice(true), None);
    assert_eq!(
        crate::routing::connected_notice(false),
        Some(&b"{\"event\":\"remote-client-connected\"}\n"[..])
    );
}

#[tokio::test]
async fn incoming_without_session_is_counted() {
    use std::sync::atomic::Ordering;
    let before = crate::relay_counters::NO_SESSION_DROPS.load(Ordering::Relaxed);
    crate::routing::deliver(
        &std::collections::HashMap::new(),
        codex_app_server_transport::ConnectionId(41),
        json!({"id": 1, "method": "thread/list"}),
    );
    assert!(crate::relay_counters::NO_SESSION_DROPS.load(Ordering::Relaxed) > before);
}

#[test]
fn chat_requests_reach_the_gateway_router_not_the_relay() {
    use crate::control::answers;
    // The phone's chat list, models and turns are the router's: the relay never answers them.
    for method in [
        "thread/list",
        "model/list",
        "thread/start",
        "thread/resume",
        "turn/start",
        "initialize",
        "remoteControl/status/changed",
    ] {
        assert!(!answers(method), "{method} must reach the gateway router");
        assert!(network_guard(&json!({"id": 1, "method": method})).is_none());
    }
    for method in [
        "remoteControl/status/read",
        "remoteControl/enable",
        "remoteControl/disable",
        "remoteControl/pairing/start",
        "remoteControl/pairing/status",
        "remoteControl/clients/list",
        "remoteControl/clients/revoke",
    ] {
        assert!(answers(method), "{method} is the relay's own");
    }
}

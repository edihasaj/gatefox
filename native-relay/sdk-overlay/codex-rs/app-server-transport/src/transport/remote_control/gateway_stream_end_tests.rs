//! Gateway: app-side stream ends send `Pong { Unknown }`; tracker-side ends do not.

use super::CHANNEL_CAPACITY;
use super::QueuedServerEnvelope;
use super::TransportEvent;
use super::client_tracker::ClientTracker;
use super::protocol::ClientEnvelope;
use super::protocol::ClientEvent;
use super::protocol::ClientId;
use super::protocol::PongStatus;
use super::protocol::ServerEvent;
use super::protocol::StreamId;
use crate::gateway_counters;
use crate::gateway_counters::Counter;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::OutgoingMessage;
use crate::outgoing_message::QueuedOutgoingMessage;
use codex_app_server_protocol::JSONRPCMessage;
use codex_app_server_protocol::JSONRPCNotification;
use codex_app_server_protocol::JSONRPCRequest;
use codex_app_server_protocol::RequestId;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::Duration;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

pub(super) struct Harness {
    pub(super) tracker: ClientTracker,
    pub(super) server_rx: mpsc::Receiver<QueuedServerEnvelope>,
    pub(super) transport_rx: mpsc::Receiver<TransportEvent>,
    pub(super) server_tx: mpsc::Sender<QueuedServerEnvelope>,
    pub(super) shutdown: CancellationToken,
}

pub(super) fn harness(server_capacity: usize, transport_capacity: usize) -> Harness {
    let (server_tx, server_rx) = mpsc::channel(server_capacity);
    let (transport_tx, transport_rx) = mpsc::channel(transport_capacity);
    let shutdown = CancellationToken::new();
    let tracker = ClientTracker::new(server_tx.clone(), transport_tx, &shutdown);
    Harness {
        tracker,
        server_rx,
        transport_rx,
        server_tx,
        shutdown,
    }
}

pub(super) fn envelope(event: ClientEvent, stream: &str, seq_id: Option<u64>) -> ClientEnvelope {
    ClientEnvelope {
        event,
        client_id: ClientId("client-1".to_string()),
        stream_id: Some(StreamId(stream.to_string())),
        seq_id,
        cursor: None,
    }
}

pub(super) fn initialize(stream: &str, seq_id: u64) -> ClientEnvelope {
    let message = JSONRPCMessage::Request(JSONRPCRequest {
        id: RequestId::Integer(1),
        method: "initialize".to_string(),
        params: Some(json!({"clientInfo": {"name": "remote-test-client", "version": "0.1.0"}})),
        trace: None,
    });
    envelope(ClientEvent::ClientMessage { message }, stream, Some(seq_id))
}

pub(super) fn request(stream: &str, seq_id: u64) -> ClientEnvelope {
    let message = JSONRPCMessage::Notification(JSONRPCNotification {
        method: format!("gateway/test/{seq_id}"),
        params: None,
    });
    envelope(ClientEvent::ClientMessage { message }, stream, Some(seq_id))
}

pub(super) struct Opened {
    pub(super) connection_id: ConnectionId,
    pub(super) writer: mpsc::Sender<QueuedOutgoingMessage>,
    pub(super) disconnect: CancellationToken,
}

pub(super) async fn open(harness: &mut Harness, stream: &str, seq_id: u64) -> Opened {
    harness
        .tracker
        .handle_message(initialize(stream, seq_id))
        .await
        .expect("initialize should open the stream");
    let opened = match next_transport_event(harness).await {
        TransportEvent::ConnectionOpened {
            connection_id,
            writer,
            disconnect_sender: Some(disconnect),
            ..
        } => Opened {
            connection_id,
            writer,
            disconnect,
        },
        other => panic!("expected connection opened, got {other:?}"),
    };
    match next_transport_event(harness).await {
        TransportEvent::IncomingMessage { connection_id, .. } => {
            assert_eq!(connection_id, opened.connection_id)
        }
        other => panic!("expected forwarded initialize, got {other:?}"),
    }
    opened
}

pub(super) async fn next_transport_event(harness: &mut Harness) -> TransportEvent {
    timeout(Duration::from_secs(1), harness.transport_rx.recv())
        .await
        .expect("transport event should arrive")
        .expect("transport channel should stay open")
}

pub(super) async fn next_server_event(harness: &mut Harness) -> QueuedServerEnvelope {
    timeout(Duration::from_secs(1), harness.server_rx.recv())
        .await
        .expect("server event should arrive")
        .expect("server channel should stay open")
}

pub(super) fn is_unknown_pong(envelope: &QueuedServerEnvelope, stream: &str) -> bool {
    matches!(
        envelope.event,
        ServerEvent::Pong {
            status: PongStatus::Unknown
        }
    ) && envelope.client_id.0 == "client-1"
        && envelope.stream_id.0 == stream
}

pub(super) async fn assert_no_pong(harness: &mut Harness) {
    while let Ok(Some(envelope)) = timeout(Duration::from_millis(100), harness.server_rx.recv()).await
    {
        assert!(
            !matches!(envelope.event, ServerEvent::Pong { .. }),
            "tracker-side close must not send a pong"
        );
    }
}

/// Emulates the websocket reader: join a finished outbound task, then close its key.
pub(super) async fn bookkeep_once(harness: &mut Harness) -> Option<(ClientId, StreamId)> {
    let key = timeout(Duration::from_millis(200), harness.tracker.bookkeep_join_set())
        .await
        .ok()
        .flatten()?;
    harness
        .tracker
        .close_client(&key)
        .await
        .expect("close should forward");
    Some(key)
}

fn passthrough(index: u64) -> QueuedOutgoingMessage {
    QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(
        json!({"method": "gateway/reply", "params": {"index": index}}),
    ))
}

fn message_index(envelope: &QueuedServerEnvelope) -> Option<u64> {
    match &envelope.event {
        ServerEvent::ServerMessage { message } => match message.as_ref() {
            OutgoingMessage::Passthrough(value) => value["params"]["index"].as_u64(),
            _ => None,
        },
        _ => None,
    }
}

#[tokio::test]
async fn app_side_cancel_drains_writer_then_sends_unknown_pong() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let opened = open(&mut harness, "stream-1", 0).await;
    opened.writer.send(passthrough(1)).await.expect("queue reply 1");
    opened.writer.send(passthrough(2)).await.expect("queue reply 2");
    opened.disconnect.cancel();

    assert_eq!(message_index(&next_server_event(&mut harness).await), Some(1));
    assert_eq!(message_index(&next_server_event(&mut harness).await), Some(2));
    let pong = next_server_event(&mut harness).await;
    assert!(is_unknown_pong(&pong, "stream-1"), "expected an unknown pong");
    if let Some(write_complete_tx) = pong.write_complete_tx {
        let _ = write_complete_tx.send(());
    }

    assert!(bookkeep_once(&mut harness).await.is_some());
    match next_transport_event(&mut harness).await {
        TransportEvent::ConnectionClosed { connection_id } => {
            assert_eq!(connection_id, opened.connection_id)
        }
        other => panic!("expected connection closed, got {other:?}"),
    }
}

#[tokio::test]
async fn dropped_writer_is_an_app_side_end() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let opened = open(&mut harness, "stream-1", 0).await;
    opened.writer.send(passthrough(3)).await.expect("queue reply");
    drop(opened.writer);
    assert_eq!(message_index(&next_server_event(&mut harness).await), Some(3));
    assert!(is_unknown_pong(&next_server_event(&mut harness).await, "stream-1"));
    assert!(bookkeep_once(&mut harness).await.is_some());
}

#[tokio::test]
async fn client_closed_sends_no_unknown_pong() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let opened = open(&mut harness, "stream-1", 0).await;
    harness
        .tracker
        .handle_message(envelope(ClientEvent::ClientClosed, "stream-1", Some(1)))
        .await
        .expect("client close");
    match next_transport_event(&mut harness).await {
        TransportEvent::ConnectionClosed { connection_id } => {
            assert_eq!(connection_id, opened.connection_id)
        }
        other => panic!("expected connection closed, got {other:?}"),
    }
    bookkeep_once(&mut harness).await;
    assert_no_pong(&mut harness).await;
}

#[tokio::test(start_paused = true)]
async fn idle_sweep_sends_no_unknown_pong() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    // The relay keeps the writer for the session's life; dropping it is an app-side end.
    let _opened = open(&mut harness, "stream-1", 0).await;
    tokio::time::advance(Duration::from_secs(601)).await;
    let expired = harness
        .tracker
        .close_expired_clients()
        .await
        .expect("idle sweep");
    assert_eq!(expired.len(), 1);
    bookkeep_once(&mut harness).await;
    assert_no_pong(&mut harness).await;
}

#[tokio::test]
async fn tracker_shutdown_sends_no_unknown_pong() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let _first = open(&mut harness, "stream-1", 0).await;
    let _second = open(&mut harness, "stream-2", 0).await;
    tokio::task::yield_now().await;
    timeout(Duration::from_secs(1), harness.tracker.shutdown())
        .await
        .expect("shutdown should finish");
    assert_no_pong(&mut harness).await;
}

#[tokio::test]
async fn sdk_root_shutdown_sends_no_unknown_pong() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let _opened = open(&mut harness, "stream-1", 0).await;
    tokio::task::yield_now().await;
    harness.shutdown.cancel();
    assert!(bookkeep_once(&mut harness).await.is_some());
    assert_no_pong(&mut harness).await;
}

#[tokio::test(start_paused = true)]
async fn failed_initialize_forward_sends_no_unknown_pong() {
    let mut harness = harness(CHANNEL_CAPACITY, 1);
    let result = harness
        .tracker
        .handle_message(initialize("stream-1", 0))
        .await;
    assert!(result.is_err(), "the full transport queue must fail the initialize");
    assert!(matches!(
        next_transport_event(&mut harness).await,
        TransportEvent::ConnectionOpened { .. }
    ));
    assert!(matches!(
        next_transport_event(&mut harness).await,
        TransportEvent::ConnectionClosed { .. }
    ));
    bookkeep_once(&mut harness).await;
    assert_no_pong(&mut harness).await;
}

#[tokio::test]
async fn reinitialize_same_stream_keeps_replacement_open() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let first = open(&mut harness, "stream-1", 0).await;
    harness
        .tracker
        .handle_message(initialize("stream-1", 0))
        .await
        .expect("re-initialize");
    match next_transport_event(&mut harness).await {
        TransportEvent::ConnectionClosed { connection_id } => {
            assert_eq!(connection_id, first.connection_id)
        }
        other => panic!("expected the first stream to close, got {other:?}"),
    }
    let (second, _second_writer) = match next_transport_event(&mut harness).await {
        TransportEvent::ConnectionOpened {
            connection_id,
            writer,
            ..
        } => (connection_id, writer),
        other => panic!("expected the replacement stream, got {other:?}"),
    };
    assert!(matches!(
        next_transport_event(&mut harness).await,
        TransportEvent::IncomingMessage { .. }
    ));

    // The predecessor's join must not close its replacement.
    bookkeep_once(&mut harness).await;
    assert!(
        timeout(Duration::from_millis(100), harness.transport_rx.recv())
            .await
            .is_err(),
        "replacement {second:?} must stay open"
    );
    assert_no_pong(&mut harness).await;
    harness
        .tracker
        .handle_message(request("stream-1", 1))
        .await
        .expect("request on the replacement");
    match next_transport_event(&mut harness).await {
        TransportEvent::IncomingMessage { connection_id, .. } => assert_eq!(connection_id, second),
        other => panic!("expected delivery to the replacement, got {other:?}"),
    }
}

#[tokio::test]
async fn stream_end_is_bounded_when_server_queue_full() {
    let mut harness = harness(1, CHANNEL_CAPACITY);
    let opened = open(&mut harness, "stream-1", 0).await;
    harness
        .server_tx
        .send(QueuedServerEnvelope {
            event: ServerEvent::Pong {
                status: PongStatus::Active,
            },
            client_id: ClientId("other-client".to_string()),
            stream_id: StreamId("other-stream".to_string()),
            write_complete_tx: None,
        })
        .await
        .expect("prefill should fit");
    let before = gateway_counters::get(Counter::StreamEndPongDropped);
    opened.writer.send(passthrough(1)).await.expect("queue reply");
    opened.disconnect.cancel();
    let joined = timeout(Duration::from_secs(1), harness.tracker.bookkeep_join_set()).await;
    assert!(joined.is_ok(), "the outbound task must join while the queue stays full");
    assert!(gateway_counters::get(Counter::StreamEndPongDropped) > before);
    assert!(gateway_counters::get(Counter::StreamEndDrainDropped) >= 1);
}

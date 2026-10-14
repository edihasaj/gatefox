//! Gateway: silent SDK drops are counted without changing what is delivered.

use super::CHANNEL_CAPACITY;
use super::TransportEvent;
use super::gateway_stream_end_tests::harness;
use super::gateway_stream_end_tests::next_transport_event;
use super::gateway_stream_end_tests::open;
use super::gateway_stream_end_tests::request;
use crate::gateway_counters;
use crate::gateway_counters::Counter;
use tokio::time::Duration;
use tokio::time::timeout;

#[tokio::test]
async fn replayed_seq_is_dropped_and_counted() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let opened = open(&mut harness, "stream-1", 0).await;
    let before = gateway_counters::get(Counter::InboundSeqDedupeDrop);
    for _ in 0..2 {
        harness
            .tracker
            .handle_message(request("stream-1", 1))
            .await
            .expect("request");
    }
    match next_transport_event(&mut harness).await {
        TransportEvent::IncomingMessage { connection_id, .. } => {
            assert_eq!(connection_id, opened.connection_id)
        }
        other => panic!("expected one delivery, got {other:?}"),
    }
    assert!(
        timeout(Duration::from_millis(100), harness.transport_rx.recv())
            .await
            .is_err(),
        "the replay must still be dropped"
    );
    assert!(gateway_counters::get(Counter::InboundSeqDedupeDrop) > before);
}

#[tokio::test]
async fn unknown_stream_message_is_counted() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let before = gateway_counters::get(Counter::UnknownStreamDrop);
    harness
        .tracker
        .handle_message(request("never-opened", 4))
        .await
        .expect("unknown stream message");
    assert!(
        timeout(Duration::from_millis(100), harness.transport_rx.recv())
            .await
            .is_err()
    );
    assert!(gateway_counters::get(Counter::UnknownStreamDrop) > before);
}

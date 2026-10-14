//! Gateway: inbound sequence holes are logged; the reset switch alone ends a stream.

use super::CHANNEL_CAPACITY;
use super::TransportEvent;
use super::gateway_inbound::Action;
use super::gateway_inbound::Envelope;
use super::gateway_inbound::Fill;
use super::gateway_inbound::GatewayInbound;
use super::gateway_stream_end_tests::assert_no_pong;
use super::gateway_stream_end_tests::bookkeep_once;
use super::gateway_stream_end_tests::envelope;
use super::gateway_stream_end_tests::harness;
use super::gateway_stream_end_tests::is_unknown_pong;
use super::gateway_stream_end_tests::next_server_event;
use super::gateway_stream_end_tests::next_transport_event;
use super::gateway_stream_end_tests::open;
use super::gateway_stream_end_tests::request;
use super::protocol::ClientEvent;
use super::protocol::ClientId;
use super::protocol::StreamId;
use crate::gateway_counters;
use crate::gateway_counters::Counter;
use crate::outgoing_message::ConnectionId;
use tokio::time::Duration;
use tokio::time::Instant;
use tokio::time::timeout;

fn key() -> (ClientId, StreamId) {
    (
        ClientId("client-1".to_string()),
        StreamId("stream-1".to_string()),
    )
}

fn tracked() -> GatewayInbound {
    let mut inbound = GatewayInbound::default();
    inbound.start(&key(), ConnectionId(1), Some(0));
    inbound
}

fn secs(value: u64) -> Duration {
    Duration::from_secs(value)
}

#[test]
fn contiguous_messages_pings_and_close_leave_no_hole() {
    let mut inbound = tracked();
    let t0 = Instant::now();
    for (envelope, seq) in [
        (Envelope::Message, 1),
        (Envelope::Ping, 2),
        (Envelope::Message, 3),
        (Envelope::Closed, 4),
    ] {
        assert_eq!(
            inbound.observe(&key(), envelope, Some(seq), t0),
            Fill::Advanced
        );
    }
    assert!(inbound.holes(&key()).is_empty());
    assert_eq!(inbound.evaluate(&key(), t0 + secs(60)), None);
    assert_eq!(inbound.pings(&key()), (1, 0));
}

#[test]
fn missing_seq_turns_stale_after_15s() {
    let mut inbound = tracked();
    let t0 = Instant::now();
    inbound.observe(&key(), Envelope::Message, Some(1), t0);
    inbound.observe(&key(), Envelope::Message, Some(3), t0);
    assert_eq!(inbound.holes(&key()), vec![(2, 2, false)]);
    assert_eq!(inbound.evaluate(&key(), t0 + secs(14)), None);
    assert_eq!(
        inbound.evaluate(&key(), t0 + secs(15)),
        Some(Action::LogOnly)
    );
    assert_eq!(inbound.holes(&key()), vec![(2, 2, true)]);
    assert_eq!(inbound.evaluate(&key(), t0 + secs(30)), None, "reported once");
}

#[test]
fn chunk_assembly_defers_staleness() {
    let mut inbound = tracked();
    let t0 = Instant::now();
    inbound.observe(&key(), Envelope::Message, Some(1), t0);
    inbound.observe(&key(), Envelope::Ping, Some(3), t0);
    inbound.chunk_pending(&key(), 2, t0 + secs(10));
    assert_eq!(inbound.evaluate(&key(), t0 + secs(16)), None);
    assert_eq!(inbound.evaluate(&key(), t0 + secs(24)), None);
    assert_eq!(
        inbound.evaluate(&key(), t0 + secs(25)),
        Some(Action::LogOnly),
        "15 s without a chunk ends the deferral"
    );
    let mut completed = tracked();
    completed.observe(&key(), Envelope::Message, Some(1), t0);
    completed.observe(&key(), Envelope::Ping, Some(3), t0);
    completed.chunk_pending(&key(), 2, t0 + secs(1));
    assert_eq!(
        completed.observe(&key(), Envelope::Message, Some(2), t0 + secs(2)),
        Fill::FilledHole { stale: false }
    );
    assert!(completed.holes(&key()).is_empty());
}

#[test]
fn pings_without_seq_are_counted_not_filled() {
    let mut inbound = tracked();
    let t0 = Instant::now();
    let before = gateway_counters::get(Counter::PingWithoutSeq);
    assert_eq!(inbound.observe(&key(), Envelope::Ping, None, t0), Fill::NoSeq);
    assert_eq!(inbound.observe(&key(), Envelope::Ping, None, t0), Fill::NoSeq);
    assert_eq!(inbound.pings(&key()), (0, 2));
    assert!(gateway_counters::get(Counter::PingWithoutSeq) >= before + 2);
    inbound.observe(&key(), Envelope::Message, Some(2), t0);
    assert_eq!(inbound.holes(&key()), vec![(1, 1, false)]);
    assert_eq!(
        inbound.evaluate(&key(), t0 + secs(15)),
        Some(Action::LogOnly)
    );
}

#[test]
fn late_fill_after_stale_is_reported() {
    let mut inbound = tracked();
    let t0 = Instant::now();
    inbound.observe(&key(), Envelope::Message, Some(10), t0);
    inbound.evaluate(&key(), t0 + secs(15));
    let before = gateway_counters::get(Counter::HoleFilledAfterStale);
    assert_eq!(
        inbound.observe(&key(), Envelope::Message, Some(5), t0 + secs(20)),
        Fill::FilledHole { stale: true }
    );
    assert!(gateway_counters::get(Counter::HoleFilledAfterStale) > before);
    assert_eq!(inbound.holes(&key()), vec![(1, 4, true), (6, 9, true)]);
    inbound.observe(&key(), Envelope::Message, Some(1), t0 + secs(21));
    inbound.observe(&key(), Envelope::Message, Some(9), t0 + secs(21));
    assert_eq!(inbound.holes(&key()), vec![(2, 4, true), (6, 8, true)]);
    assert_eq!(
        inbound.observe(&key(), Envelope::Message, Some(1), t0 + secs(22)),
        Fill::Duplicate
    );
    let unresolved = gateway_counters::get(Counter::HoleUnresolvedAtClose);
    inbound.forget(&key());
    assert!(gateway_counters::get(Counter::HoleUnresolvedAtClose) >= unresolved + 2);
}

#[test]
fn reset_switch_allows_one_reset_per_stream_per_10_minutes() {
    let directory = tempfile::TempDir::new().expect("temp dir");
    let switch = directory.path().join("inbound-gap-reset");
    let mut inbound = tracked();
    inbound.reset_switch = Some(switch.clone());
    let t0 = Instant::now();
    inbound.observe(&key(), Envelope::Message, Some(2), t0);
    assert_eq!(
        inbound.evaluate(&key(), t0 + secs(15)),
        Some(Action::LogOnly),
        "no switch file: log only"
    );
    std::fs::write(&switch, b"").expect("switch on");
    inbound.observe(&key(), Envelope::Message, Some(4), t0 + secs(16));
    assert_eq!(inbound.evaluate(&key(), t0 + secs(31)), Some(Action::Reset));
    inbound.observe(&key(), Envelope::Message, Some(6), t0 + secs(32));
    assert_eq!(
        inbound.evaluate(&key(), t0 + secs(47)),
        Some(Action::ResetSuppressed)
    );
    inbound.observe(&key(), Envelope::Message, Some(8), t0 + secs(640));
    assert_eq!(
        inbound.evaluate(&key(), t0 + secs(655)),
        Some(Action::Reset)
    );
}

#[tokio::test(start_paused = true)]
async fn late_seq_is_still_deduped_and_counted() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let opened = open(&mut harness, "stream-1", 0).await;
    let before = gateway_counters::get(Counter::InboundLateFillDeduped);
    for seq in [1, 3, 2] {
        harness
            .tracker
            .handle_message(request("stream-1", seq))
            .await
            .expect("request");
    }
    let mut delivered = Vec::new();
    while let Ok(Some(TransportEvent::IncomingMessage { connection_id, message })) =
        timeout(Duration::from_millis(100), harness.transport_rx.recv()).await
    {
        assert_eq!(connection_id, opened.connection_id);
        delivered.push(serde_json::to_value(message).expect("message json")["method"].clone());
    }
    assert_eq!(delivered, ["gateway/test/1", "gateway/test/3"]);
    assert!(gateway_counters::get(Counter::InboundLateFillDeduped) > before);
}

#[tokio::test(start_paused = true)]
async fn log_only_never_cancels() {
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    let opened = open(&mut harness, "stream-1", 0).await;
    for seq in [1, 3] {
        harness
            .tracker
            .handle_message(request("stream-1", seq))
            .await
            .expect("request");
        next_transport_event(&mut harness).await;
    }
    tokio::time::advance(Duration::from_secs(16)).await;
    harness
        .tracker
        .handle_message(envelope(ClientEvent::Ping, "stream-1", Some(4)))
        .await
        .expect("ping");
    harness
        .tracker
        .close_expired_clients()
        .await
        .expect("sweep");
    assert_eq!(
        harness.tracker.gateway_inbound.holes(&key()),
        vec![(2, 2, true)]
    );
    assert!(!opened.disconnect.is_cancelled());
    assert!(
        timeout(Duration::from_millis(100), harness.transport_rx.recv())
            .await
            .is_err(),
        "log-only mode must not close the stream"
    );
    assert_no_pong(&mut harness).await;
}

#[tokio::test(start_paused = true)]
async fn reset_switch_resets_once_via_unknown_pong() {
    let directory = tempfile::TempDir::new().expect("temp dir");
    let switch = directory.path().join("inbound-gap-reset");
    std::fs::write(&switch, b"").expect("switch on");
    let mut harness = harness(CHANNEL_CAPACITY, CHANNEL_CAPACITY);
    harness.tracker.gateway_inbound.reset_switch = Some(switch);
    let opened = open(&mut harness, "stream-1", 0).await;
    for seq in [1, 3] {
        harness
            .tracker
            .handle_message(request("stream-1", seq))
            .await
            .expect("request");
        next_transport_event(&mut harness).await;
    }
    tokio::time::advance(Duration::from_secs(16)).await;
    harness
        .tracker
        .close_expired_clients()
        .await
        .expect("sweep finds the stale hole");
    let pong = next_server_event(&mut harness).await;
    assert!(is_unknown_pong(&pong, "stream-1"));
    if let Some(write_complete_tx) = pong.write_complete_tx {
        let _ = write_complete_tx.send(());
    }
    assert!(bookkeep_once(&mut harness).await.is_some());
    match next_transport_event(&mut harness).await {
        TransportEvent::ConnectionClosed { connection_id } => {
            assert_eq!(connection_id, opened.connection_id)
        }
        other => panic!("expected the reset stream to close, got {other:?}"),
    }

    // The client reconnects on the same stream id; a new stale hole within 10 minutes is
    // logged but does not reset again.
    let _again = open(&mut harness, "stream-1", 0).await;
    harness
        .tracker
        .handle_message(request("stream-1", 2))
        .await
        .expect("request");
    next_transport_event(&mut harness).await;
    tokio::time::advance(Duration::from_secs(16)).await;
    harness
        .tracker
        .close_expired_clients()
        .await
        .expect("sweep");
    assert_eq!(
        harness.tracker.gateway_inbound.holes(&key()),
        vec![(1, 1, true)]
    );
    assert_no_pong(&mut harness).await;
    assert!(bookkeep_once(&mut harness).await.is_none());
}

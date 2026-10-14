//! Gateway: tell the client when the app side ends a remote stream.
//!
//! The tracker marks a stream before it cancels it itself (client close, idle sweep,
//! re-initialize, shutdown), so any other cancel or a closed writer is an app-side end. Only
//! those send `Pong { Unknown }`, after the stream's queued replies, so the client closes with
//! "became unknown" and reconnects at once instead of losing requests until its next ping.
//! Every await here is bounded, so the outbound task always joins.

use super::QueuedServerEnvelope;
use super::protocol::ClientId;
use super::protocol::PongStatus;
use super::protocol::ServerEvent;
use super::protocol::StreamId;
use crate::gateway_counters;
use crate::gateway_counters::Counter;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::QueuedOutgoingMessage;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio::time::Duration;
use tokio::time::Instant;
use tokio::time::timeout_at;
use tokio_util::sync::CancellationToken;

#[cfg(not(test))]
pub(super) const STREAM_END_BUDGET: Duration = Duration::from_millis(750);
#[cfg(test)]
pub(super) const STREAM_END_BUDGET: Duration = Duration::from_millis(50);

#[derive(Clone, Debug)]
pub(crate) struct StreamEnd {
    pub(super) connection_id: ConnectionId,
    tracker_closed: Arc<AtomicBool>,
    tracker_shutdown: CancellationToken,
}

impl StreamEnd {
    pub(super) fn new(connection_id: ConnectionId, tracker_shutdown: &CancellationToken) -> Self {
        Self {
            connection_id,
            tracker_closed: Arc::new(AtomicBool::new(false)),
            tracker_shutdown: tracker_shutdown.clone(),
        }
    }

    /// Called by the tracker before it cancels the stream itself.
    pub(super) fn mark_tracker_close(&self) {
        self.tracker_closed.store(true, Ordering::Release);
    }

    pub(super) fn notify_client(&self) -> bool {
        !self.tracker_closed.load(Ordering::Acquire) && !self.tracker_shutdown.is_cancelled()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EndReason {
    Cancelled,
    WriterClosed,
    StatusClosed,
    ServerQueueClosed,
}

impl EndReason {
    fn label(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::WriterClosed => "writer_closed",
            Self::StatusClosed => "status_closed",
            Self::ServerQueueClosed => "server_queue_closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PongOutcome {
    Written,
    Unconfirmed,
    Dropped,
}

impl PongOutcome {
    fn label(self) -> &'static str {
        match self {
            Self::Written => "written",
            Self::Unconfirmed => "unconfirmed",
            Self::Dropped => "dropped",
        }
    }
}

pub(super) async fn run_client_outbound(
    client_id: ClientId,
    stream_id: StreamId,
    server_event_tx: mpsc::Sender<QueuedServerEnvelope>,
    mut writer_rx: mpsc::Receiver<QueuedOutgoingMessage>,
    mut status_rx: watch::Receiver<PongStatus>,
    disconnect_token: CancellationToken,
    stream_end: StreamEnd,
) -> (ClientId, StreamId) {
    let mut carried = None;
    let reason = loop {
        let (event, write_complete_tx) = tokio::select! {
            _ = disconnect_token.cancelled() => break EndReason::Cancelled,
            queued_message = writer_rx.recv() => {
                let Some(queued_message) = queued_message else {
                    break EndReason::WriterClosed;
                };
                let event = ServerEvent::ServerMessage {
                    message: Box::new(queued_message.message),
                };
                (event, queued_message.write_complete_tx)
            }
            changed = status_rx.changed() => {
                if changed.is_err() {
                    break EndReason::StatusClosed;
                }
                (ServerEvent::Pong { status: status_rx.borrow().clone() }, None)
            }
        };
        let envelope = QueuedServerEnvelope {
            event,
            client_id: client_id.clone(),
            stream_id: stream_id.clone(),
            write_complete_tx,
        };
        // Reserve first so a message already taken from the writer survives a winning cancel.
        tokio::select! {
            _ = disconnect_token.cancelled() => {
                if matches!(envelope.event, ServerEvent::ServerMessage { .. }) {
                    carried = Some(envelope);
                }
                break EndReason::Cancelled;
            }
            permit = server_event_tx.reserve() => match permit {
                Ok(permit) => permit.send(envelope),
                Err(_) => break EndReason::ServerQueueClosed,
            },
        }
    };
    if matches!(reason, EndReason::Cancelled | EndReason::WriterClosed) && stream_end.notify_client()
    {
        finish(
            &client_id,
            &stream_id,
            &server_event_tx,
            &mut writer_rx,
            carried,
            &stream_end,
            reason,
        )
        .await;
    }
    (client_id, stream_id)
}

async fn send_before(
    server_event_tx: &mpsc::Sender<QueuedServerEnvelope>,
    envelope: QueuedServerEnvelope,
    deadline: Instant,
) -> bool {
    matches!(
        timeout_at(deadline, server_event_tx.send(envelope)).await,
        Ok(Ok(()))
    )
}

async fn finish(
    client_id: &ClientId,
    stream_id: &StreamId,
    server_event_tx: &mpsc::Sender<QueuedServerEnvelope>,
    writer_rx: &mut mpsc::Receiver<QueuedOutgoingMessage>,
    carried: Option<QueuedServerEnvelope>,
    stream_end: &StreamEnd,
    reason: EndReason,
) {
    let deadline = Instant::now() + STREAM_END_BUDGET;
    // No new replies after this point; the ones already queued still go first.
    writer_rx.close();
    let mut drained = 0_u64;
    let mut drain_dropped = 0_u64;
    let mut expired = false;
    let mut pending = carried;
    loop {
        let envelope = match pending.take() {
            Some(envelope) => envelope,
            None => match writer_rx.try_recv() {
                Ok(queued_message) => QueuedServerEnvelope {
                    event: ServerEvent::ServerMessage {
                        message: Box::new(queued_message.message),
                    },
                    client_id: client_id.clone(),
                    stream_id: stream_id.clone(),
                    write_complete_tx: queued_message.write_complete_tx,
                },
                Err(_) => break,
            },
        };
        if !expired && send_before(server_event_tx, envelope, deadline).await {
            drained += 1;
        } else {
            expired = true;
            drain_dropped += 1;
        }
    }
    let (write_complete_tx, write_complete_rx) = oneshot::channel();
    let pong = QueuedServerEnvelope {
        event: ServerEvent::Pong {
            status: PongStatus::Unknown,
        },
        client_id: client_id.clone(),
        stream_id: stream_id.clone(),
        write_complete_tx: Some(write_complete_tx),
    };
    let outcome = if send_before(server_event_tx, pong, deadline).await {
        gateway_counters::add(Counter::StreamEndPongQueued, 1);
        match timeout_at(deadline, write_complete_rx).await {
            Ok(Ok(())) => PongOutcome::Written,
            _ => PongOutcome::Unconfirmed,
        }
    } else {
        PongOutcome::Dropped
    };
    gateway_counters::add(Counter::StreamEndNotified, 1);
    gateway_counters::add(Counter::StreamEndDrained, drained);
    gateway_counters::add(Counter::StreamEndDrainDropped, drain_dropped);
    gateway_counters::add(
        match outcome {
            PongOutcome::Written => Counter::StreamEndPongWritten,
            PongOutcome::Unconfirmed => Counter::StreamEndPongUnconfirmed,
            PongOutcome::Dropped => Counter::StreamEndPongDropped,
        },
        1,
    );
    tracing::info!(
        target: "gateway_remote_control",
        gateway_event = "stream_end_notified",
        connection = stream_end.connection_id.0,
        client = %gateway_counters::hash_id(&client_id.0),
        stream = %gateway_counters::hash_id(&stream_id.0),
        reason = reason.label(),
        drained,
        drain_dropped,
        pong = outcome.label(),
    );
}

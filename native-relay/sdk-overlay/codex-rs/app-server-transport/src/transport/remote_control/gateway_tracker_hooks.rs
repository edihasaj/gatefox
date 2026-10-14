//! Gateway: hooks called from small patches in `client_tracker.rs`.
//! A child module, so it can read the tracker's private state without widening it.

use super::ClientEnvelope;
use super::ClientEvent;
use super::ClientId;
use super::ClientTracker;
use super::StreamId;
use super::gateway_inbound::Action;
use super::gateway_inbound::Envelope;
use super::gateway_inbound::Fill;
use crate::gateway_counters;
use crate::gateway_counters::Counter;
use crate::gateway_counters::hash_id;
use tokio::time::Instant;

const TARGET: &str = "gateway_remote_control";

impl ClientTracker {
    /// Joins finished outbound tasks. A task whose key now belongs to a newer outbound task
    /// (a re-initialized stream) is skipped, so it cannot close its replacement.
    pub(super) async fn gateway_bookkeep(&mut self) -> Option<(ClientId, StreamId)> {
        while let Some(join_result) = self.join_set.join_next_with_id().await {
            let Ok((task, client_key)) = join_result else {
                continue;
            };
            if self
                .clients
                .get(&client_key)
                .is_some_and(|client| client.outbound_task != task)
            {
                continue;
            }
            return Some(client_key);
        }
        futures::future::pending().await
    }

    /// An `initialize` that will replace a live explicit stream. Its chunk state must be cleared
    /// as on any other close, because the predecessor's task no longer closes the replacement.
    pub(in crate::transport::remote_control) fn gateway_reinitialized_key(
        &self,
        client_envelope: &ClientEnvelope,
    ) -> Option<(ClientId, StreamId)> {
        let ClientEvent::ClientMessage { message } = &client_envelope.event else {
            return None;
        };
        if !super::remote_control_message_starts_connection(message) {
            return None;
        }
        let client_key = (
            client_envelope.client_id.clone(),
            client_envelope.stream_id.clone()?,
        );
        self.clients.contains_key(&client_key).then_some(client_key)
    }

    /// The SDK dropped a message at or below the stream's delivered high-water mark. When that
    /// sequence number filled a known hole, the message arrived late and out of order.
    pub(super) fn gateway_dedupe_dropped(
        &self,
        client_key: &(ClientId, StreamId),
        seq_id: u64,
        fill: Fill,
    ) {
        gateway_counters::add(Counter::InboundSeqDedupeDrop, 1);
        let late = matches!(fill, Fill::FilledHole { .. });
        if late {
            gateway_counters::add(Counter::InboundLateFillDeduped, 1);
        }
        tracing::info!(
            target: TARGET,
            gateway_event = if late { "inbound_late_fill_deduped" } else { "inbound_seq_dedupe_drop" },
            connection = self.clients.get(client_key).map(|client| client.connection_id.0),
            client = %hash_id(&client_key.0.0),
            stream = %hash_id(&client_key.1.0),
            seq = seq_id,
            after_stale = matches!(fill, Fill::FilledHole { stale: true }),
        );
    }

    /// Records the sequence number of an explicit-stream envelope before the SDK handles it.
    pub(super) fn gateway_observe(
        &mut self,
        client_key: &(ClientId, StreamId),
        event: &ClientEvent,
        seq_id: Option<u64>,
        is_legacy_stream_id: bool,
        is_initialize: bool,
    ) -> Fill {
        if is_legacy_stream_id || is_initialize {
            return Fill::Untracked;
        }
        let envelope = match event {
            ClientEvent::ClientMessage { .. } => Envelope::Message,
            ClientEvent::Ping => Envelope::Ping,
            ClientEvent::ClientClosed => Envelope::Closed,
            ClientEvent::ClientMessageChunk { .. } | ClientEvent::Ack { .. } => {
                return Fill::Untracked;
            }
        };
        let now = Instant::now();
        let fill = self
            .gateway_inbound
            .observe(client_key, envelope, seq_id, now);
        self.gateway_evaluate(client_key, now);
        fill
    }

    /// Evaluates every tracked stream; runs on the 30 s idle sweep.
    pub(super) fn gateway_evaluate_all(&mut self, now: Instant) {
        for client_key in self.gateway_inbound.keys() {
            self.gateway_evaluate(&client_key, now);
        }
    }

    /// A reset ends the stream from the app side without marking it, so the client gets the
    /// unknown pong after the stream's queued replies. No JSON-RPC result is synthesized.
    fn gateway_evaluate(&mut self, client_key: &(ClientId, StreamId), now: Instant) {
        if self.gateway_inbound.evaluate(client_key, now) == Some(Action::Reset)
            && let Some(client) = self.clients.get(client_key)
        {
            client.disconnect_token.cancel();
        }
    }

    /// A chunk of a not yet complete message arrived; its stream's holes are not stale yet.
    pub(in crate::transport::remote_control) fn gateway_chunk_pending(
        &mut self,
        client_message_key: Option<&((ClientId, Option<StreamId>), u64)>,
    ) {
        if let Some(((client_id, Some(stream_id)), seq_id)) = client_message_key {
            self.gateway_inbound.chunk_pending(
                &(client_id.clone(), stream_id.clone()),
                *seq_id,
                Instant::now(),
            );
        }
    }

    /// The SDK dropped a non-initialize message for a stream it does not know.
    pub(super) fn gateway_unknown_stream_dropped(&self, client_key: &(ClientId, StreamId)) {
        gateway_counters::add(Counter::UnknownStreamDrop, 1);
        tracing::info!(
            target: TARGET,
            gateway_event = "unknown_stream_drop",
            client = %hash_id(&client_key.0.0),
            stream = %hash_id(&client_key.1.0),
        );
    }
}

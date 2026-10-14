//! Gateway: hooks called from small patches in `client_tracker.rs`.
//! A child module, so it can read the tracker's private state without widening it.

use super::ClientId;
use super::ClientTracker;
use super::StreamId;
use crate::gateway_counters;
use crate::gateway_counters::Counter;
use crate::gateway_counters::hash_id;

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

    /// The SDK dropped a message at or below the stream's delivered high-water mark.
    pub(super) fn gateway_dedupe_dropped(&self, client_key: &(ClientId, StreamId), seq_id: u64) {
        gateway_counters::add(Counter::InboundSeqDedupeDrop, 1);
        tracing::info!(
            target: TARGET,
            gateway_event = "inbound_seq_dedupe_drop",
            connection = self.clients.get(client_key).map(|client| client.connection_id.0),
            client = %hash_id(&client_key.0.0),
            stream = %hash_id(&client_key.1.0),
            seq = seq_id,
        );
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

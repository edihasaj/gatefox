//! Gateway: hooks called from small patches in `client_tracker.rs`.
//! A child module, so it can read the tracker's private state without widening it.

use super::ClientId;
use super::ClientTracker;
use super::StreamId;

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
}

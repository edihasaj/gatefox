use crate::{SessionEntry, relay_counters};
use codex_app_server_transport::{
    ConnectionId, ConnectionOrigin, QueuedOutgoingMessage, TransportEvent,
};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use tokio::{sync::mpsc, time::Duration};
use tokio_util::sync::CancellationToken;

pub type Controllers =
    HashMap<ConnectionId, (mpsc::Sender<QueuedOutgoingMessage>, CancellationToken)>;

/// Ends every remote stream from the app side first, so the SDK sends each one an unknown
/// pong after its last replies, then cancels the root token that stops the SDK writer.
/// `ConnectionClosed` is the write barrier: the SDK emits it only after the pong was written
/// or its bounded budget ran out. New streams arriving meanwhile are refused the same way.
pub async fn drain_then_stop(
    sessions: &mut HashMap<ConnectionId, SessionEntry>,
    controllers: &mut Controllers,
    events: &mut mpsc::Receiver<TransportEvent>,
    stop: &CancellationToken,
    limit: Duration,
) {
    let mut pending = HashSet::new();
    for (connection, session) in sessions.drain() {
        session.stop.cancel();
        pending.insert(connection);
    }
    for (_, (_, token)) in controllers.drain() {
        token.cancel();
    }
    let deadline = tokio::time::Instant::now() + limit;
    while !pending.is_empty() {
        let event = match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) | Err(_) => break,
        };
        match event {
            TransportEvent::ConnectionClosed { connection_id } => {
                pending.remove(&connection_id);
            }
            TransportEvent::ConnectionOpened {
                origin,
                disconnect_sender,
                ..
            } => {
                if let Some(token) = disconnect_sender {
                    token.cancel();
                }
                if origin == ConnectionOrigin::RemoteControl {
                    relay_counters::SHUTDOWN_REFUSED_STREAMS.fetch_add(1, Ordering::Relaxed);
                }
            }
            TransportEvent::IncomingMessage { .. } => {
                relay_counters::NO_SESSION_DROPS.fetch_add(1, Ordering::Relaxed);
            }
            TransportEvent::DaemonShutdown => {}
        }
    }
    stop.cancel();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use tokio::time::Instant;

    fn session(stop: &CancellationToken, task: tokio::task::Id) -> SessionEntry {
        let (writer, _reader) = mpsc::channel(1);
        SessionEntry {
            writer,
            stop: stop.clone(),
            task,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cancels_sessions_before_root_and_waits_for_closes() {
        let placeholder = tokio::spawn(std::future::pending::<()>());
        let (first, second, root) = (
            CancellationToken::new(),
            CancellationToken::new(),
            CancellationToken::new(),
        );
        let mut sessions = HashMap::from([
            (ConnectionId(1), session(&first, placeholder.id())),
            (ConnectionId(2), session(&second, placeholder.id())),
        ]);
        let (events_tx, mut events) = mpsc::channel(8);
        let stop = root.clone();
        let drain = tokio::spawn(async move {
            let started = Instant::now();
            let mut controllers = Controllers::new();
            drain_then_stop(
                &mut sessions,
                &mut controllers,
                &mut events,
                &stop,
                Duration::from_secs(1),
            )
            .await;
            started.elapsed()
        });
        tokio::task::yield_now().await;
        assert!(first.is_cancelled() && second.is_cancelled());
        assert!(!root.is_cancelled(), "the SDK writer must outlive the stream ends");
        for connection in [1, 2] {
            events_tx
                .send(TransportEvent::ConnectionClosed {
                    connection_id: ConnectionId(connection),
                })
                .await
                .unwrap();
        }
        let elapsed = drain.await.unwrap();
        assert!(elapsed < Duration::from_secs(1));
        assert!(root.is_cancelled());
        placeholder.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn flush_refuses_new_streams_and_stops_at_deadline() {
        let placeholder = tokio::spawn(std::future::pending::<()>());
        let (session_token, root, late) = (
            CancellationToken::new(),
            CancellationToken::new(),
            CancellationToken::new(),
        );
        let mut sessions =
            HashMap::from([(ConnectionId(5), session(&session_token, placeholder.id()))]);
        let (events_tx, mut events) = mpsc::channel(8);
        let (writer, _reader) = mpsc::channel(1);
        events_tx
            .send(TransportEvent::ConnectionOpened {
                connection_id: ConnectionId(6),
                origin: ConnectionOrigin::RemoteControl,
                auth: None,
                writer,
                disconnect_sender: Some(late.clone()),
            })
            .await
            .unwrap();
        let refused = relay_counters::SHUTDOWN_REFUSED_STREAMS.load(Ordering::Relaxed);
        let started = Instant::now();
        drain_then_stop(
            &mut sessions,
            &mut Controllers::new(),
            &mut events,
            &root,
            Duration::from_secs(1),
        )
        .await;
        assert!(late.is_cancelled(), "a stream opened during the flush is refused");
        assert!(relay_counters::SHUTDOWN_REFUSED_STREAMS.load(Ordering::Relaxed) > refused);
        assert!(started.elapsed() >= Duration::from_secs(1));
        assert!(session_token.is_cancelled() && root.is_cancelled());
        drop(events_tx);
        placeholder.abort();
    }
}

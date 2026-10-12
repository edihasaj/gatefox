use crate::frames::FrameReader;
use serde_json::Value;
use std::io;
use tokio::{io::AsyncBufRead, sync::mpsc, time::Interval};
use tokio_util::sync::CancellationToken;

pub enum SessionEvent {
    Cancelled,
    Activity,
    Frame(io::Result<Option<Vec<u8>>>),
    Incoming(Option<Value>),
}

pub async fn next<R: AsyncBufRead + Unpin>(
    output: &mut FrameReader<R>,
    incoming: &mut mpsc::Receiver<Value>,
    stop: &CancellationToken,
    activity: &mut Interval,
) -> SessionEvent {
    // Fair selection lets Stop and steering RPCs through continuous child output.
    // Blocking sends and writes separately prioritize explicit cancellation.
    tokio::select! {
        _ = stop.cancelled() => SessionEvent::Cancelled,
        _ = activity.tick() => SessionEvent::Activity,
        frame = output.next() => SessionEvent::Frame(frame),
        message = incoming.recv() => SessionEvent::Incoming(message),
    }
}

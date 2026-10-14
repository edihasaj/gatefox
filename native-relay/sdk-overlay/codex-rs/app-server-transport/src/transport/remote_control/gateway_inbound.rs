//! Gateway: detect client sequence numbers the host never received. Log-only by default.
//!
//! For each explicit stream the host records every client envelope sequence number it sees
//! (messages, completed chunked messages, pings and client closes). A gap below the highest
//! seen number is a hole; it exists only because a later envelope arrived. A hole unfilled for
//! 15 s, with no chunk of that stream in the last 15 s, is stale and is logged once. Only while
//! `<relay-home>/inbound-gap-reset` exists does a stale hole end the stream through the
//! unknown-pong path, at most once per stream per 10 minutes. Nothing here changes what the
//! SDK delivers, so a late message is never delivered out of order.

use super::protocol::ClientId;
use super::protocol::StreamId;
use crate::gateway_counters;
use crate::gateway_counters::Counter;
use crate::gateway_counters::hash_id;
use crate::outgoing_message::ConnectionId;
use std::collections::HashMap;
use tokio::time::Duration;
use tokio::time::Instant;

pub(super) const STALE_AFTER: Duration = Duration::from_secs(15);
pub(super) const RESET_INTERVAL: Duration = Duration::from_secs(10 * 60);
pub(super) const MAX_HOLES: usize = 64;
const TARGET: &str = "gateway_remote_control";

type Key = (ClientId, StreamId);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Envelope {
    Message,
    Ping,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fill {
    Untracked,
    NoSeq,
    Advanced,
    FilledHole { stale: bool },
    Duplicate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    LogOnly,
    Reset,
    ResetSuppressed,
}

impl Action {
    fn label(self) -> &'static str {
        match self {
            Self::LogOnly => "log_only",
            Self::Reset => "reset",
            Self::ResetSuppressed => "reset_suppressed",
        }
    }
}

#[derive(Debug)]
struct Hole {
    start: u64,
    end: u64,
    since: Instant,
    stale: bool,
}

#[derive(Debug)]
struct StreamSeqs {
    connection: ConnectionId,
    high: Option<u64>,
    holes: Vec<Hole>,
    pings_with_seq: u64,
    pings_without_seq: u64,
    chunk: Option<(u64, Instant)>,
}

#[derive(Debug, Default)]
pub(crate) struct GatewayInbound {
    streams: HashMap<Key, StreamSeqs>,
    last_reset: HashMap<Key, Instant>,
    #[cfg(test)]
    pub(super) reset_switch: Option<std::path::PathBuf>,
}

impl GatewayInbound {
    pub(super) fn start(&mut self, key: &Key, connection: ConnectionId, seq: Option<u64>) {
        self.streams.insert(
            key.clone(),
            StreamSeqs {
                connection,
                high: seq,
                holes: Vec::new(),
                pings_with_seq: 0,
                pings_without_seq: 0,
                chunk: None,
            },
        );
    }

    pub(super) fn forget(&mut self, key: &Key) {
        if let Some(stream) = self.streams.remove(key)
            && !stream.holes.is_empty()
        {
            gateway_counters::add(Counter::HoleUnresolvedAtClose, stream.holes.len() as u64);
        }
    }

    pub(super) fn keys(&self) -> Vec<Key> {
        self.streams.keys().cloned().collect()
    }

    pub(super) fn chunk_pending(&mut self, key: &Key, seq: u64, now: Instant) {
        if let Some(stream) = self.streams.get_mut(key) {
            stream.chunk = Some((seq, now));
        }
    }

    pub(super) fn observe(
        &mut self,
        key: &Key,
        envelope: Envelope,
        seq: Option<u64>,
        now: Instant,
    ) -> Fill {
        let Some(stream) = self.streams.get_mut(key) else {
            return Fill::Untracked;
        };
        if envelope == Envelope::Ping {
            let first = stream.pings_with_seq + stream.pings_without_seq == 0;
            if seq.is_some() {
                stream.pings_with_seq += 1;
                gateway_counters::add(Counter::PingWithSeq, 1);
            } else {
                stream.pings_without_seq += 1;
                gateway_counters::add(Counter::PingWithoutSeq, 1);
            }
            if first {
                tracing::info!(
                    target: TARGET,
                    gateway_event = "ping_seq_presence",
                    connection = stream.connection.0,
                    client = %hash_id(&key.0.0),
                    stream = %hash_id(&key.1.0),
                    with_seq = seq.is_some(),
                );
            }
        }
        let Some(seq) = seq else {
            if envelope == Envelope::Message {
                gateway_counters::add(Counter::MessageWithoutSeq, 1);
            }
            return Fill::NoSeq;
        };
        if stream.chunk.is_some_and(|(chunk_seq, _)| chunk_seq == seq) {
            stream.chunk = None;
        }
        let Some(high) = stream.high else {
            stream.high = Some(seq);
            return Fill::Advanced;
        };
        if seq > high {
            if seq > high + 1 {
                gateway_counters::add(Counter::HoleOpened, 1);
                gateway_counters::add(Counter::MissingSeqs, seq - high - 1);
                if stream.holes.len() < MAX_HOLES {
                    stream.holes.push(Hole {
                        start: high + 1,
                        end: seq - 1,
                        since: now,
                        stale: false,
                    });
                } else {
                    gateway_counters::add(Counter::HoleOverflow, 1);
                }
            }
            stream.high = Some(seq);
            return Fill::Advanced;
        }
        let Some(index) = stream
            .holes
            .iter()
            .position(|hole| hole.start <= seq && seq <= hole.end)
        else {
            return Fill::Duplicate;
        };
        let (since, stale) = (stream.holes[index].since, stream.holes[index].stale);
        fill_hole(&mut stream.holes, index, seq);
        gateway_counters::add(Counter::HoleFilled, 1);
        if stale {
            gateway_counters::add(Counter::HoleFilledAfterStale, 1);
            tracing::info!(
                target: TARGET,
                gateway_event = "inbound_hole_filled_late",
                connection = stream.connection.0,
                client = %hash_id(&key.0.0),
                stream = %hash_id(&key.1.0),
                seq,
                waited_ms = duration_ms(now.duration_since(since)),
            );
        }
        Fill::FilledHole { stale }
    }

    /// Marks newly stale holes, logs each once and returns the strongest action taken.
    pub(super) fn evaluate(&mut self, key: &Key, now: Instant) -> Option<Action> {
        let reset_mode = {
            let stream = self.streams.get(key)?;
            if stream
                .chunk
                .is_some_and(|(_, at)| now.duration_since(at) < STALE_AFTER)
                || !stream
                    .holes
                    .iter()
                    .any(|hole| !hole.stale && now.duration_since(hole.since) >= STALE_AFTER)
            {
                return None;
            }
            self.reset_mode()
        };
        let recently_reset = self
            .last_reset
            .get(key)
            .is_some_and(|at| now.duration_since(*at) < RESET_INTERVAL);
        let action = match (reset_mode, recently_reset) {
            (false, _) => Action::LogOnly,
            (true, true) => Action::ResetSuppressed,
            (true, false) => Action::Reset,
        };
        let stream = self.streams.get_mut(key)?;
        for hole in stream
            .holes
            .iter_mut()
            .filter(|hole| !hole.stale && now.duration_since(hole.since) >= STALE_AFTER)
        {
            hole.stale = true;
            gateway_counters::add(Counter::HoleStale, 1);
            tracing::info!(
                target: TARGET,
                gateway_event = "inbound_hole_stale",
                connection = stream.connection.0,
                client = %hash_id(&key.0.0),
                stream = %hash_id(&key.1.0),
                hole_first_seq = hole.start,
                hole_size = hole.end - hole.start + 1,
                age_ms = duration_ms(now.duration_since(hole.since)),
                high_seq = stream.high.unwrap_or_default(),
                pings_with_seq = stream.pings_with_seq,
                pings_without_seq = stream.pings_without_seq,
                reset_mode,
                action = action.label(),
            );
        }
        if reset_mode {
            gateway_counters::add(
                if action == Action::Reset {
                    Counter::InboundGapReset
                } else {
                    Counter::InboundGapResetSuppressed
                },
                1,
            );
            tracing::info!(
                target: TARGET,
                gateway_event = "inbound_gap_reset",
                connection = stream.connection.0,
                client = %hash_id(&key.0.0),
                stream = %hash_id(&key.1.0),
                suppressed = action == Action::ResetSuppressed,
            );
        }
        if action == Action::Reset {
            self.last_reset
                .retain(|_, at| now.duration_since(*at) < RESET_INTERVAL);
            self.last_reset.insert(key.clone(), now);
        }
        Some(action)
    }

    fn reset_mode(&self) -> bool {
        #[cfg(test)]
        if let Some(path) = &self.reset_switch {
            return gateway_counters::reset_switch_is_on(Some(path));
        }
        gateway_counters::inbound_reset_enabled()
    }

    #[cfg(test)]
    pub(super) fn holes(&self, key: &Key) -> Vec<(u64, u64, bool)> {
        self.streams.get(key).map_or_else(Vec::new, |stream| {
            stream
                .holes
                .iter()
                .map(|hole| (hole.start, hole.end, hole.stale))
                .collect()
        })
    }

    #[cfg(test)]
    pub(super) fn pings(&self, key: &Key) -> (u64, u64) {
        self.streams.get(key).map_or((0, 0), |stream| {
            (stream.pings_with_seq, stream.pings_without_seq)
        })
    }
}

fn fill_hole(holes: &mut Vec<Hole>, index: usize, seq: u64) {
    let room = holes.len() < MAX_HOLES;
    let hole = &mut holes[index];
    if hole.start == hole.end {
        holes.remove(index);
    } else if seq == hole.start {
        hole.start += 1;
    } else if seq == hole.end {
        hole.end -= 1;
    } else if room {
        let tail = Hole {
            start: seq + 1,
            end: hole.end,
            since: hole.since,
            stale: hole.stale,
        };
        hole.end = seq - 1;
        holes.insert(index + 1, tail);
    } else {
        // At the cap the upper part is forgotten rather than tracked.
        hole.end = seq - 1;
        gateway_counters::add(Counter::HoleOverflow, 1);
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

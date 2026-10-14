//! Gateway: process-global remote-control transport counters, hashed identifiers and the
//! inbound-gap reset switch. Nothing here stores identifiers, message bodies or tokens.

use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::fmt::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Counter {
    InboundSeqDedupeDrop,
    InboundLateFillDeduped,
    InboundChunkDedupeDrop,
    UnknownStreamDrop,
    UnknownStreamPing,
    StreamEndNotified,
    StreamEndPongQueued,
    StreamEndPongWritten,
    StreamEndPongUnconfirmed,
    StreamEndPongDropped,
    StreamEndDrained,
    StreamEndDrainDropped,
    PingWithSeq,
    PingWithoutSeq,
    MessageWithoutSeq,
    HoleOpened,
    MissingSeqs,
    HoleFilled,
    HoleStale,
    HoleFilledAfterStale,
    HoleUnresolvedAtClose,
    HoleOverflow,
    InboundGapReset,
    InboundGapResetSuppressed,
}

const COUNTERS: usize = Counter::InboundGapResetSuppressed as usize + 1;
static VALUES: [AtomicU64; COUNTERS] = [const { AtomicU64::new(0) }; COUNTERS];
static OUTBOUND_UNACKED: AtomicU64 = AtomicU64::new(0);
static OUTBOUND_UNACKED_MAX: AtomicU64 = AtomicU64::new(0);
static RESET_SWITCH: OnceLock<PathBuf> = OnceLock::new();
static SALT: OnceLock<[u8; 16]> = OnceLock::new();

pub fn add(counter: Counter, value: u64) {
    VALUES[counter as usize].fetch_add(value, Ordering::Relaxed);
}

pub fn get(counter: Counter) -> u64 {
    VALUES[counter as usize].load(Ordering::Relaxed)
}

/// Unacknowledged envelopes held by the outbound buffer; the writer stops at 128.
pub fn set_outbound_unacked(used: usize) {
    let used = used as u64;
    OUTBOUND_UNACKED.store(used, Ordering::Relaxed);
    OUTBOUND_UNACKED_MAX.fetch_max(used, Ordering::Relaxed);
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub inbound_seq_dedupe_drops: u64,
    pub inbound_late_fill_deduped: u64,
    pub inbound_chunk_dedupe_drops: u64,
    pub unknown_stream_drops: u64,
    pub unknown_stream_pings: u64,
    pub stream_end_notified: u64,
    pub stream_end_pong_queued: u64,
    pub stream_end_pong_written: u64,
    pub stream_end_pong_unconfirmed: u64,
    pub stream_end_pong_dropped: u64,
    pub stream_end_drained: u64,
    pub stream_end_drain_dropped: u64,
    pub pings_with_seq: u64,
    pub pings_without_seq: u64,
    pub messages_without_seq: u64,
    pub holes_opened: u64,
    pub missing_seqs: u64,
    pub holes_filled: u64,
    pub holes_stale: u64,
    pub holes_filled_after_stale: u64,
    pub holes_unresolved_at_close: u64,
    pub hole_overflows: u64,
    pub inbound_gap_resets: u64,
    pub inbound_gap_resets_suppressed: u64,
    pub outbound_unacked: u64,
    pub outbound_unacked_max: u64,
}

pub fn snapshot() -> Snapshot {
    use Counter::*;
    Snapshot {
        inbound_seq_dedupe_drops: get(InboundSeqDedupeDrop),
        inbound_late_fill_deduped: get(InboundLateFillDeduped),
        inbound_chunk_dedupe_drops: get(InboundChunkDedupeDrop),
        unknown_stream_drops: get(UnknownStreamDrop),
        unknown_stream_pings: get(UnknownStreamPing),
        stream_end_notified: get(StreamEndNotified),
        stream_end_pong_queued: get(StreamEndPongQueued),
        stream_end_pong_written: get(StreamEndPongWritten),
        stream_end_pong_unconfirmed: get(StreamEndPongUnconfirmed),
        stream_end_pong_dropped: get(StreamEndPongDropped),
        stream_end_drained: get(StreamEndDrained),
        stream_end_drain_dropped: get(StreamEndDrainDropped),
        pings_with_seq: get(PingWithSeq),
        pings_without_seq: get(PingWithoutSeq),
        messages_without_seq: get(MessageWithoutSeq),
        holes_opened: get(HoleOpened),
        missing_seqs: get(MissingSeqs),
        holes_filled: get(HoleFilled),
        holes_stale: get(HoleStale),
        holes_filled_after_stale: get(HoleFilledAfterStale),
        holes_unresolved_at_close: get(HoleUnresolvedAtClose),
        hole_overflows: get(HoleOverflow),
        inbound_gap_resets: get(InboundGapReset),
        inbound_gap_resets_suppressed: get(InboundGapResetSuppressed),
        outbound_unacked: OUTBOUND_UNACKED.load(Ordering::Relaxed),
        outbound_unacked_max: OUTBOUND_UNACKED_MAX.load(Ordering::Relaxed),
    }
}

/// Points the inbound-gap reset switch at `<relay-home>/inbound-gap-reset`; set once.
pub fn set_inbound_reset_switch(path: PathBuf) {
    let _ = RESET_SWITCH.set(path);
}

/// Reset mode is on only while the switch path is a regular file (checked on every call).
pub fn inbound_reset_enabled() -> bool {
    reset_switch_is_on(RESET_SWITCH.get().map(PathBuf::as_path))
}

pub fn reset_switch_is_on(path: Option<&Path>) -> bool {
    path.and_then(|path| std::fs::symlink_metadata(path).ok())
        .is_some_and(|metadata| metadata.file_type().is_file())
}

/// First 12 hex characters of sha256(per-process random salt || value). Stable within one
/// process only, so logs never carry raw client or stream identifiers.
pub fn hash_id(value: &str) -> String {
    let salt = SALT.get_or_init(rand::random::<[u8; 16]>);
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut text = String::with_capacity(12);
    for byte in &digest[..6] {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_id_is_stable_short_hex_and_hides_its_input() {
        let first = hash_id("client-raw-identifier");
        assert_eq!(first, hash_id("client-raw-identifier"));
        assert_eq!(first.len(), 12);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(!first.contains("client"));
        assert_ne!(first, hash_id("client-raw-identifier-2"));
    }

    #[test]
    fn reset_switch_requires_a_regular_file() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let path = directory.path().join("inbound-gap-reset");
        assert!(!reset_switch_is_on(None));
        assert!(!reset_switch_is_on(Some(&path)));
        std::fs::create_dir(&path).expect("directory switch");
        assert!(!reset_switch_is_on(Some(&path)));
        std::fs::remove_dir(&path).expect("remove directory switch");
        std::fs::write(&path, b"").expect("file switch");
        assert!(reset_switch_is_on(Some(&path)));
    }

    #[test]
    fn counters_and_outbound_gauge_only_grow_their_maximum() {
        let before = get(Counter::HoleOverflow);
        add(Counter::HoleOverflow, 2);
        assert!(get(Counter::HoleOverflow) >= before + 2);
        set_outbound_unacked(127);
        set_outbound_unacked(3);
        let snapshot = snapshot();
        assert!(snapshot.outbound_unacked_max >= 127);
        let json = serde_json::to_value(snapshot).expect("snapshot json");
        assert!(json.get("streamEndNotified").is_some());
        assert!(json.get("outboundUnackedMax").is_some());
    }
}

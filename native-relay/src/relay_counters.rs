use std::sync::atomic::AtomicU64;

/// Client requests for a connection with no relay session (the SDK delivered, nobody listened).
pub static NO_SESSION_DROPS: AtomicU64 = AtomicU64::new(0);
/// Remote streams refused with an unknown pong while the relay was shutting down.
pub static SHUTDOWN_REFUSED_STREAMS: AtomicU64 = AtomicU64::new(0);

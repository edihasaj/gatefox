use serde_json::{Value, json};
use std::io::Write;
use std::{collections::HashSet, io, time::SystemTime};
use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    Cancelled,
    AuthScopeChanged,
    IncomingClosed,
    ChildEof,
    FrameIncomplete,
    FrameOversized,
    FrameIo,
    JsonInvalid,
    ChildInputIo,
    PeerClosed,
    SpawnIo,
    ChildWaitIo,
    ChildKillIo,
    ChildShutdownTimeout,
    QueueFull,
    QueueClosed,
    SessionLimit,
    SessionTaskLimit,
    TaskPanic,
    TaskCancelled,
}

impl Cause {
    pub fn label(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::AuthScopeChanged => "auth_scope_changed",
            Self::IncomingClosed => "incoming_closed",
            Self::ChildEof => "child_eof",
            Self::FrameIncomplete => "frame_incomplete",
            Self::FrameOversized => "frame_oversized",
            Self::FrameIo => "frame_io",
            Self::JsonInvalid => "json_invalid",
            Self::ChildInputIo => "child_input_io",
            Self::PeerClosed => "peer_closed",
            Self::SpawnIo => "spawn_io",
            Self::ChildWaitIo => "child_wait_io",
            Self::ChildKillIo => "child_kill_io",
            Self::ChildShutdownTimeout => "child_shutdown_timeout",
            Self::QueueFull => "queue_full",
            Self::QueueClosed => "queue_closed",
            Self::SessionLimit => "session_limit",
            Self::SessionTaskLimit => "session_task_limit",
            Self::TaskPanic => "task_panic",
            Self::TaskCancelled => "task_cancelled",
        }
    }
}

pub fn frame_cause(error: &io::Error) -> Cause {
    // Match only our own fixed frame-reader errors; never emit error text.
    match error.to_string().as_str() {
        "Incomplete JSON frame" => Cause::FrameIncomplete,
        "JSON frame exceeds 16 MiB" => Cause::FrameOversized,
        _ => Cause::FrameIo,
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

pub fn record(event: &'static str, connection: u64, cause: Cause) -> Value {
    json!({"scope":"native_relay", "timestampMs":now_ms(), "event":event,
        "connection":connection, "cause":cause.label()})
}

pub fn write_record<W: Write>(writer: &mut W, value: &Value) {
    // A closed log pipe must not trigger another panic inside the panic hook.
    let _ = writeln!(writer, "gateway: {value}");
}

pub fn emit(value: &Value) {
    write_record(&mut io::stderr().lock(), value);
}

pub fn install_panic_hook() {
    // Rust's default hook prints arbitrary panic payloads before JoinSet sees them.
    std::panic::set_hook(Box::new(|_| {
        emit(&json!({"scope":"native_relay", "timestampMs":now_ms(),
            "event":"panic_observed", "cause":Cause::TaskPanic.label()}));
    }));
}

fn trusted_id(value: &Value) -> Option<String> {
    if let Some(number) = value.as_u64() {
        return Some(number.to_string());
    }
    let text = value.as_str()?;
    if text.len() == 36 {
        let parsed = uuid::Uuid::parse_str(text).ok()?;
        if parsed.hyphenated().to_string() == text {
            return Some(text.to_owned());
        }
    }
    if !text.is_empty() && text.len() <= 20 && text.bytes().all(|byte| byte.is_ascii_digit()) {
        let number = text.parse::<u64>().ok()?;
        if number.to_string() == text {
            return Some(text.to_owned());
        }
    }
    None
}

pub fn lifecycle_metadata(message: &Value) -> Value {
    let Some(method @ ("turn/started" | "turn/completed" | "error")) =
        message.get("method").and_then(Value::as_str)
    else {
        return Value::Null;
    };
    let params = &message["params"];
    let thread = params.get("threadId").and_then(trusted_id);
    let turn = params
        .get("turn")
        .and_then(|value| value.get("id"))
        .or_else(|| params.get("turnId"))
        .and_then(trusted_id);
    let status = params
        .get("turn")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .filter(|status| {
            matches!(
                *status,
                "completed" | "failed" | "interrupted" | "inProgress"
            )
        });
    json!({"method":method,"emittedAtMs":message.get("emittedAtMs").and_then(Value::as_u64),
        "params":{"threadId":thread,"turnId":turn,"turn":{"id":turn,"status":status},
            "willRetry":params.get("willRetry").and_then(Value::as_bool)}})
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct StderrCounts {
    pub bytes: u64,
    pub chunks: u64,
    pub read_failed: bool,
    pub complete: bool,
}

pub async fn drain_stderr<R: AsyncRead + Unpin>(mut reader: R) -> StderrCounts {
    let mut buffer = [0_u8; 8192];
    let mut counts = StderrCounts::default();
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => {
                counts.complete = true;
                break;
            }
            Ok(length) => {
                counts.bytes = counts.bytes.saturating_add(length as u64);
                counts.chunks = counts.chunks.saturating_add(1);
            }
            Err(_) => {
                counts.read_failed = true;
                break;
            }
        }
    }
    counts
}

pub struct SessionDiagnostics {
    connection: u64,
    received: u64,
    queued: u64,
    started: u64,
    completed: u64,
    active: HashSet<(String, String)>,
    last_received: Option<u64>,
    last_queued: Option<u64>,
}

impl SessionDiagnostics {
    pub fn new(connection: u64) -> Self {
        Self {
            connection,
            received: 0,
            queued: 0,
            started: 0,
            completed: 0,
            active: HashSet::new(),
            last_received: None,
            last_queued: None,
        }
    }
    fn base(&self, event: &'static str) -> Value {
        json!({"scope":"native_relay", "timestampMs":now_ms(), "event":event,
            "connection":self.connection, "receivedFrames":self.received,
            "queuedFrames":self.queued, "startedTurns":self.started,
            "completedTurns":self.completed, "observedActiveTurns":self.active.len(),
            "lastReceivedAtMs":self.last_received, "lastQueuedAtMs":self.last_queued})
    }
    pub fn snapshot(&self) -> Value {
        self.base("session_activity")
    }
    pub fn start(&self) -> Value {
        self.base("session_started")
    }
    pub fn received(&mut self) {
        self.received = self.received.saturating_add(1);
        self.last_received = Some(now_ms());
    }
    pub fn queued(&mut self, message: &Value) -> Option<Value> {
        self.queued = self.queued.saturating_add(1);
        self.last_queued = Some(now_ms());
        let method = message.get("method")?.as_str()?;
        let event = match method {
            "turn/started" => "turn_started_queued",
            "turn/completed" => "turn_completed_queued",
            "error" => "sdk_error_queued",
            _ => return None,
        };
        let params = message.get("params")?;
        let thread = params.get("threadId").and_then(trusted_id);
        let turn = params
            .get("turn")
            .and_then(|value| value.get("id"))
            .or_else(|| params.get("turnId"))
            .and_then(trusted_id);
        if method == "turn/started" {
            self.started = self.started.saturating_add(1);
            if self.active.len() < 128 {
                if let (Some(thread), Some(turn)) = (&thread, &turn) {
                    self.active.insert((thread.clone(), turn.clone()));
                }
            }
        } else if method == "turn/completed" {
            self.completed = self.completed.saturating_add(1);
            if let (Some(thread), Some(turn)) = (&thread, &turn) {
                self.active.remove(&(thread.clone(), turn.clone()));
            }
        }
        let mut value = self.base(event);
        if let Some(thread) = thread {
            value["threadId"] = json!(thread);
        }
        if let Some(turn) = turn {
            value["turnId"] = json!(turn);
        }
        if let Some(timestamp) = message.get("emittedAtMs").and_then(Value::as_u64) {
            value["sdkEmittedAtMs"] = json!(timestamp);
        }
        if let Some(status @ ("completed" | "failed" | "interrupted" | "inProgress")) = params
            .get("turn")
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
        {
            value["turnStatus"] = json!(status);
        }
        if let Some(retry) = params.get("willRetry").and_then(Value::as_bool) {
            value["willRetry"] = json!(retry);
        }
        Some(value)
    }
    pub fn end(
        &self,
        cause: Cause,
        stderr: &StderrCounts,
        child_exit: Option<&'static str>,
    ) -> Value {
        let mut value = self.base("session_ended");
        value["cause"] = json!(cause.label());
        value["stderrBytes"] = json!(stderr.bytes);
        value["stderrChunks"] = json!(stderr.chunks);
        value["stderrReadFailed"] = json!(stderr.read_failed);
        value["stderrDrainCompleted"] = json!(stderr.complete);
        value["childExit"] = json!(child_exit);
        value
    }
}

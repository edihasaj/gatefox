//! Audited SDK remote-control logging. Only the remote-control target and the gateway's own
//! target are subscribed. SDK message text is matched against fixed labels and never printed;
//! only allowlisted, sanitized fields are kept, ids are hashed, and each label is rate limited.

use crate::{diagnostics, sdk_log_labels as labels};
use codex_app_server_transport::gateway_counters::hash_id;
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    fmt::{self, Write as _},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tracing::{
    Event, Level, Metadata, Subscriber,
    field::{Field, Visit},
    level_filters::LevelFilter,
    subscriber::Interest,
};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

pub const SDK_TARGET: &str = "codex_app_server_transport::transport::remote_control";
pub const GATEWAY_TARGET: &str = "gateway_remote_control";
const LINES_PER_MINUTE: u32 = 20;
const MAX_VALUE: usize = 80;
const MESSAGE_PREFIX: usize = 160;
const RESERVED: &[&str] = &["scope", "timestampMs", "event", "level", "label", "suppressed", "callsite"];

pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

pub fn install() {
    let layer = SdkLogLayer::new(Arc::new(|record| diagnostics::emit(&record)));
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(layer));
}

fn wanted(metadata: &Metadata<'_>) -> bool {
    let target = metadata.target();
    metadata.is_event()
        && *metadata.level() <= Level::INFO
        && (target == GATEWAY_TARGET
            || target == SDK_TARGET
            || target
                .strip_prefix(SDK_TARGET)
                .is_some_and(|rest| rest.starts_with("::")))
}

/// Keeps at most `LINES_PER_MINUTE` lines per label; the next printed line reports the rest.
#[derive(Default)]
pub struct RateLimiter {
    windows: HashMap<String, (Instant, u32, u64)>,
}

impl RateLimiter {
    pub fn admit(&mut self, label: &str, now: Instant) -> Option<u64> {
        let window = self
            .windows
            .entry(label.to_owned())
            .or_insert((now, 0, 0));
        if now.duration_since(window.0) >= Duration::from_secs(60) {
            window.0 = now;
            window.1 = 0;
        }
        if window.1 >= LINES_PER_MINUTE {
            window.2 = window.2.saturating_add(1);
            return None;
        }
        window.1 += 1;
        Some(std::mem::take(&mut window.2))
    }
}

pub struct SdkLogLayer {
    sink: Sink,
    limiter: Mutex<RateLimiter>,
}

impl SdkLogLayer {
    pub fn new(sink: Sink) -> Self {
        Self {
            sink,
            limiter: Mutex::new(RateLimiter::default()),
        }
    }

    fn render(&self, event: &Event<'_>) -> Option<Value> {
        let metadata = event.metadata();
        let level = *metadata.level();
        let gateway = metadata.target() == GATEWAY_TARGET;
        let mut fields = Collector::new(gateway);
        event.record(&mut fields);
        let mut record = Map::new();
        let label = if gateway {
            fields.gateway_event.take().unwrap_or_else(|| "gateway_event".to_owned())
        } else {
            match labels::label_for(&fields.message.text) {
                Some(label) if level < Level::INFO || labels::LIFECYCLE.contains(&label) => {
                    label.to_owned()
                }
                Some(_) => return None,
                None if level < Level::INFO => {
                    let file = metadata.file().unwrap_or("unknown");
                    let file = file.rsplit('/').next().unwrap_or(file);
                    record.insert(
                        "callsite".into(),
                        json!(sanitize(&format!("{file}:{}", metadata.line().unwrap_or(0)))),
                    );
                    "unlisted".to_owned()
                }
                None => return None,
            }
        };
        let suppressed = self
            .limiter
            .lock()
            .ok()?
            .admit(&label, Instant::now())?;
        record.insert("scope".into(), json!("native_relay_sdk"));
        record.insert("timestampMs".into(), json!(diagnostics::now_ms()));
        record.insert("event".into(), json!("sdk_log"));
        record.insert("level".into(), json!(level.as_str().to_ascii_lowercase()));
        record.insert("label".into(), json!(label));
        if suppressed > 0 {
            record.insert("suppressed".into(), json!(suppressed));
        }
        for (name, value) in fields.values {
            let key = camel_case(&name);
            if !RESERVED.contains(&key.as_str()) {
                record.entry(key).or_insert(value);
            }
        }
        Some(Value::Object(record))
    }
}

impl<S: Subscriber> Layer<S> for SdkLogLayer {
    fn register_callsite(&self, metadata: &'static Metadata<'static>) -> Interest {
        if wanted(metadata) {
            Interest::always()
        } else {
            Interest::never()
        }
    }

    fn enabled(&self, metadata: &Metadata<'_>, _: Context<'_, S>) -> bool {
        wanted(metadata)
    }

    fn max_level_hint(&self) -> Option<LevelFilter> {
        Some(LevelFilter::INFO)
    }

    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        if wanted(event.metadata())
            && let Some(record) = self.render(event)
        {
            (self.sink)(record);
        }
    }
}

/// Printable characters only, at most 80 of them; anything else becomes `redacted`.
pub fn sanitize(value: &str) -> String {
    let safe = value.len() <= MAX_VALUE
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" _.:{}()-".contains(&byte));
    if safe { value.to_owned() } else { "redacted".to_owned() }
}

fn camel_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for character in name.chars() {
        if character == '_' {
            upper = true;
        } else if upper {
            out.extend(character.to_uppercase());
            upper = false;
        } else {
            out.push(character);
        }
    }
    out
}

/// Bounded text sink: formatting stops once `limit` bytes were kept.
struct Capped {
    text: String,
    limit: usize,
    overflow: bool,
}

impl Capped {
    fn new(limit: usize) -> Self {
        Self {
            text: String::new(),
            limit,
            overflow: false,
        }
    }
}

impl fmt::Write for Capped {
    fn write_str(&mut self, part: &str) -> fmt::Result {
        let room = self.limit.saturating_sub(self.text.len());
        if part.len() > room {
            self.overflow = true;
            let mut end = room;
            while end > 0 && !part.is_char_boundary(end) {
                end -= 1;
            }
            self.text.push_str(&part[..end]);
        } else {
            self.text.push_str(part);
        }
        Ok(())
    }
}

struct Collector {
    gateway: bool,
    message: Capped,
    gateway_event: Option<String>,
    values: Vec<(String, Value)>,
}

impl Collector {
    fn new(gateway: bool) -> Self {
        Self {
            gateway,
            message: Capped::new(MESSAGE_PREFIX),
            gateway_event: None,
            values: Vec::new(),
        }
    }

    fn keeps(&self, name: &str) -> bool {
        name != "message"
            && (self.gateway || labels::FIELDS.contains(&name) || labels::HASHED.contains(&name))
    }

    fn text(&mut self, field: &Field, value: &str, overflow: bool) {
        let name = field.name();
        if self.gateway && name == "gateway_event" {
            self.gateway_event = Some(sanitize(value));
        } else if labels::HASHED.contains(&name) {
            self.values.push((name.to_owned(), json!(hash_id(value))));
        } else {
            let value = if overflow { "redacted".to_owned() } else { sanitize(value) };
            self.values.push((name.to_owned(), json!(value)));
        }
    }
}

impl Visit for Collector {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
            return;
        }
        if !self.keeps(field.name()) {
            return;
        }
        let mut text = Capped::new(MAX_VALUE + 1);
        let _ = write!(text, "{value:?}");
        let overflow = text.overflow;
        self.text(field, &text.text, overflow);
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            let _ = self.message.write_str(value);
        } else if self.keeps(field.name()) {
            self.text(field, value, false);
        }
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        if self.keeps(field.name()) {
            self.values.push((field.name().to_owned(), json!(value)));
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        if self.keeps(field.name()) {
            self.values.push((field.name().to_owned(), json!(value)));
        }
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        if self.keeps(field.name()) {
            self.values.push((field.name().to_owned(), json!(value)));
        }
    }
}

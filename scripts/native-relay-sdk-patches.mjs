// String patches applied to pristine pinned SDK sources. Each `original` must occur exactly
// `count` times (default 1). New logic lives in native-relay/sdk-overlay; patches only call it.
const transport = 'codex-rs/app-server-transport/src/';
const remote = `${transport}transport/remote_control/`;

const existing = [
  { file: `${transport}outgoing_message.rs`, original: 'pub enum OutgoingMessage {',
    replacement: 'pub enum OutgoingMessage {\n    /// Gateway: preserve arbitrary app-server JSON envelopes.\n    Passthrough(serde_json::Value),' },
  { file: `${remote}mod.rs`, original: 'pub struct RemoteControlStartConfig {',
    replacement: 'pub struct RemoteControlStartConfig {\n    pub server_name: Option<String>,' },
  { file: `${remote}controller.rs`, original: 'let server_name = gethostname().to_string_lossy().trim().to_string();',
    replacement: 'let server_name = self.config.server_name.clone().unwrap_or_else(|| gethostname().to_string_lossy().trim().to_string());' },
  { file: `${remote}controller.rs`, original: 'server_name: gethostname().to_string_lossy().trim().to_string(),',
    replacement: 'server_name: config.server_name.clone().unwrap_or_else(|| gethostname().to_string_lossy().trim().to_string()),' },
  { file: `${remote}websocket.rs`, original: '    info!(\n        "creating new remote control enrollment:',
    replacement: '    if enrollment.is_none() || matches!(selection, RemoteControlEnrollmentSelection::ReplaceExisting) {\n        return Err(io::Error::new(ErrorKind::NotFound, "Gateway requires the existing native machine registration"));\n    }\n    info!(\n        "creating new remote control enrollment:' },
];

// The server-name field above has no default, so upstream test initializers name it as `None`,
// which keeps their original hostname behaviour.
// Upstream unit tests also enroll new mock machines. The relay binary is never built with
// cfg(test), so it keeps the existing-registration guard; only the SDK's own test build skips it.
const testCompatibility = [
  { file: `${remote}tests.rs`, count: 19, original: 'RemoteControlStartConfig {\n            remote_control_url',
    replacement: 'RemoteControlStartConfig {\n            server_name: None,\n            remote_control_url' },
  { file: `${remote}tests/retry_tests.rs`, count: 2, original: 'RemoteControlStartConfig {\n            remote_control_url',
    replacement: 'RemoteControlStartConfig {\n            server_name: None,\n            remote_control_url' },
  { file: `${remote}websocket.rs`,
    original: '    if enrollment.is_none() || matches!(selection, RemoteControlEnrollmentSelection::ReplaceExisting) {',
    replacement: '    if !cfg!(test) && (enrollment.is_none() || matches!(selection, RemoteControlEnrollmentSelection::ReplaceExisting)) {' },
];

export const sdkPatches = [...existing, ...testCompatibility];

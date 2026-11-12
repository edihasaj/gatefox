use crate::{
    diagnostics::{Cause, SessionDiagnostics, now_ms},
    session::IDLE_RELEASE_MS,
};
use serde_json::json;

const THREAD: &str = "01a12f23-9d7d-7ca0-8e55-5c54ae8379fd";
const TURN: &str = "01a12f23-9d7d-7ca0-8e55-5c54ae8379fe";

fn later() -> u64 {
    now_ms() + IDLE_RELEASE_MS + 1
}

#[test]
fn idle_release_has_a_stable_label() {
    assert_eq!(Cause::IdleReleased.label(), "idle_released");
}

#[test]
fn initialized_but_unused_stream_is_released_after_silence() {
    // The macbook-server case: the phone sent initialize, got its answer and
    // never sent anything else, pinning an old engine release for hours.
    let mut state = SessionDiagnostics::new(1);
    state.received(&json!({"id": 1, "method": "initialize", "params": {}}));
    state.queued(&json!({"id": 1, "result": {}}));
    assert!(!state.idle_expired(now_ms(), IDLE_RELEASE_MS));
    assert!(state.idle_expired(later(), IDLE_RELEASE_MS));
}

#[test]
fn running_turn_is_never_released() {
    let mut state = SessionDiagnostics::new(1);
    state.queued(&json!({"method": "turn/started",
        "params": {"threadId": THREAD, "turn": {"id": TURN}}}));
    assert!(!state.idle_expired(later(), IDLE_RELEASE_MS));
    state.queued(&json!({"method": "turn/completed",
        "params": {"threadId": THREAD, "turn": {"id": TURN, "status": "completed"}}}));
    assert!(state.idle_expired(later(), IDLE_RELEASE_MS));
}

#[test]
fn turn_without_trusted_ids_still_counts_as_running() {
    let mut state = SessionDiagnostics::new(1);
    state.queued(&json!({"method": "turn/started", "params": {}}));
    assert!(!state.idle_expired(later(), IDLE_RELEASE_MS));
}

#[test]
fn unanswered_client_request_keeps_the_session() {
    let mut state = SessionDiagnostics::new(1);
    state.received(&json!({"id": "a", "method": "thread/list"}));
    assert!(!state.idle_expired(later(), IDLE_RELEASE_MS));
    state.queued(&json!({"id": "a", "result": {"data": []}}));
    assert!(state.idle_expired(later(), IDLE_RELEASE_MS));
}

#[test]
fn waiting_approval_keeps_the_session() {
    let mut state = SessionDiagnostics::new(1);
    state.queued(&json!({"id": 7, "method": "item/commandExecution/requestApproval"}));
    assert!(!state.idle_expired(later(), IDLE_RELEASE_MS));
    state.received(&json!({"id": 7, "result": {"decision": "accept"}}));
    assert!(state.idle_expired(later(), IDLE_RELEASE_MS));
}

#[test]
fn recent_traffic_resets_the_idle_clock() {
    let mut state = SessionDiagnostics::new(1);
    state.received(&json!({"method": "initialized"}));
    assert!(!state.idle_expired(now_ms() + IDLE_RELEASE_MS / 2, IDLE_RELEASE_MS));
}

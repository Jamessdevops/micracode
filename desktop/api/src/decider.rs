//! The domain decider (PRD FR2): the single place where incoming commands are
//! validated and translated into the domain events that get appended to the log.
//!
//! It is deliberately pure — no side effects, no I/O — so the engine can run it
//! on the serialized dispatch path and the event log stays the replayable source
//! of truth. Side-effecting work (spawning the Codex subprocess, routing a turn
//! to it) lives in the [`ProviderManager`](crate::provider), which dispatches
//! these commands *before* performing the effect so the intent is recorded first.
//!
//! Command kinds are stable strings shared with the HTTP `/v1/commands` surface;
//! unknown kinds and malformed payloads are rejected rather than recorded.

use core_orchestration::{Command, DeciderError};
use core_persistence::DomainEvent;
use serde_json::json;

/// Start a provider session bound to a workspace. Payload: `session_id`
/// (required), `workspace`, `model`, `harness`, and `permission` (optional).
pub const CMD_START_SESSION: &str = "start_session";
/// Send a user turn to a session. Payload: `session_id` and `text` (both required).
pub const CMD_SEND_TURN: &str = "send_turn";
/// Interrupt the in-flight turn of a session. Payload: `session_id` (required).
pub const CMD_INTERRUPT: &str = "interrupt";

/// Validate a command and produce its domain events, or reject it.
///
/// The emitted event kinds are the ones the projection and transport already
/// understand: `send_turn` produces `provider.user_turn` (the user message that
/// opens a turn); session lifecycle commands produce `session.*` facts.
pub fn decide(command: &Command) -> Result<Vec<DomainEvent>, DeciderError> {
    match command.kind.as_str() {
        CMD_START_SESSION => {
            let session_id = require_str(command, "session_id")?;
            let mut payload = json!({ "session_id": session_id });
            // Carry the optional context through verbatim when present. `harness`
            // and `permission` are recorded so a resumed session re-launches the
            // same agent with the same autonomy (FR1).
            for key in ["workspace", "model", "harness", "permission"] {
                if let Some(value) = command.payload.get(key) {
                    if !value.is_null() {
                        payload[key] = value.clone();
                    }
                }
            }
            Ok(vec![DomainEvent::new("session.start_requested", payload)])
        }
        CMD_SEND_TURN => {
            let session_id = require_str(command, "session_id")?;
            let text = require_str(command, "text")?;
            if text.trim().is_empty() {
                return Err(DeciderError::new("send_turn requires non-empty `text`"));
            }
            Ok(vec![DomainEvent::new(
                "provider.user_turn",
                json!({ "session_id": session_id, "text": text }),
            )])
        }
        CMD_INTERRUPT => {
            let session_id = require_str(command, "session_id")?;
            Ok(vec![DomainEvent::new(
                "session.interrupt_requested",
                json!({ "session_id": session_id }),
            )])
        }
        other => Err(DeciderError::new(format!("unknown command kind: {other}"))),
    }
}

/// Pull a required, non-empty string field out of a command's payload.
fn require_str(command: &Command, field: &str) -> Result<String, DeciderError> {
    match command.payload.get(field).and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(DeciderError::new(format!(
            "{} requires a non-empty string `{field}`",
            command.kind
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn command(kind: &str, payload: Value) -> Command {
        Command {
            id: "test".into(),
            kind: kind.into(),
            payload,
        }
    }

    #[test]
    fn send_turn_produces_a_user_turn_event() {
        let events = decide(&command(
            CMD_SEND_TURN,
            json!({ "session_id": "s1", "text": "hi" }),
        ))
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "provider.user_turn");
        assert_eq!(events[0].payload["session_id"], "s1");
        assert_eq!(events[0].payload["text"], "hi");
    }

    #[test]
    fn start_session_carries_optional_context() {
        let events = decide(&command(
            CMD_START_SESSION,
            json!({ "session_id": "s1", "workspace": "/tmp/p", "model": null }),
        ))
        .unwrap();
        assert_eq!(events[0].kind, "session.start_requested");
        assert_eq!(events[0].payload["workspace"], "/tmp/p");
        // A null model is dropped rather than recorded as null.
        assert!(events[0].payload.get("model").is_none());
    }

    #[test]
    fn interrupt_produces_an_interrupt_event() {
        let events = decide(&command(CMD_INTERRUPT, json!({ "session_id": "s1" }))).unwrap();
        assert_eq!(events[0].kind, "session.interrupt_requested");
    }

    #[test]
    fn missing_or_empty_required_fields_are_rejected() {
        assert!(decide(&command(CMD_SEND_TURN, json!({ "text": "hi" }))).is_err());
        assert!(decide(&command(CMD_SEND_TURN, json!({ "session_id": "s1" }))).is_err());
        assert!(decide(&command(
            CMD_SEND_TURN,
            json!({ "session_id": "s1", "text": "  " })
        ))
        .is_err());
        assert!(decide(&command(CMD_START_SESSION, json!({}))).is_err());
    }

    #[test]
    fn unknown_command_kinds_are_rejected() {
        assert!(decide(&command("frobnicate", json!({}))).is_err());
    }
}

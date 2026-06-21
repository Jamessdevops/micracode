//! The canonical provider event model (PRD FR1).
//!
//! A provider driver speaks its own native event shape; the adapter normalizes
//! that shape into [`ProviderEvent`] so the rest of the system never sees a
//! Codex-specific payload. This is the one place a second provider (Claude,
//! Cursor, …) would have to map onto — keeping the abstraction "a thin internal
//! trait so providers *can* be re-added" (PRD §4).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A normalized event produced by a provider session.
///
/// `Unknown` preserves anything the adapter does not recognize so events are
/// never silently dropped — useful for the P0 debug pane and for snapshot tests
/// that pin the external Codex `proto` contract (PRD D1 / Risks).
///
/// `Deserialize` is derived alongside `Serialize` so the projection layer can
/// read these back out of the event log's JSON payload (PRD FR2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderEvent {
    /// The session is live; carries the provider's own session id.
    SessionStarted { session_id: String },
    /// A chunk of assistant-visible text.
    AssistantText { text: String },
    /// The agent requested a tool call.
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// The result of a tool call, correlated by `tool_use_id`.
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
    /// The turn finished. `result` is the final assistant text when present.
    TurnCompleted {
        result: Option<String>,
        is_error: bool,
    },
    /// A provider- or transport-level error surfaced to the UI.
    Error { message: String },
    /// An event the adapter did not recognize, preserved verbatim.
    Unknown { raw: Value },
}

impl ProviderEvent {
    /// The snake_case discriminant (`session_started`, `tool_use`, …). Used to
    /// build the domain-event kind (`provider.<discriminant>`) when these flow
    /// into the event store.
    pub fn discriminant(&self) -> &'static str {
        match self {
            ProviderEvent::SessionStarted { .. } => "session_started",
            ProviderEvent::AssistantText { .. } => "assistant_text",
            ProviderEvent::ToolUse { .. } => "tool_use",
            ProviderEvent::ToolResult { .. } => "tool_result",
            ProviderEvent::TurnCompleted { .. } => "turn_completed",
            ProviderEvent::Error { .. } => "error",
            ProviderEvent::Unknown { .. } => "unknown",
        }
    }
}

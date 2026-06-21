//! Normalize Claude Code CLI `stream-json` events into [`ProviderEvent`]s.
//!
//! Run headless as
//!
//! ```text
//! claude -p --output-format stream-json --input-format stream-json --verbose
//! ```
//!
//! Claude emits one JSON object per line. The shapes we map:
//!
//! - `{"type":"system","subtype":"init","session_id":"…", …}` — session ready.
//! - `{"type":"assistant","message":{"content":[ … blocks … ]}}` — assistant
//!   output: `text` blocks become assistant text, `tool_use` blocks become tool
//!   calls.
//! - `{"type":"user","message":{"content":[ … blocks … ]}}` — tool results fed
//!   back to the model: `tool_result` blocks become tool results.
//! - `{"type":"result","subtype":"success"|…,"result":"…","is_error":bool}` —
//!   the turn finished.
//!
//! Anything else is passed through as [`ProviderEvent::Unknown`]. Like the Codex
//! adapter this mapping is an external contract (PRD D1): the unit tests below
//! snapshot the shapes we depend on, so a CLI schema change fails loudly here
//! rather than corrupting downstream state. The contract is the documented
//! Claude Code stream-json schema; verify it against the installed `claude`
//! during P0 (none is installed on this machine).

use serde_json::Value;

use crate::event::ProviderEvent;

/// Normalizes one Claude `stream-json` event into zero or more canonical events.
pub struct ClaudeAdapter;

impl ClaudeAdapter {
    /// Map a single parsed `stream-json` line to canonical events.
    pub fn normalize(value: &Value) -> Vec<ProviderEvent> {
        match value.get("type").and_then(Value::as_str) {
            Some("system") => Self::system(value),
            Some("assistant") => Self::assistant(value),
            Some("user") => Self::user(value),
            Some("result") => Self::result(value),
            // Stream deltas, control messages, and any future type fall through
            // preserved.
            _ => vec![ProviderEvent::Unknown { raw: value.clone() }],
        }
    }

    /// The `system`/`init` line carries the session id → session started.
    fn system(value: &Value) -> Vec<ProviderEvent> {
        let is_init = value.get("subtype").and_then(Value::as_str) == Some("init");
        match (is_init, value.get("session_id").and_then(Value::as_str)) {
            (true, Some(session_id)) => vec![ProviderEvent::SessionStarted {
                session_id: session_id.to_string(),
            }],
            // Other system subtypes (e.g. status) carry no canonical meaning yet.
            _ => vec![ProviderEvent::Unknown { raw: value.clone() }],
        }
    }

    /// An assistant message: one event per content block we recognize.
    fn assistant(value: &Value) -> Vec<ProviderEvent> {
        let Some(blocks) = content_blocks(value) else {
            return vec![ProviderEvent::Unknown { raw: value.clone() }];
        };
        let mut events = Vec::new();
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        events.push(ProviderEvent::AssistantText {
                            text: text.to_string(),
                        });
                    }
                }
                Some("tool_use") => {
                    if let Some(id) = block.get("id").and_then(Value::as_str) {
                        events.push(ProviderEvent::ToolUse {
                            id: id.to_string(),
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string(),
                            input: block.get("input").cloned().unwrap_or(Value::Null),
                        });
                    }
                }
                // `thinking` and other block types carry no canonical event yet.
                _ => {}
            }
        }
        // A message with only unrecognized blocks is preserved so nothing is lost.
        if events.is_empty() {
            return vec![ProviderEvent::Unknown { raw: value.clone() }];
        }
        events
    }

    /// A user message replays tool results back to the model → tool results.
    fn user(value: &Value) -> Vec<ProviderEvent> {
        let Some(blocks) = content_blocks(value) else {
            return vec![ProviderEvent::Unknown { raw: value.clone() }];
        };
        let mut events = Vec::new();
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            events.push(ProviderEvent::ToolResult {
                tool_use_id: tool_use_id.to_string(),
                content: stringify_content(block.get("content")),
                is_error: block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
        if events.is_empty() {
            return vec![ProviderEvent::Unknown { raw: value.clone() }];
        }
        events
    }

    /// The `result` line ends the turn.
    fn result(value: &Value) -> Vec<ProviderEvent> {
        let is_error = value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                value.get("subtype").and_then(Value::as_str) != Some("success")
            });
        vec![ProviderEvent::TurnCompleted {
            result: value
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_string),
            is_error,
        }]
    }
}

/// Pull `message.content` as an array of blocks, if present.
fn content_blocks(value: &Value) -> Option<&Vec<Value>> {
    value.get("message")?.get("content")?.as_array()
}

/// Flatten a tool_result `content` (string, or an array of `{type:text,text}`
/// blocks) to a plain string so nothing is dropped.
fn stringify_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|b| match b.get("text").and_then(Value::as_str) {
                Some(t) => t.to_string(),
                None => b.to_string(),
            })
            .collect::<Vec<_>>()
            .join(""),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_init_becomes_session_started() {
        let evs = ClaudeAdapter::normalize(&json!({
            "type": "system",
            "subtype": "init",
            "session_id": "claude-abc",
            "tools": ["Bash"],
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::SessionStarted {
                session_id: "claude-abc".into()
            }]
        );
    }

    #[test]
    fn assistant_text_block_becomes_assistant_text() {
        let evs = ClaudeAdapter::normalize(&json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [{ "type": "text", "text": "hello" }] },
            "session_id": "claude-abc",
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::AssistantText {
                text: "hello".into()
            }]
        );
    }

    #[test]
    fn assistant_tool_use_block_becomes_tool_use() {
        let evs = ClaudeAdapter::normalize(&json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Bash",
                    "input": { "command": "ls" },
                }],
            },
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::ToolUse {
                id: "toolu_1".into(),
                name: "Bash".into(),
                input: json!({ "command": "ls" }),
            }]
        );
    }

    #[test]
    fn assistant_mixed_blocks_yield_one_event_each() {
        let evs = ClaudeAdapter::normalize(&json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "let me look" },
                    { "type": "tool_use", "id": "toolu_2", "name": "Read", "input": { "path": "x" } },
                ],
            },
        }));
        assert_eq!(
            evs,
            vec![
                ProviderEvent::AssistantText {
                    text: "let me look".into()
                },
                ProviderEvent::ToolUse {
                    id: "toolu_2".into(),
                    name: "Read".into(),
                    input: json!({ "path": "x" }),
                },
            ]
        );
    }

    #[test]
    fn user_tool_result_block_becomes_tool_result() {
        let evs = ClaudeAdapter::normalize(&json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "file contents",
                    "is_error": false,
                }],
            },
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::ToolResult {
                tool_use_id: "toolu_1".into(),
                content: "file contents".into(),
                is_error: false,
            }]
        );
    }

    #[test]
    fn user_tool_result_with_block_array_content_is_flattened() {
        let evs = ClaudeAdapter::normalize(&json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_3",
                    "content": [{ "type": "text", "text": "out" }],
                    "is_error": true,
                }],
            },
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::ToolResult {
                tool_use_id: "toolu_3".into(),
                content: "out".into(),
                is_error: true,
            }]
        );
    }

    #[test]
    fn result_success_becomes_turn_completed() {
        let evs = ClaudeAdapter::normalize(&json!({
            "type": "result",
            "subtype": "success",
            "result": "done",
            "is_error": false,
            "session_id": "claude-abc",
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::TurnCompleted {
                result: Some("done".into()),
                is_error: false,
            }]
        );
    }

    #[test]
    fn result_error_subtype_is_an_error_turn() {
        let evs = ClaudeAdapter::normalize(&json!({
            "type": "result",
            "subtype": "error_max_turns",
            "session_id": "claude-abc",
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::TurnCompleted {
                result: None,
                is_error: true,
            }]
        );
    }

    #[test]
    fn unrecognized_type_is_preserved_as_unknown() {
        let raw = json!({ "type": "stream_event", "event": { "type": "ping" } });
        let evs = ClaudeAdapter::normalize(&raw);
        assert_eq!(evs, vec![ProviderEvent::Unknown { raw }]);
    }
}

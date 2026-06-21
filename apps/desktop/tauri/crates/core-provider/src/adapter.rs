//! Normalize Codex CLI `proto` events into [`ProviderEvent`]s.
//!
//! `codex proto` emits one JSON object per line, each an envelope
//! `{"id":"<submission id>","msg":{"type":"…", …}}`. We map the `msg` shapes we
//! care about and pass anything else through as [`ProviderEvent::Unknown`].
//! Treat this mapping as an external contract (PRD D1): the unit tests below
//! snapshot the shapes we depend on, so a CLI schema change fails loudly here
//! rather than corrupting downstream state.

use serde_json::Value;

use crate::event::ProviderEvent;

/// Normalizes one provider-native event into zero or more canonical events.
pub struct CodexAdapter;

impl CodexAdapter {
    /// Map a single parsed `proto` event to canonical events. Accepts either the
    /// full `{id, msg}` envelope or a bare `msg` object.
    pub fn normalize(value: &Value) -> Vec<ProviderEvent> {
        // Unwrap the submission envelope when present.
        let msg = value.get("msg").unwrap_or(value);

        match msg.get("type").and_then(Value::as_str) {
            Some("session_configured") => Self::session_configured(msg, value),
            Some("agent_message") => Self::agent_message(msg, value),
            Some("exec_command_begin") => Self::exec_begin(msg, value),
            Some("exec_command_end") => Self::exec_end(msg, value),
            Some("mcp_tool_call_begin") => Self::mcp_begin(msg, value),
            Some("mcp_tool_call_end") => Self::mcp_end(msg, value),
            Some("task_complete") => Self::task_complete(msg),
            Some("error") => Self::error(msg),
            // Deltas, reasoning, token counts, approval requests, task_started,
            // and any future type fall through preserved.
            _ => vec![ProviderEvent::Unknown { raw: value.clone() }],
        }
    }

    /// `{"type":"session_configured","session_id":"…"}` → session started.
    fn session_configured(msg: &Value, raw: &Value) -> Vec<ProviderEvent> {
        match msg.get("session_id").and_then(Value::as_str) {
            Some(session_id) => vec![ProviderEvent::SessionStarted {
                session_id: session_id.to_string(),
            }],
            None => vec![ProviderEvent::Unknown { raw: raw.clone() }],
        }
    }

    /// `{"type":"agent_message","message":"…"}` → a chunk of assistant text.
    fn agent_message(msg: &Value, raw: &Value) -> Vec<ProviderEvent> {
        match msg.get("message").and_then(Value::as_str) {
            Some(text) => vec![ProviderEvent::AssistantText {
                text: text.to_string(),
            }],
            None => vec![ProviderEvent::Unknown { raw: raw.clone() }],
        }
    }

    /// `{"type":"exec_command_begin","call_id":"…","command":[…],"cwd":"…"}`
    /// → a shell tool call.
    fn exec_begin(msg: &Value, raw: &Value) -> Vec<ProviderEvent> {
        let Some(call_id) = msg.get("call_id").and_then(Value::as_str) else {
            return vec![ProviderEvent::Unknown { raw: raw.clone() }];
        };
        vec![ProviderEvent::ToolUse {
            id: call_id.to_string(),
            name: "exec".to_string(),
            input: serde_json::json!({
                "command": msg.get("command").cloned().unwrap_or(Value::Null),
                "cwd": msg.get("cwd").cloned().unwrap_or(Value::Null),
            }),
        }]
    }

    /// `{"type":"exec_command_end","call_id":"…","exit_code":N,"stdout":"…",
    /// "stderr":"…"}` → the shell tool's result.
    fn exec_end(msg: &Value, raw: &Value) -> Vec<ProviderEvent> {
        let Some(call_id) = msg.get("call_id").and_then(Value::as_str) else {
            return vec![ProviderEvent::Unknown { raw: raw.clone() }];
        };
        let exit_code = msg.get("exit_code").and_then(Value::as_i64);
        // Prefer the merged stream when present, else stdout + stderr.
        let content = match msg.get("aggregated_output").and_then(Value::as_str) {
            Some(s) => s.to_string(),
            None => {
                let stdout = msg.get("stdout").and_then(Value::as_str).unwrap_or_default();
                let stderr = msg.get("stderr").and_then(Value::as_str).unwrap_or_default();
                format!("{stdout}{stderr}")
            }
        };
        vec![ProviderEvent::ToolResult {
            tool_use_id: call_id.to_string(),
            content,
            is_error: exit_code.map(|c| c != 0).unwrap_or(false),
        }]
    }

    /// `{"type":"mcp_tool_call_begin","call_id":"…","invocation":{…}}` → an MCP
    /// tool call.
    fn mcp_begin(msg: &Value, raw: &Value) -> Vec<ProviderEvent> {
        let Some(call_id) = msg.get("call_id").and_then(Value::as_str) else {
            return vec![ProviderEvent::Unknown { raw: raw.clone() }];
        };
        let invocation = msg.get("invocation");
        let name = invocation
            .and_then(|i| i.get("tool"))
            .and_then(Value::as_str)
            .unwrap_or("mcp")
            .to_string();
        let input = invocation
            .and_then(|i| i.get("arguments"))
            .cloned()
            .unwrap_or(Value::Null);
        vec![ProviderEvent::ToolUse {
            id: call_id.to_string(),
            name,
            input,
        }]
    }

    /// `{"type":"mcp_tool_call_end","call_id":"…","result":{…}}` → an MCP tool
    /// result.
    fn mcp_end(msg: &Value, raw: &Value) -> Vec<ProviderEvent> {
        let Some(call_id) = msg.get("call_id").and_then(Value::as_str) else {
            return vec![ProviderEvent::Unknown { raw: raw.clone() }];
        };
        let result = msg.get("result");
        // Codex reports failure either as `{"error": …}` or an `is_error` flag.
        let is_error = result
            .and_then(|r| r.get("is_error").and_then(Value::as_bool))
            .unwrap_or_else(|| result.map(|r| r.get("error").is_some()).unwrap_or(false));
        vec![ProviderEvent::ToolResult {
            tool_use_id: call_id.to_string(),
            content: stringify_result(result),
            is_error,
        }]
    }

    /// `{"type":"task_complete","last_agent_message":"…"}` → the turn finished.
    fn task_complete(msg: &Value) -> Vec<ProviderEvent> {
        vec![ProviderEvent::TurnCompleted {
            result: msg
                .get("last_agent_message")
                .and_then(Value::as_str)
                .map(str::to_string),
            is_error: false,
        }]
    }

    /// `{"type":"error","message":"…"}` → a turn-level error.
    fn error(msg: &Value) -> Vec<ProviderEvent> {
        vec![ProviderEvent::Error {
            message: msg
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown codex error")
                .to_string(),
        }]
    }
}

/// Flatten an MCP tool `result` to a plain string. A string is used verbatim;
/// anything else is serialized as JSON so nothing is dropped.
fn stringify_result(result: Option<&Value>) -> String {
    match result {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_configured_becomes_session_started() {
        let evs = CodexAdapter::normalize(&json!({
            "id": "0",
            "msg": { "type": "session_configured", "session_id": "sess-abc" },
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::SessionStarted {
                session_id: "sess-abc".into()
            }]
        );
    }

    #[test]
    fn agent_message_becomes_assistant_text() {
        let evs = CodexAdapter::normalize(&json!({
            "id": "1",
            "msg": { "type": "agent_message", "message": "hello" },
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::AssistantText {
                text: "hello".into()
            }]
        );
    }

    #[test]
    fn exec_command_begin_becomes_tool_use() {
        let evs = CodexAdapter::normalize(&json!({
            "id": "1",
            "msg": {
                "type": "exec_command_begin",
                "call_id": "call_1",
                "command": ["bash", "-lc", "ls"],
                "cwd": "/work",
            },
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::ToolUse {
                id: "call_1".into(),
                name: "exec".into(),
                input: json!({ "command": ["bash", "-lc", "ls"], "cwd": "/work" }),
            }]
        );
    }

    #[test]
    fn exec_command_end_nonzero_exit_is_an_error_result() {
        let evs = CodexAdapter::normalize(&json!({
            "id": "1",
            "msg": {
                "type": "exec_command_end",
                "call_id": "call_1",
                "exit_code": 2,
                "stdout": "out",
                "stderr": "boom",
            },
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::ToolResult {
                tool_use_id: "call_1".into(),
                content: "outboom".into(),
                is_error: true,
            }]
        );
    }

    #[test]
    fn mcp_tool_call_round_trips_use_and_result() {
        let begin = CodexAdapter::normalize(&json!({
            "id": "1",
            "msg": {
                "type": "mcp_tool_call_begin",
                "call_id": "mcp_1",
                "invocation": { "server": "fs", "tool": "read_file",
                                "arguments": { "path": "src/lib.rs" } },
            },
        }));
        assert_eq!(
            begin,
            vec![ProviderEvent::ToolUse {
                id: "mcp_1".into(),
                name: "read_file".into(),
                input: json!({ "path": "src/lib.rs" }),
            }]
        );

        let end = CodexAdapter::normalize(&json!({
            "id": "1",
            "msg": {
                "type": "mcp_tool_call_end",
                "call_id": "mcp_1",
                "result": "file contents",
            },
        }));
        assert_eq!(
            end,
            vec![ProviderEvent::ToolResult {
                tool_use_id: "mcp_1".into(),
                content: "file contents".into(),
                is_error: false,
            }]
        );
    }

    #[test]
    fn task_complete_becomes_turn_completed() {
        let evs = CodexAdapter::normalize(&json!({
            "id": "1",
            "msg": { "type": "task_complete", "last_agent_message": "done" },
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
    fn error_becomes_error_event() {
        let evs = CodexAdapter::normalize(&json!({
            "id": "1",
            "msg": { "type": "error", "message": "kaboom" },
        }));
        assert_eq!(
            evs,
            vec![ProviderEvent::Error {
                message: "kaboom".into()
            }]
        );
    }

    #[test]
    fn unrecognized_type_is_preserved_as_unknown() {
        let raw = json!({ "id": "1", "msg": { "type": "token_count", "input_tokens": 5 } });
        let evs = CodexAdapter::normalize(&raw);
        assert_eq!(evs, vec![ProviderEvent::Unknown { raw }]);
    }
}

//! Read-model projections over the event log (PRD FR2).
//!
//! The event store is the source of truth; this crate folds its append-only
//! `provider.*` domain events into the structured shapes the UI renders —
//! **threads → turns → messages**. A [`Projection`] is pure and deterministic:
//! the same event sequence always yields the same state, so it can be rebuilt
//! from the log at any time ([`Projection::rebuild_from`]) and kept live by
//! applying each new event as it is appended ([`Projection::apply`]).
//!
//! Input events are produced by the provider pump as
//! `{ kind: "provider.<discriminant>", payload: { session_id, event } }`, plus
//! two domain events the orchestration layer records directly:
//! `provider.user_turn` (the user's message) and `provider.session_closed`
//! (the session ended). The `event` field carries a serialized
//! [`ProviderEvent`]. The thread-deletion reactor additionally records
//! `thread.deleted`, which removes a thread from the model entirely.

use std::collections::HashMap;

use core_persistence::StoredEvent;
use core_provider::ProviderEvent;
use serde::Serialize;
use serde_json::Value;

/// Lifecycle of a conversation thread (one provider session).
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Active,
    Closed,
}

/// Lifecycle of a single turn within a thread.
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Running,
    Completed,
    Error,
}

/// A single item in a turn's transcript. `role` discriminates the variant.
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    /// The user's prompt that opened the turn.
    User { text: String },
    /// A chunk of assistant-visible text.
    Assistant { text: String },
    /// A tool call. `result`/`is_error` are filled in when the matching
    /// `tool_result` (correlated by `id`) arrives.
    Tool {
        id: String,
        name: String,
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        result: Option<String>,
        is_error: bool,
    },
}

/// One user prompt and the assistant's response to it.
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
pub struct Turn {
    /// Position of this turn within its thread (0-based).
    #[ts(type = "number")]
    pub index: usize,
    pub status: TurnStatus,
    pub messages: Vec<Message>,
    /// The final assistant result text, set on completion when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<String>,
}

/// A conversation thread: one provider session and its turns.
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
pub struct Thread {
    /// Local session id (our routing id; the key clients address).
    pub id: String,
    /// Codex's own session id, learned from `session_started`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider_session_id: Option<String>,
    /// Filesystem path of the workspace/folder this session was opened in,
    /// learned from `session.start_requested`. Lets list views group threads
    /// by folder (PRD FR2). `None` for threads started without an explicit
    /// workspace (the default `OPENER_APPS_DIR`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace: Option<String>,
    pub status: ThreadStatus,
    pub turns: Vec<Turn>,
    /// Global `seq` of the last event applied to this thread.
    #[ts(type = "number")]
    pub last_seq: u64,
}

/// A lightweight thread row for list views (no turn bodies).
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
pub struct ThreadSummary {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider_session_id: Option<String>,
    /// Workspace/folder path this thread was opened in; lets the list group by
    /// folder. `None` when started without an explicit workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace: Option<String>,
    pub status: ThreadStatus,
    #[ts(type = "number")]
    pub turn_count: usize,
    #[ts(type = "number")]
    pub last_seq: u64,
}

/// The folded read model. Cheap to clone for read-only snapshots.
#[derive(Debug, Default, Clone)]
pub struct Projection {
    threads: HashMap<String, Thread>,
    /// Thread ids in first-seen order, for stable listing.
    order: Vec<String>,
    /// Global `seq` of the last event applied. Guards against replays.
    cursor: u64,
}

impl Projection {
    /// The cursor (last applied global `seq`). Used to re-sync after a lag.
    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    /// Build a projection by folding events in order (PRD: rebuildable from log).
    pub fn rebuild_from(events: &[StoredEvent]) -> Self {
        let mut projection = Projection::default();
        for event in events {
            projection.apply(event);
        }
        projection
    }

    /// Fold one event into the model. Events at or before the cursor are
    /// ignored, so applying the same event twice (e.g. a backlog/live overlap)
    /// is a no-op — the fold is idempotent over `seq`.
    pub fn apply(&mut self, event: &StoredEvent) {
        if event.seq <= self.cursor {
            return;
        }
        self.cursor = event.seq;

        let Some(session_id) = event.payload.get("session_id").and_then(Value::as_str) else {
            return; // not a session-scoped event; nothing to project
        };
        let session_id = session_id.to_string();

        match event.kind.as_str() {
            // The session-start command (PRD FR2) leads each thread in the log
            // and carries the resolved workspace path. Recording it here lets
            // list views group threads by the folder they were opened in, and
            // creates the thread row before its first turn.
            "session.start_requested" => {
                let workspace = event
                    .payload
                    .get("workspace")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let thread = self.thread_mut(&session_id);
                thread.last_seq = event.seq;
                if workspace.is_some() {
                    thread.workspace = workspace;
                }
            }
            "provider.user_turn" => {
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let thread = self.thread_mut(&session_id);
                thread.last_seq = event.seq;
                let index = thread.turns.len();
                thread.turns.push(Turn {
                    index,
                    status: TurnStatus::Running,
                    messages: vec![Message::User { text }],
                    result: None,
                });
            }
            "provider.session_closed" => {
                if let Some(thread) = self.threads.get_mut(&session_id) {
                    thread.status = ThreadStatus::Closed;
                    thread.last_seq = event.seq;
                }
            }
            // The thread-deletion reactor recorded a teardown (PRD FR3): drop
            // the thread so it leaves both the list and detail views. Durable
            // via the log, so a rebuild replays the removal.
            "thread.deleted" => {
                self.threads.remove(&session_id);
                self.order.retain(|id| id != &session_id);
            }
            // Any other `provider.*` event carries a normalized ProviderEvent
            // under `payload.event`.
            kind if kind.starts_with("provider.") => {
                if let Some(provider_event) = event
                    .payload
                    .get("event")
                    .and_then(|v| serde_json::from_value::<ProviderEvent>(v.clone()).ok())
                {
                    self.apply_provider_event(&session_id, event.seq, provider_event);
                }
            }
            // Non-provider domain events don't affect the conversation model.
            _ => {}
        }
    }

    fn apply_provider_event(&mut self, session_id: &str, seq: u64, event: ProviderEvent) {
        let thread = self.thread_mut(session_id);
        thread.last_seq = seq;
        match event {
            ProviderEvent::SessionStarted {
                session_id: provider_session_id,
            } => {
                thread.provider_session_id = Some(provider_session_id);
                // A session can start more than once on a thread when it is
                // resumed (PRD FR1); reopen a previously-closed thread so its
                // continued turns render as active.
                thread.status = ThreadStatus::Active;
            }
            ProviderEvent::AssistantText { text } => {
                current_turn(thread).messages.push(Message::Assistant { text });
            }
            ProviderEvent::ToolUse { id, name, input } => {
                current_turn(thread).messages.push(Message::Tool {
                    id,
                    name,
                    input,
                    result: None,
                    is_error: false,
                });
            }
            ProviderEvent::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                // Correlate to the pending tool call in the current turn.
                if let Some(turn) = thread.turns.last_mut() {
                    for message in turn.messages.iter_mut() {
                        if let Message::Tool {
                            id,
                            result,
                            is_error: result_is_error,
                            ..
                        } = message
                        {
                            if *id == tool_use_id {
                                *result = Some(content);
                                *result_is_error = is_error;
                                break;
                            }
                        }
                    }
                }
            }
            ProviderEvent::TurnCompleted { result, is_error } => {
                if let Some(turn) = thread.turns.last_mut() {
                    turn.status = if is_error {
                        TurnStatus::Error
                    } else {
                        TurnStatus::Completed
                    };
                    turn.result = result;
                }
            }
            ProviderEvent::Error { message } => {
                let turn = current_turn(thread);
                turn.status = TurnStatus::Error;
                turn.result = Some(message);
            }
            // Preserved-but-unrecognized provider events don't shape the model.
            ProviderEvent::Unknown { .. } => {}
        }
    }

    /// The thread for `session_id`, creating it on first reference.
    fn thread_mut(&mut self, session_id: &str) -> &mut Thread {
        if !self.threads.contains_key(session_id) {
            self.order.push(session_id.to_string());
            self.threads.insert(
                session_id.to_string(),
                Thread {
                    id: session_id.to_string(),
                    provider_session_id: None,
                    workspace: None,
                    status: ThreadStatus::Active,
                    turns: Vec::new(),
                    last_seq: 0,
                },
            );
        }
        self.threads.get_mut(session_id).expect("just inserted")
    }

    /// A thread by id, if it exists.
    pub fn thread(&self, id: &str) -> Option<&Thread> {
        self.threads.get(id)
    }

    /// All threads as summaries, in first-seen order.
    pub fn summaries(&self) -> Vec<ThreadSummary> {
        self.order
            .iter()
            .filter_map(|id| self.threads.get(id))
            .map(|thread| ThreadSummary {
                id: thread.id.clone(),
                provider_session_id: thread.provider_session_id.clone(),
                workspace: thread.workspace.clone(),
                status: thread.status.clone(),
                turn_count: thread.turns.len(),
                last_seq: thread.last_seq,
            })
            .collect()
    }
}

/// The turn assistant output appends to: the last open turn, or a fresh one if
/// assistant events arrive before any `user_turn` (defensive — keeps output
/// from being dropped).
fn current_turn(thread: &mut Thread) -> &mut Turn {
    if thread.turns.is_empty() {
        thread.turns.push(Turn {
            index: 0,
            status: TurnStatus::Running,
            messages: Vec::new(),
            result: None,
        });
    }
    thread.turns.last_mut().expect("non-empty")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Build a `provider.*` log event the way the provider pump does.
    fn provider_event(seq: u64, session_id: &str, event: Value) -> StoredEvent {
        let kind = format!(
            "provider.{}",
            event.get("type").and_then(Value::as_str).unwrap()
        );
        StoredEvent {
            seq,
            kind,
            payload: json!({ "session_id": session_id, "event": event }),
        }
    }

    fn start_requested(seq: u64, session_id: &str, workspace: &str) -> StoredEvent {
        StoredEvent {
            seq,
            kind: "session.start_requested".into(),
            payload: json!({ "session_id": session_id, "workspace": workspace }),
        }
    }

    fn user_turn(seq: u64, session_id: &str, text: &str) -> StoredEvent {
        StoredEvent {
            seq,
            kind: "provider.user_turn".into(),
            payload: json!({ "session_id": session_id, "text": text }),
        }
    }

    fn session_closed(seq: u64, session_id: &str) -> StoredEvent {
        StoredEvent {
            seq,
            kind: "provider.session_closed".into(),
            payload: json!({ "session_id": session_id }),
        }
    }

    fn thread_deleted(seq: u64, session_id: &str) -> StoredEvent {
        StoredEvent {
            seq,
            kind: "thread.deleted".into(),
            payload: json!({ "session_id": session_id, "thread_id": session_id }),
        }
    }

    #[test]
    fn folds_a_full_session_into_a_thread_with_turns_and_messages() {
        let log = vec![
            user_turn(1, "s1", "read lib.rs"),
            provider_event(2, "s1", json!({ "type": "session_started", "session_id": "claude-1" })),
            provider_event(3, "s1", json!({ "type": "assistant_text", "text": "on it" })),
            provider_event(
                4,
                "s1",
                json!({ "type": "tool_use", "id": "tu1", "name": "read_file", "input": { "path": "lib.rs" } }),
            ),
            provider_event(
                5,
                "s1",
                json!({ "type": "tool_result", "tool_use_id": "tu1", "content": "fn main() {}", "is_error": false }),
            ),
            provider_event(6, "s1", json!({ "type": "turn_completed", "result": "done", "is_error": false })),
            session_closed(7, "s1"),
        ];

        let projection = Projection::rebuild_from(&log);
        assert_eq!(projection.cursor(), 7);

        let thread = projection.thread("s1").expect("thread exists");
        assert_eq!(thread.provider_session_id.as_deref(), Some("claude-1"));
        assert_eq!(thread.status, ThreadStatus::Closed);
        assert_eq!(thread.turns.len(), 1);

        let turn = &thread.turns[0];
        assert_eq!(turn.status, TurnStatus::Completed);
        assert_eq!(turn.result.as_deref(), Some("done"));
        assert_eq!(
            turn.messages,
            vec![
                Message::User { text: "read lib.rs".into() },
                Message::Assistant { text: "on it".into() },
                Message::Tool {
                    id: "tu1".into(),
                    name: "read_file".into(),
                    input: json!({ "path": "lib.rs" }),
                    result: Some("fn main() {}".into()),
                    is_error: false,
                },
            ]
        );
    }

    #[test]
    fn second_user_turn_opens_a_new_turn() {
        let log = vec![
            user_turn(1, "s1", "hello"),
            provider_event(2, "s1", json!({ "type": "assistant_text", "text": "hi" })),
            provider_event(3, "s1", json!({ "type": "turn_completed", "result": "hi", "is_error": false })),
            user_turn(4, "s1", "again"),
            provider_event(5, "s1", json!({ "type": "assistant_text", "text": "yes" })),
        ];

        let projection = Projection::rebuild_from(&log);
        let thread = projection.thread("s1").unwrap();
        assert_eq!(thread.turns.len(), 2);
        assert_eq!(thread.turns[0].status, TurnStatus::Completed);
        assert_eq!(thread.turns[1].status, TurnStatus::Running);
        assert_eq!(
            thread.turns[1].messages,
            vec![
                Message::User { text: "again".into() },
                Message::Assistant { text: "yes".into() },
            ]
        );
    }

    #[test]
    fn resuming_a_closed_thread_reopens_it_and_appends_turns() {
        let log = vec![
            user_turn(1, "s1", "hello"),
            provider_event(2, "s1", json!({ "type": "session_started", "session_id": "claude-1" })),
            provider_event(3, "s1", json!({ "type": "turn_completed", "result": "hi", "is_error": false })),
            session_closed(4, "s1"),
            // The same thread is resumed: a new session start, then a new turn.
            provider_event(5, "s1", json!({ "type": "session_started", "session_id": "claude-2" })),
            user_turn(6, "s1", "again"),
            provider_event(7, "s1", json!({ "type": "assistant_text", "text": "still here" })),
        ];

        let projection = Projection::rebuild_from(&log);
        let thread = projection.thread("s1").unwrap();
        // Reopened, with the resumed provider session id and both turns intact.
        assert_eq!(thread.status, ThreadStatus::Active);
        assert_eq!(thread.provider_session_id.as_deref(), Some("claude-2"));
        assert_eq!(thread.turns.len(), 2);
        assert_eq!(thread.turns[0].status, TurnStatus::Completed);
        assert_eq!(
            thread.turns[1].messages,
            vec![
                Message::User { text: "again".into() },
                Message::Assistant { text: "still here".into() },
            ]
        );
    }

    #[test]
    fn deleting_a_thread_removes_it_from_the_model() {
        let log = vec![
            user_turn(1, "s1", "a"),
            user_turn(2, "s2", "b"),
            // s1 is torn down by the thread-deletion reactor.
            thread_deleted(3, "s1"),
        ];

        let projection = Projection::rebuild_from(&log);
        // Gone from detail and from the (ordered) list; s2 is untouched.
        assert!(projection.thread("s1").is_none());
        let summaries = projection.summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "s2");
    }

    #[test]
    fn deleting_an_unknown_thread_is_a_noop() {
        let mut projection = Projection::default();
        projection.apply(&thread_deleted(1, "ghost"));
        assert!(projection.summaries().is_empty());
        assert_eq!(projection.cursor(), 1);
    }

    #[test]
    fn apply_is_idempotent_over_seq() {
        let event = user_turn(1, "s1", "hello");
        let mut projection = Projection::default();
        projection.apply(&event);
        projection.apply(&event); // replay — must not duplicate
        assert_eq!(projection.thread("s1").unwrap().turns.len(), 1);
        assert_eq!(projection.cursor(), 1);
    }

    #[test]
    fn summaries_list_threads_in_first_seen_order() {
        let log = vec![
            user_turn(1, "s1", "a"),
            user_turn(2, "s2", "b"),
            provider_event(3, "s1", json!({ "type": "assistant_text", "text": "x" })),
        ];
        let projection = Projection::rebuild_from(&log);
        let summaries = projection.summaries();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].id, "s1");
        assert_eq!(summaries[0].turn_count, 1);
        assert_eq!(summaries[0].status, ThreadStatus::Active);
        assert_eq!(summaries[1].id, "s2");
    }

    #[test]
    fn start_requested_records_the_workspace_and_leads_the_thread() {
        let log = vec![
            start_requested(1, "s1", "/Users/me/projects/foo"),
            user_turn(2, "s1", "hi"),
        ];
        let projection = Projection::rebuild_from(&log);

        // The thread exists from the start event (before its first turn) and
        // carries the folder it was opened in, on both the detail and summary.
        let thread = projection.thread("s1").expect("thread exists");
        assert_eq!(thread.workspace.as_deref(), Some("/Users/me/projects/foo"));
        let summaries = projection.summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].workspace.as_deref(), Some("/Users/me/projects/foo"));
    }

    #[test]
    fn threads_without_a_start_event_have_no_workspace() {
        let projection = Projection::rebuild_from(&[user_turn(1, "s1", "hi")]);
        assert_eq!(projection.thread("s1").unwrap().workspace, None);
        assert_eq!(projection.summaries()[0].workspace, None);
    }

    #[test]
    fn turn_error_result_marks_the_turn() {
        let log = vec![
            user_turn(1, "s1", "go"),
            provider_event(2, "s1", json!({ "type": "turn_completed", "result": null, "is_error": true })),
        ];
        let projection = Projection::rebuild_from(&log);
        assert_eq!(projection.thread("s1").unwrap().turns[0].status, TurnStatus::Error);
    }
}

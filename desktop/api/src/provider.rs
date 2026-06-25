//! Session registry that bridges the provider slice to the event-sourced core.
//!
//! `start_session` spawns a Codex session via [`CodexDriver`], keeps its
//! control [`SessionHandle`] for routing turns, and pumps the session's
//! normalized [`ProviderEvent`]s into the [`EventStore`](core_persistence) as
//! domain events. Because those appends publish on the store's hot stream, the
//! events flow straight out over the existing `/v1/events` SSE transport — one
//! ordered push path to the UI (PRD G3/FR5).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use core_orchestration::{Command, Engine, Reactor, ReceiptBus, RuntimeReceipt};
use core_persistence::DomainEvent;
use core_provider::{
    ClaudeDriver, CodexDriver, Harness, PermissionMode, ProviderDriver, ProviderError,
    ProviderEvent, SessionHandle, SessionOptions,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::decider;
use crate::reaper::SessionRegistry;

/// A unit of work for the checkpoint reactor: snapshot `workspace` after a turn
/// and record it against `session_id` in the event log (PRD FR3/FR6).
struct CheckpointJob {
    engine: Arc<Engine>,
    workspace: PathBuf,
    session_id: String,
}

/// A unit of work for the runtime-ingestion reactor (PRD FR3): append one
/// normalized provider event to the log off the subprocess pump. Routing the
/// pump's appends through a single-writer reactor makes ingestion ordered and
/// drainable — the pump can wait for it to settle at shutdown without sleeping.
struct IngestionJob {
    engine: Arc<Engine>,
    kind: String,
    payload: Value,
    /// Present iff this event completes a turn: the post-turn checkpoint to
    /// hand on *after* the turn's events are durably in the log, so
    /// `provider.turn_completed` always precedes `checkpoint.captured`.
    checkpoint: Option<CheckpointJob>,
}

/// A unit of work for the thread-deletion reactor (PRD FR3): stop the thread's
/// session if it is still running, then record a `thread.deleted` fact so the
/// projection drops it. Deleting off the request path keeps subprocess teardown
/// (which can block) from stalling the HTTP handler.
struct ThreadDeletionJob {
    engine: Arc<Engine>,
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    registry: Arc<SessionRegistry>,
    thread_id: String,
}

/// A prior session's launch context, reconstructed from the event log so it can
/// be resumed (PRD FR1).
struct RecoveredSession {
    workspace: PathBuf,
    model: Option<String>,
    /// Which agent the session ran on, so resume re-launches the same one.
    harness: Harness,
    /// The permission mode the session ran under, so resume re-applies it.
    permission: PermissionMode,
    /// The agent's own session id, if the session ever reported one. Required to
    /// actually resume the conversation (the resume mechanism is harness-specific).
    provider_session_id: Option<String>,
}

pub struct ProviderManager {
    /// The two agent drivers; [`spawn`](Self::spawn) picks one per session from
    /// [`SessionOptions::harness`] (PRD §4).
    codex: CodexDriver,
    claude: ClaudeDriver,
    /// The event-sourced core. Every session event — and the user turns that
    /// drive them — is appended here, making the log the single writer for the
    /// conversation timeline the projection folds (PRD FR2/G3).
    engine: Arc<Engine>,
    /// Live sessions keyed by our local session id (distinct from Codex's own
    /// `session_id`, which arrives later via a `provider.session_started` event).
    /// Shared with each session's pump task, which evicts its entry when the
    /// session ends — so membership tracks *currently running* sessions, which
    /// is what resume consults to avoid double-spawning (PRD FR1).
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    /// Completion receipts for background work (PRD FR3). Per-turn checkpoint
    /// capture publishes here so callers can wait for a turn to fully settle
    /// instead of polling.
    receipts: ReceiptBus,
    /// Single-writer reactor that captures per-turn checkpoints off the event
    /// pump and emits receipts when each settles (PRD FR3).
    checkpoints: Reactor<CheckpointJob>,
    /// Single-writer reactor that ingests the pump's normalized provider events
    /// into the log in order, triggering per-turn checkpoints as turns complete
    /// (PRD FR3 — runtime ingestion).
    ingestion: Reactor<IngestionJob>,
    /// Single-writer reactor that tears down deleted threads off the request
    /// path: stop the session, then record the deletion (PRD FR3).
    deletions: Reactor<ThreadDeletionJob>,
    /// Persists live subprocess pids so orphans are reaped on the next startup
    /// (PRD FR1). Disabled by default; opt in with [`with_session_registry`].
    registry: Arc<SessionRegistry>,
}

impl ProviderManager {
    /// Build a manager backed by `codex` for Codex sessions and a default
    /// `claude` driver for Claude sessions. Override the latter with
    /// [`with_claude_driver`](Self::with_claude_driver). Must be called from
    /// within a Tokio runtime — it spawns the checkpoint reactor's worker task.
    pub fn new(codex: CodexDriver, engine: Arc<Engine>) -> Self {
        let receipts = ReceiptBus::new();
        let checkpoints = Reactor::spawn(receipts.clone(), checkpoint_handler);
        // Ingestion hands completed turns to the checkpoint reactor, so it
        // captures a clone of that handle. Built after `checkpoints` for that.
        let ingestion = {
            let checkpoints = checkpoints.clone();
            Reactor::spawn(receipts.clone(), move |job: IngestionJob| {
                let checkpoints = checkpoints.clone();
                async move { ingestion_handler(job, &checkpoints).await }
            })
        };
        let deletions = Reactor::spawn(receipts.clone(), thread_deletion_handler);
        ProviderManager {
            codex,
            claude: ClaudeDriver::default(),
            engine,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            receipts,
            checkpoints,
            ingestion,
            deletions,
            registry: Arc::new(SessionRegistry::disabled()),
        }
    }

    /// Enable orphan reaping by backing the manager with a persistent pid
    /// registry. The caller is responsible for [`SessionRegistry::sweep`]ing it
    /// once at startup before any session is started.
    pub fn with_session_registry(mut self, registry: SessionRegistry) -> Self {
        self.registry = Arc::new(registry);
        self
    }

    /// Override the driver used for Claude sessions (e.g. to point at a
    /// `CLAUDE_BIN` other than the default `claude`).
    pub fn with_claude_driver(mut self, claude: ClaudeDriver) -> Self {
        self.claude = claude;
        self
    }

    /// Subscribe to runtime completion receipts (PRD FR3). Used by orchestration
    /// and tests for deterministic idle detection.
    pub fn receipts(&self) -> ReceiptBus {
        self.receipts.clone()
    }

    /// Dispatch a command through the event-sourced engine, logging (but not
    /// propagating) a rejection. Routing every command-side action through the
    /// engine — rather than appending to the store directly — keeps the decider
    /// the single validation point and the log the single writer (PRD FR2).
    fn dispatch(&self, kind: &str, payload: Value) {
        let command = Command {
            id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            payload,
        };
        if let Err(e) = self.engine.dispatch(command) {
            tracing::warn!("`{kind}` command rejected: {e}");
        }
    }

    /// Start a fresh session, register its handle, and spawn the event pump.
    /// Returns the local session id used to route subsequent turns.
    pub async fn start_session(&self, opts: SessionOptions) -> Result<String, ProviderError> {
        let session_id = Uuid::new_v4().to_string();
        self.spawn(session_id, opts).await
    }

    /// Resume a previously-closed session, continuing its conversation thread
    /// (PRD FR1). The prior session's workspace, model, and Codex session id are
    /// recovered from the event log — the only inputs a caller needs is the local
    /// session id of the thread to resume.
    ///
    /// Reuses that same local id so resumed turns append to the existing thread.
    /// Returns:
    /// - `Ok(Some(id))` — resumed (or already running, in which case nothing is
    ///   re-spawned);
    /// - `Ok(None)` — no such session, or it never reached a resumable state
    ///   (never reported a Codex session id).
    pub async fn resume_session(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, ProviderError> {
        // Already running: resuming is a no-op — route to the live session.
        if self.sessions.lock().await.contains_key(session_id) {
            return Ok(Some(session_id.to_string()));
        }

        let Some(prior) = self.recover_session(session_id) else {
            return Ok(None);
        };
        let Some(provider_session_id) = prior.provider_session_id else {
            return Ok(None); // started but never resumable
        };

        let opts = SessionOptions {
            workspace: prior.workspace,
            model: prior.model,
            resume: Some(provider_session_id),
            harness: prior.harness,
            permission: prior.permission,
        };
        self.spawn(session_id.to_string(), opts).await.map(Some)
    }

    /// Spawn a provider session under an explicit local `session_id`, register
    /// its handle, record the start command, and pump its events into the log.
    /// Shared by [`start_session`](Self::start_session) (fresh id) and
    /// [`resume_session`](Self::resume_session) (reused id).
    async fn spawn(
        &self,
        session_id: String,
        opts: SessionOptions,
    ) -> Result<String, ProviderError> {
        // Keep the workspace path so the pump can checkpoint it per turn (FR6).
        let workspace = opts.workspace.clone();
        let model = opts.model.clone();
        let harness = opts.harness;
        let permission = opts.permission;
        // Pick the agent driver for this session (PRD §4). Both yield the same
        // `Session`, so everything below is harness-blind.
        let session = match harness {
            Harness::Codex => self.codex.start_session(opts).await?,
            Harness::Claude => self.claude.start_session(opts).await?,
        };
        let (handle, mut events) = session.into_parts();

        // Register the subprocess for orphan reaping before it can do anything
        // (PRD FR1); forgotten again when the session ends or is stopped.
        let pid = handle.pid();
        if let Some(pid) = pid {
            self.registry.record(pid);
        }

        // Record the start command before the pump can append any provider
        // events, so `session.start_requested` leads this thread in the log.
        self.dispatch(
            decider::CMD_START_SESSION,
            json!({
                "session_id": session_id,
                "workspace": workspace.to_string_lossy(),
                "model": model,
                "harness": harness.as_str(),
                "permission": permission.as_str(),
            }),
        );

        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), Arc::new(handle));

        let pump_id = session_id.clone();
        let engine = Arc::clone(&self.engine);
        let ingestion = self.ingestion.clone();
        let checkpoints = self.checkpoints.clone();
        let registry = Arc::clone(&self.registry);
        let sessions = Arc::clone(&self.sessions);
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                let turn_completed = matches!(event, ProviderEvent::TurnCompleted { .. });
                let kind = format!("provider.{}", event.discriminant());
                let payload = json!({
                    "session_id": pump_id,
                    "event": serde_json::to_value(&event).unwrap_or(Value::Null),
                });
                // A completed turn carries the post-turn checkpoint so the
                // ingestion reactor enqueues it only *after* this event is in
                // the log (PRD FR3/FR6) — that ordering keeps
                // `checkpoint.captured` after `provider.turn_completed`.
                let checkpoint = turn_completed.then(|| CheckpointJob {
                    engine: Arc::clone(&engine),
                    workspace: workspace.clone(),
                    session_id: pump_id.clone(),
                });
                // Ingest off the pump through the single-writer ingestion
                // reactor (PRD FR3): appends stay ordered and become drainable
                // for a deterministic, sleep-free shutdown below.
                ingestion.enqueue(IngestionJob {
                    engine: Arc::clone(&engine),
                    kind,
                    payload,
                    checkpoint,
                });
            }
            // Stdout closed → the session ended. Drain ingestion first so every
            // provider event is in the log (and any final checkpoint has been
            // handed to the checkpoint reactor), then drain checkpoints, so the
            // log stays ordered (`checkpoint.captured` precedes
            // `session_closed`). Deterministic via the reactors' idle signals —
            // no sleeps (PRD FR3).
            ingestion.drain_to_idle().await;
            checkpoints.drain_to_idle().await;
            let _ = engine.store().append(vec![DomainEvent::new(
                "provider.session_closed",
                json!({ "session_id": pump_id }),
            )]);
            if let Some(pid) = pid {
                registry.forget(pid);
            }
            // Drop the now-dead handle so the session map tracks only running
            // sessions — resume relies on this to tell closed from live.
            sessions.lock().await.remove(&pump_id);
        });

        Ok(session_id)
    }

    /// Recover a prior session's launch context from the event log: its
    /// workspace and model (from the latest `session.start_requested`) and
    /// Codex's own session id (from the latest `provider.session_started`).
    /// Returns `None` if the log has no record of the session.
    fn recover_session(&self, session_id: &str) -> Option<RecoveredSession> {
        let log = self.engine.store().read_from(0).ok()?;
        let mut recovered: Option<RecoveredSession> = None;

        for event in &log {
            if event.payload.get("session_id").and_then(Value::as_str) != Some(session_id) {
                continue;
            }
            match event.kind.as_str() {
                "session.start_requested" => {
                    let workspace = event
                        .payload
                        .get("workspace")
                        .and_then(Value::as_str)
                        .map(PathBuf::from)
                        .unwrap_or_default();
                    let model = event
                        .payload
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let harness = Harness::from_token(
                        event.payload.get("harness").and_then(Value::as_str),
                    );
                    let permission = PermissionMode::from_token(
                        event.payload.get("permission").and_then(Value::as_str),
                    );
                    // Latest start wins; carry forward any id learned so far.
                    let provider_session_id =
                        recovered.as_ref().and_then(|r| r.provider_session_id.clone());
                    recovered = Some(RecoveredSession {
                        workspace,
                        model,
                        harness,
                        permission,
                        provider_session_id,
                    });
                }
                "provider.session_started" => {
                    if let Some(id) = event
                        .payload
                        .get("event")
                        .and_then(|e| e.get("session_id"))
                        .and_then(Value::as_str)
                    {
                        if let Some(r) = recovered.as_mut() {
                            r.provider_session_id = Some(id.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
        recovered
    }

    async fn handle(&self, session_id: &str) -> Option<Arc<SessionHandle>> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    /// Send a user turn. `Ok(false)` means the session id is unknown.
    ///
    /// The turn is recorded in the event log *before* it is routed to the CLI,
    /// so the user's message always precedes the assistant output it provokes
    /// in the single ordered log the projection reads (PRD FR2).
    pub async fn send_turn(&self, session_id: &str, text: &str) -> Result<bool, ProviderError> {
        let Some(handle) = self.handle(session_id).await else {
            return Ok(false);
        };
        // The user turn is recorded as a command through the engine, which the
        // decider turns into the `provider.user_turn` event the projection folds.
        self.dispatch(
            decider::CMD_SEND_TURN,
            json!({ "session_id": session_id, "text": text }),
        );
        handle.send_turn(text).await?;
        Ok(true)
    }

    /// Interrupt the running turn. `Ok(false)` means the session id is unknown.
    pub async fn interrupt(&self, session_id: &str) -> Result<bool, ProviderError> {
        let Some(handle) = self.handle(session_id).await else {
            return Ok(false);
        };
        self.dispatch(
            decider::CMD_INTERRUPT,
            json!({ "session_id": session_id }),
        );
        handle.interrupt().await?;
        Ok(true)
    }

    /// Stop a session and reap its subprocess. `Ok(false)` if id is unknown.
    pub async fn stop(&self, session_id: &str) -> Result<bool, ProviderError> {
        let Some(handle) = self.sessions.lock().await.remove(session_id) else {
            return Ok(false);
        };
        // We're reaping it ourselves, so drop it from the orphan registry.
        if let Some(pid) = handle.pid() {
            self.registry.forget(pid);
        }
        handle.stop().await?;
        Ok(true)
    }

    /// Delete a thread: enqueue its teardown on the thread-deletion reactor
    /// (PRD FR3). Off the request path, the reactor stops the session if it is
    /// still running and appends a `thread.deleted` fact; the projection then
    /// drops the thread, and a [`RuntimeReceipt::ThreadDeleted`] marks
    /// completion. Returns `false` only if the reactor has stopped.
    pub fn delete_thread(&self, thread_id: &str) -> bool {
        self.deletions.enqueue(ThreadDeletionJob {
            engine: Arc::clone(&self.engine),
            sessions: Arc::clone(&self.sessions),
            registry: Arc::clone(&self.registry),
            thread_id: thread_id.to_string(),
        })
    }
}

/// The checkpoint reactor's handler: capture a post-turn snapshot (blocking Git
/// I/O, offloaded to `spawn_blocking`) and report what settled via receipts.
///
/// [`RuntimeReceipt::TurnQuiescent`] is emitted unconditionally — the turn is
/// settled whether or not it changed files — so a caller waiting on quiescence
/// never hangs on a no-op or failed capture (PRD FR3).
async fn checkpoint_handler(job: CheckpointJob) -> Vec<RuntimeReceipt> {
    let CheckpointJob {
        engine,
        workspace,
        session_id,
    } = job;
    let sid = session_id.clone();
    let captured = tokio::task::spawn_blocking(move || {
        crate::vcs::capture_if_changed(&engine, &workspace, None, Some(&session_id), "post-turn")
    })
    .await;

    let mut receipts = Vec::new();
    match captured {
        Ok(Ok(Some(checkpoint))) => {
            receipts.push(RuntimeReceipt::CheckpointCaptured {
                session_id: Some(sid.clone()),
                checkpoint_id: Some(checkpoint.id),
            });
            receipts.push(RuntimeReceipt::DiffFinalized {
                session_id: Some(sid.clone()),
            });
        }
        Ok(Ok(None)) => {} // no-op turn: nothing to checkpoint
        Ok(Err(e)) => tracing::warn!("post-turn checkpoint failed for session {sid}: {e}"),
        Err(e) => tracing::warn!("checkpoint task panicked for session {sid}: {e}"),
    }
    receipts.push(RuntimeReceipt::TurnQuiescent { session_id: sid });
    receipts
}

/// The runtime-ingestion reactor's handler (PRD FR3): append one normalized
/// provider event to the log, then — if it completed a turn — hand the
/// post-turn snapshot to the checkpoint reactor. Enqueuing the checkpoint only
/// here, after the append, is what guarantees `provider.turn_completed` lands
/// before its `checkpoint.captured`. Ingestion emits no receipt of its own; the
/// turn's settledness is signalled by the checkpoint reactor's `TurnQuiescent`.
async fn ingestion_handler(
    job: IngestionJob,
    checkpoints: &Reactor<CheckpointJob>,
) -> Vec<RuntimeReceipt> {
    let IngestionJob {
        engine,
        kind,
        payload,
        checkpoint,
    } = job;
    // A failed append must not wedge ingestion; the store logs it.
    let _ = engine.store().append(vec![DomainEvent::new(kind, payload)]);
    if let Some(checkpoint) = checkpoint {
        checkpoints.enqueue(checkpoint);
    }
    Vec::new()
}

/// The thread-deletion reactor's handler (PRD FR3): stop the thread's session
/// if it is still live (so deletion never orphans a subprocess), then append a
/// `thread.deleted` fact the projection folds into a thread removal. The fact
/// is appended directly, like other runtime facts (`checkpoint.captured`,
/// `session_closed`) — it records what the runtime did, not a user command.
async fn thread_deletion_handler(job: ThreadDeletionJob) -> Vec<RuntimeReceipt> {
    let ThreadDeletionJob {
        engine,
        sessions,
        registry,
        thread_id,
    } = job;

    // Take the live handle (if any) out of the session map under the lock, then
    // stop it without holding the lock.
    let handle = sessions.lock().await.remove(&thread_id);
    if let Some(handle) = handle {
        if let Some(pid) = handle.pid() {
            registry.forget(pid);
        }
        if let Err(e) = handle.stop().await {
            tracing::warn!("stopping session {thread_id} during deletion failed: {e}");
        }
    }

    let _ = engine.store().append(vec![DomainEvent::new(
        "thread.deleted",
        json!({ "session_id": thread_id, "thread_id": thread_id }),
    )]);
    vec![RuntimeReceipt::ThreadDeleted { thread_id }]
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use core_persistence::EventStore;
    use std::os::unix::fs::PermissionsExt;

    fn write_mock_codex(dir: &std::path::Path) -> std::path::PathBuf {
        let script = dir.join("mock-codex.sh");
        std::fs::write(
            &script,
            r#"#!/usr/bin/env bash
read -r _submission
printf '%s\n' '{"id":"0","msg":{"type":"session_configured","session_id":"mock-xyz"}}'
printf '%s\n' '{"id":"1","msg":{"type":"agent_message","message":"ok"}}'
printf '%s\n' '{"id":"1","msg":{"type":"task_complete","last_agent_message":"ok"}}'
"#,
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    /// A started session's normalized events land in the event log as
    /// `provider.*` domain events, terminated by `provider.session_closed`.
    #[tokio::test]
    async fn session_events_are_appended_to_the_event_log() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_mock_codex(dir.path());

        let store = EventStore::open_in_memory().unwrap();
        let engine = Arc::new(Engine::new(store, crate::decider::decide));
        let manager = ProviderManager::new(
            core_provider::CodexDriver::with_program(script),
            Arc::clone(&engine),
        );

        let session_id = manager
            .start_session(SessionOptions {
                workspace: dir.path().to_path_buf(),
                model: None,
                resume: None,
                harness: Harness::Codex,
                permission: Default::default(),
            })
            .await
            .expect("session starts");

        assert!(manager.send_turn(&session_id, "hi").await.unwrap());

        // The pump runs on its own task; wait for the terminal marker.
        let kinds = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let log = engine.store().read_from(0).unwrap();
                if log.iter().any(|e| e.kind == "provider.session_closed") {
                    return log.into_iter().map(|e| e.kind).collect::<Vec<_>>();
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("session closed within timeout");

        assert_eq!(
            kinds,
            vec![
                // Starting the session records the command first (PRD FR2), so
                // the thread's first log entry is the start request.
                "session.start_requested",
                // The user turn is recorded before it's routed to the CLI, so it
                // leads the log ahead of the assistant output it provokes.
                "provider.user_turn",
                "provider.session_started",
                "provider.assistant_text",
                "provider.turn_completed",
                // A per-turn checkpoint is captured once the turn finishes,
                // before the session is retired (PRD FR6).
                "checkpoint.captured",
                "provider.session_closed",
            ]
        );

        // Events carry the routing session id.
        let log = engine.store().read_from(0).unwrap();
        assert_eq!(log[0].payload["session_id"], session_id);
        assert_eq!(log[1].payload["session_id"], session_id);
        assert_eq!(log[1].payload["text"], "hi");
        assert_eq!(
            log[2].payload["event"]["session_id"], "mock-xyz",
            "Codex's own session id is preserved in the normalized event"
        );
    }

    /// A turn settles deterministically: subscribing to the receipt bus and
    /// waiting for `TurnQuiescent` replaces sleeps/polling (PRD FR3). When that
    /// receipt arrives the per-turn checkpoint is already in the log, because
    /// the reactor decrements its pending count only after emitting receipts.
    #[tokio::test]
    async fn turn_quiescent_receipt_signals_a_settled_turn() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_mock_codex(dir.path());

        let store = EventStore::open_in_memory().unwrap();
        let engine = Arc::new(Engine::new(store, crate::decider::decide));
        let manager = ProviderManager::new(
            core_provider::CodexDriver::with_program(script),
            Arc::clone(&engine),
        );

        let mut receipts = manager.receipts().subscribe();

        let session_id = manager
            .start_session(SessionOptions {
                workspace: dir.path().to_path_buf(),
                model: None,
                resume: None,
                harness: Harness::Codex,
                permission: Default::default(),
            })
            .await
            .expect("session starts");
        assert!(manager.send_turn(&session_id, "hi").await.unwrap());

        // Wait for the turn to go quiescent — no sleeps.
        let quiescent = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match receipts.recv().await.unwrap() {
                    core_orchestration::RuntimeReceipt::TurnQuiescent { session_id } => {
                        return session_id
                    }
                    _ => continue,
                }
            }
        })
        .await
        .expect("turn went quiescent within timeout");
        assert_eq!(quiescent, session_id);

        // The checkpoint for the turn is already durably in the log by the time
        // the quiescence receipt is observed.
        let log = engine.store().read_from(0).unwrap();
        assert!(
            log.iter().any(|e| e.kind == "checkpoint.captured"),
            "checkpoint is captured before the turn is reported quiescent"
        );
    }

    /// A mock that appends its argv to `codex-args.log` in its cwd (the
    /// workspace) on every spawn, so a test can assert the resume flag is passed.
    fn write_arg_logging_mock(dir: &std::path::Path) -> std::path::PathBuf {
        let script = dir.join("mock-codex.sh");
        std::fs::write(
            &script,
            r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> codex-args.log
read -r _submission
printf '%s\n' '{"id":"0","msg":{"type":"session_configured","session_id":"mock-xyz"}}'
printf '%s\n' '{"id":"1","msg":{"type":"agent_message","message":"ok"}}'
printf '%s\n' '{"id":"1","msg":{"type":"task_complete","last_agent_message":"ok"}}'
"#,
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    /// Block until the event log contains a `provider.session_closed` for `id`.
    async fn await_closed(engine: &Arc<Engine>, id: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let log = engine.store().read_from(0).unwrap();
                if log.iter().any(|e| {
                    e.kind == "provider.session_closed"
                        && e.payload.get("session_id").and_then(Value::as_str) == Some(id)
                }) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("session closed within timeout");
    }

    /// Resuming a closed session continues the same thread: it reuses the local
    /// id, relaunches the CLI with `experimental_resume="<codex session id>"`
    /// recovered from the log, and the new turn appends to the existing thread
    /// (PRD FR1).
    #[tokio::test]
    async fn resume_reuses_the_thread_and_passes_the_resume_flag() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_arg_logging_mock(dir.path());

        let store = EventStore::open_in_memory().unwrap();
        let engine = Arc::new(Engine::new(store, crate::decider::decide));
        let manager = ProviderManager::new(
            core_provider::CodexDriver::with_program(script),
            Arc::clone(&engine),
        );

        // First run: drive a turn and let the session close.
        let session_id = manager
            .start_session(SessionOptions {
                workspace: dir.path().to_path_buf(),
                model: None,
                resume: None,
                harness: Harness::Codex,
                permission: Default::default(),
            })
            .await
            .expect("session starts");
        assert!(manager.send_turn(&session_id, "hi").await.unwrap());
        await_closed(&engine, &session_id).await;

        // Resume: keep calling until the second CLI invocation is observed (the
        // first pump may not have evicted the closed session from the live map
        // yet, in which case resume is a no-op and we retry).
        let args_log = dir.path().join("codex-args.log");
        let resumed_id = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let id = manager
                    .resume_session(&session_id)
                    .await
                    .expect("resume ok")
                    .expect("session is resumable");
                let runs = std::fs::read_to_string(&args_log).unwrap_or_default();
                if runs.lines().count() >= 2 {
                    return id;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("resumed within timeout");

        // Resume reuses the same local id, so turns continue the same thread.
        assert_eq!(resumed_id, session_id);

        // The relaunch carried the resume config with Codex's own session id.
        let runs: Vec<String> = std::fs::read_to_string(&args_log)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert!(
            !runs[0].contains("experimental_resume"),
            "the initial launch is not a resume"
        );
        assert!(
            runs[1].contains("experimental_resume=\"mock-xyz\""),
            "the relaunch resumes Codex's session id, got: {}",
            runs[1]
        );

        // Drive a turn on the resumed session.
        assert!(manager.send_turn(&session_id, "again").await.unwrap());

        // Both turns landed in the one thread, under the same session id. (The
        // first close is already in the log, so we wait on the turn count, not
        // on another `session_closed`.)
        let user_turns = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let texts: Vec<String> = engine
                    .store()
                    .read_from(0)
                    .unwrap()
                    .iter()
                    .filter(|e| {
                        e.kind == "provider.user_turn"
                            && e.payload.get("session_id").and_then(Value::as_str)
                                == Some(&session_id)
                    })
                    .filter_map(|e| {
                        e.payload
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect();
                if texts.len() >= 2 {
                    return texts;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("both turns logged within timeout");
        assert_eq!(user_turns, vec!["hi".to_string(), "again".to_string()]);
    }

    /// Deleting a thread tears down its live session and records a
    /// `thread.deleted` fact, signalled by a `ThreadDeleted` receipt (PRD FR3).
    #[tokio::test]
    async fn deleting_a_thread_stops_the_session_and_records_the_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_mock_codex(dir.path());

        let store = EventStore::open_in_memory().unwrap();
        let engine = Arc::new(Engine::new(store, crate::decider::decide));
        let manager = ProviderManager::new(
            core_provider::CodexDriver::with_program(script),
            Arc::clone(&engine),
        );

        let mut receipts = manager.receipts().subscribe();

        // The mock blocks on its first `read`, so the session stays live until
        // we delete it — exercising the stop-a-running-session path.
        let session_id = manager
            .start_session(SessionOptions {
                workspace: dir.path().to_path_buf(),
                model: None,
                resume: None,
                harness: Harness::Codex,
                permission: Default::default(),
            })
            .await
            .expect("session starts");

        assert!(manager.delete_thread(&session_id), "deletion enqueued");

        // Wait for the deletion to settle — no sleeps.
        let deleted = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let RuntimeReceipt::ThreadDeleted { thread_id } = receipts.recv().await.unwrap() {
                    return thread_id;
                }
            }
        })
        .await
        .expect("thread deleted within timeout");
        assert_eq!(deleted, session_id);

        // The deletion is durable in the log, and the live-session map no longer
        // tracks it.
        let log = engine.store().read_from(0).unwrap();
        assert!(log.iter().any(|e| {
            e.kind == "thread.deleted"
                && e.payload.get("thread_id").and_then(Value::as_str) == Some(&session_id)
        }));
        assert!(!manager.sessions.lock().await.contains_key(&session_id));
    }

    /// Resuming an unknown session reports "not resumable" rather than spawning.
    #[tokio::test]
    async fn resuming_an_unknown_session_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_mock_codex(dir.path());
        let store = EventStore::open_in_memory().unwrap();
        let engine = Arc::new(Engine::new(store, crate::decider::decide));
        let manager = ProviderManager::new(
            core_provider::CodexDriver::with_program(script),
            Arc::clone(&engine),
        );

        let resumed = manager.resume_session("no-such-session").await.unwrap();
        assert!(resumed.is_none());
    }
}

//! The provider driver: spawn an agent CLI and frame its stdio (PRD FR1, D1).
//!
//! Two agents are supported — the Codex CLI (`codex proto`) and the Claude Code
//! CLI (`claude … --input-format stream-json`). Both run as a long-lived
//! **submission/event queue** over stdio: they read newline-delimited submissions
//! on stdin and write newline-delimited events on stdout. The per-agent
//! differences (launch flags, stdin framing, event shapes) live entirely in
//! [`Harness`](crate::harness); this module is the harness-blind plumbing that
//! spawns the child, pumps stdout through the harness's normalizer into a channel
//! of canonical [`ProviderEvent`]s, and hands back a [`SessionHandle`] for sending
//! turns and tearing down. `kill_on_drop` makes the child a child of RAII —
//! dropping the handle reaps the subprocess (PRD §3).
//!
//! NOTE: each agent's submission/event schema is an external contract (PRD D1),
//! pinned by the adapters' snapshot tests; verify them against the installed CLIs
//! during P0.

use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};

use crate::harness::Harness;
use crate::event::ProviderEvent;

/// Capacity of the per-session normalized-event channel.
const EVENT_CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("failed to spawn provider `{program}`: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("session stdin is closed")]
    StdinClosed,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, ProviderError>;

/// How to launch a Codex provider binary. The program is configurable so tests
/// can point at a mock subprocess instead of a real `codex` install.
#[derive(Debug, Clone)]
pub struct CodexConfig {
    pub program: OsString,
    /// Extra args appended after the standard `proto` flags. Use these to
    /// override the headless defaults (approval/sandbox policy) if needed.
    pub extra_args: Vec<String>,
}

impl Default for CodexConfig {
    fn default() -> Self {
        CodexConfig {
            program: OsString::from(Harness::Codex.default_program()),
            extra_args: Vec::new(),
        }
    }
}

/// How to launch a Claude Code provider binary. Mirrors [`CodexConfig`].
#[derive(Debug, Clone)]
pub struct ClaudeConfig {
    pub program: OsString,
    /// Extra args appended after the standard headless flags.
    pub extra_args: Vec<String>,
}

impl Default for ClaudeConfig {
    fn default() -> Self {
        ClaudeConfig {
            program: OsString::from(Harness::Claude.default_program()),
            extra_args: Vec::new(),
        }
    }
}

/// Options for a single session.
#[derive(Debug, Clone)]
pub struct SessionOptions {
    /// Working directory the agent operates in.
    pub workspace: PathBuf,
    /// Optional model override.
    pub model: Option<String>,
    /// Resume a prior conversation by the agent's own session id (PRD FR1).
    /// `None` starts fresh. The resume mechanism is harness-specific — see
    /// [`Harness::command_args`].
    pub resume: Option<String>,
    /// Which agent CLI backs this session (PRD §4).
    pub harness: Harness,
}

/// A provider driver: the seam each agent implements (PRD §4). Both built-in
/// drivers yield the same [`Session`] so the wiring layer stays harness-blind.
pub trait ProviderDriver {
    type Session;

    fn start_session(
        &self,
        opts: SessionOptions,
    ) -> impl Future<Output = Result<Self::Session>> + Send;
}

/// The Codex CLI driver.
pub struct CodexDriver {
    config: CodexConfig,
}

impl CodexDriver {
    pub fn new(config: CodexConfig) -> Self {
        CodexDriver { config }
    }

    /// Convenience: a driver that launches `program` (used by tests with a mock).
    pub fn with_program(program: impl Into<OsString>) -> Self {
        CodexDriver::new(CodexConfig {
            program: program.into(),
            extra_args: Vec::new(),
        })
    }
}

impl ProviderDriver for CodexDriver {
    type Session = Session;

    fn start_session(&self, opts: SessionOptions) -> impl Future<Output = Result<Session>> + Send {
        spawn_session(
            self.config.program.clone(),
            Harness::Codex,
            self.config.extra_args.clone(),
            opts,
        )
    }
}

/// The Claude Code CLI driver.
pub struct ClaudeDriver {
    config: ClaudeConfig,
}

impl ClaudeDriver {
    pub fn new(config: ClaudeConfig) -> Self {
        ClaudeDriver { config }
    }

    /// Convenience: a driver that launches `program` (used by tests with a mock).
    pub fn with_program(program: impl Into<OsString>) -> Self {
        ClaudeDriver::new(ClaudeConfig {
            program: program.into(),
            extra_args: Vec::new(),
        })
    }
}

impl Default for ClaudeDriver {
    fn default() -> Self {
        ClaudeDriver::new(ClaudeConfig::default())
    }
}

impl ProviderDriver for ClaudeDriver {
    type Session = Session;

    fn start_session(&self, opts: SessionOptions) -> impl Future<Output = Result<Session>> + Send {
        spawn_session(
            self.config.program.clone(),
            Harness::Claude,
            self.config.extra_args.clone(),
            opts,
        )
    }
}

/// Spawn `program` for `harness`, frame its stdio, and return a live [`Session`].
/// The harness drives every per-agent decision (launch flags, stdin framing,
/// event normalization), so this body is identical for Codex and Claude.
async fn spawn_session(
    program: OsString,
    harness: Harness,
    extra_args: Vec<String>,
    opts: SessionOptions,
) -> Result<Session> {
    let mut cmd = Command::new(&program);
    cmd.args(harness.command_args(&opts));
    for arg in &extra_args {
        cmd.arg(arg);
    }
    cmd.current_dir(&opts.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|source| ProviderError::Spawn {
        program: program.to_string_lossy().into_owned(),
        source,
    })?;

    // Captured at spawn time so the wiring layer can register it for orphan
    // reaping on the next startup (PRD FR1).
    let pid = child.id();

    // Both are present because we requested piped stdio above.
    let stdout = child.stdout.take().expect("stdout piped");
    let stdin = child.stdin.take().expect("stdin piped");

    let (tx, rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
    tokio::spawn(pump_stdout(stdout, harness, tx));

    Ok(Session {
        handle: SessionHandle {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(child),
            pid,
            next_submission_id: AtomicU64::new(0),
            harness,
        },
        events: rx,
    })
}

/// Read stdout line by line, normalize each JSON line through `harness`, and
/// forward the events. Stops when stdout closes (turn/session ended) or the
/// receiver is dropped.
async fn pump_stdout(
    stdout: tokio::process::ChildStdout,
    harness: Harness,
    tx: mpsc::Sender<ProviderEvent>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let events = match serde_json::from_str::<Value>(trimmed) {
                    Ok(value) => harness.normalize(&value),
                    Err(err) => vec![ProviderEvent::Error {
                        message: format!("unparsable {} event line: {err}", harness.as_str()),
                    }],
                };
                for event in events {
                    if tx.send(event).await.is_err() {
                        return; // consumer gone
                    }
                }
            }
            Ok(None) => return, // EOF
            Err(err) => {
                let _ = tx
                    .send(ProviderEvent::Error {
                        message: format!("stdout read error: {err}"),
                    })
                    .await;
                return;
            }
        }
    }
}

/// A live provider session: the control handle plus the normalized event stream.
pub struct Session {
    pub handle: SessionHandle,
    events: mpsc::Receiver<ProviderEvent>,
}

impl Session {
    /// Split into the control handle and the event receiver. The wiring layer
    /// keeps the handle (to route turns) and pumps the receiver into the event
    /// store on its own task.
    pub fn into_parts(self) -> (SessionHandle, mpsc::Receiver<ProviderEvent>) {
        (self.handle, self.events)
    }

    /// Receive the next normalized event, or `None` once the session ends.
    pub async fn recv(&mut self) -> Option<ProviderEvent> {
        self.events.recv().await
    }
}

/// Control surface for a running session: send turns, interrupt, stop. Harness-
/// blind — the stdin framing for each operation comes from [`Harness`].
pub struct SessionHandle {
    /// `None` once stdin has been closed (after `stop`).
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    /// OS process id of the subprocess, if the platform exposed one. Recorded so
    /// orphans (left behind by a hard parent crash, where `kill_on_drop` never
    /// runs) can be swept on the next startup.
    pid: Option<u32>,
    /// Monotonic id stamped on each submission. Some protocols (Codex) echo it
    /// back; it must be present and unique per submission regardless.
    next_submission_id: AtomicU64,
    /// The agent this session speaks to, source of all stdin framing.
    harness: Harness,
}

impl SessionHandle {
    /// The subprocess's OS process id, if available.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The agent backing this session.
    pub fn harness(&self) -> Harness {
        self.harness
    }

    /// Allocate the next unique submission id.
    fn submission_id(&self) -> String {
        self.next_submission_id
            .fetch_add(1, Ordering::Relaxed)
            .to_string()
    }

    /// Write one pre-framed submission line on stdin.
    async fn write_line(&self, line: &str) -> Result<()> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or(ProviderError::StdinClosed)?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Send a user turn.
    pub async fn send_turn(&self, text: &str) -> Result<()> {
        let line = self.harness.encode_turn(&self.submission_id(), text);
        self.write_line(&line).await
    }

    /// Interrupt the running turn. A no-op for harnesses without an inline
    /// interrupt (the caller can `stop` to halt them).
    pub async fn interrupt(&self) -> Result<()> {
        match self.harness.encode_interrupt(&self.submission_id()) {
            Some(line) => self.write_line(&line).await,
            None => Ok(()),
        }
    }

    /// Close stdin and reap the subprocess.
    pub async fn stop(&self) -> Result<()> {
        // Best-effort graceful shutdown submission before we drop stdin; ignore
        // failures (stdin may already be closed). Harnesses that shut down on EOF
        // produce no line here.
        if let Some(line) = self.harness.encode_shutdown(&self.submission_id()) {
            let _ = self.write_line(&line).await;
        }
        // Drop stdin so the CLI sees EOF, then make sure it's gone.
        *self.stdin.lock().await = None;
        self.child.lock().await.kill().await?;
        Ok(())
    }
}

//! A single PTY-backed terminal session (PRD FR7).
//!
//! [`Terminal::spawn`] opens a pseudo-terminal, launches a shell (or an
//! explicit command) attached to its slave end, and starts a dedicated reader
//! thread on the master. Each chunk the child writes is assigned a monotonic
//! `seq`, appended to a bounded scrollback, and published on a `broadcast`
//! channel. Viewers replay the scrollback then follow the live stream — the
//! same "backlog then live, dedupe by seq" pattern the event transport uses, so
//! a reconnecting terminal pane never loses or doubles output.
//!
//! The child is reaped when the [`Terminal`] is dropped (the writer/master are
//! released and the slave already was), or explicitly via [`Terminal::kill`].

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

/// Bytes of terminal output retained for replay to late/ reconnecting viewers.
/// Older chunks are dropped once the budget is exceeded (oldest first).
const MAX_SCROLLBACK_BYTES: usize = 256 * 1024;

/// Capacity of the live output broadcast. A viewer that lags past this gets a
/// `Lagged` error and resyncs from the scrollback — output is advisory to a
/// viewer, never a source of truth.
const OUTPUT_CHANNEL_CAPACITY: usize = 1024;

/// Size of each read from the PTY master.
const READ_BUF_SIZE: usize = 8 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("failed to open pty: {0}")]
    OpenPty(String),
    #[error("failed to spawn `{program}`: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("pty setup error: {0}")]
    Setup(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, TerminalError>;

/// How to launch a terminal.
#[derive(Debug, Clone)]
pub struct TerminalOptions {
    /// Working directory for the shell/command.
    pub workspace: PathBuf,
    /// Program to run. `None` launches the user's default login shell.
    pub command: Option<String>,
    /// Arguments passed to `command` (ignored when `command` is `None`).
    pub args: Vec<String>,
    /// Extra environment variables.
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

impl Default for TerminalOptions {
    fn default() -> Self {
        TerminalOptions {
            workspace: PathBuf::from("."),
            command: None,
            args: Vec::new(),
            env: Vec::new(),
            cols: 80,
            rows: 24,
        }
    }
}

/// One chunk of terminal output, tagged with its position in the stream.
#[derive(Debug, Clone)]
pub struct TerminalOutput {
    /// Monotonic, 0-based index of this chunk within the session.
    pub seq: u64,
    /// Raw bytes the child wrote (may end mid-UTF-8; callers re-assemble).
    pub bytes: Vec<u8>,
}

/// The bounded replay buffer shared between the reader thread and viewers.
struct Scrollback {
    chunks: VecDeque<TerminalOutput>,
    bytes: usize,
    next_seq: u64,
}

impl Scrollback {
    fn new() -> Self {
        Scrollback {
            chunks: VecDeque::new(),
            bytes: 0,
            next_seq: 0,
        }
    }

    /// Append a chunk, assign it a `seq`, and trim to the byte budget. The
    /// newest chunk is always kept even if it alone exceeds the budget.
    fn push(&mut self, bytes: Vec<u8>) -> TerminalOutput {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.bytes += bytes.len();
        let chunk = TerminalOutput { seq, bytes };
        self.chunks.push_back(chunk.clone());
        while self.bytes > MAX_SCROLLBACK_BYTES && self.chunks.len() > 1 {
            if let Some(dropped) = self.chunks.pop_front() {
                self.bytes -= dropped.bytes.len();
            }
        }
        chunk
    }

    fn snapshot(&self) -> Vec<TerminalOutput> {
        self.chunks.iter().cloned().collect()
    }
}

/// Output state shared with the reader thread.
struct Inner {
    output: tokio::sync::broadcast::Sender<TerminalOutput>,
    scrollback: Mutex<Scrollback>,
}

/// A live PTY session: read its output, write input, resize, and reap it.
pub struct Terminal {
    inner: Arc<Inner>,
    /// Held for `resize`. `MasterPty::resize` takes `&self`, but the trait
    /// object isn't `Sync`, so a `Mutex` makes the handle shareable.
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pid: Option<u32>,
}

impl Terminal {
    /// Open a PTY, launch the shell/command, and start streaming its output.
    pub fn spawn(opts: TerminalOptions) -> Result<Terminal> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows.max(1),
                cols: opts.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::OpenPty(e.to_string()))?;

        let program = opts
            .command
            .clone()
            .unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&program);
        cmd.cwd(&opts.workspace);
        if opts.command.is_some() {
            for arg in &opts.args {
                cmd.arg(arg);
            }
        }
        for (key, val) in &opts.env {
            cmd.env(key, val);
        }
        // A sane default so full-screen TUIs render; callers can override.
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|source| TerminalError::Spawn {
                program: program.clone(),
                source: std::io::Error::new(std::io::ErrorKind::Other, source.to_string()),
            })?;
        let pid = child.process_id();

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::Setup(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::Setup(e.to_string()))?;
        // Drop the slave so the master sees EOF once the child closes it; the
        // child keeps its own dup of the slave fd, so this doesn't kill it.
        drop(pair.slave);

        let (output, _) = tokio::sync::broadcast::channel(OUTPUT_CHANNEL_CAPACITY);
        let inner = Arc::new(Inner {
            output,
            scrollback: Mutex::new(Scrollback::new()),
        });

        let reader_inner = Arc::clone(&inner);
        // A blocking `Read` loop — PTYs have no async API on all platforms, so
        // it lives on its own OS thread rather than the Tokio runtime.
        std::thread::spawn(move || read_loop(reader, reader_inner));

        Ok(Terminal {
            inner,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pid,
        })
    }

    /// OS process id of the child, if the platform exposed one.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Subscribe to output produced *after* this call. Pair with
    /// [`scrollback`](Terminal::scrollback) (taken right after) to replay
    /// history first; dedupe the overlap by `seq`.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<TerminalOutput> {
        self.inner.output.subscribe()
    }

    /// A snapshot of the retained scrollback, oldest chunk first.
    pub fn scrollback(&self) -> Vec<TerminalOutput> {
        self.inner.scrollback.lock().unwrap().snapshot()
    }

    /// Write bytes to the terminal's input (keystrokes, pasted text).
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    /// Resize the PTY so the child reflows to the new viewport.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .unwrap()
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::Setup(e.to_string()))
    }

    /// Kill the child process. Idempotent — killing an already-dead child is Ok.
    pub fn kill(&self) -> Result<()> {
        self.child.lock().unwrap().kill()?;
        Ok(())
    }
}

/// Read the PTY master to EOF, buffering and broadcasting each chunk in order.
fn read_loop(mut reader: Box<dyn Read + Send>, inner: Arc<Inner>) {
    let mut buf = [0u8; READ_BUF_SIZE];
    loop {
        match reader.read(&mut buf) {
            // EOF: the child closed the PTY (it exited). Stop the thread.
            Ok(0) => break,
            Ok(n) => {
                let chunk = {
                    let mut scrollback = inner.scrollback.lock().unwrap();
                    scrollback.push(buf[..n].to_vec())
                };
                // No live viewers is fine — the chunk is already in scrollback.
                let _ = inner.output.send(chunk);
            }
            // A read error (e.g. the master was closed) also ends the stream.
            Err(_) => break,
        }
    }
}

/// The user's preferred interactive shell, falling back to a POSIX shell.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Collect output until `needle` is seen or the timeout elapses, returning
    /// everything read. Drains scrollback first, then the live stream.
    async fn read_until(term: &Terminal, needle: &str) -> String {
        let mut rx = term.subscribe();
        let mut acc = String::new();
        for chunk in term.scrollback() {
            acc.push_str(&String::from_utf8_lossy(&chunk.bytes));
        }
        if acc.contains(needle) {
            return acc;
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while let Ok(chunk) = rx.recv().await {
                acc.push_str(&String::from_utf8_lossy(&chunk.bytes));
                if acc.contains(needle) {
                    break;
                }
            }
        })
        .await;
        acc
    }

    #[tokio::test]
    async fn command_output_is_streamed() {
        let dir = tempfile::tempdir().unwrap();
        let term = Terminal::spawn(TerminalOptions {
            workspace: dir.path().to_path_buf(),
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "printf MICRA_OK".into()],
            ..Default::default()
        })
        .expect("spawn terminal");

        let out = read_until(&term, "MICRA_OK").await;
        assert!(out.contains("MICRA_OK"), "got: {out:?}");
    }

    #[tokio::test]
    async fn interactive_shell_echoes_written_input() {
        let dir = tempfile::tempdir().unwrap();
        let term = Terminal::spawn(TerminalOptions {
            workspace: dir.path().to_path_buf(),
            command: Some("/bin/sh".into()),
            args: vec!["-i".into()],
            ..Default::default()
        })
        .expect("spawn shell");

        term.write(b"echo MICRA_ECHO\n").expect("write input");
        let out = read_until(&term, "MICRA_ECHO").await;
        assert!(out.contains("MICRA_ECHO"), "got: {out:?}");
        term.kill().expect("kill");
    }

    #[tokio::test]
    async fn scrollback_replays_to_a_late_subscriber() {
        let dir = tempfile::tempdir().unwrap();
        let term = Terminal::spawn(TerminalOptions {
            workspace: dir.path().to_path_buf(),
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "printf REPLAY_ME".into()],
            ..Default::default()
        })
        .expect("spawn terminal");

        // Let the command finish and its output land in scrollback.
        let _ = read_until(&term, "REPLAY_ME").await;

        // A viewer that connects *after* the output still sees it via replay.
        let replayed: String = term
            .scrollback()
            .iter()
            .map(|c| String::from_utf8_lossy(&c.bytes).into_owned())
            .collect();
        assert!(replayed.contains("REPLAY_ME"), "got: {replayed:?}");
    }

    #[tokio::test]
    async fn resize_does_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let term = Terminal::spawn(TerminalOptions {
            workspace: dir.path().to_path_buf(),
            command: Some("/bin/sh".into()),
            args: vec!["-i".into()],
            ..Default::default()
        })
        .expect("spawn shell");
        term.resize(120, 40).expect("resize");
        term.kill().expect("kill");
    }
}

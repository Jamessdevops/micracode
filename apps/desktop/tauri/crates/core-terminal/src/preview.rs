//! Dev-server preview manager (PRD FR7).
//!
//! [`PreviewServer::spawn`] launches a project's dev server (e.g.
//! `npm run dev`) and then *discovers* the port it actually binds by scanning a
//! candidate list — dev servers commonly fall forward to the next free port, so
//! the configured port is a hint, not a guarantee. A background task drives the
//! lifecycle and publishes a [`PreviewStatus`] over a `watch` channel:
//!
//! ```text
//! Starting ──(port answers)──▶ Running { url, port } ──(child exits)──▶ Stopped
//!    │
//!    ├──(child exits first)──▶ Failed { message }
//!    └──(scan times out)─────▶ Failed { message }
//! ```
//!
//! The child is reaped on [`stop`](PreviewServer::stop) or when the server is
//! dropped (`kill_on_drop` plus a best-effort stop signal).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

/// Total time to wait for the dev server's port to start answering.
const SCAN_TIMEOUT: Duration = Duration::from_secs(60);
/// How often to re-scan the candidate ports.
const SCAN_INTERVAL: Duration = Duration::from_millis(300);
/// Per-port connection attempt timeout during a scan.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Debug, thiserror::Error)]
pub enum PreviewError {
    #[error("failed to spawn dev server `{program}`: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
}

pub type Result<T> = std::result::Result<T, PreviewError>;

/// Lifecycle of a preview's dev server. `state` discriminates the variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PreviewStatus {
    /// Spawned; waiting for a port to start answering.
    Starting,
    /// A candidate port answered — the preview is reachable at `url`.
    Running { url: String, port: u16 },
    /// The dev server exited (cleanly stopped, or after having run).
    Stopped,
    /// The dev server never became reachable (exited early or timed out).
    Failed { message: String },
}

/// How to launch and locate a dev server.
#[derive(Debug, Clone)]
pub struct PreviewOptions {
    pub workspace: PathBuf,
    /// Program to run, e.g. `npm`.
    pub command: String,
    /// Arguments, e.g. `["run", "dev"]`.
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Host to probe while scanning (usually `127.0.0.1`).
    pub scan_host: String,
    /// Candidate ports to scan, in priority order.
    pub ports: Vec<u16>,
    /// Host to put in the user-facing URL (usually `localhost`).
    pub url_host: String,
}

impl PreviewOptions {
    /// Defaults for a Next.js-style `npm run dev` on ports 3000–3009.
    pub fn npm_dev(workspace: PathBuf) -> Self {
        PreviewOptions {
            workspace,
            command: "npm".to_string(),
            args: vec!["run".to_string(), "dev".to_string()],
            env: Vec::new(),
            scan_host: "127.0.0.1".to_string(),
            ports: (3000..3010).collect(),
            url_host: "localhost".to_string(),
        }
    }
}

/// A running (or starting) dev-server preview.
pub struct PreviewServer {
    status: watch::Receiver<PreviewStatus>,
    /// Sends a stop request to the lifecycle task; consumed on first stop.
    stop: Mutex<Option<oneshot::Sender<()>>>,
    pid: Option<u32>,
}

impl PreviewServer {
    /// Spawn the dev server and begin scanning for its port.
    pub async fn spawn(opts: PreviewOptions) -> Result<PreviewServer> {
        let mut cmd = Command::new(&opts.command);
        cmd.args(&opts.args)
            .current_dir(&opts.workspace)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        for (key, val) in &opts.env {
            cmd.env(key, val);
        }

        let child = cmd.spawn().map_err(|source| PreviewError::Spawn {
            program: opts.command.clone(),
            source,
        })?;
        let pid = child.id();

        let (status_tx, status_rx) = watch::channel(PreviewStatus::Starting);
        let (stop_tx, stop_rx) = oneshot::channel();
        tokio::spawn(lifecycle(child, opts, status_tx, stop_rx));

        Ok(PreviewServer {
            status: status_rx,
            stop: Mutex::new(Some(stop_tx)),
            pid,
        })
    }

    /// The latest known status.
    pub fn status(&self) -> PreviewStatus {
        self.status.borrow().clone()
    }

    /// OS process id of the dev server, if available.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Request a stop. Idempotent; the child is killed by the lifecycle task.
    pub fn stop(&self) {
        if let Some(tx) = self.stop.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for PreviewServer {
    fn drop(&mut self) {
        // Best-effort: ask the lifecycle task to kill the child. If the task has
        // already finished, the send is a no-op and `kill_on_drop` covered it.
        self.stop();
    }
}

/// Drive the dev server: wait for its port, then watch it until stop/exit.
async fn lifecycle(
    mut child: tokio::process::Child,
    opts: PreviewOptions,
    status_tx: watch::Sender<PreviewStatus>,
    mut stop_rx: oneshot::Receiver<()>,
) {
    let deadline = Instant::now() + SCAN_TIMEOUT;
    let mut tick = tokio::time::interval(SCAN_INTERVAL);

    // Phase 1: wait for a candidate port to answer (or fail/stop first).
    loop {
        tokio::select! {
            _ = &mut stop_rx => {
                let _ = child.start_kill();
                let _ = status_tx.send(PreviewStatus::Stopped);
                return;
            }
            exited = child.wait() => {
                let message = match exited {
                    Ok(status) => format!("dev server exited before serving ({status})"),
                    Err(e) => format!("failed to await dev server: {e}"),
                };
                let _ = status_tx.send(PreviewStatus::Failed { message });
                return;
            }
            _ = tick.tick() => {
                if let Some(port) = scan(&opts.scan_host, &opts.ports).await {
                    let url = format!("http://{}:{}", opts.url_host, port);
                    let _ = status_tx.send(PreviewStatus::Running { url, port });
                    break;
                }
                if Instant::now() >= deadline {
                    let _ = child.start_kill();
                    let _ = status_tx.send(PreviewStatus::Failed {
                        message: "timed out waiting for dev server to bind a port".to_string(),
                    });
                    return;
                }
            }
        }
    }

    // Phase 2: serving. Hold until asked to stop or the child exits on its own.
    tokio::select! {
        _ = &mut stop_rx => {
            let _ = child.start_kill();
            let _ = status_tx.send(PreviewStatus::Stopped);
        }
        _ = child.wait() => {
            let _ = status_tx.send(PreviewStatus::Stopped);
        }
    }
}

/// Probe each candidate port once; return the first that accepts a connection.
async fn scan(host: &str, ports: &[u16]) -> Option<u16> {
    for &port in ports {
        let addr = format!("{host}:{port}");
        if let Ok(Ok(_stream)) =
            tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(&addr)).await
        {
            return Some(port);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpListener;

    /// Wait until `status()` satisfies `pred` or the timeout elapses.
    async fn wait_until(
        server: &PreviewServer,
        pred: impl Fn(&PreviewStatus) -> bool,
    ) -> PreviewStatus {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let s = server.status();
                if pred(&s) {
                    return s;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap_or_else(|_| server.status())
    }

    #[tokio::test]
    async fn detects_a_listening_port_and_reports_running() {
        // Bind a port ourselves to stand in for "the dev server is up". The
        // preview just needs *something* answering on a candidate port — that's
        // exactly what the scan looks for.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let dir = tempfile::tempdir().unwrap();
        let server = PreviewServer::spawn(PreviewOptions {
            workspace: dir.path().to_path_buf(),
            // A long-lived dummy "dev server" that just stays alive.
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "sleep 30".to_string()],
            env: Vec::new(),
            scan_host: "127.0.0.1".to_string(),
            ports: vec![port],
            url_host: "localhost".to_string(),
        })
        .await
        .expect("spawn preview");

        let status = wait_until(&server, |s| matches!(s, PreviewStatus::Running { .. })).await;
        match status {
            PreviewStatus::Running { url, port: p } => {
                assert_eq!(p, port);
                assert_eq!(url, format!("http://localhost:{port}"));
            }
            other => panic!("expected Running, got {other:?}"),
        }

        server.stop();
        let status = wait_until(&server, |s| matches!(s, PreviewStatus::Stopped)).await;
        assert_eq!(status, PreviewStatus::Stopped);
    }

    #[tokio::test]
    async fn reports_failed_when_the_dev_server_exits_early() {
        let dir = tempfile::tempdir().unwrap();
        // Exits immediately and never binds a port → Failed.
        let server = PreviewServer::spawn(PreviewOptions {
            workspace: dir.path().to_path_buf(),
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "exit 1".to_string()],
            env: Vec::new(),
            scan_host: "127.0.0.1".to_string(),
            // A port nothing is listening on.
            ports: vec![1],
            url_host: "localhost".to_string(),
        })
        .await
        .expect("spawn preview");

        let status = wait_until(&server, |s| matches!(s, PreviewStatus::Failed { .. })).await;
        assert!(matches!(status, PreviewStatus::Failed { .. }), "got {status:?}");
    }
}

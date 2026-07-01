//! `POST /v1/fs/pick` — open the OS-native folder chooser and return the
//! absolute path the user selects.
//!
//! A browser served over `http://localhost:3000` cannot read a local folder's
//! absolute path (the File System Access API only yields its *name*), yet the
//! session backend needs a real `workspace` path to launch the agent and run
//! git. Because `micracode-api` runs on the user's machine, it can pop the
//! *native* folder dialog there — the same Finder "Choose Folder" sheet a
//! desktop app would show — and hand back the chosen POSIX path. This is the
//! browser-app stand-in for a native picker.
//!
//! macOS only: it shells out to `osascript`'s `choose folder`. Cancelling the
//! dialog is a normal outcome, reported as `{ "cancelled": true }` (not an error).

use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::AppState;
use crate::error::ApiError;

pub fn router() -> Router<AppState> {
    Router::new().route("/fs/pick", post(pick_folder))
}

#[derive(Default, Deserialize)]
struct PickRequest {
    /// Optional directory to open the dialog at. Defaults to the OS default.
    start: Option<String>,
}

#[derive(Serialize)]
struct PickResponse {
    /// The chosen folder's absolute path; omitted when the dialog was cancelled.
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// True when the user dismissed the dialog without choosing a folder.
    cancelled: bool,
}

/// Pop the native folder chooser and return the selected absolute path.
async fn pick_folder(body: Option<Json<PickRequest>>) -> Result<Json<PickResponse>, ApiError> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    pick(req.start).await.map(Json)
}

#[cfg(target_os = "macos")]
async fn pick(start: Option<String>) -> Result<PickResponse, ApiError> {
    // AppleScript: print the POSIX path of the chosen folder. `default location`
    // seeds the dialog at `start` when one is supplied.
    let default = match start.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => format!(
            " default location (POSIX file \"{}\")",
            applescript_escape(dir)
        ),
        None => String::new(),
    };
    let script =
        format!("POSIX path of (choose folder with prompt \"Select a project folder\"{default})");

    let output = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .await
        .map_err(|e| ApiError::Unavailable(format!("could not launch native dialog: {e}")))?;

    if output.status.success() {
        // `POSIX path of` returns a trailing slash; trim it (but keep root "/").
        let raw = String::from_utf8_lossy(&output.stdout);
        let trimmed = raw.trim().trim_end_matches('/');
        let path = if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        };
        return Ok(PickResponse {
            path: Some(path),
            cancelled: false,
        });
    }

    // `choose folder` exits non-zero with "User canceled. (-128)" on cancel —
    // a normal flow, not a failure.
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("-128") || stderr.to_lowercase().contains("cancel") {
        return Ok(PickResponse {
            path: None,
            cancelled: true,
        });
    }
    Err(ApiError::BadGateway(format!(
        "native folder dialog failed: {}",
        stderr.trim()
    )))
}

#[cfg(not(target_os = "macos"))]
async fn pick(_start: Option<String>) -> Result<PickResponse, ApiError> {
    Err(ApiError::Unavailable(
        "native folder picker is only available on macOS".to_string(),
    ))
}

/// Escape a path for embedding inside an AppleScript string literal.
#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

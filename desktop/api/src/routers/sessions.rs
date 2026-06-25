//! `/v1/sessions` — start and drive agent sessions (PRD FR1). Each session runs
//! on the agent named by the request's `harness` field (Codex or Claude).
//!
//! These endpoints don't return turn output directly: a session's events are
//! appended to the event log by the [`ProviderManager`](crate::provider) and
//! streamed to the client over `GET /v1/events/stream`. The handlers here are
//! the command side (start / turn / interrupt / stop).

use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use core_provider::{Harness, PermissionMode, SessionOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::AppState;
use crate::error::ApiError;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sessions", post(start_session))
        .route("/sessions/{session_id}/turn", post(send_turn))
        .route("/sessions/{session_id}/resume", post(resume_session))
        .route("/sessions/{session_id}/interrupt", post(interrupt_session))
        .route("/sessions/{session_id}", axum::routing::delete(stop_session))
}

#[derive(Debug, Deserialize)]
pub struct StartSessionRequest {
    /// Bind the session to an existing project's workspace.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Or an explicit workspace path (ignored when `project_id` is set).
    #[serde(default)]
    pub workspace: Option<String>,
    /// Optional model override (`--model`).
    #[serde(default)]
    pub model: Option<String>,
    /// Which agent CLI backs the session — `"codex"` (default) or `"claude"`.
    #[serde(default)]
    pub harness: Harness,
    /// How much autonomy the agent has — `"bypassPermissions"` (default; runs
    /// `claude --dangerously-skip-permissions`), `"acceptEdits"`, `"plan"`, or
    /// `"default"`. Maps onto the CLI's permission/sandbox flags.
    #[serde(default)]
    pub permission: PermissionMode,
}

#[derive(Debug, Serialize)]
pub struct StartSessionResponse {
    pub session_id: String,
    /// Echo the agent the session actually started on.
    pub harness: Harness,
    /// Echo the permission mode the session actually started under.
    pub permission: PermissionMode,
}

#[derive(Debug, Deserialize)]
pub struct TurnRequest {
    pub text: String,
}

type ApiResult<T> = Result<Json<T>, ApiError>;

/// Resolve the workspace directory for a new session.
fn resolve_workspace(state: &AppState, req: &StartSessionRequest) -> Result<PathBuf, ApiError> {
    if let Some(project_id) = &req.project_id {
        let dir = state.storage.project_dir(project_id)?;
        if !dir.exists() {
            return Err(ApiError::NotFound("project not found".to_string()));
        }
        return Ok(dir);
    }
    if let Some(workspace) = &req.workspace {
        return Ok(PathBuf::from(workspace));
    }
    Ok(state.config.opener_apps_dir.clone())
}

async fn start_session(
    State(state): State<AppState>,
    Json(req): Json<StartSessionRequest>,
) -> ApiResult<StartSessionResponse> {
    let workspace = resolve_workspace(&state, &req)?;
    let harness = req.harness;
    let permission = req.permission;
    let opts = SessionOptions {
        workspace,
        model: req.model.clone(),
        resume: None,
        harness,
        permission,
    };
    let session_id = state
        .provider
        .start_session(opts)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(StartSessionResponse {
        session_id,
        harness,
        permission,
    }))
}

async fn send_turn(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<TurnRequest>,
) -> ApiResult<Value> {
    let routed = state
        .provider
        .send_turn(&session_id, &req.text)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    if !routed {
        return Err(ApiError::NotFound("session not found".to_string()));
    }
    Ok(Json(json!({ "accepted": true })))
}

/// Resume a closed session, continuing its conversation thread (PRD FR1). The
/// workspace, model, and Codex session id are recovered from the event log, so
/// the body is empty — the path id is the thread to resume. Responds with the
/// (unchanged) local session id to route subsequent turns to.
async fn resume_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> ApiResult<Value> {
    let resumed = state
        .provider
        .resume_session(&session_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    match resumed {
        Some(id) => Ok(Json(json!({ "session_id": id, "resumed": true }))),
        None => Err(ApiError::NotFound(
            "session not found or not resumable".to_string(),
        )),
    }
}

async fn interrupt_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> ApiResult<Value> {
    let routed = state
        .provider
        .interrupt(&session_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    if !routed {
        return Err(ApiError::NotFound("session not found".to_string()));
    }
    Ok(Json(json!({ "accepted": true })))
}

async fn stop_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> ApiResult<Value> {
    let stopped = state
        .provider
        .stop(&session_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    if !stopped {
        return Err(ApiError::NotFound("session not found".to_string()));
    }
    Ok(Json(json!({ "stopped": true })))
}

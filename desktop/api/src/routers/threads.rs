//! `/v1/threads` — the read side of the event-sourced core (PRD FR2).
//!
//! These endpoints serve the [`Projection`](core_projection::Projection) folded
//! from the event log: `GET /v1/threads` lists thread summaries, and
//! `GET /v1/threads/{id}` returns a full thread (turns + messages). The model is
//! kept current by [`ProjectionHandle`](crate::projection::ProjectionHandle),
//! so these are pure reads — all mutation flows through commands and the
//! provider pump into the log.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use core_projection::{Thread, ThreadSummary};

use super::AppState;
use crate::error::ApiError;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/threads", get(list_threads))
        .route("/threads/{thread_id}", get(get_thread).delete(delete_thread))
}

async fn list_threads(State(state): State<AppState>) -> Json<Vec<ThreadSummary>> {
    Json(state.projection.summaries().await)
}

async fn get_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<Thread>, ApiError> {
    state
        .projection
        .thread(&thread_id)
        .await
        .map(Json)
        .ok_or_else(|| ApiError::NotFound("thread not found".to_string()))
}

/// `DELETE /v1/threads/{id}` — tear down a thread (PRD FR3). An unknown thread
/// is a 404; a known thread is *accepted* (202) and deleted asynchronously by
/// the thread-deletion reactor, which stops the session and records the
/// removal. The thread disappears from the read endpoints once the
/// `thread.deleted` event is folded into the projection.
async fn delete_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if state.projection.thread(&thread_id).await.is_none() {
        return Err(ApiError::NotFound("thread not found".to_string()));
    }
    state.provider.delete_thread(&thread_id);
    Ok(StatusCode::ACCEPTED)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::provider::ProviderManager;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use core_orchestration::Engine;
    use core_persistence::EventStore;
    use core_provider::{CodexDriver, SessionOptions};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn write_mock_codex(dir: &std::path::Path) -> std::path::PathBuf {
        let script = dir.join("mock-codex.sh");
        std::fs::write(
            &script,
            r#"#!/usr/bin/env bash
read -r _submission
printf '%s\n' '{"id":"0","msg":{"type":"session_configured","session_id":"mock-xyz"}}'
printf '%s\n' '{"id":"1","msg":{"type":"agent_message","message":"hello there"}}'
printf '%s\n' '{"id":"1","msg":{"type":"task_complete","last_agent_message":"hello there"}}'
"#,
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    async fn json_body(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// A driven session is projected into a thread the read endpoints serve.
    #[tokio::test]
    async fn driven_session_is_projected_and_served() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_mock_codex(dir.path());

        let store = EventStore::open_in_memory().unwrap();
        let engine = Arc::new(Engine::new(store, crate::decider::decide));
        let projection = crate::projection::ProjectionHandle::spawn(Arc::clone(&engine));
        let provider = Arc::new(ProviderManager::new(
            CodexDriver::with_program(script),
            Arc::clone(&engine),
        ));

        let session_id = provider
            .start_session(SessionOptions {
                workspace: dir.path().to_path_buf(),
                model: None,
                resume: None,
                harness: core_provider::Harness::Codex,
                permission: Default::default(),
            })
            .await
            .unwrap();
        provider.send_turn(&session_id, "hi").await.unwrap();

        // Wait for the projection to observe the closed session.
        let thread = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some(t) = projection.thread(&session_id).await {
                    if matches!(t.status, core_projection::ThreadStatus::Closed) {
                        return t;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("thread projected within timeout");

        assert_eq!(thread.provider_session_id.as_deref(), Some("mock-xyz"));
        assert_eq!(thread.turns.len(), 1);
        assert_eq!(thread.turns[0].messages.len(), 2); // user + assistant

        let state = AppState {
            storage: Arc::new(crate::storage::Storage::new(dir.path().to_path_buf())),
            config: Arc::new(crate::config::Config::from_env()),
            engine,
            provider,
            projection,
            terminals: Arc::new(crate::terminal::TerminalManager::new()),
            previews: Arc::new(crate::preview::PreviewManager::new()),
        };
        let app = super::router().with_state(state);

        // List endpoint surfaces the thread summary.
        let resp = app
            .clone()
            .oneshot(Request::builder().uri("/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let list = json_body(resp).await;
        assert_eq!(list[0]["id"], session_id);
        assert_eq!(list[0]["turn_count"], 1);
        assert_eq!(list[0]["status"], "closed");

        // Detail endpoint returns the full transcript.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/threads/{session_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let detail = json_body(resp).await;
        assert_eq!(detail["turns"][0]["messages"][0]["role"], "user");
        assert_eq!(detail["turns"][0]["messages"][1]["role"], "assistant");
        assert_eq!(detail["turns"][0]["messages"][1]["text"], "hello there");

        // Unknown thread → 404.
        let resp = app
            .oneshot(Request::builder().uri("/threads/nope").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    /// `DELETE /v1/threads/{id}` accepts a known thread, tears it down via the
    /// reactor, and the read endpoints stop serving it; an unknown thread 404s.
    #[tokio::test]
    async fn delete_thread_tears_down_a_known_thread_and_404s_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_mock_codex(dir.path());

        let store = EventStore::open_in_memory().unwrap();
        let engine = Arc::new(Engine::new(store, crate::decider::decide));
        let projection = crate::projection::ProjectionHandle::spawn(Arc::clone(&engine));
        let provider = Arc::new(ProviderManager::new(
            CodexDriver::with_program(script),
            Arc::clone(&engine),
        ));

        let session_id = provider
            .start_session(SessionOptions {
                workspace: dir.path().to_path_buf(),
                model: None,
                resume: None,
                harness: core_provider::Harness::Codex,
                permission: Default::default(),
            })
            .await
            .unwrap();
        provider.send_turn(&session_id, "hi").await.unwrap();

        // Wait until the thread is projected (driven by the turn's events).
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if projection.thread(&session_id).await.is_some() {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("thread projected within timeout");

        let state = AppState {
            storage: Arc::new(crate::storage::Storage::new(dir.path().to_path_buf())),
            config: Arc::new(crate::config::Config::from_env()),
            engine,
            provider,
            projection: projection.clone(),
            terminals: Arc::new(crate::terminal::TerminalManager::new()),
            previews: Arc::new(crate::preview::PreviewManager::new()),
        };
        let app = super::router().with_state(state);

        // Unknown thread → 404, nothing enqueued.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/threads/ghost")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // Known thread → 202 Accepted.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/threads/{session_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::ACCEPTED);

        // The reactor processes the deletion: the thread leaves the projection.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if projection.thread(&session_id).await.is_none() {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("thread removed within timeout");

        // And the detail endpoint now 404s for it.
        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/threads/{session_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}

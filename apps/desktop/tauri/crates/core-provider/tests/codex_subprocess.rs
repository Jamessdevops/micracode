//! Integration test for [`CodexDriver`] against a mock subprocess.
//!
//! Spawning the real `codex` binary in CI is neither hermetic nor available, so
//! the driver's `program` is pointed at a small shell script that speaks the
//! same `proto`-over-stdio protocol: read a submission on stdin, emit canned
//! events on stdout. This exercises the full path — spawn → write turn → frame
//! stdout → normalize — that the PRD calls the "mock subprocess fixture" (PRD
//! §12, Test ergonomics). Unix-only (uses a `bash` script).

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;

use core_provider::{CodexDriver, ProviderDriver, ProviderEvent, SessionOptions};

/// Write an executable mock-`codex` script that emits a fixed transcript after
/// reading the first submission line, then drains the rest of stdin.
fn write_mock_codex(dir: &std::path::Path) -> std::path::PathBuf {
    let script = dir.join("mock-codex.sh");
    std::fs::write(
        &script,
        r#"#!/usr/bin/env bash
# Ignore the `proto` flags; read the first submission, then reply and exit so
# stdout reaches EOF and the driver's pump terminates.
read -r _submission
printf '%s\n' '{"id":"0","msg":{"type":"session_configured","session_id":"mock-123"}}'
printf '%s\n' '{"id":"1","msg":{"type":"agent_message","message":"hi from mock"}}'
printf '%s\n' '{"id":"1","msg":{"type":"task_complete","last_agent_message":"hi from mock"}}'
"#,
    )
    .unwrap();
    let mut perms = std::fs::metadata(&script).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&script, perms).unwrap();
    script
}

#[tokio::test]
async fn drives_a_turn_and_normalizes_the_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_mock_codex(dir.path());

    let driver = CodexDriver::with_program(script);
    let mut session = driver
        .start_session(SessionOptions {
            workspace: dir.path().to_path_buf(),
            model: None,
            resume: None,
            harness: core_provider::Harness::Codex,
            permission: Default::default(),
        })
        .await
        .expect("session starts");

    session.handle.send_turn("hello").await.expect("turn sent");

    let mut events = Vec::new();
    while let Some(ev) = session.recv().await {
        events.push(ev);
    }

    assert_eq!(
        events,
        vec![
            ProviderEvent::SessionStarted {
                session_id: "mock-123".into()
            },
            ProviderEvent::AssistantText {
                text: "hi from mock".into()
            },
            ProviderEvent::TurnCompleted {
                result: Some("hi from mock".into()),
                is_error: false,
            },
        ]
    );
}

#[tokio::test]
async fn missing_binary_surfaces_a_spawn_error() {
    let dir = tempfile::tempdir().unwrap();
    let driver = CodexDriver::with_program("definitely-not-a-real-binary-xyz");
    let result = driver
        .start_session(SessionOptions {
            workspace: dir.path().to_path_buf(),
            model: None,
            resume: None,
            harness: core_provider::Harness::Codex,
            permission: Default::default(),
        })
        .await;
    assert!(matches!(
        result,
        Err(core_provider::ProviderError::Spawn { .. })
    ));
}

"""Tests for `/v1/generate` cancellation + retry semantics.

We exercise the private ``_ui_message_stream`` generator directly so we
can drive ``request.is_disconnected`` deterministically and inspect the
resulting ``prompts.jsonl`` state. A TestClient would let the SSE stream
run to completion without a cancel opportunity, which is not what we
want to assert.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import MagicMock

import pytest

from micracode_api.routers import generate as generate_router
from micracode_core.schemas.stream import (
    FileWriteEvent,
    GenerateRequest,
    MessageDeltaEvent,
    StatusEvent,
    StreamEvent,
)
from micracode_core.storage import Storage


class _FakeRequest:
    """Minimal stand-in for ``fastapi.Request.is_disconnected``."""

    def __init__(self, disconnect_after: int | None = None) -> None:
        self._disconnect_after = disconnect_after
        self._polls = 0

    async def is_disconnected(self) -> bool:
        self._polls += 1
        if self._disconnect_after is None:
            return False
        return self._polls > self._disconnect_after


async def _consume(
    gen: AsyncIterator[bytes],
) -> list[bytes]:
    out: list[bytes] = []
    try:
        async for frame in gen:
            out.append(frame)
    except asyncio.CancelledError:
        pass
    return out


def _make_orchestrator_stream(
    events: list[StreamEvent],
) -> Any:
    async def _run_codegen_stream(**_: Any) -> AsyncIterator[StreamEvent]:
        for e in events:
            yield e

    return _run_codegen_stream


@pytest.mark.asyncio
async def test_normal_turn_persists_user_and_assistant_with_snapshot_id(
    monkeypatch: pytest.MonkeyPatch, storage: Storage
) -> None:
    rec = storage.create_project("Gen Normal")

    events: list[StreamEvent] = [
        StatusEvent(stage="planning", note="Reading project"),
        MessageDeltaEvent(content="Plan: tweak page.\n"),
        StatusEvent(
            stage="generating", note="Writing files", snapshot_id="20260101T000000Z-beef"
        ),
        FileWriteEvent(path="app/page.tsx", content="export default () => null;\n"),
        StatusEvent(stage="done"),
    ]
    monkeypatch.setattr(
        generate_router, "run_codegen_stream", _make_orchestrator_stream(events)
    )

    req = _FakeRequest(disconnect_after=None)
    payload = GenerateRequest(project_id=rec.id, prompt="make it simple", retry=False)
    frames = await _consume(
        generate_router._ui_message_stream(req, payload, storage, MagicMock(), request_id="test-req-id")  # type: ignore[arg-type]
    )

    assert any(b"Plan: tweak page" in f for f in frames)
    assert any(b"[DONE]" in f for f in frames)

    prompts = storage.read_prompts(rec.id)
    assert [p.role for p in prompts] == ["user", "assistant"]
    assert prompts[0].content == "make it simple"
    assert prompts[1].content.startswith("Plan: tweak page")
    assert "_(generation cancelled)_" not in prompts[1].content
    assert prompts[1].snapshot_id == "20260101T000000Z-beef"


@pytest.mark.asyncio
async def test_retry_flag_skips_user_prompt_append(
    monkeypatch: pytest.MonkeyPatch, storage: Storage
) -> None:
    rec = storage.create_project("Gen Retry")
    # Seed the history as if the original user turn had already been
    # recorded (and its bad assistant reply was popped client-side).
    storage.append_prompt(rec.id, "user", "original prompt")

    events: list[StreamEvent] = [
        StatusEvent(stage="planning"),
        MessageDeltaEvent(content="Plan v2.\n"),
        StatusEvent(stage="generating", snapshot_id="20260101T000000Z-cafe"),
        StatusEvent(stage="done"),
    ]
    monkeypatch.setattr(
        generate_router, "run_codegen_stream", _make_orchestrator_stream(events)
    )

    req = _FakeRequest()
    payload = GenerateRequest(
        project_id=rec.id, prompt="original prompt", retry=True
    )
    await _consume(
        generate_router._ui_message_stream(req, payload, storage, MagicMock(), request_id="test-req-id")  # type: ignore[arg-type]
    )

    prompts = storage.read_prompts(rec.id)
    # With retry=True the user prompt must not be re-appended.
    assert [p.role for p in prompts] == ["user", "assistant"]
    assert prompts[0].content == "original prompt"


@pytest.mark.asyncio
async def test_empty_reply_not_persisted(
    monkeypatch: pytest.MonkeyPatch, storage: Storage
) -> None:
    rec = storage.create_project("Gen Empty")

    events: list[StreamEvent] = [
        StatusEvent(stage="planning"),
        # No message.delta -> assistant_buffer stays empty
        StatusEvent(stage="done"),
    ]
    monkeypatch.setattr(
        generate_router, "run_codegen_stream", _make_orchestrator_stream(events)
    )

    req = _FakeRequest()
    payload = GenerateRequest(project_id=rec.id, prompt="hi", retry=False)
    await _consume(
        generate_router._ui_message_stream(req, payload, storage, MagicMock(), request_id="test-req-id")  # type: ignore[arg-type]
    )

    prompts = storage.read_prompts(rec.id)
    assert [p.role for p in prompts] == ["user"]


@pytest.mark.asyncio
async def test_disconnect_annotates_partial_reply(
    monkeypatch: pytest.MonkeyPatch, storage: Storage
) -> None:
    rec = storage.create_project("Gen Cancel")

    events: list[StreamEvent] = [
        StatusEvent(stage="planning"),
        MessageDeltaEvent(content="partial plan"),
        # Router will observe disconnect before consuming the next event.
        MessageDeltaEvent(content=" — continued"),
        StatusEvent(stage="done"),
    ]
    monkeypatch.setattr(
        generate_router, "run_codegen_stream", _make_orchestrator_stream(events)
    )

    # Drop the client *after* the first delta flows through. `is_disconnected`
    # is polled once per event, so `disconnect_after=2` makes the third poll
    # return True (after planning status + first delta have been emitted).
    req = _FakeRequest(disconnect_after=2)
    payload = GenerateRequest(project_id=rec.id, prompt="do it", retry=False)
    await _consume(
        generate_router._ui_message_stream(req, payload, storage, MagicMock(), request_id="test-req-id")  # type: ignore[arg-type]
    )

    prompts = storage.read_prompts(rec.id)
    assert [p.role for p in prompts] == ["user", "assistant"]
    assert prompts[1].content.endswith("_(generation cancelled)_")
    # The partial text is preserved.
    assert "partial plan" in prompts[1].content

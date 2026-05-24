"""`POST /v1/generate` — Vercel AI SDK UI Message Stream Protocol."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator

import orjson
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from micracode_core.orchestrator import _approval_registry, run_codegen_stream
from micracode_core.schemas.stream import GenerateRequest
from micracode_core.storage import SLUG_RE, Storage

from ..deps import EngineDep, StorageDep

logger = logging.getLogger(__name__)

router = APIRouter()


def _frame(payload: dict) -> bytes:
    return b"data: " + orjson.dumps(payload) + b"\n\n"


_DONE_FRAME = b"data: [DONE]\n\n"


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


class _ApproveRequest(BaseModel):
    approved: bool


async def _ui_message_stream(
    request: Request,
    payload: GenerateRequest,
    storage: Storage,
    engine: "MicracodeEngine",  # type: ignore[name-defined]
    request_id: str,
) -> AsyncIterator[bytes]:
    slug = payload.project_id
    assistant_buffer: list[str] = []
    snapshot_id: str | None = None
    cancelled = False

    try:
        prior_history = storage.read_prompts(slug)
    except Exception:
        logger.exception("failed to read prompt history for %s", slug)
        prior_history = []

    if not payload.retry:
        try:
            storage.append_prompt(slug, "user", payload.prompt)
        except Exception:
            logger.exception("failed to persist user prompt for %s", slug)

    message_id = _new_id("msg")
    text_id = _new_id("txt")
    text_started = False

    yield _frame({"type": "start", "messageId": message_id})
    yield _frame({"type": "start-step"})

    try:
        async for event in run_codegen_stream(
            project_id=slug,
            prompt=payload.prompt,
            history=prior_history,
            storage=storage,
            config=engine.config,
            provider=payload.provider,
            model=payload.model,
            mode=payload.mode,
            request_id=request_id,
        ):
            if await request.is_disconnected():
                logger.info("client disconnected — aborting stream")
                cancelled = True
                break

            if event.type == "message.delta":
                if not text_started:
                    text_started = True
                    yield _frame({"type": "text-start", "id": text_id})
                assistant_buffer.append(event.content)
                yield _frame(
                    {"type": "text-delta", "id": text_id, "delta": event.content}
                )
            elif event.type == "file.write":
                yield _frame(
                    {
                        "type": "data-file-write",
                        "id": event.path,
                        "data": {"path": event.path, "content": event.content},
                    }
                )
            elif event.type == "file.delete":
                yield _frame(
                    {
                        "type": "data-file-delete",
                        "id": event.path,
                        "data": {"path": event.path},
                    }
                )
            elif event.type == "status":
                if event.snapshot_id is not None:
                    snapshot_id = event.snapshot_id
                yield _frame(
                    {
                        "type": "data-status",
                        "data": {
                            "stage": event.stage,
                            "note": event.note,
                            "snapshot_id": event.snapshot_id,
                        },
                        "transient": True,
                    }
                )
            elif event.type == "shell.exec":
                yield _frame(
                    {
                        "type": "data-shell-exec",
                        "data": {"command": event.command, "cwd": event.cwd},
                    }
                )
            elif event.type == "tool.call":
                yield _frame(
                    {
                        "type": "data-tool-call",
                        "data": {
                            "tool_call_id": event.tool_call_id,
                            "tool_name": event.tool_name,
                            "args": event.args,
                            "reason": event.reason,
                        },
                    }
                )
            elif event.type == "tool.permission_request":
                yield _frame(
                    {
                        "type": "data-tool-permission-request",
                        "data": {
                            "tool_call_id": event.tool_call_id,
                            "command": event.command,
                            "reason": event.reason,
                            "request_id": request_id,
                        },
                    }
                )
            elif event.type == "tool.result":
                yield _frame(
                    {
                        "type": "data-tool-result",
                        "data": {
                            "tool_call_id": event.tool_call_id,
                            "tool_name": event.tool_name,
                            "output": event.output,
                            "approved": event.approved,
                        },
                    }
                )
            elif event.type == "tool.denied":
                yield _frame(
                    {
                        "type": "data-tool-denied",
                        "data": {"tool_call_id": event.tool_call_id},
                    }
                )
            elif event.type == "error":
                yield _frame({"type": "error", "errorText": event.message})
    except asyncio.CancelledError:
        cancelled = True
        raise
    except Exception as exc:
        logger.exception("codegen stream failed")
        yield _frame({"type": "error", "errorText": f"stream failed: {exc}"})
    finally:
        if text_started:
            yield _frame({"type": "text-end", "id": text_id})
        yield _frame({"type": "finish-step"})
        yield _frame({"type": "finish"})
        yield _DONE_FRAME

        reply = "".join(assistant_buffer).strip()
        if reply:
            if cancelled:
                reply = f"{reply}\n\n_(generation cancelled)_"
            try:
                storage.append_prompt(
                    slug, "assistant", reply, snapshot_id=snapshot_id
                )
            except Exception:
                logger.exception("failed to persist assistant reply for %s", slug)


@router.post("/generate")
async def generate(
    payload: GenerateRequest,
    request: Request,
    storage: StorageDep,
    engine: EngineDep,
) -> StreamingResponse:
    if not SLUG_RE.fullmatch(payload.project_id):
        raise HTTPException(status_code=400, detail="invalid project_id")
    if storage.get_project(payload.project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")

    request_id = uuid.uuid4().hex

    logger.info(
        "generate stream start project=%s prompt_len=%d request_id=%s",
        payload.project_id,
        len(payload.prompt),
        request_id,
    )
    return StreamingResponse(
        _ui_message_stream(request, payload, storage, engine, request_id=request_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "x-vercel-ai-ui-message-stream": "v1",
            "X-Request-ID": request_id,
        },
    )


@router.post("/generate/{request_id}/tool/{tool_call_id}/approve")
async def approve_tool(
    request_id: str,
    tool_call_id: str,
    body: _ApproveRequest,
) -> dict:
    """Approve or deny a pending shell_exec tool call."""
    request_approvals = _approval_registry.get(request_id)
    if request_approvals is None:
        raise HTTPException(status_code=404, detail="request not found or already completed")

    approval_data = request_approvals.get(tool_call_id)
    if approval_data is None:
        raise HTTPException(status_code=404, detail="tool call not found or already resolved")

    event, result_holder = approval_data
    result_holder.append(body.approved)
    event.set()

    return {"ok": True}

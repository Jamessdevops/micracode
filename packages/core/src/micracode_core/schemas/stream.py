"""Pydantic mirror of ``packages/shared/src/stream-events.ts``.

Any change here MUST be mirrored in the TypeScript source of truth to keep
the SSE contract in sync.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Event(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class MessageDeltaEvent(_Event):
    type: Literal["message.delta"] = "message.delta"
    content: str


class FileWriteEvent(_Event):
    type: Literal["file.write"] = "file.write"
    path: str
    content: str


class FileDeleteEvent(_Event):
    type: Literal["file.delete"] = "file.delete"
    path: str


class ShellExecEvent(_Event):
    type: Literal["shell.exec"] = "shell.exec"
    command: str
    cwd: str | None = None


class StatusEvent(_Event):
    type: Literal["status"] = "status"
    stage: Literal["planning", "generating", "done", "cancelled", "plan_ready", "max_iterations_reached"]
    note: str | None = None
    snapshot_id: str | None = None


class ErrorEvent(_Event):
    type: Literal["error"] = "error"
    message: str
    recoverable: bool = False


class ToolCallEvent(_Event):
    type: Literal["tool.call"] = "tool.call"
    tool_call_id: str
    tool_name: str
    args: dict
    reason: str = ""


class ToolPermissionRequestEvent(_Event):
    type: Literal["tool.permission_request"] = "tool.permission_request"
    tool_call_id: str
    command: str
    reason: str


class ToolResultEvent(_Event):
    type: Literal["tool.result"] = "tool.result"
    tool_call_id: str
    tool_name: str
    output: str
    approved: bool = True


class ToolDeniedEvent(_Event):
    type: Literal["tool.denied"] = "tool.denied"
    tool_call_id: str


class ToolQuestionEvent(_Event):
    type: Literal["tool.question"] = "tool.question"
    tool_call_id: str
    question: str
    options: list[str] = Field(default_factory=list)


class TodoItem(_Event):
    """A single entry in the agent's session checklist."""

    id: str
    content: str
    status: Literal["pending", "in_progress", "completed", "cancelled"] = "pending"


class TodoUpdateEvent(_Event):
    """Full snapshot of the agent's todo list, emitted whenever it changes.

    The list is sent in its entirety (not as a delta) so the UI can render
    the current checklist by replacing whatever it last had.
    """

    type: Literal["todo.update"] = "todo.update"
    todos: list[TodoItem] = Field(default_factory=list)


StreamEvent = Annotated[
    MessageDeltaEvent
    | FileWriteEvent
    | FileDeleteEvent
    | ShellExecEvent
    | StatusEvent
    | ErrorEvent
    | ToolCallEvent
    | ToolPermissionRequestEvent
    | ToolResultEvent
    | ToolDeniedEvent
    | ToolQuestionEvent
    | TodoUpdateEvent,
    Field(discriminator="type"),
]


class Attachment(BaseModel):
    """A file the user attached for per-turn context (never persisted).

    ``data`` is base64-encoded file bytes. The 28M cap on the encoded
    string is ~20MB decoded, comfortably above the 10MB client-side cap.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=256)
    mime_type: str = Field(min_length=1, max_length=128)
    data: str = Field(min_length=1, max_length=28_000_000)


class GenerateRequest(BaseModel):
    """Request body for ``POST /v1/generate``."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    prompt: str = Field(min_length=1, max_length=16000)
    history: list[dict[str, str]] | None = None
    retry: bool = False
    provider: Literal["openai", "gemini", "ollama"] | None = None
    model: str | None = Field(default=None, max_length=128)
    mode: Literal["plan", "build"] = "build"
    attachments: list[Attachment] | None = Field(default=None, max_length=10)
    # Preview click-to-select context, prepended to the codegen prompt only (not
    # persisted as the user message, so the chat transcript stays clean).
    selection_context: str | None = Field(default=None, max_length=12000)

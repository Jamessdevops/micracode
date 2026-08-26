"""Plain-Python orchestrator for the codegen loop (no LangGraph).

One async generator, two LLM calls (plan, codegen tool loop).
State flows as function arguments; events are ``yield``-ed to the caller.
File writes are persisted to storage before the matching event is yielded,
so storage and the client tree stay in sync.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import uuid
from collections.abc import AsyncIterator

import httpx

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from .config import CoreConfig
from .schemas.project import PromptRecord
from .schemas.stream import (
    Attachment,
    ErrorEvent,
    FileWriteEvent,
    MessageDeltaEvent,
    StatusEvent,
    StreamEvent,
    TodoItem,
    TodoUpdateEvent,
    ToolCallEvent,
    ToolDeniedEvent,
    ToolPermissionRequestEvent,
    ToolQuestionEvent,
    ToolResultEvent,
)
from .storage import Storage
from . import model_catalog
from .context import load_context
from .llm import LLMFactory
from .patcher import ProjectContext
from .prompts import get_prompt
from .tools import ALL_TOOLS, execute_glob, execute_grep, execute_list_files, execute_read_file, execute_search_replace, execute_shell_exec, execute_todoread, execute_todowrite, execute_webfetch, execute_write_patch

logger = logging.getLogger(__name__)


def _missing_api_key_message(provider: str, config: CoreConfig) -> str:
    env_var = "OPENAI_API_KEY" if provider == "openai" else "GOOGLE_API_KEY"
    return f"Server is not configured with a {env_var}; cannot generate code."


def build_llm(
    provider: str,
    model: str,
    config: CoreConfig | None = None,
    *,
    family: str = "openai-chat",
) -> BaseChatModel:
    """Seam used by ``_plan`` / ``_codegen``; tests monkeypatch this."""
    kwargs = {}
    if family == "openai-reasoning":
        kwargs["temperature"] = 1.0
    return LLMFactory.build(config, provider=provider, model=model, **kwargs)


HISTORY_TURN_CAP = 20
HISTORY_CHAR_CAP = 12_000
CONTEXT_FILE_DISPLAY_CAP = 12_000
# Per-attachment cap on extracted text injected into the prompt.
ATTACHMENT_TEXT_CAP = 20_000
_TEXT_MIME_EXACT = {
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
    "application/csv",
    "application/x-sh",
}


class CodegenError(RuntimeError):
    """Raised when the LLM cannot produce a usable code bundle."""


def _pdf_text(raw: bytes) -> str | None:
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(raw))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        return text.strip() or None
    except Exception:
        logger.exception("pdf text extraction failed")
        return None


def _attachment_text(att: Attachment) -> str | None:
    """Extracted text for a non-image attachment, or None to skip."""
    mime = att.mime_type.lower()
    try:
        raw = base64.b64decode(att.data, validate=False)
    except Exception:
        return None
    if mime == "application/pdf":
        text = _pdf_text(raw)
    elif mime.startswith("text/") or mime in _TEXT_MIME_EXACT:
        text = raw.decode("utf-8", errors="replace")
    else:
        return None  # images handled separately; other binaries skipped
    if not text:
        return None
    return text[:ATTACHMENT_TEXT_CAP]


def _compose_human(text: str, attachments: list[Attachment] | None):
    """Human-message content: plain string, or a multimodal content list
    when the turn carries image attachments. Text/PDF attachments are
    appended to ``text`` as labeled blocks; images become image_url parts.
    """
    if not attachments:
        return text
    blocks: list[str] = []
    images: list[dict] = []
    for att in attachments:
        if att.mime_type.lower().startswith("image/"):
            images.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{att.mime_type};base64,{att.data}"
                    },
                }
            )
            continue
        extracted = _attachment_text(att)
        if extracted:
            blocks.append(f"----- Attached file: {att.name} -----\n{extracted}")
    full_text = text
    if blocks:
        full_text = (
            f"{text}\n\nAttached files provided by the user for context:\n\n"
            + "\n\n".join(blocks)
        )
    if not images:
        return full_text
    return [{"type": "text", "text": full_text}, *images]


def _history_to_messages(
    records: list[PromptRecord] | None,
) -> list[BaseMessage]:
    if not records:
        return []

    selected: list[BaseMessage] = []
    total_chars = 0
    for rec in reversed(records):
        if rec.role == "user":
            msg: BaseMessage = HumanMessage(content=rec.content)
        elif rec.role == "assistant":
            msg = AIMessage(content=rec.content)
        else:
            continue
        next_chars = total_chars + len(rec.content)
        if selected and (len(selected) >= HISTORY_TURN_CAP or next_chars > HISTORY_CHAR_CAP):
            break
        selected.append(msg)
        total_chars = next_chars

    selected.reverse()
    return selected


def _render_context_block(context: ProjectContext) -> str:
    if not context.tree_summary and not context.files:
        return "Current project: (empty — this is the first turn)."

    parts: list[str] = []
    parts.append("Current project files (path (size in chars)):")
    parts.append(context.tree_summary or "(no files yet)")

    if context.placeholder_files:
        listed = ", ".join(sorted(context.placeholder_files))
        parts.append("")
        parts.append(
            "These files still hold unmodified starter-scaffold placeholder "
            f"content and should be overwritten with `replace` (not `edit`) "
            f"when the user asks for any substantive change: {listed}."
        )

    if context.files:
        parts.append("")
        parts.append("Contents of the most relevant files:")
        for path, body in context.files.items():
            display = body
            if len(display) > CONTEXT_FILE_DISPLAY_CAP:
                display = display[:CONTEXT_FILE_DISPLAY_CAP] + "\n/* ... truncated ... */"
            marker = " (placeholder scaffold)" if path in context.placeholder_files else ""
            parts.append(f"\n----- {path}{marker} -----\n{display}")

    return "\n".join(parts)


def _build_planner_messages(
    prompt: str,
    history: list[BaseMessage],
    context: ProjectContext,
    family: str,
    attachments: list[Attachment] | None = None,
) -> list[BaseMessage]:
    planner_prompt = get_prompt(family, "planner")
    human_content = (
        f"{_render_context_block(context)}\n\nUser request:\n{prompt or '(empty)'}"
    )
    if family == "openai-reasoning":
        return [
            HumanMessage(
                content=_compose_human(
                    f"{planner_prompt}\n\n{human_content}", attachments
                )
            ),
            *history,
        ]
    return [
        SystemMessage(content=planner_prompt),
        *history,
        HumanMessage(content=_compose_human(human_content, attachments)),
    ]


async def _plan(
    prompt: str,
    history: list[BaseMessage],
    context: ProjectContext,
    *,
    provider: str,
    model: str,
    family: str,
    config: CoreConfig,
    attachments: list[Attachment] | None = None,
) -> str:
    try:
        llm = build_llm(provider, model, config, family=family)
        msg = await llm.ainvoke(
            _build_planner_messages(prompt, history, context, family, attachments)
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("planner LLM call failed")
        raise CodegenError(f"planner failed: {exc}") from exc

    plan_text = msg.content.strip() if isinstance(msg.content, str) else ""
    if not plan_text:
        raise CodegenError("planner returned empty response")
    return plan_text


def _build_codegen_messages(
    prompt: str,
    plan: str,
    history: list[BaseMessage],
    context: ProjectContext,
    family: str,
    attachments: list[Attachment] | None = None,
) -> list[BaseMessage]:
    codegen_prompt = get_prompt(family, "codegen")
    human_content = (
        f"{_render_context_block(context)}\n\n"
        f"User request:\n{prompt or '(empty)'}\n\n"
        f"Plan:\n{plan or '(none)'}\n\n"
        "Use the available tools to implement the plan. Call read_file to "
        "inspect existing files before modifying them, search_replace for "
        "targeted edits to existing files, write_patch to create or fully "
        "overwrite files, and shell_exec (only if needed) to run build or "
        "test commands. Call webfetch to read documentation or any external "
        "URL the user references. If the request is genuinely ambiguous and a wrong "
        "guess would waste significant work, call question to ask the user "
        "before proceeding. Proceed tool call by tool call until the task is "
        "complete, then stop calling tools."
    )
    if family == "openai-reasoning":
        return [
            HumanMessage(
                content=_compose_human(
                    f"{codegen_prompt}\n\n{human_content}", attachments
                )
            ),
            *history,
        ]
    return [
        SystemMessage(content=codegen_prompt),
        *history,
        HumanMessage(content=_compose_human(human_content, attachments)),
    ]


# ---------------------------------------------------------------------------
# Approval registry and gate (seam monkeypatched in tests)
# ---------------------------------------------------------------------------

# Maps request_id -> {tool_call_id: (asyncio.Event, result_holder)}
_approval_registry: dict[str, dict[str, tuple[asyncio.Event, list[bool]]]] = {}

# Maps request_id -> {tool_call_id: (asyncio.Event, answer_holder)}
_answer_registry: dict[str, dict[str, tuple[asyncio.Event, list[str]]]] = {}

# Fed to the LLM as the tool result when the user never answers a question.
_QUESTION_TIMEOUT_SENTINEL = (
    "(The user did not respond within the time limit. Proceed using your best "
    "judgment and reasonable default assumptions.)"
)


async def _check_approval(request_id: str, tool_call_id: str) -> bool:
    """Wait for user approval of a pending shell_exec; return the decision.

    Monkeypatched in tests to return True/False immediately.
    """
    pending = _approval_registry.get(request_id, {}).get(tool_call_id)
    if pending is None:
        return False
    event, result_holder = pending
    try:
        await asyncio.wait_for(event.wait(), timeout=300.0)
        return result_holder[0] if result_holder else False
    except asyncio.TimeoutError:
        return False


async def _check_answer(request_id: str, tool_call_id: str) -> str | None:
    """Wait for the user's answer to a pending question.

    Returns the answer text, or ``None`` if no answer arrives before the
    timeout. Monkeypatched in tests to return an answer immediately.
    """
    pending = _answer_registry.get(request_id, {}).get(tool_call_id)
    if pending is None:
        return None
    event, answer_holder = pending
    try:
        await asyncio.wait_for(event.wait(), timeout=300.0)
        return answer_holder[0] if answer_holder else None
    except asyncio.TimeoutError:
        return None


# ---------------------------------------------------------------------------
# Tool-calling codegen loop
# ---------------------------------------------------------------------------


async def _codegen_tool_loop(
    prompt: str,
    plan: str,
    history: list[BaseMessage],
    context: ProjectContext,
    *,
    provider: str,
    model: str,
    family: str,
    config: CoreConfig,
    storage: Storage,
    project_id: str,
    request_id: str,
    attachments: list[Attachment] | None = None,
) -> AsyncIterator[StreamEvent]:
    try:
        llm = build_llm(provider, model, config, family=family)
    except Exception as exc:
        raise CodegenError(f"codegen llm init failed: {exc}") from exc

    bound_llm = llm.bind_tools(ALL_TOOLS)
    messages: list[BaseMessage] = _build_codegen_messages(
        prompt, plan, history, context, family, attachments
    )
    project_root = storage.project_dir(project_id)

    # Session checklist maintained by the todowrite/todoread tools. Lives for
    # the duration of this tool loop (one request).
    todos: list[TodoItem] = []

    _approval_registry[request_id] = {}
    _answer_registry[request_id] = {}

    try:
        for iteration in range(config.max_tool_iterations + 1):
            try:
                response = await bound_llm.ainvoke(messages)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("codegen tool loop LLM call failed")
                raise CodegenError(f"codegen failed: {exc}") from exc

            tool_calls = getattr(response, "tool_calls", None) or []

            if not tool_calls:
                return

            if iteration >= config.max_tool_iterations:
                yield StatusEvent(stage="max_iterations_reached")
                return

            messages.append(response)

            for tc in tool_calls:
                tool_call_id: str = tc["id"]
                tool_name: str = tc["name"]
                args: dict = tc.get("args") or {}
                reason: str = args.get("reason", "")

                yield ToolCallEvent(
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    args=args,
                    reason=reason,
                )

                if tool_name == "shell_exec":
                    command: str = args.get("command", "")
                    yield ToolPermissionRequestEvent(
                        tool_call_id=tool_call_id,
                        command=command,
                        reason=reason,
                    )

                    approval_event: asyncio.Event = asyncio.Event()
                    result_holder: list[bool] = []
                    _approval_registry[request_id][tool_call_id] = (approval_event, result_holder)

                    approved = await _check_approval(request_id, tool_call_id)

                    if not approved:
                        yield ToolDeniedEvent(tool_call_id=tool_call_id)
                        tool_result = '{"error": "user denied this command"}'
                    else:
                        output = await asyncio.to_thread(
                            execute_shell_exec,
                            command,
                            project_root,
                            config.shell_exec_output_limit,
                        )
                        yield ToolResultEvent(
                            tool_call_id=tool_call_id,
                            tool_name=tool_name,
                            output=output,
                            approved=True,
                        )
                        tool_result = output

                elif tool_name == "question":
                    question_text: str = args.get("question", "")
                    options = args.get("options") or []
                    yield ToolQuestionEvent(
                        tool_call_id=tool_call_id,
                        question=question_text,
                        options=list(options),
                    )

                    answer_event: asyncio.Event = asyncio.Event()
                    answer_holder: list[str] = []
                    _answer_registry[request_id][tool_call_id] = (answer_event, answer_holder)

                    answer = await _check_answer(request_id, tool_call_id)
                    if answer is None:
                        answer = _QUESTION_TIMEOUT_SENTINEL

                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=answer,
                        approved=True,
                    )
                    tool_result = answer

                elif tool_name == "read_file":
                    output = execute_read_file(args.get("path", ""), project_root)
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=output,
                        approved=True,
                    )
                    tool_result = output

                elif tool_name == "write_patch":
                    result_msg, file_event = execute_write_patch(
                        args.get("path", ""),
                        args.get("content", ""),
                        project_root,
                        storage,
                        project_id,
                    )
                    if file_event is not None:
                        yield file_event
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=result_msg,
                        approved=True,
                    )
                    tool_result = result_msg

                elif tool_name == "search_replace":
                    result_msg, file_event = execute_search_replace(
                        args.get("path", ""),
                        args.get("old_str", ""),
                        args.get("new_str", ""),
                        project_root,
                        storage,
                        project_id,
                    )
                    if file_event is not None:
                        yield file_event
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=result_msg,
                        approved=True,
                    )
                    tool_result = result_msg

                elif tool_name == "grep":
                    output = await asyncio.to_thread(
                        execute_grep,
                        args.get("pattern", ""),
                        args.get("path", "."),
                        project_root,
                    )
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=output,
                        approved=True,
                    )
                    tool_result = output

                elif tool_name == "glob":
                    output = await asyncio.to_thread(
                        execute_glob,
                        args.get("pattern", ""),
                        args.get("path", "."),
                        project_root,
                    )
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=output,
                        approved=True,
                    )
                    tool_result = output

                elif tool_name == "list_files":
                    output = await asyncio.to_thread(
                        execute_list_files,
                        args.get("path", "."),
                        project_root,
                    )
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=output,
                        approved=True,
                    )
                    tool_result = output

                elif tool_name == "webfetch":
                    output = await execute_webfetch(
                        args.get("url", ""),
                        args.get("format", "markdown"),
                        timeout=config.webfetch_timeout,
                        output_limit=config.webfetch_output_limit,
                        max_bytes=config.webfetch_max_bytes,
                        block_private=config.webfetch_block_private_ips,
                    )
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=output,
                        approved=True,
                    )
                    tool_result = output

                elif tool_name == "todowrite":
                    todos, tool_result = execute_todowrite(args.get("todos"))
                    yield TodoUpdateEvent(todos=list(todos))
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=tool_result,
                        approved=True,
                    )

                elif tool_name == "todoread":
                    tool_result = execute_todoread(todos)
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=tool_result,
                        approved=True,
                    )

                else:
                    tool_result = f"error: unknown tool {tool_name!r}"
                    yield ToolResultEvent(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        output=tool_result,
                        approved=True,
                    )

                messages.append(ToolMessage(content=tool_result, tool_call_id=tool_call_id))
    finally:
        _approval_registry.pop(request_id, None)
        _answer_registry.pop(request_id, None)


async def run_codegen_stream(
    *,
    project_id: str,
    prompt: str,
    history: list[PromptRecord] | None = None,
    storage: Storage | None = None,
    config: CoreConfig | None = None,
    provider: str | None = None,
    model: str | None = None,
    family: str | None = None,
    mode: str = "build",
    attachments: list[Attachment] | None = None,
    request_id: str | None = None,
) -> AsyncIterator[StreamEvent]:
    current = config or CoreConfig()
    resolved_request_id = request_id or uuid.uuid4().hex

    yield StatusEvent(stage="planning", note="Reading project")

    try:
        resolved_provider, resolved_model, catalog_family = model_catalog.resolve(
            provider, model, current
        )
        resolved_family = family if family is not None else catalog_family
    except ValueError as exc:
        yield ErrorEvent(message=str(exc), recoverable=False)
        return

    if resolved_provider == "ollama":
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.get(f"{current.ollama_base_url}/api/tags")
        except Exception:
            yield ErrorEvent(
                message=(
                    f"Ollama is not running at {current.ollama_base_url}. "
                    "Start Ollama and try again."
                ),
                recoverable=False,
            )
            return
    if resolved_provider == "openai" and not current.openai_api_key:
        yield ErrorEvent(
            message=_missing_api_key_message("openai", current), recoverable=False
        )
        return
    if resolved_provider == "gemini" and not current.google_api_key:
        yield ErrorEvent(
            message=_missing_api_key_message("gemini", current), recoverable=False
        )
        return

    store = storage or Storage(current.opener_apps_dir)

    try:
        context = load_context(store, project_id, prompt)
    except Exception as exc:
        logger.exception("failed to load project context")
        yield ErrorEvent(message=f"context load failed: {exc}", recoverable=False)
        return

    history_msgs = _history_to_messages(history)

    try:
        plan_text = await _plan(
            prompt,
            history_msgs,
            context,
            provider=resolved_provider,
            model=resolved_model,
            family=resolved_family,
            config=current,
            attachments=attachments,
        )
    except CodegenError as exc:
        logger.warning("codegen plan failed: %s", exc)
        yield ErrorEvent(message=str(exc), recoverable=False)
        return
    except Exception as exc:
        logger.exception("planner crashed")
        yield ErrorEvent(message=f"planner crashed: {exc}", recoverable=False)
        return

    yield MessageDeltaEvent(content=plan_text + "\n")

    if mode == "plan":
        yield StatusEvent(stage="plan_ready")
        return

    snapshot_id: str | None = None
    try:
        record = store.create_snapshot(project_id, user_prompt=prompt)
        snapshot_id = record.id
    except Exception:
        logger.exception("failed to create pre-turn snapshot for %s", project_id)

    yield StatusEvent(stage="generating", note="Writing files", snapshot_id=snapshot_id)

    hit_cap = False
    try:
        async for event in _codegen_tool_loop(
            prompt,
            plan_text,
            history_msgs,
            context,
            provider=resolved_provider,
            model=resolved_model,
            family=resolved_family,
            config=current,
            storage=store,
            project_id=project_id,
            request_id=resolved_request_id,
            attachments=attachments,
        ):
            yield event
            if event.type == "status" and getattr(event, "stage", None) == "max_iterations_reached":
                hit_cap = True
    except CodegenError as exc:
        logger.warning("codegen tool loop failed: %s", exc)
        yield ErrorEvent(message=str(exc), recoverable=False)
        return
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("codegen tool loop crashed")
        yield ErrorEvent(message=f"codegen crashed: {exc}", recoverable=False)
        return

    if not hit_cap:
        yield StatusEvent(stage="done")

"""Tool execution functions for the LLM tool-calling loop.

LangChain StructuredTool instances are used only to generate the JSON schema
for llm.bind_tools().  Actual execution is handled by the orchestrator loop,
not by LangChain's tool runner.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from langchain_core.tools import StructuredTool
from pydantic import BaseModel
from pydantic import Field as PField

from .patcher import _ensure_use_client, _normalize_path, _path_is_safe, _truncate
from .storage import Storage, safe_join


# ---------------------------------------------------------------------------
# Execution functions
# ---------------------------------------------------------------------------


def execute_read_file(path: str, project_root: Path) -> str:
    """Read a file relative to project root; return contents or an error string."""
    rel = _normalize_path(path)
    if rel is None:
        return "error: empty path"
    if not _path_is_safe(rel):
        return f"error: path outside project root: {path!r}"
    try:
        return safe_join(project_root, rel).read_text(encoding="utf-8")
    except FileNotFoundError:
        return f"error: file not found: {path!r}"
    except OSError as exc:
        return f"error: {exc}"


def execute_write_patch(
    path: str,
    content: str,
    project_root: Path,
    storage: Storage,
    project_id: str,
) -> tuple[str, "FileWriteEvent | None"]:
    """Create or overwrite a file; return (result_message, FileWriteEvent|None)."""
    from .schemas.stream import FileWriteEvent

    rel = _normalize_path(path)
    if rel is None:
        return "error: empty path", None
    if not _path_is_safe(rel):
        return f"error: path outside project root: {path!r}", None

    final_content = _ensure_use_client(rel, content)
    final_content = _truncate(final_content)

    try:
        storage.write_file(project_id, rel, final_content)
    except (ValueError, OSError) as exc:
        return f"error writing file: {exc}", None

    return f"wrote {rel}", FileWriteEvent(path=rel, content=final_content)


def execute_shell_exec(command: str, cwd: Path, output_limit: int) -> str:
    """Run a shell command; return combined stdout+stderr (truncated)."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=60,
        )
        output = result.stdout + result.stderr
        if len(output) > output_limit:
            output = output[:output_limit] + f"\n[truncated at {output_limit} bytes]"
        return output
    except subprocess.TimeoutExpired:
        return "error: command timed out after 60 seconds"
    except OSError as exc:
        return f"error: {exc}"


# ---------------------------------------------------------------------------
# LangChain tool schemas (for bind_tools — not invoked directly)
# ---------------------------------------------------------------------------


class _ReadFileInput(BaseModel):
    path: str = PField(description="File path relative to the project root")


class _WritePatchInput(BaseModel):
    path: str = PField(description="File path relative to the project root")
    content: str = PField(description="Full content to write (creates or overwrites the file)")


class _ShellExecInput(BaseModel):
    command: str = PField(description="Shell command to execute in the project directory")
    reason: str = PField(description="Why this command is needed (shown to the user for approval)")


READ_FILE_TOOL = StructuredTool.from_function(
    lambda path: "",
    name="read_file",
    description="Read the current contents of a project file.",
    args_schema=_ReadFileInput,
)

WRITE_PATCH_TOOL = StructuredTool.from_function(
    lambda path, content: "",
    name="write_patch",
    description="Create or overwrite a file with the given full content.",
    args_schema=_WritePatchInput,
)

SHELL_EXEC_TOOL = StructuredTool.from_function(
    lambda command, reason: "",
    name="shell_exec",
    description=(
        "Run a shell command in the project directory. "
        "Always requires explicit user approval before execution."
    ),
    args_schema=_ShellExecInput,
)

ALL_TOOLS = [READ_FILE_TOOL, WRITE_PATCH_TOOL, SHELL_EXEC_TOOL]

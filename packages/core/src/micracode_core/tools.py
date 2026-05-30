"""Tool execution functions for the LLM tool-calling loop.

LangChain StructuredTool instances are used only to generate the JSON schema
for llm.bind_tools().  Actual execution is handled by the orchestrator loop,
not by LangChain's tool runner.
"""

from __future__ import annotations

import re
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


def execute_grep(pattern: str, path: str, project_root: Path) -> str:
    """Search for a regex pattern in files; return matching lines with file:lineno."""
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        return f"error: invalid pattern: {exc}"

    if path and path != ".":
        rel = _normalize_path(path)
        if rel is None:
            return "error: empty path"
        if not _path_is_safe(rel):
            return f"error: path outside project root: {path!r}"
        search_root = safe_join(project_root, rel)
    else:
        search_root = project_root

    if not search_root.exists():
        return f"error: path not found: {path!r}"

    candidates = [search_root] if search_root.is_file() else sorted(search_root.rglob("*"))
    results: list[str] = []
    for file_path in candidates:
        if not file_path.is_file():
            continue
        try:
            text = file_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if regex.search(line):
                rel_display = file_path.relative_to(project_root)
                results.append(f"{rel_display}:{lineno}: {line}")
            if len(results) >= 200:
                break
        if len(results) >= 200:
            break

    if not results:
        return "no matches found"
    return "\n".join(results)


def execute_list_files(path: str, project_root: Path) -> str:
    """List files and subdirectories at path relative to project root."""
    if path and path != ".":
        rel = _normalize_path(path)
        if rel is None:
            return "error: empty path"
        if not _path_is_safe(rel):
            return f"error: path outside project root: {path!r}"
        target = safe_join(project_root, rel)
    else:
        target = project_root

    if not target.exists():
        return f"error: path not found: {path!r}"
    if not target.is_dir():
        return f"error: not a directory: {path!r}"

    entries = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    lines = [
        str(e.relative_to(project_root)) + ("/" if e.is_dir() else "")
        for e in entries
    ]
    return "\n".join(lines) if lines else "(empty directory)"


def execute_search_replace(
    path: str,
    old_str: str,
    new_str: str,
    project_root: Path,
    storage: Storage,
    project_id: str,
) -> tuple[str, "FileWriteEvent | None"]:
    """Replace the unique occurrence of old_str with new_str in a file."""
    from .schemas.stream import FileWriteEvent

    rel = _normalize_path(path)
    if rel is None:
        return "error: empty path", None
    if not _path_is_safe(rel):
        return f"error: path outside project root: {path!r}", None

    file_path = safe_join(project_root, rel)
    try:
        current = file_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return f"error: file not found: {path!r}", None
    except OSError as exc:
        return f"error: {exc}", None

    count = current.count(old_str)
    if count == 0:
        return "error: search string not found in file", None
    if count > 1:
        return f"error: search string matches {count} times — make old_str more specific", None

    new_content = current.replace(old_str, new_str, 1)
    final_content = _ensure_use_client(rel, new_content)
    final_content = _truncate(final_content)

    try:
        storage.write_file(project_id, rel, final_content)
    except (ValueError, OSError) as exc:
        return f"error writing file: {exc}", None

    return f"replaced in {rel}", FileWriteEvent(path=rel, content=final_content)


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


class _GrepInput(BaseModel):
    pattern: str = PField(description="Regular expression pattern to search for")
    path: str = PField(description="File or directory to search in (relative to project root). Use '.' for the entire project.")


class _ListFilesInput(BaseModel):
    path: str = PField(description="Directory to list (relative to project root). Use '.' for the project root.")


class _SearchReplaceInput(BaseModel):
    path: str = PField(description="File path relative to the project root")
    old_str: str = PField(description="Exact string to find (must appear exactly once in the file)")
    new_str: str = PField(description="String to replace it with")


class _QuestionInput(BaseModel):
    question: str = PField(
        description="A single, specific clarifying question to ask the user"
    )
    options: list[str] | None = PField(
        default=None,
        description=(
            "Optional list of suggested answers for the user to pick from. "
            "The user may still reply with free-form text instead of choosing one."
        ),
    )


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

GREP_TOOL = StructuredTool.from_function(
    lambda pattern, path: "",
    name="grep",
    description="Search for a regex pattern across project files. Returns matching lines with file path and line number.",
    args_schema=_GrepInput,
)

LIST_FILES_TOOL = StructuredTool.from_function(
    lambda path: "",
    name="list_files",
    description="List files and subdirectories at a given path within the project.",
    args_schema=_ListFilesInput,
)

SEARCH_REPLACE_TOOL = StructuredTool.from_function(
    lambda path, old_str, new_str: "",
    name="search_replace",
    description=(
        "Replace an exact substring in a file. "
        "old_str must appear exactly once; include more surrounding context if needed. "
        "Prefer this over write_patch for targeted edits to existing files."
    ),
    args_schema=_SearchReplaceInput,
)

QUESTION_TOOL = StructuredTool.from_function(
    lambda question, options=None: "",
    name="question",
    description=(
        "Ask the user a clarifying question and pause until they answer. "
        "Use this when the request is ambiguous and a wrong assumption would "
        "waste significant work — not for trivial choices you can reasonably "
        "make yourself. Ask one focused question at a time; optionally supply "
        "a few suggested answers via `options`. The user's reply is returned "
        "as the tool result."
    ),
    args_schema=_QuestionInput,
)

ALL_TOOLS = [
    READ_FILE_TOOL,
    WRITE_PATCH_TOOL,
    SHELL_EXEC_TOOL,
    GREP_TOOL,
    LIST_FILES_TOOL,
    SEARCH_REPLACE_TOOL,
    QUESTION_TOOL,
]

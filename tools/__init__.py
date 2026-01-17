"""
Tools package for Micracode AI coding assistant.

This package contains LangChain tools that the agent can use to interact
with the filesystem, execute commands, and search code.
"""

from .file_ops import read_file, write_file
from .search import grep_search, find_files
from .propose_edit import propose_edit, PROPOSE_EDIT_MARKER

# Tool registry - all available tools for the agent
ALL_TOOLS = [
    read_file,
    write_file,
    grep_search,
    find_files,
    propose_edit,
]

__all__ = [
    "read_file",
    "write_file",
    "grep_search",
    "find_files",
    "propose_edit",
    "PROPOSE_EDIT_MARKER",
    "ALL_TOOLS",
]


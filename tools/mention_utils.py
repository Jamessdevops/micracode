"""Utility functions for handling @file mentions in messages."""

import re
from pathlib import Path
from typing import Optional


def extract_file_mentions(text: str) -> list[str]:
    """Extract all @filepath mentions from text.
    
    Args:
        text: The message text to parse
        
    Returns:
        List of file paths mentioned with @ prefix
        
    Examples:
        >>> extract_file_mentions("check @main.py and @src/utils.py")
        ['main.py', 'src/utils.py']
    """
    # Match @ followed by non-whitespace characters
    pattern = r"@(\S+)"
    return re.findall(pattern, text)


def read_file_content(path: str, max_lines: int = 500) -> Optional[str]:
    """Read file content for context injection.
    
    Args:
        path: Path to the file to read
        max_lines: Maximum number of lines to include (for large files)
        
    Returns:
        File content as string, or None if file cannot be read
    """
    try:
        file_path = Path(path)
        
        if not file_path.exists():
            return None
        
        if not file_path.is_file():
            return None
        
        content = file_path.read_text(encoding="utf-8")
        lines = content.splitlines()
        
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            content = "\n".join(lines)
            content += f"\n\n... (file truncated, showing first {max_lines} lines)"
        
        return content
        
    except (PermissionError, UnicodeDecodeError, OSError):
        return None


def build_context_message(message: str, file_contexts: list[dict]) -> str:
    """Build an augmented message with file contents included.
    
    Args:
        message: The original user message
        file_contexts: List of dicts with 'path' and 'content' keys
        
    Returns:
        Message with file contents prepended as context
    """
    if not file_contexts:
        return message
    
    context_parts = []
    for ctx in file_contexts:
        path = ctx.get("path", "unknown")
        content = ctx.get("content", "")
        context_parts.append(f'<file path="{path}">\n{content}\n</file>')
    
    file_context_block = "\n\n".join(context_parts)
    
    return f"{file_context_block}\n\nUser message: {message}"


def prepare_message_with_context(message: str, base_path: str = ".") -> str:
    """Parse message for @mentions, read files, and build context message.
    
    This is a convenience function that combines extract, read, and build steps.
    
    Args:
        message: The user's message that may contain @file mentions
        base_path: Base directory to resolve relative file paths
        
    Returns:
        Message with file contents included, or original message if no files found
    """
    mentions = extract_file_mentions(message)
    
    if not mentions:
        return message
    
    base = Path(base_path).resolve()
    file_contexts = []
    
    for mention in mentions:
        # Try to resolve the path
        file_path = base / mention
        content = read_file_content(str(file_path))
        
        if content is not None:
            file_contexts.append({
                "path": mention,
                "content": content,
            })
    
    return build_context_message(message, file_contexts)

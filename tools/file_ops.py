"""
File operation tools for Micracode AI coding assistant.

These tools allow the agent to read, write, and manipulate files.
"""

from pathlib import Path
from langchain_core.tools import tool

# Maximum file size to read (100KB)
MAX_FILE_SIZE_BYTES = 100 * 1024


def _is_binary_file(file_path: Path) -> bool:
    """Check if a file is binary by reading the first chunk."""
    try:
        with open(file_path, "rb") as f:
            chunk = f.read(8192)
            # Check for null bytes which indicate binary content
            if b"\x00" in chunk:
                return True
            # Check ratio of non-text bytes
            text_chars = bytearray({7, 8, 9, 10, 12, 13, 27} | set(range(0x20, 0x100)) - {0x7F})
            non_text = sum(1 for byte in chunk if byte not in text_chars)
            if len(chunk) > 0 and non_text / len(chunk) > 0.30:
                return True
        return False
    except Exception:
        return False


@tool
def read_file(path: str, include_line_numbers: bool = False) -> str:
    """Read the contents of a file at the given path.
    
    Use this tool to read source code, configuration files, documentation,
    or any text file. The tool handles encoding detection and provides
    helpful error messages for common issues.
    
    Args:
        path: Absolute or relative path to the file to read.
        include_line_numbers: If True, prefix each line with its line number.
        
    Returns:
        The file contents as a string, or an error message if the file
        cannot be read.
        
    Examples:
        - read_file("/path/to/file.py") -> Returns file contents
        - read_file("./src/main.py", include_line_numbers=True) -> With line numbers
    """
    try:
        file_path = Path(path).resolve()
        
        # Check if file exists
        if not file_path.exists():
            return f"Error: File not found at '{path}'"
        
        # Check if it's a file (not a directory)
        if not file_path.is_file():
            return f"Error: '{path}' is a directory, not a file"
        
        # Check file size
        file_size = file_path.stat().st_size
        if file_size > MAX_FILE_SIZE_BYTES:
            size_kb = file_size / 1024
            max_kb = MAX_FILE_SIZE_BYTES / 1024
            return (
                f"Error: File exceeds size limit. "
                f"Size: {size_kb:.1f}KB, Limit: {max_kb:.0f}KB. "
                f"Consider reading specific sections or using a search tool."
            )
        
        # Check for binary files
        if _is_binary_file(file_path):
            return (
                f"Error: '{path}' appears to be a binary file. "
                f"Binary files cannot be read as text."
            )
        
        # Try reading with UTF-8 first, then fall back to other encodings
        encodings = ["utf-8", "utf-8-sig", "latin-1", "cp1252"]
        content = None
        
        for encoding in encodings:
            try:
                with open(file_path, "r", encoding=encoding) as f:
                    content = f.read()
                break
            except UnicodeDecodeError:
                continue
        
        if content is None:
            return f"Error: Unable to decode file '{path}'. Unsupported encoding."
        
        # Add line numbers if requested
        if include_line_numbers:
            lines = content.splitlines(keepends=True)
            width = len(str(len(lines)))
            numbered_lines = [
                f"{i+1:>{width}}: {line}" 
                for i, line in enumerate(lines)
            ]
            content = "".join(numbered_lines)
            # Remove trailing newline that splitlines might add
            if content.endswith("\n: "):
                content = content[:-3]
        
        return content
        
    except PermissionError:
        return f"Error: Permission denied. Cannot read '{path}'"
    except Exception as e:
        return f"Error reading file '{path}': {str(e)}"


@tool
def write_file(path: str, content: str, create_directories: bool = True) -> str:
    """Write content to a file at the given path.
    
    Use this tool to create new files or overwrite existing files.
    Parent directories will be created automatically if they don't exist.
    
    Args:
        path: Absolute or relative path to the file to write.
        content: The content to write to the file.
        create_directories: If True, create parent directories if they don't exist.
        
    Returns:
        A success message with the file path, or an error message if the
        operation fails.
        
    Examples:
        - write_file("src/new_file.py", "print('hello')") -> Creates file
        - write_file("/path/to/config.json", '{"key": "value"}') -> Writes JSON
    """
    try:
        file_path = Path(path).resolve()
        
        # Check if path points to an existing directory
        if file_path.exists() and file_path.is_dir():
            return f"Error: '{path}' is a directory, not a file"
        
        # Create parent directories if needed
        parent_dir = file_path.parent
        if not parent_dir.exists():
            if create_directories:
                parent_dir.mkdir(parents=True, exist_ok=True)
            else:
                return f"Error: Parent directory '{parent_dir}' does not exist"
        
        # Check if we're overwriting an existing file
        is_new_file = not file_path.exists()
        
        # Write the content
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        
        # Calculate stats
        lines = content.count('\n') + (1 if content and not content.endswith('\n') else 0)
        size_bytes = len(content.encode('utf-8'))
        
        action = "Created" if is_new_file else "Updated"
        return f"{action} '{file_path}' ({lines} lines, {size_bytes} bytes)"
        
    except PermissionError:
        return f"Error: Permission denied. Cannot write to '{path}'"
    except OSError as e:
        return f"Error: Cannot write to '{path}': {e.strerror}"
    except Exception as e:
        return f"Error writing file '{path}': {str(e)}"

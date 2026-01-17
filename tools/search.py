"""
Search tools for Micracode AI coding assistant.

These tools allow the agent to search for patterns in files and find files.
"""

import re
import subprocess
from pathlib import Path
from typing import Optional
from langchain_core.tools import tool

# Maximum number of results to return
MAX_RESULTS = 50

# Maximum context lines to show
MAX_CONTEXT_LINES = 3


@tool
def grep_search(
    pattern: str,
    path: str = ".",
    file_pattern: Optional[str] = None,
    case_sensitive: bool = True,
    context_lines: int = 0,
    is_regex: bool = False,
) -> str:
    """Search for a pattern in files within a directory.
    
    Use this tool to find occurrences of text patterns in source code,
    configuration files, or any text files. Supports both literal strings
    and regular expressions.
    
    Args:
        pattern: The text or regex pattern to search for.
        path: Directory or file path to search in. Defaults to current directory.
        file_pattern: Optional glob pattern to filter files (e.g., "*.py", "*.js").
        case_sensitive: If True, search is case-sensitive. Default is True.
        context_lines: Number of lines to show before/after each match (0-3).
        is_regex: If True, treat pattern as a regular expression.
        
    Returns:
        Formatted search results showing file paths, line numbers, and matching
        lines. Returns an error message if the search fails.
        
    Examples:
        - grep_search("def main", "src/") -> Find "def main" in src/
        - grep_search("TODO", file_pattern="*.py") -> Find TODOs in Python files
        - grep_search("import.*os", is_regex=True) -> Regex search for os imports
    """
    try:
        search_path = Path(path).resolve()
        
        # Validate path exists
        if not search_path.exists():
            return f"Error: Path '{path}' does not exist"
        
        # Clamp context lines
        context_lines = max(0, min(context_lines, MAX_CONTEXT_LINES))
        
        # Build grep command
        # Use grep as it's available on macOS
        cmd = ["grep", "-r", "-n", "--include=*"]
        
        # Add options
        if not case_sensitive:
            cmd.append("-i")
        
        if context_lines > 0:
            cmd.extend(["-A", str(context_lines), "-B", str(context_lines)])
        
        if is_regex:
            cmd.append("-E")
        else:
            cmd.append("-F")  # Fixed string (literal)
        
        # Add file pattern filter
        if file_pattern:
            # Replace the generic include with specific pattern
            cmd = [c for c in cmd if c != "--include=*"]
            cmd.append(f"--include={file_pattern}")
        
        # Add pattern and path
        cmd.extend([pattern, str(search_path)])
        
        # Run grep
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(search_path) if search_path.is_dir() else str(search_path.parent)
        )
        
        # grep returns 1 if no matches found (not an error)
        if result.returncode == 1 and not result.stdout:
            return f"No matches found for '{pattern}' in '{path}'"
        
        if result.returncode > 1:
            return f"Error: grep failed: {result.stderr.strip()}"
        
        # Parse and format results
        lines = result.stdout.strip().split('\n')
        
        if len(lines) > MAX_RESULTS:
            lines = lines[:MAX_RESULTS]
            truncated = True
        else:
            truncated = False
        
        # Format output
        output_lines = []
        for line in lines:
            if line.strip():
                # Make paths relative to search_path for readability
                if str(search_path) in line and search_path.is_dir():
                    line = line.replace(str(search_path) + "/", "")
                output_lines.append(line)
        
        result_text = '\n'.join(output_lines)
        
        if truncated:
            result_text += f"\n\n... (truncated, showing first {MAX_RESULTS} matches)"
        
        match_count = len([l for l in output_lines if l and not l.startswith('--')])
        header = f"Found {match_count} matches for '{pattern}':\n\n"
        
        return header + result_text
        
    except subprocess.TimeoutExpired:
        return f"Error: Search timed out after 30 seconds"
    except FileNotFoundError:
        return "Error: grep command not found. Please ensure grep is installed."
    except Exception as e:
        return f"Error searching for '{pattern}': {str(e)}"


@tool
def find_files(
    pattern: str = "*",
    path: str = ".",
    file_type: Optional[str] = None,
    max_depth: Optional[int] = None,
) -> str:
    """Find files and directories matching a pattern.
    
    Use this tool to locate files by name pattern within a directory tree.
    Supports glob patterns for flexible matching.
    
    Args:
        pattern: Glob pattern to match file names (e.g., "*.py", "test_*").
        path: Directory to search in. Defaults to current directory.
        file_type: Optional filter - "file" for files only, "dir" for directories.
        max_depth: Maximum directory depth to search (None for unlimited).
        
    Returns:
        List of matching file paths, or an error message if the search fails.
        
    Examples:
        - find_files("*.py", "src/") -> Find all Python files in src/
        - find_files("*test*", file_type="file") -> Find files with "test" in name
        - find_files("*", max_depth=2) -> List files up to 2 levels deep
    """
    try:
        search_path = Path(path).resolve()
        
        # Validate path exists
        if not search_path.exists():
            return f"Error: Path '{path}' does not exist"
        
        if not search_path.is_dir():
            return f"Error: '{path}' is not a directory"
        
        # Use find command for better performance
        cmd = ["find", str(search_path)]
        
        # Add max depth
        if max_depth is not None:
            cmd.extend(["-maxdepth", str(max_depth)])
        
        # Add type filter
        if file_type == "file":
            cmd.extend(["-type", "f"])
        elif file_type == "dir":
            cmd.extend(["-type", "d"])
        
        # Add name pattern
        cmd.extend(["-name", pattern])
        
        # Exclude hidden files and common ignore patterns
        cmd.extend(["!", "-path", "*/.git/*"])
        cmd.extend(["!", "-path", "*/.venv/*"])
        cmd.extend(["!", "-path", "*/__pycache__/*"])
        cmd.extend(["!", "-path", "*/node_modules/*"])
        
        # Run find
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        
        if result.returncode != 0:
            return f"Error: find failed: {result.stderr.strip()}"
        
        # Parse results
        files = [f for f in result.stdout.strip().split('\n') if f]
        
        if not files:
            return f"No files found matching '{pattern}' in '{path}'"
        
        # Make paths relative for readability
        relative_files = []
        for f in files:
            try:
                rel_path = Path(f).relative_to(search_path)
                relative_files.append(str(rel_path))
            except ValueError:
                relative_files.append(f)
        
        # Sort for consistent output
        relative_files.sort()
        
        # Truncate if too many
        if len(relative_files) > MAX_RESULTS:
            relative_files = relative_files[:MAX_RESULTS]
            truncated = True
        else:
            truncated = False
        
        result_text = '\n'.join(relative_files)
        
        header = f"Found {len(relative_files)} items matching '{pattern}':\n\n"
        
        if truncated:
            result_text += f"\n\n... (truncated, showing first {MAX_RESULTS} results)"
        
        return header + result_text
        
    except subprocess.TimeoutExpired:
        return f"Error: Search timed out after 30 seconds"
    except FileNotFoundError:
        return "Error: find command not found. Please ensure find is installed."
    except Exception as e:
        return f"Error finding files: {str(e)}"

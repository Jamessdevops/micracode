"""
Diff utility functions for generating and applying file diffs.
"""

import difflib
from pathlib import Path
from typing import List, Dict


def generate_diff_lines(original: str, proposed: str) -> List[Dict]:
    """Generate diff lines comparing original and proposed content.
    
    Args:
        original: The original file content
        proposed: The proposed new content
        
    Returns:
        List of dicts with keys:
            - old: old line number or ""
            - new: new line number or ""
            - content: line content
            - type: "ctx" (context), "add", or "del"
    """
    original_lines = original.splitlines(keepends=True)
    proposed_lines = proposed.splitlines(keepends=True)
    
    # Use unified_diff for better diff output
    diff = list(difflib.unified_diff(
        original_lines,
        proposed_lines,
        lineterm=""
    ))
    
    # Skip the header lines (---, +++, @@)
    diff_lines = []
    old_line = 0
    new_line = 0
    
    for line in diff:
        if line.startswith("---") or line.startswith("+++"):
            continue
        elif line.startswith("@@"):
            # Parse hunk header: @@ -start,count +start,count @@
            parts = line.split()
            if len(parts) >= 3:
                old_part = parts[1]  # -start,count
                new_part = parts[2]  # +start,count
                old_line = int(old_part.split(",")[0].lstrip("-")) - 1
                new_line = int(new_part.split(",")[0].lstrip("+")) - 1
        elif line.startswith("-"):
            old_line += 1
            diff_lines.append({
                "old": old_line,
                "new": "",
                "content": line[1:].rstrip("\n"),
                "type": "del"
            })
        elif line.startswith("+"):
            new_line += 1
            diff_lines.append({
                "old": "",
                "new": new_line,
                "content": line[1:].rstrip("\n"),
                "type": "add"
            })
        elif line.startswith(" "):
            old_line += 1
            new_line += 1
            diff_lines.append({
                "old": old_line,
                "new": new_line,
                "content": line[1:].rstrip("\n"),
                "type": "ctx"
            })
    
    return diff_lines


def apply_edit(file_path: str, new_content: str) -> str:
    """Apply the proposed edit by writing new content to file.
    
    Args:
        file_path: Path to the file to edit
        new_content: The new content to write
        
    Returns:
        Success or error message
    """
    try:
        path = Path(file_path).resolve()
        
        # Create parent directories if needed
        path.parent.mkdir(parents=True, exist_ok=True)
        
        # Write the new content
        is_new = not path.exists()
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_content)
        
        lines = new_content.count('\n') + (1 if new_content and not new_content.endswith('\n') else 0)
        action = "Created" if is_new else "Updated"
        return f"{action} '{path}' ({lines} lines)"
        
    except PermissionError:
        return f"Error: Permission denied. Cannot write to '{file_path}'"
    except Exception as e:
        return f"Error writing file: {str(e)}"


def read_file_content(file_path: str) -> str:
    """Read file content, returning empty string if file doesn't exist.
    
    Args:
        file_path: Path to the file to read
        
    Returns:
        File content or empty string
    """
    try:
        path = Path(file_path).resolve()
        if not path.exists():
            return ""
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""

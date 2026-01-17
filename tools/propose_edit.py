"""
Propose edit tool for Micracode AI coding assistant.

This tool allows the agent to propose file edits that require user approval
before being applied.
"""

import json
from pathlib import Path
from langchain_core.tools import tool

from .diff_utils import read_file_content


# Special marker prefix for propose_edit results
PROPOSE_EDIT_MARKER = "[[PROPOSE_EDIT]]"


@tool
def propose_edit(path: str, new_content: str, description: str = "") -> str:
    """Propose a file edit for user review before applying.
    
    Use this tool when you want to show the user a proposed change and let them
    decide whether to accept or reject it. The user will see a diff view with
    Accept/Reject buttons.
    
    Args:
        path: Path to the file to edit (will be created if it doesn't exist)
        new_content: The proposed new content for the file
        description: Optional brief description of what this change does
        
    Returns:
        A special marker string containing the edit proposal data.
        The UI will render this as an interactive diff block.
        
    Examples:
        - propose_edit("src/main.py", "print('hello')", "Add greeting")
        - propose_edit("config.json", '{"key": "value"}', "Initialize config")
    """
    try:
        file_path = Path(path).resolve()
        
        # Read existing content (empty string if file doesn't exist)
        original_content = read_file_content(str(file_path))
        
        # Create proposal data
        proposal = {
            "file_path": str(file_path),
            "original_content": original_content,
            "proposed_content": new_content,
            "description": description,
        }
        
        # Return special marker with JSON payload
        return f"{PROPOSE_EDIT_MARKER}{json.dumps(proposal)}"
        
    except Exception as e:
        return f"Error creating proposal: {str(e)}"

"""File suggester widget for @ file tagging autocomplete."""

import os
from pathlib import Path
from typing import Optional

from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import OptionList
from textual.widgets.option_list import Option
from textual.reactive import reactive


# Directories to exclude from file scanning
EXCLUDE_DIRS = {
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    "node_modules",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "dist",
    "build",
    ".eggs",
}


class FileSuggester(Widget):
    """Autocomplete dropdown for file suggestions.
    
    Scans the workspace for files and provides fuzzy-matched suggestions
    based on user query.
    """

    DEFAULT_CSS = """
    FileSuggester {
        display: none;
        layer: overlay;
        max-height: 12;
        width: 100%;
        background: #1a1a1a;
        border: solid #333333;
    }
    
    FileSuggester.visible {
        display: block;
    }
    
    FileSuggester OptionList {
        padding: 0;
        border: none;
        background: transparent;
        height: auto;
        max-height: 10;
    }
    
    FileSuggester .option-list--option {
        padding: 0 1;
    }
    
    FileSuggester .option-list--option-highlighted {
        background: #4a9eff30;
    }
    """

    visible = reactive(False)

    def __init__(
        self,
        root_path: str = ".",
        id: Optional[str] = None,
        classes: Optional[str] = None,
    ):
        super().__init__(id=id, classes=classes)
        self.root_path = Path(root_path).resolve()
        self._all_files: list[str] = []
        self._scan_files()

    def _scan_files(self) -> None:
        """Scan the workspace for all indexable files."""
        self._all_files = []
        
        for root, dirs, files in os.walk(self.root_path):
            # Exclude certain directories (modifies dirs in-place)
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith(".")]
            
            for file in files:
                # Skip hidden files
                if file.startswith("."):
                    continue
                
                # Get relative path from root
                full_path = os.path.join(root, file)
                try:
                    rel_path = os.path.relpath(full_path, self.root_path)
                    self._all_files.append(rel_path)
                except ValueError:
                    # Can happen on Windows with different drives
                    pass
        
        # Sort for consistent ordering
        self._all_files.sort()

    def get_suggestions(self, query: str, limit: int = 8) -> list[str]:
        """Get files matching the query using fuzzy matching.
        
        Args:
            query: The search query (partial filename)
            limit: Maximum number of suggestions to return
            
        Returns:
            List of matching file paths, sorted by relevance
        """
        if not query:
            # Return first N files if no query
            return self._all_files[:limit]
        
        query_lower = query.lower()
        
        # Find matches
        matches = [f for f in self._all_files if query_lower in f.lower()]
        
        # Sort by relevance:
        # 1. Filename starts with query
        # 2. Query appears in filename (not just path)
        # 3. Shorter paths first
        def score(path: str) -> tuple:
            filename = Path(path).name.lower()
            return (
                not filename.startswith(query_lower),  # Filename starts with query = best
                query_lower not in filename,  # Query in filename = good
                len(path),  # Shorter paths = better
            )
        
        matches.sort(key=score)
        return matches[:limit]

    def compose(self) -> ComposeResult:
        yield OptionList(id="suggestions-list")

    def update_suggestions(self, query: str) -> None:
        """Update the option list with new suggestions."""
        suggestions = self.get_suggestions(query)
        option_list = self.query_one("#suggestions-list", OptionList)
        
        option_list.clear_options()
        
        for file_path in suggestions:
            option_list.add_option(Option(file_path, id=file_path))

    def show(self, query: str = "") -> None:
        """Show the suggester with suggestions for the given query."""
        self.update_suggestions(query)
        self.visible = True
        self.add_class("visible")

    def hide(self) -> None:
        """Hide the suggester."""
        self.visible = False
        self.remove_class("visible")

    def rescan(self) -> None:
        """Rescan the workspace for files."""
        self._scan_files()

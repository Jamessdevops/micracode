"""File tag input widget with @ mention autocomplete support."""

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Static, Input, OptionList
from textual.reactive import reactive
from textual.message import Message
from typing import Optional

from .file_suggester import FileSuggester


class FileTagInput(Static):
    """Input widget with @ file tagging support.
    
    When the user types @, a file suggester dropdown appears with matching
    files from the workspace. Selecting a file inserts the path into the input.
    """

    DEFAULT_CSS = """
    FileTagInput {
        height: auto;
        padding: 0 2;
    }
    
    FileTagInput > Vertical {
        height: auto;
    }
    
    FileTagInput Horizontal {
        height: 3;
        border: tall #333333;
        background: #151515;
        padding: 0 1;
    }
    
    FileTagInput .arrow {
        width: 3;
        color: #4a9eff;
    }
    
    FileTagInput Input {
        background: transparent;
        border: none;
        width: 1fr;
    }
    
    FileTagInput Input:focus {
        border: none;
    }
    
    FileTagInput FileSuggester {
        margin-bottom: 1;
    }
    """

    class FileSelected(Message):
        """Message sent when a file is selected from suggestions."""
        
        def __init__(self, file_path: str) -> None:
            self.file_path = file_path
            super().__init__()

    # Track if we're showing suggestions
    showing_suggestions = reactive(False)
    
    def __init__(
        self,
        input_id: str = "input",
        placeholder: str = "Type your message or @path/to/file",
        root_path: str = ".",
        id: Optional[str] = None,
        classes: Optional[str] = None,
    ):
        super().__init__(id=id, classes=classes)
        self.input_id = input_id
        self.placeholder = placeholder
        self.root_path = root_path
        self._mention_start: int = -1  # Position of @ in text

    def compose(self) -> ComposeResult:
        with Vertical():
            yield FileSuggester(root_path=self.root_path, id="file-suggester")
            with Horizontal():
                yield Static("> ", classes="arrow")
                yield Input(placeholder=self.placeholder, id=self.input_id)

    def on_input_changed(self, event: Input.Changed) -> None:
        """Monitor input for @ mentions."""
        text = event.value
        input_widget = event.input
        
        # Get cursor position (approximate - Input doesn't expose cursor_position directly)
        # We'll use the end of text as cursor position for simplicity
        cursor_pos = len(text)
        
        # Find if we're currently typing an @ mention
        at_pos = self._find_active_mention(text, cursor_pos)
        
        if at_pos >= 0:
            # Extract the query after @
            query = text[at_pos + 1:cursor_pos]
            self._mention_start = at_pos
            self._show_suggestions(query)
        else:
            self._hide_suggestions()

    def _find_active_mention(self, text: str, cursor_pos: int) -> int:
        """Find the @ position if cursor is currently within a mention.
        
        Returns:
            Position of @ if in a mention, -1 otherwise
        """
        if not text:
            return -1
        
        # Look backwards from cursor for @
        for i in range(cursor_pos - 1, -1, -1):
            char = text[i]
            if char == "@":
                return i
            if char == " ":
                # Space breaks the mention
                return -1
        
        return -1

    def _show_suggestions(self, query: str) -> None:
        """Show the suggestion popup with matching files."""
        suggester = self.query_one("#file-suggester", FileSuggester)
        suggester.show(query)
        self.showing_suggestions = True

    def _hide_suggestions(self) -> None:
        """Hide the suggestion popup."""
        suggester = self.query_one("#file-suggester", FileSuggester)
        suggester.hide()
        self.showing_suggestions = False
        self._mention_start = -1

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        """Handle when user selects a file from suggestions."""
        event.stop()  # Prevent bubbling
        
        selected_file = str(event.option.id)
        input_widget = self.query_one(f"#{self.input_id}", Input)
        text = input_widget.value
        
        if self._mention_start >= 0:
            # Replace @query with @selected_file
            # Find the end of the current mention (next space or end of text)
            mention_end = len(text)
            for i in range(self._mention_start + 1, len(text)):
                if text[i] == " ":
                    mention_end = i
                    break
            
            # Build new text
            before = text[:self._mention_start]
            after = text[mention_end:]
            new_text = f"{before}@{selected_file} {after}"
            
            input_widget.value = new_text
            
            # Post message about file selection
            self.post_message(self.FileSelected(selected_file))
        
        self._hide_suggestions()
        
        # Refocus the input
        input_widget.focus()

    def on_key(self, event) -> None:
        """Handle keyboard navigation in suggestions."""
        if not self.showing_suggestions:
            return
        
        suggester = self.query_one("#file-suggester", FileSuggester)
        option_list = suggester.query_one("#suggestions-list", OptionList)
        
        if event.key == "escape":
            self._hide_suggestions()
            event.stop()
        elif event.key == "down":
            option_list.action_cursor_down()
            event.stop()
        elif event.key == "up":
            option_list.action_cursor_up()
            event.stop()
        elif event.key == "enter" and self.showing_suggestions:
            # Select the highlighted option
            highlighted = option_list.highlighted
            if highlighted is not None:
                option_list.action_select()
                event.stop()

    def get_input(self) -> Input:
        """Get the underlying Input widget."""
        return self.query_one(f"#{self.input_id}", Input)

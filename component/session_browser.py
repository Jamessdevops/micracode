"""Session browser modal for viewing and selecting previous conversations."""

from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.containers import Container, Horizontal, Vertical
from textual.widgets import Static, Input, Button
from textual.binding import Binding

from .session_list import SessionList
from .session_item import SessionItem
from .theme import THEME


class SessionBrowser(ModalScreen):
    """Modal screen for browsing and selecting previous chat sessions.
    
    Shows a searchable list of sessions with options to open, delete, or
    start a new conversation.
    """
    
    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("n", "new_session", "New Chat"),
    ]
    
    DEFAULT_CSS = """
    SessionBrowser {
        align: center middle;
    }
    
    SessionBrowser > Container {
        width: 80%;
        max-width: 100;
        height: 80%;
        max-height: 40;
        background: #0d0d0d;
        border: tall #333333;
        padding: 1 2;
    }
    
    SessionBrowser .header {
        height: 3;
        margin-bottom: 1;
    }
    
    SessionBrowser .title {
        width: 1fr;
        text-style: bold;
        color: #ffffff;
    }
    
    SessionBrowser .close-btn {
        width: 3;
        min-width: 3;
        background: transparent;
        color: #666666;
        border: none;
    }
    
    SessionBrowser .close-btn:hover {
        color: #ffffff;
    }
    
    SessionBrowser .search-input {
        height: 3;
        margin-bottom: 1;
    }
    
    SessionBrowser .search-input Input {
        background: #151515;
        border: tall #333333;
    }
    
    SessionBrowser .search-input Input:focus {
        border: tall #4a9eff;
    }
    
    SessionBrowser .footer {
        height: 3;
        dock: bottom;
        margin-top: 1;
    }
    
    SessionBrowser .hint {
        width: 1fr;
        color: #555555;
    }
    
    SessionBrowser .new-btn {
        min-width: 12;
        background: #1e3a5f;
        color: #4a9eff;
        border: tall #4a9eff;
    }
    
    SessionBrowser .new-btn:hover {
        background: #2a4a6f;
    }
    """
    
    def __init__(self, sessions: list[dict] | None = None) -> None:
        """Initialize session browser.
        
        Args:
            sessions: List of session metadata dicts
        """
        super().__init__()
        self.sessions = sessions or []
        self._filtered_sessions = self.sessions.copy()
    
    def compose(self) -> ComposeResult:
        """Compose the session browser UI."""
        with Container():
            # Header
            with Horizontal(classes="header"):
                yield Static("📚 Conversation History", classes="title")
                yield Button("×", classes="close-btn", id="close-btn")
            
            # Search bar
            with Container(classes="search-input"):
                yield Input(
                    placeholder="Search conversations...",
                    id="search-input"
                )
            
            # Session list
            yield SessionList(self._filtered_sessions)
            
            # Footer
            with Horizontal(classes="footer"):
                yield Static("Enter to open • Del to delete • Esc to close", classes="hint")
                yield Button("+ New Chat", classes="new-btn", id="new-btn")
    
    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle button presses."""
        if event.button.id == "close-btn":
            self.dismiss(None)
        elif event.button.id == "new-btn":
            self.dismiss({"action": "new"})
    
    def on_input_changed(self, event: Input.Changed) -> None:
        """Handle search input changes."""
        if event.input.id == "search-input":
            query = event.value.lower().strip()
            if query:
                self._filtered_sessions = [
                    s for s in self.sessions
                    if query in s.get("title", "").lower()
                ]
            else:
                self._filtered_sessions = self.sessions.copy()
            
            # Refresh the session list
            session_list = self.query_one(SessionList)
            session_list.refresh_sessions(self._filtered_sessions)
    
    def on_session_item_selected(self, event: SessionItem.Selected) -> None:
        """Handle session selection."""
        self.dismiss({"action": "open", "session_id": event.session_id})
    
    def on_session_item_delete_requested(self, event: SessionItem.DeleteRequested) -> None:
        """Handle session deletion request."""
        self.dismiss({"action": "delete", "session_id": event.session_id})
    
    def action_new_session(self) -> None:
        """Action to start a new session."""
        self.dismiss({"action": "new"})

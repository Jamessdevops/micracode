"""Session item widget for browsing history."""

from datetime import datetime
from textual.widgets import Static
from textual.message import Message
from rich.text import Text

from .theme import THEME


class SessionItem(Static):
    """A single session item in the session list.
    
    Displays session title, timestamp, and message count.
    Emits SessionSelected message when clicked.
    """
    
    DEFAULT_CSS = """
    SessionItem {
        height: 4;
        padding: 0 2;
        background: #1a1a1a;
        border: solid #333333;
        margin: 0 0 1 0;
    }
    
    SessionItem:hover {
        background: #252525;
        border: solid #4a9eff;
    }
    
    SessionItem:focus {
        background: #252525;
        border: solid #4a9eff;
    }
    
    SessionItem.selected {
        background: #1e3a5f;
        border: solid #4a9eff;
    }
    """
    
    class Selected(Message):
        """Message emitted when session is selected."""
        
        def __init__(self, session_id: str) -> None:
            self.session_id = session_id
            super().__init__()
    
    class DeleteRequested(Message):
        """Message emitted when deletion is requested."""
        
        def __init__(self, session_id: str) -> None:
            self.session_id = session_id
            super().__init__()
    
    def __init__(
        self, 
        session_id: str,
        title: str,
        updated_at: str,
        message_count: int,
        model: str = "",
    ) -> None:
        super().__init__()
        self.session_id = session_id
        self.title = title
        self.updated_at = updated_at
        self.message_count = message_count
        self.model = model
        self.can_focus = True
    
    def _format_time(self, iso_time: str) -> str:
        """Format ISO timestamp to human-readable string."""
        try:
            dt = datetime.fromisoformat(iso_time.replace("Z", "+00:00"))
            now = datetime.now(dt.tzinfo)
            diff = now - dt
            
            if diff.days == 0:
                return dt.strftime("%H:%M")
            elif diff.days == 1:
                return "Yesterday"
            elif diff.days < 7:
                return dt.strftime("%A")  # Day name
            else:
                return dt.strftime("%b %d")  # e.g., "Jan 14"
        except (ValueError, TypeError):
            return ""
    
    def render(self) -> Text:
        """Render the session item."""
        t = Text()
        
        # Title line
        t.append(self.title[:60], style="bold")
        if len(self.title) > 60:
            t.append("...", style="bold")
        t.append("\n")
        
        # Metadata line
        time_str = self._format_time(self.updated_at)
        t.append(f"{time_str}", style=THEME.get("muted", "#666666"))
        t.append(" • ", style=THEME.get("muted", "#666666"))
        t.append(f"{self.message_count} messages", style=THEME.get("muted", "#666666"))
        
        if self.model:
            t.append(" • ", style=THEME.get("muted", "#666666"))
            t.append(self.model, style=THEME.get("accent", "#4a9eff"))
        
        return t
    
    def on_click(self) -> None:
        """Handle click to select session."""
        self.post_message(self.Selected(self.session_id))
    
    def on_key(self, event) -> None:
        """Handle keyboard input."""
        if event.key == "enter":
            self.post_message(self.Selected(self.session_id))
        elif event.key in ("delete", "backspace"):
            self.post_message(self.DeleteRequested(self.session_id))

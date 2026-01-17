"""Session list widget for browsing conversation history."""

from datetime import datetime
from textual.containers import VerticalScroll
from textual.widgets import Static
from textual.app import ComposeResult

from .session_item import SessionItem
from .theme import THEME


class SessionList(VerticalScroll):
    """Scrollable list of previous chat sessions.
    
    Groups sessions by time period (Today, Yesterday, Last 7 Days, Older).
    """
    
    DEFAULT_CSS = """
    SessionList {
        height: 1fr;
        background: #0d0d0d;
        padding: 1 2;
    }
    
    SessionList .group-header {
        height: 2;
        color: #666666;
        text-style: bold;
        margin-top: 1;
    }
    
    SessionList .empty-message {
        height: auto;
        color: #555555;
        text-align: center;
        margin-top: 3;
    }
    """
    
    def __init__(self, sessions: list[dict] | None = None) -> None:
        """Initialize session list.
        
        Args:
            sessions: List of session metadata dicts
        """
        super().__init__()
        self.sessions = sessions or []
    
    def _group_sessions(self) -> dict[str, list[dict]]:
        """Group sessions by time period."""
        groups = {
            "Today": [],
            "Yesterday": [],
            "Last 7 Days": [],
            "Older": [],
        }
        
        now = datetime.utcnow()
        
        for session in self.sessions:
            try:
                updated = session.get("updated_at", "")
                dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                dt = dt.replace(tzinfo=None)  # Remove timezone for comparison
                diff = now - dt
                
                if diff.days == 0:
                    groups["Today"].append(session)
                elif diff.days == 1:
                    groups["Yesterday"].append(session)
                elif diff.days < 7:
                    groups["Last 7 Days"].append(session)
                else:
                    groups["Older"].append(session)
            except (ValueError, TypeError):
                groups["Older"].append(session)
        
        return groups
    
    def compose(self) -> ComposeResult:
        """Compose the session list with grouped items."""
        if not self.sessions:
            yield Static(
                "No conversations yet.\nStart chatting to create your first session!",
                classes="empty-message"
            )
            return
        
        groups = self._group_sessions()
        
        for group_name, group_sessions in groups.items():
            if group_sessions:
                yield Static(group_name, classes="group-header")
                for session in group_sessions:
                    yield SessionItem(
                        session_id=session.get("id", ""),
                        title=session.get("title", "Untitled"),
                        updated_at=session.get("updated_at", ""),
                        message_count=session.get("message_count", 0),
                        model=session.get("model", ""),
                    )
    
    def refresh_sessions(self, sessions: list[dict]) -> None:
        """Refresh the session list with new data.
        
        Args:
            sessions: New list of session metadata dicts
        """
        self.sessions = sessions
        self.remove_children()
        for widget in self.compose():
            self.mount(widget)

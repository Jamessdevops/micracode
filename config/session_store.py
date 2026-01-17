"""Session storage for conversation history."""

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from langchain_core.messages import (
    BaseMessage,
    HumanMessage,
    AIMessage,
    ToolMessage,
    SystemMessage,
    messages_to_dict,
    messages_from_dict,
)


class SessionStore:
    """Store and retrieve chat sessions.
    
    Sessions are persisted as JSON files in ~/.config/Micracode/sessions/
    Each session contains metadata and the full message history.
    """
    
    SESSIONS_DIR = Path.home() / ".config" / "Micracode" / "sessions"
    CURRENT_SESSION_FILE = Path.home() / ".config" / "Micracode" / "current_session.txt"
    
    def __init__(self):
        self._ensure_dirs()
    
    def _ensure_dirs(self) -> None:
        """Ensure sessions directory exists."""
        self.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    
    def _get_session_path(self, session_id: str) -> Path:
        """Get the file path for a session."""
        return self.SESSIONS_DIR / f"{session_id}.json"
    
    def create_session(self, model: str = "", provider: str = "") -> str:
        """Create a new session and return its ID.
        
        Args:
            model: The model name being used
            provider: The provider name (gemini, openai, anthropic)
            
        Returns:
            The new session ID
        """
        session_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat() + "Z"
        
        session_data = {
            "id": session_id,
            "title": "New Chat",
            "created_at": now,
            "updated_at": now,
            "model": model,
            "provider": provider,
            "message_count": 0,
            "messages": [],
        }
        
        self._save_session_data(session_id, session_data)
        return session_id
    
    def save_session(
        self, 
        session_id: str, 
        messages: list[BaseMessage],
        title: Optional[str] = None,
        model: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> None:
        """Save messages to an existing session.
        
        Args:
            session_id: The session ID to save to
            messages: List of LangChain messages
            title: Optional title override
            model: Optional model name
            provider: Optional provider name
        """
        # Load existing session or create new structure
        session_data = self.load_session(session_id)
        if session_data is None:
            session_data = {
                "id": session_id,
                "title": "New Chat",
                "created_at": datetime.utcnow().isoformat() + "Z",
                "model": model or "",
                "provider": provider or "",
            }
        
        # Update session data
        session_data["updated_at"] = datetime.utcnow().isoformat() + "Z"
        session_data["message_count"] = len(messages)
        session_data["messages"] = messages_to_dict(messages)
        
        # Auto-generate title from first human message if not set
        if (title is None and session_data.get("title") == "New Chat" 
            and messages):
            for msg in messages:
                if isinstance(msg, HumanMessage):
                    # Use first 50 chars of first human message as title
                    content = msg.content if isinstance(msg.content, str) else str(msg.content)
                    session_data["title"] = content[:50] + ("..." if len(content) > 50 else "")
                    break
        elif title is not None:
            session_data["title"] = title
        
        if model:
            session_data["model"] = model
        if provider:
            session_data["provider"] = provider
        
        self._save_session_data(session_id, session_data)
    
    def _save_session_data(self, session_id: str, data: dict) -> None:
        """Write session data to disk."""
        path = self._get_session_path(session_id)
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
    
    def load_session(self, session_id: str) -> Optional[dict]:
        """Load a session by ID.
        
        Args:
            session_id: The session ID to load
            
        Returns:
            Session data dict with 'messages' as LangChain message objects,
            or None if not found
        """
        path = self._get_session_path(session_id)
        if not path.exists():
            return None
        
        try:
            with open(path, "r") as f:
                data = json.load(f)
            
            # Convert message dicts back to LangChain messages
            if "messages" in data and data["messages"]:
                data["messages"] = messages_from_dict(data["messages"])
            else:
                data["messages"] = []
            
            return data
        except (json.JSONDecodeError, IOError):
            return None
    
    def load_session_metadata(self, session_id: str) -> Optional[dict]:
        """Load only session metadata (without messages).
        
        Args:
            session_id: The session ID to load
            
        Returns:
            Session metadata dict without messages, or None if not found
        """
        path = self._get_session_path(session_id)
        if not path.exists():
            return None
        
        try:
            with open(path, "r") as f:
                data = json.load(f)
            
            # Return metadata only, exclude full messages
            return {
                "id": data.get("id"),
                "title": data.get("title", "Untitled"),
                "created_at": data.get("created_at"),
                "updated_at": data.get("updated_at"),
                "model": data.get("model", ""),
                "provider": data.get("provider", ""),
                "message_count": data.get("message_count", 0),
            }
        except (json.JSONDecodeError, IOError):
            return None
    
    def list_sessions(self) -> list[dict]:
        """List all sessions, sorted by updated_at descending.
        
        Returns:
            List of session metadata dicts (without messages)
        """
        sessions = []
        
        for path in self.SESSIONS_DIR.glob("*.json"):
            session_id = path.stem
            metadata = self.load_session_metadata(session_id)
            if metadata:
                sessions.append(metadata)
        
        # Sort by updated_at, most recent first
        sessions.sort(
            key=lambda s: s.get("updated_at", ""),
            reverse=True
        )
        
        return sessions
    
    def delete_session(self, session_id: str) -> bool:
        """Delete a session.
        
        Args:
            session_id: The session ID to delete
            
        Returns:
            True if deleted, False if not found
        """
        path = self._get_session_path(session_id)
        if path.exists():
            path.unlink()
            # Clear current session if it was deleted
            if self.get_current_session() == session_id:
                self.clear_current_session()
            return True
        return False
    
    def get_current_session(self) -> Optional[str]:
        """Get the current session ID if set.
        
        Returns:
            Current session ID or None
        """
        if self.CURRENT_SESSION_FILE.exists():
            try:
                return self.CURRENT_SESSION_FILE.read_text().strip() or None
            except IOError:
                return None
        return None
    
    def set_current_session(self, session_id: str) -> None:
        """Set the current session ID.
        
        Args:
            session_id: The session ID to set as current
        """
        self.CURRENT_SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        self.CURRENT_SESSION_FILE.write_text(session_id)
    
    def clear_current_session(self) -> None:
        """Clear the current session marker."""
        if self.CURRENT_SESSION_FILE.exists():
            self.CURRENT_SESSION_FILE.unlink()


# Global instance
session_store = SessionStore()

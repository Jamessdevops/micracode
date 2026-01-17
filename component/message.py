"""Message component for Micracode TUI."""

from textual.widgets import Static
from rich.text import Text

from .theme import THEME


class Message(Static):
    """A chat message with optional model info."""

    DEFAULT_CSS = """
    Message {
        height: auto;
        margin: 1 0;
        padding: 1 2;
        background: #1a1a1a;
        border: solid #333333;
    }

    Message.ai {
        border-left: tall #4a9eff;
    }

    Message.user {
        border-left: tall #888888;
    }
    """

    def __init__(self, text: str, model: str = "", time: str = "", role: str = "ai"):
        super().__init__()
        self.msg_text = text
        self.model = model
        self.time = time
        self.add_class(role)

    def render(self) -> Text:
        t = Text()
        t.append(self.msg_text + "\n", style=THEME["text2"])
        if self.model:
            t.append(self.model, style=THEME["accent"])
            if self.time:
                t.append(f" ({self.time})", style=THEME["muted"])
        return t

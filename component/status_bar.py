"""Status bar components for Micracode TUI."""

from textual.widgets import Static
from rich.text import Text

from .theme import THEME


class ModelBar(Static):
    """Model indicator showing current provider and model."""

    DEFAULT_CSS = """
    ModelBar {
        height: 1;
        text-align: right;
        padding: 0 2;
        color: #888888;
    }
    """

    def __init__(self, provider: str = "Anthropic", model: str = "Claude Sonnet 4"):
        super().__init__()
        self.provider = provider
        self.model = model

    def render(self) -> Text:
        t = Text()
        t.append("enter send", style=THEME["muted"])
        t.append("                              ", style=THEME["bg"])
        t.append(f"{self.provider} ", style=THEME["text2"])
        t.append(self.model, style=THEME["accent"])
        return t


class StatusBar(Static):
    """Bottom status bar with app info, path, and mode."""

    DEFAULT_CSS = """
    StatusBar {
        height: 1;
        background: #151515;
        padding: 0 1;
    }
    """

    def __init__(self, version: str, path: str, mode: str = "BUILD MODE"):
        super().__init__()
        self.version = version
        self.path = path
        self.mode = mode

    def render(self) -> Text:
        t = Text()
        t.append(f"Micracode {self.version}", style=THEME["accent"])
        t.append(f"  {self.path}", style=THEME["text2"])
        t.append("                    ", style=THEME["surface2"])
        t.append("tab  ", style=THEME["muted"])
        t.append(self.mode, style=THEME["accent"])
        return t

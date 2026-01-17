"""Header component for Micracode TUI."""

from textual.widgets import Static
from rich.text import Text

from .theme import THEME


class Header(Static):
    """Top header with prompt and stats."""

    DEFAULT_CSS = """
    Header {
        height: 4;
        padding: 1 2;
        background: #0d0d0d;
        border-bottom: solid #333333;
    }
    """

    def __init__(self, prompt: str, url: str = "", stats: str = ""):
        super().__init__()
        self.prompt = prompt
        self.url = url
        self.stats = stats

    def render(self) -> Text:
        t = Text()
        t.append("# ", style=THEME["muted"])
        t.append(self.prompt, style=THEME["text"])
        if self.stats:
            t.append(f"  {self.stats}", style=THEME["muted"])
        t.append("\n")
        if self.url:
            t.append(self.url, style=THEME["accent"])
            t.append("  /unshare", style=THEME["muted"])
        return t

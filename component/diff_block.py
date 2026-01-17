"""DiffBlock component for Micracode TUI."""

from textual.widgets import Static
from rich.text import Text

from .theme import THEME


class DiffBlock(Static):
    """Code diff display with line numbers."""

    DEFAULT_CSS = """
    DiffBlock {
        height: auto;
        margin: 1 0;
        background: #151515;
        border: solid #333333;
    }
    """

    def __init__(self, filename: str, lines: list):
        """
        Initialize a diff block.

        Args:
            filename: Path of the file being edited
            lines: List of dicts with keys:
                - old: old line number or ""
                - new: new line number or ""
                - content: line content
                - type: "ctx" (context), "add", or "del"
        """
        super().__init__()
        self.filename = filename
        self.lines = lines

    def render(self) -> Text:
        t = Text()
        # Header
        t.append(f"Edit {self.filename}\n\n", style=THEME["text2"])

        for line in self.lines:
            old = line.get("old", "")
            new = line.get("new", "")
            content = line.get("content", "")
            ltype = line.get("type", "ctx")

            # Line numbers
            old_s = f"{old:>3}" if old else "   "
            new_s = f"{new:>3}" if new else "   "

            if ltype == "add":
                num_color = THEME["green"]
                line_color = THEME["green"]
                prefix = "+ "
            elif ltype == "del":
                num_color = THEME["red"]
                line_color = THEME["red"]
                prefix = "- "
            else:
                num_color = THEME["muted"]
                line_color = THEME["text2"]
                prefix = "  "

            t.append(old_s, style=num_color)
            t.append("  ", style=THEME["muted"])
            t.append(new_s, style=num_color)
            t.append("   ", style=THEME["muted"])
            t.append(prefix, style=line_color)
            t.append(content + "\n", style=line_color)

        return t

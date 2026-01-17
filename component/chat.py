"""Chat area and input components for Micracode TUI."""

from textual.app import ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Static, Input

from .theme import THEME


class ChatScroll(VerticalScroll):
    """Scrollable chat area."""

    DEFAULT_CSS = """
    ChatScroll {
        height: 1fr;
        background: #0d0d0d;
        padding: 0 2;
    }
    """


class PromptInput(Static):
    """Input prompt at bottom."""

    DEFAULT_CSS = """
    PromptInput {
        height: 4;
        padding: 0 2;
    }

    PromptInput Horizontal {
        height: 3;
        border: tall #333333;
        background: #151515;
        padding: 0 1;
    }

    PromptInput .arrow {
        width: 3;
        color: #4a9eff;
    }

    PromptInput Input {
        background: transparent;
        border: none;
        width: 1fr;
    }

    PromptInput Input:focus {
        border: none;
    }
    """

    def __init__(self, input_id: str = "input", placeholder: str = ""):
        super().__init__()
        self.input_id = input_id
        self.placeholder = placeholder

    def compose(self) -> ComposeResult:
        with Horizontal():
            yield Static("> ", classes="arrow")
            yield Input(placeholder=self.placeholder, id=self.input_id)

"""Tool message components for Micracode TUI."""

from textual.widgets import Static
from rich.text import Text
from rich.panel import Panel

from .theme import THEME


class ToolCallMessage(Static):
    """Display a tool invocation in the chat."""

    DEFAULT_CSS = """
    ToolCallMessage {
        height: auto;
        margin: 0 0 0 2;
        padding: 0 1;
    }
    """

    def __init__(self, name: str, args: dict):
        super().__init__()
        self.tool_name = name
        self.tool_args = args

    def render(self) -> Text:
        t = Text()
        t.append("🔧 ", style="bold")
        t.append(self.tool_name, style=THEME["accent"] + " bold")
        
        # Format args concisely
        if self.tool_args:
            args_str = ", ".join(
                f"{k}={repr(v)[:50]}" 
                for k, v in self.tool_args.items()
            )
            if len(args_str) > 80:
                args_str = args_str[:77] + "..."
            t.append(f"({args_str})", style=THEME["muted"])
        else:
            t.append("()", style=THEME["muted"])
        
        return t


class ToolResultMessage(Static):
    """Display a tool result in the chat."""

    DEFAULT_CSS = """
    ToolResultMessage {
        height: auto;
        margin: 0 0 1 2;
        padding: 0 1;
        max-height: 10;
    }
    """

    def __init__(self, name: str, result: str, success: bool = True):
        super().__init__()
        self.tool_name = name
        self.result = result
        self.success = success

    def render(self) -> Text:
        t = Text()
        
        # Status indicator
        if self.success and not self.result.startswith("Error"):
            t.append("  ✓ ", style="green")
        else:
            t.append("  ✗ ", style="red")
        
        # Truncate long results
        result_str = self.result
        lines = result_str.split("\n")
        if len(lines) > 5:
            result_str = "\n".join(lines[:5]) + f"\n... ({len(lines) - 5} more lines)"
        elif len(result_str) > 300:
            result_str = result_str[:297] + "..."
        
        t.append(result_str, style=THEME["text2"])
        
        return t


class StreamingMessage(Static):
    """A message that can be updated progressively as content streams in."""

    DEFAULT_CSS = """
    StreamingMessage {
        height: auto;
        margin: 1 0;
        padding: 1 2;
        background: #1a1a1a;
        border: solid #333333;
        border-left: tall #4a9eff;
    }
    
    StreamingMessage.complete {
        border-left: tall #4a9eff;
    }
    """

    def __init__(self, model: str = "", time: str = ""):
        super().__init__()
        self.content = ""
        self.model = model
        self.time = time
        self.is_complete = False

    def append_text(self, chunk: str) -> None:
        """Append a text chunk to the message."""
        self.content += chunk
        self.refresh()

    def complete(self) -> None:
        """Mark the message as complete."""
        self.is_complete = True
        self.add_class("complete")
        self.refresh()

    def render(self) -> Text:
        t = Text()
        
        # Content with optional typing indicator
        if self.content:
            t.append(self.content, style=THEME["text2"])
        
        if not self.is_complete:
            t.append("▌", style=THEME["accent"] + " blink")
        
        # Model info
        if self.is_complete and self.model:
            t.append("\n")
            t.append(self.model, style=THEME["accent"])
            if self.time:
                t.append(f" ({self.time})", style=THEME["muted"])
        
        return t

"""
Interactive diff block component with Accept/Reject buttons.
"""

from textual.widgets import Static, Button
from textual.containers import Horizontal, Vertical
from textual.message import Message as TextualMessage
from rich.text import Text

from .theme import THEME
from tools.diff_utils import generate_diff_lines, apply_edit


class DiffAccepted(TextualMessage):
    """Posted when user accepts a diff."""
    
    def __init__(self, file_path: str, result: str):
        super().__init__()
        self.file_path = file_path
        self.result = result


class DiffRejected(TextualMessage):
    """Posted when user rejects a diff."""
    
    def __init__(self, file_path: str):
        super().__init__()
        self.file_path = file_path


class InteractiveDiffBlock(Vertical):
    """Interactive code diff with Accept/Reject buttons."""

    DEFAULT_CSS = """
    InteractiveDiffBlock {
        height: auto;
        margin: 1 0;
        background: #151515;
        border: solid #333333;
    }
    
    InteractiveDiffBlock .diff-content {
        height: auto;
        padding: 1 1;
    }
    
    InteractiveDiffBlock .diff-actions {
        height: auto;
        padding: 0 1 1 1;
        align: right middle;
    }
    
    InteractiveDiffBlock .diff-actions Button {
        margin-left: 1;
        min-width: 10;
    }
    
    InteractiveDiffBlock #accept-btn {
        background: #22c55e;
        color: #000000;
    }
    
    InteractiveDiffBlock #accept-btn:hover {
        background: #16a34a;
    }
    
    InteractiveDiffBlock #reject-btn {
        background: #dc2626;
        color: #ffffff;
    }
    
    InteractiveDiffBlock #reject-btn:hover {
        background: #b91c1c;
    }
    
    InteractiveDiffBlock.accepted {
        border: solid #22c55e;
    }
    
    InteractiveDiffBlock.rejected {
        border: solid #dc2626;
        opacity: 0.6;
    }
    
    InteractiveDiffBlock.resolved .diff-actions {
        display: none;
    }
    """

    def __init__(
        self,
        file_path: str,
        original_content: str,
        proposed_content: str,
        description: str = ""
    ):
        """Initialize an interactive diff block.
        
        Args:
            file_path: Path to the file being edited
            original_content: The original file content
            proposed_content: The proposed new content
            description: Optional description of the change
        """
        super().__init__()
        self.file_path = file_path
        self.original_content = original_content
        self.proposed_content = proposed_content
        self.description = description
        self.diff_lines = generate_diff_lines(original_content, proposed_content)
        self.is_resolved = False

    def compose(self):
        """Compose the diff block with content and action buttons."""
        yield Static(self._render_diff(), classes="diff-content")
        with Horizontal(classes="diff-actions"):
            yield Button("✓ Accept", id="accept-btn", variant="success")
            yield Button("✗ Reject", id="reject-btn", variant="error")

    def _render_diff(self) -> Text:
        """Render the diff content as Rich Text."""
        t = Text()
        
        # Header with file path
        t.append("📄 ", style="bold")
        t.append(self.file_path, style=THEME["accent"] + " bold")
        
        if self.description:
            t.append(f"\n   {self.description}", style=THEME["muted"])
        
        t.append("\n\n")
        
        # Check if this is a new file
        if not self.original_content:
            t.append("  (new file)\n", style=THEME["green"])
        
        # Render diff lines
        for line in self.diff_lines:
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

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle accept/reject button clicks."""
        if self.is_resolved:
            return
        
        self.is_resolved = True
        self.add_class("resolved")
        
        if event.button.id == "accept-btn":
            # Apply the changes
            result = apply_edit(self.file_path, self.proposed_content)
            self.add_class("accepted")
            self.post_message(DiffAccepted(self.file_path, result))
        
        elif event.button.id == "reject-btn":
            self.add_class("rejected")
            self.post_message(DiffRejected(self.file_path))

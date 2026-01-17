"""Connect modal for provider selection and API key input."""

from textual.app import ComposeResult
from textual.containers import Container, Vertical, Horizontal
from textual.screen import ModalScreen
from textual.widgets import Static, Input, OptionList, Button
from textual.widgets.option_list import Option
from textual.binding import Binding
from rich.text import Text

from .theme import THEME


PROVIDERS = [
    {"id": "gemini", "name": "Gemini (Google AI)", "placeholder": "Enter your Gemini API key..."},
    {"id": "openai", "name": "OpenAI", "placeholder": "Enter your OpenAI API key (sk-...)"},
    {"id": "anthropic", "name": "Anthropic", "placeholder": "Enter your Anthropic API key..."},
]


class ConnectModal(ModalScreen):
    """Two-step modal: 1) Select provider, 2) Enter API key."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    DEFAULT_CSS = """
    ConnectModal {
        align: center middle;
    }

    ConnectModal > Container {
        width: 60;
        height: auto;
        max-height: 20;
        background: #151515;
        border: solid #333333;
        padding: 1 2;
    }

    ConnectModal .title {
        text-style: bold;
        color: #ffffff;
        text-align: center;
        margin-bottom: 1;
    }

    ConnectModal .subtitle {
        color: #888888;
        margin-bottom: 1;
    }

    ConnectModal OptionList {
        height: auto;
        max-height: 8;
        background: transparent;
        border: none;
        padding: 0;
        margin-bottom: 1;
    }

    ConnectModal OptionList > .option-list--option-highlighted {
        background: #252525;
    }

    ConnectModal .hint {
        color: #555555;
        text-align: center;
        margin-top: 1;
    }

    ConnectModal .key-input-container {
        height: auto;
    }

    ConnectModal .key-input-container Input {
        margin: 1 0;
    }

    ConnectModal .key-input-container Input:focus {
        border: tall #4a9eff;
    }

    ConnectModal .hidden {
        display: none;
    }

    ConnectModal .button-row {
        height: 3;
        margin-top: 1;
        align: center middle;
    }

    ConnectModal Button {
        margin: 0 1;
    }

    ConnectModal Button.primary {
        background: #4a9eff;
        color: #ffffff;
    }

    ConnectModal Button.secondary {
        background: #333333;
        color: #888888;
    }
    """

    def __init__(self):
        super().__init__()
        self.selected_provider = None
        self.step = 1  # 1 = provider selection, 2 = key input

    def compose(self) -> ComposeResult:
        with Container():
            yield Static("Connect to Provider", classes="title")
            
            # Step 1: Provider selection
            with Vertical(id="step-1"):
                yield Static("Select a provider:", classes="subtitle")
                
                options = []
                for provider in PROVIDERS:
                    label = Text()
                    label.append(provider["name"], style=THEME["text2"])
                    options.append(Option(label, id=provider["id"]))
                
                yield OptionList(*options, id="provider-list")
                yield Static("(Press Enter to confirm, Esc to cancel)", classes="hint")
            
            # Step 2: API key input (hidden initially)
            with Vertical(id="step-2", classes="hidden"):
                yield Static("Enter your API key:", classes="subtitle", id="key-label")
                yield Input(placeholder="", password=True, id="api-key-input")
                
                with Horizontal(classes="button-row"):
                    yield Button("◀ Back", id="back-btn", classes="secondary")
                    yield Button("Connect", id="connect-btn", classes="primary")

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        """Handle provider selection - move to step 2."""
        self.selected_provider = event.option_id
        self._show_step_2()

    def _show_step_2(self) -> None:
        """Switch to API key input step."""
        self.step = 2
        
        # Hide step 1, show step 2
        self.query_one("#step-1").add_class("hidden")
        self.query_one("#step-2").remove_class("hidden")
        
        # Update label and placeholder based on provider
        provider = next(p for p in PROVIDERS if p["id"] == self.selected_provider)
        self.query_one("#key-label", Static).update(f"Enter your {provider['name']} API key:")
        self.query_one("#api-key-input", Input).placeholder = provider["placeholder"]
        
        # Update title
        self.query_one(".title", Static).update(f"Connect to {provider['name']}")
        
        # Focus the input
        self.query_one("#api-key-input", Input).focus()

    def _show_step_1(self) -> None:
        """Go back to provider selection."""
        self.step = 1
        self.selected_provider = None
        
        # Show step 1, hide step 2
        self.query_one("#step-1").remove_class("hidden")
        self.query_one("#step-2").add_class("hidden")
        
        # Reset title
        self.query_one(".title", Static).update("Connect to Provider")
        
        # Clear input
        self.query_one("#api-key-input", Input).value = ""

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle button presses."""
        if event.button.id == "back-btn":
            self._show_step_1()
        elif event.button.id == "connect-btn":
            self._submit_key()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle Enter key in the API key input."""
        if event.input.id == "api-key-input":
            self._submit_key()

    def _submit_key(self) -> None:
        """Submit the API key and dismiss modal."""
        api_key = self.query_one("#api-key-input", Input).value.strip()
        
        if not api_key:
            # TODO: Show error
            return
        
        # Return the result to the parent
        self.dismiss({
            "provider": self.selected_provider,
            "api_key": api_key,
        })

    def action_cancel(self) -> None:
        """Handle Escape key."""
        if self.step == 2:
            self._show_step_1()
        else:
            self.dismiss(None)

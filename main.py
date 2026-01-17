"""
Micracode-style Chat Interface for Micracode - Built with Textual.
Uses reusable components from the component package.
"""

import json
from datetime import datetime
from textual.app import App, ComposeResult
from textual.widgets import Input
from textual.binding import Binding
from langchain_core.messages import HumanMessage, AIMessage

from component import (
    Header,
    Message,
    ChatScroll,
    PromptInput,
    FileTagInput,
    ModelBar,
    StatusBar,
    ConnectModal,
    ToolCallMessage,
    ToolResultMessage,
    StreamingMessage,
    SessionBrowser,
    InteractiveDiffBlock,
    DiffAccepted,
    DiffRejected,
)
from tools import PROPOSE_EDIT_MARKER
from tools.mention_utils import prepare_message_with_context
from tools.init_command import run_init_command
from tools.git_utils import (
    is_git_repo,
    is_working_dir_dirty,
    create_checkpoint,
    revert_to_checkpoint,
    get_last_checkpoint_sha,
)
from config import ConfigStore, session_store
from llm import get_model
from llm.models import get_provider_display_name, get_default_model, get_available_models
from agent import build_agent
from agent.graph import stream_agent


class MicracodeApp(App):
    """Micracode-style Chat App with LangGraph agent."""

    CSS = """
    Screen {
        background: #0d0d0d;
        layout: vertical;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit"),
        Binding("escape", "quit", "Quit"),
        Binding("ctrl+h", "show_history", "History"),
        Binding("ctrl+n", "new_session", "New Chat"),
    ]

    def __init__(self):
        super().__init__()
        self.config = ConfigStore()
        self.session_store = session_store
        self.agent = None
        self.current_provider = None
        self.current_model = None
        self.current_session_id = None
        self.messages = []  # LangChain message history
        self.last_checkpoint_sha = None  # SHA of most recent checkpoint
        
        # Try to load saved configuration
        self._load_saved_config()
        
        # Check for existing session to resume
        self._check_resume_session()
        
        # Create initial checkpoint if working directory is dirty
        self._create_startup_checkpoint()

    def _check_resume_session(self) -> None:
        """Check if there's a session to resume from last time."""
        current_session = self.session_store.get_current_session()
        if current_session:
            session_data = self.session_store.load_session(current_session)
            if session_data:
                self.current_session_id = current_session
                self.messages = session_data.get("messages", [])

    def _load_saved_config(self) -> None:
        """Load saved provider configuration if available."""
        config = self.config.get_provider()
        if config:
            provider, api_key, model = config
            try:
                llm = get_model(provider, api_key, model)
                self.agent = build_agent(llm)
                self.current_provider = provider
                self.current_model = model or get_default_model(provider)
            except Exception:
                # If loading fails, user will need to /connect again
                pass

    def compose(self) -> ComposeResult:
        # Dynamic header based on connection status
        if self.current_provider:
            status = f"Connected to {get_provider_display_name(self.current_provider)}"
        else:
            status = "Not connected - type /connect to start"
        
        yield Header(
            prompt=status,
            url="",
            stats=""
        )

        with ChatScroll(id="chat-scroll"):
            # Check if we have a session to restore
            if self.messages:
                # Restore messages from session
                for msg in self.messages:
                    if isinstance(msg, HumanMessage):
                        content = msg.content if isinstance(msg.content, str) else str(msg.content)
                        yield Message(content, model="", time="", role="user")
                    elif isinstance(msg, AIMessage) and msg.content:
                        content = msg.content if isinstance(msg.content, str) else str(msg.content)
                        yield Message(
                            content,
                            model=self.current_model or "",
                            time="",
                            role="ai"
                        )
            else:
                # Welcome message for new sessions
                yield Message(
                    "Welcome to Micracode! I'm your AI coding assistant.\n\n"
                    "Commands:\n"
                    "  /connect - Connect to an AI provider\n"
                    "  /model   - Switch models (e.g., /model gpt-4o)\n"
                    "  /init    - Generate project handbook (Micracode.md)\n"
                    "  /undo    - Undo last interaction (requires Git)\n"
                    "  /clear   - Clear chat display (keeps session)\n"
                    "  /quit    - Exit the application\n\n"
                    "Shortcuts:\n"
                    "  Ctrl+H   - Browse conversation history\n"
                    "  Ctrl+N   - Start a new chat\n\n"
                    "Type a message to chat with me!",
                    model="Micracode",
                    time=datetime.now().strftime("%I:%M %p")
                )

        # Model bar shows current provider
        yield ModelBar(
            provider=get_provider_display_name(self.current_provider) if self.current_provider else "Not connected",
            model=self.current_model or "Use /connect"
        )
        yield FileTagInput(id="prompt-input")
        yield StatusBar("v0.1.0", "~/projects", "CHAT MODE")

    def on_mount(self) -> None:
        self.query_one("#prompt-input #input", Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        cmd = event.value.strip()
        if not cmd:
            return
        
        cmd_lower = cmd.lower()
        
        if cmd_lower in ["/quit", "exit", "quit"]:
            self.exit()
            event.input.value = ""
            return
        
        if cmd_lower == "/connect":
            event.input.value = ""
            self.push_screen(ConnectModal(), self._on_connect_complete)
            return
        
        if cmd_lower == "/init":
            event.input.value = ""
            self._run_init_command()
            return
        
        if cmd_lower == "/undo":
            event.input.value = ""
            self._run_undo_command()
            return
        
        if cmd_lower == "/clear":
            event.input.value = ""
            self._run_clear_command()
            return
        
        if cmd_lower.startswith("/model"):
            event.input.value = ""
            # Extract model name if provided
            parts = cmd.split(maxsplit=1)
            model_name = parts[1].strip() if len(parts) > 1 else None
            self._run_model_command(model_name)
            return
        
        # Regular chat message
        event.input.value = ""
        self._send_message_async(cmd)
    
    def _send_message_async(self, message: str) -> None:
        """Initiate async message sending using a worker."""
        chat_scroll = self.query_one("#chat-scroll", ChatScroll)
        current_time = datetime.now().strftime("%I:%M %p")
        
        # Create checkpoint before processing (for undo support)
        self._create_checkpoint()
        
        # Add user message to chat
        user_msg = Message(message, model="", time=current_time, role="user")
        chat_scroll.mount(user_msg)
        
        # Track the message in history
        self.messages.append(HumanMessage(content=message))
        
        # Create session if this is the first message
        if not self.current_session_id:
            self.current_session_id = self.session_store.create_session(
                model=self.current_model or "",
                provider=self.current_provider or ""
            )
            self.session_store.set_current_session(self.current_session_id)
        
        # Check if we're connected
        if not self.agent:
            error_msg = Message(
                "Not connected to any AI provider. Use /connect to set up your API key.",
                model="Micracode",
                time=current_time
            )
            chat_scroll.mount(error_msg)
            chat_scroll.scroll_end()
            return
        
        # Create streaming message placeholder
        streaming_msg = StreamingMessage(
            model=self.current_model or "",
            time=datetime.now().strftime("%I:%M %p")
        )
        chat_scroll.mount(streaming_msg)
        chat_scroll.scroll_end()
        
        # Prepare message with file context from @mentions
        augmented_message = prepare_message_with_context(message)
        
        # Run the async streaming in a worker
        self.run_worker(
            self._stream_response(augmented_message, streaming_msg, chat_scroll),
            name="stream_response",
            exclusive=True,
        )
    
    async def _stream_response(
        self, 
        message: str, 
        streaming_msg: StreamingMessage,
        chat_scroll: ChatScroll
    ) -> None:
        """Stream the agent response asynchronously."""
        full_response = ""  # Accumulate full response for saving
        
        try:
            async for event_type, data in stream_agent(self.agent, message):
                if event_type == "text":
                    # Append text chunk to streaming message
                    streaming_msg.append_text(data)
                    full_response += data
                    chat_scroll.scroll_end()
                
                elif event_type == "tool_call":
                    # Display tool invocation
                    tool_msg = ToolCallMessage(
                        name=data["name"],
                        args=data["args"]
                    )
                    chat_scroll.mount(tool_msg, before=streaming_msg)
                    chat_scroll.scroll_end()
                
                elif event_type == "tool_result":
                    result = data["result"]
                    
                    # Check if this is a propose_edit result
                    if result.startswith(PROPOSE_EDIT_MARKER):
                        try:
                            proposal_json = result[len(PROPOSE_EDIT_MARKER):]
                            proposal = json.loads(proposal_json)
                            diff_block = InteractiveDiffBlock(
                                file_path=proposal["file_path"],
                                original_content=proposal["original_content"],
                                proposed_content=proposal["proposed_content"],
                                description=proposal.get("description", "")
                            )
                            chat_scroll.mount(diff_block, before=streaming_msg)
                        except (json.JSONDecodeError, KeyError):
                            # Fall back to regular result display
                            result_msg = ToolResultMessage(
                                name=data["name"],
                                result=result
                            )
                            chat_scroll.mount(result_msg, before=streaming_msg)
                    else:
                        # Regular tool result
                        result_msg = ToolResultMessage(
                            name=data["name"],
                            result=result
                        )
                        chat_scroll.mount(result_msg, before=streaming_msg)
                    chat_scroll.scroll_end()
            
            # Mark streaming complete
            streaming_msg.complete()
            chat_scroll.scroll_end()
            
            # Save AI response to message history
            if full_response:
                self.messages.append(AIMessage(content=full_response))
                
                # Auto-save session
                if self.current_session_id:
                    self.session_store.save_session(
                        self.current_session_id,
                        self.messages,
                        model=self.current_model,
                        provider=self.current_provider
                    )
            
        except Exception as e:
            # Handle errors
            streaming_msg.append_text(f"\n\nError: {str(e)}")
            streaming_msg.complete()
            chat_scroll.scroll_end()
    
    def _on_connect_complete(self, result: dict | None) -> None:
        """Handle result from ConnectModal."""
        if result:
            provider = result["provider"]
            api_key = result["api_key"]
            
            try:
                # Create the model
                model = get_default_model(provider)
                llm = get_model(provider, api_key, model)
                
                # Build the agent
                self.agent = build_agent(llm)
                self.current_provider = provider
                self.current_model = model
                
                # Save configuration
                self.config.save_provider(provider, api_key, model)
                
                # Update UI
                self._update_connection_status()
                
                # Show success message in chat
                chat_scroll = self.query_one("#chat-scroll", ChatScroll)
                success_msg = Message(
                    f"✓ Connected to {get_provider_display_name(provider)} ({model})\n\n"
                    "You can now chat with me!",
                    model="Micracode",
                    time=datetime.now().strftime("%I:%M %p")
                )
                chat_scroll.mount(success_msg)
                chat_scroll.scroll_end()
                
                self.notify(f"✓ Connected to {get_provider_display_name(provider)}")
                
            except Exception as e:
                self.notify(f"Connection failed: {str(e)}", severity="error")
    
    def _update_connection_status(self) -> None:
        """Update UI elements to reflect connection status."""
        # Update header
        header = self.query_one(Header)
        if self.current_provider:
            status = f"Connected to {get_provider_display_name(self.current_provider)}"
        else:
            status = "Not connected - type /connect to start"
        header.prompt = status
        header.refresh()
        
        # Update model bar
        model_bar = self.query_one(ModelBar)
        model_bar.provider = get_provider_display_name(self.current_provider) if self.current_provider else "Not connected"
        model_bar.model = self.current_model or "Use /connect"
        model_bar.refresh()
    
    def _run_init_command(self) -> None:
        """Run the /init command to generate Micracode.md."""
        chat_scroll = self.query_one("#chat-scroll", ChatScroll)
        current_time = datetime.now().strftime("%I:%M %p")
        
        # Show user command
        user_msg = Message("/init", model="", time=current_time, role="user")
        chat_scroll.mount(user_msg)
        
        # Show processing message
        processing_msg = Message(
            "🔍 Analyzing codebase and generating Micracode.md...",
            model="Micracode",
            time=current_time
        )
        chat_scroll.mount(processing_msg)
        chat_scroll.scroll_end()
        
        # Run the init command
        import os
        result = run_init_command(os.getcwd())
        
        # Remove processing message and show result
        processing_msg.remove()
        
        result_msg = Message(
            f"{result}\n\n"
            "The `Micracode.md` file is now your project's AI handbook. "
            "You can customize it by adding:\n"
            "- Project-specific guidelines\n"
            "- Code conventions\n"
            "- Important context for AI assistants",
            model="Micracode",
            time=datetime.now().strftime("%I:%M %p")
        )
        chat_scroll.mount(result_msg)
        chat_scroll.scroll_end()
        
        self.notify(result)
    
    def _create_startup_checkpoint(self) -> None:
        """Create an initial checkpoint on startup if working directory is dirty."""
        import os
        if is_git_repo(os.getcwd()) and is_working_dir_dirty(os.getcwd()):
            success, sha = create_checkpoint(os.getcwd())
            if success:
                self.last_checkpoint_sha = sha
    
    def _create_checkpoint(self) -> None:
        """Create a checkpoint before processing a user message."""
        import os
        if is_git_repo(os.getcwd()):
            success, sha = create_checkpoint(os.getcwd())
            if success:
                self.last_checkpoint_sha = sha
    
    def _run_undo_command(self) -> None:
        """Run the /undo command to revert the last interaction."""
        import os
        chat_scroll = self.query_one("#chat-scroll", ChatScroll)
        current_time = datetime.now().strftime("%I:%M %p")
        
        # Show undo command
        user_msg = Message("/undo", model="", time=current_time, role="user")
        chat_scroll.mount(user_msg)
        chat_scroll.scroll_end()
        
        # Check if we're in a git repo
        if not is_git_repo(os.getcwd()):
            error_msg = Message(
                "⚠️ Undo requires a Git repository. "
                "Initialize git with `git init` to enable undo functionality.",
                model="Micracode",
                time=current_time
            )
            chat_scroll.mount(error_msg)
            chat_scroll.scroll_end()
            return
        
        # Check if there's anything to undo
        if len(self.messages) < 2:
            error_msg = Message(
                "Nothing to undo. No previous interaction found.",
                model="Micracode",
                time=current_time
            )
            chat_scroll.mount(error_msg)
            chat_scroll.scroll_end()
            return
        
        # Find the checkpoint to revert to
        success, sha = get_last_checkpoint_sha(os.getcwd())
        
        if not success:
            error_msg = Message(
                f"⚠️ {sha}",  # sha contains error message on failure
                model="Micracode",
                time=current_time
            )
            chat_scroll.mount(error_msg)
            chat_scroll.scroll_end()
            return
        
        # Revert to the checkpoint
        success, revert_msg = revert_to_checkpoint(sha, os.getcwd())
        
        if not success:
            error_msg = Message(
                f"⚠️ Failed to revert files: {revert_msg}",
                model="Micracode",
                time=current_time
            )
            chat_scroll.mount(error_msg)
            chat_scroll.scroll_end()
            return
        
        # Remove last AI message and last Human message from history
        # Find and remove the last AI message
        for i in range(len(self.messages) - 1, -1, -1):
            if isinstance(self.messages[i], AIMessage):
                self.messages.pop(i)
                break
        
        # Find and remove the last Human message
        for i in range(len(self.messages) - 1, -1, -1):
            if isinstance(self.messages[i], HumanMessage):
                self.messages.pop(i)
                break
        
        # Remove UI elements - find and remove all widgets after the welcome message
        # that correspond to the last interaction
        children = list(chat_scroll.children)
        if len(children) >= 2:
            # Remove at least the last 2 messages (user + AI response)
            # But also remove any tool messages in between
            widgets_to_remove = []
            found_ai_response = False
            for child in reversed(children):
                # Skip the /undo command we just added
                if isinstance(child, Message) and child.content == "/undo":
                    continue
                if isinstance(child, (Message, ToolCallMessage, ToolResultMessage, StreamingMessage, InteractiveDiffBlock)):
                    widgets_to_remove.append(child)
                    if isinstance(child, Message) and child.role == "user":
                        break
            
            for widget in widgets_to_remove:
                widget.remove()
        
        # Clear last checkpoint SHA
        self.last_checkpoint_sha = None
        
        # Save updated session
        if self.current_session_id:
            self.session_store.save_session(
                self.current_session_id,
                self.messages,
                model=self.current_model,
                provider=self.current_provider
            )
        
        # Show success message
        success_msg = Message(
            "✓ Undone! Reverted to previous state.\n"
            "File changes have been restored and the last interaction has been removed.",
            model="Micracode",
            time=current_time
        )
        chat_scroll.mount(success_msg)
        chat_scroll.scroll_end()
        
        self.notify("Undo successful")
    
    def _run_clear_command(self) -> None:
        """Clear the chat display while keeping the session intact."""
        chat_scroll = self.query_one("#chat-scroll", ChatScroll)
        current_time = datetime.now().strftime("%I:%M %p")
        
        # Clear all messages from UI
        chat_scroll.remove_children()
        
        # Show a confirmation message
        clear_msg = Message(
            "✓ Chat cleared. Session history preserved.\n"
            "You can continue the conversation - the AI remembers previous context.",
            model="Micracode",
            time=current_time
        )
        chat_scroll.mount(clear_msg)
        chat_scroll.scroll_end()
        
        self.notify("Chat display cleared")
    
    def _run_model_command(self, model_name: str | None) -> None:
        """Switch to a different model or show available models."""
        chat_scroll = self.query_one("#chat-scroll", ChatScroll)
        current_time = datetime.now().strftime("%I:%M %p")
        
        # Check if connected to a provider
        if not self.current_provider:
            error_msg = Message(
                "Not connected to any AI provider. Use /connect first.",
                model="Micracode",
                time=current_time
            )
            chat_scroll.mount(error_msg)
            chat_scroll.scroll_end()
            return
        
        # If no model specified, show available models
        if not model_name:
            available = get_available_models(self.current_provider)
            current = self.current_model or "unknown"
            models_list = "\n".join(f"  • {m}" + (" (current)" if m == current else "") for m in available)
            
            help_msg = Message(
                f"**Available models for {get_provider_display_name(self.current_provider)}:**\n\n"
                f"{models_list}\n\n"
                f"Usage: `/model <model-name>`\n"
                f"Example: `/model gpt-4o-mini`",
                model="Micracode",
                time=current_time
            )
            chat_scroll.mount(help_msg)
            chat_scroll.scroll_end()
            return
        
        # Try to switch to the specified model
        try:
            # Get the API key from config
            config = self.config.get_provider()
            if not config:
                raise ValueError("No saved configuration found")
            
            _, api_key, _ = config
            
            # Create new model instance
            llm = get_model(self.current_provider, api_key, model_name)
            
            # Rebuild the agent with new model
            self.agent = build_agent(llm)
            old_model = self.current_model
            self.current_model = model_name
            
            # Update saved config
            self.config.save_provider(self.current_provider, api_key, model_name)
            
            # Update UI
            self._update_connection_status()
            
            # Show success message
            success_msg = Message(
                f"✓ Switched from `{old_model}` to `{model_name}`",
                model="Micracode",
                time=current_time
            )
            chat_scroll.mount(success_msg)
            chat_scroll.scroll_end()
            
            self.notify(f"Model switched to {model_name}")
            
        except Exception as e:
            error_msg = Message(
                f"⚠️ Failed to switch model: {str(e)}",
                model="Micracode",
                time=current_time
            )
            chat_scroll.mount(error_msg)
            chat_scroll.scroll_end()
    
    def action_show_history(self) -> None:
        """Show the session history browser."""
        sessions = self.session_store.list_sessions()
        self.push_screen(SessionBrowser(sessions), self._on_session_browser_complete)
    
    def action_new_session(self) -> None:
        """Start a new chat session."""
        # Clear current session
        self.session_store.clear_current_session()
        self.current_session_id = None
        self.messages = []
        
        # Clear the chat scroll and show welcome message
        chat_scroll = self.query_one("#chat-scroll", ChatScroll)
        chat_scroll.remove_children()
        
        welcome_msg = Message(
            "Welcome to Micracode! I'm your AI coding assistant.\n\n"
            "Commands:\n"
            "  /connect - Connect to an AI provider\n"
            "  /model   - Switch models (e.g., /model gpt-4o)\n"
            "  /init    - Generate project handbook (Micracode.md)\n"
            "  /undo    - Undo last interaction (requires Git)\n"
            "  /clear   - Clear chat display (keeps session)\n"
            "  /quit    - Exit the application\n\n"
            "Shortcuts:\n"
            "  Ctrl+H   - Browse conversation history\n"
            "  Ctrl+N   - Start a new chat\n\n"
            "Type a message to chat with me!",
            model="Micracode",
            time=datetime.now().strftime("%I:%M %p")
        )
        chat_scroll.mount(welcome_msg)
        
        self.notify("Started new chat session")
    
    def _on_session_browser_complete(self, result: dict | None) -> None:
        """Handle result from SessionBrowser."""
        if not result:
            return
        
        action = result.get("action")
        
        if action == "new":
            self.action_new_session()
        
        elif action == "open":
            session_id = result.get("session_id")
            if session_id:
                self._load_session(session_id)
        
        elif action == "delete":
            session_id = result.get("session_id")
            if session_id:
                self.session_store.delete_session(session_id)
                self.notify("Session deleted")
                # Re-open the browser with updated list
                self.action_show_history()
    
    def _load_session(self, session_id: str) -> None:
        """Load a session and restore its messages."""
        session_data = self.session_store.load_session(session_id)
        if not session_data:
            self.notify("Failed to load session", severity="error")
            return
        
        # Update state
        self.current_session_id = session_id
        self.messages = session_data.get("messages", [])
        self.session_store.set_current_session(session_id)
        
        # Clear and rebuild chat UI
        chat_scroll = self.query_one("#chat-scroll", ChatScroll)
        chat_scroll.remove_children()
        
        # Restore messages
        for msg in self.messages:
            if isinstance(msg, HumanMessage):
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                ui_msg = Message(content, model="", time="", role="user")
                chat_scroll.mount(ui_msg)
            elif isinstance(msg, AIMessage) and msg.content:
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                ui_msg = Message(
                    content,
                    model=session_data.get("model", ""),
                    time="",
                    role="ai"
                )
                chat_scroll.mount(ui_msg)
        
        chat_scroll.scroll_end()
        self.notify(f"Loaded: {session_data.get('title', 'Untitled')}")
    
    def on_diff_accepted(self, event: DiffAccepted) -> None:
        """Handle when user accepts a proposed diff."""
        self.notify(f"✓ {event.result}", severity="information")
    
    def on_diff_rejected(self, event: DiffRejected) -> None:
        """Handle when user rejects a proposed diff."""
        self.notify(f"✗ Changes rejected for {event.file_path}", severity="warning")


def main():
    app = MicracodeApp()
    app.run()


if __name__ == "__main__":
    main()

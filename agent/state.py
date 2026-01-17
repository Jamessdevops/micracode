"""Agent state definition."""

from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages


class AgentState(TypedDict):
    """State for the agent graph.
    
    Attributes:
        messages: List of chat messages with automatic append behavior
    """
    messages: Annotated[list[BaseMessage], add_messages]

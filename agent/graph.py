"""LangGraph agent builder with tool support."""

from typing import Literal
from langgraph.graph import StateGraph, END
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage

from .state import AgentState
from .nodes import create_agent_node, create_tool_node
from tools import ALL_TOOLS


def should_continue(state: AgentState) -> Literal["tools", "end"]:
    """Determine whether to continue to tools or end."""
    messages = state["messages"]
    last_message = messages[-1]
    
    # If the last message has tool calls, route to tools
    if isinstance(last_message, AIMessage) and last_message.tool_calls:
        return "tools"
    
    # Otherwise, end
    return "end"


def build_agent(model: BaseChatModel):
    """Build a LangGraph agent with the given model and tools.
    
    Args:
        model: The chat model to use
    
    Returns:
        A compiled LangGraph that can be invoked with messages
    """
    # Bind tools to the model
    model_with_tools = model.bind_tools(ALL_TOOLS)
    
    # Create the graph
    graph = StateGraph(AgentState)
    
    # Add nodes
    agent_node = create_agent_node(model_with_tools)
    tool_node = create_tool_node(ALL_TOOLS)
    
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    
    # Set entry point
    graph.set_entry_point("agent")
    
    # Add conditional edge from agent
    graph.add_conditional_edges(
        "agent",
        should_continue,
        {
            "tools": "tools",
            "end": END,
        }
    )
    
    # Tools always go back to agent
    graph.add_edge("tools", "agent")
    
    # Compile and return
    return graph.compile()


def invoke_agent(agent, message: str) -> str:
    """Invoke the agent with a user message.
    
    Args:
        agent: The compiled agent graph
        message: User message string
    
    Returns:
        The agent's response text
    """
    result = agent.invoke({
        "messages": [HumanMessage(content=message)]
    })
    
    # Get the last AI message (skip tool messages)
    for msg in reversed(result["messages"]):
        if isinstance(msg, AIMessage) and msg.content:
            return msg.content
    
    return "No response generated."


def _extract_text_content(content) -> str:
    """Extract text from content that may be a string or list of content blocks.
    
    Args:
        content: Either a string or a list of content block dicts
        
    Returns:
        Extracted text as a string
    """
    if isinstance(content, str):
        return content
    
    if isinstance(content, list):
        # Extract text from content blocks (e.g., [{"type": "text", "text": "..."}])
        text_parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif isinstance(block, str):
                text_parts.append(block)
        return "".join(text_parts)
    
    # Fallback: try to convert to string
    return str(content) if content else ""


async def stream_agent(agent, message: str):
    """Stream the agent's response with tool call events.
    
    Args:
        agent: The compiled agent graph
        message: User message string
    
    Yields:
        Tuples of (event_type, data):
        - ("text", str) - streaming text chunk
        - ("tool_call", dict) - tool invocation {name, args, id}
        - ("tool_result", dict) - tool result {name, result, id}
    """
    async for event in agent.astream_events(
        {"messages": [HumanMessage(content=message)]},
        version="v2"
    ):
        kind = event["event"]
        
        # Streaming text from the model
        if kind == "on_chat_model_stream":
            chunk = event["data"]["chunk"]
            if hasattr(chunk, "content") and chunk.content:
                text = _extract_text_content(chunk.content)
                if text:
                    yield ("text", text)
        
        # Tool call started
        elif kind == "on_tool_start":
            tool_input = event["data"].get("input", {})
            yield ("tool_call", {
                "name": event["name"],
                "args": tool_input,
                "id": event.get("run_id", ""),
            })
        
        # Tool call completed
        elif kind == "on_tool_end":
            output = event["data"].get("output", "")
            yield ("tool_result", {
                "name": event["name"],
                "result": str(output) if output else "",
                "id": event.get("run_id", ""),
            })

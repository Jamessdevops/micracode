"""Agent node functions."""

from langchain_core.messages import AIMessage, ToolMessage, SystemMessage
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool

from .state import AgentState


SYSTEM_PROMPT = """You are a helpful AI coding assistant.

When making file changes, ALWAYS use the `propose_edit` tool instead of `write_file`. 
This allows the user to review and approve changes before they are applied.

Only use `write_file` if the user explicitly asks you to apply changes directly without review."""


def create_agent_node(model: BaseChatModel):
    """Create an agent node function with the given model.
    
    Args:
        model: The chat model (with tools bound) to use
    
    Returns:
        A node function for the agent
    """
    def agent_node(state: AgentState) -> dict:
        """Process messages and generate a response."""
        messages = state["messages"]
        
        # Add system prompt if not already present
        if not messages or not isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=SYSTEM_PROMPT)] + list(messages)
        
        response = model.invoke(messages)
        return {"messages": [response]}
    
    return agent_node


def create_tool_node(tools: list[BaseTool]):
    """Create a tool execution node.
    
    Args:
        tools: List of tools available for execution
    
    Returns:
        A node function that executes tool calls
    """
    # Create a tool lookup dictionary
    tool_map = {tool.name: tool for tool in tools}
    
    def tool_node(state: AgentState) -> dict:
        """Execute tool calls from the last AI message."""
        messages = state["messages"]
        last_message = messages[-1]
        
        tool_messages = []
        
        if isinstance(last_message, AIMessage) and last_message.tool_calls:
            for tool_call in last_message.tool_calls:
                tool_name = tool_call["name"]
                tool_args = tool_call["args"]
                tool_id = tool_call["id"]
                
                # Execute the tool
                if tool_name in tool_map:
                    try:
                        result = tool_map[tool_name].invoke(tool_args)
                    except Exception as e:
                        result = f"Error executing {tool_name}: {str(e)}"
                else:
                    result = f"Unknown tool: {tool_name}"
                
                # Create tool message
                tool_messages.append(
                    ToolMessage(
                        content=str(result),
                        tool_call_id=tool_id,
                        name=tool_name,
                    )
                )
        
        return {"messages": tool_messages}
    
    return tool_node


async def create_agent_node_async(model: BaseChatModel):
    """Create an async agent node function with the given model.
    
    Args:
        model: The chat model to use
    
    Returns:
        An async node function for the agent
    """
    async def agent_node(state: AgentState) -> dict:
        """Process messages and generate a response."""
        messages = state["messages"]
        response = await model.ainvoke(messages)
        return {"messages": [response]}
    
    return agent_node

"""Model factory for LLM providers."""

from typing import Optional
from langchain_core.language_models.chat_models import BaseChatModel


def get_model(provider: str, api_key: str, model: Optional[str] = None) -> BaseChatModel:
    """Get a chat model instance for the specified provider.
    
    Args:
        provider: Provider name (gemini, openai, anthropic)
        api_key: API key for the provider
        model: Optional model name (uses default if not specified)
    
    Returns:
        A LangChain chat model instance
    
    Raises:
        ValueError: If provider is not supported
    """
    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(
            model=model or "gemini-2.5-flash",
            google_api_key=api_key,
        )
    
    elif provider == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model or "gpt-4o",
            api_key=api_key,
        )
    
    elif provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(
            model=model or "claude-sonnet-4-20250514",
            api_key=api_key,
        )
    
    else:
        raise ValueError(f"Unsupported provider: {provider}")


def get_provider_display_name(provider: str) -> str:
    """Get display name for a provider."""
    names = {
        "gemini": "Gemini",
        "openai": "OpenAI", 
        "anthropic": "Anthropic",
    }
    return names.get(provider, provider.title())


def get_default_model(provider: str) -> str:
    """Get default model for a provider."""
    defaults = {
        "gemini": "gemini-2.5-flash",
        "openai": "gpt-4o",
        "anthropic": "claude-sonnet-4-20250514",
    }
    return defaults.get(provider, "")


def get_available_models(provider: str) -> list[str]:
    """Get list of available models for a provider."""
    models = {
        "gemini": [
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.0-flash",
            "gemini-1.5-pro",
            "gemini-1.5-flash",
        ],
        "openai": [
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4-turbo",
            "gpt-4",
            "o1",
            "o1-mini",
            "o3-mini",
        ],
        "anthropic": [
            "claude-sonnet-4-20250514",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
        ],
    }
    return models.get(provider, [])

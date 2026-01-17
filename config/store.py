"""API key and provider configuration storage."""

import json
import os
from pathlib import Path
from typing import Optional


class ConfigStore:
    """Store and retrieve API keys and provider configuration.
    
    Keys are stored in memory during the session and optionally
    persisted to a config file.
    """
    
    CONFIG_DIR = Path.home() / ".config" / "Micracode"
    CONFIG_FILE = CONFIG_DIR / "config.json"
    
    def __init__(self):
        self._provider: Optional[str] = None
        self._api_key: Optional[str] = None
        self._model: Optional[str] = None
        self._load_from_file()
    
    def _load_from_file(self) -> None:
        """Load saved configuration from file."""
        if self.CONFIG_FILE.exists():
            try:
                with open(self.CONFIG_FILE, "r") as f:
                    data = json.load(f)
                    self._provider = data.get("provider")
                    self._api_key = data.get("api_key")
                    self._model = data.get("model")
            except (json.JSONDecodeError, IOError):
                pass
    
    def _save_to_file(self) -> None:
        """Save configuration to file."""
        self.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(self.CONFIG_FILE, "w") as f:
            json.dump({
                "provider": self._provider,
                "api_key": self._api_key,
                "model": self._model,
            }, f)
    
    def save_provider(self, provider: str, api_key: str, model: Optional[str] = None) -> None:
        """Save provider and API key.
        
        Args:
            provider: Provider name (gemini, openai, anthropic)
            api_key: API key for the provider
            model: Optional model name override
        """
        self._provider = provider
        self._api_key = api_key
        self._model = model or self._get_default_model(provider)
        self._save_to_file()
    
    def _get_default_model(self, provider: str) -> str:
        """Get default model for a provider."""
        defaults = {
            "gemini": "gemini-2.5-flash",
            "openai": "gpt-4o",
            "anthropic": "claude-sonnet-4-20250514",
        }
        return defaults.get(provider, "")
    
    def get_provider(self) -> Optional[tuple[str, str, str]]:
        """Get current provider configuration.
        
        Returns:
            Tuple of (provider, api_key, model) or None if not configured
        """
        if self._provider and self._api_key:
            return (self._provider, self._api_key, self._model or "")
        return None
    
    def is_configured(self) -> bool:
        """Check if a provider is configured."""
        return self._provider is not None and self._api_key is not None
    
    def clear(self) -> None:
        """Clear stored configuration."""
        self._provider = None
        self._api_key = None
        self._model = None
        if self.CONFIG_FILE.exists():
            self.CONFIG_FILE.unlink()


# Global instance
config_store = ConfigStore()

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_data_dir() -> Path:
    return Path.home() / "opener-apps"


class CoreConfig(BaseSettings):
    """Core runtime settings shared across all Micracode apps.

    Each app layer (web server, CLI, desktop) instantiates this with its own
    env-file or explicit overrides.  The core never does filesystem I/O to
    locate configuration.
    """

    model_config = SettingsConfigDict(
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "micracode"
    environment: str = Field(default="development")
    log_level: str = Field(default="INFO")

    # --- LLM ------------------------------------------------------------------
    llm_provider: Literal["gemini", "openai", "ollama"] = Field(default="gemini")

    google_api_key: str = Field(default="")
    gemini_model: str = Field(default="gemini-2.5-flash")

    openai_api_key: str = Field(default="")
    openai_model: str = Field(default="")

    ollama_base_url: str = Field(default="http://localhost:11434")
    ollama_model: str = Field(default="")

    @property
    def active_model(self) -> str:
        if self.llm_provider == "openai":
            return self.openai_model
        if self.llm_provider == "ollama":
            return self.ollama_model
        return self.gemini_model

    @property
    def active_api_key(self) -> str:
        if self.llm_provider == "openai":
            return self.openai_api_key
        if self.llm_provider == "ollama":
            return ""
        return self.google_api_key

    # --- Tool-calling loop ----------------------------------------------------
    max_tool_iterations: int = Field(default=20)
    shell_exec_output_limit: int = Field(default=8192)

    # --- Storage --------------------------------------------------------------
    opener_apps_dir: Path = Field(default_factory=_default_data_dir)

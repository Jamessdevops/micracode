"""Application configuration for the FastAPI dev server.

Extends :class:`CoreConfig` with web-transport-specific settings (CORS).
Values are read from (in order of precedence):
  1. Process environment
  2. ``apps/api/.env``
  3. Repo-root ``.env``
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import SettingsConfigDict

from micracode_core.config import CoreConfig

from .authfile import read_auth

_API_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _API_DIR.parent.parent


class Settings(CoreConfig):
    """Runtime settings for the FastAPI dev server."""

    model_config = SettingsConfigDict(
        env_file=(_REPO_ROOT / ".env", _API_DIR / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_web_origin: str = Field(default="http://localhost:3000")

    @property
    def cors_allow_origins(self) -> list[str]:
        return [o.strip() for o in self.app_web_origin.split(",") if o.strip()]

    @property
    def active_api_key_env_var(self) -> str:
        if self.llm_provider == "openai":
            return "OPENAI_API_KEY"
        if self.llm_provider == "ollama":
            return ""
        return "GOOGLE_API_KEY"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    # Feed the shared auth file into env; an explicit process env still wins,
    # so precedence is: process env > auth file > .env.
    for name, value in read_auth().items():
        os.environ.setdefault(name, value)
    return Settings()


settings = get_settings()

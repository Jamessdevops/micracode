"""`/v1/settings` — read and persist user API keys in the shared auth file.

Only the OpenAI key for now. Writing persists to the dedicated auth file
(shared with the desktop core, see ``authfile.py``) *and* mutates the live
cached ``Settings`` singleton so generation picks it up immediately — no
restart needed.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..authfile import write_auth
from ..config import get_settings

router = APIRouter()


class OpenAiKeyUpdate(BaseModel):
    openai_api_key: str


def _mask(key: str) -> str | None:
    if not key:
        return None
    return f"…{key[-4:]}" if len(key) > 4 else "…"


def _view() -> dict:
    key = get_settings().openai_api_key
    return {"openai": {"configured": bool(key), "hint": _mask(key)}}


@router.get("/settings")
async def read_settings() -> dict:
    return _view()


@router.post("/settings")
async def update_settings(body: OpenAiKeyUpdate) -> dict:
    key = body.openai_api_key.strip()
    get_settings().openai_api_key = key  # live effect, same object as engine.config
    write_auth("OPENAI_API_KEY", key)  # persist to the shared file
    return _view()

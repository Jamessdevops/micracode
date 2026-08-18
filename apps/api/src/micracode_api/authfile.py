"""Shared dedicated API-key file, also read/written by the TS core.

   $XDG_DATA_HOME/micracode/auth.json   (default ~/.local/share/micracode/…)

Flat JSON map of env-var name → value, e.g. ``{"OPENAI_API_KEY": "sk-…"}`` —
the names match the env vars the generators read, so the file feeds env
directly. File mode 0600; it holds secrets.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path


def auth_file() -> Path:
    data_home = os.environ.get("XDG_DATA_HOME", "").strip() or str(
        Path.home() / ".local" / "share"
    )
    return Path(data_home) / "micracode" / "auth.json"


def read_auth() -> dict[str, str]:
    try:
        data = json.loads(auth_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}  # missing or malformed → no keys
    return {k: v for k, v in data.items() if isinstance(v, str)}


def write_auth(name: str, value: str) -> None:
    path = auth_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = read_auth()
    data[name] = value
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600

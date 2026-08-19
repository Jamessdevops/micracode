"""Tests for `/v1/settings` and the shared auth-file store."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from micracode_api import authfile
from micracode_api.config import get_settings


def test_write_auth_round_trip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MICRACODE_CONFIG_DIR", str(tmp_path))

    assert authfile.read_auth() == {}  # missing file → no keys

    authfile.write_auth("OPENAI_API_KEY", "sk-1")
    authfile.write_auth("GOOGLE_API_KEY", "g")  # unrelated key preserved
    assert authfile.read_auth() == {"OPENAI_API_KEY": "sk-1", "GOOGLE_API_KEY": "g"}
    assert (authfile.auth_file().stat().st_mode & 0o777) == 0o600


def test_post_settings_takes_effect_live(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MICRACODE_CONFIG_DIR", str(tmp_path))

    res = client.post("/v1/settings", json={"openai_api_key": "sk-live-1234"})
    assert res.status_code == 200
    assert res.json()["openai"] == {"configured": True, "hint": "…1234"}

    # Live singleton mutated, so generation would use it without a restart.
    assert get_settings().openai_api_key == "sk-live-1234"
    assert client.get("/v1/settings").json()["openai"]["configured"] is True
    # Persisted to the shared dedicated file.
    assert authfile.read_auth()["OPENAI_API_KEY"] == "sk-live-1234"

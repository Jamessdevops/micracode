"""Checks for attachment composition in the orchestrator."""

from __future__ import annotations

import base64
import io

from micracode_core.orchestrator import _compose_human
from micracode_core.schemas.stream import Attachment


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def test_no_attachments_returns_plain_text() -> None:
    assert _compose_human("hello", None) == "hello"
    assert _compose_human("hello", []) == "hello"


def test_text_attachment_appended_as_block() -> None:
    att = Attachment(name="notes.txt", mime_type="text/plain", data=_b64(b"buy milk"))
    out = _compose_human("do this", [att])
    assert isinstance(out, str)
    assert "do this" in out
    assert "notes.txt" in out
    assert "buy milk" in out


def test_image_attachment_makes_multimodal_list() -> None:
    att = Attachment(name="shot.png", mime_type="image/png", data=_b64(b"\x89PNG"))
    out = _compose_human("look", [att])
    assert isinstance(out, list)
    assert out[0] == {"type": "text", "text": "look"}
    assert out[1]["type"] == "image_url"
    assert out[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_unknown_binary_is_skipped() -> None:
    att = Attachment(
        name="a.bin", mime_type="application/octet-stream", data=_b64(b"\x00\x01")
    )
    assert _compose_human("x", [att]) == "x"


def test_pdf_text_is_extracted() -> None:
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)
    att = Attachment(
        name="doc.pdf", mime_type="application/pdf", data=_b64(buf.getvalue())
    )
    # A blank page extracts to empty text, so the block is skipped entirely.
    assert _compose_human("x", [att]) == "x"

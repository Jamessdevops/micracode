/**
 * Per-turn chat attachments for the desktop backend. Images ride into the pi
 * session as native `ImageContent` (vision); text/code/PDF files are extracted
 * to text and appended to the prompt as labeled context blocks. Nothing here
 * is persisted — attachments are context for a single turn only.
 *
 * Mirrors the Python core's `_compose_human` (packages/core orchestrator.py).
 */

import type { ImageContent } from "@earendil-works/pi-ai/compat";

export interface RawAttachment {
  name: string;
  mime_type: string;
  /** base64-encoded file bytes, no `data:` prefix. */
  data: string;
}

const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/csv",
  "application/x-sh",
]);
const ATTACHMENT_TEXT_CAP = 20_000;

async function pdfText(raw: Buffer): Promise<string | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(raw));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim() || null;
  } catch {
    // Corrupt/scanned/unsupported PDF — contribute nothing rather than fail.
    return null;
  }
}

async function attachmentText(att: RawAttachment): Promise<string | null> {
  const mime = att.mime_type.toLowerCase();
  let raw: Buffer;
  try {
    raw = Buffer.from(att.data, "base64");
  } catch {
    return null;
  }
  let text: string | null;
  if (mime === "application/pdf") text = await pdfText(raw);
  else if (mime.startsWith("text/") || TEXT_MIME_EXACT.has(mime))
    text = raw.toString("utf8");
  else return null; // images handled separately; other binaries skipped
  if (!text) return null;
  return text.slice(0, ATTACHMENT_TEXT_CAP);
}

/**
 * Split attachments into (1) a prompt string with text/PDF content appended
 * and (2) the image attachments as pi `ImageContent` for the vision channel.
 */
export async function composeAttachments(
  prompt: string,
  attachments: RawAttachment[] | undefined,
): Promise<{ prompt: string; images: ImageContent[] }> {
  if (!attachments?.length) return { prompt, images: [] };
  const blocks: string[] = [];
  const images: ImageContent[] = [];
  for (const att of attachments) {
    if (att.mime_type.toLowerCase().startsWith("image/")) {
      images.push({ type: "image", data: att.data, mimeType: att.mime_type });
      continue;
    }
    const text = await attachmentText(att);
    if (text) blocks.push(`----- Attached file: ${att.name} -----\n${text}`);
  }
  let full = prompt;
  if (blocks.length) {
    full = `${prompt}\n\nAttached files provided by the user for context:\n\n${blocks.join("\n\n")}`;
  }
  return { prompt: full, images };
}

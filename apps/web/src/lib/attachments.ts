/**
 * Chat attachments: files the user drops/pastes/picks to give the model
 * extra context for a single turn. They are sent alongside the prompt in
 * the `/v1/generate` body and never persisted into project history.
 */
export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  /** base64-encoded file bytes, no `data:` prefix. */
  data: string;
  size: number;
}

/** Per-file cap. Images/PDFs above this are rejected client-side. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function isImageAttachment(a: ChatAttachment): boolean {
  return a.mimeType.startsWith("image/");
}

export async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    id: crypto.randomUUID(),
    name: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    data: btoa(binary),
    size: file.size,
  };
}

/**
 * Convert picked/dropped/pasted files into attachments, silently dropping
 * any that exceed {@link MAX_ATTACHMENT_BYTES}. Returns the accepted
 * attachments plus the names that were rejected for oversize.
 */
export async function filesToAttachments(
  files: File[],
): Promise<{ accepted: ChatAttachment[]; rejected: string[] }> {
  const accepted: ChatAttachment[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(file.name);
      continue;
    }
    accepted.push(await fileToAttachment(file));
  }
  return { accepted, rejected };
}

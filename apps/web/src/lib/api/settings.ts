/**
 * Typed client for `/v1/settings` — read + persist user API keys, one entry
 * per provider (openai, anthropic/Claude, kimi/Moonshot, gemini).
 */

import { env } from "@/lib/env";

export interface ProviderKeyState {
  configured: boolean;
  hint: string | null;
}

/** Map of provider id -> key state, e.g. { openai: {...}, anthropic: {...} }. */
export type SettingsView = Record<string, ProviderKeyState>;

export async function getSettings(init?: RequestInit): Promise<SettingsView> {
  const res = await fetch(`${env.API_BASE_URL}/v1/settings`, {
    ...init,
    cache: "no-store",
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`GET /v1/settings failed: ${res.status}`);
  return (await res.json()) as SettingsView;
}

export async function updateProviderKey(
  provider: string,
  key: string,
): Promise<SettingsView> {
  const res = await fetch(`${env.API_BASE_URL}/v1/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ provider, key }),
  });
  if (!res.ok) throw new Error(`POST /v1/settings failed: ${res.status}`);
  return (await res.json()) as SettingsView;
}

/** True when at least one provider has a key configured. */
export const anyConfigured = (s: SettingsView): boolean =>
  Object.values(s).some((p) => p.configured);

/**
 * Typed client for `/v1/settings` — read + persist user API keys.
 * OpenAI only for now.
 */

import { env } from "@/lib/env";

export interface ProviderKeyState {
  configured: boolean;
  hint: string | null;
}

export interface SettingsView {
  openai: ProviderKeyState;
}

export async function getSettings(init?: RequestInit): Promise<SettingsView> {
  const res = await fetch(`${env.API_BASE_URL}/v1/settings`, {
    ...init,
    cache: "no-store",
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`GET /v1/settings failed: ${res.status}`);
  return (await res.json()) as SettingsView;
}

export async function updateOpenAiKey(key: string): Promise<SettingsView> {
  const res = await fetch(`${env.API_BASE_URL}/v1/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ openai_api_key: key }),
  });
  if (!res.ok) throw new Error(`POST /v1/settings failed: ${res.status}`);
  return (await res.json()) as SettingsView;
}

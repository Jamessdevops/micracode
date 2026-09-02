/**
 * Typed client for `GET /v1/models`.
 *
 * The backend returns the catalog of provider+model pairs the server
 * will accept, flagging each provider with `available: boolean` based
 * on whether the corresponding API key is configured. The UI picker
 * consumes this to disable unavailable providers.
 */

import { env } from "@/lib/env";

export type ProviderId = string;

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderCatalog {
  id: ProviderId;
  label: string;
  available: boolean;
  models: ModelOption[];
}

export interface ModelCatalog {
  providers: ProviderCatalog[];
  default: { provider: string; model: string };
}

export async function getModelCatalog(init?: RequestInit): Promise<ModelCatalog> {
  const res = await fetch(`${env.API_BASE_URL}/v1/models`, {
    ...init,
    cache: "no-store",
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/models failed: ${res.status}`);
  }
  return (await res.json()) as ModelCatalog;
}

/**
 * Client-safe environment accessor.
 *
 * Only `NEXT_PUBLIC_*` variables are exposed to the browser bundle.
 * Local-filesystem build: no auth, no DB credentials — the backend
 * URL is the only thing the client needs.
 *
 * In the Electron shell the backend picks a free port at startup, so the
 * static export can't be built with the URL baked in — the preload injects
 * `__MICRACODE_API_BASE__` instead, and it wins when present.
 */

export const env = {
  get API_BASE_URL(): string {
    if (typeof window !== "undefined") {
      const injected = (window as { __MICRACODE_API_BASE__?: string })
        .__MICRACODE_API_BASE__;
      if (injected) return injected;
    }
    return process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  },
  /** Secret the core requires on every /v1 call (preload-injected in Electron). */
  get API_TOKEN(): string {
    if (typeof window !== "undefined") {
      const injected = (window as { __MICRACODE_API_TOKEN__?: string })
        .__MICRACODE_API_TOKEN__;
      if (injected) return injected;
    }
    return process.env.NEXT_PUBLIC_MICRACODE_API_TOKEN ?? "";
  },
} as const;

export function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.API_TOKEN}` };
}

export type Env = typeof env;

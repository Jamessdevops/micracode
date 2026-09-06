/**
 * Single source of truth for the LLM providers Micracode exposes.
 *
 * Drives `/v1/models` (the picker catalog), `/v1/settings` (key entry), and
 * generate.ts (which key to inject and which pi model to select). Add a
 * provider here and it lights up in all three.
 *
 *   id         app-facing id the web client sends as `provider`
 *   piProvider pi's provider id (setRuntimeApiKey / getModel / model.provider)
 *   env        env-var name persisted in ~/.micracode/auth.json
 *   models     pi model ids (pi's per-provider defaults — guaranteed resolvable)
 */

import { cliAvailable } from "./cliHarness.js";

export interface ProviderDef {
  id: string;
  /** "pi" runs in-process via the pi SDK; "cli" spawns a local binary. */
  kind: "pi" | "cli";
  piProvider: string;
  label: string;
  /** Env var holding the API key (pi providers only). */
  env: string;
  /** Binary name spawned for cli providers (empty for pi). */
  bin?: string;
  models: { id: string; label: string }[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    kind: "pi",
    piProvider: "openai",
    label: "OpenAI",
    env: "OPENAI_API_KEY",
    models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
  },
  {
    id: "anthropic",
    kind: "pi",
    piProvider: "anthropic",
    label: "Claude",
    env: "ANTHROPIC_API_KEY",
    models: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }],
  },
  {
    id: "kimi",
    kind: "pi",
    piProvider: "moonshotai",
    label: "Kimi (Moonshot)",
    env: "MOONSHOT_API_KEY",
    models: [{ id: "kimi-k2.6", label: "Kimi K2.6" }],
  },
  {
    id: "gemini",
    kind: "pi",
    piProvider: "google",
    label: "Gemini",
    env: "GOOGLE_API_KEY",
    models: [{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" }],
  },
  // CLI backends: spawn the user's locally-installed agent (like conductor.build).
  // No API key stored here — the CLI uses its own auth/login. `bin` availability
  // is probed on PATH, not by env key.
  {
    id: "claude-cli",
    kind: "cli",
    piProvider: "anthropic",
    label: "Claude Code (CLI)",
    env: "",
    bin: "claude",
    models: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ],
  },
  {
    id: "codex-cli",
    kind: "cli",
    piProvider: "openai",
    label: "Codex (CLI)",
    env: "",
    bin: "codex",
    models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
  },
];

export const providerById = (id?: string): ProviderDef | undefined =>
  PROVIDERS.find((p) => p.id === id);

export const providerConfigured = (p: ProviderDef): boolean =>
  Boolean(p.env && process.env[p.env]);

/** Available to pick: pi providers need a key; cli providers need the binary. */
export const providerAvailable = (p: ProviderDef): boolean =>
  p.kind === "cli"
    ? Boolean(p.bin && cliAvailable(p.bin))
    : providerConfigured(p);

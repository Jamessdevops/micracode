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

export interface ProviderDef {
  id: string;
  piProvider: string;
  label: string;
  env: string;
  models: { id: string; label: string }[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    piProvider: "openai",
    label: "OpenAI",
    env: "OPENAI_API_KEY",
    models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
  },
  {
    id: "anthropic",
    piProvider: "anthropic",
    label: "Claude",
    env: "ANTHROPIC_API_KEY",
    models: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }],
  },
  {
    id: "kimi",
    piProvider: "moonshotai",
    label: "Kimi (Moonshot)",
    env: "MOONSHOT_API_KEY",
    models: [{ id: "kimi-k2.6", label: "Kimi K2.6" }],
  },
  {
    id: "gemini",
    piProvider: "google",
    label: "Gemini",
    env: "GOOGLE_API_KEY",
    models: [{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" }],
  },
];

export const providerById = (id?: string): ProviderDef | undefined =>
  PROVIDERS.find((p) => p.id === id);

export const providerConfigured = (p: ProviderDef): boolean =>
  Boolean(process.env[p.env]);

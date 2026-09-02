"use client";

import { Check, KeyRound, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  getSettings,
  updateProviderKey,
  type SettingsView,
} from "@/lib/api/settings";
import { isDesktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";

// Providers the user can configure keys for. Must match the ids the core
// exposes at /v1/settings (see apps/core/src/providers.ts).
const PROVIDERS = [
  { id: "openai", label: "OpenAI", placeholder: "sk-..." },
  { id: "anthropic", label: "Claude", placeholder: "sk-ant-..." },
  { id: "kimi", label: "Kimi (Moonshot)", placeholder: "sk-..." },
  { id: "gemini", label: "Gemini", placeholder: "AIza..." },
] as const;

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="min-h-dvh bg-[#0e0e11] text-white">
      <header
        className={cn(
          "flex h-14 items-center justify-between border-b border-[#1b1b1e] px-4 text-sm",
          // Clear the macOS traffic lights in the desktop shell.
          isDesktop() && "pt-7",
        )}
      >
        <Link href="/" className="text-zinc-400 hover:text-white">
          ← Back
        </Link>
        <span className="font-medium">Settings</span>
        <span className="w-12" />
      </header>

      <div className="mx-auto max-w-xl px-4 py-10">
        <h1 className="text-lg font-semibold">API Keys</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Configure the providers Micracode uses to generate apps. Keys are
          stored on your machine. Set a key for any provider you want to use;
          pick the model in the chat composer.
        </p>

        {error && (
          <p className="mt-4 text-sm text-red-400">{error}</p>
        )}

        <div className="mt-6 space-y-4">
          {PROVIDERS.map((p) => (
            <ProviderCard
              key={p.id}
              id={p.id}
              label={p.label}
              placeholder={p.placeholder}
              state={settings?.[p.id] ?? null}
              onSaved={setSettings}
            />
          ))}
        </div>
      </div>
    </main>
  );
}

function ProviderCard({
  id,
  label,
  placeholder,
  state,
  onSaved,
}: {
  id: string;
  label: string;
  placeholder: string;
  state: SettingsView[string] | null;
  onSaved: (s: SettingsView) => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(await updateProviderKey(id, key.trim()));
      setKey("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-[#1b1b1e] bg-[#141417] p-5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-[#45f4ff]" />
        <h2 className="font-medium">{label}</h2>
        {state?.configured && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs text-emerald-400">
            <Check className="size-3" />
            Configured {state.hint && `(${state.hint})`}
          </span>
        )}
      </div>

      <label htmlFor={`${id}-key`} className="mt-4 block text-sm text-zinc-300">
        API key
      </label>
      <input
        id={`${id}-key`}
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={state?.configured ? "Enter a new key to replace" : placeholder}
        className="mt-1.5 w-full rounded-md border border-[#2a2a30] bg-[#0e0e11] px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-[#45f4ff]"
      />

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || key.trim().length === 0}
          className="inline-flex items-center gap-2 rounded-md bg-[#45f4ff] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save
        </button>
        {saved && <span className="text-sm text-emerald-400">Saved</span>}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </section>
  );
}

"use client";

import { Check, KeyRound, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  getSettings,
  updateOpenAiKey,
  type ProviderKeyState,
} from "@/lib/api/settings";

export default function SettingsPage() {
  const [openai, setOpenai] = useState<ProviderKeyState | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings()
      .then((s) => setOpenai(s.openai))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const s = await updateOpenAiKey(key.trim());
      setOpenai(s.openai);
      setKey("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-dvh bg-[#0e0e11] text-white">
      <header className="flex h-14 items-center justify-between border-b border-[#1b1b1e] px-4 text-sm">
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
          stored on your machine.
        </p>

        <section className="mt-6 rounded-xl border border-[#1b1b1e] bg-[#141417] p-5">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-[#45f4ff]" />
            <h2 className="font-medium">OpenAI</h2>
            {openai?.configured && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs text-emerald-400">
                <Check className="size-3" />
                Configured {openai.hint && `(${openai.hint})`}
              </span>
            )}
          </div>

          <label htmlFor="openai-key" className="mt-4 block text-sm text-zinc-300">
            API key
          </label>
          <input
            id="openai-key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={openai?.configured ? "Enter a new key to replace" : "sk-..."}
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
      </div>
    </main>
  );
}

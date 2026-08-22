"use client";

import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { getSettings, updateOpenAiKey } from "@/lib/api/settings";

const SKIP_KEY = "micracode:welcome-skipped";

/**
 * First-run setup modal. Shows on the home page when no OpenAI key is
 * configured and the user hasn't skipped before. Skip is remembered in
 * localStorage; adding a key elsewhere also stops it appearing.
 */
export function WelcomeModal() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (localStorage.getItem(SKIP_KEY)) return;
    getSettings()
      .then((s) => setOpen(!s.openai.configured))
      .catch(() => {
        /* backend unreachable — don't block the app with the modal */
      });
  }, []);

  if (!open) return null;

  function skip() {
    localStorage.setItem(SKIP_KEY, "1");
    setOpen(false);
  }

  async function getStarted() {
    setSaving(true);
    setError(null);
    try {
      await updateOpenAiKey(key.trim());
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-[#1b1b1e] bg-[#141417] p-6 shadow-2xl">
        <div className="flex items-center gap-2">
          <KeyRound className="size-5 text-[#45f4ff]" />
          <h2 className="text-lg font-semibold">Welcome to Micracode</h2>
        </div>
        <p className="mt-2 text-sm text-zinc-400">
          Paste your OpenAI API key to start building. It&apos;s stored on your
          machine — you can change it later in Settings.
        </p>

        <label htmlFor="welcome-key" className="mt-5 block text-sm text-zinc-300">
          OpenAI API key
        </label>
        <input
          id="welcome-key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-..."
          className="mt-1.5 w-full rounded-md border border-[#2a2a30] bg-[#0e0e11] px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-[#45f4ff]"
        />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={skip}
            className="rounded-md px-4 py-2 text-sm text-zinc-400 hover:text-white"
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={getStarted}
            disabled={saving || key.trim().length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-[#45f4ff] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}

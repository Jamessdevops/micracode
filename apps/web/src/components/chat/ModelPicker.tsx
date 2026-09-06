"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useModelStore } from "@/store/modelStore";

/**
 * Compact model selector that lives inside the chat composer.
 *
 * Reads/writes the persisted `useModelStore`. Providers whose API key
 * isn't configured on the server appear in the menu but are disabled;
 * the user hovers to see the reason.
 */
export function ModelPicker({ className }: { className?: string }) {
  const provider = useModelStore((s) => s.provider);
  const model = useModelStore((s) => s.model);
  const catalog = useModelStore((s) => s.catalog);
  const isLoading = useModelStore((s) => s.isLoading);
  const setSelection = useModelStore((s) => s.setSelection);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeLabel = useMemo(() => {
    if (!catalog) return isLoading ? "Loading…" : model ?? "Select model";
    const p = catalog.providers.find((pp) => pp.id === provider);
    const m = p?.models.find((mm) => mm.id === model);
    return m?.label ?? model ?? "Select model";
  }, [catalog, isLoading, model, provider]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!catalog && !isLoading}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md border border-zinc-800 bg-transparent px-2 text-xs text-zinc-300",
          "transition hover:bg-zinc-800 hover:text-zinc-50",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Select model"
      >
        <span className="truncate font-mono">{activeLabel}</span>
        <ChevronDown className="size-3 shrink-0 opacity-70" />
      </button>

      {open && catalog ? (
        <div
          role="listbox"
          className={cn(
            "absolute bottom-full left-0 z-50 mb-1 w-60 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl",
          )}
        >
          <div className="max-h-72 overflow-auto py-1">
            {catalog.providers.map((p) => (
              <div key={p.id} className="py-1">
                <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
                  <span className="flex items-center gap-1.5">
                    {/* CLI backends spawn a local binary (claude/codex); flag
                        them with a badge and drop the redundant "(CLI)". */}
                    {p.id.endsWith("-cli")
                      ? p.label.replace(/\s*\(CLI\)\s*$/i, "")
                      : p.label}
                    {p.id.endsWith("-cli") ? (
                      <span
                        className="rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-emerald-400"
                        title="Runs your locally-installed CLI (its own login), not an API key."
                      >
                        CLI
                      </span>
                    ) : null}
                  </span>
                  {!p.available ? (
                    <span
                      className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400"
                      title={
                        p.id === "openai"
                          ? "Set OPENAI_API_KEY on the server to enable."
                          : p.id === "gemini"
                          ? "Set GOOGLE_API_KEY on the server to enable."
                          : "Provider is not available."
                      }
                    >
                      unavailable
                    </span>
                  ) : null}
                </div>
                {p.models.map((m) => {
                  const isActive = provider === p.id && model === m.id;
                  const isDisabled = !p.available;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      disabled={isDisabled}
                      onClick={() => {
                        if (isDisabled) return;
                        setSelection(p.id, m.id);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 transition",
                        "hover:bg-zinc-800",
                        isActive && "bg-zinc-800/60 text-zinc-50",
                        isDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                      )}
                    >
                      <span className="flex flex-col">
                        <span className="font-medium">{m.label}</span>
                        <span className="font-mono text-[10px] text-zinc-500">
                          {m.id}
                        </span>
                      </span>
                      {isActive ? (
                        <Check className="size-3.5 shrink-0 text-zinc-200" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

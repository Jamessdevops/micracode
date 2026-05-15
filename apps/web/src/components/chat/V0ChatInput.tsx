"use client";

import { ArrowUp, Square } from "lucide-react";
import { useCallback, useRef } from "react";

import { ModelPicker } from "@/components/chat/ModelPicker";
import { cn } from "@/lib/utils";

export interface V0ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function V0ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming = false,
  disabled = false,
  placeholder = "Ask a follow-up...",
}: V0ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (disabled || isStreaming) return;
      if (!value.trim()) return;
      onSubmit();
    },
    [disabled, isStreaming, onSubmit, value],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        "rounded-xl border border-zinc-800 bg-zinc-900 p-2 text-sm",
        "focus-within:border-zinc-700",
      )}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!isStreaming && value.trim()) onSubmit();
          }
        }}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          "block w-full resize-none bg-transparent px-2 py-1.5 text-sm text-zinc-50 outline-none",
          "placeholder:text-zinc-500",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      />
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-1">
          <ModelPicker />
        </div>
        <div className="flex items-center gap-1">
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-zinc-800 text-zinc-50 transition hover:bg-zinc-700"
              aria-label="Stop generating"
              title="Stop"
            >
              <Square className="size-3.5" fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={disabled || !value.trim()}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md transition",
                value.trim() && !disabled
                  ? "bg-zinc-50 text-black hover:bg-white"
                  : "bg-zinc-800 text-zinc-500",
              )}
              aria-label="Send message"
              title="Send"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

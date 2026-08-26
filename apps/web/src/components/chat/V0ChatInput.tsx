"use client";

import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { ModelPicker } from "@/components/chat/ModelPicker";
import type { ChatAttachment } from "@/lib/attachments";
import { isImageAttachment } from "@/lib/attachments";
import { cn } from "@/lib/utils";

export interface V0ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  attachments?: ChatAttachment[];
  onAttachFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
}

export function V0ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming = false,
  disabled = false,
  placeholder = "Ask a follow-up...",
  attachments = [],
  onAttachFiles,
  onRemoveAttachment,
}: V0ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (disabled || isStreaming) return;
      if (!value.trim()) return;
      onSubmit();
    },
    [disabled, isStreaming, onSubmit, value],
  );

  const pickFiles = useCallback((list: FileList | null) => {
    if (!list || list.length === 0 || !onAttachFiles) return;
    onAttachFiles(Array.from(list));
  }, [onAttachFiles]);

  return (
    <form
      onSubmit={handleSubmit}
      onDragOver={(e) => {
        if (!onAttachFiles) return;
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        if (!onAttachFiles) return;
        e.preventDefault();
        setDragActive(false);
        pickFiles(e.dataTransfer.files);
      }}
      className={cn(
        "rounded-xl border border-zinc-800 bg-zinc-900 p-2 text-sm",
        "focus-within:border-zinc-700",
        dragActive && "border-zinc-500 ring-1 ring-zinc-500",
      )}
    >
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-1 pb-2">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="inline-flex max-w-[180px] items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-200"
              title={a.name}
            >
              {isImageAttachment(a) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`data:${a.mimeType};base64,${a.data}`}
                  alt=""
                  className="size-4 shrink-0 rounded-sm object-cover"
                />
              ) : (
                <Paperclip className="size-3 shrink-0 text-zinc-400" />
              )}
              <span className="truncate">{a.name}</span>
              {onRemoveAttachment ? (
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(a.id)}
                  className="shrink-0 text-zinc-500 transition hover:text-zinc-200"
                  aria-label={`Remove ${a.name}`}
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
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
        onPaste={(e) => {
          if (!onAttachFiles) return;
          const files = Array.from(e.clipboardData.files);
          if (files.length > 0) {
            e.preventDefault();
            onAttachFiles(files);
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
          {onAttachFiles ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  pickFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                aria-label="Attach files"
                title="Attach files"
              >
                <Paperclip className="size-4" />
              </button>
            </>
          ) : null}
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

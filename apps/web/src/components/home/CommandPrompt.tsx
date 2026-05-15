"use client";

import {
  BookOpen,
  Plus,
  UserRound,
  Youtube,
  Zap,
  SendHorizontal
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export type CommandPromptChip = {
  id: string;
  label: string;
  icon: React.ElementType;
};

const DEFAULT_CHIPS: CommandPromptChip[] = [
  { id: "advice", label: "Any advice for me?", icon: UserRound },
  { id: "youtube", label: "Some youtube video idea", icon: Youtube },
  { id: "kratos", label: "Life lessons from kratos", icon: BookOpen },
];

export type CommandPromptProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  chips?: CommandPromptChip[];
  onChipClick?: (chip: CommandPromptChip) => void;
  onMoreClick?: () => void;
  leadingHeader?: ReactNode;
  trailingHeader?: ReactNode;
  className?: string;
};

/**
 * Premium dark-mode command/search prompt.
 *
 * Design tokens:
 *   bg-canvas:     #0E0E10
 *   bg-surface:    #18181B (wrapper)
 *   bg-input:      #121215 (input area)
 *   border:        #27272A
 *   text-primary:  #F4F4F5
 *   text-muted:    #A1A1AA
 *   status-green:  #4ADE80
 *
 * The input box has a subtle top-edge radial gradient highlight that
 * brightens on focus.
 */
export function CommandPrompt({
  value,
  onChange,
  onSubmit,
  placeholder = "Ask anything ...",
  disabled = false,
  chips: _chips = DEFAULT_CHIPS,
  onChipClick: _onChipClick,
  onMoreClick: _onMoreClick,
  leadingHeader,
  trailingHeader,
  className,
}: CommandPromptProps) {
  const [isFocused, setIsFocused] = useState(false);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !disabled;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit?.(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      className={cn(
        // Wrapper: bg-surface, border, radius 16, padding 16, flex column gap 16.
        "flex w-full flex-col gap-4 rounded-2xl border p-4",
        "border-[#27272A] bg-[#18181B]",
        "font-[Inter,system-ui,'SF_Pro_Display','Helvetica_Neue',sans-serif]",
        className,
      )}
    >
      {/* Top header row */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2 text-[14px] font-normal text-[#A1A1AA]">
          {leadingHeader ?? (
            <>
              <Zap
                className="size-[14px] shrink-0 fill-[#A1A1AA] text-[#A1A1AA]"
                aria-hidden
              />
              <span className="truncate">
                More features are coming up.
              </span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[14px] font-normal text-[#A1A1AA]">
          {trailingHeader ?? (
            <>
              <span
                aria-hidden
                className="cmd-status-dot relative inline-block size-[8px] rounded-full bg-[#4ADE80]"
              />
              <span>Active</span>
            </>
          )}
        </div>
      </div>

      {/* Input field box */}
      <div
        className={cn(
          "cmd-input-box relative flex items-center gap-3 rounded-xl",
          "bg-[#121215]",
          "px-4 py-3 transition-all duration-200 ease-out",
          isFocused && "cmd-input-box--focused",
        )}
      >
        <button
          type="button"
          aria-label="Add attachment"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[#A1A1AA] transition-colors duration-150 hover:text-[#F4F4F5]"
        >
          <Plus className="size-[18px]" strokeWidth={1.75} />
        </button>

        <input
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={placeholder}
          aria-label="Prompt"
          className={cn(
            "min-w-0 flex-1 bg-transparent text-[14px] font-medium text-[#F4F4F5]",
            "placeholder:font-normal placeholder:text-[#A1A1AA]",
            "outline-none ring-0 focus:outline-none focus:ring-0",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />

        <button
          type="button"
          aria-label="Send"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
            canSubmit
              ? "text-[#A1A1AA] hover:text-[#F4F4F5]"
              : "cursor-not-allowed text-[#52525B] opacity-60 hover:text-[#52525B]",
          )}
        >
          <SendHorizontal className="size-[18px]" strokeWidth={1.75} />
        </button>
      </div>
      
      <style jsx>{`
        /* Hide scrollbar on chip overflow */
        .cmd-chip-row {
          scrollbar-width: none;
          -ms-overflow-style: none;
        }
        .cmd-chip-row::-webkit-scrollbar {
          display: none;
        }

        /* Subtle status-dot pulse */
        .cmd-status-dot {
          box-shadow: 0 0 8px 0 rgba(74, 222, 128, 0.55);
          animation: cmd-dot-pulse 2.4s ease-in-out infinite;
        }
        @keyframes cmd-dot-pulse {
          0%,
          100% {
            opacity: 0.6;
          }
          50% {
            opacity: 1;
          }
        }

        /* Top-edge radial glow on the input box */
        .cmd-input-box::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          padding: 1px;
          background: radial-gradient(
            120% 200% at 50% -20%,
            rgba(255, 255, 255, 0.18) 0%,
            rgba(255, 255, 255, 0.06) 22%,
            rgba(255, 255, 255, 0) 55%
          );
          -webkit-mask:
            linear-gradient(#fff 0 0) content-box,
            linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          pointer-events: none;
          transition: opacity 200ms ease-out;
        }
        .cmd-input-box::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: radial-gradient(
            80% 120% at 50% -40%,
            rgba(255, 255, 255, 0.08) 0%,
            rgba(255, 255, 255, 0.02) 35%,
            rgba(255, 255, 255, 0) 65%
          );
          pointer-events: none;
          transition: opacity 200ms ease-out;
        }
        .cmd-input-box--focused::before {
          background: radial-gradient(
            120% 200% at 50% -20%,
            rgba(255, 255, 255, 0.28) 0%,
            rgba(255, 255, 255, 0.1) 22%,
            rgba(255, 255, 255, 0) 55%
          );
        }
        .cmd-input-box--focused::after {
          background: radial-gradient(
            80% 120% at 50% -40%,
            rgba(255, 255, 255, 0.14) 0%,
            rgba(255, 255, 255, 0.04) 35%,
            rgba(255, 255, 255, 0) 65%
          );
        }

        @media (prefers-reduced-motion: reduce) {
          .cmd-status-dot {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

"use client";

import { IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { Harness } from "@/lib/types";

interface TopbarProps {
  harness: Harness;
  modelOpen: boolean;
  onToggleModel: (e: React.MouseEvent) => void;
  onSetHarness: (h: Harness) => void;
}

const OPTIONS: { value: Harness; label: string; sub: string }[] = [
  { value: "claude", label: "Claude Code", sub: "claude CLI · stream-json" },
  { value: "codex", label: "Codex", sub: "codex CLI · proto" },
];

export function Topbar({
  harness,
  modelOpen,
  onToggleModel,
  onSetHarness,
}: TopbarProps) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2.5 px-5">
      <div className="relative">
        <button
          onClick={onToggleModel}
          className="inline-flex items-center gap-[7px] rounded-[9px] px-2.5 py-1.5 text-sm font-semibold text-ink-soft hover:bg-sidebar-hover"
        >
          <span>{harness === "claude" ? "Claude" : "Codex"}</span>
          <IconChevronDown className="h-4 w-4 text-ink-faint" />
        </button>
        {modelOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute left-0 top-[46px] z-20 min-w-[220px] rounded-xl border border-line-strong bg-surface p-1.5 shadow-soft"
          >
            {OPTIONS.map((o) => (
              <div
                key={o.value}
                onClick={() => onSetHarness(o.value)}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[9px] text-sm hover:bg-sidebar-hover"
              >
                <div>
                  <div>{o.label}</div>
                  <div className="text-xs text-ink-faint">{o.sub}</div>
                </div>
                <span
                  className={cn(
                    "ml-auto text-accent",
                    harness === o.value ? "opacity-100" : "opacity-0",
                  )}
                >
                  ✓
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1" />
    </div>
  );
}

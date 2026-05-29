"use client";

import { Code2, Eye, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";

export type WorkspaceTab = "preview" | "code" | "database";

export interface EditorTopBarProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  urlText?: string;
  onTerminalToggle?: () => void;
  onRefresh?: () => void;
}

function SegmentButton({
  active,
  onClick,
  children,
  label,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md transition",
        active
          ? "bg-zinc-800 text-zinc-50"
          : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-50",
      )}
    >
      {children}
    </button>
  );
}

export function EditorTopBar({
  activeTab,
  onTabChange,
  urlText = "/",
  onTerminalToggle: _onTerminalToggle,
  onRefresh,
}: EditorTopBarProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-[#0E0E11] p-[25px]">
      <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
        <SegmentButton
          active={activeTab === "preview"}
          onClick={() => onTabChange("preview")}
          label="Preview"
        >
          <Eye className="size-3.5" />
        </SegmentButton>
        <SegmentButton
          active={activeTab === "code"}
          onClick={() => onTabChange("code")}
          label="Code"
        >
          <Code2 className="size-3.5" />
        </SegmentButton>
      </div>

      {activeTab === "preview" ? (
        <div className="flex min-w-0 flex-1 items-center gap-1 px-1">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-400">
            <span className="flex size-3.5 items-center justify-center rounded-sm bg-zinc-800 font-black text-[8px] text-zinc-50">
              MC
            </span>
            <span className="truncate font-mono">{urlText}</span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex size-6 items-center justify-center rounded text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-50"
            aria-label="Refresh preview"
            title="Refresh"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}

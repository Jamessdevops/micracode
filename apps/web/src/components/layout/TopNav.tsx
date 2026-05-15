"use client";

import { Code2, Download } from "lucide-react";
import Link from "next/link";

import { getProjectDownloadUrl } from "@/lib/api/projects";
import { cn } from "@/lib/utils";

export interface TopNavProps {
  projectId: string;
  projectName?: string;
  onPublish?: () => void;
}

function _Avatar({ className, initials = "JM" }: { className?: string; initials?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-orange-400 text-[10px] font-semibold text-black ring-1 ring-zinc-800",
        className,
      )}
      aria-hidden
    >
      {initials}
    </span>
  );
}

export function TopNav({ projectId, projectName, onPublish }: TopNavProps) {
  const _display = projectName?.trim() || projectId;

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-zinc-800 bg-black px-3 text-sm text-zinc-50">
      <div className="flex items-center gap-2">
        <Link
          href="/"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-zinc-50 text-black transition hover:opacity-90"
          aria-label="Home"
          title="Micracode"
        >
          <span className="font-black leading-none tracking-tighter">MC</span>
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <a
          href={getProjectDownloadUrl(projectId)}
          download
          onClick={onPublish}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-50 px-3 text-sm font-medium text-black transition hover:bg-white"
        >
          <Download className="size-4" />
          Download
        </a>
        {/* <Avatar className="ml-1 size-7" /> */}
      </div>
    </header>
  );
}

// Kept so sibling components can reuse the glyph in watermarks / buttons.
export function V0Glyph({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-md bg-zinc-50 text-black",
        className,
      )}
      aria-hidden
    >
      <Code2 className="size-3.5" strokeWidth={2.5} />
    </span>
  );
}

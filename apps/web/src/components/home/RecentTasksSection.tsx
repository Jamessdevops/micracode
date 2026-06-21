"use client";

import { ClipboardList, Globe2, MoreHorizontal, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ApiError, listProjects, type ProjectRecord } from "@/lib/api/projects";
import { cn } from "@/lib/utils";

type Tab = "recent" | "deployed";

export interface RecentTasksSectionProps {
  className?: string;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} ${day === 1 ? "day" : "days"} ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo} ${mo === 1 ? "month" : "months"} ago`;
  const yr = Math.round(mo / 12);
  return `${yr} ${yr === 1 ? "year" : "years"} ago`;
}

function shortId(id: string): string {
  const stripped = id.replace(/[^a-z0-9]/gi, "");
  return `EMT - ${stripped.slice(0, 6) || id.slice(0, 6)}`;
}

export function RecentTasksSection({ className }: RecentTasksSectionProps) {
  const [tab, setTab] = useState<Tab>("recent");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchProjects = () => {
    setIsRefreshing(true);
    listProjects()
      .then((data) => {
        setProjects(data);
        setError(null);
      })
      .catch((err) => {
        const msg =
          err instanceof ApiError
            ? `API error (${err.status}). Is the server running?`
            : err instanceof Error
              ? `API unreachable: ${err.message}`
              : "Unknown error loading projects";
        setError(msg);
      })
      .finally(() => setIsRefreshing(false));
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  return (
    <section className={cn("flex w-full flex-col", className)}>
      <div className="flex items-center justify-between border-b border-[#1b1b1e] pb-3">
        <div className="flex items-center gap-3 text-sm font-medium">
          <button
            type="button"
            onClick={() => setTab("recent")}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-1 py-1 transition-all duration-200 ease-in-out",
              tab === "recent" ? "text-white" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            <ClipboardList className="size-4" />
            Recent Tasks
          </button>
          <span className="text-zinc-700">|</span>
          <button
            type="button"
            onClick={() => setTab("deployed")}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-1 py-1 transition-all duration-200 ease-in-out",
              tab === "deployed" ? "text-white" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            <Globe2 className="size-4" />
            Deployed Apps
          </button>
        </div>
        <button
          type="button"
          onClick={fetchProjects}
          className="inline-flex size-8 items-center justify-center rounded-md text-zinc-400 transition-all duration-200 ease-in-out hover:bg-[#1b1b1e] hover:text-white"
          aria-label="Refresh"
        >
          <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} />
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      ) : tab === "recent" ? (
        <RecentTable projects={projects} />
      ) : (
        <EmptyState
          title="No deployed apps yet"
          description="Apps you deploy will show up here."
        />
      )}
    </section>
  );
}

function RecentTable({ projects }: { projects: ProjectRecord[] }) {
  if (projects.length === 0) {
    return (
      <EmptyState
        title="No tasks yet"
        description="Start a new project above and it will appear here."
      />
    );
  }

  return (
    <div className="mt-2">
      <div className="grid grid-cols-[140px_1fr_200px_40px] items-center gap-4 border-b border-[#1b1b1e] px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        <span>ID</span>
        <span>Task</span>
        <span>Last Modified</span>
        <span />
      </div>
      <ul className="flex flex-col">
        {projects.map((p) => (
          <li key={p.id} className="group relative">
            <Link
              href={{ pathname: "/projects", query: { id: p.id } }}
              className="grid grid-cols-[140px_1fr_200px_40px] items-center gap-4 rounded-md px-4 py-4 text-sm transition-all duration-200 ease-in-out hover:bg-[#1b1b1e]"
            >
              <span className="font-mono text-xs text-zinc-400">
                {shortId(p.id)}
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate font-medium text-white">{p.name}</span>
                <span className="truncate text-xs text-zinc-500">
                  {p.template || "Generated project"}
                </span>
              </span>
              <RelativeTime
                iso={p.updated_at}
                className="text-sm text-zinc-400"
              />
              <span className="flex justify-end">
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="More options"
                  className="inline-flex size-8 items-center justify-center rounded-md text-zinc-500 transition-all duration-200 ease-in-out hover:bg-zinc-800 hover:text-white"
                  onClick={(e) => e.preventDefault()}
                >
                  <MoreHorizontal className="size-4" />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const [text, setText] = useState<string>("");
  useEffect(() => {
    setText(formatRelative(iso));
    const id = setInterval(() => setText(formatRelative(iso)), 30_000);
    return () => clearInterval(id);
  }, [iso]);
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-dashed border-[#333336] bg-[#1b1b1e]/40 px-6 py-12 text-center">
      <p className="text-sm font-medium text-white">{title}</p>
      <p className="mt-1 text-xs text-zinc-400">{description}</p>
    </div>
  );
}

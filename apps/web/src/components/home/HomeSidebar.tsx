"use client";

import {
  Bell,
  ChevronDown,
  Folder,
  Home,
  Search,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type NavItem = { label: string; href: Route; icon: LucideIcon };

const TOP_NAV: NavItem[] = [{ label: "Home", href: "/", icon: Home }];

const WORKSPACE_NAV: NavItem[] = [
  { label: "Projects", href: "/projects", icon: Folder },
  { label: "Settings", href: "/settings", icon: Settings },
];

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors duration-150",
        active
          ? "bg-[#1b1b1e] text-[#45f4ff]"
          : "text-zinc-400 hover:bg-[#1b1b1e] hover:text-white",
      )}
    >
      <Icon className="size-4" strokeWidth={2} />
      <span>{item.label}</span>
    </Link>
  );
}

export function HomeSidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-[#1b1b1e] bg-[#0e0e11] px-3 py-4 text-white">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
        <input
          type="text"
          placeholder="Search"
          className="w-full rounded-lg border border-[#1b1b1e] bg-[#141417] py-2 pl-8 pr-12 text-sm text-white placeholder:text-zinc-500 focus:border-[#45f4ff] focus:outline-none"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-[#26262b] px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          ⌘K
        </kbd>
      </div>

      <nav className="mt-4 flex flex-col gap-0.5">
        {TOP_NAV.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={pathname === item.href}
          />
        ))}
      </nav>

      <div className="mt-6">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-[#1b1b1e]"
        >
          <span className="inline-flex size-6 items-center justify-center rounded-md bg-[#1b1b1e] text-xs font-semibold text-zinc-300">
            J
          </span>
          <span className="flex-1 text-left">James&apos;s workspace</span>
          <ChevronDown className="size-4 text-zinc-500" />
        </button>

        <nav className="mt-1 flex flex-col gap-0.5">
          {WORKSPACE_NAV.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={pathname.startsWith(item.href)}
            />
          ))}
        </nav>
      </div>

      <div className="mt-auto flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-green-600 text-sm font-semibold text-black"
            aria-hidden
          >
            J
          </span>
          <span className="text-sm font-medium text-white">James</span>
          <span className="rounded border border-[#26262b] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
            Free
          </span>
        </div>
        <button
          type="button"
          className="inline-flex size-9 items-center justify-center rounded-full bg-[#45f4ff] text-black transition-opacity duration-150 hover:opacity-90"
          aria-label="Notifications"
        >
          <Bell className="size-4" strokeWidth={2.25} />
        </button>
      </div>
    </aside>
  );
}

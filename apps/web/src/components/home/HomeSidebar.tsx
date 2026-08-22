"use client";

import { Home, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Route } from "next";
import type { LucideIcon } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

type NavItem = { label: string; href: Route; icon: LucideIcon };

const TOP_NAV: NavItem[] = [{ label: "Home", href: "/", icon: Home }];

const WORKSPACE_NAV: NavItem[] = [
  { label: "Settings", href: "/settings", icon: Settings },
];

function NavMenu({ items, exact }: { items: NavItem[]; exact?: boolean }) {
  const pathname = usePathname();
  return (
    <SidebarMenu>
      {items.map((item) => {
        const active = exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        return (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton
              asChild
              isActive={active}
              tooltip={item.label}
              className={cn(active && "text-[#45f4ff]")}
            >
              <Link href={item.href}>
                <item.icon />
                <span>{item.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function HomeSidebar() {
  // Desktop shell uses a hiddenInset title bar — leave room for the macOS
  // traffic lights so they don't overlap the first nav item.
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    setDesktop(!!window.__MICRACODE_DESKTOP__);
  }, []);

  return (
    <Sidebar collapsible="icon">
      <SidebarContent className={desktop ? "pt-7" : undefined}>
        <SidebarGroup>
          <SidebarGroupContent>
            <NavMenu items={TOP_NAV} exact />
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <NavMenu items={WORKSPACE_NAV} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}

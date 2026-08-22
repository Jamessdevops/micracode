"use client";

import { HeroComposer } from "@/components/home/HeroComposer";
import { HomeSidebar } from "@/components/home/HomeSidebar";
import { RecentTasksSection } from "@/components/home/RecentTasksSection";
import { WelcomeModal } from "@/components/home/WelcomeModal";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { isDesktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";

export default function HomePage() {
  return (
    <SidebarProvider>
      <WelcomeModal />
      <HomeSidebar />
      <SidebarInset className="bg-[#0e0e11] text-white">
        <SidebarTrigger
          className={cn(
            "m-2 text-zinc-400 hover:text-white",
            // Clear the macOS traffic lights when the sidebar is collapsed.
            isDesktop() && "mt-7",
          )}
        />
        <main className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 pb-24 pt-6">
          <HeroComposer className="mt-16" />
          <RecentTasksSection className="mt-20" />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

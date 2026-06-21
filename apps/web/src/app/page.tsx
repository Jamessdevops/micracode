"use client";

import { CheckpointsPanel } from "@/components/home/CheckpointsPanel";
import { EngineConsole } from "@/components/home/EngineConsole";
import { HarnessLauncher } from "@/components/home/HarnessLauncher";
import { HeroComposer } from "@/components/home/HeroComposer";
import { RecentTasksSection } from "@/components/home/RecentTasksSection";
import { ThreadsPanel } from "@/components/home/ThreadsPanel";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[#0e0e11] text-white">
      <main className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 pb-24 pt-6">
        <HeroComposer className="mt-16" />
        <EngineConsole className="mt-16" />
        <HarnessLauncher className="mt-8" />
        <ThreadsPanel className="mt-8" />
        <CheckpointsPanel className="mt-8" />
        <RecentTasksSection className="mt-20" />
      </main>
    </div>
  );
}

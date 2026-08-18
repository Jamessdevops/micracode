"use client";

import { HeroComposer } from "@/components/home/HeroComposer";
import { HomeSidebar } from "@/components/home/HomeSidebar";
import { RecentTasksSection } from "@/components/home/RecentTasksSection";

export default function HomePage() {
  return (
    <div className="flex min-h-screen bg-[#0e0e11] text-white">
      <HomeSidebar />
      <main className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 pb-24 pt-6">
        <HeroComposer className="mt-16" />
        <RecentTasksSection className="mt-20" />
      </main>
    </div>
  );
}

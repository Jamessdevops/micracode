import { HeroComposer } from "@/components/home/HeroComposer";
import { RecentTasksSection } from "@/components/home/RecentTasksSection";
import { ApiError, listProjects, type ProjectRecord } from "@/lib/api/projects";

export const dynamic = "force-dynamic";

async function loadProjects(): Promise<
  { projects: ProjectRecord[]; error: string | null }
> {
  try {
    const projects = await listProjects();
    return { projects, error: null };
  } catch (err) {
    const msg =
      err instanceof ApiError
        ? `API error (${err.status}). Is \`bun run dev:api\` running?`
        : err instanceof Error
          ? `API unreachable: ${err.message}`
          : "Unknown error loading projects";
    return { projects: [], error: msg };
  }
}

export default async function HomePage() {
  const { projects, error } = await loadProjects();

  return (
    <div className="min-h-screen bg-[#0e0e11] text-white">
      {/* <HomeTopNav /> */}
      <main className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 pb-24 pt-6">
        {/* <PromoBanner /> */}
        <HeroComposer className="mt-16" />
        {/* <FeatureChips className="mt-6" /> */}
        <RecentTasksSection
          projects={projects}
          error={error}
          className="mt-20"
        />
      </main>
    </div>
  );
}

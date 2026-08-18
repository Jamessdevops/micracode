"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import {
  getProject,
  getProjectFiles,
  getProjectPrompts,
  type ProjectRecord,
  type PromptRecord,
} from "@/lib/api/projects";
import type { FileSystemTree } from "@micracode/shared";

interface Loaded {
  project: ProjectRecord;
  tree: FileSystemTree;
  prompts: PromptRecord[];
}

function ProjectWorkspace() {
  const params = useSearchParams();
  const id = params.get("id");
  const initialPrompt = params.get("prompt") ?? undefined;

  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    Promise.all([getProject(id), getProjectFiles(id), getProjectPrompts(id)])
      .then(([project, files, prompts]) => {
        if (!cancelled) setData({ project, tree: files.tree, prompts });
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) return <Centered>No project id in URL.</Centered>;
  if (error) return <Centered>Failed to load project: {error}</Centered>;
  if (!data) return <Centered>Loading project…</Centered>;

  return (
    <WorkspaceShell
      projectId={data.project.id}
      projectName={data.project.name}
      initialTree={data.tree}
      initialPrompts={data.prompts}
      initialPrompt={initialPrompt}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-black text-sm text-zinc-400">
      {children}
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<Centered>Loading…</Centered>}>
      <ProjectWorkspace />
    </Suspense>
  );
}

/**
 * Typed fetch client for the project CRUD + hydration endpoints.
 *
 * Works on both the server (React Server Components) and the client:
 * callers just need to pass `cache: "no-store"` from RSCs when they
 * want fresh data on every render.
 */

import type { FileSystemTree } from "@micracode/shared";

import { env } from "@/lib/env";

export type PromptRole = "user" | "assistant" | "system" | "tool";

export interface ProjectRecord {
  id: string;
  name: string;
  template: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectBody {
  name: string;
  template?: string;
}

export interface PromptRecord {
  id: string;
  role: PromptRole;
  content: string;
  created_at: string;
  snapshot_id?: string | null;
}

export interface SnapshotRecord {
  id: string;
  created_at: string;
  user_prompt: string;
  kind: "pre-turn";
}

export interface ProjectFilesResponse {
  tree: FileSystemTree;
}

export interface UpdateProjectFileBody {
  path: string;
  content: string;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Next.js `cache` + `next.revalidate` options. */
  next?: { revalidate?: number | false; tags?: string[] };
  cache?: RequestCache;
}

function baseUrl(opts?: ApiClientOptions): string {
  return opts?.baseUrl ?? env.API_BASE_URL;
}

async function request<T>(
  path: string,
  init: RequestInit & { next?: { revalidate?: number | false; tags?: string[] } },
  opts?: ApiClientOptions,
): Promise<T> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl(opts)}${path}`, {
    ...init,
    cache: opts?.cache ?? init.cache ?? "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(
      `${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`,
      res.status,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function listProjects(opts?: ApiClientOptions): Promise<ProjectRecord[]> {
  return request<ProjectRecord[]>("/v1/projects", { method: "GET" }, opts);
}

export function createProject(
  body: CreateProjectBody,
  opts?: ApiClientOptions,
): Promise<ProjectRecord> {
  return request<ProjectRecord>(
    "/v1/projects",
    { method: "POST", body: JSON.stringify(body) },
    opts,
  );
}

export function getProject(
  id: string,
  opts?: ApiClientOptions,
): Promise<ProjectRecord> {
  return request<ProjectRecord>(
    `/v1/projects/${encodeURIComponent(id)}`,
    { method: "GET" },
    opts,
  );
}

export async function deleteProject(
  id: string,
  opts?: ApiClientOptions,
): Promise<void> {
  await request<void>(
    `/v1/projects/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    opts,
  );
}

export function getProjectFiles(
  id: string,
  opts?: ApiClientOptions,
): Promise<ProjectFilesResponse> {
  return request<ProjectFilesResponse>(
    `/v1/projects/${encodeURIComponent(id)}/files`,
    { method: "GET" },
    opts,
  );
}

export function updateProjectFile(
  id: string,
  body: UpdateProjectFileBody,
  opts?: ApiClientOptions,
): Promise<void> {
  return request<void>(
    `/v1/projects/${encodeURIComponent(id)}/files`,
    { method: "PUT", body: JSON.stringify(body) },
    opts,
  );
}

export function getProjectDownloadUrl(
  id: string,
  opts?: ApiClientOptions,
): string {
  return `${baseUrl(opts)}/v1/projects/${encodeURIComponent(id)}/download`;
}

export function getProjectPrompts(
  id: string,
  opts?: ApiClientOptions,
): Promise<PromptRecord[]> {
  return request<PromptRecord[]>(
    `/v1/projects/${encodeURIComponent(id)}/prompts`,
    { method: "GET" },
    opts,
  );
}

export function popLastAssistantPrompt(
  id: string,
  opts?: ApiClientOptions,
): Promise<{ popped: boolean }> {
  return request<{ popped: boolean }>(
    `/v1/projects/${encodeURIComponent(id)}/prompts/pop-assistant`,
    { method: "POST" },
    opts,
  );
}

export function listSnapshots(
  id: string,
  opts?: ApiClientOptions,
): Promise<SnapshotRecord[]> {
  return request<SnapshotRecord[]>(
    `/v1/projects/${encodeURIComponent(id)}/snapshots`,
    { method: "GET" },
    opts,
  );
}

export async function restoreSnapshot(
  id: string,
  snapshotId: string,
  opts?: ApiClientOptions,
): Promise<void> {
  await request<void>(
    `/v1/projects/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    { method: "POST" },
    opts,
  );
}

export async function deleteSnapshot(
  id: string,
  snapshotId: string,
  opts?: ApiClientOptions,
): Promise<void> {
  await request<void>(
    `/v1/projects/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}`,
    { method: "DELETE" },
    opts,
  );
}

/**
 * Answer a clarifying `question` tool call that the generation stream is
 * currently blocked on. `requestId` is carried on the `tool-question`
 * data part; the backend resumes the tool loop once the answer arrives.
 */
export async function answerQuestion(
  requestId: string,
  toolCallId: string,
  answer: string,
  opts?: ApiClientOptions,
): Promise<void> {
  await request<void>(
    `/v1/generate/${encodeURIComponent(requestId)}/question/${encodeURIComponent(toolCallId)}/answer`,
    { method: "POST", body: JSON.stringify({ answer }) },
    opts,
  );
}

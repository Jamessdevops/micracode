/**
 * Workspace VCS client (`/v1/projects/{id}/vcs`, `/checkpoints`): per-turn
 * snapshots of a project's working tree, their diffs, and reverts.
 */

import { type ApiClientOptions, request } from "./projects";
import type { Checkpoint } from "./generated/Checkpoint";
import type { FileChange } from "./generated/FileChange";
import type { VcsStatus } from "./generated/VcsStatus";

export type { Checkpoint, FileChange, VcsStatus };

const base = (projectId: string) =>
  `/v1/projects/${encodeURIComponent(projectId)}`;

export function getVcsStatus(
  projectId: string,
  opts?: ApiClientOptions,
): Promise<VcsStatus> {
  return request<VcsStatus>(`${base(projectId)}/vcs/status`, { method: "GET" }, opts);
}

export function getVcsDiff(
  projectId: string,
  opts?: ApiClientOptions,
): Promise<{ diff: string }> {
  return request<{ diff: string }>(`${base(projectId)}/vcs/diff`, { method: "GET" }, opts);
}

export function listCheckpoints(
  projectId: string,
  opts?: ApiClientOptions,
): Promise<Checkpoint[]> {
  return request<Checkpoint[]>(`${base(projectId)}/checkpoints`, { method: "GET" }, opts);
}

export function captureCheckpoint(
  projectId: string,
  label = "manual",
  opts?: ApiClientOptions,
): Promise<Checkpoint> {
  return request<Checkpoint>(
    `${base(projectId)}/checkpoints`,
    { method: "POST", body: JSON.stringify({ label }) },
    opts,
  );
}

export function getCheckpointDiff(
  projectId: string,
  checkpointId: string,
  opts?: ApiClientOptions,
): Promise<{ diff: string }> {
  return request<{ diff: string }>(
    `${base(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/diff`,
    { method: "GET" },
    opts,
  );
}

export function revertCheckpoint(
  projectId: string,
  checkpointId: string,
  opts?: ApiClientOptions,
): Promise<unknown> {
  return request<unknown>(
    `${base(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/revert`,
    { method: "POST", body: "{}" },
    opts,
  );
}

export function suggestCommitMessage(
  projectId: string,
  opts?: ApiClientOptions,
): Promise<{ message: string }> {
  return request<{ message: string }>(
    `${base(projectId)}/vcs/commit-message`,
    { method: "POST", body: "{}" },
    opts,
  );
}

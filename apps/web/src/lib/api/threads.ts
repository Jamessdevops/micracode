/**
 * Thread projection client (`/v1/threads`): conversation threads rebuilt from
 * the event log, for list views and transcripts.
 */

import { type ApiClientOptions, request } from "./projects";
import type { Message } from "./generated/Message";
import type { Thread } from "./generated/Thread";
import type { ThreadStatus } from "./generated/ThreadStatus";
import type { ThreadSummary } from "./generated/ThreadSummary";
import type { Turn } from "./generated/Turn";

export type { Message, Thread, ThreadStatus, ThreadSummary, Turn };

export function listThreads(opts?: ApiClientOptions): Promise<ThreadSummary[]> {
  return request<ThreadSummary[]>("/v1/threads", { method: "GET" }, opts);
}

export function getThread(
  threadId: string,
  opts?: ApiClientOptions,
): Promise<Thread> {
  return request<Thread>(
    `/v1/threads/${encodeURIComponent(threadId)}`,
    { method: "GET" },
    opts,
  );
}

export function deleteThread(
  threadId: string,
  opts?: ApiClientOptions,
): Promise<void> {
  return request<void>(
    `/v1/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
    opts,
  );
}

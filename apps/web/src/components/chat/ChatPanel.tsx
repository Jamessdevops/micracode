"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { History, RefreshCw, Send, Square } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PanelShell } from "@/components/layout/PanelShell";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";
import {
  getProjectFiles,
  popLastAssistantPrompt,
  restoreSnapshot,
} from "@/lib/api/projects";
import {
  messageText,
  type MicracodeUIMessage,
} from "@/lib/api/uiMessage";
import { cn } from "@/lib/utils";
import { useFileSystemStore } from "@/store/fileSystemStore";
import { usePendingPromptStore } from "@/store/pendingPromptStore";
import { usePreviewStore } from "@/store/previewStore";

export interface ChatPanelProps {
  projectId: string;
  initialMessages?: MicracodeUIMessage[];
  initialPrompt?: string;
  hasInitialHistory?: boolean;
}

/**
 * Module-scoped guard: remembers which project ids already had their
 * initial prompt auto-submitted in this browser tab. A module-level Set
 * survives React 18 dev Strict Mode's mount/unmount/mount cycle, so the
 * bootstrap prompt is only sent exactly once per page load.
 */
const autoSubmittedProjectIds = new Set<string>();

type Stage = "idle" | "planning" | "generating" | "done" | "cancelled" | "plan_ready";

export function ChatPanel({
  projectId,
  initialMessages,
  initialPrompt,
  hasInitialHistory = false,
}: ChatPanelProps) {
  const pathname = usePathname();
  const [draft, setDraft] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [isReverting, setIsReverting] = useState<string | null>(null);
  // `retry=true` tells the backend to skip re-appending the user prompt
  // (it's already on disk). We keep it in a ref so the transport body
  // builder — which closes over stable state — can read the latest value
  // without re-creating the transport on every click.
  const retryFlagRef = useRef(false);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<MicracodeUIMessage>({
        api: `${env.API_BASE_URL}/v1/generate`,
        // `useChat` sends the entire message history on every turn; the
        // `/v1/generate` endpoint only needs `project_id` + the current
        // prompt (it rereads prior turns from disk), so we flatten here.
        prepareSendMessagesRequest: ({ messages }) => {
          const lastUser = [...messages]
            .reverse()
            .find((m) => m.role === "user");
          const prompt = lastUser ? messageText(lastUser) : "";
          const retry = retryFlagRef.current;
          retryFlagRef.current = false;
          return {
            body: { project_id: projectId, prompt, retry },
          };
        },
      }),
    [projectId],
  );

  const { messages, setMessages, sendMessage, status, error, stop } =
    useChat<MicracodeUIMessage>({
      id: projectId,
      messages: initialMessages,
      transport,
      onData: (part) => {
        // `onData` fires for every `data-*` frame, including transient
        // ones that don't get appended to `message.parts`. We route
        // side-effect frames (file writes, shell commands, status) into
        // the appropriate Zustand stores so the editor / preview / stage
        // indicator update live.
        switch (part.type) {
          case "data-file-write":
            useFileSystemStore
              .getState()
              .upsertFile(part.data.path, part.data.content);
            break;
          case "data-file-delete":
            useFileSystemStore.getState().deleteFile(part.data.path);
            break;
          case "data-shell-exec":
            usePreviewStore
              .getState()
              .enqueueShell(part.data.command, part.data.cwd ?? undefined);
            break;
          case "data-status":
            setStage(part.data.stage);
            if (part.data.snapshot_id) {
              // The orchestrator emits this right before the first file
              // op of the turn; tag the latest assistant message so the
              // "Revert to before this message" action knows what to
              // restore.
              const snapshotId = part.data.snapshot_id;
              setMessages((prev) => {
                const next = [...prev];
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].role === "assistant") {
                    next[i] = {
                      ...next[i],
                      metadata: {
                        ...(next[i].metadata ?? {}),
                        snapshot_id: snapshotId,
                      },
                    };
                    break;
                  }
                }
                return next;
              });
            }
            break;
        }
      },
      onFinish: () => {
        setStage("idle");
      },
      onError: () => {
        setStage("idle");
      },
    });

  const isStreaming = status === "submitted" || status === "streaming";

  useEffect(() => {
    const trimmed = initialPrompt?.trim();
    if (!trimmed || hasInitialHistory) return;
    if (autoSubmittedProjectIds.has(projectId)) return;
    autoSubmittedProjectIds.add(projectId);

    // Strip the bootstrap prompt from the URL without triggering a
    // Next.js navigation, otherwise the route transition would abort the
    // in-flight stream.
    if (typeof window !== "undefined") {
      const nextUrl = `${pathname}${window.location.hash}`;
      window.history.replaceState(window.history.state, "", nextUrl);
    }

    void sendMessage({ text: trimmed });
  }, [hasInitialHistory, initialPrompt, pathname, projectId, sendMessage]);

  // Pump prompts dispatched from elsewhere (e.g. the preview panel's
  // "Fix with AI" button) into this chat instance.
  const pendingPrompt = usePendingPromptStore((s) => s.pending);
  const clearPending = usePendingPromptStore((s) => s.clearPending);
  useEffect(() => {
    if (!pendingPrompt || isStreaming) return;
    clearPending();
    void sendMessage({ text: pendingPrompt });
  }, [pendingPrompt, isStreaming, clearPending, sendMessage]);

  const onSend = async () => {
    if (!draft.trim() || isStreaming) return;
    const prompt = draft;
    setDraft("");
    await sendMessage({ text: prompt });
  };

  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messageText(messages[i]);
    }
    return "";
  }, [messages]);

  const onRetry = useCallback(async () => {
    if (isStreaming || !lastUserText) return;
    try {
      await popLastAssistantPrompt(projectId);
    } catch {
      // Non-fatal: the retry still goes through, we just might end up
      // with a duplicate assistant row in history.
    }
    // Drop the last assistant message from the UI too so the new reply
    // doesn't render alongside the bad one.
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "assistant") {
          next.splice(i, 1);
          break;
        }
      }
      return next;
    });
    retryFlagRef.current = true;
    await sendMessage({ text: lastUserText });
  }, [isStreaming, lastUserText, projectId, sendMessage, setMessages]);

  const onRevert = useCallback(
    async (messageId: string, snapshotId: string) => {
      if (isStreaming || isReverting) return;
      setIsReverting(messageId);
      try {
        await restoreSnapshot(projectId, snapshotId);
        const { tree } = await getProjectFiles(projectId);
        useFileSystemStore.getState().replaceTree(tree);
      } catch {
        // Swallow: surface via existing error banner if useChat picks it
        // up; otherwise the user can just try again.
      } finally {
        setIsReverting(null);
      }
    },
    [isReverting, isStreaming, projectId],
  );

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return null;
  }, [messages]);

  return (
    <PanelShell
      title="Chat"
      right={
        stage !== "idle" ? (
          <span className="text-[10px] font-medium uppercase text-muted-foreground">
            {stage}
          </span>
        ) : null
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Describe the app you want to build. Code will stream into the
              editor on the right.
            </p>
          ) : null}
          {messages.map((m) => {
            const text = messageText(m);
            const snapshotId =
              m.role === "assistant" ? m.metadata?.snapshot_id ?? null : null;
            const isLastAssistant = m.id === lastAssistantId;
            return (
              <div
                key={m.id}
                className={cn(
                  "rounded-md border border-border px-3 py-2 text-sm",
                  m.role === "user"
                    ? "bg-secondary"
                    : "bg-background text-foreground",
                )}
              >
                <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <span>{m.role}</span>
                  {m.role === "assistant" && snapshotId ? (
                    <button
                      type="button"
                      onClick={() => void onRevert(m.id, snapshotId)}
                      disabled={
                        isStreaming ||
                        isReverting !== null ||
                        isReverting === m.id
                      }
                      className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      title="Revert project files to the state before this message"
                    >
                      <History className="size-3" />
                      {isReverting === m.id ? "Reverting…" : "Revert"}
                    </button>
                  ) : null}
                </div>
                <div className="whitespace-pre-wrap font-sans leading-relaxed">
                  {text || <span className="text-muted-foreground">…</span>}
                </div>
                {isLastAssistant && !isStreaming && lastUserText ? (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => void onRetry()}
                      className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isStreaming || isReverting !== null}
                    >
                      <RefreshCw className="size-3" />
                      Retry
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {error ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span className="min-w-0 flex-1 truncate">{error.message}</span>
              {lastUserText ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void onRetry()}
                  disabled={isStreaming}
                >
                  <RefreshCw className="size-4" />
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <form
          className="flex shrink-0 items-end gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void onSend();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
            placeholder="Build a todo app with Next.js…"
            rows={3}
            className="min-h-[72px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {isStreaming ? (
            <Button
              type="button"
              variant="destructive"
              size="icon"
              onClick={() => stop()}
            >
              <Square className="size-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!draft.trim()}>
              <Send className="size-4" />
            </Button>
          )}
        </form>
      </div>
    </PanelShell>
  );
}

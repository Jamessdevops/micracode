"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  ChevronDown,
  ChevronRight,
  HelpCircle,
  History,
  RefreshCw,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { V0ChatInput } from "@/components/chat/V0ChatInput";
import { env } from "@/lib/env";
import {
  answerQuestion,
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
import { useModelStore } from "@/store/modelStore";
import { usePendingPromptStore } from "@/store/pendingPromptStore";
import { useWebContainerStore } from "@/store/webContainerStore";

export interface V0ChatPanelProps {
  projectId: string;
  initialMessages?: MicracodeUIMessage[];
  initialPrompt?: string;
  hasInitialHistory?: boolean;
}

type Stage = "idle" | "planning" | "generating" | "done" | "cancelled" | "plan_ready";

type ProcessLog =
  | { id: string; kind: "thought"; seconds: number }
  | { id: string; kind: "brief"; note?: string }
  | { id: string; kind: "explore"; note: string }
  | {
      id: string;
      kind: "tool-call";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      reason: string;
      output?: string;
      outputError?: boolean;
    }
  | {
      id: string;
      kind: "question";
      toolCallId: string;
      requestId: string;
      question: string;
      options: string[];
      /** Set once the question is resolved (answered or auto-proceeded). */
      resolved?: boolean;
      /** The user's answer; undefined when the turn proceeded without one. */
      answer?: string;
    };

type QuestionLog = Extract<ProcessLog, { kind: "question" }>;

const autoSubmittedProjectIds = new Set<string>();

let logIdCounter = 0;
const nextLogId = () => `log-${++logIdCounter}-${Date.now()}`;


function LogRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-zinc-400">
      {children}
    </div>
  );
}

function LogIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center text-zinc-500">
      {children}
    </span>
  );
}

function formatToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file":
      return `-> read ${args.path ?? ""}`;
    case "write_patch":
      return `-> write ${args.path ?? ""}`;
    case "shell_exec":
      return `$ ${args.command ?? ""}`;
    case "grep":
      return `* grep ${args.pattern ?? ""} in ${args.path ?? "."}`;
    case "list_files":
      return `* list ${args.path ?? "."}`;
    default:
      return `-> ${toolName} ${JSON.stringify(args)}`;
  }
}

function renderLog(
  log: ProcessLog,
  expandedLogs: Set<string>,
  toggleExpanded: (id: string) => void,
): React.ReactNode {
  switch (log.kind) {
    case "thought":
      return (
        <LogRow>
          <LogIcon>
            <Zap className="size-3.5" />
          </LogIcon>
          <span>Thought for {log.seconds}s</span>
        </LogRow>
      );
    case "brief":
      return (
        <LogRow>
          <LogIcon>
            <Sparkles className="size-3.5" />
          </LogIcon>
          <span>{log.note ?? "Generated design brief"}</span>
        </LogRow>
      );
    case "explore":
      return (
        <LogRow>
          <LogIcon>
            <Search className="size-3.5" />
          </LogIcon>
          <span>{log.note}</span>
        </LogRow>
      );
    case "tool-call": {
      const callLine = formatToolCall(log.toolName, log.args);
      const isExpanded = expandedLogs.has(log.id);
      return (
        <div className="py-0.5 font-mono text-xs space-y-0.5">
          <div className="text-zinc-600"># {log.reason}</div>
          <div className="text-zinc-200">{callLine}</div>
          {log.output !== undefined && (
            <>
              <button
                type="button"
                onClick={() => toggleExpanded(log.id)}
                className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                <span># output</span>
              </button>
              {isExpanded && (
                <pre
                  className={cn(
                    "whitespace-pre-wrap break-all pl-4 text-zinc-400",
                    log.outputError && "text-red-400",
                  )}
                >
                  {log.output}
                </pre>
              )}
            </>
          )}
        </div>
      );
    }
  }
}

function QuestionCard({
  log,
  onAnswer,
}: {
  log: QuestionLog;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(
    async (answer: string) => {
      const trimmed = answer.trim();
      if (!trimmed || submitting) return;
      setSubmitting(true);
      setErr(null);
      try {
        await onAnswer(trimmed);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to send answer");
        setSubmitting(false);
      }
    },
    [onAnswer, submitting],
  );

  return (
    <div className="my-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-1.5 text-zinc-300">
        <HelpCircle className="size-3.5 text-amber-400" />
        <span className="font-medium">Needs your input</span>
      </div>
      <div className="mb-2 whitespace-pre-wrap text-zinc-200">{log.question}</div>

      {log.resolved ? (
        <div className="text-zinc-500">
          <span className="text-zinc-400">Answered:</span>{" "}
          {log.answer ?? "(proceeded without an answer)"}
        </div>
      ) : (
        <>
          {log.options.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {log.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  disabled={submitting}
                  onClick={() => void submit(opt)}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(value);
            }}
            className="flex items-center gap-1.5"
          >
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={submitting}
              placeholder={
                log.options.length > 0
                  ? "…or type your own answer"
                  : "Type your answer…"
              }
              className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none transition focus:border-zinc-500 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={submitting || !value.trim()}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Sending…" : "Send"}
            </button>
          </form>
          {err ? <div className="mt-1 text-red-400">{err}</div> : null}
        </>
      )}
    </div>
  );
}

export function V0ChatPanel({
  projectId,
  initialMessages,
  initialPrompt,
  hasInitialHistory = false,
}: V0ChatPanelProps) {
  const pathname = usePathname();
  const [draft, setDraft] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [isReverting, setIsReverting] = useState<string | null>(null);
  const [logsByAssistantId, setLogsByAssistantId] = useState<
    Record<string, ProcessLog[]>
  >({});

  const retryFlagRef = useRef(false);
  const pendingLogsRef = useRef<ProcessLog[]>([]);
  const planningStartedAtRef = useRef<number | null>(null);
  const briefEmittedRef = useRef(false);
  const messagesScrollerRef = useRef<HTMLDivElement | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((id: string) => {
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<MicracodeUIMessage>({
        api: `${env.API_BASE_URL}/v1/generate`,
        prepareSendMessagesRequest: ({ messages }) => {
          const lastUser = [...messages]
            .reverse()
            .find((m) => m.role === "user");
          const prompt = lastUser ? messageText(lastUser) : "";
          const retry = retryFlagRef.current;
          retryFlagRef.current = false;
          // Read selection at request time (not closure capture) so
          // swapping models mid-session doesn't require recreating the
          // transport and resetting `useChat`'s internal state.
          const { provider, model } = useModelStore.getState();
          return {
            body: {
              project_id: projectId,
              prompt,
              retry,
              provider,
              model,
            },
          };
        },
      }),
    [projectId],
  );

  const appendLogToLatestAssistant = useCallback(
    (log: ProcessLog, messagesSnapshot: MicracodeUIMessage[]) => {
      let id: string | null = null;
      for (let i = messagesSnapshot.length - 1; i >= 0; i--) {
        if (messagesSnapshot[i]!.role === "assistant") {
          id = messagesSnapshot[i]!.id;
          break;
        }
      }
      if (id) {
        const targetId = id;
        setLogsByAssistantId((prev) => ({
          ...prev,
          [targetId]: [...(prev[targetId] ?? []), log],
        }));
      } else {
        pendingLogsRef.current.push(log);
      }
    },
    [],
  );

  const updateLogOutput = useCallback(
    (toolCallId: string, output: string, outputError: boolean) => {
      setLogsByAssistantId((prev) => {
        for (const [assistantId, logs] of Object.entries(prev)) {
          const idx = logs.findIndex(
            (l) => l.kind === "tool-call" && l.toolCallId === toolCallId,
          );
          if (idx !== -1) {
            const updated = [...logs];
            updated[idx] = { ...updated[idx]!, output, outputError } as ProcessLog;
            return { ...prev, [assistantId]: updated };
          }
        }
        return prev;
      });
    },
    [],
  );

  const patchQuestionLog = useCallback(
    (
      toolCallId: string,
      patch: Partial<QuestionLog>,
      onlyIfUnresolved = false,
    ) => {
      setLogsByAssistantId((prev) => {
        for (const [assistantId, logs] of Object.entries(prev)) {
          const idx = logs.findIndex(
            (l) => l.kind === "question" && l.toolCallId === toolCallId,
          );
          if (idx === -1) continue;
          const q = logs[idx] as QuestionLog;
          if (onlyIfUnresolved && q.resolved) return prev;
          const updated = [...logs];
          updated[idx] = { ...q, ...patch };
          return { ...prev, [assistantId]: updated };
        }
        return prev;
      });
    },
    [],
  );

  const handleAnswer = useCallback(
    async (log: QuestionLog, answer: string) => {
      // Optimistically resolve so the card flips to "Answered" immediately and
      // the server's own tool.result (which arrives after we POST) is a no-op.
      patchQuestionLog(log.toolCallId, { resolved: true, answer });
      try {
        await answerQuestion(log.requestId, log.toolCallId, answer);
      } catch (e) {
        patchQuestionLog(log.toolCallId, { resolved: false, answer: undefined });
        throw e;
      }
    },
    [patchQuestionLog],
  );

  const { messages, setMessages, sendMessage, status, error, stop } =
    useChat<MicracodeUIMessage>({
      id: projectId,
      messages: initialMessages,
      transport,
      onData: (part) => {
        switch (part.type) {
          case "data-file-write": {
            useFileSystemStore
              .getState()
              .upsertFile(part.data.path, part.data.content);
            break;
          }
          case "data-file-delete": {
            useFileSystemStore.getState().deleteFile(part.data.path);
            break;
          }
          case "data-shell-exec": {
            useWebContainerStore
              .getState()
              .enqueueShell(part.data.command, part.data.cwd ?? undefined);
            break;
          }
          case "data-tool-call": {
            const { tool_call_id, tool_name, args, reason } = part.data;
            // The question tool renders as an interactive card via
            // `data-tool-question`; skip the generic log row for it.
            if (tool_name === "question") break;
            setMessages((prev) => {
              appendLogToLatestAssistant(
                {
                  id: nextLogId(),
                  kind: "tool-call",
                  toolCallId: tool_call_id,
                  toolName: tool_name,
                  args,
                  reason,
                },
                prev,
              );
              return prev;
            });
            break;
          }
          case "data-tool-question": {
            const { tool_call_id, question, options, request_id } = part.data;
            setMessages((prev) => {
              appendLogToLatestAssistant(
                {
                  id: nextLogId(),
                  kind: "question",
                  toolCallId: tool_call_id,
                  requestId: request_id,
                  question,
                  options: options ?? [],
                },
                prev,
              );
              return prev;
            });
            break;
          }
          case "data-tool-result": {
            const { tool_call_id, output, approved } = part.data;
            // If this is the result for a question the user never answered,
            // the server fed its own sentinel — flip the card to a resolved,
            // answer-less state. No-op once the user has already answered.
            patchQuestionLog(tool_call_id, { resolved: true }, true);
            updateLogOutput(tool_call_id, output, !approved);
            break;
          }
          case "data-status": {
            const nextStage = part.data.stage;
            setStage(nextStage);

            if (nextStage === "planning") {
              planningStartedAtRef.current = Date.now();
              briefEmittedRef.current = false;
            } else if (nextStage === "generating") {
              const startedAt = planningStartedAtRef.current;
              if (startedAt != null) {
                const seconds = Math.max(
                  1,
                  Math.round((Date.now() - startedAt) / 1000),
                );
                planningStartedAtRef.current = null;
                setMessages((prev) => {
                  appendLogToLatestAssistant(
                    { id: nextLogId(), kind: "thought", seconds },
                    prev,
                  );
                  if (!briefEmittedRef.current) {
                    briefEmittedRef.current = true;
                    appendLogToLatestAssistant(
                      {
                        id: nextLogId(),
                        kind: "brief",
                        note: part.data.note ?? "Generated design brief",
                      },
                      prev,
                    );
                  }
                  return prev;
                });
              }
            }

            if (part.data.snapshot_id) {
              const snapshotId = part.data.snapshot_id;
              setMessages((prev) => {
                const next = [...prev];
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i]!.role === "assistant") {
                    next[i] = {
                      ...next[i]!,
                      metadata: {
                        ...(next[i]!.metadata ?? {}),
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

  // Flush buffered logs onto the first assistant message once it exists.
  useEffect(() => {
    if (pendingLogsRef.current.length === 0) return;
    let id: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") {
        id = messages[i]!.id;
        break;
      }
    }
    if (!id) return;
    const targetId = id;
    const buffered = pendingLogsRef.current;
    pendingLogsRef.current = [];
    setLogsByAssistantId((prev) => ({
      ...prev,
      [targetId]: [...(prev[targetId] ?? []), ...buffered],
    }));
  }, [messages]);

  // Auto-scroll chat to bottom as new content streams in.
  useEffect(() => {
    const el = messagesScrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, logsByAssistantId, stage]);

  useEffect(() => {
    const trimmed = initialPrompt?.trim();
    if (!trimmed || hasInitialHistory) return;
    if (autoSubmittedProjectIds.has(projectId)) return;
    autoSubmittedProjectIds.add(projectId);

    if (typeof window !== "undefined") {
      const nextUrl = `${pathname}${window.location.hash}`;
      window.history.replaceState(window.history.state, "", nextUrl);
    }

    void sendMessage({ text: trimmed });
  }, [hasInitialHistory, initialPrompt, pathname, projectId, sendMessage]);

  const pendingPrompt = usePendingPromptStore((s) => s.pending);
  const clearPending = usePendingPromptStore((s) => s.clearPending);
  useEffect(() => {
    if (!pendingPrompt || isStreaming) return;
    clearPending();
    void sendMessage({ text: pendingPrompt });
  }, [pendingPrompt, isStreaming, clearPending, sendMessage]);

  const onSend = useCallback(async () => {
    if (!draft.trim() || isStreaming) return;
    const prompt = draft;
    setDraft("");
    await sendMessage({ text: prompt });
  }, [draft, isStreaming, sendMessage]);

  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") return messageText(messages[i]!);
    }
    return "";
  }, [messages]);

  const onRetry = useCallback(async () => {
    if (isStreaming || !lastUserText) return;
    try {
      await popLastAssistantPrompt(projectId);
    } catch {
      // Non-fatal.
    }
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i]!.role === "assistant") {
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
        // Surfaced via existing error banner.
      } finally {
        setIsReverting(null);
      }
    },
    [isReverting, isStreaming, projectId],
  );

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") return messages[i]!.id;
    }
    return null;
  }, [messages]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0E0E11] text-zinc-50">
      <div
        ref={messagesScrollerRef}
        className="min-h-0 flex-1 overflow-auto px-4 py-4 bg-black"
      >
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-400">
            Describe the app you want to build. Code will stream into the
            editor on the right.
          </p>
        ) : null}

        <div className="space-y-4">
          {messages.map((m) => {
            const text = messageText(m);
            const snapshotId =
              m.role === "assistant" ? m.metadata?.snapshot_id ?? null : null;
            const isLastAssistant = m.id === lastAssistantId;
            const logs = logsByAssistantId[m.id] ?? [];

            if (m.role === "user") {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl bg-zinc-800 px-4 py-2 text-sm text-zinc-50">
                    {text}
                  </div>
                </div>
              );
            }

            return (
              <div key={m.id} className="space-y-2 text-sm">
                {logs.length > 0 ? (
                  <div className="space-y-0.5">
                    {logs.map((log) =>
                      log.kind === "question" ? (
                        <QuestionCard
                          key={log.id}
                          log={log}
                          onAnswer={(answer) => handleAnswer(log, answer)}
                        />
                      ) : (
                        <div key={log.id}>
                          {renderLog(log, expandedLogs, toggleExpanded)}
                        </div>
                      ),
                    )}
                  </div>
                ) : null}

                {text ? (
                  <div className="whitespace-pre-wrap leading-relaxed text-zinc-300">
                    {text}
                  </div>
                ) : null}

                {!text && logs.length === 0 ? (
                  <div className="text-zinc-500">…</div>
                ) : null}

                {isLastAssistant && !isStreaming ? (
                  <div className="flex items-center gap-2 pt-1 text-xs text-zinc-500">
                    {lastUserText ? (
                      <button
                        type="button"
                        onClick={() => void onRetry()}
                        className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-0.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={isStreaming || isReverting !== null}
                      >
                        <RefreshCw className="size-3" />
                        Retry
                      </button>
                    ) : null}
                    {snapshotId ? (
                      <button
                        type="button"
                        onClick={() => void onRevert(m.id, snapshotId)}
                        disabled={
                          isStreaming ||
                          isReverting !== null ||
                          isReverting === m.id
                        }
                        className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-0.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                        title="Revert project files to the state before this message"
                      >
                        <History className="size-3" />
                        {isReverting === m.id ? "Reverting…" : "Revert"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}

          {error ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              <span className="min-w-0 flex-1 truncate">{error.message}</span>
              {lastUserText ? (
                <button
                  type="button"
                  onClick={() => void onRetry()}
                  disabled={isStreaming}
                  className="inline-flex items-center gap-1 rounded-md border border-red-900/60 px-2 py-0.5 text-red-200 transition hover:bg-red-950/70 disabled:opacity-50"
                >
                  <RefreshCw className="size-3" />
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          "shrink-0 border-zinc-800 bg-black p-3",
        )}
      >
        <V0ChatInput
          value={draft}
          onChange={setDraft}
          onSubmit={() => void onSend()}
          onStop={() => stop()}
          isStreaming={isStreaming}
          placeholder={
            messages.length === 0
              ? "Describe what you want to build..."
              : "Ask a follow-up..."
          }
        />
      </div>
    </section>
  );
}

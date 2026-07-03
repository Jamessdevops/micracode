"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FlipWords } from "@/components/ui/flip-words";
import type { Message as Msg, Turn } from "@/lib/types";

interface ChatViewProps {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  turns: Turn[];
  empty: boolean;
  harness: string;
  showOptimistic: boolean;
  optimisticUser: string | null;
  pendingAssistant: boolean;
  errors: string[];
}

export function ChatView({
  scrollRef,
  turns,
  empty,
  harness,
  showOptimistic,
  optimisticUser,
  pendingAssistant,
  errors,
}: ChatViewProps) {
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-smooth">
      <div className="mx-auto max-w-[740px] px-6 pb-40 pt-6">
        {empty && (
          <div className="flex h-[calc(100vh-52px-150px)] flex-col items-center justify-center gap-1.5">
            <svg
              className="h-[38px] w-[38px] text-accent"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 2l2.4 6.4L21 11l-6.6 2.6L12 20l-2.4-6.4L3 11l6.6-2.6z" />
            </svg>
            <h1 className="mt-1.5 font-serif text-[30px] font-medium tracking-[-0.01em] text-ink">
              How can I{" "}
              <FlipWords
                words={["help", "assist", "support", "guide"]}
                className="text-accent"
              />
              you today?
            </h1>
            <p className="text-sm text-ink-faint">
              Start a {harness} session and drive the Micracode backend.
            </p>
          </div>
        )}

        {turns.map((turn, ti) => (
          <div key={ti}>
            {turn.messages.map((m, mi) => (
              <Message key={mi} m={m} />
            ))}
            {turn.status === "running" && pendingAssistant && <Typing />}
          </div>
        ))}

        {showOptimistic && (
          <>
            <div className="my-[22px] flex justify-end">
              <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-bubble px-4 py-[11px]">
                {optimisticUser}
              </div>
            </div>
            {pendingAssistant && <Typing />}
          </>
        )}

        {errors.map((msg, i) => (
          <div className="my-[22px]" key={"e" + i}>
            <div className="mb-[7px] flex items-center gap-2.5 text-[13px] text-ink-faint">
              <span className="grid h-[22px] w-[22px] place-items-center rounded-md bg-ink-faint text-xs font-bold text-accent-on">
                !
              </span>
              <span>System</span>
            </div>
            <div className="whitespace-pre-wrap break-words font-serif text-[16.5px] leading-[1.7] text-ink-soft">
              {msg}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Message({ m }: { m: Msg }) {
  if (m.role === "user") {
    return (
      <div className="my-[22px] flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-bubble px-4 py-[11px]">
          {m.text}
        </div>
      </div>
    );
  }
  if (m.role === "assistant") {
    return (
      <div className="my-[22px]">
        <Who />
        <div className="whitespace-pre-wrap break-words font-serif text-[16.5px] leading-[1.7] text-ink">
          {m.text}
        </div>
      </div>
    );
  }
  if (m.role === "tool") return <ToolCard m={m} />;
  return null;
}

function Who() {
  return (
    <div className="mb-[7px] flex items-center gap-2.5 text-[13px] text-ink-faint">
      <span className="grid h-[22px] w-[22px] place-items-center rounded-md bg-accent text-xs font-bold text-accent-on">
        M
      </span>
      <span>Micracode</span>
    </div>
  );
}

function ToolCard({ m }: { m: Msg }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className="my-2.5 overflow-hidden rounded-[11px] border border-line bg-surface">
      <div
        onClick={() => setCollapsed((c) => !c)}
        className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] text-ink-soft"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6 2 2 6-6a4 4 0 0 0 5.4-5.4l-2.3 2.3-1.4-1.4 2.3-2.3z" />
        </svg>
        <span className="font-mono text-[12.5px] text-ink">{m.name}</span>
        <span
          className={cn(
            "ml-auto text-[11px]",
            m.is_error ? "text-accent" : "text-ink-faint",
          )}
        >
          {m.is_error ? "error" : "tool"}
        </span>
      </div>
      {!collapsed && (
        <>
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words border-t border-line px-3 py-2.5 font-mono text-xs text-ink-soft">
            {JSON.stringify(m.input, null, 2)}
          </pre>
          {m.result != null && (
            <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words border-t border-line px-3 py-2.5 font-mono text-xs text-ink-soft">
              {m.result}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function Typing() {
  return (
    <div className="my-[22px]">
      <Who />
      <div className="inline-flex gap-1 py-1">
        <span className="h-[7px] w-[7px] rounded-full bg-ink-faint [animation:blink_1.2s_infinite_both]" />
        <span className="h-[7px] w-[7px] rounded-full bg-ink-faint [animation:blink_1.2s_infinite_both_0.2s]" />
        <span className="h-[7px] w-[7px] rounded-full bg-ink-faint [animation:blink_1.2s_infinite_both_0.4s]" />
      </div>
    </div>
  );
}

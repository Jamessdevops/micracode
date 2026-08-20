"use client";

import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { usePreviewStore } from "@/store/previewStore";

/**
 * Collapsible console drawer that shows streamed dev-server output. Shared
 * between the preview tab and the code tab so dev logs can be surfaced
 * wherever the user is working.
 */
export function PreviewConsole() {
  const output = usePreviewStore((s) => s.output);
  const clearOutput = usePreviewStore((s) => s.clearOutput);

  const [consoleOpen, setConsoleOpen] = useState(false);

  const errorLines = useMemo(() => output.filter((l) => l.isError), [output]);
  const hasOutput = output.length > 0;

  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!consoleOpen) return;
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [consoleOpen, output.length]);

  return (
    <div className="shrink-0 border-t border-border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onClick={() => setConsoleOpen((v) => !v)}
      >
        <span className="flex items-center gap-2">
          {consoleOpen ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronUp className="size-3" />
          )}
          Console
          {hasOutput ? (
            <span className="rounded border border-border px-1 text-[10px]">
              {output.length}
            </span>
          ) : null}
          {errorLines.length > 0 ? (
            <span className="rounded border border-destructive/40 bg-destructive/10 px-1 text-[10px] text-destructive">
              {errorLines.length} error
              {errorLines.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
        {consoleOpen && hasOutput ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              clearOutput();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                clearOutput();
              }
            }}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <Trash2 className="size-3" /> Clear
          </span>
        ) : null}
      </button>
      {consoleOpen ? (
        <div
          ref={logRef}
          className="max-h-48 overflow-auto border-t border-border bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground"
        >
          {output.length === 0 ? (
            <span className="italic text-muted-foreground">
              No output yet.
            </span>
          ) : (
            output.map((line) => (
              <div
                key={line.id}
                className={
                  line.isError ? "text-destructive" : "text-muted-foreground"
                }
              >
                <span className="mr-2 uppercase opacity-60">{line.source}</span>
                {line.text}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

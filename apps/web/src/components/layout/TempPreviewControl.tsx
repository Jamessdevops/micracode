"use client";

import {
  Check,
  Clock3,
  Copy,
  ExternalLink,
  Globe2,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getTempPreview,
  publishTempPreview,
  revokeTempPreview,
  type TempPreviewSummary,
} from "@/lib/api/projects";
import { cn } from "@/lib/utils";
import { usePreviewStore } from "@/store/previewStore";

export function TempPreviewControl({ projectId }: { projectId: string }) {
  const [preview, setPreview] = useState<TempPreviewSummary>({
    hasPreview: false,
  });
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [operation, setOperation] = useState<"publish" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const phase = usePreviewStore((state) => state.phase);
  const stopPreview = usePreviewStore((state) => state.stopPreview);
  const startPreview = usePreviewStore((state) => state.startPreview);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void getTempPreview(projectId)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageFor(reason));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const publish = useCallback(async () => {
    const restartLocalPreview = phase === "ready" || phase === "starting";
    setOperation("publish");
    setError(null);
    try {
      if (restartLocalPreview) await stopPreview(projectId);
      const result = await publishTempPreview(projectId);
      setPreview(result.preview);
      setCopied(false);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setOperation(null);
      if (restartLocalPreview) void startPreview(projectId);
    }
  }, [phase, projectId, startPreview, stopPreview]);

  const copyUrl = useCallback(async () => {
    if (!preview.canonicalUrl) return;
    try {
      await navigator.clipboard.writeText(preview.canonicalUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(
        "The preview URL could not be copied. You can open it and copy it from the browser.",
      );
    }
  }, [preview.canonicalUrl]);

  const revoke = useCallback(async () => {
    if (
      !window.confirm(
        "Revoke this public temporary preview? The link will stop working.",
      )
    )
      return;
    setOperation("revoke");
    setError(null);
    try {
      const result = await revokeTempPreview(projectId);
      setPreview(result.preview);
      setCopied(false);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setOperation(null);
    }
  }, [projectId]);

  const busy = operation !== null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-100 transition hover:border-zinc-500 hover:bg-zinc-900 disabled:opacity-50"
      >
        {isLoading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Globe2 className="size-4" />
        )}
        Temporary preview
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Temporary preview"
          className="absolute right-0 top-10 z-50 w-[360px] rounded-xl border border-zinc-700 bg-zinc-950 p-4 text-zinc-100 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Temporary preview</h2>
              <p className="mt-1 text-xs leading-5 text-zinc-400">
                Share a production static build without creating an account.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close"
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="size-4" />
            </button>
          </div>

          {preview.hasPreview && preview.canonicalUrl ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <p className="break-all text-xs text-zinc-200">
                  {preview.canonicalUrl}
                </p>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
                  <Clock3 className="size-3.5" />
                  {expiryLabel(preview.expiresAt)}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ActionButton onClick={copyUrl} disabled={busy}>
                  {copied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {copied ? "Copied" : "Copy link"}
                </ActionButton>
                <a
                  href={preview.canonicalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-zinc-100 px-2 text-xs font-medium text-black hover:bg-white"
                >
                  <ExternalLink className="size-3.5" /> Open
                </a>
                <ActionButton onClick={publish} disabled={busy}>
                  {operation === "publish" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  Update
                </ActionButton>
                <ActionButton onClick={revoke} disabled={busy} destructive>
                  {operation === "revoke" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                  Revoke
                </ActionButton>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <div className="rounded-lg border border-zinc-800 bg-black p-3 text-xs leading-5 text-zinc-400">
                <p>
                  This runs your production build and uploads only files from
                  its verified `out/` folder.
                </p>
                <p className="mt-2">
                  The resulting temp.md URL is public to anyone with the link
                  and normally expires after seven days.
                </p>
              </div>
              <button
                type="button"
                onClick={publish}
                disabled={busy || isLoading}
                className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-black hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {operation === "publish" && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                Build and share
              </button>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-md bg-red-950/60 px-3 py-2 text-xs leading-5 text-red-200"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  children,
  className,
  destructive = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { destructive?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-zinc-700 px-2 text-xs font-medium hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50",
        destructive && "text-red-300 hover:border-red-900 hover:bg-red-950/50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function expiryLabel(expiresAt?: string | null): string {
  if (!expiresAt) return "Expiry is managed by temp.md";
  const value = new Date(expiresAt);
  if (Number.isNaN(value.getTime())) return "Expiry is managed by temp.md";
  return `Expires ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value)}`;
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Temporary preview failed.";
}

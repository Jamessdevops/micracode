"use client";

import {
  IconChevronDown,
  IconDeviceLaptop,
  IconFolder,
  IconGitBranch,
  IconPlus,
  IconSquare,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { folderLabel, permLabel } from "@/lib/api";
import type { Harness, Permission } from "@/lib/types";

interface ComposerProps {
  input: string;
  onInput: (v: string, el: HTMLTextAreaElement) => void;
  onSend: () => void;
  sending: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  harness: Harness;
  permission: Permission;
  onSetPermission: (p: Permission) => void;
  permMenuOpen: boolean;
  onTogglePerm: (e: React.MouseEvent) => void;
  onToggleModel: (e: React.MouseEvent) => void;
  activeWorkspace: string;
  folderMenuOpen: boolean;
  onToggleFolderMenu: (e: React.MouseEvent) => void;
  knownFolders: string[];
  onSelectFolder: (f: string) => void;
  onPickFolder: () => void;
}

const PERMISSIONS: { value: Permission; label: string; sub: React.ReactNode }[] =
  [
    {
      value: "bypassPermissions",
      label: "Bypass permissions",
      sub: (
        <span>
          Fully autonomous · <code>--dangerously-skip-permissions</code>
        </span>
      ),
    },
    {
      value: "acceptEdits",
      label: "Accept edits",
      sub: "Auto-accept file edits in the workspace",
    },
    { value: "plan", label: "Plan", sub: "Read & propose only — no file changes" },
    {
      value: "default",
      label: "Default",
      sub: "Standard prompting (restricted when headless)",
    },
  ];

export function Composer(props: ComposerProps) {
  const {
    input,
    onInput,
    onSend,
    sending,
    textareaRef,
    harness,
    permission,
    onSetPermission,
    permMenuOpen,
    onTogglePerm,
    onToggleModel,
    activeWorkspace,
    folderMenuOpen,
    onToggleFolderMenu,
    knownFolders,
    onSelectFolder,
    onPickFolder,
  } = props;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-canvas from-[55%] to-transparent px-6 pb-[22px]">
      <div className="pointer-events-auto relative w-full max-w-[740px]">
        {/* context chips */}
        <div className="relative flex flex-wrap items-center gap-2 px-1 pb-2">
          <Chip>
            <IconDeviceLaptop className="h-[15px] w-[15px] text-ink-faint" />
            <span className="text-ink">Local</span>
          </Chip>
          <button
            title="Folder new chats open in"
            onClick={onToggleFolderMenu}
            className="inline-flex cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-[9px] border border-line bg-surface px-2.5 py-1.5 text-[13px] font-semibold text-ink-soft hover:bg-sidebar-hover hover:text-ink"
          >
            <IconFolder className="h-[15px] w-[15px] text-ink-faint" />
            <span className="max-w-[160px] overflow-hidden text-ellipsis text-ink">
              {folderLabel(activeWorkspace)}
            </span>
            <IconChevronDown className="h-[15px] w-[15px] text-ink-faint" />
          </button>
          <Chip>
            <IconGitBranch className="h-[15px] w-[15px] text-ink-faint" />
            <span className="text-ink">main</span>
          </Chip>
          <span className="mx-px h-4 w-px shrink-0 bg-line-strong" />
          <Chip>
            <IconSquare className="h-[15px] w-[15px] text-ink-faint" />
            <span className="text-ink">worktree</span>
          </Chip>
          <button
            title="Open folder…"
            onClick={(e) => {
              e.stopPropagation();
              onPickFolder();
            }}
            className="inline-flex shrink-0 items-center justify-center rounded-[9px] border border-line bg-surface p-[7px] text-ink-soft hover:bg-sidebar-hover hover:text-ink"
          >
            <FolderPlusIcon />
          </button>

          {folderMenuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-[calc(100%+8px)] left-0 z-40 max-h-[320px] min-w-[280px] max-w-[360px] overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-soft"
            >
              {["", ...knownFolders].map((f) => (
                <div
                  key={f || "__default"}
                  onClick={() => onSelectFolder(f)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-sidebar-hover",
                  )}
                >
                  <IconFolder className="h-[14px] w-[14px] shrink-0 text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap">
                      {folderLabel(f)}
                    </div>
                    {f && (
                      <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-ink-faint">
                        {f}
                      </div>
                    )}
                  </div>
                  <span
                    className={cn(
                      "ml-auto text-accent",
                      f === activeWorkspace ? "opacity-100" : "opacity-0",
                    )}
                  >
                    ✓
                  </span>
                </div>
              ))}
              <div
                onClick={onPickFolder}
                className="mt-1 flex cursor-pointer items-center gap-2 rounded-lg border-t border-line px-2.5 pb-2 pt-2.5 text-[13px] font-semibold text-accent hover:bg-sidebar-hover"
              >
                <IconPlus className="h-[14px] w-[14px] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div>Open folder…</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* input box */}
        <div className="relative flex flex-col gap-1.5 rounded-[22px] border border-line-strong bg-surface py-2 pl-4 pr-2.5 shadow-soft focus-within:shadow-[var(--shadow),0_0_0_3px_var(--ring)]">
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder="How can I help you today?"
            value={input}
            onChange={(e) => onInput(e.target.value, e.target)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            className="max-h-[200px] w-full resize-none bg-transparent py-1 text-[15.5px] leading-[1.55] text-ink outline-none placeholder:text-ink-faint"
          />

          {permMenuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-[58px] left-3 z-30 min-w-[256px] rounded-xl border border-line-strong bg-surface p-1.5 shadow-soft"
            >
              {PERMISSIONS.map((p) => (
                <div
                  key={p.value}
                  onClick={() => onSetPermission(p.value)}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-[9px] hover:bg-sidebar-hover"
                >
                  <div>
                    <div className="text-[13.5px]">{p.label}</div>
                    <div className="mt-px text-xs text-ink-faint">{p.sub}</div>
                  </div>
                  <span
                    className={cn(
                      "ml-auto text-accent",
                      permission === p.value ? "opacity-100" : "opacity-0",
                    )}
                  >
                    ✓
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={onToggleModel}
              className="inline-flex items-center gap-1.5 rounded-[9px] border border-line px-2.5 py-[5px] text-[13px] text-ink-soft hover:bg-sidebar-hover"
            >
              <span className="inline-block h-[7px] w-[7px] rounded-full bg-accent" />
              <span>{harness}</span>
            </button>
            <button
              title="Permission mode"
              onClick={onTogglePerm}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[9px] border border-line px-2.5 py-[5px] text-[13px] text-ink-soft hover:bg-sidebar-hover",
                permission === "bypassPermissions" &&
                  "border-accent/50 text-accent",
              )}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
              </svg>
              <span>{permLabel(permission)}</span>
            </button>
            <div className="flex-1" />
            <button
              title="Send"
              disabled={sending}
              onClick={onSend}
              className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-accent text-accent-on hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-line-strong"
            >
              <svg
                className="h-[18px] w-[18px]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mt-2 text-center text-[11.5px] text-ink-faint">
          Micracode test client · turns stream over{" "}
          <code>/v1/events/stream</code>
        </div>
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex cursor-default items-center gap-[7px] whitespace-nowrap rounded-[9px] border border-line bg-surface px-2.5 py-1.5 text-[13px] font-semibold text-ink-soft">
      {children}
    </span>
  );
}

function FolderPlusIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </svg>
  );
}

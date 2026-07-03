"use client";

import { motion } from "motion/react";
import {
  IconChevronRight,
  IconFolder,
  IconPlus,
  IconSettings,
} from "@tabler/icons-react";
import { Sidebar, SidebarBody, useSidebar } from "@/components/ui/sidebar";
import { RainbowButton } from "@/components/ui/rainbow-button";
import { cn } from "@/lib/utils";
import { folderLabel, DEFAULT_FOLDER } from "@/lib/api";
import type { ConnState, Thread } from "@/lib/types";

export interface AppSidebarProps {
  threads: Thread[];
  groups: Map<string, Thread[]>;
  orderedKeys: string[];
  collapsedFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  sessionId: string | null;
  onOpenChat: (id: string) => void;
  onNewChat: () => void;
  conn: ConnState;
  settingsOpen: boolean;
  onToggleSettings: (e: React.MouseEvent) => void;
  baseUrl: string;
  onBaseUrl: (v: string) => void;
  activeWorkspace: string;
  onActiveWorkspace: (v: string) => void;
}

/** Text that fades/collapses with the sidebar — same behaviour as the
 *  Aceternity `SidebarLink` label, so only icons remain in the collapsed rail. */
function Label({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { open, animate } = useSidebar();
  return (
    <motion.span
      animate={{
        opacity: animate ? (open ? 1 : 0) : 1,
        display: animate ? (open ? "inline-block" : "none") : "inline-block",
      }}
      className={cn("whitespace-pre", className)}
    >
      {children}
    </motion.span>
  );
}

export function AppSidebar(props: AppSidebarProps) {
  return (
    <Sidebar>
      <SidebarBody className="justify-between gap-2 !bg-sidebar border-r border-line !px-2.5 !py-2.5">
        <SidebarContent {...props} />
      </SidebarBody>
    </Sidebar>
  );
}

function SidebarContent({
  threads,
  groups,
  orderedKeys,
  collapsedFolders,
  onToggleFolder,
  sessionId,
  onOpenChat,
  onNewChat,
  conn,
  settingsOpen,
  onToggleSettings,
  baseUrl,
  onBaseUrl,
  activeWorkspace,
  onActiveWorkspace,
}: AppSidebarProps) {
  const { open } = useSidebar();

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* brand */}
      <div className="flex items-center gap-2.5 px-2 pb-3 pt-2">
        <div className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] bg-accent text-[15px] font-bold text-accent-on">
          M
        </div>
        <Label className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
          Micracode
        </Label>
      </div>

      {/* new chat */}
      <RainbowButton
        onClick={onNewChat}
        className="h-10 w-full justify-start gap-2.5 rounded-[9px] px-2.5 font-semibold"
      >
        <IconPlus className="h-[18px] w-[18px] shrink-0" />
        <Label>New chat</Label>
      </RainbowButton>

      <Label className="px-2.5 pb-1.5 pt-3.5 text-xs font-semibold text-ink-faint">
        Recents
      </Label>

      {/* folder groups */}
      <ul className="min-h-0 flex-1 list-none overflow-y-auto overflow-x-hidden">
        {!threads.length ? (
          open && (
            <li className="cursor-default px-2.5 py-2 text-[13px] text-ink-faint">
              No conversations yet
            </li>
          )
        ) : (
          orderedKeys.map((key) => {
            const list = groups.get(key) ?? [];
            const collapsed = collapsedFolders.has(key);
            return (
              <li key={key || "__default"} className="mb-0.5">
                <div
                  title={key || DEFAULT_FOLDER}
                  onClick={() => onToggleFolder(key)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-ink-faint hover:bg-sidebar-hover hover:text-ink-soft"
                >
                  {open && (
                    <IconChevronRight
                      className={cn(
                        "h-3 w-3 shrink-0 transition-transform",
                        !collapsed && "rotate-90",
                      )}
                    />
                  )}
                  <IconFolder className="h-[15px] w-[15px] shrink-0" />
                  <Label className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {folderLabel(key)}
                  </Label>
                  <Label className="shrink-0 font-medium opacity-80">
                    {list.length}
                  </Label>
                </div>
                {open && !collapsed && (
                  <ul className="mb-0.5 list-none">
                    {list.map((t) => (
                      <li
                        key={t.id}
                        onClick={() => onOpenChat(t.id)}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-[9px] py-[7px] pl-[22px] pr-2.5 text-sm text-ink-soft hover:bg-sidebar-hover hover:text-ink",
                          t.id === sessionId && "bg-sidebar-active text-ink",
                        )}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            t.status === "closed" ? "bg-ink-faint" : "bg-accent",
                          )}
                        />
                        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                          {t.provider_session_id || t.id.slice(0, 8)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })
        )}
      </ul>

      {/* footer: connection + settings */}
      <div className="mt-1 border-t border-line pt-2">
        <div className="flex items-center gap-2 px-2.5 py-[7px] text-[12.5px] text-ink-faint">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              conn.online
                ? "bg-ink"
                : "bg-transparent shadow-[inset_0_0_0_2px_var(--text-faint)]",
            )}
          />
          <Label className="flex-1">{conn.text}</Label>
          {open && (
            <button
              title="Settings"
              onClick={onToggleSettings}
              className="ml-auto rounded-md p-1 text-ink-faint hover:bg-sidebar-hover hover:text-ink"
            >
              <IconSettings className="h-4 w-4" />
            </button>
          )}
        </div>

        {settingsOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed bottom-[46px] left-3 z-20 w-[280px] rounded-xl border border-line-strong bg-surface p-3.5 shadow-soft"
          >
            <h3 className="mb-1 text-[13px] font-semibold text-ink">
              Connection
            </h3>
            <label className="mb-1 mt-2 block text-xs text-ink-faint">
              API base URL
            </label>
            <input
              value={baseUrl}
              onChange={(e) => onBaseUrl(e.target.value)}
              className="w-full rounded-lg border border-line bg-canvas px-2.5 py-[7px] text-ink outline-none"
            />
            <label className="mb-1 mt-2 block text-xs text-ink-faint">
              Workspace path (optional)
            </label>
            <input
              value={activeWorkspace}
              placeholder="defaults to OPENER_APPS_DIR"
              onChange={(e) => onActiveWorkspace(e.target.value)}
              className="w-full rounded-lg border border-line bg-canvas px-2.5 py-[7px] text-ink outline-none"
            />
          </div>
        )}
      </div>
    </div>
  );
}

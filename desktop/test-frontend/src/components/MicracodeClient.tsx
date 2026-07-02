"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { Topbar } from "@/components/Topbar";
import { ChatView } from "@/components/ChatView";
import { Composer } from "@/components/Composer";
import { ScrollProgress } from "@/components/ui/scroll-progress";
import { DEMO_TURNS } from "@/lib/demo";
import {
  api,
  DEFAULT_API_BASE,
  spawnHint,
  type ApiError,
} from "@/lib/api";
import type {
  ConnState,
  Harness,
  HealthResponse,
  Permission,
  SessionStartResponse,
  Thread,
} from "@/lib/types";

type MenuName = "model" | "perm" | "folder" | "settings" | null;

interface StreamEvent {
  kind?: string;
  payload?: { session_id?: string };
}

function turnsContainUser(turns: Thread["turns"], text: string): boolean {
  return (turns ?? []).some((tn) =>
    tn.messages.some((m) => m.role === "user" && m.text === text),
  );
}

export function MicracodeClient() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_API_BASE);
  const apiBase = baseUrl.replace(/\/+$/, "");

  const [harness, setHarness] = useState<Harness>("claude");
  const [permission, setPermission] = useState<Permission>("bypassPermissions");
  // The folder a *new* chat opens in (sent as `workspace` on POST /v1/sessions).
  // Empty string = let the backend default to OPENER_APPS_DIR.
  const [activeWorkspace, setActiveWorkspace] = useState("");
  const [picking, setPicking] = useState(false);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );

  const [conn, setConn] = useState<ConnState>({
    online: false,
    text: "connecting…",
  });
  const [sending, setSending] = useState(false);
  const [pendingAssistant, setPendingAssistant] = useState(false);
  const [optimisticUser, setOptimisticUser] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [openMenu, setOpenMenu] = useState<MenuName>(null);
  const [input, setInput] = useState("");
  // Dummy long chat for manual scroll testing: open the page with `?demo`.
  // Set after mount (never during render) so SSR and client hydrate identically.
  const [demoActive, setDemoActive] = useState(false);

  // Refs read inside async callbacks / the SSE handler (avoid stale closures).
  const baseRef = useRef(apiBase);
  baseRef.current = apiBase;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const call = useCallback(
    <T,>(method: string, path: string, body?: unknown) =>
      api<T>(baseRef.current, method, path, body),
    [],
  );

  useEffect(() => {
    setDemoActive(new URLSearchParams(window.location.search).has("demo"));
  }, []);

  // ── derived: bucket threads by folder ───────────────────────
  const { groups, threadWorkspace } = useMemo(() => {
    const groups = new Map<string, Thread[]>();
    const tw: Record<string, string> = {};
    for (const t of threads) {
      const key = t.workspace || "";
      tw[t.id] = key;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    return { groups, threadWorkspace: tw };
  }, [threads]);
  const twRef = useRef(threadWorkspace);
  twRef.current = threadWorkspace;

  const knownFolders = useMemo(
    () => [...groups.keys()].filter((k) => k),
    [groups],
  );
  // The active folder floats to the top so a fresh "New chat" is obvious.
  const orderedKeys = useMemo(() => {
    const keys = [...groups.keys()];
    keys.sort((a, b) => Number(b === activeWorkspace) - Number(a === activeWorkspace));
    return keys;
  }, [groups, activeWorkspace]);

  // ── data loads ──────────────────────────────────────────────
  const refreshChats = useCallback(async () => {
    try {
      setThreads(await call<Thread[]>("GET", "/v1/threads"));
    } catch {
      /* offline */
    }
  }, [call]);
  const refreshChatsSoon = useCallback(() => {
    if (chatsTimerRef.current) clearTimeout(chatsTimerRef.current);
    chatsTimerRef.current = setTimeout(refreshChats, 300);
  }, [refreshChats]);
  const loadThread = useCallback(
    async (id: string) => {
      try {
        const t = await call<Thread>("GET", `/v1/threads/${id}`);
        if (id === sessionIdRef.current) setThread(t);
      } catch {
        /* thread not folded yet — ignore */
      }
    },
    [call],
  );
  const ping = useCallback(async () => {
    try {
      const h = await call<HealthResponse>("GET", "/v1/health");
      setConn({ online: true, text: `${h.provider} · online` });
    } catch {
      setConn({ online: false, text: "backend offline" });
    }
  }, [call]);

  const pushError = (msg: string) => setErrors((prev) => [...prev, msg]);

  // ── effects: ping, initial chats, live event stream ─────────
  useEffect(() => {
    ping();
    const t = setInterval(ping, 8000);
    return () => clearInterval(t);
  }, [ping, apiBase]);
  useEffect(() => {
    refreshChats();
  }, [refreshChats, apiBase]);

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`${apiBase}/v1/events/stream?cursor=0`);
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (m) => {
      let ev: StreamEvent;
      try {
        ev = JSON.parse(m.data);
      } catch {
        return;
      }
      const sid = ev.payload && ev.payload.session_id;
      if (sid && sid !== sessionId) return; // not our conversation
      if (ev.kind && ev.kind.startsWith("provider.")) {
        if (
          ev.kind === "provider.turn_completed" ||
          ev.kind === "provider.session_closed"
        )
          setPendingAssistant(false);
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(() => loadThread(sessionId), 120);
      }
      refreshChatsSoon();
    };
    es.onerror = () => {};
    return () => {
      es.close();
      if (renderTimer) clearTimeout(renderTimer);
    };
  }, [sessionId, apiBase, loadThread, refreshChatsSoon]);

  // Close any open menu on an outside click. Listen on `window`, not `document`:
  // React 19 / Next delegates events at the document node, so a toggle's
  // `e.stopPropagation()` can't stop a document-level listener (same node) — but
  // it does stop the event before it reaches `window`, so menu toggles and
  // in-menu clicks are correctly ignored here while true outside clicks close.
  useEffect(() => {
    const onOutside = () => setOpenMenu(null);
    window.addEventListener("click", onOutside);
    return () => window.removeEventListener("click", onOutside);
  }, []);

  // keep scrolled to the newest message
  useEffect(() => {
    const s = scrollRef.current;
    if (s) s.scrollTop = s.scrollHeight;
  }, [thread, optimisticUser, pendingAssistant, errors]);

  // ── actions ─────────────────────────────────────────────────
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  function newChat() {
    setSessionId(null);
    setThread(null);
    setPendingAssistant(false);
    setOptimisticUser(null);
    setErrors([]);
    if (textareaRef.current) textareaRef.current.focus();
  }

  function openChat(id: string) {
    setSessionId(id);
    setPendingAssistant(false);
    setOptimisticUser(null);
    setErrors([]);
    // Follow the chat into its folder, so a subsequent "New chat" continues in
    // the same folder (matching t3 code / Codex desktop behaviour).
    const ws = twRef.current[id];
    if (ws !== undefined) setActiveWorkspace(ws);
    loadThread(id);
  }

  // native folder picker: the backend (on this machine) pops the real Finder
  // "Choose Folder" dialog and returns the absolute path the user picks.
  async function pickFolder() {
    if (picking) return;
    setPicking(true);
    try {
      const res = await call<{ path?: string }>("POST", "/v1/fs/pick", {
        start: activeWorkspace || undefined,
      });
      if (res && res.path) {
        setActiveWorkspace(res.path);
        refreshChats();
      }
    } catch (e) {
      const err = e as ApiError;
      pushError(
        err.status === 503
          ? "The native folder picker is only available when the backend runs on macOS."
          : `Couldn't open the folder dialog: ${err.message || err}`,
      );
    } finally {
      setPicking(false);
    }
  }

  // send a message: lazily start a session, then POST the turn
  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setErrors([]);
    setOptimisticUser(text); // optimistic: paint it immediately
    setPendingAssistant(true);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    let phase = "connect";
    let sid = sessionId;
    try {
      if (!sid) {
        phase = "start";
        const body: Record<string, unknown> = { harness, permission };
        if (activeWorkspace) body.workspace = activeWorkspace;
        const started = await call<SessionStartResponse>(
          "POST",
          "/v1/sessions",
          body,
        );
        sid = started.session_id;
        setSessionId(sid); // opens the event stream (effect)
        await refreshChats();
      }
      phase = "turn";
      await call("POST", `/v1/sessions/${sid}/turn`, { text });
    } catch (e) {
      const err = e as ApiError;
      setPendingAssistant(false);
      if (!err.status)
        pushError(
          "Could not reach the backend — is micracode-api running on " +
            apiBase +
            "?",
        );
      // The backend scrubs 500 bodies, but a session-start 500 is a CLI spawn
      // failure in practice, so surface the actionable hint by phase.
      else if (phase === "start" && err.status >= 500)
        pushError(spawnHint(harness));
      else pushError(`Error ${err.status}: ${err.message}`);
    } finally {
      setSending(false);
    }
  }

  function toggleFolder(key: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  const toggleMenu = (name: Exclude<MenuName, null>) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenu((m) => (m === name ? null : name));
  };

  // ── render ──────────────────────────────────────────────────
  const realTurns = thread?.turns ?? [];
  const showOptimistic = Boolean(
    optimisticUser && !turnsContainUser(realTurns, optimisticUser),
  );
  const turns =
    demoActive && !realTurns.length && !showOptimistic ? DEMO_TURNS : realTurns;
  const empty = !turns.length && !showOptimistic;

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <AppSidebar
        threads={threads}
        groups={groups}
        orderedKeys={orderedKeys}
        collapsedFolders={collapsedFolders}
        onToggleFolder={toggleFolder}
        sessionId={sessionId}
        onOpenChat={openChat}
        onNewChat={newChat}
        conn={conn}
        settingsOpen={openMenu === "settings"}
        onToggleSettings={toggleMenu("settings")}
        baseUrl={baseUrl}
        onBaseUrl={setBaseUrl}
        activeWorkspace={activeWorkspace}
        onActiveWorkspace={setActiveWorkspace}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <Topbar
          harness={harness}
          modelOpen={openMenu === "model"}
          onToggleModel={toggleMenu("model")}
          onSetHarness={(h) => {
            setHarness(h);
            setOpenMenu(null);
          }}
        />

        <ChatView
          scrollRef={scrollRef}
          turns={turns}
          empty={empty}
          harness={harness}
          showOptimistic={showOptimistic}
          optimisticUser={optimisticUser}
          pendingAssistant={pendingAssistant}
          errors={errors}
        />

        <ScrollProgress
          containerRef={scrollRef}
          className="absolute inset-x-0 top-[52px] z-20 h-0.5"
        />

        <Composer
          input={input}
          onInput={(v, el) => {
            setInput(v);
            autosize(el);
          }}
          onSend={sendMessage}
          sending={sending}
          textareaRef={textareaRef}
          harness={harness}
          permission={permission}
          onSetPermission={(p) => {
            setPermission(p);
            setOpenMenu(null);
          }}
          permMenuOpen={openMenu === "perm"}
          onTogglePerm={toggleMenu("perm")}
          onToggleModel={toggleMenu("model")}
          activeWorkspace={activeWorkspace}
          folderMenuOpen={openMenu === "folder"}
          onToggleFolderMenu={(e) => {
            e.stopPropagation();
            setOpenMenu((m) => (m === "folder" ? null : "folder"));
          }}
          knownFolders={knownFolders}
          onSelectFolder={(f) => {
            setOpenMenu(null);
            setActiveWorkspace(f);
          }}
          onPickFolder={pickFolder}
        />
      </div>
    </div>
  );
}

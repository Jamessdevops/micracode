"use client";

import {
  ArrowLeft,
  Bot,
  Check,
  Cpu,
  FolderGit2,
  GitBranch,
  Info,
  KeyRound,
  Leaf,
  Loader2,
  Palette,
  Search,
  Settings2,
  Terminal,
  User,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { getModelCatalog, type ModelCatalog } from "@/lib/api/models";
import { listProjects, type ProjectRecord } from "@/lib/api/projects";
import {
  getSettings,
  updateProviderKey,
  type SettingsView,
} from "@/lib/api/settings";
import { isDesktop } from "@/lib/desktop";
import { useModelStore } from "@/store/modelStore";
import { cn } from "@/lib/utils";

// Providers the user can configure keys for. Must match the ids the core
// exposes at /v1/settings (see apps/core/src/providers.ts).
const PROVIDERS = [
  { id: "openai", label: "OpenAI", placeholder: "sk-..." },
  { id: "anthropic", label: "Claude", placeholder: "sk-ant-..." },
  { id: "kimi", label: "Kimi (Moonshot)", placeholder: "sk-..." },
  { id: "gemini", label: "Gemini", placeholder: "AIza..." },
] as const;

// A section is one of the static ids below, or `proj:<projectId>` for a
// project row rendered from the fetched list.
interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

const NAV_GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Personal",
    items: [
      { id: "general", label: "General", icon: Settings2 },
      { id: "account", label: "Account", icon: User },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "models", label: "Default models", icon: Cpu },
      { id: "git", label: "Git", icon: GitBranch },
    ],
  },
  {
    heading: "Agents & environment",
    items: [
      { id: "agents", label: "Agents", icon: Bot },
      { id: "environment", label: "Environment", icon: Leaf },
    ],
  },
];

export default function SettingsPage() {
  const [section, setSection] = useState<string>("agents");
  const [query, setQuery] = useState("");

  // Shared data — loaded once, read by whichever pane needs it.
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  const groups = useMemo(() => {
    const withProjects = [
      ...NAV_GROUPS,
      ...(projects.length > 0
        ? [
            {
              heading: "Repositories",
              items: projects.map((p) => ({
                id: `proj:${p.id}`,
                label: p.name,
                icon: FolderGit2,
              })),
            },
          ]
        : []),
    ];
    const q = query.trim().toLowerCase();
    if (!q) return withProjects;
    return withProjects
      .map((g) => ({
        ...g,
        items: g.items.filter((i) => i.label.toLowerCase().includes(q)),
      }))
      .filter((g) => g.items.length > 0);
  }, [query, projects]);

  const activeProject =
    section.startsWith("proj:") &&
    projects.find((p) => p.id === section.slice(5));

  return (
    <main className="flex h-dvh bg-[#0e0e11] text-white">
      {/* Sidebar */}
      <aside
        className={cn(
          "flex w-[264px] shrink-0 flex-col border-r border-[#1b1b1e] bg-[#0b0b0e]",
          isDesktop() && "pt-7",
        )}
      >
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <span className="text-sm font-semibold">Settings</span>
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-white"
          >
            <ArrowLeft className="size-3.5" />
            Back
          </Link>
        </div>

        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-md border border-[#1b1b1e] bg-[#141417] px-2.5 py-1.5">
            <Search className="size-3.5 text-zinc-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              className="w-full bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
            />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-2">
          {groups.map((group) => (
            <div key={group.heading} className="mb-4">
              <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-600">
                {group.heading}
              </p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSection(item.id)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      active
                        ? "bg-[#1b1b1e] text-white"
                        : "text-zinc-400 hover:bg-[#141417] hover:text-zinc-200",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className={cn("mx-auto max-w-3xl px-8 py-10", isDesktop() && "pt-14")}>
          {error && section === "agents" && (
            <p className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </p>
          )}
          {section === "agents" && (
            <AgentsPane settings={settings} onSaved={setSettings} />
          )}
          {section === "models" && <ModelsPane settings={settings} />}
          {section === "general" && <GeneralPane />}
          {activeProject && <ProjectPane project={activeProject} />}
          {section === "account" && (
            <EmptyPane
              icon={User}
              title="Account"
              body="Micracode runs entirely on your machine. There's no account to sign in to — your keys, projects, and history never leave your laptop."
            />
          )}
          {section === "appearance" && (
            <EmptyPane
              icon={Palette}
              title="Appearance"
              body="Micracode ships with a single dark theme, tuned for long editing sessions. A light theme isn't available yet."
            />
          )}
          {section === "git" && (
            <EmptyPane
              icon={GitBranch}
              title="Git"
              body="Version control is per-project. Open a project and use its checkpoint history to browse and restore snapshots — there's nothing to configure globally."
            />
          )}
          {section === "environment" && (
            <EmptyPane
              icon={Leaf}
              title="Environment"
              body="The core backend runs in-process inside the app — no separate server, database, or environment variables to manage."
            />
          )}
        </div>
      </div>
    </main>
  );
}

function PaneHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>}
    </header>
  );
}

/* ---------------------------------------------------------------- Agents */

function AgentsPane({
  settings,
  onSaved,
}: {
  settings: SettingsView | null;
  onSaved: (s: SettingsView) => void;
}) {
  const [active, setActive] = useState<(typeof PROVIDERS)[number]["id"]>(
    "anthropic",
  );
  const selectedProvider = useModelStore((s) => s.provider);
  const selectedModel = useModelStore((s) => s.model);

  const provider = PROVIDERS.find((p) => p.id === active)!;
  const state = settings?.[active] ?? null;
  const configured = Boolean(state?.configured);

  return (
    <div>
      <PaneHeader
        title="Agents"
        subtitle="Connect the model providers Micracode uses to generate apps. Keys are stored on your machine and never leave it."
      />

      {/* Provider tabs */}
      <div className="mb-8 flex gap-6 border-b border-[#1b1b1e] text-sm">
        {PROVIDERS.map((p) => {
          const isActive = p.id === active;
          const ok = settings?.[p.id]?.configured;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setActive(p.id)}
              className={cn(
                "relative flex items-center gap-1.5 pb-2.5 transition-colors",
                isActive ? "text-white" : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {p.label}
              {ok && <span className="size-1.5 rounded-full bg-emerald-400" />}
              {isActive && (
                <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-[#45f4ff]" />
              )}
            </button>
          );
        })}
      </div>

      {/* Authentication method cards */}
      <p className="mb-3 text-sm font-medium text-zinc-300">Authentication</p>
      <div className="mb-8 grid grid-cols-2 gap-3">
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-[#45f4ff]/40 bg-[#141417] py-6">
          <KeyRound className="size-5 text-[#45f4ff]" />
          <span className="text-sm font-medium">API key</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-[#1b1b1e] bg-[#0e0e11] py-6 opacity-50">
          <Terminal className="size-5 text-zinc-500" />
          <span className="text-sm font-medium text-zinc-400">CLI</span>
          <span className="text-[11px] text-zinc-600">Not available</span>
        </div>
      </div>

      {/* Connection status */}
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span
          className={cn(
            "size-2 rounded-full",
            configured ? "bg-emerald-400" : "bg-zinc-600",
          )}
        />
        <span className={configured ? "text-emerald-400" : "text-zinc-400"}>
          {configured ? "Connected" : "Not connected"}
        </span>
      </div>

      <dl className="mb-8 overflow-hidden rounded-lg border border-[#1b1b1e]">
        <Row label="Provider" value={provider.label} />
        <Row label="Status" value={configured ? "Key configured" : "No key set"} />
        <Row label="Key" value={state?.hint ? `••••${state.hint}` : "—"} />
        <Row
          label="Default model"
          value={
            selectedProvider === active && selectedModel
              ? selectedModel
              : "Set in Default models"
          }
          last
        />
      </dl>

      <ProviderKeyForm
        id={provider.id}
        placeholder={provider.placeholder}
        configured={configured}
        onSaved={onSaved}
      />
    </div>
  );
}

function Row({
  label,
  value,
  last,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center bg-[#141417] text-sm",
        !last && "border-b border-[#1b1b1e]",
      )}
    >
      <dt className="w-40 shrink-0 px-4 py-2.5 text-zinc-500">{label}</dt>
      <dd className="px-4 py-2.5 text-zinc-200">{value}</dd>
    </div>
  );
}

function ProviderKeyForm({
  id,
  placeholder,
  configured,
  onSaved,
}: {
  id: string;
  placeholder: string;
  configured: boolean;
  onSaved: (s: SettingsView) => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(await updateProviderKey(id, key.trim()));
      setKey("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <label htmlFor={`${id}-key`} className="block text-sm font-medium text-zinc-300">
        {configured ? "Replace API key" : "Set API key"}
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setSaved(false);
          }}
          placeholder={configured ? "Enter a new key to replace" : placeholder}
          className="w-full rounded-md border border-[#2a2a30] bg-[#0e0e11] px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-[#45f4ff]"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || key.trim().length === 0}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-[#45f4ff] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save
        </button>
      </div>
      <div className="mt-2 h-4 text-sm">
        {saved && <span className="text-emerald-400">Saved</span>}
        {error && <span className="text-red-400">{error}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Default models */

function ModelsPane({ settings }: { settings: SettingsView | null }) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = useModelStore((s) => s.provider);
  const model = useModelStore((s) => s.model);
  const setSelection = useModelStore((s) => s.setSelection);

  useEffect(() => {
    getModelCatalog()
      .then(setCatalog)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <PaneHeader
        title="Default models"
        subtitle="Choose the model new chats start with. Providers without an API key are disabled — set one under Agents."
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!catalog && !error && (
        <Loader2 className="size-5 animate-spin text-zinc-500" />
      )}
      <div className="space-y-6">
        {catalog?.providers.map((p) => {
          const available = p.available || Boolean(settings?.[p.id]?.configured);
          return (
            <section key={p.id}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-medium text-zinc-200">{p.label}</h2>
                {!available && (
                  <span className="text-[11px] text-zinc-600">no key</span>
                )}
              </div>
              <div className="overflow-hidden rounded-lg border border-[#1b1b1e]">
                {p.models.map((m, i) => {
                  const selected = provider === p.id && model === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={!available}
                      onClick={() => setSelection(p.id, m.id)}
                      className={cn(
                        "flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors",
                        i > 0 && "border-t border-[#1b1b1e]",
                        selected ? "bg-[#141417]" : "bg-[#0e0e11] hover:bg-[#141417]",
                        !available && "cursor-not-allowed opacity-40",
                      )}
                    >
                      <span className="text-zinc-200">{m.label}</span>
                      {selected && <Check className="size-4 text-[#45f4ff]" />}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ General */

function GeneralPane() {
  const desktop = isDesktop();
  return (
    <div>
      <PaneHeader title="General" subtitle="About this Micracode install." />
      <dl className="overflow-hidden rounded-lg border border-[#1b1b1e]">
        <Row label="Version" value="0.1.0" />
        <Row label="Runtime" value={desktop ? "Desktop app" : "Browser"} />
        <Row label="Backend" value="In-process core" last />
      </dl>
      <a
        href="https://github.com/Jamessdevops/micracode"
        target="_blank"
        rel="noreferrer"
        className="mt-4 inline-flex items-center gap-1.5 text-sm text-[#45f4ff] hover:underline"
      >
        <Info className="size-4" />
        Micracode on GitHub
      </a>
    </div>
  );
}

/* ----------------------------------------------------------------- Project */

function ProjectPane({ project }: { project: ProjectRecord }) {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };
  return (
    <div>
      <PaneHeader
        title={project.name}
        subtitle="A Micracode project stored locally on this machine."
      />
      <dl className="mb-4 overflow-hidden rounded-lg border border-[#1b1b1e]">
        <Row label="Template" value={project.template} />
        <Row label="Created" value={fmt(project.created_at)} />
        <Row label="Updated" value={fmt(project.updated_at)} last />
      </dl>
      <Link
        href={{ pathname: "/projects", query: { id: project.id } }}
        className="inline-flex items-center gap-1.5 text-sm text-[#45f4ff] hover:underline"
      >
        <FolderGit2 className="size-4" />
        Open project
      </Link>
    </div>
  );
}

/* -------------------------------------------------------------- Empty state */

function EmptyPane({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div>
      <PaneHeader title={title} subtitle="" />
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[#1b1b1e] bg-[#0b0b0e] px-6 py-14 text-center">
        <Icon className="size-6 text-zinc-600" />
        <p className="max-w-md text-sm text-zinc-500">{body}</p>
      </div>
    </div>
  );
}

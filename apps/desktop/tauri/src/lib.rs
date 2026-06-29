// Micracode desktop shell (Tauri 2.0).
//
// This mirrors the existing Electron app's behaviour: a JSON settings store
// (api keys + backend port) and an IPC bridge, here exposed as Tauri commands.
// The webview loads the same Next.js frontend (`apps/web`) the Electron shell
// uses — see `tauri.conf.json` (`devUrl` / `frontendDist`).
//
// On startup it also spawns the Rust `micracode-api` backend (crate at
// `desktop/api`) on 127.0.0.1:8000 — the port the frontend's
// `NEXT_PUBLIC_API_BASE_URL` points at — and kills it on exit. This is the
// Tauri equivalent of the Electron `startBackend`/`stopBackend` lifecycle.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const DEFAULT_BACKEND_PORT: u16 = 8000;

/// Filename of the backend binary produced by the `desktop/api` crate.
#[cfg(windows)]
const BACKEND_BIN: &str = "micracode-api.exe";
#[cfg(not(windows))]
const BACKEND_BIN: &str = "micracode-api";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoreData {
    #[serde(default)]
    api_keys: HashMap<String, String>,
    #[serde(default = "default_backend_port")]
    backend_port: u16,
}

fn default_backend_port() -> u16 {
    DEFAULT_BACKEND_PORT
}

impl Default for StoreData {
    fn default() -> Self {
        StoreData {
            api_keys: HashMap::new(),
            backend_port: DEFAULT_BACKEND_PORT,
        }
    }
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

fn read_store(app: &tauri::AppHandle) -> StoreData {
    let Ok(path) = store_path(app) else {
        return StoreData::default();
    };
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => StoreData::default(),
    }
}

fn write_store(app: &tauri::AppHandle, data: &StoreData) -> Result<(), String> {
    let path = store_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create config dir: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("failed to write settings: {e}"))
}

// --- Backend lifecycle (the Tauri equivalent of Electron's startBackend) ---

/// Holds the spawned backend child so it can be killed on app exit.
struct BackendProcess(Mutex<Option<Child>>);

/// Resolve the `micracode-api` binary path.
///
/// In dev (`cargo tauri dev`) the binary is the debug build of the sibling
/// `desktop/api` crate, located relative to this crate's source dir. In a
/// packaged build it ships under `resources/backend/`.
#[cfg_attr(debug_assertions, allow(unused_variables))]
fn backend_binary_path(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        // CARGO_MANIFEST_DIR = apps/desktop/tauri  →  repo root is ../../..
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../desktop/api/target/debug")
            .join(BACKEND_BIN);
        Some(path)
    }
    #[cfg(not(debug_assertions))]
    {
        // Bundled by Tauri from `resources/backend/*` (see `tauri.conf.json`);
        // the glob preserves the `resources/backend/` prefix under the
        // resource dir.
        app.path()
            .resource_dir()
            .ok()
            .map(|dir| dir.join("resources").join("backend").join(BACKEND_BIN))
    }
}

/// Sentinels wrapping the `PATH` we print from the login shell. Interactive rc
/// files (prompt frameworks like powerlevel10k/oh-my-posh) can print to stdout
/// before our `printf` runs, so we bracket the real value and extract what's
/// between the markers rather than trusting the whole stdout.
const PATH_BEGIN: &str = "__MICRACODE_PATH_BEGIN__";
const PATH_END: &str = "__MICRACODE_PATH_END__";

/// Best-effort capture of the user's login-shell `PATH`.
///
/// A GUI app launched from Finder/Dock inherits a minimal `PATH`
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits `~/.local/bin`, Homebrew, and
/// npm-global dirs — exactly where the `claude`/`codex` CLIs usually live, so
/// the backend (and the agent CLIs it spawns) can't find them. Asking the
/// login shell for its `PATH` recovers what the user sees in a terminal.
fn login_shell_path() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // `-ilc` runs an interactive login shell so both profile files
    // (`.zprofile`/`.bash_profile`) and rc files (`.zshrc`/`.bashrc`) — where
    // users commonly set `PATH` — are sourced before we read it.
    let script = format!("printf '%s%s%s' '{PATH_BEGIN}' \"$PATH\" '{PATH_END}'");
    let output = Command::new(shell).args(["-ilc", &script]).output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Pull out the value between our sentinels, ignoring any prompt/banner junk
    // an interactive shell may have emitted around it.
    let path = stdout
        .split_once(PATH_BEGIN)
        .and_then(|(_, rest)| rest.split_once(PATH_END))
        .map(|(value, _)| value.trim().to_string())?;

    // Sanity-check it looks like a real PATH (absolute, colon-delimited) so a
    // surprise (e.g. an error message slipping between the markers) can't
    // clobber the backend's PATH.
    let looks_like_path = !path.is_empty()
        && path
            .split(':')
            .filter(|d| !d.is_empty())
            .all(|d| d.starts_with('/'));
    looks_like_path.then_some(path)
}

/// Resolve an absolute path to `bin` by scanning a colon-separated `PATH`.
///
/// A pure lookup (no extra shell spawn): returns the first directory entry that
/// exists as a file, used to pin `CLAUDE_BIN`/`CODEX_BIN` to absolute paths.
fn which_in(path: &str, bin: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(dir).join(bin))
        .find(|cand| cand.is_file())
}

/// Spawn the backend on 127.0.0.1:`backend_port`, injecting any saved API keys
/// (which are stored under their env-var names, e.g. `OPENAI_API_KEY`).
fn spawn_backend(app: &AppHandle) -> Option<Child> {
    let path = backend_binary_path(app)?;
    if !path.exists() {
        eprintln!(
            "[backend] binary not found at {} — build it with `cargo build` in desktop/api; \
             /v1 requests will 404 until then",
            path.display()
        );
        return None;
    }

    // Use the fixed port the frontend's NEXT_PUBLIC_API_BASE_URL targets, not
    // the (possibly stale) stored value.
    let store = read_store(app);
    let mut cmd = Command::new(&path);
    cmd.envs(store.api_keys);
    cmd.env("MICRACODE_API_HOST", "127.0.0.1");
    cmd.env("MICRACODE_API_PORT", DEFAULT_BACKEND_PORT.to_string());

    // Give the backend a `PATH` that can actually find the agent CLIs, then pin
    // `CLAUDE_BIN`/`CODEX_BIN` to absolute paths so each session spawns the same
    // `claude`/`codex` the user runs in their terminal. An explicit env var
    // (e.g. set by a dev launching from a shell) is inherited as-is and wins.
    let search_path = login_shell_path();
    if let Some(p) = &search_path {
        cmd.env("PATH", p);
    }
    let lookup_path = search_path
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    for (var, bin) in [("CLAUDE_BIN", "claude"), ("CODEX_BIN", "codex")] {
        if std::env::var_os(var).is_some() {
            continue;
        }
        match which_in(&lookup_path, bin) {
            Some(found) => {
                println!("[backend] resolved {bin} → {}", found.display());
                cmd.env(var, found);
            }
            None => eprintln!(
                "[backend] {bin} CLI not found on PATH; sessions using it will \
                 fail until it's installed or its path is set in settings"
            ),
        }
    }

    match cmd.spawn() {
        Ok(child) => {
            println!(
                "[backend] spawned {} on 127.0.0.1:{}",
                path.display(),
                DEFAULT_BACKEND_PORT
            );
            Some(child)
        }
        Err(err) => {
            eprintln!("[backend] failed to spawn {}: {err}", path.display());
            None
        }
    }
}

// --- Commands (the Tauri equivalent of the Electron `electronAPI` bridge) ---

#[tauri::command]
fn get_backend_port(app: tauri::AppHandle) -> u16 {
    read_store(&app).backend_port
}

#[tauri::command]
fn get_api_keys(app: tauri::AppHandle) -> HashMap<String, String> {
    read_store(&app).api_keys
}

#[tauri::command]
fn save_api_keys(app: tauri::AppHandle, keys: HashMap<String, String>) -> Result<(), String> {
    let mut store = read_store(&app);
    store.api_keys = keys;
    write_store(&app, &store)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BackendProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            get_api_keys,
            save_api_keys
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(child) = spawn_backend(&handle) {
                *app.state::<BackendProcess>().0.lock().unwrap() = Some(child);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill the backend when the app exits so we don't orphan it.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BackendProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}

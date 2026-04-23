// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use shared_child::SharedChild;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use uuid::Uuid;

struct RunnerState {
  child: Mutex<Option<Arc<SharedChild>>>,
}

const DEFAULT_MAIN_PY: &str = r#"# python.game — added assets are next to this file (same folder as Run's cwd).
# Pygame: pygame.image.load("sprite.png")
# Turtle:  open files by name; built-in image shapes and bgpic() use .gif. Optional: asset_path("x.gif")
import pygame

pygame.init()
screen = pygame.display.set_mode((400, 300))
pygame.display.set_caption("python.game")
clock = pygame.time.Clock()
running = True
while running:
  for event in pygame.event.get():
    if event.type == pygame.QUIT:
      running = False
  screen.fill((18, 24, 40))
  pygame.draw.circle(screen, (80, 200, 120), (200, 150), 48)
  pygame.display.flip()
  clock.tick(60)
pygame.quit()
"#;

const BOOTSTRAP_REL: &str = "sandbox_bootstrap.py";
const GAMES_STATE: &str = "games_state.json";
const GAMES_DIR: &str = "games";

/// TCP/TLS connect timeout for outbound HTTP clients.
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
/// PixelLab / WaveSpeed requests can run long (image jobs, polling). Not used for AI SSE streams.
const HTTP_LONG_JOB_TIMEOUT: Duration = Duration::from_secs(3600);
/// Keep long SSE reads from being dropped by NATs that expect periodic traffic.
const HTTP_STREAM_TCP_KEEPALIVE: Duration = Duration::from_secs(30);
/// Tauri IPC uses JSON; very large single events can stall or fail on some platforms.
const AI_STREAM_EMIT_MAX_CHARS: usize = 16_384;

fn emit_ai_stream_text(app: &tauri::AppHandle, event: &str, piece: &str) {
  if piece.is_empty() {
    return;
  }
  let mut rest = piece;
  while !rest.is_empty() {
    let n = if rest.len() <= AI_STREAM_EMIT_MAX_CHARS {
      rest.len()
    } else {
      let mut end = AI_STREAM_EMIT_MAX_CHARS;
      while end > 0 && !rest.is_char_boundary(end) {
        end -= 1;
      }
      end
    };
    let (chunk, tail) = rest.split_at(n);
    let _ = app.emit(event, chunk);
    rest = tail;
  }
}

fn sanitize_game_name(s: &str) -> String {
  let t = s.trim();
  if t.is_empty() {
    "Untitled".to_string()
  } else {
    t.chars().take(64).collect()
  }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct GameInfo {
  pub id: String,
  pub name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
struct GamesState {
  version: u32,
  active_id: String,
  games: Vec<GameInfo>,
}

fn app_workspace_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let p = base.join("workspace");
  fs::create_dir_all(&p).map_err(|e| e.to_string())?;
  Ok(p)
}

fn games_state_path(base: &Path) -> PathBuf {
  base.join(GAMES_STATE)
}

fn save_games_state(base: &Path, state: &GamesState) -> Result<(), String> {
  let p = games_state_path(base);
  let tmp = base.join("games_state.json.tmp");
  let j = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
  fs::write(&tmp, j).map_err(|e| e.to_string())?;
  fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
  Ok(())
}

fn create_default_game_in_dir(game_dir: &Path) -> Result<(), String> {
  fs::create_dir_all(game_dir).map_err(|e| e.to_string())?;
  let main = game_dir.join("main.py");
  if !main.is_file() {
    fs::write(&main, DEFAULT_MAIN_PY).map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// Legacy layout: workspace/main.py + workspace/assets/ — migrate to workspace/games/<id>/.
fn load_or_init_games_state(base: &Path) -> Result<GamesState, String> {
  let state_path = games_state_path(base);
  if state_path.is_file() {
    let s = fs::read_to_string(&state_path).map_err(|e| e.to_string())?;
    let mut state: GamesState = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    if state.games.is_empty() {
      return Err("corrupt game list — delete games_state.json to reset".to_string());
    }
    if !state.games.iter().any(|g| g.id == state.active_id) {
      state.active_id = state.games[0].id.clone();
      save_games_state(base, &state)?;
    }
    return Ok(state);
  }

  let legacy_main = base.join("main.py");
  let legacy_assets = base.join("assets");
  let has_legacy = legacy_main.is_file() || legacy_assets.is_dir();

  let id = Uuid::new_v4().to_string();
  let gdir = base.join(GAMES_DIR).join(&id);
  fs::create_dir_all(&gdir).map_err(|e| e.to_string())?;
  create_default_game_in_dir(&gdir)?;

  if legacy_main.is_file() {
    if gdir.join("main.py").is_file() {
      fs::remove_file(gdir.join("main.py")).ok();
    }
    fs::rename(&legacy_main, gdir.join("main.py")).map_err(|e| e.to_string())?;
  } else {
    // already written by create_default_game_in_dir
  }

  if legacy_assets.is_dir() {
    for e in fs::read_dir(&legacy_assets).map_err(|e| e.to_string())? {
      let e = e.map_err(|x| x.to_string())?;
      let p = e.path();
      if p.is_file() {
        let name = e.file_name();
        let dest = gdir.join(&name);
        if dest != p {
          if dest.exists() {
            fs::remove_file(&dest).ok();
          }
          fs::rename(&p, &dest).map_err(|e| e.to_string())?;
        }
      }
    }
    fs::remove_dir_all(&legacy_assets).map_err(|e| e.to_string())?;
  }

  let state = GamesState {
    version: 1,
    active_id: id.clone(),
    games: vec![GameInfo {
      id,
      name: if has_legacy {
        "My game".to_string()
      } else {
        "My game".to_string()
      },
    }],
  };
  save_games_state(base, &state)?;
  Ok(state)
}

fn active_sandbox_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let base = app_workspace_dir(app)?;
  let state = load_or_init_games_state(&base)?;
  let d = base.join(GAMES_DIR).join(&state.active_id);
  if !d.is_dir() {
    return Err("active project folder is missing on disk".to_string());
  }
  ensure_game_dir_flat(&d)?;
  Ok(d)
}

/// Project folder for a known game id (used so long PixelLab jobs save to the project that was active when generation started).
fn game_sandbox_dir_by_id(app: &tauri::AppHandle, project_id: &str) -> Result<PathBuf, String> {
  let base = app_workspace_dir(app)?;
  let state = load_or_init_games_state(&base)?;
  if !state.games.iter().any(|g| g.id == project_id) {
    return Err("unknown project".to_string());
  }
  let d = base.join(GAMES_DIR).join(project_id);
  if !d.is_dir() {
    return Err("project folder missing on disk".to_string());
  }
  ensure_game_dir_flat(&d)?;
  Ok(d)
}

fn is_reserved_data_filename(name: &str) -> bool {
  name.eq_ignore_ascii_case("main.py")
}

/// If an old `…/project/assets/` exists, move files up next to `main.py` and remove the folder.
fn ensure_game_dir_flat(game_dir: &Path) -> Result<(), String> {
  let sub = game_dir.join("assets");
  if !sub.is_dir() {
    return Ok(());
  }
  for e in fs::read_dir(&sub).map_err(|e| e.to_string())? {
    let e = e.map_err(|e| e.to_string())?;
    let p = e.path();
    if !p.is_file() {
      continue;
    }
    let n = e.file_name();
    let ns = n.to_string_lossy();
    if is_reserved_data_filename(&ns) {
      let alt = unique_name(game_dir, "code_from_old_assets.py");
      fs::rename(&p, game_dir.join(alt)).map_err(|e| e.to_string())?;
      continue;
    }
    let dest = game_dir.join(&n);
    if dest.exists() {
      if dest == p {
        continue;
      }
      let alt = unique_name(game_dir, &ns);
      fs::rename(&p, game_dir.join(alt)).map_err(|e| e.to_string())?;
    } else {
      fs::rename(&p, &dest).map_err(|e| e.to_string())?;
    }
  }
  fs::remove_dir_all(&sub).map_err(|e| e.to_string())?;
  Ok(())
}

fn write_bootstrap_files(ws: &Path) -> Result<(), String> {
  let bootstrap: &'static str = include_str!("../../runner/launch_sandbox.py");
  let target = ws.join(BOOTSTRAP_REL);
  fs::write(&target, bootstrap).map_err(|e| e.to_string())?;
  Ok(())
}

fn unique_name(dir: &Path, wanted: &str) -> String {
  let p = dir.join(wanted);
  if !p.exists() {
    return wanted.to_string();
  }
  let path = Path::new(wanted);
  let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("asset");
  let ext = path
    .extension()
    .and_then(|e| e.to_str())
    .map(|e| format!(".{e}"))
    .unwrap_or_default();
  let mut n = 1u32;
  loop {
    let candidate = format!("{stem}_{n}{ext}");
    if !dir.join(&candidate).exists() {
      return candidate;
    }
    n += 1;
  }
}

fn copy_import(from: &str, game: &Path) -> Result<String, String> {
  let src = Path::new(from);
  if !src.is_file() {
    return Err(format!("not a file: {from}"));
  }
  let name = src
    .file_name()
    .and_then(|s| s.to_str())
    .ok_or("bad file name")?
    .to_string();
  if is_reserved_data_filename(&name) {
    return Err("that name is reserved for your project code (main.py)".to_string());
  }
  fs::create_dir_all(game).map_err(|e| e.to_string())?;
  let final_name = unique_name(game, &name);
  let dest = game.join(&final_name);
  fs::copy(src, &dest).map_err(|e| e.to_string())?;
  Ok(final_name)
}

fn resolve_python() -> &'static str {
  if cfg!(target_os = "windows") {
    "python"
  } else {
    "python3"
  }
}

fn stop_child(state: &Arc<RunnerState>) -> Result<(), String> {
  let mut g = state.child.lock().map_err(|e| e.to_string())?;
  if let Some(c) = g.take() {
    let _ = c.kill();
    let _ = c.wait();
  }
  Ok(())
}

fn stop_runner_and_notify(app: &tauri::AppHandle, state: &Arc<RunnerState>) -> Result<(), String> {
  let had = state
    .child
    .lock()
    .map_err(|e| e.to_string())?
    .is_some();
  stop_child(state)?;
  if had {
    let _ = app.emit("runner-exit", Some(0i32));
  }
  Ok(())
}

#[derive(serde::Serialize, Clone)]
struct RunnerLine {
  stream: String,
  line: String,
}

fn emit_line(app: &tauri::AppHandle, stream: &str, line: &str) {
  let _ = app.emit(
    "runner-line",
    RunnerLine {
      stream: stream.to_string(),
      line: line.to_string(),
    },
  );
}

fn spawn_log_thread<R: Read + Send + 'static>(app: tauri::AppHandle, stream: &str, out: R) {
  let s = stream.to_string();
  let reader = BufReader::new(out);
  std::thread::spawn(move || {
    for line in reader.lines() {
      match line {
        Ok(l) => emit_line(&app, &s, &l),
        Err(_) => break,
      }
    }
  });
}

fn spawn_wait_thread(app: tauri::AppHandle, child: Arc<SharedChild>) {
  std::thread::spawn(move || {
    let code = child.wait();
    let exit = code.ok().and_then(|s| s.code());
    let _ = app.emit("runner-exit", exit);
  });
}

/// Spawning a game window (pygame, turtle, etc.) next to a **native fullscreen** IDE “loses”
/// the Tauri window: macOS leaves fullscreen on another space, or the app is minimized. We only
/// exit fullscreen / restore a minimized or hidden host window — we do **not** always `show` the
/// IDE, and we do not schedule delayed `show` calls: those were raising the z-order of the
/// Tauri window *after* a slow child window (e.g. Tk after loading a multi-frame GIF) had
/// appeared, which left the game window **behind** the IDE.
///
/// On **macOS**, do **not** `unminimize` / `show` the host: that re-activates the app and the
/// WebView becomes the key window, while turtle runs in a **separate** Python+Tk process. The
/// user would get **no key events in the game** (they all go to the editor). Exiting
/// fullscreen so the user can see the desktop is enough; if the host was minimized, they can
/// restore it from the dock.
fn resurface_ide_for_child_process(app: &tauri::AppHandle) {
  let Some(w) = app.get_webview_window("main") else {
    return;
  };
  if w.is_fullscreen().unwrap_or(false) {
    let _ = w.set_fullscreen(false);
  }
  #[cfg(target_os = "macos")]
  {
    return;
  }
  #[cfg(not(target_os = "macos"))]
  {
    if w.is_minimized().unwrap_or(false) {
      let _ = w.unminimize();
    } else if !w.is_visible().unwrap_or(true) {
      let _ = w.show();
    }
  }
}

/// Windows: the host process (this app) had the last user input (Run), so a spawned child is not
/// allowed to call `SetForegroundWindow` for its Tk/turtle (or SDL) window unless we explicitly
/// allow it. Without this, the game can render but has no keyboard.
#[cfg(windows)]
mod win_allow_child_fg {
  #[link(name = "user32")]
  extern "system" {
    pub(crate) fn AllowSetForegroundWindow(id: u32) -> i32;
  }
}

#[cfg(windows)]
fn allow_set_foreground_for_child_process(child_pid: u32) {
  if child_pid == 0 {
    return;
  }
  unsafe {
    let _ = win_allow_child_fg::AllowSetForegroundWindow(child_pid);
  }
}

fn run_inner(app: &tauri::AppHandle, state: &Arc<RunnerState>) -> Result<(), String> {
  stop_child(state)?;

  emit_line(
    app,
    "info",
    "Starting Python (project folder = cwd; ASSET_DIR & asset_path() available)…",
  );
  let base = app_workspace_dir(app)?;
  write_bootstrap_files(&base)?;
  let sandbox = active_sandbox_dir(app)?;
  let main_path = sandbox.join("main.py");
  if !main_path.is_file() {
    fs::write(&main_path, DEFAULT_MAIN_PY).map_err(|e| e.to_string())?;
  }
  let sandbox_s = fs::canonicalize(&sandbox).map_err(|e| e.to_string())?;
  let sandbox_str = sandbox_s
    .to_str()
    .ok_or("invalid utf-8 in project path")?
    .to_string();

  let mut cmd = std::process::Command::new(resolve_python());
  let bootstrap = base.join(BOOTSTRAP_REL);
  cmd
    .arg(&bootstrap)
    .current_dir(&base)
    .env("SANDBOX_ROOT", &sandbox_str)
    .env("PYTHONUNBUFFERED", "1")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  // Windows: `python.exe` is a console-subsystem process; without this, the OS shows a new terminal
  // window when Run spawns it from our GUI app (macOS does not). Stdio pipes still work.
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
  }

  let shared = SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?;
  #[cfg(windows)]
  allow_set_foreground_for_child_process(shared.id());
  let out = shared
    .take_stdout()
    .ok_or_else(|| "no stdout on child process".to_string())?;
  let err = shared
    .take_stderr()
    .ok_or_else(|| "no stderr on child process".to_string())?;

  let shared = Arc::new(shared);
  {
    let mut g = state.child.lock().map_err(|e| e.to_string())?;
    *g = Some(Arc::clone(&shared));
  }

  let h1 = app.clone();
  let h2 = app.clone();
  spawn_log_thread(h1, "stdout", out);
  spawn_log_thread(h2, "stderr", err);
  let h3 = app.clone();
  spawn_wait_thread(h3, Arc::clone(&shared));

  resurface_ide_for_child_process(app);

  Ok(())
}

#[tauri::command]
fn list_games(app: tauri::AppHandle) -> Result<Vec<GameInfo>, String> {
  let base = app_workspace_dir(&app)?;
  let s = load_or_init_games_state(&base)?;
  Ok(s.games)
}

#[tauri::command]
fn get_active_game(app: tauri::AppHandle) -> Result<GameInfo, String> {
  let base = app_workspace_dir(&app)?;
  let s = load_or_init_games_state(&base)?;
  s.games
    .iter()
    .find(|g| g.id == s.active_id)
    .cloned()
    .ok_or_else(|| "no active project".to_string())
}

#[tauri::command]
fn create_game(
  app: tauri::AppHandle,
  state: State<'_, Arc<RunnerState>>,
  name: String,
) -> Result<GameInfo, String> {
  let base = app_workspace_dir(&app)?;
  stop_runner_and_notify(&app, &*state)?;
  let name = sanitize_game_name(&name);
  let id = Uuid::new_v4().to_string();
  let gdir = base.join(GAMES_DIR).join(&id);
  if gdir.exists() {
    return Err("project id conflict — try again".to_string());
  }
  create_default_game_in_dir(&gdir)?;
  let mut gs = load_or_init_games_state(&base)?;
  let info = GameInfo { id, name };
  gs.games.push(info.clone());
  gs.active_id = info.id.clone();
  save_games_state(&base, &gs)?;
  let _ = app.emit("project-changed", serde_json::Value::Null);
  Ok(info)
}

#[tauri::command]
fn open_game(
  app: tauri::AppHandle,
  state: State<'_, Arc<RunnerState>>,
  id: String,
) -> Result<GameInfo, String> {
  if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
    return Err("invalid id".to_string());
  }
  let base = app_workspace_dir(&app)?;
  stop_runner_and_notify(&app, &*state)?;
  let mut gs = load_or_init_games_state(&base)?;
  if !gs.games.iter().any(|g| g.id == id) {
    return Err("project not found".to_string());
  }
  let d = base.join(GAMES_DIR).join(&id);
  if !d.is_dir() {
    return Err("project folder is missing on disk".to_string());
  }
  gs.active_id = id;
  save_games_state(&base, &gs)?;
  let info = gs
    .games
    .iter()
    .find(|g| g.id == gs.active_id)
    .expect("active game")
    .clone();
  let _ = app.emit("project-changed", serde_json::Value::Null);
  Ok(info)
}

#[tauri::command]
fn rename_current_game(
  app: tauri::AppHandle,
  name: String,
) -> Result<GameInfo, String> {
  let name = sanitize_game_name(&name);
  let base = app_workspace_dir(&app)?;
  let mut gs = load_or_init_games_state(&base)?;
  let i = gs
    .games
    .iter()
    .position(|g| g.id == gs.active_id)
    .ok_or("active project not in list")?;
  gs.games[i].name = name.clone();
  save_games_state(&base, &gs)?;
  let _ = app.emit("project-changed", serde_json::Value::Null);
  Ok(gs.games[i].clone())
}

#[tauri::command]
fn delete_game(
  app: tauri::AppHandle,
  state: State<'_, Arc<RunnerState>>,
  id: String,
) -> Result<(), String> {
  if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
    return Err("invalid id".to_string());
  }
  let base = app_workspace_dir(&app)?;
  let mut gs = load_or_init_games_state(&base)?;
  if gs.games.len() <= 1 {
    return Err("keep at least one project".to_string());
  }
  if !gs.games.iter().any(|g| g.id == id) {
    return Err("project not found".to_string());
  }
  stop_runner_and_notify(&app, &*state)?;
  let gpath = base.join(GAMES_DIR).join(&id);
  if gpath.is_dir() {
    fs::remove_dir_all(&gpath).map_err(|e| e.to_string())?;
  }
  gs.games.retain(|g| g.id != id);
  if gs.active_id == id {
    gs.active_id = gs.games[0].id.clone();
  }
  save_games_state(&base, &gs)?;
  let _ = app.emit("project-changed", serde_json::Value::Null);
  Ok(())
}

/// Safe folder name segment for export directory (e.g. `My_Snake_play`).
fn folder_base_from_game_name(name: &str) -> String {
  let t = name.trim();
  if t.is_empty() {
    return "game".to_string();
  }
  let mut o = String::new();
  for c in t.chars().take(40) {
    if c.is_alphanumeric() || c == ' ' || c == '_' || c == '-' {
      o.push(c);
    } else {
      o.push('_');
    }
  }
  let o = o.trim().replace(' ', "_");
  if o.is_empty() {
    "game".to_string()
  } else {
    o
  }
}

fn make_unique_export_dir(parent: &Path, game_name: &str) -> PathBuf {
  let seg = folder_base_from_game_name(game_name);
  let base = format!("{seg}_play");
  if !parent.join(&base).exists() {
    return parent.join(&base);
  }
  let mut n = 2u32;
  loop {
    let candidate = format!("{base}_{n}");
    let p = parent.join(&candidate);
    if !p.exists() {
      return p;
    }
    n += 1;
  }
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ExportResult {
  pub path: String,
  pub label: String,
}

#[tauri::command]
fn export_active_game(app: tauri::AppHandle, parent_path: String) -> Result<ExportResult, String> {
  if parent_path.is_empty() {
    return Err("no destination".to_string());
  }
  let parent = PathBuf::from(&parent_path);
  if !parent.is_dir() {
    return Err("not a directory".to_string());
  }
  let wbase = app_workspace_dir(&app)?;
  let st = load_or_init_games_state(&wbase)?;
  let ag = st
    .games
    .iter()
    .find(|g| g.id == st.active_id)
    .ok_or_else(|| "no active project".to_string())?
    .clone();
  let src = wbase.join(GAMES_DIR).join(&st.active_id);
  if !src.is_dir() {
    return Err("project folder missing".to_string());
  }
  ensure_game_dir_flat(&src)?;
  let out_root = make_unique_export_dir(&parent, &ag.name);
  fs::create_dir_all(&out_root).map_err(|e| e.to_string())?;

  let main_src = src.join("main.py");
  if !main_src.is_file() {
    return Err("main.py is missing in project".to_string());
  }
  fs::copy(&main_src, &out_root.join("main.py")).map_err(|e| e.to_string())?;

  let mut names: Vec<String> = vec![];
  for e in fs::read_dir(&src).map_err(|e| e.to_string())? {
    let e = e.map_err(|e| e.to_string())?;
    let p = e.path();
    if !p.is_file() {
      continue;
    }
    let name = e.file_name().to_string_lossy().into_owned();
    if is_reserved_data_filename(&name) {
      continue;
    }
    fs::copy(&p, &out_root.join(&name)).map_err(|e| e.to_string())?;
    names.push(name);
  }
  names.sort();

  let manifest = serde_json::json!({
    "format": 1,
    "name": &ag.name,
    "main": "main.py",
    "files": &names
  });
  fs::write(
    out_root.join("export_manifest.json"),
    serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
  )
  .map_err(|e| e.to_string())?;

  let uline_len = ag.name.chars().count().max(8).min(48);
  let uline: String = (0..uline_len).map(|_| '=').collect();
  let mut readm = format!("{}\n{}\n\n", ag.name, uline);
  readm.push_str(
    "Contents\n  main.py                 — your code (e.g. pygame, turtle, stdlib)\n  export_manifest.json   — project name + list of other files in this folder\n  run.sh / run.bat        — start (or: python3 main.py from this folder)\n\n",
  );
  readm.push_str("How to play\n  1)  Optional: python3 -m pip install pygame  (turtle is in the stdlib)\n  2)  From this folder:  python3 main.py   (or double-click run.bat on Windows)\n\n");
  readm.push_str("Other game files in this folder (load by filename, same as in your code):\n");
  if names.is_empty() {
    readm.push_str("  (none)\n");
  } else {
    for n in &names {
      readm.push_str("  * ");
      readm.push_str(n);
      readm.push('\n');
    }
  }
  fs::write(&out_root.join("README.txt"), &readm).map_err(|e| e.to_string())?;

  let sh = r#"#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then exec python3 main.py; fi
if command -v python >/dev/null 2>&1; then exec python main.py; fi
echo "Install Python 3, then: python3 -m pip install pygame  # optional, for pygame"
exit 1
"#;
  let shp = out_root.join("run.sh");
  fs::write(&shp, sh).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = fs::metadata(&shp) {
      let mut p = m.permissions();
      p.set_mode(0o755);
      let _ = fs::set_permissions(&shp, p);
    }
  }

  let bat = r#"@echo off
cd /d "%~dp0"
where python3 >nul 2>&1 && python3 main.py & goto :done
where python >nul 2>&1 && python main.py & goto :done
where py >nul 2>&1 && py -3 main.py & goto :done
echo Install Python 3, then: pip install pygame  ^(optional for pygame; turtle is built in^)
pause
:done
"#;
  fs::write(&out_root.join("run.bat"), bat).map_err(|e| e.to_string())?;

  let out_str = out_root
    .canonicalize()
    .unwrap_or(out_root);
  let path_str = out_str
    .to_str()
    .ok_or("invalid path")?
    .to_string();
  let label = out_str
    .file_name()
    .and_then(|n| n.to_str())
    .unwrap_or("export")
    .to_string();
  Ok(ExportResult { path: path_str, label })
}

#[tauri::command]
fn read_main(app: tauri::AppHandle) -> Result<String, String> {
  let dir = active_sandbox_dir(&app)?;
  let p = dir.join("main.py");
  if !p.is_file() {
    fs::write(&p, DEFAULT_MAIN_PY).map_err(|e| e.to_string())?;
  }
  fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_main(app: tauri::AppHandle, content: String) -> Result<(), String> {
  let dir = active_sandbox_dir(&app)?;
  let p = dir.join("main.py");
  fs::write(&p, content).map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
fn list_assets(app: tauri::AppHandle) -> Result<Vec<String>, String> {
  let root = active_sandbox_dir(&app)?;
  if !root.is_dir() {
    return Ok(vec![]);
  }
  let mut names: Vec<String> = fs::read_dir(&root)
    .map_err(|e| e.to_string())?
    .filter_map(|e| e.ok())
    .filter(|e| e.path().is_file())
    .map(|e| e.file_name().to_string_lossy().into_owned())
    .filter(|n| !is_reserved_data_filename(n))
    .collect();
  names.sort();
  Ok(names)
}

/// Absolute path to a data file in the project folder, for `convertFileSrc` in the webview.
#[tauri::command]
fn resolve_asset_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
  if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
    return Err("invalid name".to_string());
  }
  if is_reserved_data_filename(&name) {
    return Err("invalid name".to_string());
  }
  let p = active_sandbox_dir(&app)?.join(&name);
  if !p.is_file() {
    return Err("not found".to_string());
  }
  let p = p.canonicalize().map_err(|e| e.to_string())?;
  p.to_str()
    .ok_or_else(|| "bad path".to_string())
    .map(str::to_string)
}

#[tauri::command]
fn import_asset_path(app: tauri::AppHandle, from_path: String) -> Result<String, String> {
  let root = active_sandbox_dir(&app)?;
  let name = copy_import(&from_path, &root)?;
  let _ = app.emit("assets-updated", serde_json::Value::Null);
  Ok(name)
}

#[tauri::command]
fn remove_asset(app: tauri::AppHandle, name: String) -> Result<(), String> {
  if name.contains("..") || name.contains('/') || name.contains('\\') {
    return Err("invalid name".to_string());
  }
  if is_reserved_data_filename(&name) {
    return Err("cannot remove main.py from here — edit it in the code panel".to_string());
  }
  let p = active_sandbox_dir(&app)?.join(&name);
  if p.is_file() {
    fs::remove_file(p).map_err(|e| e.to_string())?;
  }
  let _ = app.emit("assets-updated", serde_json::Value::Null);
  Ok(())
}

#[tauri::command]
fn rename_asset(app: tauri::AppHandle, from: String, to: String) -> Result<String, String> {
  for s in [&from, &to] {
    if s.is_empty() || s.contains("..") || s.contains('/') || s.contains('\\') {
      return Err("invalid name".to_string());
    }
  }
  if is_reserved_data_filename(&to) {
    return Err("that name is reserved for your project code (main.py)".to_string());
  }
  if is_reserved_data_filename(&from) {
    return Err("cannot rename main.py from the asset list".to_string());
  }
  if from == to {
    return Ok(to);
  }
  let a = active_sandbox_dir(&app)?;
  let src = a.join(&from);
  if !src.is_file() {
    return Err("source not found".to_string());
  }
  let final_to = unique_name(&a, &to);
  let dst = a.join(&final_to);
  if dst != src {
    if dst.exists() {
      return Err("target exists".to_string());
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
  }
  let _ = app.emit("assets-updated", serde_json::Value::Null);
  Ok(final_to)
}

#[tauri::command]
fn run_sandbox(
  app: tauri::AppHandle,
  state: State<'_, Arc<RunnerState>>,
) -> Result<(), String> {
  run_inner(&app, &*state)
}

#[tauri::command]
fn stop_sandbox(
  _app: tauri::AppHandle,
  state: State<'_, Arc<RunnerState>>,
) -> Result<(), String> {
  stop_child(&*state)
}

fn import_path_drop(app: &tauri::AppHandle, path: &Path) {
  if !path.is_file() {
    return;
  }
  let s = path.to_string_lossy().to_string();
  let ws = match active_sandbox_dir(app) {
    Ok(w) => w,
    Err(e) => {
      let _ = app.emit("import-asset-err", e);
      return;
    }
  };
  match copy_import(&s, &ws) {
    Ok(name) => {
      let _ = app.emit("import-asset-ok", name);
    }
    Err(e) => {
      let _ = app.emit("import-asset-err", e);
    }
  }
  let _ = app.emit("assets-updated", serde_json::Value::Null);
}

// ---- Google Gemini (Generative Language API) — key on disk, requests from Rust ----

fn gemini_key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(base.join("gemini_api_key"))
}

#[tauri::command]
fn save_gemini_api_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
  let key = key.trim();
  let p = gemini_key_path(&app)?;
  if key.is_empty() {
    if p.is_file() {
      fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    return Ok(());
  }
  if let Some(parent) = p.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&p, key.as_bytes()).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = fs::metadata(&p) {
      let mut perm = m.permissions();
      perm.set_mode(0o600);
      let _ = fs::set_permissions(&p, perm);
    }
  }
  Ok(())
}

#[tauri::command]
fn gemini_key_configured(app: tauri::AppHandle) -> Result<bool, String> {
  let p = gemini_key_path(&app)?;
  if !p.is_file() {
    return Ok(false);
  }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
  Ok(!s.trim().is_empty())
}

fn read_gemini_api_key(app: &tauri::AppHandle) -> Result<String, String> {
  let p = gemini_key_path(app)?;
  if !p.is_file() {
    return Err("add an API key first".to_string());
  }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
  let t = s.trim();
  if t.is_empty() {
    return Err("add an API key first".to_string());
  }
  Ok(t.to_string())
}

// ---- OpenAI (Chat Completions) — key on disk, requests from Rust ----

fn openai_key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(base.join("openai_api_key"))
}

#[tauri::command]
fn save_openai_api_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
  let key = key.trim();
  let p = openai_key_path(&app)?;
  if key.is_empty() {
    if p.is_file() {
      fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    return Ok(());
  }
  if let Some(parent) = p.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&p, key.as_bytes()).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = fs::metadata(&p) {
      let mut perm = m.permissions();
      perm.set_mode(0o600);
      let _ = fs::set_permissions(&p, perm);
    }
  }
  Ok(())
}

#[tauri::command]
fn openai_key_configured(app: tauri::AppHandle) -> Result<bool, String> {
  let p = openai_key_path(&app)?;
  if !p.is_file() {
    return Ok(false);
  }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
  Ok(!s.trim().is_empty())
}

fn read_openai_api_key(app: &tauri::AppHandle) -> Result<String, String> {
  let p = openai_key_path(app)?;
  if !p.is_file() {
    return Err("add an OpenAI API key first".to_string());
  }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
  let t = s.trim();
  if t.is_empty() {
    return Err("add an OpenAI API key first".to_string());
  }
  Ok(t.to_string())
}

// ---- PixelLab (https://api.pixellab.ai/v2) — key on disk, requests from Rust (see v2/llms.txt) ----

const PIXELLAB_V2: &str = "https://api.pixellab.ai/v2";

fn pixellab_key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(base.join("pixellab_api_key"))
}

#[tauri::command]
fn save_pixellab_api_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
  let key = key.trim();
  let p = pixellab_key_path(&app)?;
  if key.is_empty() {
    if p.is_file() {
      fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    return Ok(());
  }
  if let Some(parent) = p.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&p, key.as_bytes()).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = fs::metadata(&p) {
      let mut perm = m.permissions();
      perm.set_mode(0o600);
      let _ = fs::set_permissions(&p, perm);
    }
  }
  Ok(())
}

#[tauri::command]
fn pixellab_key_configured(app: tauri::AppHandle) -> Result<bool, String> {
  let p = pixellab_key_path(&app)?;
  if !p.is_file() {
    return Ok(false);
  }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
  Ok(!s.trim().is_empty())
}

fn read_pixellab_api_key(app: &tauri::AppHandle) -> Result<String, String> {
  let p = pixellab_key_path(app)?;
  if !p.is_file() {
    return Err("add a PixelLab API token first (pixellab.ai account)".to_string());
  }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
  let t = s.trim();
  if t.is_empty() {
    return Err("add a PixelLab API token first".to_string());
  }
  Ok(t.to_string())
}

fn pixellab_http_client() -> Result<reqwest::blocking::Client, String> {
  reqwest::blocking::Client::builder()
    .connect_timeout(HTTP_CONNECT_TIMEOUT)
    .timeout(HTTP_LONG_JOB_TIMEOUT)
    .build()
    .map_err(|e| e.to_string())
}

fn pixellab_get_path_ok(path: &str) -> bool {
  let path_only = path.split('?').next().unwrap_or(path);
  if path_only == "/balance" {
    return true;
  }
  if path_only == "/characters" {
    return true;
  }
  if let Some(r) = path_only.strip_prefix("/background-jobs/") {
    let id = r.trim_end_matches('/');
    return is_valid_chat_id(id);
  }
  if let Some(r) = path_only.strip_prefix("/isometric-tiles/") {
    let id = r.split('/').next().unwrap_or(r);
    return is_valid_chat_id(id);
  }
  if let Some(r) = path_only.strip_prefix("/tilesets/") {
    let segs: Vec<&str> = r.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() == 1 {
      return is_valid_chat_id(segs[0]);
    }
  }
  if let Some(r) = path_only.strip_prefix("/characters/") {
    let segs: Vec<&str> = r.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
      return false;
    }
    if !is_valid_chat_id(segs[0]) {
      return false;
    }
    if segs.len() == 1 {
      return true;
    }
    if segs.len() == 2 && (segs[1] == "zip" || segs[1] == "animations") {
      return true;
    }
  }
  false
}

const PIXELLAB_POST_PATHS: &[&str] = &[
  "/create-image-pixflux",
  "/generate-image-v2",
  "/create-character-with-4-directions",
  "/create-character-with-8-directions",
  "/create-isometric-tile",
  "/map-objects",
  // Follow-ups for existing characters (see https://api.pixellab.ai/v2/llms.txt)
  "/animate-character",
  "/characters/animations",
  "/generate-with-style-v2",
  "/generate-8-rotations-v2",
  // Still + motion: image → animation (v3 returns a background job; poll for frames)
  "/animate-with-text-v3",
  "/create-tileset",
  "/image-to-pixelart",
  "/remove-background",
];

fn pixellab_post_path_ok(path: &str) -> bool {
  path.split('?').next().is_some_and(|p| PIXELLAB_POST_PATHS.contains(&p))
}

/// GET `https://api.pixellab.ai/v2` + path (path may include `?…` for `/characters?limit=…`).
#[tauri::command]
fn pixellab_v2_get(app: tauri::AppHandle, path: String) -> Result<String, String> {
  if !path.starts_with('/') || path.contains("..") {
    return Err("invalid path".to_string());
  }
  if !pixellab_get_path_ok(&path) {
    return Err("request not allowed".to_string());
  }
  let key = read_pixellab_api_key(&app)?;
  let url = format!("{PIXELLAB_V2}{path}");
  let client = pixellab_http_client()?;
  let res = client
    .get(&url)
    .header("Authorization", format!("Bearer {key}"))
    .header("Accept", "application/json")
    .send()
    .map_err(|e| e.to_string())?;
  let status = res.status();
  let text = res.text().map_err(|e| e.to_string())?;
  if !status.is_success() {
    return Err(format!("PixelLab HTTP {status}: {text}"));
  }
  Ok(text)
}

/// POST JSON to an allowlisted PixelLab v2 path; returns response body (JSON text).
#[tauri::command]
fn pixellab_v2_post(app: tauri::AppHandle, path: String, body: serde_json::Value) -> Result<String, String> {
  if !path.starts_with('/') || path.contains("..") {
    return Err("invalid path".to_string());
  }
  if !pixellab_post_path_ok(&path) {
    return Err("request not allowed".to_string());
  }
  let key = read_pixellab_api_key(&app)?;
  let url = format!("{PIXELLAB_V2}{path}");
  let client = pixellab_http_client()?;
  let res = client
    .post(&url)
    .header("Authorization", format!("Bearer {key}"))
    .header("Content-Type", "application/json")
    .json(&body)
    .send()
    .map_err(|e| e.to_string())?;
  let status = res.status();
  let text = res.text().map_err(|e| e.to_string())?;
  if !status.is_success() {
    return Err(format!("PixelLab HTTP {status}: {text}"));
  }
  Ok(text)
}

// ---- Midjourney text-to-image via WaveSpeed AI (https://api.wavespeed.ai/api/v3/...) ----
// Midjourney does not publish a first-party HTTP API; WaveSpeed hosts a Midjourney model with a stable REST surface.

const WAVESPEED_API_V3: &str = "https://api.wavespeed.ai/api/v3";

fn midjourney_key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(base.join("midjourney_wavespeed_api_key"))
}

#[tauri::command]
fn save_midjourney_api_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
  let key = key.trim();
  let p = midjourney_key_path(&app)?;
  if key.is_empty() {
    if p.is_file() {
      fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    return Ok(());
  }
  if let Some(parent) = p.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&p, key.as_bytes()).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = fs::metadata(&p) {
      let mut perm = m.permissions();
      perm.set_mode(0o600);
      let _ = fs::set_permissions(&p, perm);
    }
  }
  Ok(())
}

#[tauri::command]
fn midjourney_key_configured(app: tauri::AppHandle) -> Result<bool, String> {
  let p = midjourney_key_path(&app)?;
  if !p.is_file() {
    return Ok(false);
  }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
  Ok(!s.trim().is_empty())
}

fn read_midjourney_api_key(app: &tauri::AppHandle) -> Result<String, String> {
  let p = midjourney_key_path(app)?;
  if !p.is_file() {
    return Err("add a WaveSpeed API key first (wavespeed.ai — Midjourney text-to-image)".to_string());
  }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
  let t = s.trim();
  if t.is_empty() {
    return Err("add a WaveSpeed API key first".to_string());
  }
  Ok(t.to_string())
}

fn wavespeed_http_client() -> Result<reqwest::blocking::Client, String> {
  reqwest::blocking::Client::builder()
    .connect_timeout(HTTP_CONNECT_TIMEOUT)
    .timeout(HTTP_LONG_JOB_TIMEOUT)
    .build()
    .map_err(|e| e.to_string())
}

fn is_safe_wavespeed_prediction_id(id: &str) -> bool {
  let id = id.trim();
  (8..=128).contains(&id.len())
    && id
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
fn wavespeed_midjourney_submit(app: tauri::AppHandle, body: serde_json::Value) -> Result<String, String> {
  let key = read_midjourney_api_key(&app)?;
  let url = format!("{WAVESPEED_API_V3}/midjourney/text-to-image");
  let client = wavespeed_http_client()?;
  let res = client
    .post(&url)
    .header("Authorization", format!("Bearer {key}"))
    .header("Content-Type", "application/json")
    .header("Accept", "application/json")
    .json(&body)
    .send()
    .map_err(|e| e.to_string())?;
  let status = res.status();
  let text = res.text().map_err(|e| e.to_string())?;
  if !status.is_success() {
    return Err(format!("WaveSpeed HTTP {status}: {text}"));
  }
  Ok(text)
}

#[tauri::command]
fn wavespeed_midjourney_prediction_result(
  app: tauri::AppHandle,
  prediction_id: String,
) -> Result<String, String> {
  let id = prediction_id.trim();
  if !is_safe_wavespeed_prediction_id(id) {
    return Err("invalid prediction id".to_string());
  }
  let key = read_midjourney_api_key(&app)?;
  let url = format!("{WAVESPEED_API_V3}/predictions/{id}/result");
  let client = wavespeed_http_client()?;
  let res = client
    .get(&url)
    .header("Authorization", format!("Bearer {key}"))
    .header("Accept", "application/json")
    .send()
    .map_err(|e| e.to_string())?;
  let status = res.status();
  let text = res.text().map_err(|e| e.to_string())?;
  if !status.is_success() {
    return Err(format!("WaveSpeed HTTP {status}: {text}"));
  }
  Ok(text)
}

fn mj_output_download_host_ok(host: &str) -> bool {
  let h = host.to_ascii_lowercase();
  h.ends_with("wavespeed.ai") || h.ends_with("wavespeedcdn.ai")
}

/// HTTPS GET for a generated image URL (WaveSpeed CDN only — avoids open SSRF).
#[tauri::command]
fn fetch_mj_output_bytes(url: String) -> Result<Vec<u8>, String> {
  let u = url.trim();
  let parsed = reqwest::Url::parse(u).map_err(|_| "invalid image url".to_string())?;
  if parsed.scheme() != "https" {
    return Err("only https image urls".to_string());
  }
  let host = parsed.host_str().unwrap_or("");
  if !mj_output_download_host_ok(host) {
    return Err("image host is not a WaveSpeed download domain".to_string());
  }
  let client = wavespeed_http_client()?;
  let res = client.get(u).send().map_err(|e| e.to_string())?;
  let status = res.status();
  if !status.is_success() {
    return Err(format!("download HTTP {status}"));
  }
  let bytes = res.bytes().map_err(|e| e.to_string())?;
  if bytes.is_empty() {
    return Err("empty image".to_string());
  }
  if bytes.len() > 32 * 1024 * 1024 {
    return Err("image too large".to_string());
  }
  Ok(bytes.to_vec())
}

/// Write a PNG (or any bytes) into a game folder next to `main.py` with collision-safe name.
/// `project_id` is the [`GameInfo::id`] for the target project; use `None` for the currently active project.
#[tauri::command]
fn write_project_asset_bytes(
  app: tauri::AppHandle,
  filename: String,
  data: Vec<u8>,
  project_id: Option<String>,
) -> Result<String, String> {
  if data.is_empty() {
    return Err("empty data".to_string());
  }
  let name = filename.trim();
  if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
    return Err("invalid file name".to_string());
  }
  if is_reserved_data_filename(name) {
    return Err("that name is reserved for project code (main.py)".to_string());
  }
  let root = match project_id.as_deref() {
    None | Some("") => active_sandbox_dir(&app)?,
    Some(id) => game_sandbox_dir_by_id(&app, id)?,
  };
  let final_name = unique_name(&root, name);
  let p = root.join(&final_name);
  fs::write(&p, data).map_err(|e| e.to_string())?;
  let _ = app.emit("assets-updated", serde_json::Value::Null);
  Ok(final_name)
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct GeminiTurn {
  pub role: String,
  pub text: String,
}

// 2.0 is no longer available to new API key holders; use 2.5+.
// Gemini 3.x (Google AI model docs). Live / TTS models use other API surfaces, not streamGenerateContent.
const GEMINI_MODEL_ALLOWLIST: &[&str] = &[
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

const OPENAI_MODEL_ALLOWLIST: &[&str] = &[
  "gpt-5.4",
  "gpt-5.4-2026-03-05",
  "gpt-5.4-pro",
  "gpt-5.4-pro-2026-03-05",
  "gpt-5.4-mini",
  "gpt-5.4-mini-2026-03-17",
  "gpt-5.4-nano",
  "gpt-5.4-nano-2026-03-17",
  "gpt-5.2",
  "gpt-5.2-2025-12-11",
  "gpt-5.1",
  "gpt-5.1-2025-11-13",
  "gpt-5",
  "gpt-5-2025-08-07",
  "gpt-5-mini",
  "gpt-5-mini-2025-08-07",
  "gpt-5-nano",
  "gpt-5-nano-2025-08-07",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
];

fn validate_model_for_provider(provider: &str, model: &str) -> Result<(), String> {
  match provider {
    "gemini" => {
      if !GEMINI_MODEL_ALLOWLIST.contains(&model) {
        return Err("unsupported model".to_string());
      }
    }
    "gpt" => {
      if !OPENAI_MODEL_ALLOWLIST.contains(&model) {
        return Err("unsupported model".to_string());
      }
    }
    _ => return Err("invalid provider".to_string()),
  }
  Ok(())
}

/// Concatenate `parts[].text` in one streamed JSON chunk (metadata-only → empty string).
/// Do not short-circuit on `SAFETY` before reading `parts` — a chunk can include text + finish reason.
fn gemini_chunk_text(v: &serde_json::Value) -> String {
  let mut out = String::new();
  let Some(arr) = v.get("candidates").and_then(|c| c.as_array()) else {
    return out;
  };
  for first in arr.iter().take(1) {
    let Some(parts) = first
      .get("content")
      .and_then(|c| c.get("parts"))
      .and_then(|p| p.as_array())
    else {
      continue;
    };
    for p in parts {
      // Skip model “thinking” fragments when explicitly flagged (2.x thinking models)
      if p.get("thought").and_then(|t| t.as_bool()) == Some(true) {
        continue;
      }
      if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
        if !t.is_empty() {
          out.push_str(t);
        }
      }
    }
  }
  out
}

fn build_gemini_request_body(contents: &[GeminiTurn]) -> serde_json::Value {
  let parts: Vec<serde_json::Value> = contents
    .iter()
    .map(|t| {
      serde_json::json!({
        "role": t.role,
        "parts": [{"text": t.text}]
      })
    })
    .collect();
  serde_json::json!({
    "contents": parts,
    "generationConfig": {
      // 8192 was easy to hit on long code / reasoning-heavy replies; models cap as needed.
      "maxOutputTokens": 32768u32,
      "temperature": 0.9
    }
  })
}

fn validate_gemini_chat(contents: &[GeminiTurn]) -> Result<(), String> {
  if contents.is_empty() {
    return Err("no messages to send".to_string());
  }
  let last = contents.last().ok_or("no messages")?;
  if last.role != "user" {
    return Err("last turn must be a user message".to_string());
  }
  for t in contents {
    if t.role != "user" && t.role != "model" {
      return Err("messages must use roles user and model only".to_string());
    }
  }
  Ok(())
}

/// Runs `streamGenerateContent` in a background thread; emits
/// `gemini-stream-chunk` (String), `gemini-stream-done`, `gemini-stream-error` (String).
#[tauri::command]
fn gemini_start_stream(app: tauri::AppHandle, model: String, contents: Vec<GeminiTurn>) -> Result<(), String> {
  if !GEMINI_MODEL_ALLOWLIST.contains(&model.as_str()) {
    return Err("unsupported model".to_string());
  }
  validate_gemini_chat(&contents)?;
  let key = read_gemini_api_key(&app)?;
  let body = build_gemini_request_body(&contents);
  let app_thread = app.clone();
  let url = format!(
    "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent",
    model
  );
  std::thread::spawn(move || {
    let client = match reqwest::blocking::Client::builder()
      .connect_timeout(HTTP_CONNECT_TIMEOUT)
      .tcp_keepalive(HTTP_STREAM_TCP_KEEPALIVE)
      // No end-to-end timeout: slow models can stream longer than any fixed wall-clock limit.
      .timeout(None)
      .build()
    {
      Ok(c) => c,
      Err(e) => {
        let _ = app_thread.emit("gemini-stream-error", e.to_string());
        return;
      }
    };
    // `alt=sse` is required for `data: …` line-delimited SSE. Without it, the API can return
    // a different shape (or buffer as one JSON), so we never see line-by-line text.
    let res = match client
      .post(&url)
      .query(&[("key", key.as_str()), ("alt", "sse")])
      .json(&body)
      .send()
    {
      Ok(r) => r,
      Err(e) => {
        let _ = app_thread.emit("gemini-stream-error", format!("network: {e}"));
        return;
      }
    };
    let status = res.status();
    if !status.is_success() {
      let text = res.text().unwrap_or_default();
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(msg) = v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
          let _ = app_thread.emit("gemini-stream-error", msg.to_string());
          return;
        }
      }
      let _ = app_thread.emit("gemini-stream-error", format!("API error (HTTP {status}): {text}"));
      return;
    }
    let mut reader = BufReader::new(res);
    let mut line = String::new();
    let mut any_chunk = false;
    loop {
      line.clear();
      match reader.read_line(&mut line) {
        Ok(0) => break,
        Ok(_) => {}
        Err(e) => {
          let _ = app_thread.emit("gemini-stream-error", e.to_string());
          return;
        }
      }
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      let json_str = if trimmed
        .get(..5)
        .is_some_and(|h| h.eq_ignore_ascii_case("data:"))
      {
        trimmed[5..].trim()
      } else {
        trimmed
      };
      let json_str = json_str.trim_start_matches('\u{feff}');
      if json_str == "[DONE]" {
        break;
      }
      let v: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => continue,
      };
      if v.get("error").is_some() {
        let msg = v
          .get("error")
          .and_then(|e| e.get("message"))
          .and_then(|m| m.as_str())
          .unwrap_or("API error");
        let _ = app_thread.emit("gemini-stream-error", msg.to_string());
        return;
      }
      if let Some(pb) = v.get("promptFeedback") {
        if let Some(b) = pb.get("blockReason") {
          let _ = app_thread.emit("gemini-stream-error", format!("request blocked: {b}"));
          return;
        }
      }
      if let Some(arr) = v.get("candidates").and_then(|c| c.as_array()) {
        if let Some(c0) = arr.first() {
          if c0.get("finishReason").and_then(|r| r.as_str()) == Some("SAFETY") {
            let _ = app_thread.emit(
              "gemini-stream-error",
              "model stopped the reply for safety reasons",
            );
            return;
          }
        }
      }
      let piece = gemini_chunk_text(&v);
      if !piece.is_empty() {
        any_chunk = true;
        emit_ai_stream_text(&app_thread, "gemini-stream-chunk", &piece);
      }
    }
    if !any_chunk {
      let _ = app_thread.emit("gemini-stream-error", "empty reply from model");
      return;
    }
    let _ = app_thread.emit("gemini-stream-done", "");
  });
  Ok(())
}

fn openai_chunk_text(v: &serde_json::Value) -> String {
  let mut out = String::new();
  let Some(choices) = v.get("choices").and_then(|c| c.as_array()) else {
    return out;
  };
  for ch in choices {
    let Some(delta) = ch.get("delta") else {
      continue;
    };
    let Some(content) = delta.get("content") else {
      continue;
    };
    match content {
      serde_json::Value::String(s) => out.push_str(s),
      serde_json::Value::Array(parts) => {
        for p in parts {
          if let Some(t) = p.get("text").and_then(|x| x.as_str()) {
            out.push_str(t);
          } else if let Some(s) = p.as_str() {
            out.push_str(s);
          }
        }
      }
      _ => {}
    }
  }
  out
}

fn build_openai_messages(contents: &[GeminiTurn]) -> Vec<serde_json::Value> {
  contents
    .iter()
    .map(|t| {
      let role = if t.role == "model" {
        "assistant"
      } else {
        "user"
      };
      serde_json::json!({
        "role": role,
        "content": t.text
      })
    })
    .collect()
}

/// Chat Completions streaming; emits `openai-stream-chunk`, `openai-stream-done`, `openai-stream-error`.
#[tauri::command]
fn openai_start_stream(app: tauri::AppHandle, model: String, contents: Vec<GeminiTurn>) -> Result<(), String> {
  validate_model_for_provider("gpt", &model)?;
  validate_gemini_chat(&contents)?;
  let key = read_openai_api_key(&app)?;
  let messages = build_openai_messages(&contents);
  let m = model.to_ascii_lowercase();
  // GPT-5+ rejects `max_tokens`; it expects `max_completion_tokens` (Chat Completions).
  let use_max_completion_tokens = m.starts_with("gpt-5");
  let max_out: u32 = if m.starts_with("gpt-5") {
    65536
  } else {
    16384
  };
  let body = if use_max_completion_tokens {
    serde_json::json!({
      "model": model,
      "messages": messages,
      "stream": true,
      "max_completion_tokens": max_out,
      "temperature": 0.9
    })
  } else {
    serde_json::json!({
      "model": model,
      "messages": messages,
      "stream": true,
      "max_tokens": max_out,
      "temperature": 0.9
    })
  };
  let app_thread = app.clone();
  std::thread::spawn(move || {
    let client = match reqwest::blocking::Client::builder()
      .connect_timeout(HTTP_CONNECT_TIMEOUT)
      .tcp_keepalive(HTTP_STREAM_TCP_KEEPALIVE)
      .timeout(None)
      .build()
    {
      Ok(c) => c,
      Err(e) => {
        let _ = app_thread.emit("openai-stream-error", e.to_string());
        return;
      }
    };
    let res = match client
      .post("https://api.openai.com/v1/chat/completions")
      .header("Authorization", format!("Bearer {key}"))
      .header("Content-Type", "application/json")
      .json(&body)
      .send()
    {
      Ok(r) => r,
      Err(e) => {
        let _ = app_thread.emit("openai-stream-error", format!("network: {e}"));
        return;
      }
    };
    let status = res.status();
    if !status.is_success() {
      let text = res.text().unwrap_or_default();
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(msg) = v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
          let _ = app_thread.emit("openai-stream-error", msg.to_string());
          return;
        }
      }
      let _ = app_thread.emit("openai-stream-error", format!("API error (HTTP {status}): {text}"));
      return;
    }
    let mut reader = BufReader::new(res);
    let mut line = String::new();
    let mut any_chunk = false;
    loop {
      line.clear();
      match reader.read_line(&mut line) {
        Ok(0) => break,
        Ok(_) => {}
        Err(e) => {
          let _ = app_thread.emit("openai-stream-error", e.to_string());
          return;
        }
      }
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      let json_str = if trimmed
        .get(..5)
        .is_some_and(|h| h.eq_ignore_ascii_case("data:"))
      {
        trimmed[5..].trim()
      } else {
        trimmed
      };
      let json_str = json_str.trim_start_matches('\u{feff}');
      if json_str == "[DONE]" {
        break;
      }
      let v: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => continue,
      };
      if let Some(msg) = v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
        let _ = app_thread.emit("openai-stream-error", msg.to_string());
        return;
      }
      let piece = openai_chunk_text(&v);
      if !piece.is_empty() {
        any_chunk = true;
        emit_ai_stream_text(&app_thread, "openai-stream-chunk", &piece);
      }
    }
    if !any_chunk {
      let _ = app_thread.emit("openai-stream-error", "empty reply from model");
      return;
    }
    let _ = app_thread.emit("openai-stream-done", "");
  });
  Ok(())
}

// ---- AI chat sessions: separate folders per provider (gemini | gpt) ----

fn ai_chats_dir_for_provider(app: &tauri::AppHandle, provider: &str) -> Result<PathBuf, String> {
  let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let sub = match provider {
    "gemini" => "gemini_chats",
    "gpt" => "gpt_chats",
    _ => return Err("invalid provider".to_string()),
  };
  let d = base.join(sub);
  if !d.is_dir() {
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
  }
  Ok(d)
}

fn now_secs() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs() as i64)
    .unwrap_or(0)
}

fn is_valid_chat_id(id: &str) -> bool {
  Uuid::parse_str(id).is_ok()
}

fn chat_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
  if !is_valid_chat_id(id) {
    return Err("invalid chat id".to_string());
  }
  Ok(dir.join(format!("{id}.json")))
}

fn default_ai_provider() -> String {
  "gemini".to_string()
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct GeminiChatFile {
  pub id: String,
  pub title: String,
  /// `"gemini"` | `"gpt"` — older files omit this and deserialize as Gemini.
  #[serde(default = "default_ai_provider")]
  pub provider: String,
  pub model: String,
  pub updated_at: i64,
  pub turns: Vec<GeminiTurn>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct GeminiChatListItem {
  pub id: String,
  pub title: String,
  pub updated_at: i64,
}

#[tauri::command]
fn list_gemini_chats(app: tauri::AppHandle, provider: String) -> Result<Vec<GeminiChatListItem>, String> {
  if provider != "gemini" && provider != "gpt" {
    return Err("invalid provider".to_string());
  }
  let dir = ai_chats_dir_for_provider(&app, &provider)?;
  let read = match fs::read_dir(&dir) {
    Ok(r) => r,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
    Err(e) => return Err(e.to_string()),
  };
  let mut items: Vec<GeminiChatListItem> = Vec::new();
  for ent in read.flatten() {
    let p = ent.path();
    if !p.extension().is_some_and(|e| e == "json") {
      continue;
    }
    let Ok(text) = fs::read_to_string(&p) else {
      continue;
    };
    if let Ok(f) = serde_json::from_str::<GeminiChatFile>(&text) {
      items.push(GeminiChatListItem {
        id: f.id,
        title: f.title,
        updated_at: f.updated_at,
      });
    }
  }
  items.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
  Ok(items)
}

#[tauri::command]
fn load_gemini_chat(app: tauri::AppHandle, id: String, provider: String) -> Result<GeminiChatFile, String> {
  if provider != "gemini" && provider != "gpt" {
    return Err("invalid provider".to_string());
  }
  let dir = ai_chats_dir_for_provider(&app, &provider)?;
  let p = chat_path(&dir, &id)?;
  if !p.is_file() {
    return Err("chat not found".to_string());
  }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
  serde_json::from_str(&s).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_gemini_conversation(
  app: tauri::AppHandle,
  id: String,
  provider: String,
  title: String,
  model: String,
  turns: Vec<GeminiTurn>,
) -> Result<(), String> {
  validate_model_for_provider(&provider, &model)?;
  let dir = ai_chats_dir_for_provider(&app, &provider)?;
  let p = chat_path(&dir, &id)?;
  for t in &turns {
    if t.role != "user" && t.role != "model" {
      return Err("invalid turn role in saved chat".to_string());
    }
  }
  let title = title.trim().to_string();
  let touch_time = if p.is_file() {
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    if let Ok(prev) = serde_json::from_str::<GeminiChatFile>(&s) {
      if prev.id == id
        && prev.provider == provider
        && prev.model == model
        && prev.title == title
        && prev.turns == turns
      {
        prev.updated_at
      } else {
        now_secs()
      }
    } else {
      now_secs()
    }
  } else {
    now_secs()
  };
  let file = GeminiChatFile {
    id: id.clone(),
    title,
    provider,
    model,
    updated_at: touch_time,
    turns,
  };
  let s = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
  fs::write(&p, s).map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
fn new_gemini_chat(app: tauri::AppHandle, provider: String) -> Result<String, String> {
  let (def_model, prov) = match provider.as_str() {
    "gpt" => ("gpt-5.4", "gpt"),
    "gemini" => ("gemini-2.5-flash", "gemini"),
    _ => return Err("invalid provider".to_string()),
  };
  let id = Uuid::new_v4().to_string();
  let dir = ai_chats_dir_for_provider(&app, prov)?;
  let p = chat_path(&dir, &id)?;
  let file = GeminiChatFile {
    id: id.clone(),
    title: "New chat".to_string(),
    provider: prov.to_string(),
    model: def_model.to_string(),
    updated_at: now_secs(),
    turns: vec![],
  };
  let s = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
  fs::write(&p, s).map_err(|e| e.to_string())?;
  Ok(id)
}

#[tauri::command]
fn delete_gemini_chat_file(app: tauri::AppHandle, id: String, provider: String) -> Result<(), String> {
  if provider != "gemini" && provider != "gpt" {
    return Err("invalid provider".to_string());
  }
  let dir = ai_chats_dir_for_provider(&app, &provider)?;
  let p = chat_path(&dir, &id)?;
  if p.is_file() {
    fs::remove_file(&p).map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(Arc::new(RunnerState {
      child: Mutex::new(None),
    }))
    .on_window_event(|window, event: &tauri::WindowEvent| {
      if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position: _ }) =
        event.to_owned()
      {
        let app = window.app_handle().clone();
        for p in paths {
          import_path_drop(&app, p.as_path());
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      list_games,
      get_active_game,
      create_game,
      open_game,
      rename_current_game,
      delete_game,
      export_active_game,
      read_main,
      write_main,
      list_assets,
      resolve_asset_path,
      import_asset_path,
      remove_asset,
      rename_asset,
      run_sandbox,
      stop_sandbox,
      save_gemini_api_key,
      gemini_key_configured,
      save_openai_api_key,
      openai_key_configured,
      save_pixellab_api_key,
      pixellab_key_configured,
      pixellab_v2_get,
      pixellab_v2_post,
      save_midjourney_api_key,
      midjourney_key_configured,
      wavespeed_midjourney_submit,
      wavespeed_midjourney_prediction_result,
      fetch_mj_output_bytes,
      write_project_asset_bytes,
      gemini_start_stream,
      openai_start_stream,
      list_gemini_chats,
      load_gemini_chat,
      save_gemini_conversation,
      new_gemini_chat,
      delete_gemini_chat_file,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

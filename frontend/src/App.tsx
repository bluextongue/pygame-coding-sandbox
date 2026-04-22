import "./App.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Editor, { type OnChange } from "@monaco-editor/react";
import { GeminiPanel } from "./GeminiPanel";

const AUTOSAVE_MS = 600;
const CONSOLE_MAX = 2000;

type RunnerLinePayload = { stream: string; line: string };

type GameInfo = { id: string; name: string };
type ExportResult = { path: string; label: string };

const defaultCode = `# Pygame + pygame — files you add are stored next to main.py; load by filename.
# Example: pygame.image.load("sprite.png")
import pygame

pygame.init()
screen = pygame.display.set_mode((400, 300))
pygame.display.set_caption("Pygame Coding Sandbox")
clock = pygame.time.Clock()
running = True
while running:
  for event in pygame.event.get():
    if event.type == pygame.QUIT:
      running = False
  screen.fill((30, 30, 40))
  pygame.display.flip()
  clock.tick(60)
pygame.quit()
`;

function formatConsoleLine(p: RunnerLinePayload): string {
  const tag =
    p.stream === "info"
      ? "ℹ"
      : p.stream === "stderr"
        ? "ERR"
        : p.stream === "stdout"
          ? "OUT"
          : p.stream;
  return `[${tag}] ${p.line}`;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const AUDIO_RE = /\.(wav|mp3|ogg|flac|m4a|aac)$/i;

function isImageFile(name: string): boolean {
  return IMAGE_RE.test(name);
}
function isAudioFile(name: string): boolean {
  return AUDIO_RE.test(name);
}
function extLabel(name: string): string {
  const m = name.match(/(\.[^.]+)$/);
  return m ? m[1] : "…";
}

/** For rename inputs: place caret just before the last “.” (extension) so the stem is easy to edit. */
function caretIndexBeforeLastDot(filename: string): number {
  const last = filename.lastIndexOf(".");
  if (last <= 0) return filename.length;
  return last;
}

type AssetListItemProps = {
  name: string;
  isEditing: boolean;
  renameBuffer: string;
  onRenameBufferChange: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onBeginRename: () => void;
  onRemove: () => void;
  onPlayUrl: (url: string) => void;
};

function AssetListItem({
  name,
  isEditing,
  renameBuffer,
  onRenameBufferChange,
  onCommitRename,
  onCancelRename,
  onBeginRename,
  onRemove,
  onPlayUrl,
}: AssetListItemProps) {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const assetRenameInputRef = useRef<HTMLInputElement>(null);
  const needPath = isImageFile(name) || isAudioFile(name);
  const showPlay = isAudioFile(name) && mediaUrl;

  useEffect(() => {
    setThumbFailed(false);
    if (!isTauri() || !needPath) {
      setMediaUrl(null);
      setPathLoading(false);
      return;
    }
    setPathLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        const p = (await invoke("resolve_asset_path", { name })) as string;
        if (!cancelled) {
          setMediaUrl(convertFileSrc(p));
        }
      } catch {
        if (!cancelled) setMediaUrl(null);
      } finally {
        if (!cancelled) setPathLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name, needPath]);

  useLayoutEffect(() => {
    if (!isEditing) return;
    const el = assetRenameInputRef.current;
    if (!el) return;
    const i = caretIndexBeforeLastDot(name);
    const setCaret = () => {
      const inp = assetRenameInputRef.current;
      if (inp) inp.setSelectionRange(i, i);
    };
    setCaret();
    const id = requestAnimationFrame(setCaret);
    return () => cancelAnimationFrame(id);
  }, [isEditing, name]);

  return (
    <li className="asset-row">
      <div className="asset-thumb-wrap">
        {isImageFile(name) && mediaUrl && !thumbFailed ? (
          <img
            className="asset-thumb"
            src={mediaUrl}
            alt=""
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <span className="asset-thumb-fallback" title={name}>
            {isImageFile(name) && pathLoading ? "…" : isAudioFile(name) ? "♪" : extLabel(name)}
          </span>
        )}
      </div>
      {isEditing ? (
        <input
          ref={assetRenameInputRef}
          className="asset-rename"
          value={renameBuffer}
          onChange={(e) => onRenameBufferChange(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitRename();
            } else if (e.key === "Escape") {
              onCancelRename();
            }
          }}
          autoFocus
        />
      ) : (
        <button
          type="button"
          className="asset-name"
          onDoubleClick={onBeginRename}
          title="Double-click to rename"
        >
          {name}
        </button>
      )}
      {showPlay ? (
        <button
          type="button"
          className="win-mini-btn asset-play"
          onClick={() => onPlayUrl(mediaUrl!)}
          title="Play"
          aria-label={`Play ${name}`}
        >
          ▶
        </button>
      ) : (
        <span className="asset-play-spacer" aria-hidden />
      )}
      <button
        type="button"
        className="win-mini-btn"
        onClick={onRemove}
        aria-label={`Delete ${name}`}
      >
        Del
      </button>
    </li>
  );
}

export default function App() {
  const [code, setCode] = useState(defaultCode);
  const [ready, setReady] = useState(false);
  const [assets, setAssets] = useState<string[]>([]);
  const [consoleText, setConsoleText] = useState("");
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [renameBuffer, setRenameBuffer] = useState("");

  const [activeGame, setActiveGame] = useState<GameInfo | null>(null);
  const [games, setGames] = useState<GameInfo[]>([]);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [floatKind, setFloatKind] = useState<null | "new" | "rename">(null);
  const [floatName, setFloatName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<GameInfo | null>(null);
  const [exportDone, setExportDone] = useState<ExportResult | null>(null);
  const [geminiOpen, setGeminiOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  const codeRef = useRef(code);
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const saveSeq = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  const saveNow = useCallback(async (content: string) => {
    if (!isTauri()) return;
    await invoke("write_main", { content });
  }, []);

  const refreshAssets = useCallback(async () => {
    if (!isTauri()) return;
    const list = (await invoke("list_assets")) as string[];
    setAssets(list);
  }, []);

  const appendConsole = useCallback((line: string) => {
    setConsoleText((prev) => {
      const next = prev ? `${prev}\n${line}` : line;
      const parts = next.split("\n");
      if (parts.length > CONSOLE_MAX) {
        return parts.slice(-CONSOLE_MAX).join("\n");
      }
      return next;
    });
  }, []);

  const loadWorkspace = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const [ag, gList, main, alist] = await Promise.all([
        invoke("get_active_game") as Promise<GameInfo>,
        invoke("list_games") as Promise<GameInfo[]>,
        invoke("read_main") as Promise<string>,
        invoke("list_assets") as Promise<string[]>,
      ]);
      setActiveGame(ag);
      setGames(gList);
      setCode(main);
      setAssets(alist);
    } catch (e) {
      appendConsole(String(e));
    }
  }, [appendConsole]);

  const scrollConsole = useCallback(() => {
    const el = mainScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollConsole();
  }, [consoleText, scrollConsole]);

  // Initial load: project + main.py + assets
  useEffect(() => {
    if (!isTauri()) {
      setReady(true);
      appendConsole("Open this app with Tauri (npm run tauri dev) to run local Python and import assets.");
      return;
    }
    let active = true;
    void (async () => {
      try {
        if (active) await loadWorkspace();
      } catch (e) {
        appendConsole(String(e));
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [appendConsole, loadWorkspace]);

  // Event listeners: runner, assets
  useEffect(() => {
    if (!isTauri()) return;

    let disposers: (() => void)[] = [];
    let cancelled = false;

    const p = Promise.all([
      listen<RunnerLinePayload>("runner-line", (ev) => {
        appendConsole(formatConsoleLine(ev.payload));
      }),
      listen<number | null>("runner-exit", (ev) => {
        setRunning(false);
        const code = ev.payload;
        appendConsole(
          code === null || code === undefined
            ? "[exit] process ended (no code)"
            : `[exit] code ${code}`,
        );
      }),
      listen("assets-updated", () => {
        void refreshAssets();
      }),
      listen("project-changed", () => {
        setRunning(false);
        void loadWorkspace();
      }),
      listen<string>("import-asset-err", (e) => {
        appendConsole(`[import] ${e.payload}`);
      }),
    ]).then((unsubs) => {
      if (cancelled) {
        unsubs.forEach((u) => u());
      } else {
        disposers = unsubs;
      }
    });

    return () => {
      cancelled = true;
      disposers.forEach((u) => u());
      void p;
    };
  }, [appendConsole, refreshAssets, loadWorkspace]);

  const handleEditorChange: OnChange = (value) => {
    const v = value ?? "";
    setCode(v);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveNow(v);
    }, AUTOSAVE_MS);
  };

  const applyGeminiCodeToEditor = useCallback((raw: string) => {
    const content = raw.replace(/\r\n/g, "\n");
    codeRef.current = content;
    setCode(content);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (isTauri()) {
      void invoke("write_main", { content });
    }
  }, []);

  const flushSave = useCallback(async () => {
    if (!isTauri()) return;
    saveSeq.current += 1;
    const seq = saveSeq.current;
    await invoke("write_main", { content: codeRef.current });
    if (seq !== saveSeq.current) return;
  }, []);

  const run = useCallback(async () => {
    if (!isTauri()) {
      appendConsole("Run is only available in the desktop app.");
      return;
    }
    try {
      setConsoleText("");
      appendConsole(`[…] ${new Date().toLocaleTimeString()} — saving & starting…`);
      await flushSave();
      setRunning(true);
      await invoke("run_sandbox");
    } catch (e) {
      setRunning(false);
      appendConsole(String(e));
    }
  }, [appendConsole, flushSave]);

  const stop = useCallback(async () => {
    if (!isTauri()) return;
    try {
      await invoke("stop_sandbox");
    } catch (e) {
      appendConsole(String(e));
    } finally {
      setRunning(false);
    }
  }, [appendConsole]);

  const restart = useCallback(async () => {
    await stop();
    await run();
  }, [run, stop]);

  const pickFiles = useCallback(async () => {
    if (!isTauri()) return;
    const picked = await open({ multiple: true, title: "Add assets" });
    if (picked == null) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    for (const p of paths) {
      try {
        await invoke("import_asset_path", { fromPath: p });
      } catch (e) {
        appendConsole(String(e));
      }
    }
    await refreshAssets();
  }, [appendConsole, refreshAssets]);

  const beginRename = (name: string) => {
    setEditing(name);
    setRenameBuffer(name);
  };

  const commitRename = useCallback(async () => {
    if (!editing) return;
    const from = editing;
    const to = renameBuffer.trim();
    setEditing(null);
    if (!to || to === from) return;
    try {
      const finalName = (await invoke("rename_asset", { from, to })) as string;
      if (finalName && finalName !== to) {
        appendConsole(`[rename] name in use, saved as “${finalName}”`);
      }
      await refreshAssets();
    } catch (e) {
      appendConsole(String(e));
    }
  }, [appendConsole, editing, renameBuffer, refreshAssets]);

  const remove = useCallback(
    async (name: string) => {
      try {
        await invoke("remove_asset", { name });
        await refreshAssets();
      } catch (e) {
        appendConsole(String(e));
      }
    },
    [appendConsole, refreshAssets],
  );

  const playAudioUrl = useCallback((url: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const a = new Audio(url);
    audioRef.current = a;
    void a.play().catch(() => {
      if (audioRef.current === a) {
        audioRef.current = null;
      }
    });
    a.addEventListener("ended", () => {
      if (audioRef.current === a) {
        audioRef.current = null;
      }
    });
  }, []);

  const switchGame = useCallback(
    async (id: string) => {
      if (!isTauri() || !activeGame || id === activeGame.id) {
        setProjectMenuOpen(false);
        return;
      }
      try {
        await flushSave();
        await invoke("open_game", { id });
        await loadWorkspace();
      } catch (e) {
        appendConsole(String(e));
      } finally {
        setProjectMenuOpen(false);
      }
    },
    [activeGame, appendConsole, flushSave, loadWorkspace],
  );

  const createGame = useCallback(async () => {
    if (!isTauri()) return;
    try {
      await flushSave();
      await invoke("create_game", { name: floatName.trim() || "Untitled" });
      await loadWorkspace();
      setFloatKind(null);
    } catch (e) {
      appendConsole(String(e));
    }
  }, [floatName, appendConsole, flushSave, loadWorkspace]);

  const applyRenameProject = useCallback(async () => {
    if (!isTauri()) return;
    try {
      await invoke("rename_current_game", { name: floatName.trim() || "Untitled" });
      await loadWorkspace();
      setFloatKind(null);
    } catch (e) {
      appendConsole(String(e));
    }
  }, [floatName, appendConsole, loadWorkspace]);

  const confirmDeleteProject = useCallback(async () => {
    if (!deleteTarget || !isTauri()) return;
    try {
      if (activeGame && deleteTarget.id === activeGame.id) {
        await flushSave();
      }
      await invoke("delete_game", { id: deleteTarget.id });
      await loadWorkspace();
      setDeleteTarget(null);
      setProjectMenuOpen(false);
    } catch (e) {
      appendConsole(String(e));
    }
  }, [deleteTarget, activeGame, appendConsole, flushSave, loadWorkspace]);

  const runExport = useCallback(async () => {
    if (!isTauri()) return;
    setProjectMenuOpen(false);
    try {
      await flushSave();
      const dest = await open({
        directory: true,
        multiple: false,
        title: "Export — choose where to put the folder",
      });
      if (dest === null || dest === undefined) return;
      const parentPath = typeof dest === "string" ? dest : dest[0];
      const res = (await invoke("export_active_game", { parentPath })) as ExportResult;
      appendConsole(`[export] ${res.path}`);
      setExportDone(res);
    } catch (e) {
      appendConsole(String(e));
    }
  }, [appendConsole, flushSave]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!floatKind && !deleteTarget && !projectMenuOpen && !exportDone && !geminiOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFloatKind(null);
        setDeleteTarget(null);
        setProjectMenuOpen(false);
        setExportDone(null);
        setGeminiOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [floatKind, deleteTarget, projectMenuOpen, exportDone, geminiOpen]);

  return (
    <div className="app">
      <header className="top-bar" role="banner">
        {isTauri() && activeGame && (
          <div className="top-bar-set" ref={projectMenuRef}>
            <button
              type="button"
              className="set-btn"
              onClick={() => setProjectMenuOpen((o) => !o)}
              title="Set — projects, new, switch"
            >
              <span className="set-btn-label">Set</span>{" "}
              <span className="set-btn-name">{activeGame.name}</span>{" "}
              <span className="set-btn-chev" aria-hidden>
                ▾
              </span>
            </button>
            {projectMenuOpen && (
              <div className="set-pop" role="menu" aria-label="Projects">
                <ul className="set-pop-list">
                  {games.map((g) => {
                    const isOn = g.id === activeGame.id;
                    return (
                      <li key={g.id} className="set-pop-item">
                        <button
                          type="button"
                          className="set-pop-row"
                          onClick={() => void switchGame(g.id)}
                        >
                          <span className="set-pop-tick" aria-hidden>
                            {isOn ? "●" : " "}
                          </span>
                          <span className="set-pop-title">{g.name}</span>
                        </button>
                        <button
                          type="button"
                          className="set-pop-rm"
                          title="Delete"
                          onClick={() => {
                            if (games.length > 1) {
                              setDeleteTarget(g);
                            }
                          }}
                          disabled={games.length <= 1}
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="set-pop-div" />
                <div className="set-pop-foot">
                  <button
                    type="button"
                    className="win-link-btn"
                    onClick={() => {
                      setFloatName("Untitled");
                      setFloatKind("new");
                      setProjectMenuOpen(false);
                    }}
                  >
                    + New
                  </button>
                  <button
                    type="button"
                    className="win-link-btn"
                    onClick={() => {
                      setFloatName(activeGame.name);
                      setFloatKind("rename");
                      setProjectMenuOpen(false);
                    }}
                  >
                    Rename…
                  </button>
                  <button type="button" className="win-link-btn" onClick={() => void runExport()}>
                    Export…
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          className="gemini-btn"
          onClick={() => setGeminiOpen(true)}
          title="Open Gemini: save your Generative Language API key and chat (calls go from the app, not the browser)"
          aria-label="Open Gemini (API key)"
        >
          <span className="gemini-btn-ico" aria-hidden>
            ◆
          </span>
          Gemini
        </button>

        <div className="top-bar-actions" role="group" aria-label="Run controls">
          <button
            type="button"
            className="win-btn"
            onClick={run}
            disabled={!ready || running}
            title="Save main.py; Run sets the working directory to your project folder (same as main.py)"
          >
            Run
          </button>
          <button type="button" className="win-btn" onClick={stop} disabled={!ready || !running}>
            Stop
          </button>
          <button
            type="button"
            className="win-btn"
            onClick={restart}
            disabled={!ready}
            title="Stop if running, then start again"
          >
            Restart
          </button>
        </div>
        <span className="top-bar-status" title="Status">
          {ready ? (running ? "Python running" : "Idle") : "Loading…"}
        </span>
      </header>

      {isTauri() && (floatKind || deleteTarget || exportDone) && (
        <div
          className="set-float-back"
          onMouseDown={() => {
            setFloatKind(null);
            setDeleteTarget(null);
            setExportDone(null);
          }}
        />
      )}

      {geminiOpen && <div className="set-float-back" onMouseDown={() => setGeminiOpen(false)} />}
      {/* Always mount Gemini so stream listeners + live text keep running when the user closes the overlay */}
      <div
        className="set-float"
        style={{ zIndex: 120, display: geminiOpen ? "flex" : "none" }}
        aria-hidden={!geminiOpen}
      >
        <GeminiPanel
          open={geminiOpen}
          onClose={() => setGeminiOpen(false)}
          onSendCodeToEditor={applyGeminiCodeToEditor}
        />
      </div>

      {isTauri() && floatKind && (
        <div
          className="set-float"
          role="dialog"
          aria-label={floatKind === "new" ? "New project" : "Rename project"}
        >
          <div className="set-float-in win-pop">
            <div className="win-pop-head">
              {floatKind === "new" ? "New project" : "Rename project"}
            </div>
            <div className="win-pop-body">
              <label className="win-pop-lab" htmlFor="set-float-input">
                Name
              </label>
              <input
                id="set-float-input"
                className="win-pop-inp"
                value={floatName}
                onChange={(e) => setFloatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (floatKind === "new") void createGame();
                    else void applyRenameProject();
                  }
                }}
                autoFocus
              />
            </div>
            <div className="win-pop-foot">
              <button type="button" className="win-btn" onClick={() => setFloatKind(null)}>
                Cancel
              </button>
              {floatKind === "new" ? (
                <button type="button" className="win-btn" onClick={() => void createGame()}>
                  Create
                </button>
              ) : (
                <button type="button" className="win-btn" onClick={() => void applyRenameProject()}>
                  OK
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {isTauri() && deleteTarget && (
        <div className="set-float" role="dialog" aria-label="Delete project">
          <div className="set-float-in win-pop">
            <div className="win-pop-head">Delete project</div>
            <div className="win-pop-body">
              <p className="win-pop-txt">Remove “{deleteTarget.name}” and its assets from this machine?</p>
            </div>
            <div className="win-pop-foot">
              <button type="button" className="win-btn" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="win-btn"
                onClick={() => void confirmDeleteProject()}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {isTauri() && exportDone && (
        <div className="set-float" role="dialog" aria-label="Export complete">
          <div className="set-float-in win-pop">
            <div className="win-pop-head">Exported</div>
            <div className="win-pop-body">
              <p className="win-pop-txt">
                Created folder <strong>{exportDone.label}</strong> with <code className="win-pop-code">main.py</code>, your
                other game files, <code className="win-pop-code">export_manifest.json</code> (name list), scripts, and{" "}
                <code className="win-pop-code">README.txt</code> — all in one place.
              </p>
              <pre className="win-pop-path" title={exportDone.path}>
                {exportDone.path}
              </pre>
            </div>
            <div className="win-pop-foot">
              <button type="button" className="win-btn" onClick={() => setExportDone(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="main-row" role="main">
        <section className="win-panel" aria-label="Assets">
          <div className="win-panel-header">
            <span className="win-panel-title">Assets</span>
            <button type="button" className="win-link-btn" onClick={pickFiles}>
              Add…
            </button>
          </div>
          <div className="win-panel-body asset-list-body">
            <div
              className="drop-zone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => e.preventDefault()}
            >
              <p className="drop-hint muted">Drop files onto the window, or use Add…</p>
            </div>
            <ul className="asset-ul">
              {assets.map((name) => (
                <AssetListItem
                  key={`${activeGame?.id ?? "local"}-${name}`}
                  name={name}
                  isEditing={editing === name}
                  renameBuffer={renameBuffer}
                  onRenameBufferChange={setRenameBuffer}
                  onCommitRename={commitRename}
                  onCancelRename={() => setEditing(null)}
                  onBeginRename={() => beginRename(name)}
                  onRemove={() => void remove(name)}
                  onPlayUrl={playAudioUrl}
                />
              ))}
            </ul>
          </div>
        </section>

        <section className="win-panel win-panel--grow" aria-label="Code editor">
          <div className="win-panel-header">
            <span className="win-panel-title">Code</span>
            <span className="win-panel-subtle">main.py + autosave</span>
          </div>
          <div className="win-panel-body editor-surface" aria-label="Code editor (Monaco)">
            {ready && (
              <Editor
                height="100%"
                defaultLanguage="python"
                value={code}
                theme="vs-dark"
                onChange={handleEditorChange}
                options={{
                  fontSize: 12,
                  /* Integer line height + explicit monospace family avoids Tahoma/11px `inherit` fighting the editor. */
                  lineHeight: 19,
                  fontFamily:
                    'ui-monospace, "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", monospace',
                  minimap: { enabled: false },
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  /* Tauri / WKWebView: layer hinting (translate3d) + GPU text paths often mis-size the first view lines. */
                  disableLayerHinting: true,
                  experimentalGpuAcceleration: "off",
                  stickyScroll: { enabled: false },
                  mouseWheelZoom: false,
                }}
              />
            )}
          </div>
        </section>
      </div>

      <section className="win-panel console-panel" aria-label="Output console">
        <div className="win-panel-header">
          <span className="win-panel-title">Output</span>
        </div>
        <div className="win-panel-body console-body sunken" role="log" ref={mainScrollRef}>
          <pre className="console-pre">{consoleText || " "}</pre>
        </div>
      </section>
    </div>
  );
}

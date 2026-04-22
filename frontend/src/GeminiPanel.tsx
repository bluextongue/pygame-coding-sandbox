import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

type Turn = { role: "user" | "model"; text: string };

/** Split on GFM-style ``` ` fences (same pattern as most LLM outputs). */
function parseMarkdownFences(s: string): { kind: "text" | "code"; value: string; info: string }[] {
  const re = /```([^\n\r`]*?)\r?\n([\s\S]*?)```/g;
  const out: { kind: "text" | "code"; value: string; info: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", value: s.slice(last, m.index), info: "" });
    }
    out.push({ kind: "code", value: m[2] ?? "", info: (m[1] ?? "").trim() });
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    out.push({ kind: "text", value: s.slice(last), info: "" });
  }
  if (out.length === 0) {
    return [{ kind: "text", value: s, info: "" }];
  }
  return out;
}

type ModelMsgProps = {
  text: string;
  turnIndex: number;
  copyFlashKey: string | null;
  onCopy: (t: string, key: string) => void;
  onSendToEditor: ((key: string, code: string) => void) | undefined;
  editorToEditorFlash: string | null;
};

function GeminiModelMessage({ text, turnIndex, copyFlashKey, onCopy, onSendToEditor, editorToEditorFlash }: ModelMsgProps) {
  const segments = useMemo(() => parseMarkdownFences(text), [text]);
  const hasFencedCode = segments.some((s) => s.kind === "code");

  return (
    <>
      <div className="gemini-msg-hdr">
        <span className="gemini-msg-who">Gemini</span>
        <div className="gemini-msg-actions">
          <button
            type="button"
            className="win-link-btn"
            onClick={() => onCopy(text, `all-${turnIndex}`)}
            title={
              hasFencedCode
                ? "Copy entire message (explanations and code, including markdown fences)"
                : "Copy message"
            }
          >
            {copyFlashKey === `all-${turnIndex}` ? "Copied" : hasFencedCode ? "Copy all" : "Copy"}
          </button>
        </div>
      </div>
      <div className="gemini-msg-body">
        {segments.map((seg, j) => {
          if (seg.kind === "text") {
            return (
              <div key={j} className="gemini-msg-txt gemini-msg-prose">
                {seg.value}
              </div>
            );
          }
          const ck = `${turnIndex}-b${j}`;
          return (
            <div key={j} className="gemini-code-wrap">
              <div className="gemini-code-blk-hdr">
                {seg.info ? (
                  <span className="gemini-code-lang" title="Language or tag after the code fence (e.g. python)">
                    {seg.info}
                  </span>
                ) : (
                  <span className="gemini-code-lang gemini-code-lang-muted">code</span>
                )}
                <div className="gemini-code-blk-btns">
                  <button
                    type="button"
                    className="win-link-btn"
                    onClick={() => onCopy(seg.value, ck)}
                    title="Copy only this code block (no extra prose)"
                  >
                    {copyFlashKey === ck ? "Copied" : "Copy code"}
                  </button>
                  {onSendToEditor && (
                    <button
                      type="button"
                      className="win-link-btn"
                      onClick={() => onSendToEditor(ck, seg.value.replace(/\r\n/g, "\n"))}
                      title="Replace the Code (main.py) buffer with this block and save to disk in the Tauri app"
                    >
                      {editorToEditorFlash === ck ? "Sent" : "To editor"}
                    </button>
                  )}
                </div>
              </div>
              <pre className="gemini-code-blk">
                <code>{seg.value.replace(/\r\n/g, "\n")}</code>
              </pre>
            </div>
          );
        })}
      </div>
    </>
  );
}

const MODELS: { id: string; label: string }[] = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
  { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
];

type ChatListItem = { id: string; title: string; updated_at: number };

function turnPayload(turns: Turn[]) {
  return turns.map((t) => ({ role: t.role, text: t.text }));
}

/** Title from the first line of the first user turn (like Gemini’s auto-titles). */
function smartTitle(turns: Turn[]): string {
  const u = turns.find((x) => x.role === "user");
  if (!u) return "New chat";
  const firstLine = u.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length);
  const s0 = (firstLine ?? u.text.trim()).replace(/\s+/g, " ");
  if (s0.length > 60) return `${s0.slice(0, 57)}…`;
  return s0 || "New chat";
}

function formatChatTime(secs: number): string {
  const d = new Date(secs * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const diff = (now.getTime() - d.getTime()) / 864e5;
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Floating panel frame (fixed to viewport) — drag (title) + 8-point resize. */
type Rect = { x: number; y: number; w: number; h: number };
type WinEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const GEMINI_PNL_MIN_W = 360;
const GEMINI_PNL_MIN_H = 240;

function defaultWindowRect(): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(GEMINI_PNL_MIN_W, Math.min(vw * 0.88, 800));
  const h = Math.max(GEMINI_PNL_MIN_H, Math.min(vh * 0.8, 700));
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}

function clampRect(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let { x, y, w, h } = r;
  w = Math.max(GEMINI_PNL_MIN_W, w);
  h = Math.max(GEMINI_PNL_MIN_H, h);
  w = Math.min(w, vw);
  h = Math.min(h, vh);
  x = Math.max(0, Math.min(x, vw - w));
  y = Math.max(0, Math.min(y, vh - h));
  return { x, y, w, h };
}

function applyResize(r: Rect, edge: WinEdge, dx: number, dy: number): Rect {
  const { x, y, w, h } = r;
  switch (edge) {
    case "e":
      return { x, y, w: w + dx, h };
    case "w":
      return { x: x + dx, y, w: w - dx, h };
    case "n":
      return { x, y: y + dy, w, h: h - dy };
    case "s":
      return { x, y, w, h: h + dy };
    case "ne":
      return { x, y: y + dy, w: w + dx, h: h - dy };
    case "nw":
      return { x: x + dx, y: y + dy, w: w - dx, h: h - dy };
    case "se":
      return { x, y, w: w + dx, h: h + dy };
    case "sw":
      return { x: x + dx, y, w: w - dx, h: h + dy };
  }
}

const RESIZE_GRIPS: readonly WinEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

type Props = {
  open: boolean;
  onClose: () => void;
  /** Replace main.py in the app editor with a fenced code block. */
  onSendCodeToEditor?: (code: string) => void;
};

export function GeminiPanel({ open, onClose, onSendCodeToEditor }: Props) {
  const [model, setModel] = useState(MODELS[0].id);
  const [keyInput, setKeyInput] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatTitle, setChatTitle] = useState("New chat");
  const [sessionReady, setSessionReady] = useState(!isTauri());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [copyFlashKey, setCopyFlashKey] = useState<string | null>(null);
  const [editorToEditorFlash, setEditorToEditorFlash] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamAccRef = useRef("");
  const lastUserTextRef = useRef("");
  const stateRef = useRef({ activeChatId: null as string | null, model: MODELS[0].id, chatTitle: "New chat" });
  const sessionInited = useRef(false);

  const refreshKeyState = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const ok = (await invoke("gemini_key_configured")) as boolean;
      setHasKey(!!ok);
    } catch {
      setHasKey(false);
    }
  }, []);

  const refreshChats = useCallback(async () => {
    if (!isTauri()) return;
    const list = (await invoke("list_gemini_chats")) as ChatListItem[];
    setChats(list);
  }, []);

  useEffect(() => {
    void refreshKeyState();
  }, [refreshKeyState]);

  // Load or create a saved session — first time the panel is opened (avoids work until needed).
  useEffect(() => {
    if (!isTauri() || !open) return;
    if (sessionInited.current) return;
    sessionInited.current = true;
    let cancelled = false;
    void (async () => {
      try {
        let list = (await invoke("list_gemini_chats")) as ChatListItem[];
        if (list.length === 0) {
          await invoke("new_gemini_chat");
          list = (await invoke("list_gemini_chats")) as ChatListItem[];
        }
        if (cancelled) return;
        setChats(list);
        const first = list[0];
        if (first) {
          const f = (await invoke("load_gemini_chat", { id: first.id })) as {
            id: string;
            title: string;
            model: string;
            turns: { role: string; text: string }[];
          };
          if (cancelled) return;
          setActiveChatId(f.id);
          setChatTitle(f.title);
          setModel(f.model);
          setTurns(
            f.turns.map((t) => ({
              role: t.role === "model" ? "model" : "user",
              text: t.text,
            })),
          );
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    stateRef.current = { activeChatId, model, chatTitle };
  }, [activeChatId, model, chatTitle]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, sending, streamText, open]);

  const saveCurrentConv = useCallback(async () => {
    if (!isTauri() || !activeChatId) return;
    let title = chatTitle;
    if (title === "New chat" || !title.trim()) {
      const d = smartTitle(turns);
      if (d) title = d;
    }
    await invoke("save_gemini_conversation", {
      id: activeChatId,
      model,
      title,
      turns: turnPayload(turns),
    });
    if (title !== chatTitle) setChatTitle(title);
    await refreshChats();
  }, [activeChatId, model, chatTitle, turns, refreshChats]);

  const openChat = useCallback(
    async (id: string) => {
      if (!isTauri() || !sessionReady) return;
      if (sending) return;
      if (id === activeChatId) return;
      setErr(null);
      try {
        await saveCurrentConv();
        const f = (await invoke("load_gemini_chat", { id })) as {
          id: string;
          title: string;
          model: string;
          turns: { role: string; text: string }[];
        };
        setActiveChatId(f.id);
        setChatTitle(f.title);
        setModel(f.model);
        setTurns(
          f.turns.map((t) => ({
            role: t.role === "model" ? "model" : "user",
            text: t.text,
          })),
        );
        setDraft("");
        await refreshChats();
      } catch (e) {
        setErr(String(e));
      }
    },
    [activeChatId, sessionReady, sending, saveCurrentConv, refreshChats],
  );

  const startNewChat = useCallback(async () => {
    if (!isTauri() || !sessionReady || sending) return;
    setErr(null);
    try {
      await saveCurrentConv();
      const id = (await invoke("new_gemini_chat")) as string;
      await refreshChats();
      setActiveChatId(id);
      setChatTitle("New chat");
      setModel(MODELS[0].id);
      setTurns([]);
      setDraft("");
    } catch (e) {
      setErr(String(e));
    }
  }, [sessionReady, sending, saveCurrentConv, refreshChats]);

  const removeChat = useCallback(
    async (id: string) => {
      if (!isTauri() || sending) return;
      if (!window.confirm("Delete this chat? This cannot be undone.")) return;
      setErr(null);
      try {
        await invoke("delete_gemini_chat_file", { id });
        await refreshChats();
        const list = (await invoke("list_gemini_chats")) as ChatListItem[];
        if (id === activeChatId) {
          if (list[0]) {
            const f = (await invoke("load_gemini_chat", { id: list[0].id })) as {
              id: string;
              title: string;
              model: string;
              turns: { role: string; text: string }[];
            };
            setActiveChatId(f.id);
            setChatTitle(f.title);
            setModel(f.model);
            setTurns(
              f.turns.map((t) => ({
                role: t.role === "model" ? "model" : "user",
                text: t.text,
              })),
            );
            setDraft("");
          } else {
            const nid = (await invoke("new_gemini_chat")) as string;
            await refreshChats();
            setActiveChatId(nid);
            setChatTitle("New chat");
            setModel(MODELS[0].id);
            setTurns([]);
            setDraft("");
          }
        }
      } catch (e) {
        setErr(String(e));
      }
    },
    [activeChatId, sending, refreshChats],
  );

  const renameChat = useCallback(
    async (c: ChatListItem) => {
      if (!isTauri() || sending) return;
      const n = window.prompt("Rename chat", c.title);
      if (n == null) return;
      const t = n.trim();
      if (!t) return;
      setErr(null);
      try {
        if (c.id === activeChatId) {
          await invoke("save_gemini_conversation", {
            id: c.id,
            model,
            title: t,
            turns: turnPayload(turns),
          });
          setChatTitle(t);
        } else {
          const f = (await invoke("load_gemini_chat", { id: c.id })) as {
            id: string;
            model: string;
            turns: { role: string; text: string }[];
          };
          await invoke("save_gemini_conversation", {
            id: f.id,
            model: f.model,
            title: t,
            turns: f.turns,
          });
        }
        await refreshChats();
      } catch (e) {
        setErr(String(e));
      }
    },
    [activeChatId, model, sending, turns, refreshChats],
  );

  // Stream events (Rust `streamGenerateContent` → SSE)
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let disposers: (() => void)[] = [];
    const p = Promise.all([
      listen<string>("gemini-stream-chunk", (e) => {
        if (cancelled) return;
        const piece = e.payload;
        if (typeof piece === "string" && piece.length) {
          streamAccRef.current += piece;
          setStreamText(streamAccRef.current);
        }
      }),
      listen("gemini-stream-done", () => {
        if (cancelled) return;
        const full = streamAccRef.current;
        streamAccRef.current = "";
        setStreamText("");
        setTurns((prev) => {
          const next: Turn[] = [...prev, { role: "model", text: full }];
          const st = stateRef.current;
          if (st.activeChatId) {
            let title = st.chatTitle;
            if (title === "New chat" || !title.trim()) {
              const d = smartTitle(next);
              if (d) title = d;
            }
            if (title !== st.chatTitle) {
              setChatTitle(title);
            }
            void invoke("save_gemini_conversation", {
              id: st.activeChatId,
              model: st.model,
              title,
              turns: turnPayload(next),
            })
              .then(() => refreshChats())
              .catch(() => {});
          }
          setSending(false);
          return next;
        });
      }),
      listen<string>("gemini-stream-error", (e) => {
        if (cancelled) return;
        const msg = typeof e.payload === "string" ? e.payload : "stream error";
        setErr(msg);
        streamAccRef.current = "";
        setStreamText("");
        setTurns((prev) => prev.slice(0, -1));
        setDraft(lastUserTextRef.current);
        setSending(false);
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
  }, [refreshChats]);

  const saveKey = useCallback(async () => {
    setErr(null);
    if (!isTauri()) return;
    try {
      await invoke("save_gemini_api_key", { key: keyInput });
      setKeyInput("");
      await refreshKeyState();
    } catch (e) {
      setErr(String(e));
    }
  }, [keyInput, refreshKeyState]);

  const clearKey = useCallback(async () => {
    setErr(null);
    if (!isTauri()) return;
    try {
      await invoke("save_gemini_api_key", { key: "" });
      setKeyInput("");
      await refreshKeyState();
    } catch (e) {
      setErr(String(e));
    }
  }, [refreshKeyState]);

  const clearChat = useCallback(async () => {
    setErr(null);
    setTurns([]);
    if (isTauri() && activeChatId) {
      try {
        await invoke("save_gemini_conversation", {
          id: activeChatId,
          model,
          title: chatTitle,
          turns: [],
        });
        await refreshChats();
      } catch (e) {
        setErr(String(e));
      }
    }
  }, [activeChatId, model, chatTitle, refreshChats]);

  const flashCopy = useCallback((text: string, key: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopyFlashKey(key);
      window.setTimeout(
        () => setCopyFlashKey((k) => (k === key ? null : k)),
        1500,
      );
    });
  }, []);

  const sendCodeToEditor = useCallback(
    (key: string, code: string) => {
      onSendCodeToEditor?.(code);
      setEditorToEditorFlash(key);
      window.setTimeout(
        () => setEditorToEditorFlash((k) => (k === key ? null : k)),
        1500,
      );
    },
    [onSendCodeToEditor],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !isTauri() || sending) return;
    if (!sessionReady || !activeChatId) return;
    setErr(null);
    const userTurn: Turn = { role: "user", text };
    const nextTurns: Turn[] = [...turns, userTurn];
    const historyPayload = nextTurns.map((t) => ({ role: t.role, text: t.text }));
    lastUserTextRef.current = text;
    setTurns(nextTurns);
    setDraft("");
    streamAccRef.current = "";
    setStreamText("");
    setSending(true);
    let title = chatTitle;
    if (title === "New chat" || !title.trim()) {
      const d = smartTitle(nextTurns);
      if (d) {
        title = d;
        setChatTitle(d);
      }
    }
    try {
      await invoke("save_gemini_conversation", {
        id: activeChatId,
        model,
        title,
        turns: turnPayload(nextTurns),
      });
      void refreshChats();
      await invoke("gemini_start_stream", { model, contents: historyPayload });
    } catch (e) {
      setErr(String(e));
      setTurns((prev) => prev.slice(0, -1));
      setDraft(text);
      setSending(false);
      streamAccRef.current = "";
      setStreamText("");
    }
  }, [draft, model, sending, turns, sessionReady, activeChatId, chatTitle, refreshChats]);

  const onModelChange = useCallback(
    async (next: string) => {
      setModel(next);
      if (!isTauri() || !activeChatId || sending) return;
      try {
        await invoke("save_gemini_conversation", {
          id: activeChatId,
          model: next,
          title: chatTitle,
          turns: turnPayload(turns),
        });
        await refreshChats();
      } catch {
        /* ignore; model still use next for next send */
      }
    },
    [activeChatId, chatTitle, turns, sending, refreshChats],
  );

  const [frame, setFrame] = useState<Rect>(() => defaultWindowRect());
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const onTitleBarMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".win9x-close-btn")) return;
    e.preventDefault();
    const r0 = { ...frameRef.current };
    document.body.classList.add("gemini-pnl-noselect");
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: MouseEvent) => {
      setFrame(
        clampRect({ ...r0, x: r0.x + (ev.clientX - sx), y: r0.y + (ev.clientY - sy) }),
      );
    };
    const onUp = () => {
      document.body.classList.remove("gemini-pnl-noselect");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const onResizeGripMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>, edge: WinEdge) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    const r0 = { ...frameRef.current };
    document.body.classList.add("gemini-pnl-noselect");
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      setFrame(clampRect(applyResize(r0, edge, dx, dy)));
    };
    const onUp = () => {
      document.body.classList.remove("gemini-pnl-noselect");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  useLayoutEffect(() => {
    if (open) {
      setFrame((f) => clampRect(f));
    }
  }, [open]);

  useEffect(() => {
    const onWinResize = () => {
      setFrame((f) => clampRect(f));
    };
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);

  useEffect(
    () => () => {
      document.body.classList.remove("gemini-pnl-noselect");
    },
    [],
  );

  if (!open) {
    return null;
  }

  const inputLocked = !isTauri() || !hasKey || sending || !sessionReady || (isTauri() && !activeChatId);

  return (
    <div
      className="gemini-pnl-outer"
      role="dialog"
      aria-label="Gemini (API)"
      style={{
        position: "fixed",
        left: frame.x,
        top: frame.y,
        width: frame.w,
        height: frame.h,
        zIndex: 1,
      }}
    >
      <div
        className="gemini-pnl win-pop gemini-pnl--split"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="win-pop-head gemini-pnl-headbar"
          onMouseDown={onTitleBarMouseDown}
          title="Drag to move"
        >
          <span className="gemini-pnl-titletext">Gemini</span>
          <button
            type="button"
            className="win9x-close-btn"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <span className="win9x-close-x" aria-hidden>
              ×
            </span>
          </button>
        </div>
        <div className="gemini-pnl-work">
          {isTauri() && (
            <aside className="gemini-pnl-hist" aria-label="Chat history">
              <button
                type="button"
                className="win-btn gemini-hist-new"
                onClick={() => void startNewChat()}
                disabled={!sessionReady || sending}
              >
                + New chat
              </button>
              <div className="gemini-hist-label">Recent</div>
              {!sessionReady ? (
                <p className="win-pop-txt gemini-hist-loading" style={{ margin: "4px 0 0" }}>
                  Loading…
                </p>
              ) : (
                <ul className="gemini-hist-list">
                  {chats.map((c) => (
                    <li
                      key={c.id}
                      className={`gemini-hist-item ${c.id === activeChatId ? "is-active" : ""}`}
                    >
                      <button
                        type="button"
                        className="gemini-hist-row"
                        onClick={() => void openChat(c.id)}
                        disabled={sending}
                        title={c.title}
                      >
                        <span className="gemini-hist-title">{c.title || "—"}</span>
                        <span className="gemini-hist-time">{formatChatTime(c.updated_at)}</span>
                      </button>
                      <div className="gemini-hist-tools">
                        <button
                          type="button"
                          className="win-link-btn"
                          onClick={() => void renameChat(c)}
                          disabled={sending}
                          title="Rename"
                          aria-label="Rename"
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="win-link-btn"
                          onClick={() => void removeChat(c.id)}
                          disabled={sending}
                          title="Delete"
                          aria-label="Delete"
                        >
                          ×
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}

          <div className="gemini-pnl-main">
            <div className="win-pop-body gemini-pnl-body">
              {!isTauri() && (
                <p className="win-pop-txt" style={{ marginTop: 0 }}>
                  The Gemini chat uses the app backend and only runs in the desktop (Tauri) build. Open with{" "}
                  <code className="win-pop-code">npm run tauri dev</code>. Saved chats and memory are
                  available there only.
                </p>
              )}

              {isTauri() && (
                <>
                  <p className="win-pop-txt" style={{ marginTop: 0 }}>
                    The key is stored in your app data directory and is only used from Rust to call Google; it
                    is not sent to the editor JavaScript. Chats are saved as files next to the key.{" "}
                    <button
                      type="button"
                      className="win-link-btn"
                      onClick={() => void openUrl("https://aistudio.google.com/apikey")}
                    >
                      Get a key
                    </button>
                  </p>
                  <div className="gemini-pnl-keyrow">
                    <input
                      type="password"
                      className="win-pop-inp"
                      placeholder={hasKey ? "•••• key on file — paste to replace" : "Paste Generative Language API key"}
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      autoComplete="off"
                    />
                    <div className="gemini-pnl-keyactions">
                      <button
                        type="button"
                        className="win-btn"
                        onClick={() => void saveKey()}
                        disabled={!keyInput.trim()}
                      >
                        Save key
                      </button>
                      {hasKey && (
                        <button type="button" className="win-btn" onClick={() => void clearKey()}>
                          Remove key
                        </button>
                      )}
                    </div>
                  </div>
                  <label className="win-pop-lab" htmlFor="gemini-model" style={{ marginTop: 6 }}>
                    Model
                  </label>
                  <select
                    id="gemini-model"
                    className="win-pop-inp gemini-pnl-select"
                    value={model}
                    onChange={(e) => void onModelChange(e.target.value)}
                    disabled={!hasKey || !sessionReady}
                  >
                    {MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <div className="gemini-pnl-chathdr">
                <span>Conversation{chatTitle && chatTitle !== "New chat" ? ` — ${chatTitle}` : ""}</span>
                {isTauri() && hasKey && sessionReady && (
                  <button
                    type="button"
                    className="win-link-btn"
                    onClick={() => void clearChat()}
                    disabled={sending || turns.length === 0}
                  >
                    Clear chat
                  </button>
                )}
              </div>
              <div className="gemini-pnl-msgs" ref={scrollRef}>
                {turns.length === 0 && isTauri() && hasKey && !sending && sessionReady && (
                  <p className="win-pop-txt" style={{ margin: 0, opacity: 0.7 }}>
                    Type a message below and press Send. Pick a past chat in the list or start a new one.
                  </p>
                )}
                {turns.map((t, i) => (
                  <div
                    key={i}
                    className={t.role === "user" ? "gemini-msg gemini-msg-user" : "gemini-msg gemini-msg-model"}
                  >
                    {t.role === "user" ? (
                      <>
                        <span className="gemini-msg-who">You</span>
                        <div className="gemini-msg-txt">{t.text}</div>
                      </>
                    ) : (
                      <GeminiModelMessage
                        text={t.text}
                        turnIndex={i}
                        copyFlashKey={copyFlashKey}
                        onCopy={flashCopy}
                        onSendToEditor={onSendCodeToEditor ? sendCodeToEditor : undefined}
                        editorToEditorFlash={editorToEditorFlash}
                      />
                    )}
                  </div>
                ))}
                {sending && (
                  <div className="gemini-msg gemini-msg-model">
                    <span className="gemini-msg-who">Gemini</span>
                    <div className="gemini-msg-txt">
                      {streamText}
                      <span className="gemini-stream-cursor" aria-hidden>
                        ▊
                      </span>
                    </div>
                  </div>
                )}
              </div>
              {err && (
                <p className="win-pop-txt" style={{ color: "#800000", marginBottom: 0 }}>
                  {err}
                </p>
              )}
            </div>
            <div className="win-pop-foot gemini-pnl-foot">
              <div className="gemini-pnl-inputrow">
                <textarea
                  className="win-pop-inp gemini-pnl-ta"
                  rows={2}
                  placeholder="Message…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  disabled={inputLocked}
                />
                <button
                  type="button"
                  className="win-btn"
                  onClick={() => void send()}
                  disabled={inputLocked || !draft.trim()}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="gemini-pnl-grips" aria-hidden>
        {RESIZE_GRIPS.map((edge) => (
          <div
            key={edge}
            className={`gemini-pnl-grip gemini-pnl-grip--${edge}`}
            onMouseDown={(e) => onResizeGripMouseDown(e, edge)}
            title="Resize"
          />
        ))}
      </div>
    </div>
  );
}

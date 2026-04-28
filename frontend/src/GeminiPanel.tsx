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
import { openUrl } from "@tauri-apps/plugin-opener";
import { initAiStreamListenersOnce, resetAiStreamHandlers, setAiStreamHandlerGetter } from "./aiStreamBridge";

type Turn = { role: "user" | "model"; text: string };
type AiProvider = "gemini" | "gpt";

type FenceSeg = { kind: "text" | "code"; value: string; info: string };

/** e.g. corrupted "pythonpython" / "bashbash" from doubled stream chunks */
function dedupeRepeatedFenceInfo(info: string): string {
  const t = info.trim();
  if (t.length < 2) return t;
  const n = t.length;
  for (let k = Math.floor(n / 2); k >= 1; k--) {
    if (n % k !== 0) continue;
    const unit = t.slice(0, k);
    if (unit.repeat(n / k) === t) return unit;
  }
  return t;
}

/**
 * GFM-style fenced blocks: only a *line* that is (≤3 spaces)(3+ fence chars)(optional info)
 * can open/close. Code may contain ```…``` on inner lines without ending the block.
 * This avoids the old regex `*?` bug that treated the first ``` inside JS/Python as the end.
 */
function parseMarkdownFences(raw: string): FenceSeg[] {
  const lines = raw.split(/\r?\n/);
  const out: FenceSeg[] = [];
  let textLines: string[] = [];
  let i = 0;

  const flushText = () => {
    if (textLines.length === 0) return;
    const value = textLines.join("\n");
    textLines = [];
    if (value.length === 0) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") {
      last.value = `${last.value}\n${value}`;
    } else {
      out.push({ kind: "text", value, info: "" });
    }
  };

  const tryOpenFence = (line: string) => {
    const m = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
    if (!m) return null;
    const tick = m[2];
    const ch = tick[0] as "`" | "~";
    const info = (m[3] ?? "").trim();
    return { tickLen: tick.length, fenceChar: ch, info };
  };

  const tryCloseFence = (line: string, openTickLen: number, openCh: "`" | "~") => {
    const m = line.match(/^(\s{0,3})(`{3,}|~{3,})\s*$/);
    if (!m) return false;
    const run = m[2];
    if (run[0] !== openCh) return false;
    return run.length >= openTickLen;
  };

  while (i < lines.length) {
    const open = tryOpenFence(lines[i] ?? "");
    if (open) {
      flushText();
      i++;
      const codeLines: string[] = [];
      let closed = false;
      while (i < lines.length) {
        const L = lines[i] ?? "";
        if (tryCloseFence(L, open.tickLen, open.fenceChar)) {
          closed = true;
          i++;
          break;
        }
        codeLines.push(L);
        i++;
      }
      const code = codeLines.join("\n");
      out.push({ kind: "code", value: code, info: dedupeRepeatedFenceInfo(open.info) });
      if (!closed) {
        /* EOF before closing fence — keep accumulated body as one block */
      }
      continue;
    }
    textLines.push(lines[i] ?? "");
    i++;
  }
  flushText();
  if (out.length === 0) {
    return [{ kind: "text", value: raw, info: "" }];
  }
  return out;
}

type ModelMsgProps = {
  text: string;
  turnIndex: number;
  copyFlashKey: string | null;
  onCopy: (t: string, key: string) => void;
  onSendToEditor: ((key: string, code: string) => void) | undefined;
  /** Chat-scoped id so the same block index in a different chat is distinct. */
  chatId: string;
  sentToEditorKeys: Readonly<Record<string, true>>;
  /** Tauri: run main.py (after this block was sent to the editor). */
  onRunFromAi: (() => void | Promise<void>) | undefined;
  running: boolean;
  assistantLabel: string;
  /** Reply is still streaming; same fenced rendering as final, plus caret. */
  streaming?: boolean;
};

function GeminiModelMessage({
  text,
  turnIndex,
  copyFlashKey,
  onCopy,
  onSendToEditor,
  chatId,
  sentToEditorKeys,
  onRunFromAi,
  running,
  assistantLabel,
  streaming = false,
}: ModelMsgProps) {
  const segments = useMemo(() => parseMarkdownFences(text), [text]);
  const hasFencedCode = segments.some((s) => s.kind === "code");

  return (
    <>
      <div className="gemini-msg-hdr">
        <span className="gemini-msg-who">{assistantLabel}</span>
        <div className="gemini-msg-actions">
          <button
            type="button"
            className="win-link-btn gemini-copy-all-btn"
            onClick={() => void onCopy(text, `all-${turnIndex}`)}
            title={
              hasFencedCode
                ? "Copy entire reply (prose and code, including markdown fences)"
                : "Copy entire reply"
            }
          >
            {copyFlashKey === `all-${turnIndex}` ? "Copied" : "Copy reply"}
          </button>
        </div>
      </div>
      <div className={`gemini-msg-body${streaming ? " gemini-msg-body--streaming" : ""}`}>
        {segments.map((seg, j) => {
          if (seg.kind === "text") {
            return (
              <div key={j} className="gemini-msg-txt gemini-msg-prose">
                {seg.value}
              </div>
            );
          }
          const ck = `${chatId}-${turnIndex}-b${j}`;
          const codeNorm = seg.value.replace(/\r\n/g, "\n");
          const sentHere = sentToEditorKeys[ck] === true;
          const showRun = isTauri() && onRunFromAi && sentHere;
          return (
            <div key={j} className="gemini-code-wrap">
              <div className="gemini-code-blk-hdr">
                {seg.info ? (
                  <span className="gemini-code-lang" title="Fence language / tag">
                    {seg.info}
                  </span>
                ) : (
                  <span className="gemini-code-lang gemini-code-lang-muted">code</span>
                )}
                <div className="gemini-code-blk-btns">
                  <button
                    type="button"
                    className="win-link-btn gemini-code-action-btn"
                    onClick={() => void onCopy(seg.value, ck)}
                    title="Copy this block only"
                  >
                    {copyFlashKey === ck ? "Copied" : "Copy"}
                  </button>
                  {onSendToEditor &&
                    !streaming &&
                    (showRun ? (
                      <button
                        type="button"
                        className="win-link-btn gemini-code-action-btn"
                        disabled={running}
                        onClick={() => {
                          void onRunFromAi?.();
                        }}
                        title="Run main.py (toolbar Run)"
                      >
                        Run
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="win-link-btn gemini-code-action-btn"
                        disabled={!isTauri() && sentHere}
                        onClick={() => {
                          if (!sentHere) onSendToEditor(ck, codeNorm);
                        }}
                        title={isTauri() ? "Write this block to main.py" : "Send to on-screen editor"}
                      >
                        {!isTauri() && sentHere ? "Sent" : "To editor"}
                      </button>
                    ))}
                </div>
              </div>
              <pre className="gemini-code-blk">
                <code>{seg.value.replace(/\r\n/g, "\n")}</code>
              </pre>
            </div>
          );
        })}
        {streaming && (
          <span className="gemini-stream-cursor" aria-hidden>
            ▊
          </span>
        )}
      </div>
    </>
  );
}

const GEMINI_MODELS: { id: string; label: string }[] = [
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
  { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash-Lite" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  {
    id: "gemini-3.1-pro-preview-customtools",
    label: "Gemini 3.1 Pro (custom tools)",
  },
  {
    id: "gemini-3-pro-image-preview",
    label: "Gemini 3 Pro Image (Nano Banana Pro)",
  },
  {
    id: "gemini-3.1-flash-image-preview",
    label: "Gemini 3.1 Flash Image",
  },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
  { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
];

/** Picker + labels; any `gpt-*` id from a saved file is passed through and validated in Rust. */
const GPT_MODELS: { id: string; label: string }[] = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-pro", label: "GPT-5.4 pro" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "gpt-5.4-nano", label: "GPT-5.4 nano" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-5.1", label: "GPT-5.1" },
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-5-nano", label: "GPT-5 nano" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
];

function normalizeModel(p: AiProvider, model: string): string {
  const list = p === "gemini" ? GEMINI_MODELS : GPT_MODELS;
  if (p === "gpt") {
    if (list.some((m) => m.id === model)) return model;
    const t = model.trim();
    if (/^gpt-[0-9a-z._-]+$/i.test(t)) return t;
    return list[0].id;
  }
  return list.some((m) => m.id === model) ? model : list[0].id;
}

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
  /** Tauri: after “To editor”, the same slot shows Run — same behavior as the toolbar Run. */
  onRunFromAi?: () => void | Promise<void>;
  /** Disables the Run control while a run is in progress. */
  running?: boolean;
  /** True while a reply is streaming (toolbar can show activity when the panel is closed). */
  onGenActivityChange?: (busy: boolean) => void;
};

export function GeminiPanel({
  open,
  onClose,
  onSendCodeToEditor,
  onRunFromAi,
  running = false,
  onGenActivityChange,
}: Props) {
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [model, setModel] = useState(GEMINI_MODELS[0].id);
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
  const [sentToEditorKeys, setSentToEditorKeys] = useState<Record<string, true>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamAccRef = useRef("");
  const lastUserTextRef = useRef("");
  const stateRef = useRef({
    activeChatId: null as string | null,
    model: GEMINI_MODELS[0].id,
    chatTitle: "New chat",
    provider: "gemini" as AiProvider,
  });
  const sessionInited = useRef(false);
  /** Bumped on every chat / provider / new-chat navigation; aborts in-flight work after any `await` so out-of-order completion can’t clobber the UI. */
  const chatNavGenRef = useRef(0);
  const nextChatNavGen = () => {
    chatNavGenRef.current += 1;
    return chatNavGenRef.current;
  };
  const isStaleChatNav = (g: number) => g !== chatNavGenRef.current;

  const modelsForProvider = useMemo(
    () => (provider === "gemini" ? GEMINI_MODELS : GPT_MODELS),
    [provider],
  );

  const refreshKeyState = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const ok =
        provider === "gemini"
          ? ((await invoke("gemini_key_configured")) as boolean)
          : ((await invoke("openai_key_configured")) as boolean);
      setHasKey(!!ok);
    } catch {
      setHasKey(false);
    }
  }, [provider]);

  const refreshChats = useCallback(
    async (forProvider?: AiProvider) => {
      if (!isTauri()) return;
      const pr = forProvider ?? provider;
      const list = (await invoke("list_gemini_chats", { provider: pr })) as ChatListItem[];
      setChats(list);
    },
    [provider],
  );

  useEffect(() => {
    void refreshKeyState();
  }, [refreshKeyState]);

  const assistantLabel = provider === "gemini" ? "Gemini" : "GPT";

  useEffect(() => {
    setSentToEditorKeys({});
  }, [activeChatId]);

  useEffect(() => {
    onGenActivityChange?.(sending);
  }, [sending, onGenActivityChange]);

  // Load or create a saved session — first time the panel is opened (avoids work until needed).
  useEffect(() => {
    if (!isTauri() || !open) return;
    if (sessionInited.current) return;
    let cancelled = false;
    void (async () => {
      try {
        let list = (await invoke("list_gemini_chats", { provider: "gemini" })) as ChatListItem[];
        if (list.length === 0) {
          await invoke("new_gemini_chat", { provider: "gemini" });
          list = (await invoke("list_gemini_chats", { provider: "gemini" })) as ChatListItem[];
        }
        if (cancelled) return;
        setChats(list);
        const first = list[0];
        if (first) {
          const f = (await invoke("load_gemini_chat", { id: first.id, provider: "gemini" })) as {
            id: string;
            title: string;
            provider?: string;
            model: string;
            turns: { role: string; text: string }[];
          };
          if (cancelled) return;
          setProvider("gemini");
          setActiveChatId(f.id);
          setChatTitle(f.title);
          setModel(normalizeModel("gemini", f.model));
          setTurns(
            f.turns.map((t) => ({
              role: t.role === "model" ? "model" : "user",
              text: t.text,
            })),
          );
        }
        if (!cancelled) {
          sessionInited.current = true;
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        setSessionReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    stateRef.current = { activeChatId, model, chatTitle, provider };
  }, [activeChatId, model, chatTitle, provider]);

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
    const m = normalizeModel(provider, model);
    if (m !== model) {
      setModel(m);
    }
    await invoke("save_gemini_conversation", {
      id: activeChatId,
      provider,
      model: m,
      title,
      turns: turnPayload(turns),
    });
    if (title !== chatTitle) setChatTitle(title);
    await refreshChats();
  }, [activeChatId, provider, model, chatTitle, turns, refreshChats]);

  const openChat = useCallback(
    async (id: string) => {
      if (!isTauri() || !sessionReady || sending) return;
      if (id === activeChatId) return;
      const g = nextChatNavGen();
      setErr(null);
      try {
        await saveCurrentConv();
        if (isStaleChatNav(g)) {
          return;
        }
        const f = (await invoke("load_gemini_chat", { id, provider })) as {
          id: string;
          title: string;
          provider?: string;
          model: string;
          turns: { role: string; text: string }[];
        };
        if (isStaleChatNav(g)) {
          return;
        }
        setActiveChatId(f.id);
        setChatTitle(f.title);
        setModel(normalizeModel(provider, f.model));
        setTurns(
          f.turns.map((t) => ({
            role: t.role === "model" ? "model" : "user",
            text: t.text,
          })),
        );
        setDraft("");
        await refreshChats();
      } catch (e) {
        if (!isStaleChatNav(g)) {
          setErr(String(e));
        }
      }
    },
    [activeChatId, provider, sessionReady, sending, saveCurrentConv, refreshChats],
  );

  const startNewChat = useCallback(async () => {
    if (!isTauri() || !sessionReady || sending) return;
    const g = nextChatNavGen();
    setErr(null);
    try {
      await saveCurrentConv();
      if (isStaleChatNav(g)) {
        return;
      }
      const id = (await invoke("new_gemini_chat", { provider })) as string;
      if (isStaleChatNav(g)) {
        return;
      }
      await refreshChats();
      if (isStaleChatNav(g)) {
        return;
      }
      setActiveChatId(id);
      setChatTitle("New chat");
      setModel((provider === "gemini" ? GEMINI_MODELS : GPT_MODELS)[0].id);
      setTurns([]);
      setDraft("");
    } catch (e) {
      if (!isStaleChatNav(g)) {
        setErr(String(e));
      }
    }
  }, [sessionReady, sending, saveCurrentConv, refreshChats, provider]);

  const removeChat = useCallback(
    async (id: string) => {
      if (!isTauri() || sending) return;
      if (!window.confirm("Delete this chat? This cannot be undone.")) return;
      const g = nextChatNavGen();
      const wasActive = id === activeChatId;
      setErr(null);
      try {
        await invoke("delete_gemini_chat_file", { id, provider });
        if (isStaleChatNav(g)) {
          return;
        }
        await refreshChats();
        if (isStaleChatNav(g)) {
          return;
        }
        const list = (await invoke("list_gemini_chats", { provider })) as ChatListItem[];
        if (isStaleChatNav(g)) {
          return;
        }
        if (wasActive) {
          if (list[0]) {
            const f = (await invoke("load_gemini_chat", { id: list[0].id, provider })) as {
              id: string;
              title: string;
              provider?: string;
              model: string;
              turns: { role: string; text: string }[];
            };
            if (isStaleChatNav(g)) {
              return;
            }
            setActiveChatId(f.id);
            setChatTitle(f.title);
            setModel(normalizeModel(provider, f.model));
            setTurns(
              f.turns.map((t) => ({
                role: t.role === "model" ? "model" : "user",
                text: t.text,
              })),
            );
            setDraft("");
          } else {
            const nid = (await invoke("new_gemini_chat", { provider })) as string;
            if (isStaleChatNav(g)) {
              return;
            }
            await refreshChats();
            if (isStaleChatNav(g)) {
              return;
            }
            setActiveChatId(nid);
            setChatTitle("New chat");
            setModel((provider === "gemini" ? GEMINI_MODELS : GPT_MODELS)[0].id);
            setTurns([]);
            setDraft("");
          }
        }
      } catch (e) {
        if (!isStaleChatNav(g)) {
          setErr(String(e));
        }
      }
    },
    [activeChatId, provider, sending, refreshChats],
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
            provider,
            model,
            title: t,
            turns: turnPayload(turns),
          });
          setChatTitle(t);
        } else {
          const f = (await invoke("load_gemini_chat", { id: c.id, provider })) as {
            id: string;
            provider?: string;
            model: string;
            turns: { role: string; text: string }[];
          };
          const prov = f.provider === "gpt" ? "gpt" : "gemini";
          await invoke("save_gemini_conversation", {
            id: f.id,
            provider: prov,
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
    [activeChatId, model, provider, sending, turns, refreshChats],
  );

  const onStreamDone = useCallback(() => {
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
          provider: st.provider,
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
  }, [refreshChats]);

  const onStreamError = useCallback((msg: string) => {
    setErr(msg);
    streamAccRef.current = "";
    setStreamText("");
    setTurns((prev) => prev.slice(0, -1));
    setDraft(lastUserTextRef.current);
    setSending(false);
  }, []);

  const onStreamDoneRef = useRef(onStreamDone);
  const onStreamErrorRef = useRef(onStreamError);
  onStreamDoneRef.current = onStreamDone;
  onStreamErrorRef.current = onStreamError;

  // One global Tauri `listen` registration (see aiStreamBridge.ts). Per-effect listeners could stack
  // (Strict Mode, timing) and duplicate every chunk in the UI.
  useEffect(() => {
    if (!isTauri()) return;
    void initAiStreamListenersOnce();
    return () => {
      resetAiStreamHandlers();
    };
  }, []);

  useLayoutEffect(() => {
    if (!isTauri()) return;
    setAiStreamHandlerGetter(() => ({
      onChunk: (piece: string) => {
        streamAccRef.current += piece;
        setStreamText(streamAccRef.current);
      },
      onDone: () => {
        onStreamDoneRef.current();
      },
      onError: (msg: string) => {
        onStreamErrorRef.current(msg);
      },
    }));
  });

  const saveKey = useCallback(async () => {
    setErr(null);
    if (!isTauri()) return;
    try {
      if (provider === "gemini") {
        await invoke("save_gemini_api_key", { key: keyInput });
      } else {
        await invoke("save_openai_api_key", { key: keyInput });
      }
      setKeyInput("");
      await refreshKeyState();
    } catch (e) {
      setErr(String(e));
    }
  }, [keyInput, provider, refreshKeyState]);

  const clearKey = useCallback(async () => {
    setErr(null);
    if (!isTauri()) return;
    try {
      if (provider === "gemini") {
        await invoke("save_gemini_api_key", { key: "" });
      } else {
        await invoke("save_openai_api_key", { key: "" });
      }
      setKeyInput("");
      await refreshKeyState();
    } catch (e) {
      setErr(String(e));
    }
  }, [provider, refreshKeyState]);

  const clearChat = useCallback(async () => {
    setErr(null);
    setTurns([]);
    if (isTauri() && activeChatId) {
      try {
        await invoke("save_gemini_conversation", {
          id: activeChatId,
          provider,
          model,
          title: chatTitle,
          turns: [],
        });
        await refreshChats();
      } catch (e) {
        setErr(String(e));
      }
    }
  }, [activeChatId, provider, model, chatTitle, refreshChats]);

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
      setSentToEditorKeys((p) => ({ ...p, [key]: true }));
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
      const m = normalizeModel(provider, model);
      if (m !== model) {
        setModel(m);
      }
      await invoke("save_gemini_conversation", {
        id: activeChatId,
        provider,
        model: m,
        title,
        turns: turnPayload(nextTurns),
      });
      void refreshChats();
      if (provider === "gemini") {
        await invoke("gemini_start_stream", { model: m, contents: historyPayload });
      } else {
        await invoke("openai_start_stream", { model: m, contents: historyPayload });
      }
    } catch (e) {
      setErr(String(e));
      setTurns((prev) => prev.slice(0, -1));
      setDraft(text);
      setSending(false);
      streamAccRef.current = "";
      setStreamText("");
    }
  }, [draft, provider, model, sending, turns, sessionReady, activeChatId, chatTitle, refreshChats]);

  const onModelChange = useCallback(
    async (next: string) => {
      setModel(next);
      if (!isTauri() || !activeChatId || sending) return;
      try {
        await invoke("save_gemini_conversation", {
          id: activeChatId,
          provider,
          model: next,
          title: chatTitle,
          turns: turnPayload(turns),
        });
        await refreshChats();
      } catch {
        /* ignore; model still use next for next send */
      }
    },
    [activeChatId, provider, chatTitle, turns, sending, refreshChats],
  );

  const onProviderSet = useCallback(
    async (p: AiProvider) => {
      if (p === provider || !isTauri() || !sessionReady || sending) return;
      const g = nextChatNavGen();
      setErr(null);
      const firstModel = (p === "gemini" ? GEMINI_MODELS : GPT_MODELS)[0].id;
      try {
        await saveCurrentConv();
        if (isStaleChatNav(g)) {
          return;
        }
        let list = (await invoke("list_gemini_chats", { provider: p })) as ChatListItem[];
        if (isStaleChatNav(g)) {
          return;
        }
        if (list.length === 0) {
          await invoke("new_gemini_chat", { provider: p });
          list = (await invoke("list_gemini_chats", { provider: p })) as ChatListItem[];
        }
        if (isStaleChatNav(g)) {
          return;
        }
        const first = list[0];
        if (first) {
          const f = (await invoke("load_gemini_chat", { id: first.id, provider: p })) as {
            id: string;
            title: string;
            model: string;
            turns: { role: string; text: string }[];
          };
          if (isStaleChatNav(g)) {
            return;
          }
          setProvider(p);
          setChats(list);
          setActiveChatId(f.id);
          setChatTitle(f.title);
          setModel(normalizeModel(p, f.model));
          setTurns(
            f.turns.map((t) => ({
              role: t.role === "model" ? "model" : "user",
              text: t.text,
            })),
          );
        } else {
          if (isStaleChatNav(g)) {
            return;
          }
          setProvider(p);
          setChats(list);
          setActiveChatId(null);
          setChatTitle("New chat");
          setModel(firstModel);
          setTurns([]);
        }
        setDraft("");
        if (isStaleChatNav(g)) {
          return;
        }
        await refreshChats(p);
      } catch (e) {
        if (!isStaleChatNav(g)) {
          setErr(String(e));
        }
      }
    },
    [provider, sessionReady, sending, saveCurrentConv, refreshChats],
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
      aria-label="AI (API)"
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
          <span className="gemini-pnl-titletext">AI</span>
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
                  {chats.map((c) => {
                    const isSelected = c.id === activeChatId;
                    return (
                      <li
                        key={c.id}
                        className={`gemini-hist-item ${isSelected ? "is-active" : ""}`}
                        onClick={() => void openChat(c.id)}
                        title={c.title}
                        aria-current={isSelected ? "true" : undefined}
                      >
                        <div className="gemini-hist-main">
                          <span className="gemini-hist-title">{c.title || "—"}</span>
                          <span className="gemini-hist-time">{formatChatTime(c.updated_at)}</span>
                        </div>
                        <div className="gemini-hist-tools" onClick={(e) => e.stopPropagation()}>
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
                    );
                  })}
                </ul>
              )}
            </aside>
          )}

          <div className="gemini-pnl-main">
            <div className="win-pop-body gemini-pnl-body">
              {!isTauri() && (
                <p className="win-pop-txt" style={{ marginTop: 0 }}>
                  The AI panel uses the app backend and only runs in the desktop (Tauri) build. Open with{" "}
                  <code className="win-pop-code">npm run tauri dev</code>. Saved chats and keys are available
                  there only.
                </p>
              )}

              {isTauri() && (
                <>
                <p className="win-pop-txt" style={{ marginTop: 0 }}>
                  Keys stay in your app data folder; requests go from Rust, not the webview. Chats are saved
                  as local files.{" "}
                    {provider === "gemini" ? (
                      <button
                        type="button"
                        className="win-link-btn"
                        onClick={() => void openUrl("https://aistudio.google.com/apikey")}
                      >
                        Google AI key
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="win-link-btn"
                        onClick={() => void openUrl("https://platform.openai.com/api-keys")}
                      >
                        OpenAI key
                      </button>
                    )}
                  </p>
                  <div className="ai-pnl-provt" role="group" aria-label="Model provider">
                    <span className="ai-pnl-provt-lab">Use</span>
                    <button
                      type="button"
                      className={`ai-pnv-btn ${provider === "gemini" ? "is-on" : ""}`}
                      onClick={() => void onProviderSet("gemini")}
                      disabled={!sessionReady || sending}
                    >
                      Gemini
                    </button>
                    <button
                      type="button"
                      className={`ai-pnv-btn ${provider === "gpt" ? "is-on" : ""}`}
                      onClick={() => void onProviderSet("gpt")}
                      disabled={!sessionReady || sending}
                    >
                      GPT
                    </button>
                  </div>
                  <div className="gemini-pnl-keyrow">
                    <input
                      type="password"
                      className="win-pop-inp"
                      placeholder={
                        hasKey
                          ? "•••• key on file — paste to replace"
                          : provider === "gemini"
                            ? "Google Generative Language API key"
                            : "OpenAI API key (sk-…)"
                      }
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
                  <label className="win-pop-lab" htmlFor="ai-model" style={{ marginTop: 6 }}>
                    Model
                  </label>
                  <select
                    id="ai-model"
                    className="win-pop-inp gemini-pnl-select"
                    value={model}
                    onChange={(e) => void onModelChange(e.target.value)}
                    disabled={!hasKey || !sessionReady}
                  >
                    {modelsForProvider.map((m) => (
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
                        chatId={activeChatId ?? ""}
                        sentToEditorKeys={sentToEditorKeys}
                        onRunFromAi={onRunFromAi}
                        running={running}
                        assistantLabel={assistantLabel}
                      />
                    )}
                  </div>
                ))}
                {sending && (
                  <div className="gemini-msg gemini-msg-model">
                    <GeminiModelMessage
                      text={streamText}
                      turnIndex={turns.length}
                      copyFlashKey={copyFlashKey}
                      onCopy={flashCopy}
                      onSendToEditor={onSendCodeToEditor ? sendCodeToEditor : undefined}
                      chatId={activeChatId ?? ""}
                      sentToEditorKeys={sentToEditorKeys}
                      onRunFromAi={onRunFromAi}
                      running={running}
                      assistantLabel={assistantLabel}
                      streaming
                    />
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

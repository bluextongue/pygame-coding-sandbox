import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AiStreamHandlers = {
  onChunk: (piece: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
};

const noopHandlers: AiStreamHandlers = {
  onChunk: () => {},
  onDone: () => {},
  onError: () => {},
};

let handlerGetter: () => AiStreamHandlers = () => noopHandlers;

/** Latest handlers (updated every GeminiPanel render). Listeners always call through this. */
export function setAiStreamHandlerGetter(get: () => AiStreamHandlers) {
  handlerGetter = get;
}

export function resetAiStreamHandlers() {
  handlerGetter = () => noopHandlers;
}

let listenersPromise: Promise<void> | null = null;

/**
 * One global registration for gemini/openai stream events. Duplicate `listen()` calls were
 * doubling every streamed chunk in the UI (`importimport`, etc.).
 */
export function initAiStreamListenersOnce(): Promise<void> {
  if (listenersPromise) return listenersPromise;
  if (!isTauri()) {
    listenersPromise = Promise.resolve();
    return listenersPromise;
  }
  listenersPromise = (async () => {
    const onChunk = (e: { payload: unknown }) => {
      const piece = e.payload;
      if (typeof piece === "string" && piece.length) {
        handlerGetter().onChunk(piece);
      }
    };
    const onErr = (e: { payload: unknown }) => {
      const msg = typeof e.payload === "string" ? e.payload : "stream error";
      handlerGetter().onError(msg);
    };
    await Promise.all([
      listen("gemini-stream-chunk", onChunk),
      listen("gemini-stream-done", () => {
        handlerGetter().onDone();
      }),
      listen<string>("gemini-stream-error", onErr),
      listen("openai-stream-chunk", onChunk),
      listen("openai-stream-done", () => {
        handlerGetter().onDone();
      }),
      listen<string>("openai-stream-error", onErr),
    ]);
  })();
  return listenersPromise;
}

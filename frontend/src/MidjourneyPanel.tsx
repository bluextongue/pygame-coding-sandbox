import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type Props = {
  open: boolean;
  onClose: () => void;
  onAssetsChanged?: () => void;
  /** Fires when a Midjourney generation starts or fully finishes (while the panel is closed, too). */
  onGenActivityChange?: (busy: boolean) => void;
};

type MjRect = { x: number; y: number; w: number; h: number };
type MjWinEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MJ_PNL_MIN_W = 380;
const MJ_PNL_MIN_H = 320;

function mjDefaultWindowRect(): MjRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(MJ_PNL_MIN_W, Math.min(vw * 0.88, 820));
  const h = Math.max(MJ_PNL_MIN_H, Math.min(vh * 0.82, 720));
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}

function mjClampRect(r: MjRect): MjRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let { x, y, w, h } = r;
  w = Math.max(MJ_PNL_MIN_W, w);
  h = Math.max(MJ_PNL_MIN_H, h);
  w = Math.min(w, vw);
  h = Math.min(h, vh);
  x = Math.max(0, Math.min(x, vw - w));
  y = Math.max(0, Math.min(y, vh - h));
  return { x, y, w, h };
}

function mjApplyResize(r: MjRect, edge: MjWinEdge, dx: number, dy: number): MjRect {
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

const MJ_RESIZE_GRIPS: readonly MjWinEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function b64ToBytes(dataUrlOrB64: string): Uint8Array {
  const s = dataUrlOrB64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extractWaveSpeedData(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const d = v.data;
    if (d && typeof d === "object") return d as Record<string, unknown>;
    return v;
  } catch {
    return null;
  }
}

function extractOutputs(data: Record<string, unknown>): string[] {
  const outs = data.outputs;
  if (!Array.isArray(outs)) return [];
  const r: string[] = [];
  for (const item of outs) {
    if (typeof item === "string" && item.length > 0) r.push(item);
    else if (item && typeof item === "object" && "url" in item) {
      const u = (item as { url?: unknown }).url;
      if (typeof u === "string" && u.length > 0) r.push(u);
    }
  }
  return r;
}

async function outputRefToBytes(ref: string): Promise<Uint8Array> {
  const t = ref.trim();
  if (t.startsWith("data:")) {
    return b64ToBytes(t);
  }
  if (t.startsWith("https://")) {
    const arr = (await invoke("fetch_mj_output_bytes", { url: t })) as number[];
    return new Uint8Array(arr);
  }
  if (t.length > 64 && !t.includes("://") && !t.includes("/")) {
    return b64ToBytes(`data:image/png;base64,${t}`);
  }
  throw new Error(`Unsupported output format (first 80 chars): ${t.slice(0, 80)}`);
}

type ActiveGameRef = { id: string };

async function finalizeSaveStatus(
  baseLine: string,
  requestedFileName: string,
  finalName: string,
  targetProjectId: string,
): Promise<string> {
  const now = (await invoke("get_active_game")) as ActiveGameRef;
  let s = baseLine;
  if (finalName !== requestedFileName) {
    s += ` — saved as "${finalName}" (name collision).`;
  }
  if (now.id !== targetProjectId) {
    s += " — file is in the project that was active when you started.";
  }
  return s;
}

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2", "9:21", "21:9"] as const;
const MJ_VERSIONS = ["6", "6.1", "7"] as const;
const MJ_QUALITY = [0.25, 0.5, 1, 2] as const;

export function MidjourneyPanel({ open, onClose, onAssetsChanged, onGenActivityChange }: Props) {
  const [keyInput, setKeyInput] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [prompt, setPrompt] = useState("cinematic portrait of a robot explorer, golden hour, detailed");
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>("1:1");
  const [stylize, setStylize] = useState(150);
  const [chaos, setChaos] = useState(0);
  const [weird, setWeird] = useState(0);
  const [version, setVersion] = useState<(typeof MJ_VERSIONS)[number]>("7");
  const [quality, setQuality] = useState<(typeof MJ_QUALITY)[number]>(1);
  const [seed, setSeed] = useState(-1);
  const [saveName, setSaveName] = useState("midjourney_1.png");
  const [saveGrid, setSaveGrid] = useState(false);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [jsonDebug, setJsonDebug] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const previewUrlsRef = useRef<string[]>([]);

  const [frame, setFrame] = useState<MjRect>(() => mjDefaultWindowRect());
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const clearPreviewObjectUrls = () => {
    for (const u of previewUrlsRef.current) {
      URL.revokeObjectURL(u);
    }
    previewUrlsRef.current = [];
  };

  const setPreviewBlobs = (allBytes: Uint8Array[]) => {
    clearPreviewObjectUrls();
    const next: string[] = [];
    for (const bytes of allBytes) {
      const u = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      next.push(u);
    }
    previewUrlsRef.current = next;
    setPreviewUrls(next);
  };

  useEffect(
    () => () => {
      clearPreviewObjectUrls();
    },
    [],
  );

  const refreshKey = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setHasKey((await invoke("midjourney_key_configured")) as boolean);
    } catch {
      setHasKey(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshKey();
  }, [open, refreshKey]);

  useEffect(() => {
    onGenActivityChange?.(busy);
  }, [busy, onGenActivityChange]);

  const saveKey = async () => {
    if (!isTauri()) return;
    setErr(null);
    try {
      await invoke("save_midjourney_api_key", { key: keyInput });
      setKeyInput("");
      await refreshKey();
    } catch (e) {
      setErr(String(e));
    }
  };

  const clearKey = async () => {
    if (!isTauri()) return;
    setErr(null);
    try {
      await invoke("save_midjourney_api_key", { key: "" });
      await refreshKey();
    } catch (e) {
      setErr(String(e));
    }
  };

  const pollPrediction = useCallback(async (predictionId: string) => {
    for (let i = 0; i < 150; i++) {
      const txt = (await invoke("wavespeed_midjourney_prediction_result", {
        predictionId,
      })) as string;
      const data = extractWaveSpeedData(txt);
      if (!data) {
        throw new Error("Invalid prediction JSON");
      }
      const st = String(data.status || "").toLowerCase();
      if (st === "failed" || st === "error") {
        throw new Error(String(data.error || data.message || "Generation failed"));
      }
      if (st === "completed" || st === "complete" || st === "succeeded") {
        return { text: txt, data };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("Timed out waiting for Midjourney (WaveSpeed). Try again.");
  }, []);

  const onGenerate = async () => {
    if (!isTauri() || !hasKey) return;
    const p = prompt.trim();
    if (!p) return;
    setErr(null);
    setStatusLine(null);
    setJsonDebug(null);
    setBusy(true);
    clearPreviewObjectUrls();
    setPreviewUrls([]);
    try {
      const targetProject = (await invoke("get_active_game")) as ActiveGameRef;
      const requested = saveName.trim() || "midjourney.png";
      const body = {
        prompt: p,
        aspect_ratio: aspectRatio,
        quality,
        stylize: Math.max(0, Math.min(1000, Math.round(stylize))),
        chaos: Math.max(0, Math.min(100, Math.round(chaos))),
        weird: Math.max(0, Math.min(3000, Math.round(weird))),
        version,
        seed: seed < 0 ? -1 : Math.min(2147483647, Math.max(0, Math.round(seed))),
        enable_base64_output: true,
      };
      const submitTxt = (await invoke("wavespeed_midjourney_submit", { body })) as string;
      setJsonDebug(submitTxt.slice(0, 2500));
      const submitData = extractWaveSpeedData(submitTxt);
      const predId = submitData && typeof submitData.id === "string" ? submitData.id : null;
      if (!predId) {
        setErr("No task id in WaveSpeed response. See debug JSON.");
        return;
      }
      const { text: doneTxt, data: doneData } = await pollPrediction(predId);
      setJsonDebug(`${submitTxt.slice(0, 1200)}\n\n--- poll ---\n\n${doneTxt.slice(0, 4000)}`);
      const outs = extractOutputs(doneData);
      if (outs.length === 0) {
        setErr("No images in completed task. See debug JSON.");
        return;
      }
      if (saveGrid) {
        const stem = requested.replace(/\.(png|jpe?g|webp)$/i, "") || "midjourney";
        const extMatch = requested.match(/(\.[a-z]+)$/i);
        const ext = extMatch ? extMatch[1].toLowerCase() : ".png";
        const forPreview: Uint8Array[] = [];
        for (let idx = 0; idx < outs.length; idx++) {
          const bytes = await outputRefToBytes(outs[idx]!);
          forPreview.push(bytes);
          const fn = `${stem}_${idx + 1}${ext}`;
          await invoke("write_project_asset_bytes", {
            filename: fn,
            data: Array.from(bytes),
            project_id: targetProject.id,
          });
        }
        onAssetsChanged?.();
        setStatusLine(
          await finalizeSaveStatus(
            `Saved ${outs.length} images (${stem}_1${ext} …)`,
            `${stem}_1${ext}`,
            `${stem}_1${ext}`,
            targetProject.id,
          ),
        );
        setPreviewBlobs(forPreview);
      } else {
        const bytes = await outputRefToBytes(outs[0]!);
        const name = (await invoke("write_project_asset_bytes", {
          filename: requested,
          data: Array.from(bytes),
          project_id: targetProject.id,
        })) as string;
        onAssetsChanged?.();
        let msg = await finalizeSaveStatus(`Saved ${name}`, requested, name, targetProject.id);
        if (outs.length > 1) {
          msg += ` — ${outs.length} variants; enable “Save all grid” to save each file.`;
        }
        setStatusLine(msg);
        setPreviewBlobs([bytes]);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onMjTitleBarMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".win9x-close-btn, .midjourney-head-actions")) return;
    e.preventDefault();
    const r0 = { ...frameRef.current };
    document.body.classList.add("gemini-pnl-noselect");
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: MouseEvent) => {
      setFrame(mjClampRect({ ...r0, x: r0.x + (ev.clientX - sx), y: r0.y + (ev.clientY - sy) }));
    };
    const onUp = () => {
      document.body.classList.remove("gemini-pnl-noselect");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const onMjResizeGripMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>, edge: MjWinEdge) => {
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
      setFrame(mjClampRect(mjApplyResize(r0, edge, dx, dy)));
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
      setFrame((f) => mjClampRect(f));
    }
  }, [open]);

  useEffect(() => {
    const onWinResize = () => {
      setFrame((f) => mjClampRect(f));
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

  return (
    <div
      className="midjourney-pnl-outer"
      role="dialog"
      aria-label="Midjourney"
      aria-hidden={!open}
      inert={!open ? true : undefined}
      style={{
        position: "fixed",
        left: frame.x,
        top: frame.y,
        width: frame.w,
        height: frame.h,
        zIndex: 1,
      }}
    >
      <div className="win-pop midjourney-win" onMouseDown={(e) => e.stopPropagation()}>
        <div
          className="win-pop-head midjourney-head"
          onMouseDown={onMjTitleBarMouseDown}
          title="Drag to move"
        >
          <span className="midjourney-titletext">Midjourney</span>
          <div className="midjourney-head-actions">
            <button
              type="button"
              className="win-link-btn"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() =>
                void openUrl("https://wavespeed.ai/docs-api/midjourney/midjourney-text-to-image")
              }
            >
              API docs
            </button>
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
        </div>
        <div className="win-pop-body midjourney-body">
          {!isTauri() && (
            <p className="win-pop-txt" style={{ marginTop: 0 }}>
              Midjourney generation runs in the desktop app so your API key stays local.
            </p>
          )}
          {isTauri() && (
            <>
              <p className="midjourney-hint" style={{ marginTop: 0 }}>
                Text-to-image using WaveSpeed’s hosted <strong>Midjourney</strong> model (
                <code className="win-pop-code">/api/v3/midjourney/text-to-image</code>). Midjourney does not ship a
                public HTTP API; this uses WaveSpeed’s documented REST surface. Get a key at{" "}
                <button type="button" className="win-link-btn" onClick={() => void openUrl("https://wavespeed.ai/")}>
                  wavespeed.ai
                </button>
                .
              </p>
              <div className="midjourney-keyrow">
                <input
                  className="win-pop-inp"
                  type="password"
                  placeholder={hasKey ? "•••• key on file — paste to replace" : "WaveSpeed API key"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  autoComplete="off"
                />
                <button type="button" className="win-btn" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
                  Save
                </button>
                {hasKey && (
                  <button type="button" className="win-btn" onClick={() => void clearKey()}>
                    Remove
                  </button>
                )}
              </div>
              <label className="win-pop-lab" htmlFor="mj-prompt">
                Prompt
              </label>
              <textarea
                id="mj-prompt"
                className="win-pop-inp midjourney-ta"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={busy}
              />
              <div className="midjourney-grid2">
                <div>
                  <label className="win-pop-lab" htmlFor="mj-ar">
                    Aspect
                  </label>
                  <select
                    id="mj-ar"
                    className="win-pop-inp"
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value as (typeof ASPECT_RATIOS)[number])}
                    disabled={busy}
                  >
                    {ASPECT_RATIOS.map((ar) => (
                      <option key={ar} value={ar}>
                        {ar}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="win-pop-lab" htmlFor="mj-ver">
                    Version
                  </label>
                  <select
                    id="mj-ver"
                    className="win-pop-inp"
                    value={version}
                    onChange={(e) => setVersion(e.target.value as (typeof MJ_VERSIONS)[number])}
                    disabled={busy}
                  >
                    {MJ_VERSIONS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="win-pop-lab" htmlFor="mj-q">
                    Quality
                  </label>
                  <select
                    id="mj-q"
                    className="win-pop-inp"
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value) as (typeof MJ_QUALITY)[number])}
                    disabled={busy}
                  >
                    {MJ_QUALITY.map((q) => (
                      <option key={q} value={q}>
                        {q}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="win-pop-lab" htmlFor="mj-seed">
                    Seed (−1 random)
                  </label>
                  <input
                    id="mj-seed"
                    className="win-pop-inp midjourney-num"
                    type="number"
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value) || -1)}
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="midjourney-grid3">
                <div>
                  <label className="win-pop-lab" htmlFor="mj-stylize">
                    Stylize
                  </label>
                  <input
                    id="mj-stylize"
                    className="win-pop-inp midjourney-num"
                    type="number"
                    min={0}
                    max={1000}
                    value={stylize}
                    onChange={(e) => setStylize(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))}
                    disabled={busy}
                  />
                </div>
                <div>
                  <label className="win-pop-lab" htmlFor="mj-chaos">
                    Chaos
                  </label>
                  <input
                    id="mj-chaos"
                    className="win-pop-inp midjourney-num"
                    type="number"
                    min={0}
                    max={100}
                    value={chaos}
                    onChange={(e) => setChaos(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                    disabled={busy}
                  />
                </div>
                <div>
                  <label className="win-pop-lab" htmlFor="mj-weird">
                    Weird
                  </label>
                  <input
                    id="mj-weird"
                    className="win-pop-inp midjourney-num"
                    type="number"
                    min={0}
                    max={3000}
                    value={weird}
                    onChange={(e) => setWeird(Math.max(0, Math.min(3000, Number(e.target.value) || 0)))}
                    disabled={busy}
                  />
                </div>
              </div>
              <label className="midjourney-tgl" style={{ marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={saveGrid}
                  onChange={(e) => setSaveGrid(e.target.checked)}
                  disabled={busy}
                />
                <span>Save all grid images (Midjourney returns several variants)</span>
              </label>
              <label className="win-pop-lab" htmlFor="mj-fn" style={{ marginTop: 6 }}>
                Save as
              </label>
              <input
                id="mj-fn"
                className="win-pop-inp"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                disabled={busy}
              />
              {err && <p className="midjourney-err">{err}</p>}
              {busy && (
                <p className="midjourney-status midjourney-status-working" aria-live="polite">
                  {statusLine || "Working…"}
                </p>
              )}
              {!busy && statusLine && <p className="midjourney-status">{statusLine}</p>}
              <div className="midjourney-go">
                <button type="button" className="win-btn" onClick={() => void onGenerate()} disabled={busy || !hasKey || !prompt.trim()}>
                  {busy ? "…" : "Generate"}
                </button>
              </div>
              {previewUrls.length > 0 && (
                <div
                  className={`midjourney-preview${
                    previewUrls.length > 1 ? " midjourney-preview--grid" : ""
                  }`}
                >
                  {previewUrls.map((u, i) => (
                    <img
                      key={u}
                      src={u}
                      alt={`Result ${i + 1} of ${previewUrls.length}`}
                      className="midjourney-preview-img"
                    />
                  ))}
                </div>
              )}
              {jsonDebug && (
                <details className="midjourney-json">
                  <summary>Response (debug)</summary>
                  <pre className="midjourney-pre">{jsonDebug}</pre>
                </details>
              )}
            </>
          )}
        </div>
      </div>
      <div className="gemini-pnl-grips" aria-hidden>
        {MJ_RESIZE_GRIPS.map((edge) => (
          <div
            key={edge}
            className={`gemini-pnl-grip gemini-pnl-grip--${edge}`}
            onMouseDown={(e) => onMjResizeGripMouseDown(e, edge)}
            title="Resize"
          />
        ))}
      </div>
    </div>
  );
}

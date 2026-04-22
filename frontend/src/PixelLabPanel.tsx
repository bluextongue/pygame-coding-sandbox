import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type MainTab = "still" | "motion" | "motionPrompt" | "background";

type Props = {
  open: boolean;
  onClose: () => void;
  onAssetsChanged?: () => void;
  /** Filenames in the project (same as Assets panel); Motion tab lists `.png` here. */
  projectAssets?: string[];
};

function b64ToBytes(dataUrlOrB64: string): Uint8Array {
  const s = dataUrlOrB64.replace(/^data:image\/\w+;base64,/, "").trim();
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extractFromEnvelope(json: string): { raw: unknown; data: unknown } {
  const v = JSON.parse(json) as Record<string, unknown>;
  if ("data" in v && v.data !== undefined) {
    return { raw: v, data: v.data };
  }
  return { raw: v, data: v };
}

function apiErrorMessage(json: string): string | null {
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (v.success === false && v.error != null) return String(v.error);
    if (v.error != null) return String(v.error);
    const d = (v.data ?? v) as Record<string, unknown> | null;
    if (d && d.error != null) return String(d.error);
  } catch {
    // ignore
  }
  return null;
}

/** Pull frame image base64 strings from a completed job payload (nested). */
function extractFrameBase64s(root: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (s: string) => {
    const t = s.trim();
    if (t.length < 20) return;
    if (seen.has(t)) return;
    seen.add(t);
    found.push(t);
  };

  const walk = (o: unknown) => {
    if (o == null) return;
    if (typeof o === "string") {
      if (o.length > 80 && (o.startsWith("iVBOR") || o.startsWith("/9j/"))) push(`data:image/png;base64,${o}`);
      return;
    }
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    if (typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    if (typeof r.base64 === "string") {
      const b = r.base64;
      push(b.startsWith("data:") ? b : `data:image/png;base64,${b}`);
    }
    const img = r.image;
    if (img && typeof img === "object") {
      const ib = (img as { base64?: string }).base64;
      if (typeof ib === "string") push(ib.startsWith("data:") ? ib : `data:image/png;base64,${ib}`);
    }
    for (const v of Object.values(r)) walk(v);
  };

  walk(root);
  return found;
}

async function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Image load failed"));
    im.src = src;
  });
}

/** PixelLab v3: max 256×256 for the still; scale down proportionally. */
async function scaleImageToPngDataUrlMax256(im: HTMLImageElement): Promise<string> {
  let { width: iw, height: ih } = im;
  const max = 256;
  if (iw <= max && ih <= max) {
    const c = document.createElement("canvas");
    c.width = iw;
    c.height = ih;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas unsupported");
    ctx.drawImage(im, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!blob) throw new Error("toBlob failed");
    return await blobToDataUrl(blob);
  }
  const scale = Math.min(max / iw, max / ih);
  const ow = Math.max(1, Math.round(iw * scale));
  const oh = Math.max(1, Math.round(ih * scale));
  const c = document.createElement("canvas");
  c.width = ow;
  c.height = oh;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas unsupported");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(im, 0, 0, ow, oh);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  return await blobToDataUrl(blob);
}

async function scaleFileToDataUrlMax256(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const im = await loadImageEl(url);
    return await scaleImageToPngDataUrlMax256(im);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Project asset or other image URL (e.g. `convertFileSrc`); no revoke. */
async function scaleImageUrlToDataUrlMax256(url: string): Promise<string> {
  const im = await loadImageEl(url);
  return await scaleImageToPngDataUrlMax256(im);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

/** PixelLab runs can take minutes; always save to the project that was open when the user clicked Generate. */
type ActiveGameRef = { id: string };

async function finalizeSaveStatus(
  baseLine: string,
  requestedFileName: string,
  finalName: string,
  targetProjectId: string,
): Promise<string> {
  const now = (await invoke("get_active_game") as ActiveGameRef).id;
  let s = baseLine;
  if (finalName !== requestedFileName) {
    s += ` — look for the exact name "${finalName}" in Assets (a file named "${requestedFileName}" was already in this project).`;
  }
  if (now !== targetProjectId) {
    s += " — the file is in the project that was open when you started; use the project menu to switch back to see it in Assets.";
  }
  return s;
}

async function stitchFramesHorizontalPng(b64OrDataUrls: string[]): Promise<Uint8Array> {
  if (b64OrDataUrls.length === 0) throw new Error("No frames to stitch");
  const imgs = await Promise.all(b64OrDataUrls.map((s) => loadImageEl(s.startsWith("data:") ? s : `data:image/png;base64,${s}`)));
  const h = Math.max(...imgs.map((i) => i.naturalHeight || i.height));
  const w = imgs.reduce((acc, i) => acc + (i.naturalWidth || i.width), 0);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas unsupported");
  ctx.imageSmoothingEnabled = false;
  let x = 0;
  for (const im of imgs) {
    const iw = im.naturalWidth || im.width;
    const ih = im.naturalHeight || im.height;
    const y = Math.floor((h - ih) / 2);
    ctx.drawImage(im, x, y);
    x += iw;
  }
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("Export failed");
  return new Uint8Array(await blob.arrayBuffer());
}

export function PixelLabPanel({ open, onClose, onAssetsChanged, projectAssets = [] }: Props) {
  const [tab, setTab] = useState<MainTab>("still");

  const [keyInput, setKeyInput] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);

  const [description, setDescription] = useState("cute 16-bit potion bottle, centered");
  const [w, setW] = useState(64);
  const [h, setH] = useState(64);
  const [noBackground, setNoBackground] = useState(true);

  const [motionAction, setMotionAction] = useState("walking forward, loopable");
  const [frameCount, setFrameCount] = useState(8);
  const [motionFile, setMotionFile] = useState<File | null>(null);
  const [motionProjectPng, setMotionProjectPng] = useState<string | null>(null);
  const motionInputRef = useRef<HTMLInputElement>(null);

  const [motionPromptDesc, setMotionPromptDesc] = useState("cute 16-bit hero, side view, centered");
  const [motionPromptW, setMotionPromptW] = useState(64);
  const [motionPromptH, setMotionPromptH] = useState(64);

  const motionPngsInProject = projectAssets.filter((n) => /\.png$/i.test(n));

  const [bgDescription, setBgDescription] = useState("parallax-ready pixel sky, clouds, distant hills, soft colors");
  const [bgW, setBgW] = useState(512);
  const [bgH, setBgH] = useState(288);

  const [saveName, setSaveName] = useState("sprite.png");
  const [sheetName, setSheetName] = useState("walk_strip.png");
  const [bgFileName, setBgFileName] = useState("background.png");

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [lastPreview, setLastPreview] = useState<string | null>(null);
  const [jsonDebug, setJsonDebug] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const setPreviewBlob = (bytes: Uint8Array) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    const u = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    previewUrlRef.current = u;
    setLastPreview(u);
  };

  useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    },
    [],
  );

  const refreshKey = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setHasKey((await invoke("pixellab_key_configured")) as boolean);
    } catch {
      setHasKey(false);
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!isTauri() || !hasKey) {
      setBalance(null);
      return;
    }
    try {
      const t = (await invoke("pixellab_v2_get", { path: "/balance" })) as string;
      const { data } = extractFromEnvelope(t);
      setBalance(data ? JSON.stringify(data) : t);
    } catch {
      setBalance(null);
    }
  }, [hasKey]);

  useEffect(() => {
    if (!open) return;
    void refreshKey();
  }, [open, refreshKey]);

  useEffect(() => {
    if (!open) return;
    onAssetsChanged?.();
  }, [open, onAssetsChanged]);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    void refreshBalance();
  }, [open, hasKey, refreshBalance]);

  const saveKey = async () => {
    if (!isTauri()) return;
    setErr(null);
    try {
      await invoke("save_pixellab_api_key", { key: keyInput });
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
      await invoke("save_pixellab_api_key", { key: "" });
      await refreshKey();
    } catch (e) {
      setErr(String(e));
    }
  };

  const pollJob = useCallback(async (jobId: string) => {
    const path = `/background-jobs/${jobId}`;
    for (let i = 0; i < 120; i++) {
      setStatusLine(`Job ${jobId.slice(0, 8)}… (poll ${i + 1}/120, ~5s)`);
      const t = (await invoke("pixellab_v2_get", { path })) as string;
      const { data, raw } = extractFromEnvelope(t);
      const payload = (data ?? raw) as Record<string, unknown> | null;
      const st = String(payload?.status || "").toLowerCase();
      if (
        st === "completed" ||
        st === "complete" ||
        st === "succeeded" ||
        st === "failed" ||
        st === "canceled" ||
        st === "cancelled" ||
        st === "error"
      ) {
        return { payload, text: t };
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error("Timed out waiting for the PixelLab job (try again or check the web app).");
  }, []);

  /** `firstFrameDataUrl` must already be scaled to max 256×256 (PNG data URL). */
  const runMotionV3Pipeline = useCallback(
    async (firstFrameDataUrl: string, targetProjectId: string) => {
      const requested = sheetName.trim() || "strip.png";
      const fc = Math.max(4, Math.min(16, frameCount - (frameCount % 2)));
      if (fc !== frameCount) setFrameCount(fc);

      const body = {
        first_frame: { type: "base64" as const, base64: firstFrameDataUrl, format: "png" as const },
        action: motionAction.trim() || "idle",
        frame_count: fc,
        no_background: noBackground,
        seed: 0,
      };
      const t = (await invoke("pixellab_v2_post", { path: "/animate-with-text-v3", body })) as string;
      setJsonDebug(t.slice(0, 2000));
      const emsg = apiErrorMessage(t);
      if (emsg) {
        setErr(emsg);
        return;
      }
      const root = JSON.parse(t) as Record<string, unknown>;
      const d = (root["data"] ?? root) as Record<string, unknown>;
      const jobId = (d["background_job_id"] as string) || (root["background_job_id"] as string);
      if (!jobId) {
        setErr("No job id (expected background_job_id).");
        return;
      }
      const { payload, text: doneText } = await pollJob(jobId);
      setJsonDebug((doneText || JSON.stringify(payload)).slice(0, 6000));
      const pMotion = (payload || {}) as Record<string, unknown>;
      if (pMotion.status === "failed" || pMotion.status === "canceled") {
        setErr(String(pMotion.error || pMotion.message || pMotion.detail || "Animation job did not complete."));
        return;
      }
      const frames = extractFrameBase64s(payload ?? {});
      if (frames.length === 0) {
        setErr("Job finished but no frames were found in the response. See debug JSON below.");
        return;
      }
      const sheet = await stitchFramesHorizontalPng(frames);
      const name = (await invoke("write_project_asset_bytes", {
        filename: requested,
        data: Array.from(sheet),
        project_id: targetProjectId,
      })) as string;
      onAssetsChanged?.();
      setStatusLine(
        await finalizeSaveStatus(
          `Saved horizontal sheet (${frames.length} frames) as ${name}`,
          requested,
          name,
          targetProjectId,
        ),
      );
      setPreviewBlob(sheet);
    },
    [frameCount, motionAction, noBackground, sheetName, pollJob, onAssetsChanged],
  );

  const onGenerateStill = async () => {
    if (!isTauri() || !hasKey) return;
    setErr(null);
    setStatusLine(null);
    setJsonDebug(null);
    setBusy(true);
    setLastPreview(null);
    try {
      const targetProject = (await invoke("get_active_game") as ActiveGameRef);
      const requested = saveName.trim() || "sprite.png";
      const cw = Math.max(16, Math.min(400, w));
      const ch = Math.max(16, Math.min(400, h));
      if (cw !== w || ch !== h) {
        setW(cw);
        setH(ch);
      }
      const body = {
        description: description.trim() || "pixel art",
        image_size: { width: cw, height: ch },
        no_background: noBackground,
      };
      const t = (await invoke("pixellab_v2_post", { path: "/create-image-pixflux", body })) as string;
      setJsonDebug(t.slice(0, 1500));
      const emsg = apiErrorMessage(t);
      if (emsg) {
        setErr(emsg);
        return;
      }
      const { data } = extractFromEnvelope(t);
      const raw = data ?? JSON.parse(t);
      const b64 = extractFrameBase64s(raw)[0];
      if (!b64) {
        setErr("No image in response");
        return;
      }
      const bytes = b64ToBytes(b64);
      const name = (await invoke("write_project_asset_bytes", {
        filename: requested,
        data: Array.from(bytes),
        project_id: targetProject.id,
      })) as string;
      onAssetsChanged?.();
      setStatusLine(await finalizeSaveStatus(`Saved ${name}`, requested, name, targetProject.id));
      setPreviewBlob(bytes);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onGenerateMotion = async () => {
    if (!isTauri() || !hasKey) return;
    if (!motionFile && !motionProjectPng) return;
    setErr(null);
    setStatusLine(null);
    setJsonDebug(null);
    setBusy(true);
    setLastPreview(null);
    try {
      const targetProject = (await invoke("get_active_game") as ActiveGameRef);
      const dataUrl = motionProjectPng
        ? await (async () => {
            const p = (await invoke("resolve_asset_path", { name: motionProjectPng })) as string;
            return await scaleImageUrlToDataUrlMax256(convertFileSrc(p));
          })()
        : await scaleFileToDataUrlMax256(motionFile!);
      await runMotionV3Pipeline(dataUrl, targetProject.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onGenerateMotionFromPrompt = async () => {
    if (!isTauri() || !hasKey) return;
    const desc = motionPromptDesc.trim();
    if (!desc) return;
    setErr(null);
    setStatusLine(null);
    setJsonDebug(null);
    setBusy(true);
    setLastPreview(null);
    try {
      const targetProject = (await invoke("get_active_game") as ActiveGameRef);
      const cw = Math.max(16, Math.min(400, motionPromptW));
      const ch = Math.max(16, Math.min(400, motionPromptH));
      if (cw !== motionPromptW) setMotionPromptW(cw);
      if (ch !== motionPromptH) setMotionPromptH(ch);
      setStatusLine("Generating first frame (Pixflux)…");
      const stillBody = {
        description: desc,
        image_size: { width: cw, height: ch },
        no_background: noBackground,
      };
      const t0 = (await invoke("pixellab_v2_post", { path: "/create-image-pixflux", body: stillBody })) as string;
      setJsonDebug(t0.slice(0, 1500));
      const emsg0 = apiErrorMessage(t0);
      if (emsg0) {
        setErr(emsg0);
        return;
      }
      const { data } = extractFromEnvelope(t0);
      const raw = data ?? JSON.parse(t0);
      const b64 = extractFrameBase64s(raw)[0];
      if (!b64) {
        setErr("No image from Pixflux (first frame).");
        return;
      }
      setStatusLine("Scaling first frame, starting animation job…");
      const scaled = await scaleImageUrlToDataUrlMax256(b64);
      await runMotionV3Pipeline(scaled, targetProject.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onGenerateBackground = async () => {
    if (!isTauri() || !hasKey) return;
    setErr(null);
    setStatusLine(null);
    setJsonDebug(null);
    setBusy(true);
    setLastPreview(null);
    try {
      const targetProject = (await invoke("get_active_game") as ActiveGameRef);
      const requested = bgFileName.trim() || "background.png";
      const bw = Math.max(16, Math.min(792, bgW));
      const bh = Math.max(16, Math.min(688, bgH));
      if (bw !== bgW) setBgW(bw);
      if (bh !== bgH) setBgH(bh);
      const body = {
        description: bgDescription.trim() || "background",
        image_size: { width: bw, height: bh },
        no_background: false,
        seed: 0,
      };
      const t = (await invoke("pixellab_v2_post", { path: "/generate-image-v2", body })) as string;
      const emsg = apiErrorMessage(t);
      if (emsg) {
        setErr(emsg);
        return;
      }
      const root = JSON.parse(t) as Record<string, unknown>;
      const d = (root["data"] ?? root) as Record<string, unknown>;
      const jobId = (d["background_job_id"] as string) || (root["background_job_id"] as string);
      if (!jobId) {
        setErr("No job id from generate-image-v2.");
        return;
      }
      const { payload, text: doneText } = await pollJob(jobId);
      setJsonDebug((doneText || JSON.stringify(payload)).slice(0, 6000));
      const p = (payload || {}) as Record<string, unknown>;
      if (p.status === "failed" || p.status === "canceled") {
        setErr(String(p.error || p.message || p.detail || "Background job did not complete."));
        return;
      }
      const frames = extractFrameBase64s(payload ?? {});
      const use = frames[0];
      if (!use) {
        setErr("No image in job result. Open debug JSON or PixelLab on the web.");
        return;
      }
      const bytes = b64ToBytes(use);
      const name = (await invoke("write_project_asset_bytes", {
        filename: requested,
        data: Array.from(bytes),
        project_id: targetProject.id,
      })) as string;
      onAssetsChanged?.();
      setStatusLine(await finalizeSaveStatus(`Saved ${name}`, requested, name, targetProject.id));
      setPreviewBlob(bytes);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div className="pixel-lab-outer" role="dialog" aria-label="Pixel Lab" onMouseDown={(e) => e.stopPropagation()}>
      <div className="win-pop pixel-lab-win">
        <div className="win-pop-head pixel-lab-head">
          <span>Pixel Lab</span>
          <div className="pixel-lab-head-actions">
            <button
              type="button"
              className="win-link-btn"
              onClick={() => void openUrl("https://api.pixellab.ai/v2/llms.txt")}
            >
              API v2
            </button>
            <button type="button" className="win9x-close-btn" onClick={onClose} title="Close" aria-label="Close">
              <span className="win9x-close-x" aria-hidden>
                ×
              </span>
            </button>
          </div>
        </div>
        <div className="win-pop-body pixel-lab-body">
          {!isTauri() && (
            <p className="win-pop-txt" style={{ marginTop: 0 }}>
              PixelLab tools run in the Tauri app so your token stays local.
            </p>
          )}

          {isTauri() && (
            <>
              <p className="win-pop-txt" style={{ marginTop: 0 }}>
                <button type="button" className="win-link-btn" onClick={() => void openUrl("https://pixellab.ai/account")}>
                  Get a token
                </button>{" "}
                — one sprite at a time, then motion from a still, then wide backgrounds. Uses{" "}
                <code className="win-pop-code">/create-image-pixflux</code>, <code className="win-pop-code">/animate-with-text-v3</code>,{" "}
                <code className="win-pop-code">/generate-image-v2</code>.
              </p>
              <div className="pixel-lab-keyrow">
                <input
                  className="win-pop-inp"
                  type="password"
                  placeholder="API token"
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
              {balance && <p className="pixel-lab-balance">Balance: {balance}</p>}

              <div className="pixel-lab-tabs" role="tablist" aria-label="Mode">
                {(
                  [
                    ["still", "Still (item / character)"],
                    ["motion", "Motion (from PNG)"],
                    ["motionPrompt", "Motion (prompt)"],
                    ["background", "Background"],
                  ] as [MainTab, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    className={`pixel-lab-tab ${tab === k ? "is-on" : ""}`}
                    onClick={() => setTab(k)}
                    disabled={busy}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === "still" && (
                <>
                  <p className="pixel-lab-hint" style={{ marginTop: 6 }}>
                    One PNG, exact size, Pixflux. Good for items, icons, or static character poses.
                  </p>
                  <label className="win-pop-lab" htmlFor="pl-desc-s">
                    Description
                  </label>
                  <textarea
                    id="pl-desc-s"
                    className="win-pop-inp pixel-lab-ta"
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={busy}
                  />
                  <div className="pixel-lab-dims" style={{ marginTop: 4 }}>
                    <span className="win-pop-lab">W × H</span>
                    <div className="pixel-lab-dim-pair">
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={16}
                        max={400}
                        value={w}
                        onChange={(e) => setW(Math.max(16, Math.min(400, Number(e.target.value) || 64)))}
                        disabled={busy}
                      />
                      <span className="pixel-lab-dim-x" aria-hidden>
                        ×
                      </span>
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={16}
                        max={400}
                        value={h}
                        onChange={(e) => setH(Math.max(16, Math.min(400, Number(e.target.value) || 64)))}
                        disabled={busy}
                      />
                    </div>
                  </div>
                  <label className="pixel-lab-tgl" style={{ marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={noBackground}
                      onChange={(e) => setNoBackground(e.target.checked)}
                      disabled={busy}
                    />
                    <span>Transparent background</span>
                  </label>
                  <label className="win-pop-lab" htmlFor="pl-fn-s" style={{ marginTop: 6 }}>
                    Save as
                  </label>
                  <input
                    id="pl-fn-s"
                    className="win-pop-inp"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    disabled={busy}
                  />
                </>
              )}

              {tab === "motion" && (
                <>
                  <p className="pixel-lab-hint" style={{ marginTop: 6 }}>
                    Same idea as the site: a <strong>still PNG</strong> of your art + a <strong>short action</strong> (e.g. walk, wing flap). We scale the source to max 256×256, call{" "}
                    <code className="win-pop-code">/animate-with-text-v3</code>, then stitch frames into a <strong>horizontal strip</strong> for you.
                  </p>
                  {motionPngsInProject.length > 0 && (
                    <>
                      <label className="win-pop-lab" htmlFor="pl-mot-asset" style={{ marginTop: 4 }}>
                        First frame from project
                      </label>
                      <select
                        id="pl-mot-asset"
                        className="win-pop-inp pixel-lab-asset-sel"
                        value={motionProjectPng ?? ""}
                        onChange={(e) => {
                          const v = e.target.value || null;
                          setMotionProjectPng(v);
                          if (v) {
                            setMotionFile(null);
                            if (motionInputRef.current) motionInputRef.current.value = "";
                          }
                        }}
                        disabled={busy}
                      >
                        <option value="">(choose a PNG in this project…)</option>
                        {motionPngsInProject.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <p className="pixel-lab-sublab" style={{ margin: "6px 0 0" }}>
                    Or a file on disk
                  </p>
                  <input
                    ref={motionInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="pixel-lab-file"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setMotionFile(f);
                      if (f) setMotionProjectPng(null);
                    }}
                    disabled={busy}
                  />
                  {motionFile && <p className="pixel-lab-filename">{motionFile.name}</p>}
                  {motionProjectPng && !motionFile && <p className="pixel-lab-filename">{motionProjectPng}</p>}
                  <label className="win-pop-lab" htmlFor="pl-act" style={{ marginTop: 6 }}>
                    Action
                  </label>
                  <input
                    id="pl-act"
                    className="win-pop-inp"
                    value={motionAction}
                    onChange={(e) => setMotionAction(e.target.value)}
                    disabled={busy}
                    placeholder="e.g. flapping wings slowly, side view"
                  />
                  <div className="pixel-lab-dims" style={{ marginTop: 4 }}>
                    <span className="win-pop-lab">Frames</span>
                    <div>
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={4}
                        max={16}
                        step={2}
                        value={frameCount}
                        onChange={(e) => {
                          const n = Number(e.target.value) || 8;
                          const e2 = n % 2 === 0 ? n : n + 1;
                          setFrameCount(Math.max(4, Math.min(16, e2)));
                        }}
                        disabled={busy}
                      />
                      <p className="pixel-lab-sublab" style={{ margin: "2px 0 0" }}>
                        4–16, even (PixelLab)
                      </p>
                    </div>
                  </div>
                  <label className="pixel-lab-tgl" style={{ marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={noBackground}
                      onChange={(e) => setNoBackground(e.target.checked)}
                      disabled={busy}
                    />
                    <span>Transparent background on frames</span>
                  </label>
                  <label className="win-pop-lab" htmlFor="pl-fn-m" style={{ marginTop: 6 }}>
                    Horizontal sheet save as
                  </label>
                  <input
                    id="pl-fn-m"
                    className="win-pop-inp"
                    value={sheetName}
                    onChange={(e) => setSheetName(e.target.value)}
                    disabled={busy}
                  />
                </>
              )}

              {tab === "motionPrompt" && (
                <>
                  <p className="pixel-lab-hint" style={{ marginTop: 6 }}>
                    <strong>Pixflux</strong> draws the first still from your text, then the same <code className="win-pop-code">/animate-with-text-v3</code> + strip stitch as <strong>Motion (from PNG)</strong>. No file or asset — describe the character, then the action.
                  </p>
                  <label className="win-pop-lab" htmlFor="pl-desc-mp">
                    First frame (description)
                  </label>
                  <textarea
                    id="pl-desc-mp"
                    className="win-pop-inp pixel-lab-ta"
                    rows={2}
                    value={motionPromptDesc}
                    onChange={(e) => setMotionPromptDesc(e.target.value)}
                    disabled={busy}
                  />
                  <div className="pixel-lab-dims" style={{ marginTop: 4 }}>
                    <span className="win-pop-lab">W × H</span>
                    <div className="pixel-lab-dim-pair">
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={16}
                        max={400}
                        value={motionPromptW}
                        onChange={(e) => setMotionPromptW(Math.max(16, Math.min(400, Number(e.target.value) || 64)))}
                        disabled={busy}
                      />
                      <span className="pixel-lab-dim-x" aria-hidden>
                        ×
                      </span>
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={16}
                        max={400}
                        value={motionPromptH}
                        onChange={(e) => setMotionPromptH(Math.max(16, Math.min(400, Number(e.target.value) || 64)))}
                        disabled={busy}
                      />
                    </div>
                  </div>
                  <p className="pixel-lab-sublab" style={{ margin: "2px 0 0" }}>
                    Pixflux size; animation step scales to max 256×256
                  </p>
                  <label className="pixel-lab-tgl" style={{ marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={noBackground}
                      onChange={(e) => setNoBackground(e.target.checked)}
                      disabled={busy}
                    />
                    <span>Transparent on first frame and animation</span>
                  </label>
                  <label className="win-pop-lab" htmlFor="pl-act-mp" style={{ marginTop: 6 }}>
                    Action
                  </label>
                  <input
                    id="pl-act-mp"
                    className="win-pop-inp"
                    value={motionAction}
                    onChange={(e) => setMotionAction(e.target.value)}
                    disabled={busy}
                    placeholder="e.g. flapping wings slowly, side view"
                  />
                  <div className="pixel-lab-dims" style={{ marginTop: 4 }}>
                    <span className="win-pop-lab">Frames</span>
                    <div>
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={4}
                        max={16}
                        step={2}
                        value={frameCount}
                        onChange={(e) => {
                          const n = Number(e.target.value) || 8;
                          const e2 = n % 2 === 0 ? n : n + 1;
                          setFrameCount(Math.max(4, Math.min(16, e2)));
                        }}
                        disabled={busy}
                      />
                      <p className="pixel-lab-sublab" style={{ margin: "2px 0 0" }}>
                        4–16, even (PixelLab)
                      </p>
                    </div>
                  </div>
                  <label className="win-pop-lab" htmlFor="pl-fn-mp" style={{ marginTop: 6 }}>
                    Horizontal sheet save as
                  </label>
                  <input
                    id="pl-fn-mp"
                    className="win-pop-inp"
                    value={sheetName}
                    onChange={(e) => setSheetName(e.target.value)}
                    disabled={busy}
                  />
                </>
              )}

              {tab === "background" && (
                <>
                  <p className="pixel-lab-hint" style={{ marginTop: 6 }}>
                    Wide scene for levels or parallax. Uses the Pro <code className="win-pop-code">generate-image-v2</code> path (background job) and saves the first result image.
                  </p>
                  <label className="win-pop-lab" htmlFor="pl-bg-d">
                    Description
                  </label>
                  <textarea
                    id="pl-bg-d"
                    className="win-pop-inp pixel-lab-ta"
                    rows={2}
                    value={bgDescription}
                    onChange={(e) => setBgDescription(e.target.value)}
                    disabled={busy}
                  />
                  <div className="pixel-lab-dims" style={{ marginTop: 4 }}>
                    <span className="win-pop-lab">W × H</span>
                    <div className="pixel-lab-dim-pair">
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={16}
                        max={792}
                        value={bgW}
                        onChange={(e) => setBgW(Math.max(16, Math.min(792, Number(e.target.value) || 512)))}
                        disabled={busy}
                      />
                      <span className="pixel-lab-dim-x" aria-hidden>
                        ×
                      </span>
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={16}
                        max={688}
                        value={bgH}
                        onChange={(e) => setBgH(Math.max(16, Math.min(688, Number(e.target.value) || 288)))}
                        disabled={busy}
                      />
                    </div>
                  </div>
                  <p className="pixel-lab-sublab">Max 792×688 per API. Try 16:9 sizes (e.g. 512×288).</p>
                  <label className="win-pop-lab" htmlFor="pl-fn-b" style={{ marginTop: 6 }}>
                    Save as
                  </label>
                  <input
                    id="pl-fn-b"
                    className="win-pop-inp"
                    value={bgFileName}
                    onChange={(e) => setBgFileName(e.target.value)}
                    disabled={busy}
                  />
                </>
              )}

              {err && <p className="pixel-lab-err">{err}</p>}
              {statusLine && <p className="pixel-lab-status">{statusLine}</p>}

              <div className="pixel-lab-go">
                {tab === "still" && (
                  <button type="button" className="win-btn" onClick={() => void onGenerateStill()} disabled={busy || !hasKey}>
                    {busy ? "…" : "Generate still"}
                  </button>
                )}
                {tab === "motion" && (
                  <button
                    type="button"
                    className="win-btn"
                    onClick={() => void onGenerateMotion()}
                    disabled={busy || !hasKey || (!motionFile && !motionProjectPng)}
                  >
                    {busy ? "…" : "Generate sheet"}
                  </button>
                )}
                {tab === "motionPrompt" && (
                  <button
                    type="button"
                    className="win-btn"
                    onClick={() => void onGenerateMotionFromPrompt()}
                    disabled={busy || !hasKey || !motionPromptDesc.trim()}
                  >
                    {busy ? "…" : "Generate sheet"}
                  </button>
                )}
                {tab === "background" && (
                  <button
                    type="button"
                    className="win-btn"
                    onClick={() => void onGenerateBackground()}
                    disabled={busy || !hasKey}
                  >
                    {busy ? "…" : "Generate background"}
                  </button>
                )}
              </div>

              {lastPreview && (
                <div className="pixel-lab-preview">
                  <img src={lastPreview} alt="Preview" className="pixel-lab-preview-img" />
                </div>
              )}

              {jsonDebug && (
                <details className="pixel-lab-json">
                  <summary>Response (debug)</summary>
                  <pre className="pixel-lab-pre">{jsonDebug}</pre>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

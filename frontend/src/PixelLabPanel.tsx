import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PixelArtStudioContent } from "./PixelArtStudioPanel";

type MainTab = "still" | "motion" | "motionPrompt" | "background" | "image2pixel" | "studio";

type Props = {
  open: boolean;
  onClose: () => void;
  onAssetsChanged?: () => void;
  /** Fires when a Pixel Lab generation run starts or fully finishes (while the panel is closed, too). */
  onGenActivityChange?: (busy: boolean) => void;
  /** Filenames in the project (same as Assets panel); Motion tab lists `.png` here. */
  projectAssets?: string[];
};

/** Floating shell — same drag + 8-point resize as the AI panel. */
type PlRect = { x: number; y: number; w: number; h: number };
type PlWinEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const PIXEL_LAB_PNL_MIN_W = 360;
const PIXEL_LAB_PNL_MIN_H = 240;

function plDefaultWindowRect(): PlRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(PIXEL_LAB_PNL_MIN_W, Math.min(vw * 0.88, 800));
  const h = Math.max(PIXEL_LAB_PNL_MIN_H, Math.min(vh * 0.8, 700));
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}

function plClampRect(r: PlRect): PlRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let { x, y, w, h } = r;
  w = Math.max(PIXEL_LAB_PNL_MIN_W, w);
  h = Math.max(PIXEL_LAB_PNL_MIN_H, h);
  w = Math.min(w, vw);
  h = Math.min(h, vh);
  x = Math.max(0, Math.min(x, vw - w));
  y = Math.max(0, Math.min(y, vh - h));
  return { x, y, w, h };
}

function plApplyResize(r: PlRect, edge: PlWinEdge, dx: number, dy: number): PlRect {
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

const PL_RESIZE_GRIPS: readonly PlWinEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function b64ToBytes(dataUrlOrB64: string): Uint8Array {
  const s = dataUrlOrB64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Standard base64 with correct padding. Pixel Lab `/image-to-pixelart` rejects data URLs / malformed lengths. */
function bytesToStandardBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function pngDataUrlToStrictBase64(dataUrl: string): string {
  return bytesToStandardBase64(b64ToBytes(dataUrl));
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

function normalizeFrameObjectToDataUrl(item: unknown): string | null {
  if (item == null || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  if (typeof r.base64 === "string") {
    const b = r.base64.trim();
    if (b.length < 20) return null;
    return b.startsWith("data:") ? b : `data:image/png;base64,${b}`;
  }
  const img = r.image;
  if (img && typeof img === "object") {
    const ib = (img as { base64?: string }).base64;
    if (typeof ib === "string" && ib.trim().length >= 20) {
      const t = ib.trim();
      return t.startsWith("data:") ? t : `data:image/png;base64,${t}`;
    }
  }
  return null;
}

/**
 * completed `animate-with-text-v3` jobs include a `frames` array plus an echoed `first_frame`;
 * {@link extractFrameBase64s} walks the whole tree and collects both, yielding one extra cell.
 */
function extractAnimateV3FramesForSheet(root: unknown): string[] {
  if (root && typeof root === "object") {
    const o = root as Record<string, unknown>;
    const lists: unknown[] = [
      o.frames,
      (o.result as Record<string, unknown> | undefined)?.frames,
      (o.output as Record<string, unknown> | undefined)?.frames,
      (o.data as Record<string, unknown> | undefined)?.frames,
    ];
    for (const arr of lists) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const out: string[] = [];
      for (const item of arr) {
        const u = normalizeFrameObjectToDataUrl(item);
        if (u) out.push(u);
      }
      if (out.length > 0) return out;
    }
  }
  return extractFrameBase64s(root);
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

const PIXELART_INPUT_MAX = 1280;
/** `/remove-background` accepts at most 400×400 (see PixelLab OpenAPI). */
const REMOVE_BG_MAX = 400;

/** Size after fitting inside `maxSide` (PixelLab image-to-pixelart input limits). */
function dimensionsAfterMaxSide(iw: number, ih: number, maxSide: number): { w: number; h: number } {
  if (iw < 1 || ih < 1) return { w: 16, h: 16 };
  let scale = 1;
  const m = Math.max(iw, ih);
  if (m > maxSide) scale = maxSide / m;
  let w = Math.max(16, Math.round(iw * scale));
  let h = Math.max(16, Math.round(ih * scale));
  for (let guard = 0; guard < 16 && Math.max(w, h) > maxSide; guard++) {
    scale *= 0.995;
    w = Math.max(16, Math.round(iw * scale));
    h = Math.max(16, Math.round(ih * scale));
  }
  return { w, h };
}

function suggestPixelartOutputSize(iw: number, ih: number): { ow: number; oh: number } {
  const { w, h } = dimensionsAfterMaxSide(iw, ih, PIXELART_INPUT_MAX);
  return {
    ow: Math.max(16, Math.min(320, Math.round(w / 4))),
    oh: Math.max(16, Math.min(320, Math.round(h / 4))),
  };
}

/** PNG data URL and logical size sent as `image_size` (must match encoded bitmap). */
async function prepareImageForPixelartInput(
  im: HTMLImageElement,
  flattenAlpha: boolean,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const iw = im.naturalWidth || im.width;
  const ih = im.naturalHeight || im.height;
  const { w: ow, h: oh } = dimensionsAfterMaxSide(iw, ih, PIXELART_INPUT_MAX);
  const c = document.createElement("canvas");
  c.width = ow;
  c.height = oh;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas unsupported");
  ctx.imageSmoothingEnabled = true;
  if (flattenAlpha) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, ow, oh);
    ctx.drawImage(im, 0, 0, ow, oh);
  } else {
    ctx.clearRect(0, 0, ow, oh);
    ctx.drawImage(im, 0, 0, ow, oh);
  }
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, width: ow, height: oh };
}

/** Raster scaled to fit PixelLab `/remove-background` limits (photo with background intact). */
async function prepareImageForRemoveBackground(
  im: HTMLImageElement,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const iw = im.naturalWidth || im.width;
  const ih = im.naturalHeight || im.height;
  const { w: ow, h: oh } = dimensionsAfterMaxSide(iw, ih, REMOVE_BG_MAX);
  const c = document.createElement("canvas");
  c.width = ow;
  c.height = oh;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas unsupported");
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, ow, oh);
  ctx.drawImage(im, 0, 0, ow, oh);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, width: ow, height: oh };
}

/**
 * PixelLab `/image-to-pixelart` often returns an **opaque** PNG with flat grey where the input was transparent.
 * Recombine with the cutout from `/remove-background` so those regions get alpha 0 again.
 */
async function mergePixelArtWithCutoutAlpha(
  pixelArtPng: Uint8Array,
  cutoutIm: HTMLImageElement,
  outW: number,
  outH: number,
): Promise<Uint8Array> {
  const blob = new Blob([pixelArtPng], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  try {
    const pixIm = await loadImageEl(url);
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas unsupported");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixIm, 0, 0, outW, outH);
    const pixData = ctx.getImageData(0, 0, outW, outH);

    const mc = document.createElement("canvas");
    mc.width = outW;
    mc.height = outH;
    const mctx = mc.getContext("2d");
    if (!mctx) throw new Error("Canvas unsupported");
    mctx.imageSmoothingEnabled = true;
    mctx.clearRect(0, 0, outW, outH);
    mctx.drawImage(cutoutIm, 0, 0, outW, outH);
    const maskData = mctx.getImageData(0, 0, outW, outH);

    const p = pixData.data;
    const m = maskData.data;
    for (let i = 0; i < p.length; i += 4) {
      const ma = m[i + 3];
      const pa = p[i + 3];
      p[i + 3] = Math.min(255, Math.round((pa * ma) / 255));
    }
    ctx.putImageData(pixData, 0, 0);
    const outBlob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!outBlob) throw new Error("toBlob failed");
    return new Uint8Array(await outBlob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
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

export function PixelLabPanel({
  open,
  onClose,
  onAssetsChanged,
  onGenActivityChange,
  projectAssets = [],
}: Props) {
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
  const imageAssetsInProject = projectAssets.filter((n) => /\.(png|jpe?g|webp|gif)$/i.test(n));

  const [bgDescription, setBgDescription] = useState("parallax-ready pixel sky, clouds, distant hills, soft colors");
  const [bgW, setBgW] = useState(512);
  const [bgH, setBgH] = useState(288);

  const [saveName, setSaveName] = useState("sprite.png");
  const [sheetName, setSheetName] = useState("walk_strip.png");
  const [bgFileName, setBgFileName] = useState("background.png");

  const [i2pFile, setI2pFile] = useState<File | null>(null);
  const [i2pProjectAsset, setI2pProjectAsset] = useState<string | null>(null);
  const i2pInputRef = useRef<HTMLInputElement>(null);
  const [i2pSourceLabel, setI2pSourceLabel] = useState<string | null>(null);
  const [i2pOutW, setI2pOutW] = useState(64);
  const [i2pOutH, setI2pOutH] = useState(64);
  const [i2pGuidance, setI2pGuidance] = useState(8);
  const [i2pTransparent, setI2pTransparent] = useState(true);
  const [i2pSaveName, setI2pSaveName] = useState("pixelized.png");

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [lastPreview, setLastPreview] = useState<string | null>(null);
  const [jsonDebug, setJsonDebug] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const [frame, setFrame] = useState<PlRect>(() => plDefaultWindowRect());
  const frameRef = useRef(frame);
  frameRef.current = frame;

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

  /** Avoid hitting `/balance` on every open; AI panel feels snappier because it rarely re-fetches on open. */
  const balanceCacheRef = useRef<{ at: number; text: string } | null>(null);
  const BALANCE_CACHE_MS = 45_000;

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
      balanceCacheRef.current = null;
      return;
    }
    const c = balanceCacheRef.current;
    const now = Date.now();
    if (c && now - c.at < BALANCE_CACHE_MS) {
      setBalance(c.text);
      return;
    }
    try {
      const t = (await invoke("pixellab_v2_get", { path: "/balance" })) as string;
      const { data } = extractFromEnvelope(t);
      const text = data ? JSON.stringify(data) : t;
      setBalance(text);
      balanceCacheRef.current = { at: Date.now(), text };
    } catch {
      setBalance(null);
      balanceCacheRef.current = null;
    }
  }, [hasKey]);

  useEffect(() => {
    if (!open) return;
    void refreshKey();
  }, [open, refreshKey]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const id = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!cancelled) void refreshBalance();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [open, hasKey, refreshBalance]);

  useEffect(() => {
    onGenActivityChange?.(busy);
  }, [busy, onGenActivityChange]);

  const saveKey = async () => {
    if (!isTauri()) return;
    setErr(null);
    try {
      await invoke("save_pixellab_api_key", { key: keyInput });
      setKeyInput("");
      balanceCacheRef.current = null;
      await refreshKey();
      await refreshBalance();
    } catch (e) {
      setErr(String(e));
    }
  };

  const clearKey = async () => {
    if (!isTauri()) return;
    setErr(null);
    try {
      await invoke("save_pixellab_api_key", { key: "" });
      balanceCacheRef.current = null;
      await refreshKey();
    } catch (e) {
      setErr(String(e));
    }
  };

  const applyI2pNaturalSizeHints = useCallback(async (im: HTMLImageElement) => {
    const iw = im.naturalWidth || im.width;
    const ih = im.naturalHeight || im.height;
    const { w, h } = dimensionsAfterMaxSide(iw, ih, PIXELART_INPUT_MAX);
    setI2pSourceLabel(`Source (fit to API input): ${w}×${h}`);
    const { ow, oh } = suggestPixelartOutputSize(iw, ih);
    setI2pOutW(ow);
    setI2pOutH(oh);
  }, []);

  const pollJob = useCallback(async (jobId: string) => {
    const path = `/background-jobs/${jobId}`;
    for (let i = 0; i < 120; i++) {
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
      const rawFrames = extractAnimateV3FramesForSheet(payload ?? {});
      const frames = rawFrames.slice(0, fc);
      if (frames.length === 0) {
        setErr("Job finished but no frames were found in the response. See debug JSON below.");
        return;
      }
      if (frames.length < fc) {
        setErr(
          `Job returned ${rawFrames.length} frame(s); need ${fc}. If this persists, check the debug JSON below.`,
        );
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

  const onGenerateImage2Pixelart = async () => {
    if (!isTauri() || !hasKey) return;
    if (!i2pFile && !i2pProjectAsset) return;
    setErr(null);
    setStatusLine(null);
    setJsonDebug(null);
    setBusy(true);
    setLastPreview(null);
    try {
      const targetProject = (await invoke("get_active_game")) as ActiveGameRef;
      const requested = i2pSaveName.trim() || "pixelized.png";
      const im = await (async () => {
        if (i2pProjectAsset) {
          const p = (await invoke("resolve_asset_path", { name: i2pProjectAsset })) as string;
          return await loadImageEl(convertFileSrc(p));
        }
        const url = URL.createObjectURL(i2pFile!);
        try {
          return await loadImageEl(url);
        } finally {
          URL.revokeObjectURL(url);
        }
      })();

      let dataUrl: string;
      let inW: number;
      let inH: number;
      let removeBgDebug = "";
      let cutoutForMask: HTMLImageElement | null = null;

      if (i2pTransparent) {
        setStatusLine("Removing background (PixelLab)…");
        const rbg = await prepareImageForRemoveBackground(im);
        const removeBody = {
          image: {
            type: "base64" as const,
            base64: pngDataUrlToStrictBase64(rbg.dataUrl),
            format: "png" as const,
          },
          image_size: { width: rbg.width, height: rbg.height },
          background_removal_task: "remove_simple_background" as const,
        };
        const tR = (await invoke("pixellab_v2_post", { path: "/remove-background", body: removeBody })) as string;
        removeBgDebug = tR.slice(0, 1200);
        const emsgR = apiErrorMessage(tR);
        if (emsgR) {
          setErr(emsgR);
          return;
        }
        const { data: dataR } = extractFromEnvelope(tR);
        const rawR = dataR ?? JSON.parse(tR);
        const b64r = extractFrameBase64s(rawR)[0];
        if (!b64r) {
          setErr("No image from remove-background");
          return;
        }
        const imFg = await loadImageEl(b64r.startsWith("data:") ? b64r : `data:image/png;base64,${b64r}`);
        cutoutForMask = imFg;
        const prep = await prepareImageForPixelartInput(imFg, false);
        dataUrl = prep.dataUrl;
        inW = prep.width;
        inH = prep.height;
        setStatusLine(null);
      } else {
        const prep = await prepareImageForPixelartInput(im, true);
        dataUrl = prep.dataUrl;
        inW = prep.width;
        inH = prep.height;
      }

      let ow = Math.max(16, Math.min(320, i2pOutW));
      let oh = Math.max(16, Math.min(320, i2pOutH));
      if (ow !== i2pOutW) setI2pOutW(ow);
      if (oh !== i2pOutH) setI2pOutH(oh);
      let g = Math.max(1, Math.min(20, i2pGuidance));
      if (g !== i2pGuidance) setI2pGuidance(g);
      const body = {
        image: {
          type: "base64" as const,
          base64: pngDataUrlToStrictBase64(dataUrl),
          format: "png" as const,
        },
        image_size: { width: inW, height: inH },
        output_size: { width: ow, height: oh },
        text_guidance_scale: g,
      };
      const t = (await invoke("pixellab_v2_post", { path: "/image-to-pixelart", body })) as string;
      setJsonDebug(
        removeBgDebug
          ? `remove-background:\n${removeBgDebug}\n\n---\n\nimage-to-pixelart:\n${t.slice(0, 2000)}`
          : t.slice(0, 2000),
      );
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
      let bytes = b64ToBytes(b64);
      if (cutoutForMask) {
        setStatusLine("Applying transparency…");
        bytes = await mergePixelArtWithCutoutAlpha(bytes, cutoutForMask, ow, oh);
        setStatusLine(null);
      }
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

  const onPlTitleBarMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".win9x-close-btn, .pixel-lab-head-actions")) return;
    e.preventDefault();
    const r0 = { ...frameRef.current };
    document.body.classList.add("gemini-pnl-noselect");
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: MouseEvent) => {
      setFrame(plClampRect({ ...r0, x: r0.x + (ev.clientX - sx), y: r0.y + (ev.clientY - sy) }));
    };
    const onUp = () => {
      document.body.classList.remove("gemini-pnl-noselect");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const onPlResizeGripMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>, edge: PlWinEdge) => {
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
      setFrame(plClampRect(plApplyResize(r0, edge, dx, dy)));
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
      setFrame((f) => plClampRect(f));
    }
  }, [open]);

  useEffect(() => {
    const onWinResize = () => {
      setFrame((f) => plClampRect(f));
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
      className="pixel-lab-pnl-outer"
      role="dialog"
      aria-label="Pixel Lab"
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
      <div className="win-pop pixel-lab-win" onMouseDown={(e) => e.stopPropagation()}>
        <div
          className="win-pop-head pixel-lab-head"
          onMouseDown={onPlTitleBarMouseDown}
          title="Drag to move"
        >
          <span className="pixel-lab-titletext">Pixel Lab</span>
          <div className="pixel-lab-head-actions">
            <button
              type="button"
              className="win-link-btn"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => void openUrl("https://api.pixellab.ai/v2/llms.txt")}
            >
              API v2
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
        <div className="win-pop-body pixel-lab-body">
          {!isTauri() && (
            <p className="win-pop-txt" style={{ marginTop: 0 }}>
              PixelLab tools run in the Tauri app so your token stays local.
            </p>
          )}

          {isTauri() && (
            <>
              {tab !== "studio" && (
                <>
                  <p className="win-pop-txt" style={{ marginTop: 0 }}>
                    <button type="button" className="win-link-btn" onClick={() => void openUrl("https://pixellab.ai/account")}>
                      Get a token
                    </button>{" "}
                    — one sprite at a time, then motion from a still, then wide backgrounds. Uses{" "}
                    <code className="win-pop-code">/create-image-pixflux</code>, <code className="win-pop-code">/animate-with-text-v3</code>,{" "}
                    <code className="win-pop-code">/generate-image-v2</code>, <code className="win-pop-code">/image-to-pixelart</code>.
                  </p>
                  <div className="pixel-lab-keyrow">
                    <input
                      className="win-pop-inp"
                      type="password"
                      placeholder={
                        hasKey ? "•••• key on file — paste to replace" : "API token"
                      }
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
                </>
              )}

              {tab === "studio" && (
                <p className="win-pop-txt" style={{ marginTop: 0 }}>
                  <strong>Studio</strong> — draw cels and export a spritesheet to the same project folder. No PixelLab API key needed.
                </p>
              )}

              <div className="pixel-lab-tabs" role="tablist" aria-label="Mode">
                {(
                  [
                    ["still", "Still (item / character)"],
                    ["motion", "Motion (from PNG)"],
                    ["motionPrompt", "Motion (prompt)"],
                    ["background", "Background"],
                    ["image2pixel", "Image → pixel art"],
                    ["studio", "Studio (draw)"],
                  ] as [MainTab, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    className={`pixel-lab-tab ${tab === k ? "is-on" : ""}`}
                    onClick={() => setTab(k)}
                    disabled={busy && k !== "studio"}
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

              {tab === "image2pixel" && (
                <>
                  <p className="pixel-lab-hint" style={{ marginTop: 6 }}>
                    Raster photo or sketch → game-style pixel art via{" "}
                    <code className="win-pop-code">/image-to-pixelart</code>. Input is scaled to fit{" "}
                    <strong>1280</strong> max side; output up to <strong>320×320</strong>.
                  </p>
                  {imageAssetsInProject.length > 0 && (
                    <>
                      <label className="win-pop-lab" htmlFor="pl-i2p-asset" style={{ marginTop: 4 }}>
                        Image from project
                      </label>
                      <select
                        id="pl-i2p-asset"
                        className="win-pop-inp pixel-lab-asset-sel"
                        value={i2pProjectAsset ?? ""}
                        onChange={(e) => {
                          const v = e.target.value || null;
                          setI2pProjectAsset(v);
                          if (v) {
                            setI2pFile(null);
                            if (i2pInputRef.current) i2pInputRef.current.value = "";
                            void (async () => {
                              try {
                                const p = (await invoke("resolve_asset_path", { name: v })) as string;
                                const im = await loadImageEl(convertFileSrc(p));
                                await applyI2pNaturalSizeHints(im);
                              } catch {
                                setI2pSourceLabel(null);
                              }
                            })();
                          } else {
                            setI2pSourceLabel(null);
                          }
                        }}
                        disabled={busy}
                      >
                        <option value="">(choose an image in this project…)</option>
                        {imageAssetsInProject.map((n) => (
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
                    ref={i2pInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="pixel-lab-file"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setI2pFile(f);
                      if (f) {
                        setI2pProjectAsset(null);
                        void (async () => {
                          try {
                            const url = URL.createObjectURL(f);
                            const im = await loadImageEl(url);
                            URL.revokeObjectURL(url);
                            await applyI2pNaturalSizeHints(im);
                          } catch {
                            setI2pSourceLabel(null);
                          }
                        })();
                      } else {
                        setI2pSourceLabel(null);
                      }
                    }}
                    disabled={busy}
                  />
                  {i2pFile && <p className="pixel-lab-filename">{i2pFile.name}</p>}
                  {i2pProjectAsset && !i2pFile && <p className="pixel-lab-filename">{i2pProjectAsset}</p>}
                  {i2pSourceLabel && <p className="pixel-lab-sublab">{i2pSourceLabel}</p>}
                  <div className="pixel-lab-dims" style={{ marginTop: 4 }}>
                    <span className="win-pop-lab">Output W × H</span>
                    <div className="pixel-lab-dim-pair">
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={16}
                        max={320}
                        value={i2pOutW}
                        onChange={(e) => setI2pOutW(Math.max(16, Math.min(320, Number(e.target.value) || 64)))}
                        disabled={busy}
                      />
                      <span className="pixel-lab-dim-x" aria-hidden>
                        ×
                      </span>
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={16}
                        max={320}
                        value={i2pOutH}
                        onChange={(e) => setI2pOutH(Math.max(16, Math.min(320, Number(e.target.value) || 64)))}
                        disabled={busy}
                      />
                    </div>
                  </div>
                  <p className="pixel-lab-sublab" style={{ margin: "2px 0 0" }}>
                    Tip: ~¼ of the fitted source size (API suggestion).
                  </p>
                  <div className="pixel-lab-dims" style={{ marginTop: 4 }}>
                    <span className="win-pop-lab">Style strength</span>
                    <div>
                      <input
                        className="win-pop-inp pixel-lab-num"
                        type="number"
                        min={1}
                        max={20}
                        step={0.5}
                        value={i2pGuidance}
                        onChange={(e) => setI2pGuidance(Math.max(1, Math.min(20, Number(e.target.value) || 8)))}
                        disabled={busy}
                      />
                      <p className="pixel-lab-sublab" style={{ margin: "2px 0 0" }}>
                        1–20 (PixelLab <code className="win-pop-code">text_guidance_scale</code>)
                      </p>
                    </div>
                  </div>
                  <label className="pixel-lab-tgl" style={{ marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={i2pTransparent}
                      onChange={(e) => setI2pTransparent(e.target.checked)}
                      disabled={busy}
                    />
                    <span>Remove background, then pixelate</span>
                  </label>
                  <p className="pixel-lab-sublab" style={{ margin: "2px 0 0" }}>
                    When on: PixelLab <code className="win-pop-code">/remove-background</code> (up to 400×400) then{" "}
                    <code className="win-pop-code">/image-to-pixelart</code>, like the website — <strong>two</strong> API
                    steps. When off: flatten onto white and only run image-to-pixel art (one step).
                  </p>
                  <label className="win-pop-lab" htmlFor="pl-fn-i2p" style={{ marginTop: 6 }}>
                    Save as
                  </label>
                  <input
                    id="pl-fn-i2p"
                    className="win-pop-inp"
                    value={i2pSaveName}
                    onChange={(e) => setI2pSaveName(e.target.value)}
                    disabled={busy}
                  />
                </>
              )}

              <div
                className="pixel-lab-studio-mount"
                style={{ display: tab === "studio" ? "block" : "none" }}
                aria-hidden={tab !== "studio"}
              >
                <PixelArtStudioContent
                  active={open && tab === "studio"}
                  onAssetsChanged={onAssetsChanged}
                  projectAssets={projectAssets}
                />
              </div>

              {err && tab !== "studio" && <p className="pixel-lab-err">{err}</p>}
              {tab !== "studio" && busy && (
                <p className="pixel-lab-status pixel-lab-status-working" aria-live="polite">
                  {statusLine || "Working…"}
                </p>
              )}
              {tab !== "studio" && !busy && statusLine && <p className="pixel-lab-status">{statusLine}</p>}

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
                {tab === "image2pixel" && (
                  <button
                    type="button"
                    className="win-btn"
                    onClick={() => void onGenerateImage2Pixelart()}
                    disabled={busy || !hasKey || (!i2pFile && !i2pProjectAsset)}
                  >
                    {busy ? "…" : "Convert to pixel art"}
                  </button>
                )}
              </div>

              {lastPreview && tab !== "studio" && (
                <div className="pixel-lab-preview">
                  <img src={lastPreview} alt="Preview" className="pixel-lab-preview-img" />
                </div>
              )}

              {jsonDebug && tab !== "studio" && (
                <details className="pixel-lab-json">
                  <summary>Response (debug)</summary>
                  <pre className="pixel-lab-pre">{jsonDebug}</pre>
                </details>
              )}
            </>
          )}
        </div>
      </div>
      <div className="gemini-pnl-grips" aria-hidden>
        {PL_RESIZE_GRIPS.map((edge) => (
          <div
            key={edge}
            className={`gemini-pnl-grip gemini-pnl-grip--${edge}`}
            onMouseDown={(e) => onPlResizeGripMouseDown(e, edge)}
            title="Resize"
          />
        ))}
      </div>
    </div>
  );
}

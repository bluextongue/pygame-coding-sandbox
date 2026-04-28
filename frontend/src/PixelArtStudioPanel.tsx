import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";

type Tool = "pencil" | "eraser" | "fill";

type PixelBuffer = { w: number; h: number; data: Uint8ClampedArray };

export type PixelArtStudioContentProps = {
  /** True when the Studio tab is active and the Pixel Lab panel is open — drives canvas init / input hooks. */
  active: boolean;
  onAssetsChanged?: () => void;
  projectAssets: string[];
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function bresenhamLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  setPixel: (x: number, y: number) => void,
) {
  let x0f = Math.floor(x0);
  let y0f = Math.floor(y0);
  const x1f = Math.floor(x1);
  const y1f = Math.floor(y1);
  const dx = Math.abs(x1f - x0f);
  const dy = -Math.abs(y1f - y0f);
  const sx = x0f < x1f ? 1 : -1;
  const sy = y0f < y1f ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    setPixel(x0f, y0f);
    if (x0f === x1f && y0f === y1f) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0f += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0f += sy;
    }
  }
}

function floodFill(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  target: [number, number, number, number],
  fill: [number, number, number, number],
) {
  if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === fill[3]) {
    return;
  }
  const stack: [number, number][] = [[sx, sy]];
  const seen = new Set<number>();
  const key = (x: number, y: number) => y * w + x;

  const match = (i: number) => {
    return (
      data[i] === target[0] &&
      data[i + 1] === target[1] &&
      data[i + 2] === target[2] &&
      data[i + 3] === target[3]
    );
  };

  const startI = (sy * w + sx) * 4;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || !match(startI)) return;

  while (stack.length) {
    const p = stack.pop()!;
    const [x, y] = p;
    const k = key(x, y);
    if (seen.has(k)) continue;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = (y * w + x) * 4;
    if (!match(i)) continue;
    seen.add(k);
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

function clampSize(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n) || n < lo) return lo;
  if (n > hi) return hi;
  return Math.floor(n);
}

function normalizeFilename(input: string): string {
  let s = input.trim();
  if (!s.toLowerCase().endsWith(".png")) {
    s = `${s}.png`;
  }
  return s.replace(/[/\\]/g, "_");
}

/** Horizontal strip, left-to-right, standard for pixel tools — no gaps, same frame size, clean PNG. */
function stitchPixelBuffersToPng(frames: PixelBuffer[]): Promise<Uint8Array> {
  if (frames.length === 0) throw new Error("no frames to stitch");
  const { w: fw, h: fh } = frames[0]!;
  for (const f of frames) {
    if (f.w !== fw || f.h !== fh) {
      throw new Error("all frames must be the same size (use a single size per cel)");
    }
  }
  const c = document.createElement("canvas");
  c.width = fw * frames.length;
  c.height = fh;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas not available");
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.w, f.h), i * fw, 0);
  }
  return new Promise((res, rej) => {
    c.toBlob(
      (blob) => {
        if (!blob) rej(new Error("export failed"));
        else
          void blob.arrayBuffer().then((ab) => {
            res(new Uint8Array(ab));
          });
      },
      "image/png",
    );
  });
}

const MAX_CELS = 64;

export function PixelArtStudioContent({ active, onAssetsChanged, projectAssets }: PixelArtStudioContentProps) {
  const [w, setW] = useState(32);
  const [h, setH] = useState(32);
  const [tool, setTool] = useState<Tool>("pencil");
  const [colorHex, setColorHex] = useState("#202830");
  const [zoom, setZoom] = useState(12);
  const [showGrid, setShowGrid] = useState(true);
  const [saveName, setSaveName] = useState("sprite.png");
  const [sheetFileName, setSheetFileName] = useState("spritesheet.png");
  const [status, setStatus] = useState("");
  const [loadPick, setLoadPick] = useState("");

  /** All animation cels; the active one is `imageRef` (synced in layout). */
  const framesListRef = useRef<PixelBuffer[]>([]);
  const [activeFrame, setActiveFrame] = useState(0);
  const [sheetRev, setSheetRev] = useState(0);

  const imageRef = useRef<PixelBuffer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintRaf = useRef<number | null>(null);
  const lastCell = useRef<{ x: number; y: number } | null>(null);
  const isDrawing = useRef(false);

  const [openedDoc, setOpenedDoc] = useState<string | null>(null);
  const [sheetOpenName, setSheetOpenName] = useState<string | null>(null);
  const [renderTick, setRenderTick] = useState(0);

  const imagePngs = projectAssets.filter((n) => IMAGE_RE.test(n));

  const getRgba = useCallback((): [number, number, number, number] => {
    if (tool === "eraser") return [0, 0, 0, 0];
    const hex = colorHex.replace(/^#/, "");
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      return [r, g, b, 255];
    }
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (Number.isNaN(r + g + b)) return [0, 0, 0, 255];
      return [r, g, b, 255];
    }
    return [0, 0, 0, 255];
  }, [colorHex, tool]);

  const initBuffer = useCallback(
    (nw: number, nh: number) => {
      const cw = clampSize(nw, 4, 256);
      const ch = clampSize(nh, 4, 256);
      const data = new Uint8ClampedArray(cw * ch * 4);
      const cell: PixelBuffer = { w: cw, h: ch, data };
      framesListRef.current = [cell];
      setActiveFrame(0);
      imageRef.current = cell;
      setW(cw);
      setH(ch);
      setSheetRev((n) => n + 1);
      setRenderTick((n) => n + 1);
    },
    [],
  );

  const drawToCanvas = useCallback(() => {
    const el = canvasRef.current;
    const img = imageRef.current;
    if (!el || !img) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const { w: iw, h: ih, data } = img;
    el.width = iw;
    el.height = ih;
    const im = new ImageData(new Uint8ClampedArray(data), iw, ih);
    ctx.putImageData(im, 0, 0);
    if (showGrid && iw <= 128 && ih <= 128) {
      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= iw; x++) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, ih);
        ctx.stroke();
      }
      for (let y = 0; y <= ih; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(iw, y + 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [showGrid, renderTick]);

  // Point `imageRef` at the active cel (runs before the draw pass below).
  useLayoutEffect(() => {
    if (!active) return;
    const list = framesListRef.current;
    if (list.length === 0) return;
    const i = Math.min(Math.max(0, activeFrame), list.length - 1);
    const b = list[i]!;
    imageRef.current = b;
    setW(b.w);
    setH(b.h);
  }, [active, activeFrame, sheetRev]);

  // Redraw on reopen, or when the buffer/cel/selection changes (sheetRev switches frames).
  useLayoutEffect(() => {
    if (!active) return;
    drawToCanvas();
    const raf = requestAnimationFrame(() => {
      drawToCanvas();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, drawToCanvas, renderTick, activeFrame, sheetRev]);

  const cellFromEvent = (e: ReactMouseEvent<HTMLCanvasElement> | { clientX: number; clientY: number }) => {
    const el = canvasRef.current;
    const img = imageRef.current;
    if (!el || !img) return null;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * img.w;
    const y = ((e.clientY - r.top) / r.height) * img.h;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= img.w || cy >= img.h) return null;
    return { cx, cy };
  };

  const paintAt = (cx: number, cy: number) => {
    const img = imageRef.current;
    if (!img) return;
    const c = getRgba();
    const i = (cy * img.w + cx) * 4;
    if (tool === "fill") return;
    img.data[i] = c[0]!;
    img.data[i + 1] = c[1]!;
    img.data[i + 2] = c[2]!;
    img.data[i + 3] = c[3]!;
  };

  const onCanvasDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const cell = cellFromEvent(e);
    if (!cell) return;
    const img = imageRef.current;
    if (!img) return;

    if (tool === "fill") {
      const i = (cell.cy * img.w + cell.cx) * 4;
      const target: [number, number, number, number] = [
        img.data[i]!,
        img.data[i + 1]!,
        img.data[i + 2]!,
        img.data[i + 3]!,
      ];
      const fill = getRgba();
      floodFill(img.data, img.w, img.h, cell.cx, cell.cy, target, fill);
      setRenderTick((n) => n + 1);
      return;
    }

    isDrawing.current = true;
    lastCell.current = { x: cell.cx, y: cell.cy };
    paintAt(cell.cx, cell.cy);
    setRenderTick((n) => n + 1);
  };

  const onCanvasMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current || tool === "fill") return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    const last = lastCell.current;
    const img = imageRef.current;
    if (!img) return;
    if (last) {
      bresenhamLine(last.x, last.y, cell.cx, cell.cy, (x, y) => {
        if (x >= 0 && y >= 0 && x < img.w && y < img.h) paintAt(x, y);
      });
    } else {
      paintAt(cell.cx, cell.cy);
    }
    lastCell.current = { x: cell.cx, y: cell.cy };
    if (paintRaf.current == null) {
      paintRaf.current = requestAnimationFrame(() => {
        paintRaf.current = null;
        setRenderTick((n) => n + 1);
      });
    }
  };

  const endPaint = () => {
    isDrawing.current = false;
    lastCell.current = null;
    if (paintRaf.current != null) {
      cancelAnimationFrame(paintRaf.current);
      paintRaf.current = null;
    }
    setRenderTick((n) => n + 1);
  };

  useEffect(() => {
    if (!active) return;
    const end = () => {
      isDrawing.current = false;
      lastCell.current = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("blur", end);
    };
  }, [active]);

  const handleNew = () => {
    const nw = window.prompt("Canvas width in pixels (4–256):", String(w)) ?? "";
    const nh = window.prompt("Canvas height in pixels (4–256):", String(h)) ?? "";
    const wi = parseInt(nw, 10);
    const hi = parseInt(nh, 10);
    initBuffer(
      Number.isFinite(wi) ? wi : w,
      Number.isFinite(hi) ? hi : h,
    );
    setOpenedDoc(null);
    setSaveName("sprite.png");
    setSheetOpenName(null);
    setStatus("New canvas (1 frame)");
  };

  const addEmptyCel = useCallback(() => {
    const list = framesListRef.current;
    if (list.length === 0) return;
    if (list.length >= MAX_CELS) {
      setStatus(`Max ${MAX_CELS} frames`);
      return;
    }
    const { w: fw, h: fh } = list[0]!;
    const data = new Uint8ClampedArray(fw * fh * 4);
    list.push({ w: fw, h: fh, data });
    setActiveFrame(list.length - 1);
    setSheetRev((n) => n + 1);
    setStatus(`Frame ${list.length} — empty (same size as first)`);
  }, []);

  const duplicateCel = useCallback(() => {
    const list = framesListRef.current;
    const cur = imageRef.current;
    if (!cur || list.length === 0) return;
    if (list.length >= MAX_CELS) {
      setStatus(`Max ${MAX_CELS} frames`);
      return;
    }
    const fromLabel = activeFrame + 1;
    const data = new Uint8ClampedArray(cur.data);
    list.push({ w: cur.w, h: cur.h, data });
    setActiveFrame(list.length - 1);
    setSheetRev((n) => n + 1);
    setStatus(`New frame #${list.length} — copy of #${fromLabel}`);
  }, [activeFrame]);

  const removeCel = useCallback(() => {
    const list = framesListRef.current;
    if (list.length <= 1) return;
    const idx = activeFrame;
    list.splice(idx, 1);
    setActiveFrame(Math.min(idx, list.length - 1));
    setSheetRev((n) => n + 1);
    setStatus(`${list.length} frame(s) in sheet`);
  }, [activeFrame]);

  /** Previous / next cel in the list — only changes the active index (like clicking 1, 2, 3). */
  const goPrevCel = useCallback(() => {
    setActiveFrame((a) => Math.max(0, a - 1));
    setRenderTick((n) => n + 1);
  }, []);

  const goNextCel = useCallback(() => {
    setActiveFrame((a) => {
      const m = Math.max(0, framesListRef.current.length - 1);
      return Math.min(m, a + 1);
    });
    setRenderTick((n) => n + 1);
  }, []);

  /** Swap this cel with a neighbor in the list — reorders the export sheet only, does not change "which" buffer you are editing. */
  const shiftCelInStrip = useCallback(
    (dir: -1 | 1) => {
      const list = framesListRef.current;
      const from = activeFrame;
      const to = from + dir;
      if (to < 0 || to >= list.length) return;
      const a = list[from]!;
      const b = list[to]!;
      list[from] = b;
      list[to] = a;
      setActiveFrame(to);
      setSheetRev((n) => n + 1);
    },
    [activeFrame],
  );

  const handleLoad = async () => {
    if (!isTauri() || !loadPick) return;
    setStatus("Loading…");
    try {
      const path = (await invoke("resolve_asset_path", { name: loadPick })) as string;
      const url = convertFileSrc(path);
      const cvs = document.createElement("canvas");
      const c2 = cvs.getContext("2d");
      if (!c2) return;
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.decoding = "async";
      await new Promise<void>((res, rej) => {
        im.onload = () => res();
        im.onerror = () => rej(new Error("load"));
        im.src = url;
      });
      const maxSide = 256;
      let tw = im.naturalWidth;
      let th = im.naturalHeight;
      if (tw > maxSide || th > maxSide) {
        const s = maxSide / Math.max(tw, th);
        tw = Math.max(1, Math.floor(tw * s));
        th = Math.max(1, Math.floor(th * s));
      }
      cvs.width = tw;
      cvs.height = th;
      c2.imageSmoothingEnabled = false;
      c2.drawImage(im, 0, 0, tw, th);
      const id = c2.getImageData(0, 0, tw, th);
      const cell: PixelBuffer = { w: tw, h: th, data: id.data };
      framesListRef.current = [cell];
      setActiveFrame(0);
      imageRef.current = cell;
      setW(tw);
      setH(th);
      setSheetRev((n) => n + 1);
      setOpenedDoc(loadPick);
      setSaveName(loadPick);
      setSheetOpenName(null);
      setRenderTick((n) => n + 1);
      setStatus(`Loaded ${loadPick} (1 frame)`);
    } catch {
      setStatus("Could not load image");
    }
  };

  const imageToPngBlob = useCallback((): Promise<Blob | null> => {
    const img = imageRef.current;
    if (!img) return Promise.resolve(null);
    const c = document.createElement("canvas");
    c.width = img.w;
    c.height = img.h;
    const ctx = c.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
    return new Promise((res) => c.toBlob((b) => res(b), "image/png"));
  }, []);

  const handleSave = async () => {
    if (!isTauri()) return;
    const name = normalizeFilename(saveName);
    if (!name || name === ".png") {
      setStatus("Enter a file name");
      return;
    }
    setStatus("Saving…");
    try {
      const blob = await imageToPngBlob();
      if (!blob) throw new Error("no png");
      const ab = await blob.arrayBuffer();
      const data = new Uint8Array(ab);
      const isOverwrite = openedDoc != null && openedDoc === name;
      if (isOverwrite) {
        await invoke("overwrite_project_asset", {
          filename: name,
          data: Array.from(data),
          project_id: null,
        });
        onAssetsChanged?.();
        setStatus(`Replaced ${name}`);
      } else {
        const finalName = (await invoke("write_project_asset_bytes", {
          filename: name,
          data: Array.from(data),
          project_id: null,
        })) as string;
        setSaveName(finalName);
        setOpenedDoc(finalName);
        onAssetsChanged?.();
        setStatus(`Saved as ${finalName}`);
      }
    } catch (e) {
      setStatus(String(e));
    }
  };

  const handleSaveSheet = async () => {
    if (!isTauri()) return;
    const name = normalizeFilename(sheetFileName);
    if (!name || name === ".png") {
      setStatus("Enter a sheet file name");
      return;
    }
    const cels = framesListRef.current;
    if (cels.length === 0) return;
    setStatus("Exporting sheet…");
    try {
      const data = await stitchPixelBuffersToPng(cels);
      const isOverwrite = sheetOpenName != null && sheetOpenName === name;
      if (isOverwrite) {
        await invoke("overwrite_project_asset", {
          filename: name,
          data: Array.from(data),
          project_id: null,
        });
        onAssetsChanged?.();
        setStatus(`Replaced ${name} — ${cels.length} frame(s) in one row, left to right`);
      } else {
        const finalName = (await invoke("write_project_asset_bytes", {
          filename: name,
          data: Array.from(data),
          project_id: null,
        })) as string;
        setSheetFileName(finalName);
        setSheetOpenName(finalName);
        onAssetsChanged?.();
        setStatus(`Sheet saved as ${finalName} — ${cels.length}×${cels[0]!.w}×${cels[0]!.h} px (strip)`);
      }
    } catch (e) {
      setStatus(String(e));
    }
  };

  useLayoutEffect(() => {
    if (!active) return;
    if (framesListRef.current.length === 0) {
      initBuffer(32, 32);
      setStatus("New 32×32 — paint or open an image");
    }
  }, [active, initBuffer]);

  return (
    <div className="pixel-art-studio-embed pixel-art-studio-body">
          {!isTauri() && (
            <p className="win-pop-txt" style={{ marginTop: 0 }}>
              Open the Tauri app to draw, save, and load images from the project folder.
            </p>
          )}

          {isTauri() && (
            <>
              <p className="win-pop-txt pixel-art-studio-lead" style={{ marginTop: 0 }}>
                Draw cels, add frames, duplicate, and export a horizontal <strong>spritesheet</strong> — or save the
                current cel only. Same workflow as Piskel / Aseprite-style strips, built into your project.
              </p>

              <div className="pixel-art-studio-toolbar">
                <div className="pixel-art-studio-group">
                  <span className="win-pop-lab" style={{ margin: 0 }}>
                    Tool
                  </span>
                  {(
                    [
                      ["pencil", "Pencil"],
                      ["eraser", "Eraser"],
                      ["fill", "Fill"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      className={`pixel-lab-mode ${tool === k ? "is-on" : ""}`}
                      onClick={() => setTool(k)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="pixel-art-studio-group">
                  <label className="win-pop-lab" style={{ margin: 0 }} htmlFor="px-color">
                    Color
                  </label>
                  <input
                    id="px-color"
                    type="color"
                    className="pixel-art-studio-color"
                    value={colorHex.length === 7 ? colorHex : "#000000"}
                    onChange={(e) => setColorHex(e.target.value)}
                    disabled={tool === "eraser"}
                    title="Brush color"
                  />
                  <input
                    className="win-pop-inp pixel-lab-num"
                    style={{ maxWidth: "5.5rem" }}
                    value={colorHex}
                    onChange={(e) => setColorHex(e.target.value)}
                    disabled={tool === "eraser"}
                    aria-label="Color hex"
                  />
                </div>
                <div className="pixel-art-studio-group">
                  <span className="win-pop-lab" style={{ margin: 0 }}>
                    Zoom
                  </span>
                  <input
                    type="range"
                    className="pixel-art-studio-zoom"
                    min={4}
                    max={24}
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                  />
                  <span className="pixel-art-studio-wxh">{w}×{h}</span>
                </div>
                <label className="win-pop-lab pixel-art-tgl">
                  <input
                    type="checkbox"
                    checked={showGrid}
                    onChange={(e) => {
                      setShowGrid(e.target.checked);
                      setRenderTick((n) => n + 1);
                    }}
                  />{" "}
                  Grid
                </label>
                <button type="button" className="win-btn" onClick={handleNew}>
                  New…
                </button>
                <button
                  type="button"
                  className="win-btn"
                  onClick={() => {
                    const img = imageRef.current;
                    if (!img) return;
                    img.data.fill(0);
                    setRenderTick((n) => n + 1);
                    setStatus("Cleared");
                  }}
                >
                  Clear
                </button>
              </div>

              <div className="pixel-art-sheetbar" data-sheet-rev={sheetRev}>
                <div className="pixel-art-sheetbar-row1">
                  <span className="win-pop-lab pixel-art-sheet-cels-label">
                    Cels
                  </span>
                  <div className="pixel-art-celstrip" role="tablist" aria-label="Animation cels">
                    {Array.from({ length: framesListRef.current.length }, (_, i) => (
                      <button
                        key={`f-${i}-${sheetRev}`}
                        type="button"
                        role="tab"
                        className={`pixel-lab-mode pixel-art-cel-pill ${activeFrame === i ? "is-on" : ""}`}
                        onClick={() => setActiveFrame(i)}
                        title={`Cel ${i + 1}`}
                      >
                        {i + 1}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="pixel-art-sheetbar-actions">
                  <button
                    type="button"
                    className="win-link-btn"
                    onClick={addEmptyCel}
                    title="Add an empty frame (same width and height as the first cel)"
                  >
                    + Add frame
                  </button>
                  <button
                    type="button"
                    className="win-link-btn"
                    onClick={duplicateCel}
                    title="Duplicate the current frame into a new cel"
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="win-link-btn"
                    onClick={removeCel}
                    disabled={framesListRef.current.length <= 1}
                    title="Remove the current frame"
                  >
                    Remove
                  </button>
                  <span
                    className="pixel-art-cel-mov"
                    title={`Cel ${activeFrame + 1} of ${framesListRef.current.length} — step with arrows (same as 1, 2, 3).`}
                  >
                    <button
                      type="button"
                      className="win-mini-btn pixel-art-cel-mov-btn"
                      onClick={goPrevCel}
                      aria-label="Previous frame"
                      disabled={activeFrame === 0}
                    >
                      ◀
                    </button>
                    <span className="pixel-art-cel-mov-lbl" aria-hidden>
                      {activeFrame + 1}/{framesListRef.current.length}
                    </span>
                    <button
                      type="button"
                      className="win-mini-btn pixel-art-cel-mov-btn"
                      onClick={goNextCel}
                      aria-label="Next frame"
                      disabled={activeFrame === framesListRef.current.length - 1}
                    >
                      ▶
                    </button>
                  </span>
                  <span className="pixel-art-strip-order">
                    <span className="pixel-art-strip-order-lab" title="Reorders this drawing in the export row; use ◀/▶ above to switch cels.">
                      Sheet order
                    </span>
                    <button
                      type="button"
                      className="win-link-btn"
                      onClick={() => shiftCelInStrip(-1)}
                      disabled={activeFrame === 0}
                      title="Swap with the previous slot in the sheet (affects export order only)"
                    >
                      «
                    </button>
                    <button
                      type="button"
                      className="win-link-btn"
                      onClick={() => shiftCelInStrip(1)}
                      disabled={activeFrame === framesListRef.current.length - 1}
                      title="Swap with the next slot in the sheet (affects export order only)"
                    >
                      »
                    </button>
                  </span>
                </div>
                <p className="pixel-art-sheetbar-hint">
                  <strong>◀ / ▶</strong> and the number tabs only change which frame you are editing. <strong>Sheet order</strong> ( « » )
                  reorders cels in the wide PNG. Export: one row, no gaps; step by <code className="win-pop-code">image_width // n</code> in pygame.
                </p>
                <div className="pixel-art-studio-save pixel-art-sheet-export">
                  <label className="win-pop-lab" htmlFor="px-sheet" style={{ margin: 0 }}>
                    Export sheet
                  </label>
                  <input
                    id="px-sheet"
                    className="win-pop-inp"
                    value={sheetFileName}
                    onChange={(e) => setSheetFileName(e.target.value)}
                    placeholder="spritesheet.png"
                  />
                  <button type="button" className="win-btn" onClick={() => void handleSaveSheet()}>
                    Save sheet PNG
                  </button>
                </div>
              </div>

              <div className="pixel-art-canvas-outer" onMouseLeave={endPaint} onMouseUp={endPaint}>
                <div
                  className="pixel-art-canvas-surface"
                  style={{
                    width: w * zoom,
                    height: h * zoom,
                    maxWidth: "100%",
                  }}
                >
                  <canvas
                    ref={canvasRef}
                    className="pixel-art-canvas"
                    style={{
                      width: "100%",
                      height: "100%",
                      imageRendering: "pixelated",
                      cursor: tool === "fill" ? "copy" : "crosshair",
                    }}
                    onMouseDown={onCanvasDown}
                    onMouseMove={onCanvasMove}
                  />
                </div>
              </div>

              <div className="pixel-art-studio-foot">
                <div className="pixel-art-studio-open">
                  <label className="win-pop-lab" htmlFor="px-load" style={{ margin: 0 }}>
                    Open from assets
                  </label>
                  <select
                    id="px-load"
                    className="win-pop-inp pixel-lab-asset-sel"
                    value={loadPick}
                    onChange={(e) => setLoadPick(e.target.value)}
                  >
                    <option value="">— choose —</option>
                    {imagePngs.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="win-btn"
                    onClick={() => void handleLoad()}
                    disabled={!loadPick}
                  >
                    Open
                  </button>
                </div>
                <div className="pixel-art-studio-save">
                  <label className="win-pop-lab" htmlFor="px-save" style={{ margin: 0 }}>
                    Save as
                  </label>
                  <input
                    id="px-save"
                    className="win-pop-inp"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="sprite.png"
                  />
                  <button type="button" className="win-btn" onClick={() => void handleSave()}>
                    Save PNG
                  </button>
                </div>
              </div>
              {status && <p className="pixel-lab-sublab">{status}</p>}
            </>
          )}
    </div>
  );
}

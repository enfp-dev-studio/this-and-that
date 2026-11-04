// The editor without the UI: the canvases (the picture being edited, and an
// open reference), marks, SAM outlines, sheen, recording (marks + voice +
// realtime transcription), jobs, references and version history. React reads
// its state through subscribe/getSnapshot; pointer drawing goes straight to
// the canvas.

import { postJson } from './api';
import { LiveAsr } from './live-asr';
import { markColor, themeVar, themeLength, watchTheme } from './colors';
import { loadTrials, saveTrials, type Method, type Round, type Trial } from './experiment';
import type { Task } from './presets';
import { LAB } from '../lab';
import { quickShape } from './quickshape';

export type Point = { x: number; y: number; t: number };
export type Stroke = {
  mark: number;
  points: Point[];
  on?: string; // the reference this mark is drawn on; none = the picture being edited
  markId?: string; // SAM request for this mark, sent when the stroke ends
  mask?: HTMLImageElement; // SAM's outline of what the mark points at
  tinted?: { color: string; canvas: HTMLCanvasElement };
  samDone?: boolean;
  settled?: boolean; // no tint or sheen: an arrow, "no change", or already edited locally
  pen?: 'point' | 'shape'; // the pen mode it was drawn with, when not auto
  original?: Point[]; // the freehand stroke, when it was snapped to a shape (QuickShape)
  snapAt?: number; // when it snapped, for the brief flash
};
// Auto: the app tells from what is said whether a mark selects or draws a new
// shape. Point and Shape force it.
export type PenMode = 'auto' | 'point' | 'shape';
export type Edit = { mark: number; kind?: string; op?: string; target: string; instruction: string };
export type Version = { url: string; imageId: Promise<string> };
// A reference picture: a character sheet, a style, or a detail like an ornament.
// Pinned ones go to every edit; others only when a mark is drawn on them.
export type Ref = { id: string; url: string; imageId: Promise<string>; pinned: boolean };
// A named part of the picture (Spark, in the background): box on a 0–1000 grid.
export type Part = { id: number; name: string; box: number[]; parent: number; pair: number };
export type StepState = 'pending' | 'active' | 'done';
export type Mode = 'empty' | 'idle' | 'recording' | 'processing' | 'review';
export type Fit = { x: number; y: number; w: number; h: number };

export type Snapshot = {
  mode: Mode;
  caption: string;
  edits: Edit[];
  localMarks: number[];
  steps: { sam: StepState; understand: StepState; edit: StepState; paste: StepState };
  elapsedMs: number;
  marks: number; // marks drawn in this recording
  penOnly: boolean; // once a stylus is used, fingers don't draw
  penMode: PenMode;
  canUnsnap: boolean; // the last stroke was snapped: Undo (or a tap on it) restores the freehand one
  zoom: number; // the picture's zoom over its fit-to-screen size
  versions: Version[];
  index: number; // current version
  result: Version | null; // the edit waiting for Keep or Discard
  compare: boolean; // before/after overlay
  peek: boolean; // held: show the picture before this edit
  fit: Fit; // where the picture sits in its stage, CSS px
  anchors: { mark: number; x: number; y: number }[]; // beside each mark's number on the picture, CSS px
  refs: Ref[];
  activeRef: string | null; // the reference open beside the picture
  experiment: boolean; // time each task done one of four ways
  method: Method;
  task: string; // the preset being done, or "Free"
  trials: Trial[];
  failure: string | null; // why the last edit didn't come through; its marks are kept for "Try again"
};

type Job = {
  stage: string;
  transcript?: string;
  edits?: Edit[];
  error?: string;
  resultImageId?: string;
  previewImageId?: string;
  localMarks?: number[];
  elapsedMs: number;
};

// One drawing surface: the picture being edited, or the open reference.
type Surface = {
  key: 'target' | 'ref';
  el?: HTMLElement;
  canvas?: HTMLCanvasElement;
  ctx?: CanvasRenderingContext2D;
  image: HTMLImageElement | null;
};

const NO_STEPS = { sam: 'pending', understand: 'pending', edit: 'pending', paste: 'pending' } as const;
const SERVER_STEPS = ['understand', 'edit', 'paste', 'done'] as const;

export const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });

async function upload(url: string) {
  const dataUrl = url.startsWith('data:') ? url : await blobToDataUrl(await (await fetch(url)).blob());
  return (await postJson('/api/images', { image: dataUrl })).imageId as string;
}

// Start the server's parts pass on a reference, so its part names are words
// to listen for by the time the user talks about it.
const findPartsOf = (ref: Ref) => ref.imageId.then((id) => fetch(`/api/images/${id}/parts`)).catch(() => {});

const loadImage = async (url: string) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
};

class Editor {
  private snapshot: Snapshot = {
    mode: 'empty',
    caption: '',
    edits: [],
    localMarks: [],
    steps: { ...NO_STEPS },
    elapsedMs: 0,
    marks: 0,
    penOnly: false,
    penMode: 'auto',
    canUnsnap: false,
    zoom: 1,
    versions: [],
    index: -1,
    result: null,
    compare: false,
    peek: false,
    fit: { x: 0, y: 0, w: 0, h: 0 },
    anchors: [],
    refs: [],
    activeRef: null,
    experiment: false,
    method: 'pen',
    task: 'Free',
    trials: loadTrials(),
    failure: null,
  };
  private listeners = new Set<() => void>();
  onError: (message: string) => void = () => {};
  onNotice: (message: string) => void = () => {};

  private target: Surface = { key: 'target', image: null };
  private ref: Surface = { key: 'ref', image: null };
  private preview: HTMLImageElement | null = null; // instant edits, shown while the rest is edited
  private strokes: Stroke[] = [];
  private drawing: { stroke: Stroke; surface: Surface } | null = null;
  private parts: { url: string; list: Part[] } | null = null; // for the current version
  private hover: Part | null = null; // the part under the pen or mouse
  // QuickShape: a stroke held still for HOLD_MS at its end snaps to a shape.
  private hold: { x: number; y: number; timer: number } | null = null;
  private lastSnap: { stroke: Stroke; liftAt: number } | null = null;
  // Zoom and pan of the picture over its fit-to-screen place (1, 0, 0 = fit).
  private view = { zoom: 1, x: 0, y: 0 };
  private pan: { x: number; y: number } | null = null; // right or middle mouse drag
  private touches = new Map<number, { x: number; y: number }>(); // fingers, once a pen is in use

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private t0 = 0;
  private micStream: MediaStream | null = null;
  private live: LiveAsr | null = null;
  private pressedAt = 0;
  private startedByThisPress = false;
  // Experiment timing: when this round's input began, and the round waiting for its result.
  private inputAt: number | null = null;
  private pending: (Omit<Round, 'waitMs' | 'kept'> & { sentAt: number }) | null = null;
  // The last request, so a failed edit can be sent again with one tap.
  private lastSend: { body: Record<string, unknown>; jobId?: string } | null = null;

  // ---------- store ----------

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;
  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  // ---------- canvases ----------

  attach(stage: HTMLElement, canvas: HTMLCanvasElement) {
    return this.attachSurface(this.target, stage, canvas);
  }

  attachRef(stage: HTMLElement, canvas: HTMLCanvasElement) {
    return this.attachSurface(this.ref, stage, canvas);
  }

  private attachSurface(surface: Surface, el: HTMLElement, canvas: HTMLCanvasElement) {
    Object.assign(surface, { el, canvas, ctx: canvas.getContext('2d')! });
    const ro = new ResizeObserver(() => this.draw());
    ro.observe(el);
    const unwatch = watchTheme(() => this.draw());
    const listeners = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(type: K, f: (e: HTMLElementEventMap[K]) => void) => canvas.addEventListener(type, f, { signal: listeners.signal });
    on('pointerdown', (e) => (surface.key === 'target' && this.gestureDown(e)) || this.pointerDown(surface, e));
    on('pointermove', (e) => (surface.key === 'target' && this.gestureMove(e)) || (this.drawing ? this.pointerMove(e) : this.hoverAt(surface, e)));
    on('pointerleave', () => this.setHover(null));
    on('pointerup', (e) => (surface.key === 'target' && this.gestureUp(e)) || this.endStroke());
    on('pointercancel', (e) => (surface.key === 'target' && this.gestureUp(e)) || this.endStroke());
    on('contextmenu', (e) => e.preventDefault());
    // Wheel or trackpad pinch zooms the picture around the pointer (on the
    // stage, so it works over the result and the callouts too).
    if (surface.key === 'target') el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const box = canvas.getBoundingClientRect();
      this.zoomAt(e.clientX - box.left, e.clientY - box.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { signal: listeners.signal, passive: false });
    this.draw();
    return () => {
      ro.disconnect();
      unwatch();
      listeners.abort();
      if (surface.canvas === canvas) Object.assign(surface, { el: undefined, canvas: undefined, ctx: undefined });
    };
  }

  // Where a surface's image sits, in CSS px. The picture leaves room below
  // for the floating toolbar (theme.css).
  private fitRect(surface: Surface): Fit & { k: number } {
    const w = surface.el?.clientWidth ?? 0;
    const h = surface.el?.clientHeight ?? 0;
    const img = surface.image;
    if (!img) return { x: 0, y: 0, w, h, k: 1 };
    const pad = themeLength('--stage-padding');
    // The picture clears the floating chrome above and the toolbar below.
    const above = surface.key === 'target' ? Math.max(pad, themeLength('--chrome-height')) : pad;
    const below = surface.key === 'target' ? themeLength('--toolbar-clearance') : pad;
    // An open reference floats at the left; the picture fits beside it.
    const left = surface.key === 'target' && this.snapshot.activeRef ? themeLength('--ref-width') + pad : 0;
    const aw = Math.max(1, w - left - pad * 2), ah = Math.max(1, h - above - below);
    const fit = Math.min(aw / img.naturalWidth, ah / img.naturalHeight);
    const zoom = surface.key === 'target' ? this.view : { zoom: 1, x: 0, y: 0 };
    const k = fit * zoom.zoom;
    const iw = img.naturalWidth * k, ih = img.naturalHeight * k;
    // Zoomed around the fitted centre, then panned.
    return { x: left + (w - left - iw) / 2 + zoom.x, y: above + ah / 2 - ih / 2 + zoom.y, w: iw, h: ih, k };
  }

  // ---------- zoom and pan (the picture only) ----------

  // Zoom by `factor`, keeping the picture point under (px, py) in place (stage px).
  zoomAt(px: number, py: number, factor: number) {
    if (!this.target.image) return;
    const r = this.fitRect(this.target);
    const u = (px - r.x) / r.k, v = (py - r.y) / r.k;
    this.view.zoom = Math.min(8, Math.max(0.5, this.view.zoom * factor));
    const r2 = this.fitRect(this.target);
    this.view.x += px - (r2.x + u * r2.k);
    this.view.y += py - (r2.y + v * r2.k);
    this.viewChanged();
  }

  // Zoom around the middle of the screen (the zoom buttons).
  zoomBy(factor: number) {
    const el = this.target.el;
    if (el) this.zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
  }

  private panBy(dx: number, dy: number) {
    this.view.x += dx;
    this.view.y += dy;
    this.viewChanged();
  }

  // Back to fit-to-screen, eased.
  fitView() {
    const from = { ...this.view }, t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 280), e = 1 - (1 - t) ** 3;
      this.view = { zoom: from.zoom + (1 - from.zoom) * e, x: from.x * (1 - e), y: from.y * (1 - e) };
      this.viewChanged();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private viewChanged() {
    if (this.snapshot.zoom !== this.view.zoom) this.set({ zoom: this.view.zoom });
    this.draw();
  }

  // Right or middle mouse drags pan; with a pen in use, two fingers pinch and
  // pan (fingers don't draw then). True when the event was a gesture.
  private gestureDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
      this.pan = { x: e.clientX, y: e.clientY };
      return true;
    }
    if (e.pointerType === 'touch' && this.snapshot.penOnly && !this.drawing) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return true;
    }
    return false;
  }

  private gestureMove(e: PointerEvent) {
    if (this.pan) {
      this.panBy(e.clientX - this.pan.x, e.clientY - this.pan.y);
      this.pan = { x: e.clientX, y: e.clientY };
      return true;
    }
    const prev = this.touches.get(e.pointerId);
    if (!prev) return false;
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      const other = a === prev ? b : a;
      const now = { x: e.clientX, y: e.clientY };
      const box = this.target.canvas!.getBoundingClientRect();
      const mid0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 }, mid1 = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(now.x - other.x, now.y - other.y);
      if (d0 > 0) this.zoomAt(mid0.x - box.left, mid0.y - box.top, d1 / d0);
      this.panBy(mid1.x - mid0.x, mid1.y - mid0.y);
    }
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    return true;
  }

  private gestureUp(e: PointerEvent) {
    if (this.pan && e.pointerType === 'mouse') {
      this.pan = null;
      return true;
    }
    return this.touches.delete(e.pointerId);
  }

  private strokesOn(surface: Surface) {
    return this.strokes.filter((s) => (surface.key === 'target' ? !s.on : s.on === this.snapshot.activeRef));
  }

  draw() {
    this.drawSurface(this.target);
    this.drawSurface(this.ref);
  }

  private drawSurface(surface: Surface) {
    const { canvas, ctx, el, image } = surface;
    if (!canvas || !ctx || !el) return;
    const dpr = devicePixelRatio || 1;
    const cw = Math.round(el.clientWidth * dpr), ch = Math.round(el.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) [canvas.width, canvas.height] = [cw, ch];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const r = this.fitRect(surface);
    if (surface.key === 'target') {
      const f = this.snapshot.fit;
      if (f.x !== r.x || f.y !== r.y || f.w !== r.w || f.h !== r.h) queueMicrotask(() => this.set({ fit: { x: r.x, y: r.y, w: r.w, h: r.h } }));
    }
    if (!image) return;
    ctx.drawImage(surface.key === 'target' ? (this.preview ?? image) : image, r.x, r.y, r.w, r.h);

    const strokes = this.strokesOn(surface);
    const working = this.snapshot.mode === 'processing';
    if (surface.key === 'target') this.updateAnchors(strokes, image, r);
    // SAM outlines (the picture only): a tint in the mark's colour, plus a sheen while the edit runs.
    const masks = strokes.filter((s) => s.mask && !s.settled);
    if (masks.length) {
      ctx.globalAlpha = working ? 0.28 : 0.38;
      for (const s of masks) ctx.drawImage(this.tint(s), r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
      if (working) this.drawSheen(ctx, masks, r);
    }

    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.scale(r.k, r.k);
    const unit = Math.max(image.naturalWidth, image.naturalHeight) / 160;
    for (const s of strokes) this.drawStroke(ctx, image, s, unit, working ? 0.55 : 1);
    if (surface.key === 'target' && this.hover && !this.drawing && (this.snapshot.mode === 'idle' || this.snapshot.mode === 'recording')) {
      this.drawPart(ctx, image, this.hover, r.k);
    }
    ctx.restore();
  }

  // Where the callout for each mark goes: just right of its numbered badge
  // (same placement as drawStroke), in the stage's CSS px.
  private updateAnchors(strokes: Stroke[], image: HTMLImageElement, r: Fit & { k: number }) {
    const unit = Math.max(image.naturalWidth, image.naturalHeight) / 160;
    const rad = unit * 2.6;
    const anchors = strokes.map((s) => {
      const p0 = s.points[0];
      const bx = Math.min(Math.max(p0.x, rad), image.naturalWidth - rad);
      const by = Math.min(Math.max(p0.y - rad * 1.3, rad), image.naturalHeight - rad);
      return { mark: s.mark, x: Math.round(r.x + (bx + rad) * r.k + 6), y: Math.round(r.y + by * r.k) };
    });
    if (JSON.stringify(anchors) !== JSON.stringify(this.snapshot.anchors)) queueMicrotask(() => this.set({ anchors }));
  }

  // The server's mask in this theme's colour for the mark.
  private tint(s: Stroke) {
    const color = markColor(s.mark);
    if (s.tinted?.color === color) return s.tinted.canvas;
    const c = document.createElement('canvas');
    c.width = s.mask!.naturalWidth;
    c.height = s.mask!.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(s.mask!, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    s.tinted = { color, canvas: c };
    return c;
  }

  private sheenCanvas = document.createElement('canvas');
  private drawSheen(ctx: CanvasRenderingContext2D, masks: Stroke[], r: Fit) {
    const c = this.sheenCanvas;
    const g = c.getContext('2d')!;
    c.width = Math.max(1, Math.round(r.w));
    c.height = Math.max(1, Math.round(r.h));
    for (const s of masks) g.drawImage(this.tint(s), 0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-in';
    const span = c.width + c.height;
    const at = ((performance.now() / 1400) % 1) * span * 1.6 - span * 0.3;
    const grad = g.createLinearGradient(at - 160, at * 0.4 - 80, at + 160, at * 0.4 + 80);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.5, themeVar('--sheen'));
    grad.addColorStop(1, 'transparent');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
    ctx.drawImage(c, r.x, r.y, r.w, r.h);
  }

  private animate = () => {
    if (this.snapshot.mode !== 'processing') return;
    this.draw();
    requestAnimationFrame(this.animate);
  };

  // Same look as the server's render: halo, colour line, numbered badge.
  private drawStroke(ctx: CanvasRenderingContext2D, image: HTMLImageElement, s: Stroke, unit: number, alpha: number) {
    if (!s.points.length) return;
    const color = markColor(s.mark);
    const halo = themeVar('--mark-halo');
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Just snapped (QuickShape): a wider halo that fades out.
    const flash = s.snapAt ? 1 - (performance.now() - s.snapAt) / 400 : 0;
    const passes = flash > 0 ? ([[halo, unit * (1.6 + 2 * flash)], [halo, unit * 1.6], [color, unit]] as const) : ([[halo, unit * 1.6], [color, unit]] as const);
    for (const [stroke, width] of passes) {
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.1, s.points[0].y);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    const r = unit * 2.6;
    const p0 = s.points[0];
    const bx = Math.min(Math.max(p0.x, r), image.naturalWidth - r);
    const by = Math.min(Math.max(p0.y - r * 1.3, r), image.naturalHeight - r);
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = unit * 0.5;
    ctx.strokeStyle = halo;
    ctx.stroke();
    ctx.fillStyle = themeVar('--mark-text');
    ctx.font = `600 ${r * 1.15}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(s.mark), bx, by + r * 0.05);
    ctx.globalAlpha = 1;
  }

  // ---------- parts: background info, shown only with ?lab ----------

  // Asking starts the server's parts pass, whose names Voice Transcribe
  // listens for. The parts are never shown in the everyday app and never
  // suggest a selection: what the user draws and says decides. With ?lab,
  // hovering shows the part under the pen, as a debug aid.
  private async loadParts(v: Version) {
    try {
      const imageId = await v.imageId;
      const { parts } = await (await fetch(`/api/images/${imageId}/parts`)).json();
      if (LAB && this.current() === v) this.parts = { url: v.url, list: parts ?? [] };
    } catch {
      // Optional: without parts there are just no keywords (and no lab hover label).
    }
  }

  private hoverAt(surface: Surface, e: PointerEvent) {
    if (surface.key !== 'target' || e.pointerType === 'touch' || e.buttons || !this.parts || this.parts.url !== this.current()?.url) return;
    const img = surface.image!;
    const p = this.toImage(surface, e);
    const x = (p.x / img.naturalWidth) * 1000, y = (p.y / img.naturalHeight) * 1000;
    // The most specific part: the smallest box under the point.
    const size = (q: Part) => (q.box[2] - q.box[0]) * (q.box[3] - q.box[1]);
    const under = this.parts.list.filter((q) => x >= q.box[0] && x <= q.box[2] && y >= q.box[1] && y <= q.box[3]).sort((a, b) => size(a) - size(b));
    this.setHover(under[0] ?? null);
  }

  private setHover(part: Part | null) {
    if (part === this.hover) return;
    this.hover = part;
    this.draw();
  }

  // The hovered part's box and name (with its parent), in the theme's colours.
  private drawPart(ctx: CanvasRenderingContext2D, image: HTMLImageElement, part: Part, k: number) {
    const [x0, y0, x1, y1] = part.box.map((v, i) => (v * (i % 2 ? image.naturalHeight : image.naturalWidth)) / 1000);
    const parent = this.parts?.list.find((q) => q.id === part.parent)?.name;
    const label = parent ? `${parent} › ${part.name}` : part.name;
    const px = 1 / k; // one CSS pixel in image units
    ctx.save();
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = themeVar('--primary');
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
    ctx.font = `500 ${13 * px}px ${getComputedStyle(document.body).fontFamily}`;
    const w = ctx.measureText(label).width + 16 * px, h = 24 * px;
    const lx = Math.min(Math.max(x0, 0), image.naturalWidth - w), ly = y0 - h - 4 * px < 0 ? y1 + 4 * px : y0 - h - 4 * px;
    ctx.fillStyle = themeVar('--popover');
    ctx.strokeStyle = themeVar('--border');
    ctx.lineWidth = px;
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, h, 6 * px);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = themeVar('--popover-foreground');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, lx + 8 * px, ly + h / 2);
    ctx.restore();
  }

  private toImage(surface: Surface, e: PointerEvent): Point {
    const box = surface.canvas!.getBoundingClientRect();
    const r = this.fitRect(surface);
    const img = surface.image!;
    const x = (e.clientX - box.left - r.x) / r.k;
    const y = (e.clientY - box.top - r.y) / r.k;
    return {
      x: Math.round(Math.max(0, Math.min(img.naturalWidth - 1, x))),
      y: Math.round(Math.max(0, Math.min(img.naturalHeight - 1, y))),
      t: Math.round(performance.now() - this.t0),
    };
  }

  private async pointerDown(surface: Surface, e: PointerEvent) {
    const { mode } = this.snapshot;
    if (!this.target.image || !surface.image || mode === 'processing' || mode === 'review') return;
    if (this.snapshot.experiment && (this.snapshot.method === 'type' || this.snapshot.method === 'voice')) return;
    if (e.pointerType === 'pen' && !this.snapshot.penOnly) this.set({ penOnly: true });
    if (e.pointerType === 'touch' && this.snapshot.penOnly) return; // palm rejection once a stylus is in use
    surface.canvas!.setPointerCapture(e.pointerId);
    if (mode === 'idle') await this.startRecording();
    // Marks are numbered across the picture and the reference, in drawing order.
    const stroke: Stroke = { mark: this.strokes.length + 1, points: [this.toImage(surface, e)] };
    if (surface.key === 'ref') stroke.on = this.snapshot.activeRef!;
    else if (this.snapshot.penMode !== 'auto') stroke.pen = this.snapshot.penMode;
    this.drawing = { stroke, surface };
    this.strokes.push(stroke);
    this.set({ marks: this.strokes.length });
    this.watchHold(e);
    this.draw();
  }

  private pointerMove(e: PointerEvent) {
    if (!this.drawing) return;
    if (this.drawing.stroke.original) return; // snapped: the shape stays until the pen lifts
    const coalesced = e.getCoalescedEvents?.() ?? [];
    for (const ev of coalesced.length ? coalesced : [e]) this.drawing.stroke.points.push(this.toImage(this.drawing.surface, ev));
    this.watchHold(e);
    this.draw();
  }

  private endStroke() {
    if (this.hold) clearTimeout(this.hold.timer);
    this.hold = null;
    const d = this.drawing;
    this.drawing = null;
    if (!d) return;
    const s = d.stroke;
    // A quick tap on a shape that just snapped puts the freehand stroke back.
    const k = this.fitRect(d.surface).k;
    const xs = s.points.map((p) => p.x), ys = s.points.map((p) => p.y);
    const tap = s.points.at(-1)!.t - s.points[0].t < 300 && Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * k < 8;
    const snapped = this.lastSnap;
    if (tap && snapped && performance.now() - snapped.liftAt < 2500 && this.strokes.at(-2) === snapped.stroke && this.near(snapped.stroke, s.points[0], 40 / k)) {
      this.strokes.pop();
      this.set({ marks: this.strokes.length });
      this.unsnap();
      return;
    }
    if (s.original) this.lastSnap = { stroke: s, liftAt: performance.now() };
    else this.forgetSnap();
    this.segment(s);
  }

  // ---------- QuickShape: hold the pen still at the end of a stroke ----------

  private watchHold(e: PointerEvent) {
    if (this.hold && Math.hypot(e.clientX - this.hold.x, e.clientY - this.hold.y) <= 4) return;
    if (this.hold) clearTimeout(this.hold.timer);
    this.hold = { x: e.clientX, y: e.clientY, timer: window.setTimeout(() => this.snap(), 400) };
  }

  private snap() {
    const d = this.drawing;
    if (!d || d.stroke.original) return;
    const fit = quickShape(d.stroke.points, 24 / this.fitRect(d.surface).k);
    if (!fit) return;
    Object.assign(d.stroke, { original: d.stroke.points, points: fit.points, snapAt: performance.now() });
    this.set({ canUnsnap: true });
    this.flash();
  }

  // The freehand stroke back, and SAM asked again for it.
  private unsnap() {
    const s = this.lastSnap?.stroke;
    this.forgetSnap();
    if (!s?.original || !this.strokes.includes(s)) return false;
    Object.assign(s, { points: s.original, original: undefined, snapAt: undefined, mask: undefined, tinted: undefined, samDone: false });
    this.updateSamStep();
    this.draw();
    this.segment(s);
    return true;
  }

  private forgetSnap() {
    this.lastSnap = null;
    if (this.snapshot.canUnsnap) this.set({ canUnsnap: false });
  }

  private near(s: Stroke, p: Point, pad: number) {
    const xs = s.points.map((q) => q.x), ys = s.points.map((q) => q.y);
    return p.x >= Math.min(...xs) - pad && p.x <= Math.max(...xs) + pad && p.y >= Math.min(...ys) - pad && p.y <= Math.max(...ys) + pad;
  }

  // Redraw for the snap's brief flash.
  private flash = () => {
    this.draw();
    if (this.strokes.some((s) => s.snapAt && performance.now() - s.snapAt < 400)) requestAnimationFrame(this.flash);
  };

  // Ask SAM for this mark right away; show its outline when it comes back.
  // Marks on a reference are crops for Muse Image, not edit regions.
  private async segment(s: Stroke) {
    if (s.on) {
      s.samDone = true;
      return;
    }
    const markId = (s.markId = crypto.randomUUID().slice(0, 8));
    try {
      const imageId = await this.current()!.imageId;
      const r = await postJson('/api/marks', { imageId, markId, stroke: { mark: s.mark, points: s.points } });
      if (s.markId !== markId) return; // the stroke changed shape meanwhile (unsnapped) and was sent again
      if (r.found) s.mask = await loadImage(r.overlay);
    } catch (err) {
      console.warn('SAM for mark', s.mark, 'failed:', err);
    }
    if (s.markId !== markId) return;
    s.samDone = true;
    if (this.strokes.includes(s)) {
      this.draw();
      this.updateSamStep();
    }
  }

  setPenOnly(on: boolean) {
    this.set({ penOnly: on });
  }

  setPenMode(penMode: PenMode) {
    this.set({ penMode });
  }

  clearMarks() {
    if (this.snapshot.mode === 'processing') return;
    if (this.snapshot.mode === 'recording') this.cancelRecording();
    this.strokes = [];
    this.forgetSnap();
    this.set({ marks: 0, failure: null });
    this.draw();
  }

  // ---------- references ----------

  async addRef(file: Blob) {
    const url = await blobToDataUrl(file);
    const ref: Ref = { id: crypto.randomUUID().slice(0, 8), url, imageId: upload(url), pinned: false };
    ref.imageId.catch((e) => this.onError(`Upload failed: ${e.message}`));
    findPartsOf(ref);
    this.set({ refs: [...this.snapshot.refs, ref] });
    await this.openRef(ref.id);
  }

  async openRef(id: string | null) {
    const ref = this.snapshot.refs.find((r) => r.id === id);
    this.ref.image = ref ? await loadImage(ref.url) : null;
    this.set({ activeRef: ref ? ref.id : null });
    this.draw();
  }

  togglePin(id: string) {
    this.set({ refs: this.snapshot.refs.map((r) => (r.id === id ? { ...r, pinned: !r.pinned } : r)) });
  }

  removeRef(id: string) {
    if (this.snapshot.mode === 'recording' || this.snapshot.mode === 'processing') return;
    this.strokes = this.strokes.filter((s) => s.on !== id);
    this.set({ refs: this.snapshot.refs.filter((r) => r.id !== id), marks: this.strokes.length });
    if (this.snapshot.activeRef === id) this.openRef(null);
  }

  // ---------- images and history ----------

  private current() {
    return this.snapshot.versions[this.snapshot.index] as Version | undefined;
  }

  private async show(url: string) {
    this.target.image = await loadImage(url);
    this.preview = null;
    this.strokes = [];
    this.forgetSnap();
  }

  // A new picture starts a new history (and fits the screen).
  async open(url: string) {
    if (this.snapshot.mode === 'processing' || this.snapshot.mode === 'recording') return;
    await this.show(url);
    this.view = { zoom: 1, x: 0, y: 0 };
    this.set({ zoom: 1 });
    const v: Version = { url, imageId: upload(url) };
    v.imageId.catch((e) => this.onError(`Upload failed: ${e.message}`));
    this.set({ mode: 'idle', versions: [v], index: 0, result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.loadParts(v);
    this.draw();
  }

  async openFile(file: Blob) {
    await this.open(await blobToDataUrl(file));
  }

  async goTo(index: number) {
    const { mode, versions } = this.snapshot;
    if (mode === 'processing' || mode === 'recording' || index < 0 || index >= versions.length) return;
    await this.show(versions[index].url);
    this.set({ mode: 'idle', index, result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.loadParts(versions[index]);
    this.draw();
  }
  // Undo right after a stroke snapped puts the freehand stroke back first.
  undo = () => this.unsnap() || this.goTo(this.snapshot.index - 1);
  redo = () => this.goTo(this.snapshot.index + 1);

  // Keep: the result becomes the next version (dropping any redo).
  async keep() {
    const { result, versions, index } = this.snapshot;
    if (!result) return;
    this.closeTrial();
    await this.show(result.url);
    this.set({ mode: 'idle', versions: [...versions.slice(0, index + 1), result], index: index + 1, result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.loadParts(result);
    this.draw();
  }

  discard() {
    this.strokes = [];
    this.forgetSnap();
    this.preview = null;
    this.set({ mode: 'idle', result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.draw();
  }

  // Download what is on screen: the pending result, or the current version.
  async exportCurrent() {
    const { result, versions, index } = this.snapshot;
    const url = result?.url ?? versions[index]?.url;
    if (!url) return;
    const blob = await (await fetch(url)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `this-and-that-v${index + (result ? 2 : 1)}.${blob.type === 'image/png' ? 'png' : 'jpg'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  setCompare(on: boolean) {
    this.set({ compare: on });
  }

  // Press and hold to see the picture before this edit.
  setPeek(on: boolean) {
    if (on && !this.comparePair()) return;
    if (on !== this.snapshot.peek) this.set({ peek: on });
  }

  // What the before/after overlay shows: the pending result against the
  // current version, or the current version against the one before it.
  comparePair(): { before: string; after: string } | null {
    const { result, versions, index } = this.snapshot;
    if (result) return { before: versions[index].url, after: result.url };
    if (index > 0) return { before: versions[index - 1].url, after: versions[index].url };
    return null;
  }

  // ---------- talk: hold to talk, or tap to start and tap to send ----------

  async talkDown() {
    const { mode } = this.snapshot;
    if (!this.target.image || mode === 'processing') return;
    this.pressedAt = performance.now();
    this.startedByThisPress = mode === 'idle' || mode === 'review';
    if (mode === 'review') await this.keep();
    if (this.startedByThisPress) await this.startRecording();
  }

  talkUp() {
    if (this.snapshot.mode !== 'recording') return;
    const held = performance.now() - this.pressedAt > 400;
    // A quick tap that started recording keeps it going; a hold, or a tap
    // while recording, sends.
    if (held || !this.startedByThisPress) this.stopAndSend();
  }

  private async startRecording() {
    if (this.snapshot.mode === 'recording') return;
    this.markInput();
    this.strokes = [];
    this.forgetSnap();
    this.chunks = [];
    this.set({ mode: 'recording', marks: 0, compare: false, ...this.emptyPanel() });
    this.t0 = performance.now();
    try {
      this.micStream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.recorder = new MediaRecorder(this.micStream);
      this.recorder.ondataavailable = (ev) => ev.data.size && this.chunks.push(ev.data);
      this.recorder.start(250);
      // The clock starts when audio does, so stroke times line up with the voice.
      this.t0 = performance.now();
      try {
        this.live = new LiveAsr(this.micStream, (text) => this.snapshot.mode === 'recording' && text && this.set({ caption: text }), this.listenFor());
      } catch {
        this.live = null; // batch transcription on the server still works
      }
    } catch (err) {
      this.recorder = null;
      this.onNotice(`Microphone unavailable (${(err as Error).message}). Allow it to say what to change.`);
    }
  }

  // The picture and its references, for the words Voice Transcribe listens for.
  private listenFor() {
    return Promise.all([this.current()!.imageId, ...this.snapshot.refs.map((r) => r.imageId)]).catch(() => []);
  }

  private cancelRecording() {
    this.recorder?.stop();
    this.recorder = null;
    this.live?.stop();
    this.live = null;
    this.set({ mode: 'idle' });
  }

  private async stopAndSend() {
    this.forgetSnap(); // what is sent is final
    const rec = this.recorder;
    const audio = rec
      ? await new Promise<Blob>((resolve) => {
          rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType }));
          rec.stop();
        })
      : null;
    this.recorder = null;
    const asrId = this.live ? this.live.stop() : Promise.resolve(null);
    this.live = null;
    const speechMs = performance.now() - this.t0;
    if (this.snapshot.experiment && this.snapshot.method === 'voice') {
      this.markSent({ chars: 0, speechMs, marks: 0 });
      return this.sendWhole({ audio: audio ? await blobToDataUrl(audio) : null, asrId: await asrId });
    }
    if (!this.strokes.some((s) => !s.on)) {
      this.set({ mode: 'idle' });
      this.onNotice('Draw a mark on the picture while you talk.');
      return;
    }
    this.markSent({ chars: 0, speechMs, marks: this.strokes.length });
    this.set({ mode: 'processing', steps: { ...NO_STEPS, sam: 'active' }, elapsedMs: 0 });
    this.updateSamStep();
    this.animate();
    try {
      const refId = (id?: string) => this.snapshot.refs.find((r) => r.id === id)?.imageId;
      const body = {
        imageId: await this.current()!.imageId,
        strokes: await Promise.all(this.strokes.map(async ({ mark, points, markId, on, pen }) => ({ mark, points, markId, pen, on: on ? await refId(on) : undefined }))),
        pinned: await Promise.all(this.snapshot.refs.filter((r) => r.pinned).map((r) => r.imageId)),
        audio: audio ? await blobToDataUrl(audio) : null,
      };
      await this.sendJob(body, { asrId: await asrId });
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  // The keyboard fallback: the marks drawn so far, with the request typed
  // instead of said (any recording is dropped).
  async sendTyped(text: string) {
    text = text.trim();
    const { mode } = this.snapshot;
    if (!text || !this.target.image || mode === 'processing' || mode === 'review') return;
    if (!this.strokes.some((s) => !s.on)) return this.onNotice('Draw a mark on the picture first, then type what to change there.');
    if (mode === 'recording') {
      this.recorder?.stop();
      this.recorder = null;
      this.live?.stop();
      this.live = null;
    }
    this.forgetSnap();
    this.set({ mode: 'processing', steps: { ...NO_STEPS, sam: 'active' }, elapsedMs: 0, caption: text });
    this.updateSamStep();
    this.animate();
    try {
      const refId = (id?: string) => this.snapshot.refs.find((r) => r.id === id)?.imageId;
      await this.sendJob({
        imageId: await this.current()!.imageId,
        strokes: await Promise.all(this.strokes.map(async ({ mark, points, markId, on, pen }) => ({ mark, points, markId, pen, on: on ? await refId(on) : undefined }))),
        pinned: await Promise.all(this.snapshot.refs.filter((r) => r.pinned).map((r) => r.imageId)),
        text,
      });
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  private async sendJob(body: Record<string, unknown>, once: Record<string, unknown> = {}) {
    this.lastSend = { body };
    const { id } = await postJson('/api/jobs', { ...body, ...once });
    this.lastSend.jobId = id;
    await this.follow(id);
  }

  // "Try again" after an edit didn't come through: the same marks and voice,
  // sent again; the server reuses what it already understood.
  async retry() {
    const last = this.lastSend;
    if (!last || this.snapshot.mode !== 'idle' || !this.snapshot.failure) return;
    this.set({ mode: 'processing', failure: null, steps: { ...NO_STEPS, sam: 'done' }, edits: [], localMarks: [], elapsedMs: 0 });
    this.animate();
    try {
      await this.sendJob(last.body, { retryOf: last.jobId });
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  // ---------- experiment ----------

  setExperiment(on: boolean) {
    this.set({ experiment: on, method: on ? this.snapshot.method : 'pen' });
  }

  setMethod(method: Method) {
    if (this.snapshot.mode === 'recording' || this.snapshot.mode === 'processing') return;
    this.set({ method });
  }

  // A preset: its picture as a new history, its references (the first
  // unpinned one opened beside the picture), and its name for the trials.
  async loadTask(task: Task | null) {
    if (this.snapshot.mode === 'recording' || this.snapshot.mode === 'processing') return;
    if (!task) return this.set({ task: 'Free' });
    await this.open(task.image);
    const refs: Ref[] = task.refs.map((r) => {
      const ref: Ref = { id: crypto.randomUUID().slice(0, 8), url: r.url, imageId: upload(r.url), pinned: r.pinned };
      ref.imageId.catch((e) => this.onError(`Upload failed: ${e.message}`));
      findPartsOf(ref);
      return ref;
    });
    this.set({ task: task.title, refs });
    await this.openRef(refs.find((r) => !r.pinned)?.id ?? null);
  }

  // The typed way: the request as text, Muse Image edits the whole picture.
  async submitText(text: string) {
    if (!this.target.image || !text.trim() || this.snapshot.mode === 'processing' || this.snapshot.mode === 'recording') return;
    if (this.snapshot.mode === 'review') await this.keep();
    this.markInput();
    this.markSent({ chars: text.trim().length, speechMs: 0, marks: 0 });
    this.strokes = [];
    this.set({ caption: text.trim() });
    await this.sendWhole({ text: text.trim() });
  }

  // Type and Voice: no marks, the whole picture as Muse Image redraws it.
  private async sendWhole(body: { text?: string; audio?: string | null; asrId?: string | null }) {
    this.set({ mode: 'processing', steps: { ...NO_STEPS, sam: 'done' }, elapsedMs: 0, marks: 0 });
    try {
      const { asrId, ...rest } = body;
      await this.sendJob({ imageId: await this.current()!.imageId, whole: true, ...rest }, { asrId });
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  // First keystroke or press of a round (and of a trial, if none is open).
  markInput() {
    if (!this.snapshot.experiment || this.inputAt !== null) return;
    this.inputAt = performance.now();
    const open = this.snapshot.trials.at(-1);
    if (!open || open.totalMs !== null || open.method !== this.snapshot.method || open.task !== this.snapshot.task) {
      const trial: Trial = { id: crypto.randomUUID().slice(0, 8), method: this.snapshot.method, task: this.snapshot.task, startedAt: Date.now(), rounds: [], totalMs: null };
      this.setTrials([...this.snapshot.trials, trial]);
    }
  }

  private markSent(r: { chars: number; speechMs: number; marks: number }) {
    if (!this.snapshot.experiment || this.inputAt === null) return;
    const now = performance.now();
    this.pending = { inputMs: now - this.inputAt, ...r, sentAt: now };
  }

  private markResult() {
    if (!this.pending) return;
    const { sentAt, ...round } = this.pending;
    this.pending = null;
    this.inputAt = null;
    this.updateOpenTrial((t) => ({ ...t, rounds: [...t.rounds, { ...round, waitMs: performance.now() - sentAt, kept: false }] }));
  }

  private closeTrial() {
    if (!this.snapshot.experiment) return;
    this.updateOpenTrial((t) => ({
      ...t,
      rounds: t.rounds.map((r, i) => (i === t.rounds.length - 1 ? { ...r, kept: true } : r)),
      totalMs: Date.now() - t.startedAt,
    }));
  }

  private updateOpenTrial(f: (t: Trial) => Trial) {
    const trials = this.snapshot.trials;
    const open = trials.at(-1);
    if (!open || open.totalMs !== null) return;
    this.setTrials([...trials.slice(0, -1), f(open)]);
  }

  private setTrials(trials: Trial[]) {
    saveTrials(trials);
    this.set({ trials });
  }

  clearTrials() {
    this.setTrials([]);
  }

  // ---------- progress ----------

  private emptyPanel() {
    return { caption: '', edits: [], localMarks: [], steps: { ...NO_STEPS }, elapsedMs: 0, failure: null };
  }

  private updateSamStep() {
    if (this.snapshot.mode !== 'processing') return;
    this.set({ steps: { ...this.snapshot.steps, sam: this.strokes.every((s) => s.samDone) ? 'done' : 'active' } });
  }

  // Every model call on the server has a deadline and one retry, so a job
  // ends within ~2 minutes; this is the client's own backstop.
  private async follow(id: string) {
    const started = performance.now();
    for (;;) {
      if (performance.now() - started > 150_000) throw new Error('no answer in 150 s');
      const job: Job = await (await fetch(`/api/jobs/${id}`, { signal: AbortSignal.timeout(10_000) })).json();
      if (job.error) throw new Error(job.error);
      const at = SERVER_STEPS.indexOf(job.stage as (typeof SERVER_STEPS)[number]);
      const steps = { ...this.snapshot.steps };
      for (const [i, name] of (['understand', 'edit', 'paste'] as const).entries()) steps[name] = i < at ? 'done' : i === at ? 'active' : 'pending';
      const patch: Partial<Snapshot> = { steps, elapsedMs: job.elapsedMs };
      if (job.transcript) patch.caption = job.transcript;
      if (job.edits && !this.snapshot.edits.length) {
        patch.edits = job.edits;
        // An arrow's SAM mask is whatever it crossed: stop highlighting it.
        for (const e of job.edits) {
          const s = this.strokes.find((s) => s.mark === e.mark);
          if (s) s.settled = e.kind === 'pointer' || e.kind === 'reference' || /^no change/i.test(e.instruction);
        }
      }
      if (job.localMarks?.length) patch.localMarks = job.localMarks;
      this.set(patch);
      if (job.previewImageId && !this.preview) await this.showPreview(job.previewImageId, job.localMarks ?? []);
      if (job.stage === 'done') return this.showResult(job.resultImageId!);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Local edits are done: show them now, keep the sheen on what Muse is still editing.
  private async showPreview(id: string, localMarks: number[]) {
    this.preview = await loadImage(`/api/images/${id}.jpg`);
    for (const s of this.strokes) if (localMarks.includes(s.mark)) s.settled = true;
    this.draw();
  }

  private async showResult(resultImageId: string) {
    const result: Version = { url: `/api/images/${resultImageId}.jpg`, imageId: Promise.resolve(resultImageId) };
    await loadImage(result.url);
    this.markResult();
    this.set({ mode: 'review', result, compare: true, steps: { sam: 'done', understand: 'done', edit: 'done', paste: 'done' } });
    this.draw();
  }

  // The marks stay on the picture, and the canvas offers "Try again".
  private fail(message: string) {
    console.warn('Edit failed:', message);
    this.pending = null;
    this.inputAt = null;
    this.preview = null;
    this.set({ mode: 'idle', steps: { ...NO_STEPS }, failure: message || 'unknown error' });
    this.draw();
  }
}

export const editor = new Editor();

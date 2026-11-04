// The editor without the UI: the canvases (the picture being edited, and an
// open reference), marks, SAM outlines, sheen, recording (marks + voice +
// realtime transcription), jobs, references and version history. React reads
// its state through subscribe/getSnapshot; pointer drawing goes straight to
// the canvas.

import { postJson } from './api';
import { LiveAsr } from './live-asr';
import { markColor, themeVar, themeLength, watchTheme } from './colors';
import { loadTrials, saveTrials, type Method, type Round, type Trial } from './experiment';

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
};
export type Edit = { mark: number; kind?: string; op?: string; target: string; instruction: string };
export type Version = { url: string; imageId: Promise<string> };
// A reference picture: a character sheet, a style, or a detail like an ornament.
// Pinned ones go to every edit; others only when a mark is drawn on them.
export type Ref = { id: string; url: string; imageId: Promise<string>; pinned: boolean };
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
  versions: Version[];
  index: number; // current version
  result: Version | null; // the edit waiting for Keep or Discard
  compare: boolean; // before/after overlay
  fit: Fit; // where the picture sits in its stage, CSS px
  refs: Ref[];
  activeRef: string | null; // the reference open beside the picture
  experiment: boolean; // time each task done one of four ways
  method: Method;
  task: string; // the preset being done, or "Free"
  trials: Trial[];
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
    versions: [],
    index: -1,
    result: null,
    compare: false,
    fit: { x: 0, y: 0, w: 0, h: 0 },
    refs: [],
    activeRef: null,
    experiment: false,
    method: 'pen',
    task: 'Free',
    trials: loadTrials(),
  };
  private listeners = new Set<() => void>();
  onError: (message: string) => void = () => {};
  onNotice: (message: string) => void = () => {};

  private target: Surface = { key: 'target', image: null };
  private ref: Surface = { key: 'ref', image: null };
  private preview: HTMLImageElement | null = null; // instant edits, shown while the rest is edited
  private strokes: Stroke[] = [];
  private drawing: { stroke: Stroke; surface: Surface } | null = null;

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
    on('pointerdown', (e) => this.pointerDown(surface, e));
    on('pointermove', (e) => this.pointerMove(e));
    on('pointerup', () => this.endStroke());
    on('pointercancel', () => this.endStroke());
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
    const below = surface.key === 'target' ? themeLength('--toolbar-clearance') : pad;
    const aw = Math.max(1, w - pad * 2), ah = Math.max(1, h - pad - below);
    const k = Math.min(aw / img.naturalWidth, ah / img.naturalHeight);
    const iw = img.naturalWidth * k, ih = img.naturalHeight * k;
    return { x: (w - iw) / 2, y: pad + (ah - ih) / 2, w: iw, h: ih, k };
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
    ctx.restore();
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
    for (const [stroke, width] of [[halo, unit * 1.6], [color, unit]] as const) {
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
    this.drawing = { stroke, surface };
    this.strokes.push(stroke);
    this.set({ marks: this.strokes.length });
    this.draw();
  }

  private pointerMove(e: PointerEvent) {
    if (!this.drawing) return;
    const coalesced = e.getCoalescedEvents?.() ?? [];
    for (const ev of coalesced.length ? coalesced : [e]) this.drawing.stroke.points.push(this.toImage(this.drawing.surface, ev));
    this.draw();
  }

  private endStroke() {
    if (this.drawing) this.segment(this.drawing.stroke);
    this.drawing = null;
  }

  // Ask SAM for this mark right away; show its outline when it comes back.
  // Marks on a reference are crops for Muse Image, not edit regions.
  private async segment(s: Stroke) {
    if (s.on) {
      s.samDone = true;
      return;
    }
    s.markId = crypto.randomUUID().slice(0, 8);
    try {
      const imageId = await this.current()!.imageId;
      const r = await postJson('/api/marks', { imageId, markId: s.markId, stroke: { mark: s.mark, points: s.points } });
      if (r.found) s.mask = await loadImage(r.overlay);
    } catch (err) {
      console.warn('SAM for mark', s.mark, 'failed:', err);
    }
    s.samDone = true;
    if (this.strokes.includes(s)) {
      this.draw();
      this.updateSamStep();
    }
  }

  setPenOnly(on: boolean) {
    this.set({ penOnly: on });
  }

  clearMarks() {
    if (this.snapshot.mode === 'processing') return;
    if (this.snapshot.mode === 'recording') this.cancelRecording();
    this.strokes = [];
    this.set({ marks: 0 });
    this.draw();
  }

  // ---------- references ----------

  async addRef(file: Blob) {
    const url = await blobToDataUrl(file);
    const ref: Ref = { id: crypto.randomUUID().slice(0, 8), url, imageId: upload(url), pinned: false };
    ref.imageId.catch((e) => this.onError(`Upload failed: ${e.message}`));
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
  }

  // A new picture starts a new history.
  async open(url: string) {
    if (this.snapshot.mode === 'processing' || this.snapshot.mode === 'recording') return;
    await this.show(url);
    const v: Version = { url, imageId: upload(url) };
    v.imageId.catch((e) => this.onError(`Upload failed: ${e.message}`));
    this.set({ mode: 'idle', versions: [v], index: 0, result: null, compare: false, marks: 0, ...this.emptyPanel() });
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
    this.draw();
  }
  undo = () => this.goTo(this.snapshot.index - 1);
  redo = () => this.goTo(this.snapshot.index + 1);

  // Keep: the result becomes the next version (dropping any redo).
  async keep() {
    const { result, versions, index } = this.snapshot;
    if (!result) return;
    this.closeTrial();
    await this.show(result.url);
    this.set({ mode: 'idle', versions: [...versions.slice(0, index + 1), result], index: index + 1, result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.draw();
  }

  discard() {
    this.strokes = [];
    this.preview = null;
    this.set({ mode: 'idle', result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.draw();
  }

  setCompare(on: boolean) {
    this.set({ compare: on });
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
        this.live = new LiveAsr(this.micStream, (text) => this.snapshot.mode === 'recording' && text && this.set({ caption: text }));
      } catch {
        this.live = null; // batch transcription on the server still works
      }
    } catch (err) {
      this.recorder = null;
      this.onNotice(`Microphone unavailable (${(err as Error).message}). Marks only.`);
    }
  }

  private cancelRecording() {
    this.recorder?.stop();
    this.recorder = null;
    this.live?.stop();
    this.live = null;
    this.set({ mode: 'idle' });
  }

  private async stopAndSend() {
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
      const { id } = await postJson('/api/jobs', {
        imageId: await this.current()!.imageId,
        strokes: await Promise.all(this.strokes.map(async ({ mark, points, markId, on }) => ({ mark, points, markId, on: on ? await refId(on) : undefined }))),
        pinned: await Promise.all(this.snapshot.refs.filter((r) => r.pinned).map((r) => r.imageId)),
        audio: audio ? await blobToDataUrl(audio) : null,
        asrId: await asrId,
      });
      await this.follow(id);
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

  setTask(task: string) {
    this.set({ task });
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
      const { id } = await postJson('/api/jobs', { imageId: await this.current()!.imageId, whole: true, ...body });
      await this.follow(id);
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
    return { caption: '', edits: [], localMarks: [], steps: { ...NO_STEPS }, elapsedMs: 0 };
  }

  private updateSamStep() {
    if (this.snapshot.mode !== 'processing') return;
    this.set({ steps: { ...this.snapshot.steps, sam: this.strokes.every((s) => s.samDone) ? 'done' : 'active' } });
  }

  private async follow(id: string) {
    for (;;) {
      const job: Job = await (await fetch(`/api/jobs/${id}`)).json();
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
          if (s) s.settled = e.kind === 'pointer' || /^no change/i.test(e.instruction);
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

  private fail(message: string) {
    this.pending = null;
    this.inputAt = null;
    this.set({ mode: 'idle', steps: { ...NO_STEPS } });
    this.onError(message);
    this.draw();
  }
}

export const editor = new Editor();
